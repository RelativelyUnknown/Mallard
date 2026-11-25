/**
 * Pure snapshot engine: turn the store's pre-aggregated usage groups into the
 * `SnapshotSourceData` bundle the dashboard is composed from. It replaces the
 * single SQL statement of `EventReader.readFilteredSnapshot` and keeps its
 * semantics (see the notes on {@link buildSnapshotSource}), but prices at read
 * time and derives local days, hours and weekdays in TypeScript.
 */
import type { AggregateGroup, PricingSnapshot } from './contracts';
import { createPricer } from './pricing';
import { COST_CATEGORIES, type CostCategory } from './types';
import { UNATTRIBUTED_REPO } from './aggregate';
import { nextBucketStart, startOf } from '../util/time';

// ── SnapshotSourceData ─────────────────────────────────────────────────────────

/**
 * The normalized data bundle the snapshot engine produces. There is one engine
 * ({@link buildSnapshotSource}); the no-filter dashboard load is its empty-
 * filter case, so every read returns the same shape and can never disagree.
 */
export interface SnapshotSourceData {
  totals: {
    all:   { credits: number; cost: number; tokens: number; eventCount: number };
    mtd:   { credits: number; cost: number; tokens: number; eventCount: number };
    today: { credits: number; cost: number; tokens: number; eventCount: number };
  };
  /** Events whose cost is estimated (log-derived) rather than authoritative. */
  estimatedEventCount: number;
  /** day_start = epoch ms of local midnight, DST-correct. */
  daily:      Array<{
    dayStart: number; credits: number; cost: number; tokens: number; eventCount: number;
    /** Per-day cost split by category (USD), for the category-trend chart. */
    catInput: number; catOutput: number; catCacheRead: number; catCacheCreation: number; catThinking: number; catTool: number;
  }>;
  models:     Array<{ modelId: string; credits: number; cost: number; tokens: number }>;
  repos:      Array<{ repo: string; credits: number; cost: number; tokens: number; heuristicShare: number }>;
  /** Per-language spend; language is 'unknown' for rows without one. */
  languages:  Array<{ language: string; credits: number; cost: number; tokens: number }>;
  /** hour_local = 0-23 in session timezone (DST-correct). */
  hourly:     Array<{ hourLocal: number; credits: number }>;
  categories: Array<{ category: string; cost: number }>;
  sankey:     Array<{ model: string; surface: string; count: number; credits: number }>;
  /** Distinct values; in the filtered path scoped to the range filter only. */
  dims:       { models: string[]; surfaces: string[]; sources: string[]; repos: string[] };
  /** Credits per weekday, index 0=Sun … 6=Sat. */
  weekday:    number[];
}

// ── Engine ─────────────────────────────────────────────────────────────────────

/** What the store hands the engine for one dashboard read. */
export interface SnapshotGroups {
  /**
   * Groups matching the dashboard's whole filter (range, models, surfaces,
   * sources, branches, repos), already narrowed by the store query. The
   * default 365-day window of a filtered read is the caller's job: it is part
   * of the filter, and the engine never looks at one.
   */
  groups: readonly AggregateGroup[];
  /**
   * Groups matching the RANGE filter only; they feed `dims`, so the filter
   * dropdowns keep offering values that the other filters hide. Omit it when
   * no filter besides the range is active (it then equals `groups`).
   */
  dimGroups?: readonly AggregateGroup[];
}

interface Totals { credits: number; cost: number; tokens: number; eventCount: number }

interface DayAcc extends Totals {
  cat: Record<CostCategory, number>;
}

/** Local-calendar facts of one 15-minute UTC bucket, derived once however many groups share it. */
interface LocalBucket {
  day: DayAcc;
  hour: number;
  weekday: number;
  inToday: boolean;
  inMonth: boolean;
}

interface Acc extends Totals {
  /** Cost that came from rows whose repo attribution is a heuristic guess. */
  heuristicCost: number;
}

interface ModelAcc extends Acc {
  /** The model's credit-bearing rows per surface: the sankey links. */
  surfaces: Map<string, { count: number; credits: number }>;
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Highest credits first; equal credits ordered by name, so the order is deterministic. */
function byCreditsThenName<T extends { credits: number }>(name: (t: T) => string): (a: T, b: T) => number {
  return (a, b) => b.credits - a.credits || byName(name(a), name(b));
}

function add(into: Totals, credits: number, cost: number, tokens: number, count: number): void {
  into.credits += credits;
  into.cost += cost;
  into.tokens += tokens;
  into.eventCount += count;
}

function accFor<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

/** `acc` of `key`, adding `credits`, `cost`, `tokens`, `count` and the heuristic share to it. */
function addTo(map: Map<string, Acc>, key: string, credits: number, cost: number, tokens: number, count: number, heuristic: number): void {
  const acc = accFor(map, key, emptyAcc);
  add(acc, credits, cost, tokens, count);
  acc.heuristicCost += heuristic;
}

const emptyTotals = (): Totals => ({ credits: 0, cost: 0, tokens: 0, eventCount: 0 });
const emptyAcc = (): Acc => ({ ...emptyTotals(), heuristicCost: 0 });
const emptyModelAcc = (): ModelAcc => ({ ...emptyAcc(), surfaces: new Map() });
const emptyDay = (): DayAcc => ({ ...emptyTotals(), cat: emptyCats() });
const emptyCats = (): Record<CostCategory, number> =>
  ({ input: 0, output: 0, tool: 0, thinking: 0, cache_creation: 0, cache_read: 0, unknown: 0 });

/**
 * Build `SnapshotSourceData` from the store's aggregate groups, priced with
 * `pricing`, at clock `now` (injected; it only defines "today" and "month to
 * date", which are local-calendar windows).
 *
 * It copies `readFilteredSnapshot`'s semantics:
 *  - `dims` come from `dimGroups`, the range-only read;
 *  - a null repo is `unattributed` (as is a literal `unattributed`), a null
 *    language is `unknown`;
 *  - `tokens` is prompt + completion only (cache and thinking tokens are
 *    priced but not counted);
 *  - `sankey` keeps only model/surface pairs whose credits are above 0, and
 *    `categories` only categories whose cost is above 0;
 *  - `heuristicShare` is the cost share of rows attributed heuristically;
 *  - `hourly` lists only hours that have rows, `weekday` is 0 = Sunday;
 *  - local day, hour and weekday are DST-correct (one bucket for the repeated
 *    hour of a fall-back day), derived per 15-minute bucket: every real UTC
 *    offset is a multiple of 15 minutes, so a bucket never straddles a local
 *    hour, day or month boundary.
 *
 * It differs from it where the intended-differences list says so: counts are
 * sums of `requests` (a rolled-up row counts as the requests it holds),
 * `estimatedEventCount` is always the total count (every row is estimated),
 * and ties in the ranked lists are ordered by name (the sankey by model, then
 * surface) instead of arbitrarily.
 *
 * Read protocol for the caller (A3): slice the filter's range into windows,
 * `store.aggregate(filter, window)` each (yielding to the event loop between
 * them), concatenate into `groups`; do the same with the range-only filter for
 * `dimGroups` when other filters are active.
 */
export function buildSnapshotSource(input: SnapshotGroups, now: number, pricing: PricingSnapshot): SnapshotSourceData {
  const { groups } = input;
  const monthStart = startOf(now, 'month');
  const monthEnd = nextBucketStart(now, 'month');
  const dayStart = startOf(now, 'day');
  const dayEnd = nextBucketStart(now, 'day');

  const price = createPricer(pricing);
  const all = emptyTotals();
  const mtd = emptyTotals();
  const today = emptyTotals();
  const daily = new Map<number, DayAcc>();
  const models = new Map<string, ModelAcc>();
  const repos = new Map<string, Acc>();
  const languages = new Map<string, Acc>();
  const hourCredits = new Array<number>(24).fill(0);
  const hourSeen = new Array<boolean>(24).fill(false);
  const weekday = new Array<number>(7).fill(0);
  const locals = new Map<number, LocalBucket>();

  for (const g of groups) {
    let local = locals.get(g.bucketStartMs);
    if (local === undefined) {
      const date = new Date(g.bucketStartMs);
      local = {
        day: accFor(daily, startOf(g.bucketStartMs, 'day'), emptyDay),
        hour: date.getHours(),
        weekday: date.getDay(),
        inToday: g.bucketStartMs >= dayStart && g.bucketStartMs < dayEnd,
        inMonth: g.bucketStartMs >= monthStart && g.bucketStartMs < monthEnd,
      };
      locals.set(g.bucketStartMs, local);
    }

    const { credits, cost, costByCategory } = price(g);
    const tokens = g.promptTokens + g.completionTokens;
    const count = g.requests;
    const heuristic = g.attribution === 'heuristic' ? cost : 0;

    add(all, credits, cost, tokens, count);
    if (local.inMonth) add(mtd, credits, cost, tokens, count);
    if (local.inToday) add(today, credits, cost, tokens, count);
    add(local.day, credits, cost, tokens, count);
    for (const category in costByCategory) local.day.cat[category as CostCategory] += costByCategory[category as CostCategory]!;

    const model = accFor(models, g.modelId, emptyModelAcc);
    add(model, credits, cost, tokens, count);
    model.heuristicCost += heuristic;
    addTo(repos, g.repo ?? UNATTRIBUTED_REPO, credits, cost, tokens, count, heuristic);
    addTo(languages, g.language ?? 'unknown', credits, cost, tokens, count, heuristic);

    if (credits > 0) {
      let link = model.surfaces.get(g.surface);
      if (link === undefined) {
        link = { count: 0, credits: 0 };
        model.surfaces.set(g.surface, link);
      }
      link.count += count;
      link.credits += credits;
    }

    hourCredits[local.hour]! += credits;
    hourSeen[local.hour] = true;
    weekday[local.weekday]! += credits;
  }

  const catTotals = emptyCats();
  for (const day of daily.values()) for (const c of COST_CATEGORIES) catTotals[c] += day.cat[c];

  const dim = input.dimGroups ?? groups;
  const dimModels = new Set<string>();
  const dimSurfaces = new Set<string>();
  const dimSources = new Set<string>();
  const dimRepos = new Set<string>();
  for (const g of dim) {
    dimModels.add(g.modelId);
    dimSurfaces.add(g.surface);
    dimSources.add(g.source);
    dimRepos.add(g.repo ?? UNATTRIBUTED_REPO);
  }
  const sorted = (set: Set<string>): string[] => [...set].sort(byName);

  return {
    totals: { all, mtd, today },
    estimatedEventCount: all.eventCount,
    daily: [...daily.entries()]
      .sort(([a], [b]) => a - b)
      .map(([start, d]) => ({
        dayStart: start,
        credits: d.credits,
        cost: d.cost,
        tokens: d.tokens,
        eventCount: d.eventCount,
        catInput: d.cat.input,
        catOutput: d.cat.output,
        catCacheRead: d.cat.cache_read,
        catCacheCreation: d.cat.cache_creation,
        catThinking: d.cat.thinking,
        catTool: d.cat.tool,
      })),
    models: [...models.entries()]
      .map(([modelId, a]) => ({ modelId, credits: a.credits, cost: a.cost, tokens: a.tokens }))
      .sort(byCreditsThenName((m) => m.modelId)),
    repos: [...repos.entries()]
      .map(([repo, a]) => ({
        repo,
        credits: a.credits,
        cost: a.cost,
        tokens: a.tokens,
        heuristicShare: a.cost > 0 ? a.heuristicCost / a.cost : 0,
      }))
      .sort(byCreditsThenName((r) => r.repo)),
    languages: [...languages.entries()]
      .map(([language, a]) => ({ language, credits: a.credits, cost: a.cost, tokens: a.tokens }))
      .sort(byCreditsThenName((l) => l.language)),
    hourly: hourCredits.flatMap((c, hourLocal) => (hourSeen[hourLocal] ? [{ hourLocal, credits: c }] : [])),
    categories: COST_CATEGORIES.filter((c) => catTotals[c] > 0).map((category) => ({ category, cost: catTotals[category] })),
    sankey: [...models.entries()]
      .flatMap(([model, m]) => [...m.surfaces.entries()].map(([surface, link]) => ({ model, surface, count: link.count, credits: link.credits })))
      .sort((a, b) => byName(a.model, b.model) || byName(a.surface, b.surface)),
    dims: { models: sorted(dimModels), surfaces: sorted(dimSurfaces), sources: sorted(dimSources), repos: sorted(dimRepos) },
    weekday,
  };
}

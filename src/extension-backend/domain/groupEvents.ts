/**
 * The TypeScript reference of what the event store does with stored rows. The
 * SQLite store implements the same semantics in SQL; `MemoryEventStore` (the
 * driver-missing fallback) runs this code directly; the shared store contract
 * test checks both against it.
 *
 *  - {@link groupEvents}: the SQL `GROUP BY` of `store.aggregate`
 *      SELECT ts - ts % 900000, modelId, surface, source, repo, branch, language,
 *             attribution, (COALESCE(promptTokens,0) + COALESCE(completionTokens,0) > 0),
 *             SUM(requests), SUM(COALESCE(promptTokens,0)), ...
 *      FROM events WHERE <filter> GROUP BY ...
 *  - {@link matchesRecordFilter}: the filter's WHERE clause.
 *  - {@link rollUpEvents} / {@link mergeRolledRow}: the daily rollup `compact` performs.
 *
 * Pure and framework-free, so it is also the executable spec the tests use.
 */
import type { AggregateGroup, RawEvent } from './contracts';
import { UNATTRIBUTED_REPO } from './aggregate';
import type { RepoAttribution } from './types';
import type { RecordFilter } from '../store/EventRepository';
import { dayStartOffset, nextBucketStart, startOf } from '../util/time';

/** Width of the UTC time bucket a group covers. */
export const BUCKET_MS = 15 * 60_000;

/** Start of the 15-minute UTC bucket containing `ts` (also right for negative timestamps). */
export function bucketStart(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

/** True when the event passes the filter, with the same semantics as the store's WHERE clause. */
export function matchesRecordFilter(e: RawEvent, f: RecordFilter): boolean {
  if (f.range && !(e.ts >= f.range.start && e.ts < f.range.end)) return false;
  if (f.models?.length && !f.models.includes(e.modelId)) return false;
  if (f.surfaces?.length && !f.surfaces.includes(e.surface)) return false;
  if (f.sources?.length && !f.sources.includes(e.source)) return false;
  if (f.branches?.length && !(e.branch !== null && f.branches.includes(e.branch))) return false;
  if (f.repos?.length) {
    const named = f.repos.filter((r) => r !== UNATTRIBUTED_REPO);
    const namedHit = e.repo !== null && named.includes(e.repo);
    const unattributedHit = e.repo === null && f.repos.includes(UNATTRIBUTED_REPO);
    if (!namedHit && !unattributedHit) return false;
  }
  return true;
}

export function filterEvents(events: readonly RawEvent[], filter: RecordFilter): RawEvent[] {
  return events.filter((e) => matchesRecordFilter(e, filter));
}

/**
 * The `tokensKnown` grouping key: the row carries prompt or completion tokens
 * to price. NOT "not NULL": a known 0/0 row prices through credits, so lumping
 * it with token-bearing rows would price its summed tokens instead and lose the
 * credit cost.
 */
export function tokensKnownOf(promptTokens: number | null, completionTokens: number | null): boolean {
  return (promptTokens ?? 0) + (completionTokens ?? 0) > 0;
}

/** Orders groups the way the store's `ORDER BY` does: bucket, then the dimensions (NULL first). */
export function compareGroups(a: AggregateGroup, b: AggregateGroup): number {
  return (
    a.bucketStartMs - b.bucketStartMs ||
    cmpText(a.modelId, b.modelId) ||
    cmpText(a.surface, b.surface) ||
    cmpText(a.source, b.source) ||
    cmpText(a.repo, b.repo) ||
    cmpText(a.branch, b.branch) ||
    cmpText(a.language, b.language) ||
    cmpText(a.attribution, b.attribution) ||
    Number(a.tokensKnown) - Number(b.tokensKnown)
  );
}

/** Binary string order with NULL before everything, like SQLite's default collation. */
function cmpText(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

/** GROUP BY bucket, model, surface, source, repo, branch, language, attribution, tokensKnown. */
export function groupEvents(events: readonly RawEvent[]): AggregateGroup[] {
  const groups = new Map<string, AggregateGroup>();
  for (const e of events) {
    const bucketStartMs = bucketStart(e.ts);
    const tokensKnown = tokensKnownOf(e.promptTokens, e.completionTokens);
    const key = JSON.stringify([bucketStartMs, e.modelId, e.surface, e.source, e.repo, e.branch, e.language, e.attribution, tokensKnown]);
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        bucketStartMs, modelId: e.modelId, surface: e.surface, source: e.source,
        repo: e.repo, branch: e.branch, language: e.language, attribution: e.attribution, tokensKnown,
        requests: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
      };
      groups.set(key, g);
    }
    g.requests += e.requests;
    g.promptTokens += e.promptTokens ?? 0;
    g.completionTokens += e.completionTokens ?? 0;
    g.cacheReadTokens += e.cacheReadTokens;
    g.cacheCreationTokens += e.cacheCreationTokens;
    g.thinkingTokens += e.thinkingTokens;
  }
  // SQL leaves the order unspecified; the store sorts so results (and test failures) read the same every run.
  return [...groups.values()].sort(compareGroups);
}

// ── Rollup ────────────────────────────────────────────────────────────────────

export interface RolledUp {
  /** Raw rows at or after the cutoff, then the rolled rows. */
  rows: RawEvent[];
  rolled: RawEvent[];
  /** The raw events each rolled row (by id) stands for. */
  members: Map<string, RawEvent[]>;
  cutoff: number;
}

/** Id prefix of a rolled-up row; such rows are never rolled again. */
export const ROLL_PREFIX = 'roll:';

/** True for a rolled-up row (as opposed to a raw per-request row). */
export function isRolledId(id: string): boolean {
  return id.startsWith(ROLL_PREFIX);
}

/** Local `YYYY-MM-DD` of an epoch ms (call under the zone being tested). */
export function localDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Id of the rolled row a raw event belongs to: local day, model, repo label, surface, source. */
export function rollId(e: Pick<RawEvent, 'ts' | 'modelId' | 'repo' | 'surface' | 'source'>): string {
  return `${ROLL_PREFIX}${localDate(e.ts)}:${e.modelId}:${e.repo ?? UNATTRIBUTED_REPO}:${e.surface}:${e.source}`;
}

/** SUM() that keeps NULL when every value is NULL. */
export function sumOrNull(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}

/** 'heuristic' wins over 'authoritative' (a rolled day is heuristic when any part was); none stays none. */
export function mergeAttribution(a: RepoAttribution | null, b: RepoAttribution | null): RepoAttribution | null {
  if (a === 'heuristic' || b === 'heuristic') return 'heuristic';
  if (a === 'authoritative' || b === 'authoritative') return 'authoritative';
  return null;
}

/**
 * Collapse raw events into one row per local day, model, surface, source and
 * repo label. A rolled row sits at local midnight, sums `requests` and every
 * token column (NULL only when every member's value is NULL), keeps
 * `heuristic` attribution if any member had it, and drops branch and language.
 * A repo literally named `unattributed` is the same sentinel as no repo and
 * rolls up as NULL. Call under the zone being tested.
 */
export function rollUpGroups(events: readonly RawEvent[]): { rolled: RawEvent[]; members: Map<string, RawEvent[]> } {
  const members = new Map<string, RawEvent[]>();
  for (const e of events) {
    const id = rollId(e);
    const list = members.get(id);
    if (list) list.push(e);
    else members.set(id, [e]);
  }
  const rolled = [...members.entries()].map(([id, list]): RawEvent => {
    const first = list[0]!;
    return list.slice(1).reduce<RawEvent>((acc, e) => mergeRolledRow(acc, toRolledRow(e, id)), toRolledRow(first, id));
  }).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { rolled, members };
}

/** The rolled row a single raw event contributes (before merging with its siblings). */
export function toRolledRow(e: RawEvent, id: string): RawEvent {
  return {
    id,
    ts: startOf(e.ts, 'day'),
    modelId: e.modelId,
    surface: e.surface,
    source: e.source,
    repo: e.repo === UNATTRIBUTED_REPO ? null : e.repo,
    branch: null,
    attribution: e.attribution,
    language: null,
    requests: e.requests,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    cacheReadTokens: e.cacheReadTokens,
    cacheCreationTokens: e.cacheCreationTokens,
    thinkingTokens: e.thinkingTokens,
  };
}

/**
 * Add rolled row `add` into `into` (the same id): what the store's rollup
 * upsert does when a raw day that already has a roll row receives more events.
 */
export function mergeRolledRow(into: RawEvent, add: RawEvent): RawEvent {
  return {
    ...into,
    attribution: mergeAttribution(into.attribution, add.attribution),
    requests: into.requests + add.requests,
    promptTokens: sumOrNull(into.promptTokens, add.promptTokens),
    completionTokens: sumOrNull(into.completionTokens, add.completionTokens),
    cacheReadTokens: into.cacheReadTokens + add.cacheReadTokens,
    cacheCreationTokens: into.cacheCreationTokens + add.cacheCreationTokens,
    thinkingTokens: into.thinkingTokens + add.thinkingTokens,
  };
}

/** The local midnight `retentionDays` calendar days before the day containing `now`. */
export function retentionCutoff(now: number, retentionDays: number): number {
  return dayStartOffset(now, -retentionDays);
}

/**
 * Cutoff that rolls the day containing `boundaryTs` (the newest row that must go
 * to get under the raw-row cap) and everything before it. Day-aligned, because
 * a rollup groups whole local days, and never later than today's midnight: the
 * current day is never rolled to satisfy the cap.
 */
export function capCutoff(boundaryTs: number, now: number): number {
  return Math.min(nextBucketStart(boundaryTs, 'day'), startOf(now, 'day'));
}

/**
 * Executable spec of compaction: raw events older than the local midnight
 * `retentionDays` before `now` collapse into rolled rows (see
 * {@link rollUpGroups}). An event exactly at the cutoff stays raw.
 */
export function rollUpEvents(events: readonly RawEvent[], now: number, retentionDays: number): RolledUp {
  const cutoff = retentionCutoff(now, retentionDays);
  const rows = events.filter((e) => e.ts >= cutoff);
  const { rolled, members } = rollUpGroups(events.filter((e) => e.ts < cutoff));
  return { rows: [...rows, ...rolled], rolled, members, cutoff };
}

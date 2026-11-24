/* c8 ignore next */
/**
 * Builds the rule evaluation context — a plain nested object that
 * evalCondition() and renderTemplate() walk via var-path resolution.
 *
 * Every user-keyed map (model/surface/repo/vars/branchBudgets) is a
 * null-prototype object so a key such as "__proto__" or "constructor" is just
 * data, and resolveVar only ever reads own properties.
 */
import { startOf } from '../../util/time';
import { BillingState, ChartInputs, DailyBarsData, SnapshotCore, SnapshotDims, TokensDailyData } from '../types';
import { evalCondition } from './jsonCondition';

/**
 * Rules read summary + dimensions + billing. The optional day-level data is
 * used only to derive trailing-window figures (`window7d`, `month.tokens`):
 * host-side snapshots carry `chartInputs`, the composed wire snapshot carries
 * `chartData`. Without either, those fields are simply absent.
 */
export type RuleSnapshot = SnapshotCore & SnapshotDims & BillingState & {
  chartInputs?: Pick<ChartInputs, 'dayAggregates'>;
  chartData?: { dailyBars?: Pick<DailyBarsData, 'points'>; tokensDaily?: Pick<TokensDailyData, 'tokens'> };
};

export interface HistorySample {
  ts: number;
  todayCredits: number;
}

export interface EvalBuildInput {
  snapshot: RuleSnapshot | null;
  /** History of past snapshots for velocity. May be empty. */
  history?: HistorySample[];
  /** User-defined variables from the rule document `vars` block. */
  vars?: Record<string, unknown>;
  /** Sign-in state — needed by `requiresAuth` rules. */
  signedIn?: boolean;
  /** Cooldown bookkeeping (ruleId → last fired timestamp). */
  fired?: Map<string, number>;
  /** Evaluation wall-clock time; defaults to Date.now(). */
  now?: number;
  /** Alert groups from the document; passed through to the rule evaluator. */
  groups?: import('../types').AlertGroup[];
  /** Per-branch credit budgets from UserConfig. */
  branchBudgets?: Record<string, number>;
}

const ZERO_BUDGET = {
  monthly: null,
  includedCredits: 0,
  usedCredits: 0,
  usedCost: 0,
  percentOfBudget: 0,
  percentOfIncluded: 0,
  projectedOverage: null,
  pace: 'no-budget',
} as const;

const ZERO_FORECAST = {
  granularity: 'month',
  projectedCredits: 0,
  projectedCost: 0,
  low: 0,
  high: 0,
  basis: 'insufficient-data',
  asOf: 0,
} as const;

function toFiniteNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  /* c8 ignore next */
  return fallback;
}

/** A null-prototype record, optionally seeded from `source`'s own enumerable keys. */
function dict<T>(source?: Record<string, T>): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  if (source) for (const key of Object.keys(source)) out[key] = source[key]!;
  return out;
}

interface Totals {
  credits: number;
  cost: number;
  tokens?: number;
}

/** The last 7 calendar days (today and the 6 before it), from whichever day-level data the snapshot carries. */
function trailingWeek(snapshot: RuleSnapshot, now: number): Totals | null {
  const aggregates = snapshot.chartInputs?.dayAggregates;
  if (aggregates) {
    // Step back by calendar day (not 24h multiples) so a DST day can't shift the window.
    let from = startOf(now, 'day');
    for (let i = 0; i < 6; i++) from = startOf(from - 1, 'day');
    const totals = { credits: 0, cost: 0, tokens: 0 };
    for (const agg of aggregates) {
      if (agg.start < from || agg.start > now) continue;
      totals.credits += agg.credits;
      totals.cost += agg.cost;
      totals.tokens += agg.tokens;
    }
    return totals;
  }
  const points = snapshot.chartData?.dailyBars?.points;
  if (points && points.length >= 7) {
    const week = points.slice(-7);
    const tokens = snapshot.chartData?.tokensDaily?.tokens;
    return {
      credits: week.reduce((acc, p) => acc + p.credits, 0),
      cost: week.reduce((acc, p) => acc + p.cost, 0),
      ...(tokens && tokens.length === points.length
        ? { tokens: tokens.slice(-7).reduce((acc, v) => acc + v, 0) }
        : {}),
    };
  }
  return null;
}

/** Tokens used so far this calendar month, or undefined when the snapshot has no day-level data. */
function monthTokens(snapshot: RuleSnapshot, now: number): number | undefined {
  const aggregates = snapshot.chartInputs?.dayAggregates;
  if (!aggregates) return undefined;
  const from = startOf(now, 'month');
  let tokens = 0;
  for (const agg of aggregates) if (agg.start >= from && agg.start <= now) tokens += agg.tokens;
  return tokens;
}

/**
 * Spend rate over the history window: the least-squares slope of today's
 * credits against time. `todayCredits` is a counter that falls back toward 0
 * at midnight or when the data is recomputed, so the window restarts at the
 * last such drop instead of treating it as negative spend. Fewer than two
 * samples after the restart (or no time span) means no measurable rate.
 */
function velocityOf(history: readonly HistorySample[] | undefined): { creditsPerHour: number; windowMinutes: number } {
  const none = { creditsPerHour: 0, windowMinutes: 0 };
  if (!history || history.length < 2) return none;
  let start = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i]!.todayCredits < history[i - 1]!.todayCredits) start = i;
  }
  const window = history.slice(start);
  if (window.length < 2) return none;

  const meanTs = window.reduce((acc, s) => acc + s.ts, 0) / window.length;
  const meanCredits = window.reduce((acc, s) => acc + s.todayCredits, 0) / window.length;
  let covariance = 0;
  let variance = 0;
  for (const s of window) {
    covariance += (s.ts - meanTs) * (s.todayCredits - meanCredits);
    variance += (s.ts - meanTs) ** 2;
  }
  const spanMs = window[window.length - 1]!.ts - window[0]!.ts;
  if (variance <= 0 || spanMs <= 0) return none;
  return {
    creditsPerHour: Math.max(0, (covariance / variance) * 3_600_000),
    windowMinutes: spanMs / 60_000,
  };
}

/* c8 ignore next */
export function buildRuleContext(input: EvalBuildInput): Record<string, unknown> {
  const now = input.now ?? Date.now();
  const snapshot = input.snapshot;

  const today = snapshot?.today ?? { credits: 0, cost: 0, tokens: 0 };
  // No snapshot at all means no usage; a snapshot without day-level data means
  // "unknown", which is reported as absent rather than as a made-up zero.
  const window7d = snapshot ? trailingWeek(snapshot, now) : { credits: 0, cost: 0, tokens: 0 };

  const tokensThisMonth = snapshot ? monthTokens(snapshot, now) : 0;
  const month = snapshot
    ? {
        credits: snapshot.budget.usedCredits,
        cost: snapshot.budget.usedCost,
        ...(tokensThisMonth !== undefined ? { tokens: tokensThisMonth } : {}),
      }
    : { credits: 0, cost: 0, tokens: 0 };

  const budget = snapshot?.budget ?? ZERO_BUDGET;
  const forecast = snapshot?.forecast ?? ZERO_FORECAST;

  const velocity = velocityOf(input.history);
  const pricePerCredit = toFiniteNumber(snapshot?.pricePerCredit);

  const topModel = snapshot?.topModels?.[0] ?? null;
  const topRepo = snapshot?.byRepo?.[0] ?? null;

  const model = dict<{ credits: number; cost: number; tokens: number }>();
  for (const modelEntry of snapshot?.topModels ?? [])
    model[modelEntry.key] = { credits: modelEntry.credits, cost: modelEntry.cost, tokens: modelEntry.tokens };
  for (const modelKey of snapshot?.allModels ?? []) {
    if (!model[modelKey]) model[modelKey] = { credits: 0, cost: 0, tokens: 0 };
  }

  // Per-surface credits come from the model → surface links; cost/tokens are
  // not tracked per surface, so those fields do not exist.
  const surface = dict<{ credits: number }>();
  for (const surfaceKey of snapshot?.allSurfaces ?? []) surface[surfaceKey] = { credits: 0 };
  for (const link of snapshot?.sankeyLinks ?? []) {
    const entry = (surface[link.target] ??= { credits: 0 });
    entry.credits += link.value;
  }
  let topSurface: { id: string; credits: number } | null = null;
  for (const [id, entry] of Object.entries(surface)) {
    if (!topSurface || entry.credits > topSurface.credits) topSurface = { id, credits: entry.credits };
  }

  const repo = dict<{ credits: number; cost: number; tokens: number }>();
  for (const repoEntry of snapshot?.byRepo ?? [])
    repo[repoEntry.key] = { credits: repoEntry.credits, cost: repoEntry.cost, tokens: repoEntry.tokens };
  for (const repoKey of snapshot?.allRepos ?? []) {
    if (!repo[repoKey]) repo[repoKey] = { credits: 0, cost: 0, tokens: 0 };
  }

  const billing = snapshot?.githubBilling
    ? {
        netAmount: snapshot.githubBilling.totalNetAmount,
        grossAmount: snapshot.githubBilling.items.reduce((acc, item) => acc + item.grossAmount, 0),
        // A 0–1 fraction (0.25 = a quarter of the quota left); negative once over quota.
        quotaPercentRemaining: snapshot.githubBilling.quota
          ? toFiniteNumber(snapshot.githubBilling.quota.entitlement) > 0
            ? 1 -
              toFiniteNumber(snapshot.githubBilling.quota.used) /
                toFiniteNumber(snapshot.githubBilling.quota.entitlement)
            : null
          : null,
        unlimited: snapshot.githubBilling.quota?.unlimited ?? false,
      }
    : null;

  const base = {
    today,
    month,
    window7d,
    budget: {
      monthly: budget.monthly,
      includedCredits: budget.includedCredits,
      usedCredits: budget.usedCredits,
      usedCost: budget.usedCost,
      percentOfBudget: budget.percentOfBudget,
      percentOfIncluded: budget.percentOfIncluded,
      projectedOverage: budget.projectedOverage,
      pace: budget.pace,
    },
    forecast: {
      projectedCredits: forecast.projectedCredits,
      projectedCost: forecast.projectedCost,
      low: forecast.low,
      high: forecast.high,
      basis: forecast.basis,
    },
    velocity: {
      creditsPerHour: velocity.creditsPerHour,
      // Display-currency cost of the credit rate (same units as today.cost).
      costPerHour: velocity.creditsPerHour * pricePerCredit,
      windowMinutes: velocity.windowMinutes,
    },
    topModel: topModel
      ? { id: topModel.key, credits: topModel.credits, cost: topModel.cost }
      : null,
    topSurface,
    topRepo: topRepo ? { id: topRepo.key, credits: topRepo.credits, cost: topRepo.cost } : null,
    model,
    surface,
    repo,
    billing,
    now: {
      weekday: new Date(now).getDay(),
      hour: new Date(now).getHours(),
      minute: new Date(now).getMinutes(),
      iso: new Date(now).toISOString(),
      ts: now,
    },
    signedIn: input.signedIn ?? !!snapshot?.githubBilling,
    currentBranch: snapshot?.currentBranch ?? null,
    currentBranchCredits: snapshot?.currentBranchCredits ?? 0,
    branchBudgets: dict(input.branchBudgets),
    vars: dict(input.vars),
  };

  // ctx.group.<id>: each group's `active` condition, evaluated against the rest
  // of the context. Built here so alerts and restrictions see the same values.
  const group = dict<boolean>();
  for (const g of input.groups ?? []) group[g.id] = evalCondition(g.active, base);
  return { ...base, group };
}

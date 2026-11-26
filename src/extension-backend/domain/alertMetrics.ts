/**
 * The metric lookup behind flat alert rules and restrictions: from a snapshot
 * (and the recent spend history, for velocity) to the numbers a rule compares.
 *
 * Pure and webview-safe: no vscode, no Node, no clock (callers pass `now`).
 *
 * The context is a map from the rule's metric name to its current value, so a
 * lookup is a plain `get` and a metric that is not in the map is unavailable
 * (see `compare()` for what unavailable means to a comparison):
 *
 *   today.credits  today.cost  month.credits  month.cost
 *   budget.percentOfBudget  budget.percentOfIncluded
 *   forecast.projectedCredits  forecast.projectedCost
 *   velocity.creditsPerHour  window7d.credits  currentBranchCredits
 *   model:<id>.credits  model:<id>.cost  repo:<name>.credits  repo:<name>.cost
 *
 * Without a snapshot nothing is available, so a `<` rule never fires on the
 * zeros of an empty context. `window7d.credits` needs the snapshot's day-level
 * data and is unavailable without it. A model or repo the snapshot lists but has
 * no spend for reads 0; one it does not know is unavailable.
 */
import { startOf } from '../util/time';
import type { SnapshotData } from './types';

/** One reading of today's credits; the history of these feeds `velocity.creditsPerHour`. */
export interface HistorySample {
  ts: number;
  todayCredits: number;
}

/** What the metrics read from a snapshot; a host-side `SnapshotData` satisfies it. */
export type MetricSnapshot = Pick<
  SnapshotData,
  'today' | 'budget' | 'forecast' | 'topModels' | 'allModels' | 'byRepo' | 'allRepos' | 'currentBranchCredits'
> & {
  /** Day-level data, used only for `window7d.credits`. */
  chartInputs?: Pick<SnapshotData['chartInputs'], 'dayAggregates'>;
};

export interface FlatContext {
  /** Metric name to current value. A metric that is not here is unavailable. */
  readonly values: ReadonlyMap<string, number>;
}

export interface FlatContextInput {
  /** The unfiltered snapshot, or null when there is none yet. */
  snapshot: MetricSnapshot | null;
  /**
   * Recent `todayCredits` samples (oldest first). Without them
   * `velocity.creditsPerHour` is 0, so pass them wherever the context feeds
   * alerts OR restrictions.
   */
  history?: readonly HistorySample[];
  now: number;
}

/** Credits in the last 7 calendar days (today and the 6 before it), or null when the snapshot has no day-level data. */
function trailingWeekCredits(snapshot: MetricSnapshot, now: number): number | null {
  const aggregates = snapshot.chartInputs?.dayAggregates;
  if (!aggregates) return null;
  // Step back by calendar day (not 24h multiples) so a DST day can't shift the window.
  let from = startOf(now, 'day');
  for (let i = 0; i < 6; i++) from = startOf(from - 1, 'day');
  let credits = 0;
  for (const agg of aggregates) if (agg.start >= from && agg.start <= now) credits += agg.credits;
  return credits;
}

/**
 * Spend rate over the history window: the least-squares slope of today's
 * credits against time. `todayCredits` is a counter that falls back toward 0
 * at midnight or when the data is recomputed, so the window restarts at the
 * last such drop instead of treating it as negative spend. Fewer than two
 * samples after the restart (or no time span) means no measurable rate (0).
 */
export function creditsPerHour(history: readonly HistorySample[] | undefined): number {
  if (!history || history.length < 2) return 0;
  let start = 0;
  for (let i = 1; i < history.length; i++) {
    if (history[i]!.todayCredits < history[i - 1]!.todayCredits) start = i;
  }
  const window = history.slice(start);
  if (window.length < 2) return 0;

  const meanTs = window.reduce((acc, s) => acc + s.ts, 0) / window.length;
  const meanCredits = window.reduce((acc, s) => acc + s.todayCredits, 0) / window.length;
  let covariance = 0;
  let variance = 0;
  for (const s of window) {
    covariance += (s.ts - meanTs) * (s.todayCredits - meanCredits);
    variance += (s.ts - meanTs) ** 2;
  }
  const spanMs = window[window.length - 1]!.ts - window[0]!.ts;
  if (variance <= 0 || spanMs <= 0) return 0;
  return Math.max(0, (covariance / variance) * 3_600_000);
}

export function buildFlatContext(input: FlatContextInput): FlatContext {
  const values = new Map<string, number>();
  const { snapshot, now } = input;
  if (!snapshot) return { values };

  const { today, budget, forecast } = snapshot;
  values.set('today.credits', today.credits);
  values.set('today.cost', today.cost);
  values.set('month.credits', budget.usedCredits);
  values.set('month.cost', budget.usedCost);
  values.set('budget.percentOfBudget', budget.percentOfBudget);
  values.set('budget.percentOfIncluded', budget.percentOfIncluded);
  values.set('forecast.projectedCredits', forecast.projectedCredits);
  values.set('forecast.projectedCost', forecast.projectedCost);
  values.set('velocity.creditsPerHour', creditsPerHour(input.history));
  values.set('currentBranchCredits', snapshot.currentBranchCredits);
  const week = trailingWeekCredits(snapshot, now);
  if (week !== null) values.set('window7d.credits', week);

  // Spend per model and repo, then the idle ones the snapshot lists (0, not unavailable).
  const keyed = (kind: 'model' | 'repo', spend: ReadonlyArray<{ key: string; credits: number; cost: number }>, known: readonly string[]): void => {
    for (const { key, credits, cost } of spend) {
      values.set(`${kind}:${key}.credits`, credits);
      values.set(`${kind}:${key}.cost`, cost);
    }
    for (const key of known) {
      if (!values.has(`${kind}:${key}.credits`)) {
        values.set(`${kind}:${key}.credits`, 0);
        values.set(`${kind}:${key}.cost`, 0);
      }
    }
  };
  keyed('model', snapshot.topModels, snapshot.allModels);
  keyed('repo', snapshot.byRepo, snapshot.allRepos);
  return { values };
}

/** The metric's current value, or undefined when it is unavailable. */
export function metricValue(metric: string, ctx: FlatContext): number | undefined {
  return ctx.values.get(metric);
}

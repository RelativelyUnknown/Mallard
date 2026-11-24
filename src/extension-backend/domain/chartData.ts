/* c8 ignore next */
/**
 * Pure host-side functions that build render-ready chart payloads.
 * Assembled once in buildSnapshot(); the webview only paints, never aggregates.
 */
import {
  BudgetState,
  CategoryBreakdownData,
  CategoryDailyRow,
  CategoryTrendData,
  ChartData,
  COST_CATEGORIES,
  CostCategory,
  DailyBarsData,
  DailyBarPoint,
  DisplayPrefs,
  Filter,
  Forecast,
  HeatmapData,
  HourlyTimelineData,
  ModelBreakdownData,
  TokensDailyData,
  TopEntry,
  UsageAggregate,
  UsageEvent,
  WeekdayData,
} from './types';
import { PricingManifest } from './pricing';
import { matchesFilter } from './aggregate';
import { bucketKey, daysInMonth, startOf } from '../util/time';

const DAILY_BARS_WINDOW = 30;
// A full year, GitHub-contribution-graph style (schema caps this at 52).
const HEATMAP_WEEKS = 52;
const TOP_N = 8;

// Display prefs come from a hand-edited file; the builders clamp them so a 0,
// negative or absurd value can neither divide by zero nor loop for ages.
const MAX_WINDOW_DAYS = 366;
const MAX_HEATMAP_WEEKS = 104;
const MAX_TOP_N = 50;

/** Integer in [min, max]; undefined/NaN fall back to `fallback`. */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = Math.trunc(value ?? fallback);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Local-midnight timestamps of the last `count` calendar days, oldest first,
 * ending with the day containing `now`. Steps back with startOf (one ms before
 * a local midnight is always the previous calendar day) instead of subtracting
 * 24h multiples, which skips or repeats a day across a DST change.
 */
function recentDayStarts(now: number, count: number): number[] {
  const days = new Array<number>(count);
  let day = startOf(now, 'day');
  for (let i = count - 1; i >= 0; i--) {
    days[i] = day;
    day = startOf(day - 1, 'day');
  }
  return days;
}

function shortModelName(id: string): string {
  return id.replace(/^(models\/|openai\/|anthropic\/|google\/)/, '').slice(0, 32);
}

export function buildDailyBarsData(
  dayAggregates: UsageAggregate[],
  budget: BudgetState,
  forecast: Forecast,
  now: number,
  window = DAILY_BARS_WINDOW,
): DailyBarsData {
  const days = clampInt(window, DAILY_BARS_WINDOW, 1, MAX_WINDOW_DAYS);
  const byKey = new Map<string, UsageAggregate>(dayAggregates.map((a) => [a.bucketKey, a]));
  // The included allowance and the projection are MONTHLY figures, so the
  // per-day reference is their share of the month — independent of how many
  // days the chart happens to show.
  const monthDays = daysInMonth(now);
  const dailyBudget = budget.includedCredits > 0 ? budget.includedCredits / monthDays : 0;

  const points: DailyBarPoint[] = [];
  for (const ts of recentDayStarts(now, days)) {
    const key = bucketKey(ts, 'day');
    const agg = byKey.get(key);
    const credits = agg?.credits ?? 0;
    const cost = agg?.cost ?? 0;

    const d = new Date(ts);
    const date = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    let colorIndex = 0;
    if (dailyBudget > 0) {
      const ratio = credits / dailyBudget;
      if (ratio >= 1.0) colorIndex = 2;
      else if (ratio >= 0.7) colorIndex = 1;
    }

    points.push({ date, credits, cost, colorIndex });
  }

  const budgetLine = dailyBudget > 0 ? dailyBudget : null;
  const projectedLine =
    forecast.basis !== 'insufficient-data' ? forecast.projectedCredits / monthDays : null;

  let run = 0;
  const cumulativeCosts = points.map((p) => { run += p.cost; return run; });

  return { points, budgetLine, projectedLine, cumulativeCosts };
}

export function buildModelBreakdownData(
  topModels: TopEntry[],
  pricePerCredit: number,
  manifest?: PricingManifest,
  topN = TOP_N,
): ModelBreakdownData {
  const top = topModels.slice(0, clampInt(topN, TOP_N, 1, MAX_TOP_N));
  const multipliers = manifest?.models ?? {};
  const allMultipliers = Object.values(multipliers).filter((v) => v > 0);
  const minMultiplier = allMultipliers.length > 0 ? Math.min(...allMultipliers) : 1;
  return {
    labels: top.map((m) => shortModelName(m.key)),
    credits: top.map((m) => m.credits),
    costs: top.map((m) => m.cost),
    tokens: top.map((m) => m.tokens),
    cheapestEquivalentCosts: top.map((m) => m.tokens * minMultiplier * pricePerCredit),
  };
}

export function buildHourlyTimelineData(events: readonly UsageEvent[], filter?: Filter): HourlyTimelineData {
  const hours = new Array(24).fill(0) as number[];
  for (const e of events) {
    if (!matchesFilter(e, filter)) continue;
    // Each event's own local hour, so the offset in force on ITS date (DST
    // included) applies rather than today's.
    hours[new Date(e.ts).getHours()]! += e.credits;
  }
  const max = Math.max(...hours);
  // null when there is no hourly activity — indexOf(0) would otherwise always
  // report midnight as the "peak".
  const peakHour = max > 0 ? hours.indexOf(max) : null;
  return { hours, peakHour };
}

/** Credits per weekday (index 0=Sun … 6=Sat) from raw events. */
export function buildWeekdayTotals(events: readonly UsageEvent[], filter?: Filter): number[] {
  const totals = new Array(7).fill(0) as number[];
  for (const e of events) {
    if (!matchesFilter(e, filter)) continue;
    // Local weekday of the event itself (0=Sun … 6=Sat), matching the SQL
    // dayofweek() path.
    totals[new Date(e.ts).getDay()]! += e.credits;
  }
  return totals;
}

export function buildHeatmapData(dayAggregates: UsageAggregate[], now: number, weeks = HEATMAP_WEEKS): HeatmapData {
  const byStart = new Map<number, number>(dayAggregates.map((a) => [a.start, a.credits]));
  const days = clampInt(weeks, HEATMAP_WEEKS, 1, MAX_HEATMAP_WEEKS) * 7;

  const cells: Array<{ date: string; value: number }> = [];
  let max = 0;
  // days + 1 cells: the inclusive range from `days` days ago through today.
  for (const d of recentDayStarts(now, days + 1)) {
    const value = byStart.get(d) ?? 0;
    const dt = new Date(d);
    const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    cells.push({ date, value });
    if (value > max) max = value;
  }

  return { cells, max };
}

/**
 * Spend split by cost category, summed from each event's `costByCategory`.
 * When no event carries a breakdown, returns `available: false` so the UI
 * hides the chart rather than showing a misleading single bucket.
 */
export function buildCategoryBreakdownData(
  events: readonly UsageEvent[],
  f?: Filter,
): CategoryBreakdownData {
  const totals = new Map<CostCategory, number>();
  let any = false;
  for (const e of events) {
    if (!matchesFilter(e, f)) continue;
    if (!e.costByCategory) continue;
    for (const cat of COST_CATEGORIES) {
      const val = e.costByCategory[cat];
      if (val == null || val <= 0) continue;
      any = true;
      totals.set(cat, (totals.get(cat) ?? 0) + val);
    }
  }
  if (!any) return { categories: [], costs: [], available: false };
  const categories = COST_CATEGORIES.filter((c) => (totals.get(c) ?? 0) > 0);
  return {
    categories,
    /* c8 ignore next */
    costs: categories.map((c) => totals.get(c) ?? 0),
    available: categories.length > 0,
  };
}

/**
 * Builds a WeekdayData from a 7-element credits array (index 0=Sun … 6=Sat).
 * Returns zero-filled data if the array is empty or shorter than 7.
 */
export function buildWeekdayData(totals: number[]): WeekdayData {
  const filled = Array.from({ length: 7 }, (_, i) => totals[i] ?? 0);
  const max = Math.max(...filled);
  const peak = filled.indexOf(max);
  // null when there is no weekday activity — indexOf would otherwise report
  // Sunday as the "peak" of an all-zero week.
  return { totals: filled, peak, peakWeekday: max > 0 ? peak : null };
}

/* c8 ignore next */
/** MM-DD label for a local-day timestamp (same format as dailyBars). */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Daily token/event volume over the dailyBars window. */
export function buildTokensDailyData(
  dayAggregates: UsageAggregate[],
  now: number,
  window = DAILY_BARS_WINDOW,
): TokensDailyData {
  const byKey = new Map<string, UsageAggregate>(dayAggregates.map((a) => [a.bucketKey, a]));
  const dates: string[] = [];
  const tokens: number[] = [];
  const events: number[] = [];
  for (const ts of recentDayStarts(now, clampInt(window, DAILY_BARS_WINDOW, 1, MAX_WINDOW_DAYS))) {
    const agg = byKey.get(bucketKey(ts, 'day'));
    dates.push(dayLabel(ts));
    tokens.push(agg?.tokens ?? 0);
    events.push(agg?.eventCount ?? 0);
  }
  return { dates, tokens, events };
}

/** Stacked per-category cost over the dailyBars window. */
export function buildCategoryTrendData(
  categoryDaily: CategoryDailyRow[],
  now: number,
  window = DAILY_BARS_WINDOW,
): CategoryTrendData {
  const byKey = new Map(categoryDaily.map((r) => [bucketKey(r.dayStart, 'day'), r.costs]));
  const dates: string[] = [];
  const perCategory = new Map<CostCategory, number[]>();
  for (const ts of recentDayStarts(now, clampInt(window, DAILY_BARS_WINDOW, 1, MAX_WINDOW_DAYS))) {
    dates.push(dayLabel(ts));
    const costs = byKey.get(bucketKey(ts, 'day')) ?? {};
    for (const cat of COST_CATEGORIES) {
      const arr = perCategory.get(cat) ?? new Array<number>(0);
      while (arr.length < dates.length - 1) arr.push(0);
      arr.push(costs[cat] ?? 0);
      perCategory.set(cat, arr);
    }
  }
  const series = COST_CATEGORIES
    .map((category) => ({ category, costs: perCategory.get(category) ?? [] }))
    .filter((sr) => sr.costs.some((v) => v > 0));
  return { dates, series, available: series.length > 0 };
}

export function buildChartData(
  dayAggregates: UsageAggregate[],
  topModels: TopEntry[],
  budget: BudgetState,
  forecast: Forecast,
  now: number,
  categoryBreakdown: CategoryBreakdownData,
  hourlyTimeline: HourlyTimelineData,
  pricePerCredit: number,
  manifest?: PricingManifest,
  weekdayTotals?: number[],
  display?: DisplayPrefs,
  categoryDaily: CategoryDailyRow[] = [],
): ChartData {
  return {
    dailyBars: buildDailyBarsData(dayAggregates, budget, forecast, now, display?.dailyBarsWindow),
    modelBreakdown: buildModelBreakdownData(topModels, pricePerCredit, manifest, display?.topN),
    heatmap: buildHeatmapData(dayAggregates, now, display?.heatmapWeeks),
    categoryBreakdown,
    hourlyTimeline,
    weekdayBreakdown: buildWeekdayData(weekdayTotals ?? []),
    tokensDaily: buildTokensDailyData(dayAggregates, now, display?.dailyBarsWindow),
    categoryTrend: buildCategoryTrendData(categoryDaily, now, display?.dailyBarsWindow),
  };
}

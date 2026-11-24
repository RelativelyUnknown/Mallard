/* c8 ignore next */
/**
 * Holt-Winters triple exponential smoothing with additive weekly seasonality (m=7).
 *
 * Parameters (alpha, beta, gamma) are fitted by coarse grid-search minimising
 * mean squared one-step-ahead error.  Requires ≥ 14 observations; the caller
 * (`selectForecaster`) guarantees this.
 *
 * The MLOps caching layer (store fitted params in the DuckDB `meta` table, key
 * `forecaster.seasonal.v1`) is deliberately left at the service boundary — call
 * `fitHoltWinters` from `UsageService.buildSnapshot()` when params are stale and
 * persist the JSON.  This file remains a pure domain module with no I/O.
 */
import type { Forecast, UsageAggregate } from '../types';
import { monthPosition, type Forecaster, type ForecastInput } from './linear';
import { dayStartOffset, startOf, nextBucketStart } from '../../util/time';

export interface HoltWintersParams {
  alpha: number;
  beta: number;
  gamma: number;
  /** 7 seasonal index values (one per weekday position in the cycle). */
  seasonalIndices: number[];
  /** Akaike Information Criterion for model comparison. */
  aic: number;
  fittedAt: number;
}

const PERIOD = 7; // weekly seasonality

/**
 * Longest history fitted. Older days barely move a weekly smoother, and the
 * zero-filled series would otherwise stretch back to a stray epoch-0 event
 * (decades of days × the 729-point parameter grid) on every snapshot.
 */
const MAX_HISTORY_DAYS = 180;

/**
 * Mean squared one-step-ahead forecast error for given Holt-Winters params.
 * Uses the first `PERIOD` observations only for initialisation.
 */
function hwMse(series: number[], alpha: number, beta: number, gamma: number): number {
  const m = PERIOD;
  const n = series.length;
  if (n <= m) return Infinity;

  /* c8 ignore next */
  const initAvg = series.slice(0, m).reduce((a, b) => a + b, 0) / m || 1;
  let L = initAvg;
  let B = 0;
  const S = series.slice(0, m).map((v) => v - initAvg);

  let totalSE = 0;
  const count = n - m;
  for (let t = m; t < n; t++) {
    const y = series[t]!;
    const si = S[t % m]!;
    const yHat = Math.max(0, L + B + si);
    totalSE += (y - yHat) ** 2;
    const prevL = L;
    L = alpha * (y - si) + (1 - alpha) * (L + B);
    B = beta * (L - prevL) + (1 - beta) * B;
    S[t % m] = gamma * (y - L) + (1 - gamma) * si;
  }
  return totalSE / count;
}

/**
 * Replay Holt-Winters on the series and return the final state (L, B, S[]).
 * S[] has length PERIOD — the current seasonal indices after processing all data.
 */
function hwState(
  series: number[],
  alpha: number,
  beta: number,
  gamma: number,
): { L: number; B: number; S: number[]; residualStd: number } {
  const m = PERIOD;
  const n = series.length;
  /* c8 ignore next */
  const initAvg = series.slice(0, Math.min(m, n)).reduce((a, b) => a + b, 0) / Math.min(m, n) || 1;
  let L = initAvg;
  let B = 0;
  const S = series.slice(0, Math.min(m, n)).map((v) => v - initAvg);
  while (S.length < m) S.push(0);

  let sse = 0;
  let count = 0;
  for (let t = 0; t < n; t++) {
    const y = series[t]!;
    const si = S[t % m]!;
    if (t >= m) {
      sse += (y - Math.max(0, L + B + si)) ** 2;
      count++;
    }
    const prevL = L;
    L = alpha * (y - si) + (1 - alpha) * (L + B);
    B = beta * (L - prevL) + (1 - beta) * B;
    S[t % m] = gamma * (y - L) + (1 - gamma) * si;
  }
  return { L, B, S: [...S], residualStd: Math.sqrt(count > 0 ? sse / count : 0) };
}

/**
 * Fit Holt-Winters parameters by coarse grid-search over [0.1, 0.9] in steps
 * of 0.1 for alpha, beta, and gamma.  Returns the best-fitting params.
 * `fittedAt` is a stamp for the caller's cache; it defaults to the wall clock
 * only so ad-hoc callers need not pass one (the forecaster passes its `now`).
 */
export function fitHoltWinters(series: number[], fittedAt: number = Date.now()): HoltWintersParams {
  const m = PERIOD;
  const STEPS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

  let bestAlpha = 0.3;
  let bestBeta = 0.1;
  let bestGamma = 0.2;
  let bestMse = Infinity;

  for (const alpha of STEPS) {
    for (const beta of STEPS) {
      for (const gamma of STEPS) {
        const mse = hwMse(series, alpha, beta, gamma);
        if (mse < bestMse) {
          bestMse = mse;
          bestAlpha = alpha;
          bestBeta = beta;
          bestGamma = gamma;
        }
      }
    }
  }

  const { S } = hwState(series, bestAlpha, bestBeta, bestGamma);

  // AIC: n * ln(MSE) + 2 * k, k = 3 params + m seasonal indices
  const n = Math.max(1, series.length - m);
  const aic = n * Math.log(Math.max(1e-10, bestMse)) + 2 * (3 + m);

  return {
    alpha: bestAlpha,
    beta: bestBeta,
    gamma: bestGamma,
    seasonalIndices: S,
    aic,
    fittedAt,
  };
}

/**
 * Gap-free daily credit series: every local calendar day from the first day
 * with data up to (not including) `endExclusive`, zero for idle days. The
 * aggregates only contain days that had events, but Holt-Winters indexes its
 * weekly seasonality by position — dropping idle days shifts every later
 * weekday. Days at or after `endExclusive` (today's partial day) are left out,
 * and so is anything older than MAX_HISTORY_DAYS.
 */
function dailySeries(dayAggregates: UsageAggregate[], endExclusive: number): number[] {
  const byDay = new Map<number, number>();
  const oldest = dayStartOffset(endExclusive, -MAX_HISTORY_DAYS);
  let first = Number.POSITIVE_INFINITY;
  for (const a of dayAggregates) {
    const day = startOf(a.start, 'day');
    if (day >= endExclusive || day < oldest) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + a.credits);
    if (day < first) first = day;
  }
  const series: number[] = [];
  for (let day = first; day < endExclusive; day = nextBucketStart(day, 'day')) {
    series.push(byDay.get(day) ?? 0);
  }
  return series;
}

export const seasonalForecaster: Forecaster = {
  forecast({ dayAggregates, now, pricePerCredit }: ForecastInput): Forecast {
    const { monthStart, monthEnd, todayStart, remainingDays } = monthPosition(now);

    const monthDays = dayAggregates.filter((a) => a.start >= monthStart && a.start < monthEnd);
    const mtdCredits = monthDays.reduce((s, a) => s + a.credits, 0);
    const todayCredits = monthDays
      .filter((a) => startOf(a.start, 'day') === todayStart)
      .reduce((s, a) => s + a.credits, 0);
    const asOf = now;

    // Fit on complete days only: today is still partial, and feeding its
    // half-day total to the smoother would drag the level and today's weekday
    // index down. The series ends yesterday, so the first forecast step (h = 1)
    // is today.
    const series = dailySeries(dayAggregates, todayStart);
    if (series.length <= PERIOD) {
      return {
        granularity: 'month',
        projectedCredits: mtdCredits,
        projectedCost: mtdCredits * pricePerCredit,
        low: mtdCredits,
        high: mtdCredits,
        basis: 'insufficient-data',
        asOf,
      };
    }

    const params = fitHoltWinters(series, now);
    const { L, B, S, residualStd } = hwState(series, params.alpha, params.beta, params.gamma);
    const expected = (h: number): number =>
      Math.max(0, L + h * B + S[(series.length + h - 1) % PERIOD]!);

    // Today's credits are already in mtdCredits; add what is still expected of
    // it (it should finish at least at the model's value for its weekday),
    // then every remaining day of the month.
    let forecastedRemaining = Math.max(0, expected(1) - todayCredits);
    for (let h = 2; h <= remainingDays + 1; h++) forecastedRemaining += expected(h);

    const projectedCredits = mtdCredits + forecastedRemaining;
    const band = residualStd * Math.sqrt(Math.max(1, remainingDays));

    return {
      granularity: 'month',
      projectedCredits,
      projectedCost: projectedCredits * pricePerCredit,
      low: Math.max(mtdCredits, projectedCredits - band),
      high: projectedCredits + band,
      basis: 'seasonal',
      asOf,
    };
  },
/* c8 ignore next */
};

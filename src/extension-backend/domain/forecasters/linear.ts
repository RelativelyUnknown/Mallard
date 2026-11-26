/* c8 ignore next */
/**
 * Linear run-rate forecaster. The confidence band widens with the number of
 * remaining days (uncertainty compounds) and never dips below the
 * month-to-date total.
 *
 * Today is a partial day. Counting it as a full elapsed day diluted the rate
 * every morning (and the projection sawtoothed at midnight), so the rate and
 * variance come from the complete days before today only; today contributes
 * its actual credits to the month-to-date total and is expected to finish at
 * least at the typical daily rate.
 */
import { Forecast, UsageAggregate } from '../types';
import { nextBucketStart, startOf } from '../../util/time';

export interface ForecastInput {
  dayAggregates: UsageAggregate[];
  now: number;
  pricePerCredit: number;
}

export interface Forecaster {
  forecast(input: ForecastInput): Forecast;
}

export interface MonthPosition {
  monthStart: number;
  monthEnd: number;
  /** Local midnight of the day containing `now`. */
  todayStart: number;
  totalDays: number;
  /** Calendar days of the month up to and including today. */
  elapsedDays: number;
  /** Whole calendar days after today. */
  remainingDays: number;
}

/** Where `now` sits in its month, counted in calendar days (DST-safe). */
export function monthPosition(now: number): MonthPosition {
  const monthStart = startOf(now, 'month');
  const monthEnd = nextBucketStart(now, 'month');
  const todayStart = startOf(now, 'day');
  let totalDays = 0;
  let elapsedDays = 0;
  for (let day = monthStart; day < monthEnd; day = nextBucketStart(day, 'day')) {
    totalDays++;
    if (day <= todayStart) elapsedDays++;
  }
  return { monthStart, monthEnd, todayStart, totalDays, elapsedDays, remainingDays: totalDays - elapsedDays };
}

export const linearForecaster: Forecaster = {
  forecast({ dayAggregates, now, pricePerCredit }): Forecast {
    const { monthStart, monthEnd, todayStart, elapsedDays, remainingDays } = monthPosition(now);
    const completeDays = elapsedDays - 1; // days of this month before today

    const monthDays = dayAggregates.filter((a) => a.start >= monthStart && a.start < monthEnd);
    const mtdCredits = monthDays.reduce((s, a) => s + a.credits, 0);
    const activeDays = monthDays.filter((a) => a.credits > 0).length;
    const asOf = now;

    if (activeDays < 3 || completeDays < 1) {
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

    // Per-day totals of the complete days (zero-filled) for rate and variance.
    const byDayStart = new Map<number, number>();
    for (const a of monthDays) byDayStart.set(a.start, a.credits);
    const dailyTotals: number[] = [];
    for (let day = monthStart; day < todayStart; day = nextBucketStart(day, 'day')) {
      dailyTotals.push(byDayStart.get(day) ?? 0);
    }
    const dailyRate = dailyTotals.reduce((s, v) => s + v, 0) / dailyTotals.length;

    // Today's own credits are already in mtdCredits; add what is still expected.
    const todayRemainder = Math.max(0, dailyRate - (byDayStart.get(todayStart) ?? 0));
    const projectedCredits = mtdCredits + todayRemainder + dailyRate * remainingDays;

    const variance =
      dailyTotals.reduce((s, v) => s + (v - dailyRate) ** 2, 0) / dailyTotals.length;
    const stdev = Math.sqrt(variance);
    const band = stdev * Math.sqrt(remainingDays + (todayRemainder > 0 ? 1 : 0));

    return {
      granularity: 'month',
      projectedCredits,
      projectedCost: projectedCredits * pricePerCredit,
      low: Math.max(mtdCredits, projectedCredits - band),
      high: projectedCredits + band,
      basis: 'linear',
      asOf,
    };
  },
/* c8 ignore next */
};

import { strict as assert } from 'assert';
import { aggregateBy } from '../../../src/extension-backend/domain/aggregate';
import { linearForecaster, monthPosition } from '../../../src/extension-backend/domain/forecasters/linear';
import { startOf, nextBucketStart, DAY_MS } from '../../../src/extension-backend/util/time';
import { makeEvent } from '../helpers';

function makeDayEvents(dayOffsets: number[], creditsPerDay: number, monthStart: number) {
  return dayOffsets.map((d, i) =>
    makeEvent({ id: `d${d}-${i}`, ts: monthStart + d * DAY_MS + DAY_MS / 2, credits: creditsPerDay }),
  );
}

describe('linearForecaster', () => {
  it('returns insufficient-data when activeDays < 3', () => {
    const now = new Date(2026, 5, 10, 12).getTime();
    const monthStart = startOf(now, 'month');
    const events = [
      makeEvent({ id: 'a', ts: monthStart + DAY_MS / 2, credits: 5 }),
      makeEvent({ id: 'b', ts: monthStart + DAY_MS + DAY_MS / 2, credits: 5 }),
    ];
    const dayAggregates = aggregateBy(events, 'day');
    const f = linearForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.04 });
    assert.equal(f.basis, 'insufficient-data');
    assert.equal(f.projectedCredits, 10);
    assert.equal(f.low, 10);
    assert.equal(f.high, 10);
  });

  it('returns insufficient-data when elapsedDays <= 0 (now before monthStart)', () => {
    const now = new Date(2026, 5, 1).getTime();
    // monthStart at midnight on June 1 — elapsedDays = floor((0)/DAY_MS)+1 = 1 normally,
    // so use a now that is literally before the month boundary
    const monthStart = startOf(now, 'month');
    const beforeMonth = monthStart - 1;
    // Provide 3+ active days from a prior window so activeDays check passes if reached,
    // but elapsedDays <= 0 fires first when monthDays is empty
    const f = linearForecaster.forecast({ dayAggregates: [], now: beforeMonth, pricePerCredit: 0.04 });
    assert.equal(f.basis, 'insufficient-data');
  });

  it('produces zero band at end of month (remainingDays = 0)', () => {
    const now = new Date(2026, 5, 30, 23, 0).getTime(); // last day of June 2026
    const monthStart = startOf(now, 'month');
    const monthEnd = nextBucketStart(now, 'month');
    const totalDays = Math.round((monthEnd - monthStart) / DAY_MS);
    // Events on days 0..totalDays-1
    const events = Array.from({ length: totalDays }, (_, d) =>
      makeEvent({ id: `d${d}`, ts: monthStart + d * DAY_MS + DAY_MS / 2, credits: 10 }),
    );
    const dayAggregates = aggregateBy(events, 'day');
    const f = linearForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.04 });
    assert.equal(f.basis, 'linear');
    // band = stdev * sqrt(0) = 0, so low = high = projected
    assert.ok(Math.abs(f.high - f.low) < 1e-6, `low (${f.low}) should equal high (${f.high})`);
  });

  it('zero-fills missing days in variance calculation', () => {
    const now = new Date(2026, 5, 10, 12).getTime();
    const monthStart = startOf(now, 'month');
    // Only 3 active days spread non-consecutively (gaps get zero-filled)
    const events = [
      makeEvent({ id: 'a', ts: monthStart + 0 * DAY_MS + DAY_MS / 2, credits: 10 }),
      makeEvent({ id: 'b', ts: monthStart + 4 * DAY_MS + DAY_MS / 2, credits: 10 }),
      makeEvent({ id: 'c', ts: monthStart + 8 * DAY_MS + DAY_MS / 2, credits: 10 }),
    ];
    const dayAggregates = aggregateBy(events, 'day');
    const f = linearForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.04 });
    assert.equal(f.basis, 'linear');
    // With gaps, variance is non-zero → band > 0 → high > low
    assert.ok(f.high > f.low, 'band should be positive with zero-filled gaps');
  });

  it('low is clamped to mtdCredits when projected - band < mtdCredits', () => {
    const now = new Date(2026, 5, 5, 12).getTime();
    const monthStart = startOf(now, 'month');
    // High variance: days 0,1,2 have wildly different credits → band can exceed remaining projection
    const events = [
      makeEvent({ id: 'a', ts: monthStart + 0 * DAY_MS + DAY_MS / 2, credits: 0.01 }),
      makeEvent({ id: 'b', ts: monthStart + 1 * DAY_MS + DAY_MS / 2, credits: 1000 }),
      makeEvent({ id: 'c', ts: monthStart + 2 * DAY_MS + DAY_MS / 2, credits: 0.01 }),
    ];
    const dayAggregates = aggregateBy(events, 'day');
    const mtdCredits = 1000.02;
    const f = linearForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.04 });
    assert.equal(f.basis, 'linear');
    assert.ok(f.low >= mtdCredits - 1e-6, `low (${f.low}) should be >= mtdCredits (${mtdCredits})`);
  });

  it('projects cost using pricePerCredit', () => {
    const now = new Date(2026, 5, 10, 12).getTime();
    const monthStart = startOf(now, 'month');
    const events = makeDayEvents([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 10, monthStart);
    const dayAggregates = aggregateBy(events, 'day');
    const f = linearForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.05 });
    assert.ok(Math.abs(f.projectedCost - f.projectedCredits * 0.05) < 1e-6);
  });
});

describe('linearForecaster — today is a partial day', () => {
  const june = (day: number, hour = 12) => new Date(2026, 5, day, hour).getTime();
  const steadyDays = (days: number[], credits: number) =>
    aggregateBy(days.map((d) => makeEvent({ id: `d${d}`, ts: june(d), credits })), 'day');

  it('does not dilute the rate with an idle just-started day', () => {
    // 9 complete days of 10 credits, then 00:10 on day 10 with nothing logged yet.
    const dayAggregates = steadyDays([1, 2, 3, 4, 5, 6, 7, 8, 9], 10);
    const f = linearForecaster.forecast({ dayAggregates, now: june(10, 0) + 10 * 60_000, pricePerCredit: 0.04 });
    assert.equal(f.basis, 'linear');
    // 90 so far + today expected at the typical 10 + 20 more days at 10.
    assert.ok(Math.abs(f.projectedCredits - 300) < 1e-9, `got ${f.projectedCredits}`);
  });

  it('adds no phantom credits once today is already above the typical rate', () => {
    const dayAggregates = aggregateBy(
      [
        ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => makeEvent({ id: `d${d}`, ts: june(d), credits: 10 })),
        makeEvent({ id: 'today', ts: june(10, 9), credits: 25 }),
      ],
      'day',
    );
    const f = linearForecaster.forecast({ dayAggregates, now: june(10, 18), pricePerCredit: 0.04 });
    // mtd 115 (today stays at its 25) + 20 remaining days at the complete-day rate of 10.
    assert.ok(Math.abs(f.projectedCredits - 315) < 1e-9, `got ${f.projectedCredits}`);
  });

  it('needs at least one complete day', () => {
    // Three active days exist, but it is still the 1st: no complete day to measure a rate from.
    const dayAggregates = steadyDays([1, 2, 3], 10);
    const f = linearForecaster.forecast({ dayAggregates, now: june(1, 20), pricePerCredit: 0.04 });
    assert.equal(f.basis, 'insufficient-data');
  });
});

describe('monthPosition', () => {
  it('counts calendar days, not 24h blocks, across DST', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      // Last hour of the 25h fall-back day (Nov 1): still day 1.
      assert.equal(monthPosition(new Date(2026, 10, 1, 23, 30).getTime()).elapsedDays, 1);
      // First hour after the 23h spring-forward day (Mar 8): day 9 of 31.
      const spring = monthPosition(new Date(2026, 2, 9, 0, 30).getTime());
      assert.equal(spring.elapsedDays, 9);
      assert.equal(spring.totalDays, 31);
      assert.equal(spring.remainingDays, 22);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

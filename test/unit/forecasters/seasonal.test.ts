import { strict as assert } from 'assert';
import { aggregateBy } from '../../../src/extension-backend/domain/aggregate';
import { fitHoltWinters, seasonalForecaster } from '../../../src/extension-backend/domain/forecasters/seasonal';
import { startOf, nextBucketStart, DAY_MS } from '../../../src/extension-backend/util/time';
import { makeEvent } from '../helpers';

describe('fitHoltWinters', () => {
  it('handles short series (< PERIOD=7): all MSEs are Infinity, still returns params', () => {
    const params = fitHoltWinters([1, 2, 3]);
    assert.ok(typeof params.alpha === 'number');
    assert.ok(typeof params.beta === 'number');
    assert.ok(typeof params.gamma === 'number');
    assert.equal(params.seasonalIndices.length, 7);
    // With a 3-element series, hwMse always returns Infinity → bestMse stays Infinity
    // AIC = n * log(Infinity) + 2*(3+7) → Infinity
    assert.ok(!isFinite(params.aic));
    assert.ok(params.fittedAt > 0);
  });

  it('handles a series of exactly PERIOD length (boundary)', () => {
    const params = fitHoltWinters([1, 2, 3, 4, 5, 6, 7]);
    assert.equal(params.seasonalIndices.length, 7);
    // n <= m for all grid points → Infinity MSE
    assert.ok(!isFinite(params.aic));
  });

  it('returns valid params for a full seasonal series', () => {
    const series = Array.from({ length: 21 }, (_, i) => 10 + (i % 7 < 5 ? 5 : 0));
    const params = fitHoltWinters(series);
    assert.ok(params.alpha > 0 && params.alpha <= 1);
    assert.ok(params.beta > 0 && params.beta <= 1);
    assert.ok(params.gamma > 0 && params.gamma <= 1);
    assert.equal(params.seasonalIndices.length, 7);
    assert.ok(isFinite(params.aic));
  });
});

describe('seasonalForecaster', () => {
  it('returns a seasonal basis for 14+ days of data', () => {
    const now = new Date(2026, 5, 20, 12).getTime();
    const monthStart = startOf(now, 'month');
    const events = Array.from({ length: 14 }, (_, d) =>
      makeEvent({ id: `d${d}`, ts: monthStart + d * DAY_MS + DAY_MS / 2, credits: 10 + (d % 3) }),
    );
    const dayAggregates = aggregateBy(events, 'day');
    const f = seasonalForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.04 });
    assert.equal(f.basis, 'seasonal');
    assert.ok(f.projectedCredits > 0);
    assert.ok(f.low <= f.projectedCredits);
    assert.ok(f.high >= f.projectedCredits);
  });

  it('projectedCredits equals mtdCredits when remainingDays is 0', () => {
    // Place now at the last day of the month so remainingDays = 0
    const now = new Date(2026, 5, 30, 23, 30).getTime(); // June 30
    const monthStart = startOf(now, 'month');
    const monthEnd = nextBucketStart(now, 'month');
    const totalDays = Math.round((monthEnd - monthStart) / DAY_MS);
    const events = Array.from({ length: totalDays }, (_, d) =>
      makeEvent({ id: `d${d}`, ts: monthStart + d * DAY_MS + DAY_MS / 2, credits: 10 }),
    );
    const dayAggregates = aggregateBy(events, 'day');
    const mtdCredits = dayAggregates
      .filter((a) => a.start >= monthStart && a.start < monthEnd)
      .reduce((s, a) => s + a.credits, 0);
    const f = seasonalForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.04 });
    // forecastedRemaining loop doesn't execute → projectedCredits = mtdCredits
    assert.ok(Math.abs(f.projectedCredits - mtdCredits) < 1e-6);
  });

  it('low is clamped to mtdCredits', () => {
    const now = new Date(2026, 5, 20, 12).getTime();
    const monthStart = startOf(now, 'month');
    const events = Array.from({ length: 14 }, (_, d) =>
      makeEvent({ id: `d${d}`, ts: monthStart + d * DAY_MS + DAY_MS / 2, credits: 10 }),
    );
    const dayAggregates = aggregateBy(events, 'day');
    const mtdCredits = dayAggregates
      .filter((a) => a.start >= monthStart && a.start < nextBucketStart(now, 'month'))
      .reduce((s, a) => s + a.credits, 0);
    const f = seasonalForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.04 });
    assert.ok(f.low >= mtdCredits - 1e-6, `low (${f.low}) must be >= mtdCredits (${mtdCredits})`);
  });

  it('applies pricePerCredit to projectedCost', () => {
    const now = new Date(2026, 5, 20, 12).getTime();
    const monthStart = startOf(now, 'month');
    const events = Array.from({ length: 14 }, (_, d) =>
      makeEvent({ id: `d${d}`, ts: monthStart + d * DAY_MS + DAY_MS / 2, credits: 10 }),
    );
    const dayAggregates = aggregateBy(events, 'day');
    const f = seasonalForecaster.forecast({ dayAggregates, now, pricePerCredit: 0.05 });
    assert.ok(Math.abs(f.projectedCost - f.projectedCredits * 0.05) < 1e-6);
  });
});

describe('seasonalForecaster — gap-free series and the partial day', () => {
  const june = (day: number, hour = 12) => new Date(2026, 5, day, hour).getTime(); // 2026-06-01 is a Monday

  // Mon–Fri usage only: the aggregates simply have no rows for weekends.
  const weekdays = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 15, 16, 17, 18, 19, 22, 23];
  const weekends = [6, 7, 13, 14, 20, 21];

  it('treats days without events as zero-credit days', () => {
    const events = [
      ...weekdays.map((d) => makeEvent({ id: `wd${d}`, ts: june(d), credits: 10 })),
      makeEvent({ id: 'today', ts: june(24, 9), credits: 4 }), // Wed, partial
    ];
    const sparse = aggregateBy(events, 'day');
    const dense = aggregateBy(
      [...events, ...weekends.map((d) => makeEvent({ id: `we${d}`, ts: june(d), credits: 0 }))],
      'day',
    );
    const now = june(24, 12);

    const fromSparse = seasonalForecaster.forecast({ dayAggregates: sparse, now, pricePerCredit: 0.04 });
    const fromDense = seasonalForecaster.forecast({ dayAggregates: dense, now, pricePerCredit: 0.04 });

    assert.equal(fromSparse.basis, 'seasonal');
    assert.ok(Math.abs(fromSparse.projectedCredits - fromDense.projectedCredits) < 1e-9,
      'idle days must not change the result whether or not they appear as zero rows');
    // Remaining: today's rest (~6) + Thu, Fri, Mon, Tue (~40) + a quiet weekend,
    // not the ~60 a weekend-blind series projects.
    const mtd = 17 * 10 + 4;
    const remainder = fromSparse.projectedCredits - mtd;
    assert.ok(remainder > 38 && remainder < 52, `remaining ${remainder.toFixed(1)} should reflect the idle weekend`);
  });

  it('fits complete days only and expects today to finish at the model value for its weekday', () => {
    // 19 steady days (Jun 1–19), then 09:00–12:00 of day 20 with 1 credit so far.
    const events = [
      ...Array.from({ length: 19 }, (_, i) => makeEvent({ id: `d${i}`, ts: june(i + 1), credits: 10 })),
      makeEvent({ id: 'today', ts: june(20, 9), credits: 1 }),
    ];
    const f = seasonalForecaster.forecast({
      dayAggregates: aggregateBy(events, 'day'),
      now: june(20, 12),
      pricePerCredit: 0.04,
    });
    // mtd 191 + today brought up to 10 (+9) + 10 remaining days × 10.
    assert.ok(Math.abs(f.projectedCredits - 300) < 1e-6, `got ${f.projectedCredits}`);
  });

  it('reports insufficient-data instead of fitting a week or less of history', () => {
    const events = Array.from({ length: 5 }, (_, i) => makeEvent({ id: `d${i}`, ts: june(i + 1), credits: 10 }));
    const f = seasonalForecaster.forecast({
      dayAggregates: aggregateBy(events, 'day'),
      now: june(6, 12), // day 6: five complete days behind it
      pricePerCredit: 0.04,
    });
    assert.equal(f.basis, 'insufficient-data');
    assert.equal(f.projectedCredits, 50);
  });

  it('is deterministic — the fit stamp comes from the injected clock', () => {
    assert.equal(fitHoltWinters([1, 2, 3, 4, 5, 6, 7, 8, 9], 1234).fittedAt, 1234);
  });
});

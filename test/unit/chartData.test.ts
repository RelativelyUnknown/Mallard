import { strict as assert } from 'assert';
import { aggregateBy } from '../../src/extension-backend/domain/aggregate';
import {
  buildCategoryBreakdownData,
  buildChartData,
  buildDailyBarsData,
  buildHeatmapData,
  buildCategoryTrendData,
  buildHourlyTimelineData,
  buildModelBreakdownData,
  buildTokensDailyData,
  buildWeekdayData,
  buildWeekdayTotals,
} from '../../src/extension-backend/domain/chartData';
import { PricingManifest } from '../../src/extension-backend/domain/pricing';
import { BudgetState, Forecast, TopEntry } from '../../src/extension-backend/domain/types';
import { DAY_MS, daysInMonth, startOf } from '../../src/extension-backend/util/time';
import { makeEvent } from './helpers';

const EMPTY_BUDGET: BudgetState = {
  monthly: null,
  includedCredits: 0,
  usedCredits: 0,
  usedCost: 0,
  percentOfBudget: 0,
  percentOfIncluded: 0,
  projectedOverage: null,
  pace: 'no-budget',
};

const INSUF_FORECAST: Forecast = {
  granularity: 'month',
  projectedCredits: 0,
  projectedCost: 0,
  low: 0,
  high: 0,
  basis: 'insufficient-data',
  asOf: 0,
};

describe('buildWeekdayTotals', () => {
  // Local noon (new Date(y, m, d, h) builds in the host zone), because the
  // weekday is bucketed by the local calendar day. A UTC-noon instant lands on
  // the NEXT local day in zones ahead of +12h (e.g. Pacific/Auckland).
  it('anchors index 0 on Sunday (epoch day 0 was a Thursday)', () => {
    // 2021-01-03 is a Sunday, 2021-01-04 a Monday, 2021-01-09 a Saturday.
    const sun = new Date(2021, 0, 3, 12).getTime();
    const mon = new Date(2021, 0, 4, 12).getTime();
    const sat = new Date(2021, 0, 9, 12).getTime();
    const totals = buildWeekdayTotals([
      makeEvent({ ts: sun, credits: 1 }),
      makeEvent({ ts: mon, credits: 2 }),
      makeEvent({ ts: sat, credits: 3 }),
    ]);
    assert.equal(totals[0], 1, 'Sunday → index 0');
    assert.equal(totals[1], 2, 'Monday → index 1');
    assert.equal(totals[6], 3, 'Saturday → index 6');
  });

  for (const tz of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC', 'Pacific/Kiritimati']) {
    it(`buckets by the local calendar day whatever the host zone (TZ=${tz})`, () => {
      withTimezone(tz, () => {
        // Just after local midnight and just before the next one: same local weekday, 24h apart in UTC terms.
        const earlySunday = new Date(2021, 0, 3, 0, 5).getTime();
        const lateSunday = new Date(2021, 0, 3, 23, 55).getTime();
        const earlyMonday = new Date(2021, 0, 4, 0, 5).getTime();
        const totals = buildWeekdayTotals([
          makeEvent({ ts: earlySunday, credits: 1 }),
          makeEvent({ ts: lateSunday, credits: 2 }),
          makeEvent({ ts: earlyMonday, credits: 4 }),
        ]);
        assert.deepEqual(totals, [3, 4, 0, 0, 0, 0, 0]);
      });
    });
  }
});

describe('buildDailyBarsData', () => {
  it('returns 30 points for any input', () => {
    const data = buildDailyBarsData([], EMPTY_BUDGET, INSUF_FORECAST, Date.now());
    assert.strictEqual(data.points.length, 30);
    assert.strictEqual(data.budgetLine, null);
    assert.strictEqual(data.projectedLine, null);
  });

  it('assigns correct color indices based on daily budget', () => {
    const now = startOf(Date.now(), 'day');
    const events = [
      { ts: now - 2 * DAY_MS, credits: 1, cost: 0.04 },
      { ts: now - 1 * DAY_MS, credits: 8, cost: 0.32 },
    ];
    // Use aggregateBy to get UsageAggregate[] in the expected shape

    const evts = events.map((e) => makeEvent(e));
    const dayAggs = aggregateBy(evts, 'day');

    const budget: BudgetState = { ...EMPTY_BUDGET, includedCredits: 100 };
    const data = buildDailyBarsData(dayAggs, budget, INSUF_FORECAST, now);

    // The daily budget is the month's allowance spread over the month (it used to be
    // divided by the 30-day chart window, which only agreed for 30-day months).
    assert.strictEqual(data.budgetLine, 100 / daysInMonth(now));
    // day with 1 credit out of ≈3.3 → ratio ≈ 0.3 → blue (0)
    const lowDay = data.points.find((p) => p.credits === 1);
    assert.ok(lowDay, 'expected a low-credit day');
    assert.strictEqual(lowDay!.colorIndex, 0);

    // day with 8 credits out of ≈3.3 → ratio ≈ 2.4 → red (2)
    const highDay = data.points.find((p) => p.credits === 8);
    assert.ok(highDay, 'expected a high-credit day');
    assert.strictEqual(highDay!.colorIndex, 2);
  });

  it('assigns colorIndex 1 when credits are between 70% and 100% of daily budget', () => {
    const now = startOf(Date.now(), 'day');
    const evts = [makeEvent({ ts: now - 1 * DAY_MS, credits: 2.5, cost: 0.1 })];
    const dayAggs = aggregateBy(evts, 'day');
    // includedCredits=90 → dailyBudget = 90 / daysInMonth ≈ 2.9–3.2, credits=2.5 → ratio ≈ 0.78–0.86 → colorIndex=1
    const budget: BudgetState = { ...EMPTY_BUDGET, includedCredits: 90 };
    const data = buildDailyBarsData(dayAggs, budget, INSUF_FORECAST, now);
    const day = data.points.find((p) => p.credits === 2.5);
    assert.ok(day, 'expected a day with 2.5 credits');
    assert.strictEqual(day!.colorIndex, 1);
  });

  it('sets projectedLine when forecast is available', () => {
    const forecast: Forecast = { ...INSUF_FORECAST, basis: 'linear', projectedCredits: 300 };
    const now = Date.now();
    const data = buildDailyBarsData([], EMPTY_BUDGET, forecast, now);
    assert.strictEqual(data.projectedLine, 300 / daysInMonth(now)); // month projection spread over the month
  });

  it('formats dates as MM-DD', () => {
    const data = buildDailyBarsData([], EMPTY_BUDGET, INSUF_FORECAST, Date.now());
    for (const p of data.points) {
      assert.match(p.date, /^\d{2}-\d{2}$/, `expected MM-DD, got ${p.date}`);
    }
  });
});

describe('buildModelBreakdownData', () => {
  it('strips provider prefixes and truncates labels', () => {
    const tops: TopEntry[] = [
      { key: 'openai/gpt-4o', credits: 10, cost: 0.4, tokens: 1000 },
      { key: 'anthropic/claude-sonnet-4', credits: 5, cost: 0.2, tokens: 500 },
      { key: 'models/gemini-pro', credits: 2, cost: 0.08, tokens: 200 },
    ];
    const data = buildModelBreakdownData(tops, 0.04);
    assert.deepStrictEqual(data.labels, ['gpt-4o', 'claude-sonnet-4', 'gemini-pro']);
    assert.deepStrictEqual(data.credits, [10, 5, 2]);
    assert.deepStrictEqual(data.costs, [0.4, 0.2, 0.08]);
  });

  it('uses minMultiplier from manifest when models have non-zero multipliers', () => {
    const tops: TopEntry[] = [
      { key: 'gpt-4o', credits: 10, cost: 0.4, tokens: 1000 },
    ];
    const manifest: PricingManifest = {
      version: 1,
      pricePerCredit: 0.04,
      updatedAt: '2025-01-01',
      models: { 'gpt-4o': 0.5, 'claude-opus-4': 10 },
    };
    const data = buildModelBreakdownData(tops, 0.04, manifest);
    // minMultiplier = min(0.5, 10) = 0.5; cheapest = 1000 * 0.5 * 0.04 = 20
    assert.ok(data.cheapestEquivalentCosts.length > 0);
    assert.ok(Math.abs(data.cheapestEquivalentCosts[0]! - 20) < 0.001);
  });

  it('strips google/ prefix via shortModelName', () => {
    const tops: TopEntry[] = [
      { key: 'google/gemini-pro', credits: 5, cost: 0.2, tokens: 500 },
    ];
    const data = buildModelBreakdownData(tops, 0.04);
    assert.strictEqual(data.labels[0], 'gemini-pro');
  });

  it('caps at 8 models', () => {
    const tops: TopEntry[] = Array.from({ length: 12 }, (_, i) => ({
      key: `model-${i}`,
      credits: i,
      cost: i * 0.04,
      tokens: i * 100,
    }));
    const data = buildModelBreakdownData(tops, 0.04);
    assert.strictEqual(data.labels.length, 8);
  });
});

describe('buildHourlyTimelineData', () => {
  it('accumulates credits per hour', () => {
    const now = new Date(2026, 2, 18, 10).getTime(); // 10am local
    const events = [
      makeEvent({ ts: now, credits: 3, modelId: 'gpt-4o' }),
      makeEvent({ ts: now, credits: 5, modelId: 'claude-sonnet-4' }),
    ];
    const data = buildHourlyTimelineData(events);
    assert.equal(data.hours[10], 8);
    assert.equal(data.peakHour, 10);
  });

  it('skips events that do not match the filter', () => {
    const now = new Date(2026, 2, 18, 10).getTime();
    const events = [
      makeEvent({ ts: now, credits: 5, modelId: 'gpt-4o' }),
      makeEvent({ ts: now, credits: 3, modelId: 'claude-sonnet-4' }),
    ];
    const data = buildHourlyTimelineData(events, { models: ['gpt-4o'] });
    assert.equal(data.hours[10], 5);
  });
});

describe('buildCategoryBreakdownData', () => {
  it('reports unavailable when no event carries a breakdown', () => {
    const data = buildCategoryBreakdownData([makeEvent({ ts: 1000, cost: 0.04 })]);
    assert.strictEqual(data.available, false);
    assert.deepStrictEqual(data.categories, []);
  });

  it('sums per-category cost in canonical order, dropping zero buckets', () => {
    const events = [
      makeEvent({ ts: 1000, cost: 0.1, costByCategory: { input: 0.06, output: 0.04 } }),
      makeEvent({ ts: 2000, cost: 0.05, costByCategory: { output: 0.05, tool: 0 } }),
    ];
    const data = buildCategoryBreakdownData(events);
    assert.strictEqual(data.available, true);
    assert.deepStrictEqual(data.categories, ['input', 'output']);
    assert.ok(Math.abs(data.costs[0]! - 0.06) < 1e-9);
    assert.ok(Math.abs(data.costs[1]! - 0.09) < 1e-9);
  });
});

describe('buildHeatmapData', () => {
  it('defaults to a full year (52 weeks) of cells', () => {
    const now = startOf(Date.now(), 'day');
    const data = buildHeatmapData([], now);
    assert.strictEqual(data.cells.length, 52 * 7 + 1); // inclusive range
    assert.strictEqual(data.max, 0);
  });

  it('maps aggregate credits to the correct date', () => {
    const now = startOf(Date.now(), 'day');
    const targetDay = now - 3 * DAY_MS;

    const dayAggs = aggregateBy([makeEvent({ ts: targetDay, credits: 7 })], 'day');
    const data = buildHeatmapData(dayAggs, now);

    const dt = new Date(targetDay);
    const targetLocal = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
    const cell = data.cells.find((c) => c.date === targetLocal);
    assert.ok(cell, 'expected cell for target day');
    assert.strictEqual(cell!.value, 7);
    assert.strictEqual(data.max, 7);
  });

  it('labels cells using local calendar dates, not UTC (regression)', () => {
    // In timezones ahead of UTC, local midnight is still the previous UTC
    // day — a naive toISOString().slice(0,10) would mislabel every cell one
    // day earlier. Force a UTC+2 zone to catch that regression.
    const originalTz = process.env.TZ;
    process.env.TZ = 'Europe/Amsterdam';
    try {
      const now = startOf(Date.now(), 'day');
      const targetDay = now - 3 * DAY_MS;
      const dayAggs = aggregateBy([makeEvent({ ts: targetDay, credits: 9 })], 'day');
      const data = buildHeatmapData(dayAggs, now);

      const dt = new Date(targetDay);
      const targetLocal = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      const targetUtc = new Date(targetDay).toISOString().slice(0, 10);

      const cell = data.cells.find((c) => c.date === targetLocal);
      assert.ok(cell, 'expected cell keyed by local calendar date');
      assert.strictEqual(cell!.value, 9);
      assert.notStrictEqual(
        targetLocal,
        targetUtc,
        'test is only meaningful when local and UTC dates actually differ',
      );
      assert.ok(
        !data.cells.some((c) => c.date === targetUtc && c.value === 9),
        'value must not be mislabeled under the UTC date',
      );
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });
});

describe('buildCategoryBreakdownData — filter', () => {
  it('excludes events not matching the filter', () => {
    const events = [
      makeEvent({ ts: 1_000_000, modelId: 'gpt-4o', costByCategory: { input: 0.05 } }),
      makeEvent({ ts: 2_000_000, modelId: 'claude-sonnet-4', costByCategory: { input: 0.03 } }),
    ];
    const result = buildCategoryBreakdownData(events, { models: ['gpt-4o'] });
    assert.equal(result.available, true);
    assert.ok(result.categories.length > 0);
  });

  it('returns unavailable when all events are filtered out', () => {
    const events = [makeEvent({ ts: 1_000_000, modelId: 'gpt-4o', costByCategory: { input: 0.05 } })];
    const result = buildCategoryBreakdownData(events, { models: ['claude-sonnet-4'] });
    assert.equal(result.available, false);
  });
});

describe('buildChartData', () => {
  it('applies display prefs to window sizes and topN', () => {
    const now = startOf(Date.now(), 'day');
    const events = [makeEvent({ ts: now - DAY_MS, credits: 5, cost: 0.20 })];
    const dayAggs = aggregateBy(events, 'day');
    const category = buildCategoryBreakdownData(events);
    const hourly = buildHourlyTimelineData(events);

    const result = buildChartData(
      dayAggs, [], EMPTY_BUDGET, INSUF_FORECAST, now,
      category, hourly, 0.04, undefined, undefined,
      { dailyBarsWindow: 14, topN: 3, heatmapWeeks: 6 },
    );

    assert.strictEqual(result.dailyBars.points.length, 14);
    // heatmap loop: for (i = weeks*7; i >= 0; i--) → inclusive → weeks*7+1 cells
    assert.strictEqual(result.heatmap.cells.length, 6 * 7 + 1);
    assert.ok(result.modelBreakdown.labels.length === 0); // no models in input
  });
});

/** Run `fn` with the process time zone set to `tz`, restoring it afterwards. */
function withTimezone<T>(tz: string, fn: () => T): T {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

/** The MM-DD label of each of the last `count` calendar days ending on `now`'s local date, oldest first. */
function expectedDayLabels(now: number, count: number): string[] {
  const t = new Date(now);
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - (count - 1 - i));
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

describe('chartData — daily budget / projected lines', () => {
  // February 2026 has 28 days.
  const feb = new Date(2026, 1, 15, 12).getTime();

  it('REGRESSION: the budget line is includedCredits / days-in-month, not / window', () => {
    const budget: BudgetState = { ...EMPTY_BUDGET, includedCredits: 280 };
    for (const window of [7, 14, 30]) {
      const data = buildDailyBarsData([], budget, INSUF_FORECAST, feb, window);
      assert.strictEqual(data.budgetLine, 10, `window ${window}`);
    }
  });

  it('REGRESSION: the projected line is projectedCredits / days-in-month, not / window', () => {
    const forecast: Forecast = { ...INSUF_FORECAST, basis: 'linear', projectedCredits: 560 };
    for (const window of [7, 30]) {
      assert.strictEqual(buildDailyBarsData([], EMPTY_BUDGET, forecast, feb, window).projectedLine, 20);
    }
    const march = new Date(2026, 2, 10, 12).getTime(); // 31 days
    assert.strictEqual(buildDailyBarsData([], EMPTY_BUDGET, { ...forecast, projectedCredits: 310 }, march).projectedLine, 10);
  });

  it('colour thresholds follow the per-day share of the month', () => {
    const aggs = aggregateBy(
      [makeEvent({ ts: new Date(2026, 1, 14, 12).getTime(), credits: 9 }), makeEvent({ ts: new Date(2026, 1, 13, 12).getTime(), credits: 4 })],
      'day',
    );
    const data = buildDailyBarsData(aggs, { ...EMPTY_BUDGET, includedCredits: 280 }, INSUF_FORECAST, feb, 7);
    assert.strictEqual(data.points.find((p) => p.credits === 9)!.colorIndex, 1, '9 of 10 → amber');
    assert.strictEqual(data.points.find((p) => p.credits === 4)!.colorIndex, 0, '4 of 10 → blue');
  });
});

describe('chartData — window / weeks / topN clamping', () => {
  const now = new Date(2026, 5, 15, 12).getTime();
  const budget: BudgetState = { ...EMPTY_BUDGET, includedCredits: 300 };

  it('REGRESSION: a window of 0 no longer yields an Infinity budget line or zero points', () => {
    for (const window of [0, -5, NaN]) {
      const data = buildDailyBarsData([], budget, INSUF_FORECAST, now, window);
      assert.ok(data.points.length >= 1, `window ${window}`);
      assert.ok(Number.isFinite(data.budgetLine ?? 0), `window ${window} budgetLine`);
    }
    assert.strictEqual(buildDailyBarsData([], budget, INSUF_FORECAST, now, 0).points.length, 1);
    assert.strictEqual(buildDailyBarsData([], budget, INSUF_FORECAST, now, NaN).points.length, 30, 'NaN → default');
  });

  it('REGRESSION: an absurd window is capped at 366 days instead of looping for ages', () => {
    assert.strictEqual(buildDailyBarsData([], budget, INSUF_FORECAST, now, 100_000).points.length, 366);
    assert.strictEqual(buildDailyBarsData([], budget, INSUF_FORECAST, now, Infinity).points.length, 366);
    assert.strictEqual(buildTokensDailyData([], now, 100_000).dates.length, 366);
    assert.strictEqual(buildCategoryTrendData([], now, 100_000).dates.length, 366);
    assert.strictEqual(buildTokensDailyData([], now, -3).dates.length, 1);
  });

  it('REGRESSION: heatmap weeks are clamped to [1, 104]', () => {
    assert.strictEqual(buildHeatmapData([], now, 0).cells.length, 7 + 1);
    assert.strictEqual(buildHeatmapData([], now, -4).cells.length, 7 + 1);
    assert.strictEqual(buildHeatmapData([], now, 100_000).cells.length, 104 * 7 + 1);
    assert.strictEqual(buildHeatmapData([], now, NaN).cells.length, 52 * 7 + 1);
  });

  it('REGRESSION: topN is clamped to [1, 50]', () => {
    const tops: TopEntry[] = Array.from({ length: 80 }, (_, i) => ({ key: `m${i}`, credits: i, cost: i, tokens: i }));
    assert.strictEqual(buildModelBreakdownData(tops, 0.04, undefined, 0).labels.length, 1);
    assert.strictEqual(buildModelBreakdownData(tops, 0.04, undefined, -3).labels.length, 1);
    assert.strictEqual(buildModelBreakdownData(tops, 0.04, undefined, 1_000_000).labels.length, 50);
    assert.strictEqual(buildModelBreakdownData(tops, 0.04, undefined, NaN).labels.length, 8);
  });
});

describe('chartData — calendar-day stepping across DST', () => {
  // [zone, local instants straddling that zone's spring-forward and fall-back changes]
  const CASES: Array<[string, Array<[number, number, number, number, number]>]> = [
    ['America/New_York', [
      [2026, 2, 8, 0, 30], [2026, 2, 9, 0, 30], [2026, 2, 9, 23, 30], [2026, 2, 10, 0, 30], [2026, 2, 12, 12, 0],
      [2026, 10, 1, 0, 30], [2026, 10, 2, 0, 30], [2026, 10, 2, 23, 30], [2026, 10, 3, 0, 30],
    ]],
    ['Europe/Berlin', [
      [2026, 2, 29, 0, 30], [2026, 2, 30, 0, 30], [2026, 2, 30, 23, 30],
      [2026, 9, 25, 0, 30], [2026, 9, 26, 0, 30], [2026, 9, 26, 23, 30],
    ]],
    ['Australia/Sydney', [
      [2026, 3, 5, 0, 30], [2026, 3, 6, 0, 30], [2026, 9, 4, 0, 30], [2026, 9, 5, 0, 30], [2026, 9, 5, 23, 30],
    ]],
  ];

  for (const [zone, instants] of CASES) {
    it(`REGRESSION (${zone}): every chart lists consecutive distinct calendar days and keys data to the right day`, () => {
      withTimezone(zone, () => {
        for (const [y, m, d, h, min] of instants) {
          const now = new Date(y, m, d, h, min).getTime();
          for (const window of [3, 10, 45]) {
            const want = expectedDayLabels(now, window);
            const ctxMsg = `${zone} ${y}-${m + 1}-${d} ${h}:${min} window ${window}`;
            assert.deepStrictEqual(buildTokensDailyData([], now, window).dates, want, `tokens ${ctxMsg}`);
            assert.deepStrictEqual(buildCategoryTrendData([], now, window).dates, want, `trend ${ctxMsg}`);
            assert.deepStrictEqual(
              buildDailyBarsData([], EMPTY_BUDGET, INSUF_FORECAST, now, window).points.map((p) => p.date),
              want,
              `bars ${ctxMsg}`,
            );
          }

          // Credits recorded at local noon on each of the last 5 days land on exactly that day's bar.
          const events = Array.from({ length: 5 }, (_, i) =>
            makeEvent({ ts: new Date(y, m, d - i, 12).getTime(), credits: i + 1 }),
          );
          const bars = buildDailyBarsData(aggregateBy(events, 'day'), EMPTY_BUDGET, INSUF_FORECAST, now, 5);
          assert.deepStrictEqual(
            bars.points.map((p) => p.credits),
            [5, 4, 3, 2, 1],
            `credits per day ${zone} ${y}-${m + 1}-${d} ${h}:${min}`,
          );
        }
      });
    });
  }

  it('REGRESSION (America/New_York): heatmap cells are consecutive local dates across both changes', () => {
    withTimezone('America/New_York', () => {
      for (const now of [new Date(2026, 2, 9, 0, 30).getTime(), new Date(2026, 10, 2, 0, 30).getTime()]) {
        const cells = buildHeatmapData([], now, 52).cells.map((c) => c.date);
        assert.strictEqual(cells.length, 52 * 7 + 1);
        assert.strictEqual(new Set(cells).size, cells.length, 'no repeated day');
        for (let i = 1; i < cells.length; i++) {
          const prev = new Date(`${cells[i - 1]}T12:00:00Z`).getTime();
          assert.strictEqual(new Date(`${cells[i]}T12:00:00Z`).getTime() - prev, DAY_MS, `gap before ${cells[i]}`);
        }
      }
    });
  });
});

describe('chartData — per-event local hour and weekday', () => {
  it('REGRESSION: hourly buckets use each event\'s own UTC offset (summer vs winter), not today\'s', () => {
    withTimezone('America/New_York', () => {
      const events = [
        makeEvent({ ts: new Date(2026, 6, 15, 9, 15).getTime(), credits: 2 }), // EDT
        makeEvent({ ts: new Date(2026, 0, 15, 9, 45).getTime(), credits: 3 }), // EST
      ];
      const data = buildHourlyTimelineData(events);
      assert.strictEqual(data.hours[9], 5);
      assert.strictEqual(data.peakHour, 9);
    });
  });

  it('REGRESSION: hourly buckets handle timestamps before 1970 (negative modulo)', () => {
    withTimezone('UTC', () => {
      const data = buildHourlyTimelineData([makeEvent({ ts: Date.UTC(1969, 11, 31, 10, 30), credits: 4 })]);
      assert.strictEqual(data.hours[10], 4);
      assert.strictEqual(data.hours.reduce((a, b) => a + b, 0), 4);
    });
  });

  it('REGRESSION: weekday totals use each event\'s own local date and handle pre-1970 timestamps', () => {
    withTimezone('America/New_York', () => {
      // Monday 00:30 EDT is Sunday 23:30 under the winter (-5) offset that is in force today.
      const totals = buildWeekdayTotals([
        makeEvent({ ts: new Date(2026, 6, 13, 0, 30).getTime(), credits: 2 }), // Mon 2026-07-13 EDT
        makeEvent({ ts: new Date(2026, 0, 11, 23, 30).getTime(), credits: 3 }), // Sun 2026-01-11 EST
      ]);
      assert.strictEqual(totals[1], 2, 'Monday');
      assert.strictEqual(totals[0], 3, 'Sunday');
    });
    withTimezone('UTC', () => {
      // 1969-12-31 was a Wednesday.
      const totals = buildWeekdayTotals([makeEvent({ ts: Date.UTC(1969, 11, 31, 12), credits: 1 })]);
      assert.strictEqual(totals[3], 1);
      assert.strictEqual(totals.reduce((a, b) => a + b, 0), 1);
    });
  });
});

describe('buildWeekdayData', () => {
  it('REGRESSION: peakWeekday is null for an all-zero week (like peakHour), not Sunday', () => {
    assert.strictEqual(buildWeekdayData([]).peakWeekday, null);
    assert.strictEqual(buildWeekdayData([0, 0, 0, 0, 0, 0, 0]).peakWeekday, null);
  });

  it('reports the busiest weekday (Sun=0) and keeps the numeric `peak`', () => {
    const data = buildWeekdayData([1, 2, 9, 3, 0, 0, 4]);
    assert.strictEqual(data.peakWeekday, 2);
    assert.strictEqual(data.peak, 2);
    assert.deepStrictEqual(data.totals, [1, 2, 9, 3, 0, 0, 4]);
    assert.strictEqual(buildWeekdayData([]).peak, 0);
  });
});

import { strict as assert } from 'assert';
import { buildFlatContext, creditsPerHour, metricValue } from '../../src/extension-backend/domain/alertMetrics';
import type { FlatContext } from '../../src/extension-backend/domain/alertMetrics';
import { FIXED_FLAT_METRICS } from '../../src/extension-backend/domain/flatAlerts';
import { MODEL_ID, ctxOf, ruleSnapshot } from './flatAlertsFixture';

const H = 3_600_000;
const mv = (metric: string, ctx: FlatContext): number | undefined => metricValue(metric, ctx);

describe('metricValue', () => {
  const ctx = ctxOf(
    ruleSnapshot({
      topModels: [
        { key: MODEL_ID, credits: 90, cost: 36, tokens: 1 },
        { key: 'gpt-4.1', credits: 60, cost: 24, tokens: 1 },
      ],
    }),
    [
      { ts: 0, todayCredits: 0 },
      { ts: H, todayCredits: 60 },
    ],
  );

  it('reads every fixed metric from the snapshot', () => {
    const expected: Record<string, number> = {
      'today.credits': 12,
      'today.cost': 0.48,
      'month.credits': 150,
      'month.cost': 60,
      'budget.percentOfBudget': 0.6,
      'budget.percentOfIncluded': 0.5,
      'forecast.projectedCredits': 240,
      'forecast.projectedCost': 96,
      'velocity.creditsPerHour': 60,
      'window7d.credits': 0,
      currentBranchCredits: 33,
    };
    for (const m of FIXED_FLAT_METRICS) assert.equal(mv(m, ctx), expected[m], m);
  });

  it('reads keyed metrics, ids with dots included, and 0 for a known but idle model or repo', () => {
    assert.equal(mv(`model:${MODEL_ID}.credits`, ctx), 90);
    assert.equal(mv('model:gpt-4.1.cost', ctx), 24);
    assert.equal(mv('repo:foo.js.credits', ctx), 50);
    assert.equal(mv('repo:alpha.cost', ctx), 40);
    assert.equal(mv('model:idle-model.credits', ctx), 0);
    assert.equal(mv('repo:idle-repo.cost', ctx), 0);
  });

  it('is undefined for an unknown model or repo, and never reads inherited names', () => {
    assert.equal(mv('model:nope.credits', ctx), undefined);
    assert.equal(mv('repo:nope.cost', ctx), undefined);
    assert.equal(mv('model:constructor.credits', ctx), undefined);
    assert.equal(mv('model:__proto__.credits', ctx), undefined);
    assert.equal(mv('repo:toString.cost', ctx), undefined);
  });

  it('a model named __proto__ is plain data', () => {
    const odd = ctxOf(ruleSnapshot({ topModels: [{ key: '__proto__', credits: 7, cost: 1, tokens: 1 }] }));
    assert.equal(mv('model:__proto__.credits', odd), 7);
    assert.equal(({} as Record<string, unknown>)['credits'], undefined, 'nothing leaked onto Object.prototype');
  });

  it('is undefined for every metric without a snapshot (the zeros of an empty context must not match)', () => {
    const none = ctxOf(null);
    assert.equal(none.values.size, 0);
    for (const m of FIXED_FLAT_METRICS) assert.equal(mv(m, none), undefined, m);
    assert.equal(mv('model:x.credits', none), undefined);
  });

  it('month.* is the budget usage, and the context is built from the snapshot alone', () => {
    const c = buildFlatContext({ snapshot: ruleSnapshot({ budget: { ...ruleSnapshot().budget, usedCredits: 7, usedCost: 3 } }), now: 1 });
    assert.equal(mv('month.credits', c), 7);
    assert.equal(mv('month.cost', c), 3);
  });
});

describe('window7d.credits', () => {
  const now = new Date(2026, 0, 15, 12, 0).getTime();
  const day = (d: number, credits: number) => ({ start: new Date(2026, 0, d).getTime(), credits, cost: 0, tokens: 0 });

  it('is unavailable without day-level data', () => {
    assert.equal(mv('window7d.credits', ctxOf(ruleSnapshot({ chartInputs: undefined }))), undefined);
  });

  it('sums the last 7 calendar days (today and the 6 before it) of the day aggregates', () => {
    const c = ctxOf(ruleSnapshot({ chartInputs: { dayAggregates: [day(8, 1), day(9, 2), day(15, 4), day(16, 99)] } }), undefined, now);
    // 9th..15th inclusive: the 8th is outside the week, the 16th is in the future.
    assert.equal(mv('window7d.credits', c), 6);
  });

  it('is not a copy of today', () => {
    const c = ctxOf(ruleSnapshot({ chartInputs: { dayAggregates: [day(12, 40), day(15, 3)] } }), undefined, now);
    assert.equal(mv('window7d.credits', c), 43);
    assert.equal(mv('today.credits', c), 12);
  });
});

describe('creditsPerHour (the least-squares spend rate)', () => {
  const sample = (minutes: number, todayCredits: number) => ({ ts: minutes * 60_000, todayCredits });

  it('is 0 without a history, or with fewer than two samples', () => {
    assert.equal(creditsPerHour(undefined), 0);
    assert.equal(creditsPerHour([]), 0);
    assert.equal(creditsPerHour([sample(0, 10)]), 0);
  });

  it('a steady stream recovers its exact rate', () => {
    assert.equal(creditsPerHour([sample(0, 0), sample(30, 30), sample(60, 60)]), 60);
    assert.equal(creditsPerHour([sample(0, 0), sample(60, 60)]), 60);
    assert.equal(creditsPerHour([sample(0, 0), sample(60, 30), sample(120, 80)]), 40);
  });

  it('fits a line through every sample instead of using only the two endpoints', () => {
    const history = [sample(0, 0), sample(10, 50), sample(20, 52), sample(30, 54), sample(60, 60)];
    const rate = creditsPerHour(history);
    const endpoints = 60; // first to last
    assert.notEqual(rate, endpoints);
    assert.ok(rate > 0 && rate < 120);
  });

  it('a counter reset (midnight, recompute) restarts the window instead of zeroing the rate', () => {
    // 100 credits, then the counter falls to 5: only the samples after the drop count.
    assert.equal(creditsPerHour([sample(0, 100), sample(10, 5), sample(40, 35), sample(70, 65)]), 60);
  });

  it('is 0 right after a reset (a single post-reset sample is not a rate)', () => {
    assert.equal(creditsPerHour([sample(0, 100), sample(10, 5)]), 0);
  });

  it('flat history is a rate of 0 over a real window, and identical timestamps give no rate', () => {
    assert.equal(creditsPerHour([sample(0, 10), sample(30, 10), sample(60, 10)]), 0);
    assert.equal(creditsPerHour([sample(5, 10), sample(5, 20)]), 0);
  });
});

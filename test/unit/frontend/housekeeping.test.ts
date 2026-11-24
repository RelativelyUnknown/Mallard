import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { UsageSnapshot } from '../../../src/extension-backend/domain/types';
import { describeCharts } from '../../../src/extension-frontend/srDescriptions';
import { formatMoney } from '../../../src/extension-backend/domain/format';
import { lazyChart } from '../../../src/extension-frontend/lazyMount';
import { CHART_REGISTRY } from '../../../src/extension-frontend/charts/registry';

function richSnapshot(): UsageSnapshot {
  const now = Date.now();
  const s = buildSnapshot(
    [
      makeEvent({ ts: now - 1000, modelId: 'gpt-4o', credits: 50, cost: 2, surface: 'chat', promptTokens: 900, completionTokens: 300, repo: 'acme/app', costByCategory: { input: 0.5, output: 0.8 } }),
      makeEvent({ ts: now - 2000, modelId: 'claude-sonnet-4-5', credits: 30, cost: 1.2, surface: 'inline', promptTokens: 400, completionTokens: 100, repo: 'acme/lib', costByCategory: { input: 0.4, output: 0.6 } }),
    ],
    {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    },
  );
  s.byLanguage = [{ key: 'typescript', credits: 9, cost: 0.36, tokens: 900 }, { key: 'unknown', credits: 1, cost: 0.04, tokens: 10 }];
  s.githubBilling = {
    quota: null, fetchedAt: now, totalNetAmount: 7,
    items: [
      { model: 'gpt-4o', sku: 'copilot', grossAmount: 5, netAmount: 4, grossQuantity: 10 },
      { model: 'claude-sonnet-4-5', sku: 'copilot', grossAmount: 4, netAmount: 3, grossQuantity: 8 },
    ],
  };
  s.chartData.categoryTrend = {
    dates: ['01-01', '01-02'],
    series: [{ category: 'input', costs: [0.1, 0.2] }, { category: 'output', costs: [0.3, 0] }],
    available: true,
  };
  return s;
}

describe('screen-reader chart descriptions', () => {
  it('cover every registered chart body (13), so no aria-describedby target is left empty', () => {
    const described = Object.keys(describeCharts(richSnapshot())).sort();
    assert.deepEqual(described, CHART_REGISTRY.map((d) => d.bodyId).sort());
    assert.equal(described.length, 13);
  });

  it('are short, non-empty sentences with the headline numbers for a populated snapshot', () => {
    const d = describeCharts(richSnapshot());
    for (const [id, text] of Object.entries(d)) {
      assert.ok(text.length > 10 && text.length < 220, `${id}: ${text}`);
      assert.ok(!/No data|unavailable|No usage/i.test(text), `${id} should have data: ${text}`);
    }
    assert.match(d['chart-models']!, /Top model: gpt-4o/);
    assert.match(d['chart-repos']!, /acme\/app/);
    assert.match(d['chart-languages']!, /typescript/);
    assert.match(d['chart-billing']!, /gpt-4o/);
    assert.match(d['chart-category-trend']!, /input, output/);
    assert.match(d['chart-tokens']!, /tokens on /);
    assert.match(d['chart-sankey']!, / to /);
    assert.match(d['chart-cumulative']!, /Cumulative spend over \d+ days/);
    assert.match(d['chart-weekday']!, /Busiest day: (Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day/);
  });

  it('say so plainly when a chart has nothing to show', () => {
    const empty = richSnapshot();
    empty.sankeyLinks = [];
    empty.byRepo = [];
    empty.byLanguage = [{ key: 'unknown', credits: 1, cost: 0.04, tokens: 10 }];
    delete empty.githubBilling;
    empty.chartData.categoryTrend = { dates: [], series: [], available: false };
    empty.chartData.tokensDaily = { dates: [], tokens: [], events: [] };
    empty.chartData.weekdayBreakdown = { totals: [0, 0, 0, 0, 0, 0, 0], peak: 0 };
    empty.chartData.dailyBars = { ...empty.chartData.dailyBars, points: [], cumulativeCosts: [] };
    const d = describeCharts(empty);
    for (const id of ['chart-sankey', 'chart-repos', 'chart-languages', 'chart-billing', 'chart-category-trend', 'chart-tokens', 'chart-weekday', 'chart-cumulative', 'chart-daily']) {
      assert.match(d[id]!, /No data/, id);
    }
  });
});

describe('screen-reader chart descriptions — empty and ragged inputs', () => {
  it('say so plainly for the remaining empty states (heatmap, models, categories, hours)', () => {
    const empty = richSnapshot();
    empty.chartData.heatmap = { ...empty.chartData.heatmap, max: 0 };
    empty.chartData.modelBreakdown = { ...empty.chartData.modelBreakdown, labels: [], credits: [], costs: [], tokens: [], cheapestEquivalentCosts: [] };
    empty.chartData.categoryBreakdown = { ...empty.chartData.categoryBreakdown, available: false };
    empty.chartData.hourlyTimeline = { hours: new Array(24).fill(0) as number[], peakHour: null };
    const d = describeCharts(empty);
    assert.equal(d['chart-heatmap'], 'Activity heatmap. No usage data.');
    assert.equal(d['chart-models'], 'Model breakdown. No data.');
    assert.equal(d['chart-category'], 'Cost category breakdown unavailable.');
    assert.equal(d['chart-hourly'], 'Usage by hour. No data.');
  });

  it('names the busiest hour when there is hourly activity', () => {
    const snap = richSnapshot();
    const hours = new Array(24).fill(0) as number[];
    hours[14] = 5;
    snap.chartData.hourlyTimeline = { hours, peakHour: 14 };
    assert.equal(describeCharts(snap)['chart-hourly'], 'Usage by hour. Peak hour: 14:00.');
  });

  it('still produces a sentence when a parallel series is shorter than its labels (a missing value reads as 0 / unknown day)', () => {
    const snap = richSnapshot();
    snap.chartData.modelBreakdown = { ...snap.chartData.modelBreakdown, labels: ['gpt-4o'], credits: [] };
    snap.chartData.categoryBreakdown = { categories: ['input', 'output'], costs: [0.5], available: true };
    snap.chartData.tokensDaily = { dates: [], tokens: [0, 7], events: [] };
    const d = describeCharts(snap);
    assert.match(d['chart-models']!, /Top model: gpt-4o with 0 cr\./);
    assert.equal(d['chart-category'], `Cost by category: input ${formatMoney(0.5, 'USD')}, output ${formatMoney(0, 'USD')}.`);
    assert.match(d['chart-tokens']!, /Peak: 7 tokens on an unknown day\./);
  });

  it('treats a zero-valued top repository, language and billing item as "No data", and names a billing item by its fallbacks', () => {
    const snap = richSnapshot();
    snap.byRepo = [{ key: 'acme/zero', credits: 0, cost: 0, tokens: 0 }];
    snap.byLanguage = [{ key: 'rust', credits: 0, cost: 0, tokens: 0 }];
    snap.githubBilling = {
      quota: null, fetchedAt: 1, totalNetAmount: 0,
      items: [{ model: '', sku: 'copilot', grossAmount: 0, netAmount: 0, grossQuantity: 1 }],
    };
    const zero = describeCharts(snap);
    assert.equal(zero['chart-repos'], 'Spend by repository. No data.');
    assert.equal(zero['chart-languages'], 'Spend by detected language. No data.');
    assert.equal(zero['chart-billing'], 'GitHub billing line items. No data.');

    // Cost-only repo/language and gross-only billing still count as data.
    snap.byRepo = [{ key: 'acme/costly', credits: 0, cost: 3, tokens: 0 }];
    snap.byLanguage = [{ key: 'rust', credits: 0, cost: 2, tokens: 0 }];
    snap.githubBilling = {
      quota: null, fetchedAt: 1, totalNetAmount: 0,
      items: [{ model: '', sku: '', grossAmount: 2, netAmount: 0, grossQuantity: 1 }],
    };
    const d = describeCharts(snap);
    assert.match(d['chart-repos']!, /Top repository: acme\/costly/);
    assert.match(d['chart-languages']!, /Top language: rust/);
    assert.match(d['chart-billing']!, /Largest: unknown at /);
  });
});

describe('lazyChart', () => {
  interface FakeObserver { callback: (entries: Array<{ isIntersecting: boolean }>) => void; disconnected: boolean }
  const globals = globalThis as unknown as { IntersectionObserver?: unknown };
  const original = globals.IntersectionObserver;
  let observers: FakeObserver[] = [];
  const originalError = console.error;
  let logged: unknown[][] = [];

  beforeEach(() => {
    observers = [];
    logged = [];
    globals.IntersectionObserver = class {
      private readonly rec: FakeObserver;
      constructor(callback: FakeObserver['callback']) {
        this.rec = { callback, disconnected: false };
        observers.push(this.rec);
      }
      observe(): void {}
      disconnect(): void { this.rec.disconnected = true; }
    };
    console.error = (...args: unknown[]) => { logged.push(args); };
  });
  afterEach(() => {
    globals.IntersectionObserver = original;
    console.error = originalError;
  });

  interface Handle { resize(): void; reinit(): void; renders: number }
  const visible = [{ isIntersecting: true }];

  it('mounts on first intersection, replays the stashed render, then stops observing', () => {
    let mounted = 0;
    const lazy = lazyChart<Handle>(document.createElement('div'), () => {
      mounted++;
      return { resize() {}, reinit() {}, renders: 0 };
    });
    let rendered = 0;
    lazy.render((h) => { h.renders++; rendered++; });
    assert.equal(mounted, 0, 'nothing mounted while off screen');

    observers[0]!.callback([{ isIntersecting: false }]);
    assert.equal(mounted, 0);
    observers[0]!.callback(visible);
    assert.equal(mounted, 1);
    assert.equal(rendered, 1);
    assert.equal(observers[0]!.disconnected, true);
  });

  it('logs a factory failure, stays observed, and mounts on the next intersection', () => {
    let attempts = 0;
    const lazy = lazyChart<Handle>(document.createElement('div'), () => {
      attempts++;
      if (attempts === 1) throw new Error('canvas unavailable');
      return { resize() {}, reinit() {}, renders: 0 };
    });
    let rendered = 0;
    lazy.render(() => { rendered++; });

    assert.doesNotThrow(() => observers[0]!.callback(visible), 'a failing chart must not throw out of the observer');
    assert.equal(attempts, 1);
    assert.equal(logged.length, 1);
    assert.match(String(logged[0]![0]), /failed to mount/);
    assert.equal(observers[0]!.disconnected, false, 'still observing so it can retry');
    assert.equal(rendered, 0);

    observers[0]!.callback(visible);
    assert.equal(attempts, 2);
    assert.equal(rendered, 1, 'the stashed render ran once the retry succeeded');
    assert.equal(observers[0]!.disconnected, true);
  });

  it('rerenderForTheme is a no-op before mount and reinit + replay afterwards', () => {
    let reinits = 0;
    const lazy = lazyChart<Handle>(document.createElement('div'), () => ({
      resize() {}, reinit() { reinits++; }, renders: 0,
    }));
    let rendered = 0;
    lazy.render(() => { rendered++; });
    lazy.rerenderForTheme();
    assert.equal(reinits, 0);
    assert.equal(rendered, 0);

    observers[0]!.callback(visible);
    assert.equal(rendered, 1);
    lazy.rerenderForTheme();
    assert.equal(reinits, 1);
    assert.equal(rendered, 2);
  });

  it('resize is a no-op while off screen and reaches the mounted chart afterwards', () => {
    let resizes = 0;
    const lazy = lazyChart<Handle>(document.createElement('div'), () => ({
      resize() { resizes++; }, reinit() {}, renders: 0,
    }));
    lazy.resize();
    assert.equal(resizes, 0, 'nothing to resize before the chart exists');

    observers[0]!.callback(visible);
    lazy.resize();
    assert.equal(resizes, 1);
  });

  it('render() on an already-mounted chart applies immediately, and the latest closure is what a theme change replays', () => {
    const lazy = lazyChart<Handle>(document.createElement('div'), () => ({
      resize() {}, reinit() {}, renders: 0,
    }));
    observers[0]!.callback(visible);
    const calls: string[] = [];
    lazy.render(() => { calls.push('first'); });
    lazy.render(() => { calls.push('second'); });
    assert.deepEqual(calls, ['first', 'second'], 'each render applies right away');

    lazy.rerenderForTheme();
    assert.deepEqual(calls, ['first', 'second', 'second'], 'only the most recent closure is replayed');
  });

  it('mounts and reinitialises cleanly when no render closure was ever supplied', () => {
    let mounted = 0;
    let reinits = 0;
    const lazy = lazyChart<Handle>(document.createElement('div'), () => {
      mounted++;
      return { resize() {}, reinit() { reinits++; }, renders: 0 };
    });
    observers[0]!.callback(visible);
    assert.equal(mounted, 1);
    assert.doesNotThrow(() => lazy.rerenderForTheme());
    assert.equal(reinits, 1, 'the chart is still recreated for the new theme');
  });
});

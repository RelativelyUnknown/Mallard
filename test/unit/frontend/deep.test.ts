import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { UsageSnapshot, Metric } from '../../../src/extension-backend/domain/types';
import { mountDailyBars } from '../../../src/extension-frontend/charts/dailyBars';
import { mountModelBreakdown } from '../../../src/extension-frontend/charts/modelBreakdown';
import { mountCategoryBreakdown } from '../../../src/extension-frontend/charts/categoryBreakdown';
import { mountSankey } from '../../../src/extension-frontend/charts/sankey';
import { mountHeatmap } from '../../../src/extension-frontend/charts/heatmap';
import { mountHourlyTimeline } from '../../../src/extension-frontend/charts/hourlyTimeline';
import { mountCumulativeArea } from '../../../src/extension-frontend/charts/cumulativeArea';
import { mountWeekdayRadial } from '../../../src/extension-frontend/charts/weekdayRadial';
import { mountKpiCards } from '../../../src/extension-frontend/components/KpiCards';
import { mountFilterBar } from '../../../src/extension-frontend/components/FilterBar';
import { mountStatusBanner } from '../../../src/extension-frontend/components/StatusBanner';
import { mountCurrencySelector } from '../../../src/extension-frontend/components/CurrencySelector';
import { mountRestrictionBanner } from '../../../src/extension-frontend/components/RestrictionBanner';
import { resetFilterSync } from '../../../src/extension-frontend/filterSync';
import { setState, state } from '../../../src/extension-frontend/store';
import { lastOption, seriesValues, StubDatum } from './stubChart';

function richSnapshot(): UsageSnapshot {
  const now = Date.now();
  return buildSnapshot(
    [
      makeEvent({
        ts: now - 1000, modelId: 'gpt-4o', credits: 50, cost: 2.0, surface: 'chat',
        promptTokens: 1000, completionTokens: 500, repo: 'acme/app',
        costByCategory: { input: 0.5, output: 0.8, cache_read: 0.2, thinking: 0.5 },
      }),
      makeEvent({
        ts: now - 2000, modelId: 'claude-sonnet-4-5', credits: 30, cost: 1.2, surface: 'inline',
        promptTokens: 800, completionTokens: 400, repo: 'acme/lib',
        costByCategory: { input: 0.4, output: 0.6, tool: 0.2 },
      }),
      makeEvent({
        ts: now - 3000, modelId: 'gpt-4o', credits: 20, cost: 0.8, surface: 'agent',
        promptTokens: 500, completionTokens: 200, repo: 'acme/app',
        costByCategory: { input: 0.3, output: 0.4, thinking: 0.1 },
      }),
    ],
    {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    },
  );
}

const METRICS: Metric[] = ['cost', 'credits', 'tokens'];

function postedSetFilters(): Array<{ type: string; value: Record<string, unknown> }> {
  const all = (globalThis as unknown as { __postedMessages: Array<{ type: string; value: Record<string, unknown> }> }).__postedMessages;
  return all.filter((m) => m.type === 'setFilter');
}

function resetFilterState(): void {
  resetFilterSync();
  setState({ filter: {}, datePreset: 'month', metric: 'cost' });
  (globalThis as unknown as { __postedMessages: unknown[] }).__postedMessages = [];
}

describe('charts — buildOption with rich data + all metrics', () => {
  const snapshot = richSnapshot();

  for (const metric of METRICS) {
    it(`modelBreakdown plots the ${metric} values, reversed so the top model is drawn first on screen`, () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const h = mountModelBreakdown(el);
      h.update(snapshot, metric);
      const opt = lastOption(h);

      const mb = snapshot.chartData.modelBreakdown;
      const expected = metric === 'cost' ? mb.costs : metric === 'tokens' ? mb.tokens : mb.credits;
      assert.ok(expected.length >= 2, 'fixture has several models');
      assert.deepEqual(opt.yAxis!.data, [...mb.labels].reverse());
      assert.deepEqual(seriesValues(opt.series![0]!), [...expected].reverse());
      // The "cheapest equivalent" ghost bar only makes sense for money.
      assert.equal(opt.series!.length, metric === 'cost' ? 2 : 1);
      el.remove();
    });

    it(`KpiCards renders values for metric=${metric}`, () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const h = mountKpiCards(el);
      h.update(snapshot, metric);
      assert.ok(el.querySelector('.wv-kpi-grid'));
      const today = el.querySelector('#kpi-today-val')!.textContent!;
      const model = el.querySelector('#kpi-model-sub')!.textContent!;
      if (metric === 'cost') {
        assert.match(today, /\$/);
        assert.match(model, /\$/);
      } else if (metric === 'credits') {
        assert.match(today, /cr$/);
        assert.match(model, /cr$/);
      } else {
        assert.match(today, /tok$/);
        assert.match(model, /tok$/);
      }
      el.remove();
    });

    describe(`FilterBar for metric=${metric}`, () => {
      beforeEach(resetFilterState);
      afterEach(resetFilterState);

      it('marks exactly that metric button as pressed and offers the snapshot\'s models', () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        const h = mountFilterBar(el);
        h.update(snapshot, metric);
        const pressed = [...el.querySelectorAll<HTMLElement>('[data-metric]')]
          .filter((b) => b.getAttribute('aria-pressed') === 'true')
          .map((b) => b.dataset.metric);
        assert.deepEqual(pressed, [metric]);
        const models = [...el.querySelectorAll<HTMLElement>('#model-dropdown [role="option"]')]
          .map((o) => o.dataset.model)
          .filter((m) => m !== '__all__');
        assert.deepEqual(models, snapshot.allModels);
        el.remove();
      });
    });
  }

  it('categoryBreakdown plots one pie slice per cost category with its cost', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountCategoryBreakdown(el);
    h.update(snapshot);
    const series = lastOption(h).series![0]!;
    assert.equal(series.type, 'pie');
    const cb = snapshot.chartData.categoryBreakdown;
    assert.ok(cb.available && cb.categories.length > 1);
    const slices = series.data as Array<{ name: string; value: number }>;
    assert.equal(slices.length, cb.categories.length);
    assert.deepEqual(slices.map((s) => s.value), cb.costs);
    el.remove();
  });

  it('sankey draws one node per distinct model/surface and one link per flow, with 2+ models and surfaces', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountSankey(el);
    h.update(snapshot);
    const series = lastOption(h).series![0]!;
    assert.equal(series.type, 'sankey');
    assert.ok(snapshot.allModels.length >= 2 && snapshot.allSurfaces.length >= 2);
    assert.equal(series.links!.length, snapshot.sankeyLinks.length);
    const names = (series.data as Array<{ name: string }>).map((n) => n.name);
    assert.equal(new Set(names).size, names.length, 'nodes are unique');
    for (const l of snapshot.sankeyLinks) {
      assert.ok(names.includes(l.source) && names.includes(l.target));
    }
    el.remove();
  });

  it('dailyBars handles incremental update (isIncremental=true): only the bar data and tooltip are refreshed', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountDailyBars(el);
    h.update(snapshot);
    assert.ok(lastOption(h).xAxis, 'first update is a full render');

    const points = snapshot.chartData.dailyBars.points.map((p, i, all) =>
      i === all.length - 1 ? { ...p, credits: p.credits + 40 } : p);
    const incremental: UsageSnapshot = {
      ...snapshot,
      isIncremental: true,
      chartData: { ...snapshot.chartData, dailyBars: { ...snapshot.chartData.dailyBars, points } },
    };
    h.update(incremental);

    const opt = lastOption(h);
    assert.equal(opt.xAxis, undefined, 'no axis rebuild');
    assert.deepEqual(seriesValues(opt.series![0]!), points.map((p) => p.credits));
    assert.equal(opt.animation, true);
    el.remove();
  });

  it('heatmap renders one cell per day (plus a legend swatch per bucket) with multi-day data', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountHeatmap(el);
    h.update(snapshot);
    const { cells } = snapshot.chartData.heatmap;
    assert.ok(cells.length > 300, 'about a year of days');
    assert.equal(el.querySelectorAll('.wv-heatmap-grid .wv-heatmap-cell').length, cells.length);
    assert.equal(el.querySelectorAll('.wv-heatmap-legend-swatch').length, 5);
    assert.equal(el.style.display, '');
    // The busiest day lands in the top intensity bucket.
    assert.ok(el.querySelector('.wv-heatmap-cell--4'));
    el.remove();
  });

  it('hourlyTimeline plots 24 hourly bars and highlights only the peak hour', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountHourlyTimeline(el);
    h.update(snapshot);
    const { hours, peakHour } = snapshot.chartData.hourlyTimeline;
    const data = lastOption(h).series![0]!.data as StubDatum[];
    assert.equal(data.length, 24);
    assert.equal(peakHour === null, false);
    const colors = data.map((d) => d.itemStyle?.color);
    const peakColor = colors[peakHour!];
    assert.equal(colors.filter((c) => c === peakColor).length, 1, 'only the peak hour wears the accent');
    assert.ok(hours[peakHour!]! > 0);
    el.remove();
  });

  it('cumulativeArea plots the host\'s running total and draws the monthly budget as a reference line', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountCumulativeArea(el);
    h.update(snapshot);
    const series = lastOption(h).series![0]!;
    assert.deepEqual(series.data, snapshot.chartData.dailyBars.cumulativeCosts);
    assert.deepEqual(series.markLine!.data, [{ yAxis: 50 }]);
    el.remove();
  });

  it('weekdayRadial plots Monday-first, rotating the host\'s Sunday-first totals', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountWeekdayRadial(el);
    h.update(snapshot);
    const { totals } = snapshot.chartData.weekdayBreakdown;
    const plotted = seriesValues(lastOption(h).series![0]!);
    assert.equal(plotted.length, 7);
    assert.deepEqual(plotted, [1, 2, 3, 4, 5, 6, 0].map((i) => Math.round(totals[i] ?? 0)));
    el.remove();
  });
});

describe('components — DOM events + deeper updates', () => {
  beforeEach(resetFilterState);
  afterEach(resetFilterState);

  it('FilterBar model-filter: picking a model checks it, updates the label, and posts it as a filter', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountFilterBar(el);
    const snap = richSnapshot();
    h.update(snap, 'credits');

    const option = [...el.querySelectorAll<HTMLElement>('#model-dropdown [role="option"]')]
      .find((o) => o.dataset.model === 'gpt-4o')!;
    option.click();

    const chosen = [...el.querySelectorAll<HTMLElement>('#model-dropdown [role="option"]')]
      .find((o) => o.dataset.model === 'gpt-4o')!;
    assert.equal(chosen.getAttribute('aria-selected'), 'true');
    assert.equal(el.querySelector('#model-filter-label')!.textContent, 'gpt-4o');
    assert.deepEqual(postedSetFilters().at(-1)!.value.models, ['gpt-4o']);
    assert.deepEqual(state().filter.models, ['gpt-4o']);
    el.remove();
  });

  it('FilterBar date-preset click marks the preset pressed and posts the preset with its range', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountFilterBar(el);
    h.update(richSnapshot(), 'cost');

    el.querySelector<HTMLButtonElement>('[data-preset="7d"]')!.click();

    assert.equal(el.querySelector('[data-preset="7d"]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(el.querySelector('[data-preset="month"]')!.getAttribute('aria-pressed'), 'false');
    const sent = postedSetFilters().at(-1)!.value;
    assert.equal(sent.rangePreset, '7d');
    assert.ok(sent.range, 'a relative preset carries a concrete range too');
    el.remove();
  });

  it('CurrencySelector change fires the onChange callback', () => {
    let changed = '';
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountCurrencySelector(el, (code) => { changed = code; });
    h.update({ USD: 1, EUR: 0.92, JPY: 150 }, 'EUR');
    const select = el.querySelector('select') as HTMLSelectElement;
    select.value = 'JPY';
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
    assert.equal(changed, 'JPY');
    el.remove();
  });

  it('StatusBanner renders degraded, empty and loading statuses with matching kind and text', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountStatusBanner(el);
    const banner = () => el.querySelector<HTMLElement>('.wv-banner')!;
    const text = () => el.querySelector('.wv-banner-text')!.textContent;

    h.update({ ...richSnapshot(), status: { kind: 'degraded', reason: 'Connector error' } });
    assert.equal(banner().dataset.kind, 'warn');
    assert.equal(text(), 'Degraded: Connector error');

    h.update({ ...richSnapshot(), status: { kind: 'empty', reason: 'No logs' } });
    assert.equal(banner().dataset.kind, 'empty');
    assert.equal(text(), 'No logs');

    h.update({ ...richSnapshot(), status: { kind: 'loading', reason: 'Reading…' } });
    assert.equal(banner().dataset.kind, 'loading');
    assert.equal(text(), 'Reading…');
    el.remove();
  });

  it('RestrictionBanner: Dismiss hides it, snooze posts a restrictSnooze, and an active override shows the snoozed notice', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountRestrictionBanner(el);
    const active = { version: 1 as const, active: true, ruleId: 'r', reasonMessage: 'Over budget', firedAt: Date.now(), userOverrideUntil: null };
    h.update(active);
    assert.equal(el.querySelector('[role="alert"] strong')!.textContent, 'Over budget');

    const posted = (globalThis as unknown as { __postedMessages: unknown[] }).__postedMessages;
    el.querySelector<HTMLButtonElement>('#restrict-snooze-15')!.click();
    assert.deepEqual(posted.at(-1), { type: 'restrictSnooze', minutes: 15 });

    el.querySelector<HTMLButtonElement>('button')!.click(); // the first button is Dismiss
    assert.equal(el.style.display, 'none');
    assert.equal(el.querySelector('[role="alert"]'), null);

    h.update({ ...active, firedAt: active.firedAt + 1, userOverrideUntil: Date.now() + 60000 });
    assert.match(el.querySelector('[role="status"]')!.textContent!, /Snoozed for 1m/);
    el.remove();
  });

  it('KpiCards shows different readouts for each metric variant', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountKpiCards(el);
    const seen = new Set<string>();
    for (const m of METRICS) {
      h.update(richSnapshot(), m);
      seen.add(el.querySelector('#kpi-today-val')!.textContent!);
    }
    assert.equal(seen.size, METRICS.length, `distinct today readouts, got ${[...seen].join(' | ')}`);
    el.remove();
  });
});

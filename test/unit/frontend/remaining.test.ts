import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { UsageSnapshot } from '../../../src/extension-backend/domain/types';
import { mountDailyBars } from '../../../src/extension-frontend/charts/dailyBars';
import { mountCumulativeArea } from '../../../src/extension-frontend/charts/cumulativeArea';
import { mountModelBreakdown } from '../../../src/extension-frontend/charts/modelBreakdown';
import { mountFilterBar } from '../../../src/extension-frontend/components/FilterBar';
import { resetFilterSync } from '../../../src/extension-frontend/filterSync';
import { setState, state } from '../../../src/extension-frontend/store';
import { readTheme } from '../../../src/extension-frontend/theme';
import { lastOption, seriesValues, StubDatum } from './stubChart';

function richSnapshot(): UsageSnapshot {
  const now = Date.now();
  return buildSnapshot(
    [
      makeEvent({ ts: now - 1000, modelId: 'gpt-4o', credits: 50, cost: 2, surface: 'chat', source: 'local', costByCategory: { input: 0.5, output: 0.8 } }),
      makeEvent({ ts: now - 2000, modelId: 'claude-sonnet-4-5', credits: 30, cost: 1.2, surface: 'inline', source: 'local', costByCategory: { input: 0.4, output: 0.6 } }),
      makeEvent({ ts: now - 3000, modelId: 'gpt-4o', credits: 20, cost: 0.8, surface: 'agent', source: 'claude-code' }),
      makeEvent({ ts: now - 5 * 86400000, modelId: 'claude-sonnet-4-5', credits: 10, cost: 0.4, surface: 'chat', source: 'claude-code' }),
    ],
    {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    },
  );
}

describe('charts — projected pace, focus dimming, onModelClick', () => {
  it('dailyBars renders projected pace line when forecast is non-insufficient', () => {
    const snap = richSnapshot();
    // Force a non-insufficient forecast so projectedLine is non-null
    const withForecast: UsageSnapshot = {
      ...snap,
      chartData: {
        ...snap.chartData,
        dailyBars: { ...snap.chartData.dailyBars, projectedLine: 10 },
      },
    };
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountDailyBars(el);
    h.update(withForecast);

    const opt = lastOption(h);
    const pace = opt.series!.find((s) => s.name === 'Projected pace')!;
    assert.ok(pace, 'a "Projected pace" series is drawn');
    assert.equal(pace.type, 'line');
    assert.equal(pace.lineStyle!.type, 'dotted');
    assert.deepEqual(seriesValues(pace), withForecast.chartData.dailyBars.points.map(() => 10));
    assert.equal(opt.legend!.show, true, 'the legend appears once there is more than one series');

    h.update(snap); // projectedLine back to null in the base fixture
    assert.equal(lastOption(h).series!.some((s) => s.name === 'Projected pace'), false);
    el.remove();
  });

  it('modelBreakdown calls onModelClick when a bar is clicked (via stub)', () => {
    const clicked: string[] = [];
    const el = document.createElement('div');
    document.body.appendChild(el);
    // Passing onModelClick triggers onMount → chart.on('click', ...) → stub fires immediately
    const h = mountModelBreakdown(el, (label) => clicked.push(label));
    h.update(richSnapshot(), 'cost');
    assert.ok(clicked.includes('gpt-4o'), 'click handler fired with model name');
    el.remove();
  });

  it('modelBreakdown dims non-focused models (bars and axis labels) when focusedModels is non-empty', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountModelBreakdown(el);
    const handle = h as unknown as { setFocused: (s: ReadonlySet<string>) => void };
    const snap = richSnapshot();

    handle.setFocused(new Set(['gpt-4o']));
    h.update(snap, 'cost');
    const opt = lastOption(h);
    const labels = opt.yAxis!.data!;
    const bars = opt.series![0]!.data as StubDatum[];
    assert.ok(labels.includes('gpt-4o') && labels.length >= 2);
    labels.forEach((label, i) => {
      if (label === 'gpt-4o') assert.equal(bars[i]!.itemStyle, undefined, 'focused bar keeps full opacity');
      else assert.equal(bars[i]!.itemStyle?.opacity, 0.25, `${label} dimmed`);
    });
    const labelColor = opt.yAxis!.axisLabel!.color!;
    assert.equal(labelColor('gpt-4o'), undefined, 'focused label keeps the theme colour');
    assert.equal(labelColor('claude-sonnet-4-5'), readTheme().muted, 'others fade to the muted colour');

    handle.setFocused(new Set());
    h.update(snap, 'cost');
    const cleared = lastOption(h).series![0]!.data as StubDatum[];
    assert.ok(cleared.every((d) => d.itemStyle === undefined), 'clearing focus restores every bar');
    el.remove();
  });
});

describe('cumulativeArea — no budget branch', () => {
  it('renders without a budget line when monthlyBudget is 0, and with one when a budget is set', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountCumulativeArea(el);
    const snap = richSnapshot();
    // Override budget.monthly to null so the markLine ternary takes the false branch
    h.update({
      ...snap,
      budget: { ...snap.budget, monthly: null },
    });
    assert.equal(lastOption(h).series![0]!.markLine, undefined);

    h.update({ ...snap, budget: { ...snap.budget, monthly: 80 } });
    assert.deepEqual(lastOption(h).series![0]!.markLine!.data, [{ yAxis: 80 }]);
    el.remove();
  });
});

describe('FilterBar — source chips, model dropdown, surface toggle', () => {
  function reset(): void {
    resetFilterSync();
    setState({ filter: {}, datePreset: 'month', metric: 'cost' });
    (globalThis as unknown as { __postedMessages: unknown[] }).__postedMessages = [];
  }
  beforeEach(reset);
  afterEach(reset);

  function lastFilter(): Record<string, unknown> {
    const all = (globalThis as unknown as { __postedMessages: Array<{ type: string; value: Record<string, unknown> }> }).__postedMessages;
    return all.filter((m) => m.type === 'setFilter').at(-1)!.value;
  }

  function mount() {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const h = mountFilterBar(el);
    h.update(richSnapshot(), 'credits');
    const pressed = (sel: string) => el.querySelector(sel)!.getAttribute('aria-pressed');
    return { el, h, pressed };
  }

  it('source chips filter to Copilot sources, to Claude Code, or back to all', () => {
    const { el, pressed } = mount();
    assert.equal(pressed('[data-source-group="__all__"]'), 'true', 'starts unfiltered');

    el.querySelector<HTMLElement>('[data-source-group="claude-code"]')!.click();
    assert.deepEqual(lastFilter().sources, ['claude-code']);
    assert.equal(pressed('[data-source-group="claude-code"]'), 'true');
    assert.equal(pressed('[data-source-group="__all__"]'), 'false');

    el.querySelector<HTMLElement>('[data-source-group="copilot"]')!.click();
    assert.deepEqual(lastFilter().sources, ['lm', 'local', 'github']);
    assert.equal(pressed('[data-source-group="copilot"]'), 'true');

    el.querySelector<HTMLElement>('[data-source-group="__all__"]')!.click();
    assert.equal('sources' in lastFilter(), false);
    assert.equal(pressed('[data-source-group="__all__"]'), 'true');
    el.remove();
  });

  it('surface chips select one surface, toggle it off on a second click, and "All" clears it', () => {
    const { el, pressed } = mount();
    el.querySelector<HTMLElement>('[data-surface="inline"]')!.click();
    assert.deepEqual(lastFilter().surfaces, ['inline']);
    assert.equal(pressed('[data-surface="inline"]'), 'true');
    assert.equal(pressed('[data-surface="__all__"]'), 'false');

    el.querySelector<HTMLElement>('[data-surface="inline"]')!.click();
    assert.equal('surfaces' in lastFilter(), false, 'second click toggles it off');
    assert.equal(pressed('[data-surface="__all__"]'), 'true');

    el.querySelector<HTMLElement>('[data-surface="agent"]')!.click();
    el.querySelector<HTMLElement>('[data-surface="__all__"]')!.click();
    assert.equal('surfaces' in lastFilter(), false);
    el.remove();
  });

  it('model dropdown: clicking models builds the multi-select, All models clears it', () => {
    const { el } = mount();
    const option = (model: string) =>
      [...el.querySelectorAll<HTMLElement>('#model-dropdown [role="option"]')].find((o) => o.dataset.model === model)!;
    const [first, second] = richSnapshot().allModels;

    option(first!).click();
    assert.deepEqual(lastFilter().models, [first]);
    option(second!).click();
    assert.deepEqual(lastFilter().models, [first, second]);
    assert.equal(el.querySelector('#model-filter-label')!.textContent, '2 models');

    option(first!).click(); // deselect
    assert.deepEqual(lastFilter().models, [second]);
    assert.equal(option(first!).getAttribute('aria-selected'), 'false');

    option('__all__').click();
    assert.equal('models' in lastFilter(), false);
    assert.equal(el.querySelector('#model-filter-label')!.textContent, 'All models');
    assert.equal(option('__all__').getAttribute('aria-selected'), 'true');
    el.remove();
  });

  it('date-preset buttons are exclusive and metric buttons switch the shared metric', () => {
    const { el, h } = mount();
    for (const preset of ['today', '7d', '30d', 'month', 'all']) {
      el.querySelector<HTMLButtonElement>(`[data-preset="${preset}"]`)!.click();
      const pressedPresets = [...el.querySelectorAll<HTMLElement>('[data-preset]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.dataset.preset);
      assert.deepEqual(pressedPresets, [preset]);
      assert.equal(lastFilter().rangePreset, preset);
    }

    el.querySelectorAll<HTMLButtonElement>('[data-metric]').forEach((btn) => btn.click());
    assert.equal(state().metric, 'tokens', 'the last metric button clicked wins');
    h.update(richSnapshot(), state().metric);
    assert.equal(el.querySelector('[data-metric="tokens"]')!.getAttribute('aria-pressed'), 'true');
    assert.equal(el.querySelector('[data-metric="cost"]')!.getAttribute('aria-pressed'), 'false');
    el.remove();
  });

  it('model dropdown opens and closes from the button, a click outside, and the keyboard', () => {
    const { el } = mount();
    const btn = el.querySelector<HTMLButtonElement>('#model-filter-btn')!;
    const dropdown = el.querySelector<HTMLElement>('#model-dropdown')!;
    const options = () => [...dropdown.querySelectorAll<HTMLElement>('[role="option"]')];
    const key = (target: HTMLElement, k: string) =>
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

    assert.equal(dropdown.hidden, true);
    btn.click();
    assert.equal(dropdown.hidden, false);
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    assert.equal(document.activeElement, options()[0], 'opening focuses the first option');
    btn.click();
    assert.equal(dropdown.hidden, true);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');

    key(btn, 'Enter');
    assert.equal(dropdown.hidden, false);
    key(dropdown, 'ArrowDown');
    assert.equal(document.activeElement, options()[1]);
    key(dropdown, 'ArrowDown');
    assert.equal(document.activeElement, options()[2]);
    key(dropdown, 'ArrowUp');
    assert.equal(document.activeElement, options()[1]);

    key(dropdown, 'Enter'); // activates the focused option
    assert.deepEqual(lastFilter().models, [options()[1]!.dataset.model]);
    assert.equal(document.activeElement, options()[1], 'focus stays on the toggled model after the rebuild');

    key(dropdown, 'Escape');
    assert.equal(dropdown.hidden, true);
    assert.equal(document.activeElement, btn, 'Escape returns focus to the button');

    btn.click();
    document.body.click();
    assert.equal(dropdown.hidden, true, 'clicking outside closes it');
    el.remove();
  });
});

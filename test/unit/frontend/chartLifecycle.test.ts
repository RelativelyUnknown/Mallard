import { strict as assert } from 'assert';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { UsageSnapshot } from '../../../src/extension-backend/domain/types';
import { mountDailyBars } from '../../../src/extension-frontend/charts/dailyBars';
import { mountModelBreakdown } from '../../../src/extension-frontend/charts/modelBreakdown';
import { mountHourlyTimeline } from '../../../src/extension-frontend/charts/hourlyTimeline';
import { CHART_REGISTRY } from '../../../src/extension-frontend/charts/registry';
import { recordCharts } from './stubChart';

function makeSnapshot(): UsageSnapshot {
  const now = Date.now();
  return buildSnapshot(
    [
      makeEvent({ ts: now - 1000, modelId: 'gpt-4o', credits: 50, cost: 2, surface: 'chat' }),
      makeEvent({ ts: now - 2000, modelId: 'claude-sonnet-4-5', credits: 6, cost: 0.24, surface: 'inline' }),
    ],
    {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    },
  );
}

describe('theme reinit — event handlers survive the instance being recreated', () => {
  it('reinit() disposes the old ECharts instance and creates a new one', () => {
    recordCharts((created) => {
      const h = mountHourlyTimeline(document.createElement('div'));
      assert.equal(created.length, 1);
      h.reinit();
      assert.equal(created.length, 2);
      assert.equal(created[0]!.disposed, true);
      assert.equal(created[1]!.disposed, false);
    });
  });

  it('modelBreakdown attaches its click handler to the new instance after reinit()', () => {
    recordCharts((created) => {
      const clicked: string[] = [];
      const h = mountModelBreakdown(document.createElement('div'), (label) => clicked.push(label));
      assert.equal(created[0]!.handlers.get('click')?.length, 1);

      h.reinit();
      assert.equal(created[1]!.handlers.get('click')?.length, 1, 'handler re-attached to the recreated instance');

      created[1]!.emit('click', { name: 'gpt-4o' });
      assert.deepEqual(clicked, ['gpt-4o']);
    });
  });

  it('a bar click after a theme change still toggles the model filter (registry wiring)', () => {
    recordCharts((created) => {
      const toggled: string[] = [];
      const def = CHART_REGISTRY.find((d) => d.id === 'models')!;
      const chart = def.mount(document.createElement('div'), { toggleModelFilter: (l) => toggled.push(l) });
      chart.update(makeSnapshot(), { metric: 'credits', focusedModels: [] });

      // What main.ts's rerenderForTheme does: reinit, then replay the last render.
      chart.reinit();
      chart.update(makeSnapshot(), { metric: 'credits', focusedModels: [] });

      created.at(-1)!.emit('click', { name: 'claude-sonnet-4-5' });
      assert.deepEqual(toggled, ['claude-sonnet-4-5']);
    });
  });

  it('a click with no bar name is ignored', () => {
    recordCharts((created) => {
      const clicked: string[] = [];
      mountModelBreakdown(document.createElement('div'), (label) => clicked.push(label));
      created[0]!.emit('click', {});
      assert.deepEqual(clicked, []);
    });
  });
});

describe('dailyBars — incremental updates', () => {
  function withToday(s: UsageSnapshot, credits: number, incremental: boolean): UsageSnapshot {
    const points = s.chartData.dailyBars.points.map((p, i, all) =>
      i === all.length - 1 ? { ...p, credits, cost: credits / 25 } : p);
    return {
      ...s,
      isIncremental: incremental,
      chartData: { ...s.chartData, dailyBars: { ...s.chartData.dailyBars, points } },
    };
  }

  it('applies a full option (axes and series) to an instance recreated by a theme change, even when the snapshot is incremental', () => {
    recordCharts((created) => {
      const base = makeSnapshot();
      const h = mountDailyBars(document.createElement('div'));
      h.update(base);
      h.reinit();
      h.update(withToday(base, 99, true));

      const calls = created[1]!.setOptionCalls;
      assert.equal(calls.length, 1);
      const option = calls[0]!.option;
      assert.ok(option.xAxis, 'full option carries the x axis');
      assert.ok(option.yAxis, 'full option carries the y axis');
      assert.equal(option.series?.[0]?.type, 'bar');
    });
  });

  it('a very first incremental snapshot on a fresh chart is also a full render', () => {
    recordCharts((created) => {
      const h = mountDailyBars(document.createElement('div'));
      h.update(withToday(makeSnapshot(), 5, true));
      assert.ok(created[0]!.setOptionCalls[0]!.option.xAxis);
    });
  });

  it('after a clear (no data) the next incremental snapshot re-renders in full', () => {
    recordCharts((created) => {
      const base = makeSnapshot();
      const h = mountDailyBars(document.createElement('div'));
      h.update(base);
      const empty: UsageSnapshot = {
        ...base,
        chartData: { ...base.chartData, dailyBars: { ...base.chartData.dailyBars, points: [] } },
      };
      h.update(empty);
      h.update(withToday(base, 7, true));
      const last = created[0]!.setOptionCalls.at(-1)!.option;
      assert.ok(last.xAxis, 'axes restored');
    });
  });

  it('on a warm instance an incremental update is partial but refreshes the tooltip data', () => {
    recordCharts((created) => {
      const base = makeSnapshot();
      const h = mountDailyBars(document.createElement('div'));
      h.update(withToday(base, 10, false));
      h.update(withToday(base, 77, true));

      const calls = created[0]!.setOptionCalls;
      assert.equal(calls.length, 2);
      const partial = calls[1]!.option;
      assert.equal(partial.xAxis, undefined, 'no axis rebuild for a one-bar change');
      const todayIdx = base.chartData.dailyBars.points.length - 1;

      // The formatter in the incremental option reads the NEW points...
      const text = partial.tooltip!.formatter!([{ dataIndex: todayIdx }]);
      assert.match(text, /77/);
      // ...whereas the formatter from the first render still holds the old ones.
      assert.match(calls[0]!.option.tooltip!.formatter!([{ dataIndex: todayIdx }]), /10/);
    });
  });
});

describe('modelBreakdown — metric switch', () => {
  it('replaces series on update so a dropped ghost series is removed (replaceMerge)', () => {
    recordCharts((created) => {
      const h = mountModelBreakdown(document.createElement('div'));
      const s = makeSnapshot();
      h.update(s, 'cost');
      h.update(s, 'credits');

      const [costCall, creditsCall] = created[0]!.setOptionCalls;
      assert.equal(costCall!.option.series!.length, 2, 'cost mode draws the ghost series');
      assert.equal(creditsCall!.option.series!.length, 1, 'credits mode has none');
      for (const call of [costCall!, creditsCall!]) {
        assert.equal(call.opts?.notMerge, false);
        assert.deepEqual(call.opts?.replaceMerge, ['series']);
      }
    });
  });

  it('draws the ghost bar in a concrete colour, not the CSS keyword currentColor', () => {
    recordCharts((created) => {
      const h = mountModelBreakdown(document.createElement('div'));
      h.update(makeSnapshot(), 'cost');
      const ghost = created[0]!.setOptionCalls[0]!.option.series![1]!;
      const color = ghost.itemStyle?.color;
      assert.ok(color && color.toLowerCase() !== 'currentcolor', `got ${color}`);
      assert.match(color!, /^(#|rgb)/);
    });
  });

  it('charts that rebuild their whole option each time do not opt into replaceMerge', () => {
    recordCharts((created) => {
      const h = mountHourlyTimeline(document.createElement('div'));
      const s = makeSnapshot();
      s.chartData.hourlyTimeline = { hours: [0, 1, ...new Array<number>(22).fill(0)], peakHour: 1 };
      h.update(s);
      const opts = created[0]!.setOptionCalls[0]!.opts!;
      assert.equal(opts.notMerge, true);
      assert.equal('replaceMerge' in opts, false);
    });
  });
});

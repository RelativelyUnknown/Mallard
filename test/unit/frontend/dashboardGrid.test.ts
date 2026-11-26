import { strict as assert } from 'assert';
import type { LayoutV2 } from '../../../src/extension-backend/domain/contracts';
import { defaultLayout, PANEL_IDS } from '../../../src/extension-backend/domain/layout';
import { CHART_REGISTRY } from '../../../src/extension-frontend/charts/registry';
import { mountDashboardGrid } from '../../../src/extension-frontend/dashboardGrid';
import type { DashboardGrid } from '../../../src/extension-frontend/dashboardGrid';
import { ENGINE_OPTIONS } from '../../../src/extension-frontend/gridConstants';
import { GridstackEngine } from '../../../src/extension-frontend/gridstackEngine';
import { collectPanels, LAYOUT_HINT_ID, panelItemHtml } from '../../../src/extension-frontend/panels';
import { FakeEngine } from './fakeEngine';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEBOUNCE = 5;

function build(engine: FakeEngine | GridstackEngine = new FakeEngine()) {
  document.body.innerHTML = `
    <button id="edit" aria-pressed="false">Edit layout</button>
    <button id="reset" hidden>Reset layout</button>
    <button id="add">Add chart</button>
    <p id="${LAYOUT_HINT_ID}" hidden>hint</p>
    <div id="live" role="status" aria-live="polite"></div>
    <div id="grid" class="grid-stack">${CHART_REGISTRY.map(panelItemHtml).join('')}</div>`;
  const root = document.getElementById('grid')!;
  const { items, titles } = collectPanels(CHART_REGISTRY, root);
  const persisted: LayoutV2[] = [];
  const grid = mountDashboardGrid({
    root,
    items,
    titles,
    engine,
    controls: {
      edit: document.getElementById('edit')!,
      reset: document.getElementById('reset')!,
      add: document.getElementById('add')!,
      hint: document.getElementById(LAYOUT_HINT_ID)!,
      live: document.getElementById('live')!,
    },
    onPersist: (l) => void persisted.push(l),
    debounceMs: DEBOUNCE,
  });
  const q = (sel: string) => document.querySelector<HTMLElement>(sel)!;
  const item = (id: string) => items[id]!;
  const grip = (id: string) => q(`[data-panel="${id}"] [data-act="move"]`);
  const hideBtn = (id: string) => q(`[data-panel="${id}"] [data-act="hide"]`);
  const press = (target: Element, key: string) => target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const live = () => q('#live').textContent;
  return { engine, root, grid, persisted, q, item, grip, hideBtn, press, live };
}

const hiddenIds = (l: LayoutV2) => l.panels.filter((p) => p.hidden).map((p) => p.id);
const panel = (l: LayoutV2, id: string) => l.panels.find((p) => p.id === id)!;

describe('dashboardGrid controller (with a fake engine)', () => {
  let ctx: ReturnType<typeof build>;
  let grid: DashboardGrid;
  const engine = () => ctx.engine as FakeEngine;
  beforeEach(() => {
    ctx = build();
    grid = ctx.grid;
  });
  afterEach(() => {
    grid.destroy();
    document.body.innerHTML = '';
  });

  describe('mount and apply', () => {
    it('mounts the engine with the dashboard option set and starts static and wide', () => {
      assert.equal(engine().mountedWith, ENGINE_OPTIONS);
      assert.equal(engine().isStatic(), true);
      assert.equal(grid.isEditing(), false);
      assert.equal(grid.isNarrow(), false);
    });

    it('registers the visible panels in one go and takes the hidden ones out of the grid (not display:none)', () => {
      grid.apply(defaultLayout());
      const visible = defaultLayout().panels.filter((p) => !p.hidden).map((p) => p.id);
      assert.deepEqual(engine().calls.filter((c) => c.startsWith('registerAll')), [`registerAll:${visible.join(',')}`]);
      for (const id of PANEL_IDS) assert.equal(ctx.item(id).hidden, !visible.includes(id), id);
      assert.deepEqual(engine().save().map((p) => p.id).sort(), [...visible].sort());
    });

    it('labels every hide button "Hide X" or "Show X" from the panel state', () => {
      grid.apply(defaultLayout());
      assert.equal(ctx.hideBtn('daily').getAttribute('aria-label'), 'Hide Daily usage (last 30 days)');
      assert.equal(ctx.hideBtn('daily').getAttribute('title'), 'Hide Daily usage (last 30 days)');
      assert.equal(ctx.hideBtn('repos').getAttribute('aria-label'), 'Show By repository');
    });

    it('applying the layout it already shows is a no-op: nothing is re-registered, focus stays put', () => {
      grid.apply(defaultLayout());
      grid.setEditing(true);
      ctx.grip('models').focus();
      const calls = engine().calls.length;
      grid.apply(defaultLayout());
      grid.apply(JSON.parse(JSON.stringify(defaultLayout())));
      assert.equal(engine().calls.length, calls);
      assert.equal(document.activeElement, ctx.grip('models'), 'a host echo does not blur the control being used');
    });

    it('a different layout moves what differs, removes what became hidden and adds what became visible', () => {
      grid.apply(defaultLayout());
      const next = defaultLayout();
      next.panels = next.panels.map((p) => {
        if (p.id === 'models') return { ...p, x: 3, y: 40 };
        if (p.id === 'sankey') return { ...p, hidden: true };
        if (p.id === 'repos') return { ...p, hidden: false };
        return p;
      });
      engine().calls.length = 0;
      grid.apply(next);
      assert.deepEqual(engine().calls, ['unregister:sankey', 'add:repos', 'load:models']);
      assert.equal(ctx.item('sankey').hidden, true);
      assert.equal(ctx.item('repos').hidden, false);
      assert.equal(ctx.hideBtn('sankey').getAttribute('aria-label'), 'Show Flow breakdown');
      assert.equal(ctx.hideBtn('repos').getAttribute('aria-label'), 'Hide By repository');
      assert.equal(ctx.persisted.length, 0, 'a layout from the host never persists by itself');
    });

    it('keeps ids this build has no panel for, and ignores panels the layout does not list', () => {
      const layout = defaultLayout();
      layout.panels.push({ id: 'from-the-future', x: 0, y: 99, w: 1, h: 7, hidden: false });
      layout.panels = layout.panels.filter((p) => p.id !== 'hourly');
      grid.apply(layout);
      assert.equal(ctx.item('hourly').hidden, true, 'not in the layout: not in the grid');
      engine().dragTo('daily', { x: 1 });
      engine().emit();
      grid.flush();
      assert.ok(panel(ctx.persisted.at(-1)!, 'from-the-future'), 'the unknown panel round-trips through a save');
      assert.equal(panel(ctx.persisted.at(-1)!, 'daily').x, 1);
    });

    it('re-applies after a no-data panel was removed, without resurrecting it', () => {
      grid.apply(defaultLayout());
      grid.setNoData('heatmap', true);
      const next = defaultLayout();
      next.panels = next.panels.map((p) => (p.id === 'models' ? { ...p, w: 2 } : p));
      grid.apply(next);
      assert.equal(engine().isRegistered('heatmap'), false);
      assert.equal(engine().rect('models')!.w, 2);
    });
  });

  describe('persistence', () => {
    beforeEach(() => grid.apply(defaultLayout()));

    it('persists a pointer drag once, after the debounce, with every panel (parked ones keep their last rect)', async () => {
      engine().dragTo('daily', { x: 2 });
      engine().emit();
      engine().dragTo('daily', { x: 1 });
      engine().emit();
      assert.equal(ctx.persisted.length, 0, 'debounced');
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.persisted.length, 1, 'two changes in a row, one save');
      const saved = ctx.persisted[0]!;
      assert.equal(saved.version, 2);
      assert.equal(saved.panels.length, PANEL_IDS.length);
      assert.equal(panel(saved, 'daily').x, 1);
      assert.deepEqual(hiddenIds(saved), ['repos', 'categoryTrend', 'tokens', 'billing', 'languages']);
      assert.deepEqual(panel(saved, 'repos'), panel(defaultLayout(), 'repos'), 'a hidden panel keeps its reserved rect');
    });

    it('flush() persists immediately and cancels the pending timer', async () => {
      engine().emit();
      grid.flush();
      assert.equal(ctx.persisted.length, 1);
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.persisted.length, 1);
    });

    it('does not persist the host\'s echo of its own save (that would re-arrange a grid the user is already moving)', () => {
      engine().dragTo('daily', { x: 1 });
      engine().emit();
      grid.flush();
      const echoed = ctx.persisted.at(-1)!;
      engine().dragTo('daily', { x: 2 }); // the user keeps dragging while the echo is on its way
      const calls = engine().calls.length;
      grid.apply(JSON.parse(JSON.stringify(echoed)));
      assert.equal(engine().calls.length, calls, 'the echo is ignored');
      assert.equal(engine().rect('daily')!.x, 2);
    });

    it('never persists while the grid is narrow, nor for an ignorable (mid-load) change', async () => {
      engine().emit({ ignorable: true });
      engine().setColumns(1);
      engine().emit();
      grid.flush();
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.persisted.length, 0, 'a one-column view never overwrites the wide layout');
    });

    it('stores the positions the engine reports, so compaction after a change is part of the save', () => {
      engine().dragTo('models', { y: 5 });
      engine().emit();
      grid.flush();
      assert.equal(panel(ctx.persisted[0]!, 'models').y, 5);
    });
  });

  describe('hide, show and the Add chart list', () => {
    beforeEach(() => grid.apply(defaultLayout()));

    it('the hide button removes the panel from the grid, flips its label, moves focus to Add chart, announces, persists', async () => {
      grid.setEditing(true);
      ctx.hideBtn('models').focus();
      ctx.hideBtn('models').click();

      assert.equal(engine().isRegistered('models'), false);
      assert.equal(ctx.item('models').hidden, true);
      assert.equal(ctx.hideBtn('models').getAttribute('aria-label'), 'Show By model');
      assert.equal(document.activeElement, ctx.q('#add'), 'the focused button just left the grid');
      await sleep(DEBOUNCE * 4);
      assert.ok(hiddenIds(ctx.persisted.at(-1)!).includes('models'));
      assert.equal(ctx.live(), 'By model hidden. Use Add chart to bring it back.');
      assert.ok(grid.hiddenPanels().some((p) => p.id === 'models' && p.title === 'By model'));
    });

    it('the grip is not a hide button: clicks elsewhere in the grid do nothing', () => {
      const calls = engine().calls.length;
      ctx.grip('models').click();
      ctx.q('.wv-chart-title').click();
      assert.equal(engine().calls.length, calls);
    });

    it('hiddenPanels() lists the hidden panels with their titles, in layout order, and nothing else', () => {
      assert.deepEqual(grid.hiddenPanels().map((p) => p.id), ['repos', 'categoryTrend', 'tokens', 'billing', 'languages']);
      assert.equal(grid.hiddenPanels()[0]!.title, 'By repository');
      const layout = defaultLayout();
      layout.panels.push({ id: 'from-the-future', x: 0, y: 99, w: 1, h: 7, hidden: true });
      grid.apply(layout);
      assert.equal(grid.hiddenPanels().some((p) => p.id === 'from-the-future'), false, 'no panel to add for an unknown id');
    });

    it('show() adds the panel back at its reserved rect, flips the label, persists and announces', async () => {
      grid.show('repos');
      assert.equal(engine().isRegistered('repos'), true);
      assert.deepEqual(engine().rect('repos'), { ...panelRect(defaultLayout(), 'repos') });
      assert.equal(ctx.item('repos').hidden, false);
      assert.equal(ctx.hideBtn('repos').getAttribute('aria-label'), 'Hide By repository');
      assert.equal(ctx.live(), '', 'announced on the next frame');
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.live(), 'By repository added.');
      assert.equal(hiddenIds(ctx.persisted.at(-1)!).includes('repos'), false);
    });

    it('show() on a panel that is not hidden (or unknown) does nothing', () => {
      const calls = engine().calls.length;
      grid.show('models');
      grid.show('nope');
      assert.equal(engine().calls.length, calls);
    });

    it('show() on a panel with no data explains that it will appear once there is data', async () => {
      grid.setNoData('repos', true);
      grid.show('repos');
      assert.equal(engine().isRegistered('repos'), false);
      await sleep(DEBOUNCE * 2);
      assert.equal(ctx.live(), 'By repository added. It has no data yet, so it appears once there is some.');
      assert.equal(grid.hiddenPanels().some((p) => p.id === 'repos'), false);
    });
  });

  describe('panels without data', () => {
    beforeEach(() => grid.apply(defaultLayout()));

    it('leave the grid, return at their last rect, and never touch the stored layout', async () => {
      engine().calls.length = 0;
      grid.setNoData('heatmap', true);
      assert.deepEqual(engine().calls, ['unregister:heatmap']);
      assert.equal(ctx.item('heatmap').hidden, true);
      grid.setNoData('heatmap', true); // repeated snapshots say the same thing
      assert.equal(engine().calls.length, 1);

      grid.setNoData('heatmap', false);
      assert.deepEqual(engine().calls.at(-1), 'add:heatmap');
      assert.equal(ctx.item('heatmap').hidden, false);
      assert.deepEqual(engine().rect('heatmap'), panelRect(defaultLayout(), 'heatmap'));
      grid.setNoData('heatmap', false);
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.persisted.length, 0, 'a data-driven change is not a layout change');
    });

    it('a panel that is both hidden and without data stays out when the data arrives', () => {
      grid.setNoData('repos', true);
      grid.setNoData('repos', false);
      assert.equal(engine().isRegistered('repos'), false);
    });

    it('their label does not claim the panel is hidden in the layout', () => {
      grid.setNoData('heatmap', true);
      assert.equal(ctx.hideBtn('heatmap').getAttribute('aria-label'), 'Hide Activity (past year)');
    });
  });

  describe('edit mode', () => {
    it('toggles static, the editing class, aria-pressed, the reset button and the hint, and announces it', async () => {
      grid.apply(defaultLayout());
      ctx.q('#edit').click();
      assert.equal(grid.isEditing(), true);
      assert.equal(engine().isStatic(), false);
      assert.equal(ctx.root.classList.contains('wv-editing'), true);
      assert.equal(ctx.q('#edit').getAttribute('aria-pressed'), 'true');
      assert.equal(ctx.q('#reset').hidden, false);
      assert.equal(ctx.q(`#${LAYOUT_HINT_ID}`).hidden, false);
      await sleep(5);
      assert.match(ctx.live(), /^Layout editing on\. Focus a panel's move handle and press Space to lift it\.$/);

      ctx.q('#edit').click();
      assert.equal(grid.isEditing(), false);
      assert.equal(engine().isStatic(), true);
      assert.equal(ctx.root.classList.contains('wv-editing'), false);
      assert.equal(ctx.q('#edit').getAttribute('aria-pressed'), 'false');
      assert.equal(ctx.q('#reset').hidden, true);
      assert.equal(ctx.q(`#${LAYOUT_HINT_ID}`).hidden, true);
      await sleep(5);
      assert.equal(ctx.live(), 'Layout editing off.');
    });

    it('setting the mode it is already in changes nothing', () => {
      const calls = engine().calls.length;
      grid.setEditing(false);
      assert.equal(engine().calls.length, calls);
      grid.setEditing(true);
      grid.setEditing(true);
      assert.equal(engine().calls.filter((c) => c === 'setStatic:false').length, 1);
    });

    it('one live region carries every announcement, and a repeated message is announced again', async () => {
      grid.setEditing(true);
      grid.setEditing(false);
      grid.setEditing(true);
      assert.equal(document.querySelectorAll('[aria-live]').length, 1);
      await sleep(5);
      grid.setEditing(false);
      assert.equal(ctx.live(), '', 'cleared first so the same text can repeat');
      await sleep(5);
      assert.equal(ctx.live(), 'Layout editing off.');
    });

    it('reset puts the default layout back, persists it at once and announces', async () => {
      grid.apply(defaultLayout());
      grid.setEditing(true);
      engine().dragTo('daily', { x: 2 });
      engine().emit();
      grid.flush();
      ctx.persisted.length = 0;
      ctx.q('#reset').click();
      assert.deepEqual(ctx.persisted, [defaultLayout()]);
      assert.equal(engine().rect('daily')!.x, 0);
      await sleep(5);
      assert.equal(ctx.live(), 'Layout reset to the default.');
    });
  });

  describe('the narrow (one-column) layout', () => {
    it('forces edit mode off, disables Edit and Add chart with an explanation, and re-enables them when wide again', () => {
      grid.apply(defaultLayout());
      grid.setEditing(true);
      engine().setColumns(1);
      assert.equal(grid.isNarrow(), true);
      assert.equal(grid.isEditing(), false);
      assert.equal(engine().isStatic(), true);
      for (const id of ['edit', 'add']) {
        assert.equal((ctx.q(`#${id}`) as HTMLButtonElement).disabled, true, id);
        assert.equal(ctx.q(`#${id}`).title, 'Layout editing is only available in the wide layout');
      }
      grid.setEditing(true);
      assert.equal(grid.isEditing(), false, 'cannot be switched on while narrow');

      engine().setColumns(4);
      assert.equal(grid.isNarrow(), false);
      assert.equal((ctx.q('#edit') as HTMLButtonElement).disabled, false);
      assert.equal(ctx.q('#edit').title, '');
      grid.setEditing(true);
      assert.equal(grid.isEditing(), true);
    });

    it('starts disabled when the window is already narrow at mount', () => {
      grid.destroy();
      const narrow = new FakeEngine();
      narrow.mount = function (root, opts) {
        FakeEngine.prototype.mount.call(this, root, { ...opts, columns: 1 });
      };
      ctx = build(narrow);
      grid = ctx.grid;
      assert.equal(grid.isNarrow(), true);
      assert.equal((ctx.q('#edit') as HTMLButtonElement).disabled, true);
    });
  });

  describe('keyboard lift mode through the controller', () => {
    beforeEach(() => {
      grid.apply(defaultLayout());
      grid.setEditing(true);
    });

    it('moves do not persist; the drop persists once the debounce passes', async () => {
      ctx.grip('models').focus();
      ctx.press(ctx.grip('models'), ' ');
      ctx.press(ctx.grip('models'), 'ArrowRight');
      ctx.press(ctx.grip('models'), 'ArrowRight');
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.persisted.length, 0, 'still lifted');
      ctx.press(ctx.grip('models'), ' ');
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.persisted.length, 1);
      assert.equal(panel(ctx.persisted[0]!, 'models').x, 2);
    });

    it('Escape cancels without persisting and leaves the model at the original positions', async () => {
      const original = engine().save();
      ctx.press(ctx.grip('models'), ' ');
      ctx.press(ctx.grip('models'), 'ArrowRight');
      ctx.press(ctx.grip('models'), 'Escape');
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.persisted.length, 0);
      assert.deepEqual(engine().save(), original);
      grid.flush();
      assert.equal(panel(ctx.persisted[0]!, 'models').x, 0, 'a later save carries the restored position');
    });

    it('a layout from the host that arrives mid-lift waits for the drop, then is applied', () => {
      ctx.press(ctx.grip('models'), ' ');
      const next = defaultLayout();
      next.panels = next.panels.map((p) => (p.id === 'daily' ? { ...p, w: 1 } : p));
      grid.apply(next);
      assert.equal(engine().rect('daily')!.w, 2, 'the grid is not rearranged under the lifted panel');
      ctx.press(ctx.grip('models'), ' ');
      assert.equal(engine().rect('daily')!.w, 1);
    });

    it('a no-data change mid-lift waits for the drop too', () => {
      ctx.press(ctx.grip('models'), ' ');
      grid.setNoData('heatmap', true);
      assert.equal(engine().isRegistered('heatmap'), true);
      ctx.press(ctx.grip('models'), 'Escape');
      assert.equal(engine().isRegistered('heatmap'), false);
    });

    it('switching edit mode off cancels a lift in progress', () => {
      ctx.press(ctx.grip('models'), ' ');
      ctx.press(ctx.grip('models'), 'ArrowRight');
      grid.setEditing(false);
      assert.equal(engine().rect('models')!.x, 0);
      assert.equal(ctx.grip('models').getAttribute('aria-pressed'), 'false');
    });
  });

  describe('destroy', () => {
    it('stops the pending save, detaches the keyboard layer and destroys the engine', async () => {
      grid.apply(defaultLayout());
      engine().emit();
      grid.destroy();
      await sleep(DEBOUNCE * 4);
      assert.equal(ctx.persisted.length, 0);
      assert.ok(engine().calls.includes('destroy'));
      grid.setEditing(true);
      ctx.press(ctx.grip('models'), ' ');
      assert.equal(ctx.grip('models').getAttribute('aria-pressed'), 'false');
    });
  });
});

function panelRect(l: LayoutV2, id: string) {
  const p = l.panels.find((q) => q.id === id)!;
  return { id: p.id, x: p.x, y: p.y, w: p.w, h: p.h };
}

describe('dashboardGrid controller (with the real gridstack engine)', () => {
  const g = globalThis as unknown as { ResizeObserver?: unknown };
  let stubbed = false;
  let ctx: ReturnType<typeof build>;
  before(() => {
    if (!g.ResizeObserver) {
      g.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      stubbed = true;
    }
  });
  after(() => {
    if (stubbed) delete g.ResizeObserver;
  });
  beforeEach(() => {
    ctx = build(new GridstackEngine());
    ctx.grid.apply(defaultLayout());
    ctx.grid.setEditing(true);
  });
  afterEach(() => {
    ctx.grid.destroy();
    document.body.innerHTML = '';
  });

  it('lays the default layout out exactly as migrated, and Tab order is the visual order', () => {
    const saved = (ctx.engine as GridstackEngine).save();
    const visible = defaultLayout().panels.filter((p) => !p.hidden);
    for (const p of visible) assert.deepEqual(saved.find((s) => s.id === p.id), panelRect(defaultLayout(), p.id));
    const dom = [...ctx.root.children].filter((el) => !(el as HTMLElement).hidden).map((el) => el.getAttribute('gs-id'));
    assert.deepEqual(dom, saved.map((s) => s.id));
  });

  it('lift, move and drop under real gravity: the neighbour is displaced, the saved layout is overlap-free', async () => {
    ctx.grip('weekday').focus();
    ctx.press(ctx.grip('weekday'), ' ');
    ctx.press(ctx.grip('weekday'), 'ArrowRight'); // onto hourly (1,26)
    await sleep(5);
    assert.equal(ctx.live(), 'Usage by weekday moved to column 2, row band 3. Displaced: Usage by hour.');
    ctx.press(ctx.grip('weekday'), ' ');
    await sleep(DEBOUNCE * 6);
    const saved = ctx.persisted.at(-1)!;
    const visible = saved.panels.filter((p) => !p.hidden);
    assert.equal(panel(saved, 'weekday').x, 1);
    for (const [i, a] of visible.entries()) {
      for (const b of visible.slice(i + 1)) {
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.equal(overlap, false, `${a.id} overlaps ${b.id}`);
      }
    }
    assert.equal(document.activeElement, ctx.grip('weekday'), 'focus follows the panel through gridstack\'s DOM re-sort');
  });

  it('resize mode changes the height tier and persists it on drop', async () => {
    ctx.press(ctx.grip('weekday'), ' ');
    ctx.press(ctx.grip('weekday'), 'r');
    ctx.press(ctx.grip('weekday'), 'ArrowDown');
    ctx.press(ctx.grip('weekday'), ' ');
    await sleep(DEBOUNCE * 6);
    assert.equal(panel(ctx.persisted.at(-1)!, 'weekday').h, 21);
  });

  it('hiding a panel does not persist the compaction it causes, showing it restores it, charts keep their node', async () => {
    const body = document.getElementById('chart-weekday')!;
    ctx.hideBtn('weekday').click();
    await sleep(DEBOUNCE * 6);
    assert.equal(panel(ctx.persisted.at(-1)!, 'weekday').hidden, true, 'the user hid it: saved');
    ctx.persisted.length = 0;
    ctx.grid.setNoData('hourly', true);
    ctx.grid.setNoData('hourly', false);
    await sleep(DEBOUNCE * 6);
    assert.equal(ctx.persisted.length, 0, 'data-driven removal and return save nothing');
    ctx.grid.show('weekday');
    assert.equal(document.getElementById('chart-weekday'), body, 'the chart body element (and so the chart instance) survived');
    assert.equal(ctx.item('weekday').hidden, false);
  });
});

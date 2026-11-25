import { strict as assert } from 'assert';
import { CHART_REGISTRY } from '../../../src/extension-frontend/charts/registry';
import { bodyPx, CELL_HEIGHT, COLUMNS, ENGINE_OPTIONS, MARGIN, MIN_ROWS, NARROW_BELOW_PX, TIER_NAMES, TIER_ROW_LIST } from '../../../src/extension-frontend/gridConstants';
import { sanitizeRects } from '../../../src/extension-frontend/gridEngine';
import { collectPanels, LAYOUT_HINT_ID, panelItemHtml } from '../../../src/extension-frontend/panels';
import { observeResize } from '../../../src/extension-frontend/resizeFrame';
import { describeCharts } from '../../../src/extension-frontend/srDescriptions';
import { makeEvent } from '../helpers';
import { buildSnapshot } from '../snapshotFixture';

function render() {
  document.body.innerHTML = `<div id="grid">${CHART_REGISTRY.map(panelItemHtml).join('')}</div>`;
  return document.getElementById('grid')!;
}

describe('panel markup (a gridstack widget per chart)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('is a labelled <section> that is the widget content, with a role=img body described by a hidden paragraph', () => {
    const root = render();
    for (const def of CHART_REGISTRY) {
      const item = root.querySelector(`[gs-id="${def.id}"]`)!;
      assert.ok(item.classList.contains('grid-stack-item'));
      const section = item.querySelector('section')!;
      assert.ok(section.classList.contains('grid-stack-item-content'), 'the section is the gridstack content element');
      assert.equal(section.getAttribute('aria-label'), def.title);
      assert.equal(section.dataset.panel, def.id);
      const body = section.querySelector<HTMLElement>(`#${def.bodyId}`)!;
      assert.equal(body.getAttribute('role'), 'img');
      assert.equal(body.getAttribute('aria-label'), def.ariaLabel);
      const desc = section.querySelector(`#desc-${def.bodyId}`)!;
      assert.equal(body.getAttribute('aria-describedby'), desc.id);
      assert.ok(desc.classList.contains('wv-sr-only'));
    }
  });

  it('has one description element for every key describeCharts() writes (so screen readers always get the numbers)', () => {
    render();
    const now = Date.now();
    const snapshot = buildSnapshot([makeEvent({ ts: now - 1000, credits: 10 })], {
      now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
      filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
    });
    const keys = Object.keys(describeCharts(snapshot));
    assert.equal(keys.length, CHART_REGISTRY.length, 'one description per chart');
    for (const bodyId of keys) assert.ok(document.getElementById(`desc-${bodyId}`), `desc-${bodyId}`);
  });

  it('gives the grip its keyboard contract: a button, roledescription, shortcuts, the hint, not pressed', () => {
    const root = render();
    const grip = root.querySelector<HTMLElement>('[data-panel="daily"] [data-act="move"]')!;
    assert.equal(grip.tagName, 'BUTTON');
    assert.equal(grip.getAttribute('type'), 'button');
    assert.equal(grip.getAttribute('aria-label'), 'Move Daily usage (last 30 days)');
    assert.equal(grip.getAttribute('aria-roledescription'), 'movable panel');
    assert.equal(grip.getAttribute('aria-keyshortcuts'), 'Space Enter');
    assert.equal(grip.getAttribute('aria-describedby'), LAYOUT_HINT_ID);
    assert.equal(grip.getAttribute('aria-pressed'), 'false');
    assert.equal(grip.hasAttribute('role'), false, 'no slider semantics: a real button with a roledescription');
    assert.equal(root.querySelectorAll('[role="slider"]').length, 0);
  });

  it('puts a labelled hide button and the grip inside the header (the pointer drag handle)', () => {
    const root = render();
    const header = root.querySelector('[data-panel="models"] .wv-panel-header')!;
    assert.ok(header.querySelector('.wv-chart-title'));
    assert.equal(header.querySelector('[data-act="hide"]')!.getAttribute('aria-label'), 'Hide By model');
    assert.ok(header.querySelector('.wv-panel-tools [data-act="move"]'));
    assert.equal(ENGINE_OPTIONS.handle, '.wv-panel-header');
    assert.equal(ENGINE_OPTIONS.dragCancel, '.wv-panel-hide', 'pressing the hide button does not start a drag');
    assert.ok(header.querySelector('.wv-panel-hide'));
    for (const i of header.querySelectorAll('i')) assert.equal(i.getAttribute('aria-hidden'), 'true');
  });

  it('escapes titles and labels', () => {
    document.body.innerHTML = panelItemHtml({ id: 'daily', icon: 'codicon-x', title: 'A <b>"x"</b> & y', bodyId: 'chart-x', ariaLabel: 'say "hi"' });
    const section = document.querySelector('section')!;
    assert.equal(section.getAttribute('aria-label'), 'A <b>"x"</b> & y');
    assert.equal(document.querySelector('b'), null);
    assert.equal(document.getElementById('chart-x')!.getAttribute('aria-label'), 'say "hi"');
  });

  it('collectPanels finds the rendered items and the titles by id', () => {
    const root = render();
    const { items, titles } = collectPanels(CHART_REGISTRY, root);
    assert.equal(Object.keys(items).length, CHART_REGISTRY.length);
    assert.equal(items['daily']!.getAttribute('gs-id'), 'daily');
    assert.equal(titles['hourly'], 'Usage by hour');
  });
});

describe('grid constants and engine input', () => {
  it('has the measured option set: 4 columns, 24 px rows, 6 px margins, 700 px breakpoint, no animation', () => {
    assert.deepEqual(
      { columns: ENGINE_OPTIONS.columns, narrow: ENGINE_OPTIONS.narrowBelowPx, cell: ENGINE_OPTIONS.cellHeight, margin: ENGINE_OPTIONS.margin, animate: ENGINE_OPTIONS.animate, minH: ENGINE_OPTIONS.minH },
      { columns: 4, narrow: 700, cell: 24, margin: 6, animate: false, minH: 7 },
    );
    assert.deepEqual([COLUMNS, NARROW_BELOW_PX, CELL_HEIGHT, MARGIN, MIN_ROWS], [4, 700, 24, 6, 7]);
  });

  it('maps the tiers to rows whose chart bodies match the old 120 / 260 / 455 px within 5 px', () => {
    assert.deepEqual([...TIER_NAMES], ['compact', 'normal', 'tall']);
    assert.deepEqual([...TIER_ROW_LIST], [7, 13, 21]);
    assert.deepEqual(TIER_ROW_LIST.map(bodyPx), [115, 259, 451]);
    for (const [px, want] of TIER_ROW_LIST.map((rows, i) => [bodyPx(rows), [120, 260, 455][i]!] as const)) assert.ok(Math.abs(px - want) <= 5);
  });
});

describe('sanitizeRects', () => {
  it('clamps onto the grid, rounds, dedupes and drops malformed entries', () => {
    const out = sanitizeRects(
      [
        { id: 'a', x: 3, y: -4, w: 9, h: 2 },
        { id: 'a', x: 0, y: 0, w: 1, h: 1 },
        { id: 'b', x: NaN, y: 1.6, w: 1, h: 99 },
        null as never,
        { id: 7 as never, x: 0, y: 0, w: 1, h: 7 },
      ],
      4,
      7,
    );
    assert.deepEqual(out, [
      { id: 'a', x: 0, y: 0, w: 4, h: 7 },
      { id: 'b', x: 0, y: 2, w: 1, h: 99 },
    ]);
  });
});

describe('observeResize', () => {
  type Entry = { contentRect: { width: number; height: number } };
  let callback: ((entries: Entry[]) => void) | undefined;
  let disconnected = 0;
  const g = globalThis as unknown as { ResizeObserver?: unknown };
  const original = g.ResizeObserver;
  beforeEach(() => {
    callback = undefined;
    disconnected = 0;
    g.ResizeObserver = class {
      constructor(cb: (entries: Entry[]) => void) {
        callback = cb;
      }
      observe() {}
      disconnect() {
        disconnected++;
      }
    };
  });
  afterEach(() => {
    if (original) g.ResizeObserver = original;
    else delete g.ResizeObserver;
  });
  const size = (width: number, height: number): Entry[] => [{ contentRect: { width, height } }];
  const frame = () => new Promise((r) => setTimeout(r, 5));

  it('calls back once per frame however many size changes arrive in it', async () => {
    let calls = 0;
    observeResize(document.createElement('div'), () => void calls++);
    callback!(size(100, 100));
    callback!(size(120, 100));
    callback!(size(140, 100));
    assert.equal(calls, 0, 'not synchronously');
    await frame();
    assert.equal(calls, 1);
  });

  it('skips an element with no size (a panel taken out of the grid)', async () => {
    let calls = 0;
    observeResize(document.createElement('div'), () => void calls++);
    callback!(size(0, 100));
    callback!(size(100, 0));
    await frame();
    assert.equal(calls, 0);
  });

  it('the returned function stops observing and cancels a frame that was already scheduled', async () => {
    let calls = 0;
    const stop = observeResize(document.createElement('div'), () => void calls++);
    callback!(size(100, 100));
    stop();
    assert.equal(disconnected, 1);
    await frame();
    assert.equal(calls, 0);
    observeResize(document.createElement('div'), () => void calls++)(); // stopping with nothing scheduled
    assert.equal(disconnected, 2);
  });
});

/**
 * The REAL gridstack adapter under the repo's jsdom setup. jsdom has no layout, so pointer drag and
 * resize cannot run here (Playwright covers them: test/webview), but init, widgets, update/save/load,
 * unregister/add, events and even breakpoint switching do. gridstack needs a ResizeObserver, which the
 * setup does not provide: a no-op stub is enough.
 */
import { strict as assert } from 'assert';
import type { GridStack } from 'gridstack';
import { ENGINE_OPTIONS } from '../../../src/extension-frontend/gridConstants';
import { GridstackEngine } from '../../../src/extension-frontend/gridstackEngine';
import type { PanelRect } from '../../../src/extension-frontend/gridEngine';

const g = globalThis as unknown as { ResizeObserver?: unknown };
const gridOf = (root: HTMLElement): GridStack => (root as unknown as { gridstack: GridStack }).gridstack;
const setWidth = (px: number): void => void Object.defineProperty(window, 'innerWidth', { value: px, configurable: true });
const r = (id: string, x: number, y: number, w: number, h: number): PanelRect => ({ id, x, y, w, h });

function item(root: HTMLElement, id: string): HTMLElement {
  const d = document.createElement('div');
  d.className = 'grid-stack-item';
  d.setAttribute('gs-id', id);
  d.innerHTML = '<div class="grid-stack-item-content"><button class="grip">g</button></div>';
  root.appendChild(d);
  return d;
}

function build(opts = ENGINE_OPTIONS) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const engine = new GridstackEngine();
  engine.mount(root, opts);
  const els = { a: item(root, 'a'), b: item(root, 'b'), c: item(root, 'c') };
  engine.registerAll([
    { id: 'a', el: els.a, rect: r('a', 0, 0, 2, 7) },
    { id: 'b', el: els.b, rect: r('b', 2, 0, 2, 13) },
    { id: 'c', el: els.c, rect: r('c', 0, 13, 4, 7) },
  ]);
  return { engine, root, els };
}

describe('GridstackEngine (the gridstack adapter, in jsdom)', () => {
  let ctx: ReturnType<typeof build>;
  let stubbed = false;
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
    setWidth(1024);
    ctx = build();
  });
  afterEach(() => {
    try {
      ctx.engine.destroy();
    } catch {
      /* already destroyed */
    }
    ctx.root.remove();
    setWidth(1024);
  });

  it('mounts a static 4-column grid and adopts the existing nodes instead of creating widgets', () => {
    assert.equal(ctx.engine.columns(), 4);
    assert.equal(ctx.engine.isStatic(), true);
    assert.equal(ctx.root.querySelectorAll('.grid-stack-item').length, 3);
    assert.deepEqual(ctx.engine.save().map((p) => p.id).sort(), ['a', 'b', 'c']);
    assert.ok([...ctx.root.querySelectorAll('.grid-stack-item')].every((el) => !el.hasAttribute('hidden')));
  });

  it('save() resolves the defaults gridstack omits (h equal to minH is dropped by grid.save())', () => {
    assert.deepEqual(ctx.engine.rect('a'), r('a', 0, 0, 2, 7), 'h:7 === minH is absent in the raw save');
    assert.deepEqual(ctx.engine.save().find((p) => p.id === 'a'), r('a', 0, 0, 2, 7));
  });

  it('registerAll sanitises oversize rects (gridstack would keep them unclamped)', () => {
    const e = new GridstackEngine();
    const root = document.createElement('div');
    document.body.appendChild(root);
    e.mount(root, ENGINE_OPTIONS);
    e.registerAll([{ id: 'x', el: item(root, 'x'), rect: r('x', 9, 0, 99, 1) }]);
    assert.deepEqual(e.rect('x'), r('x', 0, 0, 4, 7));
    e.destroy();
    root.remove();
  });

  it('update() returns the rect that resulted after collisions; an unknown id gives null', () => {
    ctx.engine.setStatic(false);
    assert.deepEqual(ctx.engine.update('a', { w: 3 }), r('a', 0, 0, 3, 7));
    assert.ok(ctx.engine.rect('b')!.y > 0, 'the overlapped panel is pushed down by collision, not swapped');
    assert.equal(ctx.engine.update('nope', { w: 3 }), null);
    assert.equal(ctx.engine.rect('nope'), null);
  });

  it('keeps DOM (= tab) order equal to visual row-major order after a move', () => {
    ctx.engine.setStatic(false);
    ctx.engine.update('c', { y: 0, x: 0, w: 4 });
    const order = [...ctx.root.children].map((el) => el.getAttribute('gs-id'));
    const visual = ctx.engine.save().map((p) => p.id);
    assert.deepEqual(order, visual);
  });

  it('unregister() hides the node but keeps it and its children; add() brings it back', () => {
    const rect = ctx.engine.unregister('b');
    assert.deepEqual(rect, r('b', 2, 0, 2, 13));
    assert.equal(ctx.engine.isRegistered('b'), false);
    assert.equal(ctx.els.b.isConnected, true, 'the node (and so its chart instance) survives');
    assert.equal(ctx.els.b.hidden, true);
    assert.deepEqual(ctx.engine.save().map((p) => p.id).sort(), ['a', 'c']);
    assert.equal(ctx.engine.unregister('b'), null, 'a second unregister has nothing to remove');
    assert.equal(ctx.engine.unregister('nope'), null);

    ctx.engine.add('b', ctx.els.b, r('b', 2, 0, 2, 13));
    assert.equal(ctx.engine.isRegistered('b'), true);
    assert.equal(ctx.els.b.hidden, false);
    assert.deepEqual(ctx.engine.rect('b'), r('b', 2, 0, 2, 13));
    assert.equal(ctx.engine.save().length, 3);
  });

  it('add() takes a node that was never registered (a panel hidden at startup) and sanitises its rect', () => {
    const late = item(ctx.root, 'late');
    late.hidden = true;
    ctx.engine.add('late', late, r('late', 3, 40, 9, 2));
    assert.equal(late.hidden, false);
    assert.deepEqual(ctx.engine.rect('late'), r('late', 0, 40, 4, 7));
  });

  it('load() sanitises, ignores unknown ids and unregistered panels, and creates no widget for them', () => {
    ctx.engine.unregister('c');
    ctx.engine.load([r('a', 9, 0, 99, 1), r('ghost', 0, 0, 1, 1), r('c', 0, 0, 1, 7)]);
    const a = ctx.engine.rect('a')!;
    assert.deepEqual([a.x, a.w, a.h], [0, 4, 7], 'clamped: x:9,w:99 -> x0,w4; h:1 -> minH');
    assert.equal(ctx.root.querySelectorAll('.grid-stack-item').length, 3, 'no ghost widget');
    assert.equal(ctx.engine.isRegistered('c'), false, 'a listed-but-unregistered panel stays out');
    assert.ok(ctx.engine.rect('b'), 'a panel missing from the list stays put');
  });

  it('onChange fires with the rects, column and ignorable flag for a programmatic update, and can be unsubscribed', () => {
    ctx.engine.setStatic(false);
    assert.equal(ctx.engine.isStatic(), false);
    const seen: Array<{ n: number; column: number; ignorable: boolean }> = [];
    const off = ctx.engine.onChange((i) => seen.push({ n: i.rects.length, column: i.column, ignorable: i.ignorable }));
    ctx.engine.update('a', { w: 1 });
    off();
    ctx.engine.update('a', { w: 2 });
    assert.deepEqual(seen, [{ n: 3, column: 4, ignorable: false }]);
  });

  it('does not emit change for registerAll, add, unregister or load (the controller relies on that)', () => {
    let n = 0;
    ctx.engine.onChange(() => n++);
    ctx.engine.unregister('b');
    ctx.engine.add('b', ctx.els.b, r('b', 2, 0, 2, 13));
    ctx.engine.load([r('a', 1, 0, 1, 7)]);
    assert.equal(n, 0);
  });

  it('switches to one column below 700 px, reports it, and restores the wide layout exactly on the way back', () => {
    const seen: number[] = [];
    const off = ctx.engine.onColumnChange((c) => seen.push(c));
    const before = ctx.engine.save();
    setWidth(500);
    gridOf(ctx.root).onResize(500, 400);
    assert.equal(ctx.engine.columns(), 1);
    setWidth(1024);
    gridOf(ctx.root).onResize(1024, 400);
    off();
    assert.deepEqual(seen, [1, 4]);
    assert.deepEqual(ctx.engine.save(), before, 'moveScale returns every panel to its wide rect');
  });

  it('a layout registered while the window is ALREADY narrow is cached as the wide layout', () => {
    setWidth(500);
    const root = document.createElement('div');
    document.body.appendChild(root);
    const e = new GridstackEngine();
    e.mount(root, ENGINE_OPTIONS);
    assert.equal(e.columns(), 1);
    e.registerAll([
      { id: 'a', el: item(root, 'a'), rect: r('a', 0, 0, 2, 7) },
      { id: 'b', el: item(root, 'b'), rect: r('b', 2, 0, 2, 7) },
    ]);
    setWidth(1024);
    gridOf(root).onResize(1024, 400);
    assert.deepEqual(e.save().map((p) => `${p.id}:${p.x},${p.y},${p.w}x${p.h}`).sort(), ['a:0,0,2x7', 'b:2,0,2x7']);
    e.destroy();
    root.remove();
  });

  it('destroy() leaves the panel DOM alone and drops the callbacks', () => {
    ctx.engine.onChange(() => assert.fail('no change after destroy'));
    ctx.engine.destroy();
    assert.equal(ctx.root.querySelectorAll('.grid-stack-item').length, 3);
    assert.throws(() => ctx.engine.save(), /not mounted/);
  });

  it('an engine that was never mounted fails with a clear message', () => {
    assert.throws(() => new GridstackEngine().save(), /not mounted/);
    assert.throws(() => new GridstackEngine().columns(), /not mounted/);
  });
});

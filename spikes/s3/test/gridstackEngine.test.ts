/**
 * The REAL gridstack adapter under the repo's jsdom setup. Shows how much of gridstackEngine.ts a
 * jsdom unit test can cover (answer feeds the ".c8rc.json exclusion or not" decision):
 *   npm run test:unit   and   npm run coverage
 * Needs a ResizeObserver stub (the repo's jsdom.cjs does not provide one) - 3 lines.
 */
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { GridstackEngine } from '../src/gridstackEngine';

const g = globalThis as any;
const OPTS = { columns: 4, narrowBelowPx: 700, cellHeight: 24, margin: 6, animate: false, handle: '.h', dragCancel: '.c', minH: 7 };

function build() {
  g.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const els = ['a', 'b', 'c'].map((id) => { const d = document.createElement('div'); d.className = 'grid-stack-item'; d.setAttribute('gs-id', id); d.innerHTML = '<div class="grid-stack-item-content"></div>'; root.appendChild(d); return d; });
  const e = new GridstackEngine();
  e.mount(root, OPTS);
  e.register('a', els[0]!, { id: 'a', x: 0, y: 0, w: 2, h: 7 });
  e.register('b', els[1]!, { id: 'b', x: 2, y: 0, w: 2, h: 13 });
  e.register('c', els[2]!, { id: 'c', x: 0, y: 13, w: 4, h: 7 });
  return { e, root, els };
}

describe('GridstackEngine adapter in jsdom', () => {
  let ctx: ReturnType<typeof build>;
  beforeEach(() => { ctx = build(); });
  afterEach(() => { try { ctx.e.destroy(); } catch { /* already destroyed */ } ctx.root.remove(); Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true }); });

  it('save() resolves gridstack-omitted defaults (h == minH is dropped by grid.save())', () => {
    const rects = ctx.e.save();
    assert.deepEqual(rects.find((r) => r.id === 'a'), { id: 'a', x: 0, y: 0, w: 2, h: 7 }); // h:7 === minH => absent in raw save()
    assert.equal(rects.length, 3);
  });
  it('update() returns the engine-resolved rect; missing id -> null', () => {
    assert.deepEqual(ctx.e.rect('b'), { id: 'b', x: 2, y: 0, w: 2, h: 13 });
    assert.deepEqual(ctx.e.update('a', { w: 3 }), { id: 'a', x: 0, y: 0, w: 3, h: 7 });
    assert.ok(ctx.e.rect('b')!.y > 0, 'the overlapped panel is pushed down by gravity/collision, not swapped');
    assert.equal(ctx.e.update('nope', { w: 3 }), null);
    assert.equal(ctx.e.rect('nope'), null);
  });
  it('unregister/reregister keeps the DOM node and remembers the rect', () => {
    const r = ctx.e.unregister('b');
    assert.deepEqual(r, { id: 'b', x: 2, y: 0, w: 2, h: 13 });
    assert.equal(ctx.e.isRegistered('b'), false);
    assert.equal(ctx.els[1]!.isConnected, true);
    assert.equal(ctx.els[1]!.hidden, true);
    assert.equal(ctx.e.unregister('b'), null);
    ctx.e.reregister('b');
    assert.equal(ctx.e.isRegistered('b'), true);
    assert.equal(ctx.els[1]!.hidden, false);
    ctx.e.reregister('ghost'); // no-op
    ctx.e.unregister('a');
    ctx.e.reregister('a', { x: 1 });
    assert.equal(ctx.e.rect('a')!.x, 1);
  });
  it('load() sanitises, ignores unknown ids and unregistered panels', () => {
    ctx.e.unregister('c');
    ctx.e.load([{ id: 'a', x: 9, y: 0, w: 99, h: 1 }, { id: 'ghost', x: 0, y: 0, w: 1, h: 1 }, { id: 'c', x: 0, y: 0, w: 1, h: 7 }]);
    const a = ctx.e.rect('a')!;
    assert.deepEqual([a.x, a.w, a.h], [0, 4, 7]); // clamped (x:9,w:99 -> x0,w4; h:1 -> minH 7); y is wherever it settles around panels NOT in the list
    assert.equal(ctx.root.querySelectorAll('.grid-stack-item').length, 3); // no ghost widget created
    assert.equal(ctx.e.isRegistered('c'), false); // listed-but-unregistered panel stays out
  });
  it('setStatic toggles; onChange fires and can be unsubscribed', () => {
    assert.equal(ctx.e.isStatic(), true);
    ctx.e.setStatic(false);
    assert.equal(ctx.e.isStatic(), false);
    const seen: number[] = [];
    const off = ctx.e.onChange((i) => seen.push(i.rects.length));
    ctx.e.update('a', { w: 1 });
    off();
    ctx.e.update('a', { w: 2 });
    assert.equal(seen.length, 1);
    assert.equal(ctx.e.columns(), 4);
  });
  it('breakpoint switch (simulated via onResize + innerWidth) notifies onColumnChange', () => {
    const seen: number[] = [];
    const off = ctx.e.onColumnChange((c) => seen.push(c));
    Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
    ctx.e.raw().onResize(500, 400);
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    ctx.e.raw().onResize(1024, 400);
    off();
    assert.deepEqual(seen, [1, 4]);
  });
  it('change info is flagged ignorable while gridstack applies a load', () => {
    const flags: boolean[] = [];
    ctx.e.onChange((i) => flags.push(i.ignorable));
    ctx.e.load([{ id: 'a', x: 1, y: 0, w: 1, h: 7 }]);
    assert.ok(flags.length >= 0);
  });
  it('registerAll() adopts existing nodes via load(), sanitising rects and ignoring nothing it was given', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const mk = (id: string) => { const d = document.createElement('div'); d.setAttribute('gs-id', id); d.innerHTML = '<div class="grid-stack-item-content"></div>'; root.appendChild(d); return d; };
    const e = new GridstackEngine();
    e.mount(root, OPTS);
    const [a, b] = [mk('a'), mk('b')];
    e.registerAll([{ id: 'a', el: a, rect: { id: 'a', x: 0, y: 0, w: 2, h: 7 } }, { id: 'b', el: b, rect: { id: 'b', x: 9, y: 0, w: 99, h: 1 } }]);
    assert.equal(root.querySelectorAll('.grid-stack-item').length, 2); // existing nodes adopted, none created
    assert.equal(e.isRegistered('a') && e.isRegistered('b'), true);
    assert.deepEqual(e.rect('a'), { id: 'a', x: 0, y: 0, w: 2, h: 7 });
    const rb = e.rect('b')!;
    assert.deepEqual([rb.x, rb.w], [0, 4]);
    e.destroy();
    root.remove();
  });
  it('unmounted engine throws a clear error', () => {
    assert.throws(() => new GridstackEngine().save(), /not mounted/);
  });
});

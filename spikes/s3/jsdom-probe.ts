/**
 * S3 section 6: does gridstack 14.1.1 run under the repo's jsdom setup (test/unit/setup/jsdom.cjs,
 * jsdom 29.1.1) and what breaks?   npm run jsdom
 * The setup file is preloaded with --require, so `window`, `document`, `matchMedia`, ... are the
 * repo's own globals (notably: NO ResizeObserver, NO IntersectionObserver, NO MouseEvent global).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
const rows: Array<{ step: string; ok: boolean; detail?: string }> = [];
function step(name: string, fn: () => unknown): any {
  try {
    const v = fn();
    rows.push({ step: name, ok: true, detail: typeof v === 'string' ? v : undefined });
    return v;
  } catch (e) {
    rows.push({ step: name, ok: false, detail: String((e as Error).message ?? e).split('\n')[0] });
    return undefined;
  }
}

const g = globalThis as any;
const globalsMissing = ['ResizeObserver', 'IntersectionObserver', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'TouchEvent'].filter((k) => typeof g[k] === 'undefined');
console.log('repo jsdom setup is missing globals:', globalsMissing.join(', '));

const { GridStack } = step('import gridstack (ESM-in-CJS through tsx/cjs)', () => require('gridstack')) ?? {};
if (!GridStack) { console.table(rows); process.exit(1); }
const { GridstackEngine } = require('./src/gridstackEngine');

function host(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}
const mkItems = (grid: HTMLElement) => ['a', 'b', 'c'].map((id) => { const d = document.createElement('div'); d.className = 'grid-stack-item'; d.innerHTML = '<div class="grid-stack-item-content">x</div>'; d.setAttribute('gs-id', id); grid.appendChild(d); return d; });

// 1. bare init (no responsive options -> no ResizeObserver needed)
let grid: any;
step('GridStack.init({column:4, cellHeight:24}) without ResizeObserver need', () => { grid = GridStack.init({ column: 4, cellHeight: 24, margin: 6, auto: false, staticGrid: true }, host()); return 'ok'; });
// 2. responsive options need ResizeObserver
step('GridStack.init with columnOpts.breakpoints (ResizeObserver absent in repo setup)', () => GridStack.init({ column: 4, columnOpts: { breakpoints: [{ w: 700, c: 1 }], breakpointForWindow: true } }, host()));
// 3. same, with a stub ResizeObserver
g.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
let rgrid: any;
step('same, with a 3-line ResizeObserver stub', () => { rgrid = GridStack.init({ column: 4, cellHeight: 24, auto: false, columnOpts: { breakpoints: [{ w: 700, c: 1 }], breakpointForWindow: true, columnMax: 4, layout: 'moveScale' } }, host()); return 'ok'; });
// 4. engine ops (pure data-structure logic, no layout needed)
const els = mkItems(rgrid.el);
step('makeWidget x3 + update + save', () => {
  rgrid.makeWidget(els[0], { id: 'a', x: 0, y: 0, w: 2, h: 7 });
  rgrid.makeWidget(els[1], { id: 'b', x: 2, y: 0, w: 2, h: 13 });
  rgrid.makeWidget(els[2], { id: 'c', x: 0, y: 7, w: 4, h: 7 });
  rgrid.update(els[2], { y: 13 });
  return JSON.stringify(rgrid.save(false).map((n: any) => `${n.id}:${n.x},${n.y}`));
});
step('writes --gs-x/--gs-w custom properties onto the element', () => { const v = els[1]!.style.getPropertyValue('--gs-x'); if (v !== '2') throw new Error(`--gs-x=${JSON.stringify(v)}`); return `--gs-x=${v}`; });
step('removeWidget(el,false) + makeWidget(el) re-add', () => { rgrid.removeWidget(els[0], false); const n = rgrid.engine.nodes.length; rgrid.makeWidget(els[0], { id: 'a', x: 0, y: 0, w: 2, h: 7 }); return `nodes ${n} -> ${rgrid.engine.nodes.length}`; });
step('load() with addRemove=false', () => { rgrid.load([{ id: 'a', x: 1, y: 0, w: 1, h: 7 }], false); return JSON.stringify(rgrid.engine.nodes.find((n: any) => n.id === 'a') && { x: els[0]!.gridstackNode.x }); });
step('setStatic(false) wires drag/resize (DD handlers)', () => { rgrid.setStatic(false); return `handles in DOM: ${rgrid.el.querySelectorAll('.ui-resizable-handle').length}`; });
step('grid.on("change") fires after update()', () => { let n = 0; rgrid.on('change', () => n++); rgrid.update(els[1], { w: 1 }); if (!n) throw new Error('no change event'); return `${n} event(s)`; });
// 5. breakpoint switching, simulated without layout
step('breakpoint switch simulated: window.innerWidth=500 + grid.onResize(500)', () => {
  Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
  const before = rgrid.getColumn();
  rgrid.onResize(500, 400);
  return `columns ${before} -> ${rgrid.getColumn()}`;
});
step('... and back to wide restores the cached layout', () => {
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  rgrid.onResize(1024, 400);
  return `columns -> ${rgrid.getColumn()}`;
});
// 6. pointer drag
step('mouse drag: dispatch mousedown/mousemove/mouseup (does not throw, but is INERT)', () => {
  const header = els[1]!;
  const MouseEventCtor = (window as any).MouseEvent;
  header.dispatchEvent(new MouseEventCtor('mousedown', { bubbles: true, clientX: 10, clientY: 10, button: 0 }));
  document.dispatchEvent(new MouseEventCtor('mousemove', { bubbles: true, clientX: 200, clientY: 200 }));
  document.dispatchEvent(new MouseEventCtor('mouseup', { bubbles: true, clientX: 200, clientY: 200 }));
  return `b now at ${els[1]!.gridstackNode.x},${els[1]!.gridstackNode.y} (jsdom has no layout: getBoundingClientRect() is all zeros so cell math cannot move anything)`;
});
step('getBoundingClientRect()/clientWidth are 0 (layout-dependent features are inert)', () => `rect.width=${rgrid.el.getBoundingClientRect().width} clientWidth=${rgrid.el.clientWidth}`);
step('destroy(false)', () => { rgrid.destroy(false); return 'ok'; });

// 7. our real adapter in jsdom
step('GridstackEngine adapter: mount/register/update/save/load/unregister/reregister/setStatic/destroy', () => {
  const e = new GridstackEngine();
  const root = host();
  const items = mkItems(root);
  e.mount(root, { columns: 4, narrowBelowPx: 700, cellHeight: 24, margin: 6, animate: false, handle: '.x', dragCancel: '.y', minH: 7 });
  items.forEach((el, i) => e.register(['a', 'b', 'c'][i], el, { id: ['a', 'b', 'c'][i], x: i === 2 ? 0 : i * 2, y: i === 2 ? 7 : 0, w: 2, h: 7 }));
  const out: string[] = [];
  out.push(JSON.stringify(e.update('a', { w: 3 })));
  out.push('save=' + e.save().map((r: any) => `${r.id}:${r.x},${r.y},${r.w}x${r.h}`).join(' '));
  e.unregister('b'); out.push('unregister->' + e.save().length);
  e.reregister('b'); out.push('reregister->' + e.save().length);
  e.load([{ id: 'a', x: 0, y: 0, w: 99, h: 1 }, { id: 'ghost', x: 0, y: 0, w: 1, h: 1 }]);
  out.push('load-sanitised a=' + JSON.stringify(e.rect('a')));
  e.setStatic(false); out.push('static=' + e.isStatic());
  let cols = 0; e.onColumnChange((c: number) => { cols = c; });
  Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
  e.raw().onResize(500, 400);
  e.destroy();
  Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
  return out.join(' | ') + ' | colCb=' + cols;
});

console.table(rows.map((r) => ({ step: r.step, ok: r.ok ? 'OK' : 'THROWS', detail: r.detail })));

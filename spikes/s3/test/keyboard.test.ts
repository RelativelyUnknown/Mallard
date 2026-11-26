/**
 * Unit test of the keyboard layer against FakeEngine, run under the REPO's jsdom setup
 * (test/unit/setup/jsdom.cjs) with node:test, to prove the adapter-interface approach is testable
 * without gridstack:   npm run test:unit
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { FakeEngine } from '../src/fakeEngine';
import { attachKeyboardLayer, nearestTier, nextMove, rowBand } from '../src/keyboard';
import { sanitizeRects } from '../src/gridEngine';

const TIER_ROWS = [7, 13, 21] as const;
const TIER_NAMES = ['compact', 'normal', 'tall'] as const;

function setup() {
  document.body.innerHTML = `
    <div id="grid">
      <section data-panel="a"><div class="wv-panel-header"><span data-act="move" tabindex="0"></span><span role="slider" data-axis="w" tabindex="0"></span><span role="slider" data-axis="h" tabindex="0"></span></div></section>
      <section data-panel="b"><div class="wv-panel-header"><span data-act="move" tabindex="0"></span></div></section>
    </div>`;
  const engine = new FakeEngine();
  engine.register('a', document.createElement('div'), { id: 'a', x: 0, y: 0, w: 2, h: 7 });
  engine.register('b', document.createElement('div'), { id: 'b', x: 2, y: 0, w: 2, h: 13 });
  engine.setStatic(false);
  const said: string[] = [];
  const handled: string[] = [];
  const root = document.getElementById('grid')!;
  const off = attachKeyboardLayer(root, engine, { tierRows: TIER_ROWS, tierNames: TIER_NAMES, titleOf: (id) => id.toUpperCase(), announce: (m) => said.push(m), onHandled: (i) => handled.push(`${i.kind}:${i.id}`) });
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  return { engine, said, handled, root, off, press, q: (s: string) => document.querySelector<HTMLElement>(s)! };
}

describe('keyboard layer over GridEngine (FakeEngine)', () => {
  it('Alt+ArrowRight moves one column, announces the result, preventDefaults', () => {
    const { engine, said, press, q } = setup();
    const e = press(q('[data-panel="a"] [data-act="move"]'), 'ArrowRight', { altKey: true });
    assert.equal(e.defaultPrevented, true);
    assert.deepEqual(engine.rect('a'), { id: 'a', x: 1, y: 0, w: 2, h: 7 });
    assert.match(said.at(-1)!, /A moved to column 2, row 1\./);
  });
  it('is inert in static (view) mode and for modified keys', () => {
    const { engine, press, q, said } = setup();
    engine.setStatic(true);
    press(q('[data-panel="a"] [data-act="move"]'), 'ArrowRight', { altKey: true });
    engine.setStatic(false);
    press(q('[data-panel="a"] [data-act="move"]'), 'ArrowRight', { altKey: true, ctrlKey: true });
    assert.equal(engine.rect('a')!.x, 0);
    assert.equal(said.length, 0);
  });
  it('plain arrows on the width slider resize and sync aria-value*', () => {
    const { engine, press, q, said } = setup();
    const s = q('[data-panel="a"] [data-axis="w"]');
    press(s, 'ArrowRight');
    assert.equal(engine.rect('a')!.w, 3);
    assert.equal(s.getAttribute('aria-valuenow'), '3');
    assert.equal(s.getAttribute('aria-valuetext'), '3 of 4 columns');
    press(s, 'ArrowRight'); // x:0,w:3 -> 4
    press(s, 'ArrowRight'); // clamped
    assert.match(said.at(-1)!, /maximum width/);
  });
  it('height slider steps through tiers', () => {
    const { engine, press, q } = setup();
    const s = q('[data-panel="a"] [data-axis="h"]');
    press(s, 'ArrowUp');
    assert.equal(engine.rect('a')!.h, 13);
    press(s, 'ArrowUp');
    assert.equal(engine.rect('a')!.h, 21);
    press(s, 'ArrowDown');
    assert.equal(engine.rect('a')!.h, 13);
  });
  it('re-asserts focus when the engine update dropped it (the no-moveBefore case)', () => {
    const { engine, press, q } = setup();
    const grip = q('[data-panel="a"] [data-act="move"]');
    grip.focus();
    const orig = engine.update.bind(engine);
    engine.update = (id, patch) => { (document.activeElement as HTMLElement | null)?.blur(); return orig(id, patch); };
    press(grip, 'ArrowRight', { altKey: true });
    assert.equal(document.activeElement, grip);
  });
  it('pure helpers: nextMove jumps over neighbours, rowBand ranks y, nearestTier', () => {
    const all = [{ id: 'a', x: 0, y: 0, w: 2, h: 7 }, { id: 'b', x: 0, y: 7, w: 2, h: 13 }];
    assert.deepEqual(nextMove(all[0]!, all, 0, 1, 4), { y: 20 });
    assert.equal(nextMove(all[0]!, all, 0, -1, 4), null);
    assert.equal(nextMove(all[0]!, all, -1, 0, 4), null);
    assert.equal(rowBand(all[1]!, all), 2);
    assert.equal(nearestTier(12, TIER_ROWS), 1);
  });
  it('sanitizeRects clamps, rounds, dedupes (pure)', () => {
    const out = sanitizeRects([{ id: 'a', x: 3, y: -4, w: 9, h: 2 }, { id: 'a', x: 0, y: 0, w: 1, h: 1 }, { id: 'b', x: NaN as any, y: 1.6 as any, w: 1, h: 99 }], 4, 7);
    assert.deepEqual(out, [{ id: 'a', x: 0, y: 0, w: 4, h: 7 }, { id: 'b', x: 0, y: 2, w: 1, h: 99 }]);
  });
});

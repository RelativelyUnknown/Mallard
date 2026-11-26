import { strict as assert } from 'assert';
import { attachLiftKeyboard, nearestTier, nextMove, restoreFocus, rowBand } from '../../../src/extension-frontend/keyboard';
import type { LiftController } from '../../../src/extension-frontend/keyboard';
import { panelItemHtml } from '../../../src/extension-frontend/panels';
import { ENGINE_OPTIONS, TIER_NAMES, TIER_ROW_LIST } from '../../../src/extension-frontend/gridConstants';
import type { PanelRect } from '../../../src/extension-frontend/gridEngine';
import { FakeEngine } from './fakeEngine';

const def = (id: 'daily' | 'heatmap' | 'models', title: string) =>
  panelItemHtml({ id, icon: 'codicon-x', title, bodyId: `chart-${id}`, ariaLabel: `${title} chart` });
const r = (id: string, x: number, y: number, w: number, h: number): PanelRect => ({ id, x, y, w, h });

/** Three panels in a 4-column grid: A (0,0 2x7) and B (2,0 2x13) side by side, C (0,13 4x7) below. */
function setup(engineClass: new () => FakeEngine = FakeEngine) {
  document.body.innerHTML = `<div id="grid">${def('daily', 'Alpha')}${def('heatmap', 'Beta')}${def('models', 'Gamma')}</div>`;
  const root = document.getElementById('grid')!;
  const engine = new engineClass();
  engine.mount(root, ENGINE_OPTIONS);
  const rects = { daily: r('daily', 0, 0, 2, 7), heatmap: r('heatmap', 2, 0, 2, 13), models: r('models', 0, 13, 4, 7) };
  engine.registerAll(
    Object.entries(rects).map(([id, rect]) => ({ id, el: root.querySelector<HTMLElement>(`[gs-id="${id}"]`)!, rect })),
  );
  engine.setStatic(false);
  const said: string[] = [];
  const ends: string[] = [];
  let starts = 0;
  const titles: Record<string, string> = { daily: 'Alpha', heatmap: 'Beta', models: 'Gamma', extra: 'Delta' };
  const lift: LiftController = attachLiftKeyboard(root, engine, {
    tierRows: TIER_ROW_LIST,
    tierNames: TIER_NAMES,
    titleOf: (id) => titles[id]!,
    announce: (m) => said.push(m),
    onStart: () => void starts++,
    onEnd: (result, id) => void ends.push(`${result}:${id}`),
  });
  const grip = (id: string) => root.querySelector<HTMLElement>(`[data-panel="${id}"] [data-act="move"]`)!;
  const press = (target: Element, key: string, init: KeyboardEventInit = {}) => {
    const e = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(e);
    return e;
  };
  return { root, engine, lift, said, ends, starts: () => starts, grip, press };
}

describe('keyboard lift mode', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('lifting', () => {
    it('Space lifts the focused panel and announces where it is and what the keys do', () => {
      const { engine, said, grip, press, lift, root } = setup();
      grip('daily').focus();
      const e = press(grip('daily'), ' ');

      assert.equal(e.defaultPrevented, true);
      assert.equal(lift.isLifted(), true);
      assert.equal(grip('daily').getAttribute('aria-pressed'), 'true');
      const panel = root.querySelector<HTMLElement>('[data-panel="daily"]')!;
      assert.equal(panel.classList.contains('wv-lifted'), true);
      assert.equal(panel.dataset.liftMode, 'move');
      assert.deepEqual(said, ['Alpha lifted. Column 1, row band 1. Use arrow keys to move, R to resize, Space to drop, Escape to cancel.']);
      assert.deepEqual(engine.rect('daily'), r('daily', 0, 0, 2, 7), 'lifting alone moves nothing');
    });

    it('Enter lifts too, and reports the column and row band of a panel that is not top-left', () => {
      const { said, grip, press } = setup();
      press(grip('models'), 'Enter');
      assert.match(said[0]!, /^Gamma lifted\. Column 1, row band 2\./);
      assert.equal(said.length, 1);
    });

    it('reports the ordinal row band, never a raw row number', () => {
      const { said, grip, press, engine } = setup();
      engine.dragTo('models', { y: 40 });
      press(grip('models'), ' ');
      assert.match(said[0]!, /row band 2\./);
      assert.doesNotMatch(said[0]!, /40/);
    });

    it('is inert in view (static) mode, with modifier keys, and on anything but a grip', () => {
      const { engine, said, grip, press, root, lift } = setup();
      engine.setStatic(true);
      assert.equal(press(grip('daily'), ' ').defaultPrevented, false);
      engine.setStatic(false);
      for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) press(grip('daily'), ' ', init);
      press(root.querySelector('[data-act="hide"]')!, ' ');
      press(root.querySelector('[data-panel="daily"] .wv-panel-header')!, 'Enter');
      press(grip('daily'), 'ArrowRight'); // not lifted: an arrow does nothing
      press(grip('daily'), 'a');
      assert.equal(lift.isLifted(), false);
      assert.deepEqual(said, []);
      assert.deepEqual(engine.rect('daily'), r('daily', 0, 0, 2, 7));
    });

    it('does not lift a panel the engine does not track (parked: hidden or no data)', () => {
      const { engine, said, grip, press, lift } = setup();
      engine.unregister('heatmap');
      press(grip('heatmap'), ' ');
      assert.equal(lift.isLifted(), false);
      assert.deepEqual(said, []);
    });

    it('lets Space keyup on a grip through preventDefault (some engines activate a button on keyup)', () => {
      const { grip } = setup();
      const up = new window.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
      grip('daily').dispatchEvent(up);
      assert.equal(up.defaultPrevented, true);
      const other = new window.KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true });
      document.getElementById('grid')!.dispatchEvent(other);
      assert.equal(other.defaultPrevented, false);
      const arrow = new window.KeyboardEvent('keyup', { key: 'ArrowUp', bubbles: true, cancelable: true });
      grip('daily').dispatchEvent(arrow);
      assert.equal(arrow.defaultPrevented, false);
    });
  });

  describe('moving', () => {
    it('an arrow moves the lifted panel one column and announces the resulting position', () => {
      const { engine, said, grip, press } = setup();
      press(grip('daily'), ' ');
      const e = press(grip('daily'), 'ArrowRight');
      assert.equal(e.defaultPrevented, true);
      assert.deepEqual(engine.rect('daily'), r('daily', 1, 0, 2, 7));
      assert.equal(said.at(-1), 'Alpha moved to column 2, row band 1.');
      press(grip('daily'), 'ArrowLeft');
      assert.equal(said.at(-1), 'Alpha moved to column 1, row band 1.');
    });

    it('says so when a move is not possible (edge of the grid, nothing above or below)', () => {
      const { said, grip, press, engine } = setup();
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowLeft');
      assert.equal(said.at(-1), 'Alpha cannot move further left.');
      press(grip('daily'), 'ArrowUp');
      assert.equal(said.at(-1), 'Alpha cannot move further up.');
      press(grip('models'), 'x');
      press(grip('daily'), 'ArrowDown'); // heatmap does not overlap in x... models below does
      assert.match(said.at(-1)!, /Alpha moved to column 1, row band 3\./);
      press(grip('daily'), 'ArrowDown');
      assert.equal(said.at(-1), 'Alpha cannot move further down.');
      assert.deepEqual(engine.rect('daily')!.y, 20);
    });

    it('a vertical move jumps just past the neighbour (a bare y+1 would be undone by gravity)', () => {
      const { engine, grip, press } = setup();
      press(grip('models'), ' ');
      press(grip('models'), 'ArrowUp');
      assert.equal(engine.rect('models')!.y, 0, 'onto the top neighbour that overlaps it in x');
    });

    it('reports an engine that refused the move (gravity put it back) as "cannot move"', () => {
      class Sticky extends FakeEngine {
        override update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null {
          super.update(id, patch);
          return this.rect(id) && { ...this.rects.get(id)!, x: 0, y: 0 };
        }
      }
      const { grip, press, said, engine } = setup(Sticky);
      engine.dragTo('daily', { x: 0, y: 0 });
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      assert.equal(said.at(-1), 'Alpha cannot move further right.');
    });

    it('names the panels a move displaced, up to two, then counts the rest', () => {
      class Pushy extends FakeEngine {
        pushed = 1;
        override update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null {
          const out = super.update(id, patch);
          const others = ['heatmap', 'models', 'daily'].filter((o) => o !== id).slice(0, this.pushed);
          for (const o of others) this.dragTo(o, { y: this.rects.get(o)!.y + 100 });
          return out;
        }
      }
      const { grip, press, said, engine } = setup(Pushy);
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      assert.equal(said.at(-1), 'Alpha moved to column 2, row band 1. Displaced: Beta.');
      (engine as Pushy).pushed = 2;
      press(grip('daily'), 'ArrowRight');
      assert.match(said.at(-1)!, /Displaced: Gamma and Beta\.$/);
    });

    it('counts displaced panels beyond two', () => {
      class Pushy extends FakeEngine {
        override update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null {
          const out = super.update(id, patch);
          for (const o of ['heatmap', 'models', 'extra']) this.dragTo(o, { y: this.rects.get(o)!.y + 100 });
          return out;
        }
      }
      const { grip, press, said, engine } = setup(Pushy);
      engine.registerAll([{ id: 'extra', el: document.createElement('div'), rect: r('extra', 3, 40, 1, 7) }]);
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      assert.equal(said.at(-1), 'Alpha moved to column 2, row band 1. Displaced: Beta and 2 others.');
    });

    it('keeps focus on the same grip when the engine re-render dropped it', () => {
      class Blurring extends FakeEngine {
        override update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null {
          (document.activeElement as HTMLElement | null)?.blur();
          return super.update(id, patch);
        }
      }
      const { grip, press } = setup(Blurring);
      grip('daily').focus();
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      assert.equal(document.activeElement, grip('daily'));
    });
  });

  describe('resizing', () => {
    it('R switches to resize mode and back, announcing each', () => {
      const { said, grip, press, root } = setup();
      press(grip('daily'), ' ');
      press(grip('daily'), 'r');
      assert.match(said.at(-1)!, /^Resize mode\. Right and Left change the width, Down and Up change the height\. R to move again\.$/);
      assert.equal(root.querySelector<HTMLElement>('[data-panel="daily"]')!.dataset.liftMode, 'resize');
      press(grip('daily'), 'R');
      assert.equal(said.at(-1), 'Move mode. Arrow keys move Alpha. R to resize.');
      assert.equal(root.querySelector<HTMLElement>('[data-panel="daily"]')!.dataset.liftMode, 'move');
    });

    it('Right and Left change the width by one column, bounded by the grid', () => {
      const { engine, said, grip, press } = setup();
      press(grip('daily'), ' ');
      press(grip('daily'), 'r');
      press(grip('daily'), 'ArrowRight');
      assert.equal(engine.rect('daily')!.w, 3);
      assert.equal(said.at(-1), 'Alpha resized to 3 of 4 columns wide.');
      press(grip('daily'), 'ArrowRight');
      assert.equal(engine.rect('daily')!.w, 4);
      press(grip('daily'), 'ArrowRight');
      assert.equal(said.at(-1), 'Alpha is already at its maximum width.');
      press(grip('daily'), 'ArrowLeft');
      press(grip('daily'), 'ArrowLeft');
      press(grip('daily'), 'ArrowLeft');
      assert.equal(engine.rect('daily')!.w, 1);
      press(grip('daily'), 'ArrowLeft');
      assert.equal(said.at(-1), 'Alpha is already at its minimum width.');
    });

    it('cannot widen past the right edge of the grid from where the panel starts', () => {
      const { engine, said, grip, press } = setup();
      press(grip('heatmap'), ' ');
      press(grip('heatmap'), 'r');
      press(grip('heatmap'), 'ArrowRight');
      assert.equal(engine.rect('heatmap')!.w, 2, 'x:2 + w:2 already reaches column 4');
      assert.equal(said.at(-1), 'Beta is already at its maximum width.');
    });

    it('Down and Up step through the height tiers (compact 7, normal 13, tall 21 rows)', () => {
      const { engine, said, grip, press } = setup();
      press(grip('daily'), ' ');
      press(grip('daily'), 'r');
      press(grip('daily'), 'ArrowDown');
      assert.equal(engine.rect('daily')!.h, 13);
      assert.equal(said.at(-1), 'Alpha resized to normal height.');
      press(grip('daily'), 'ArrowDown');
      assert.equal(engine.rect('daily')!.h, 21);
      assert.equal(said.at(-1), 'Alpha resized to tall height.');
      press(grip('daily'), 'ArrowDown');
      assert.equal(said.at(-1), 'Alpha is already at its maximum height.');
      press(grip('daily'), 'ArrowUp');
      press(grip('daily'), 'ArrowUp');
      assert.equal(engine.rect('daily')!.h, 7);
      assert.equal(said.at(-1), 'Alpha resized to compact height.');
      press(grip('daily'), 'ArrowUp');
      assert.equal(said.at(-1), 'Alpha is already at its minimum height.');
    });

    it('a height set by dragging snaps to the next tier in the direction pressed', () => {
      const { engine, grip, press } = setup();
      engine.dragTo('daily', { h: 10 });
      press(grip('daily'), ' ');
      press(grip('daily'), 'r');
      press(grip('daily'), 'ArrowDown');
      assert.equal(engine.rect('daily')!.h, 13);
      engine.dragTo('daily', { h: 10 });
      press(grip('daily'), 'ArrowUp');
      assert.equal(engine.rect('daily')!.h, 7);
    });
  });

  describe('ending a lift', () => {
    it('Space drops the panel where it is, announces it, and tells the persistence layer', () => {
      const { engine, said, grip, press, lift, ends, root } = setup();
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      const e = press(grip('daily'), ' ');

      assert.equal(e.defaultPrevented, true);
      assert.equal(lift.isLifted(), false);
      assert.deepEqual(engine.rect('daily'), r('daily', 1, 0, 2, 7));
      assert.equal(said.at(-1), 'Alpha dropped at column 2, row band 1.');
      assert.deepEqual(ends, ['drop:daily']);
      assert.equal(grip('daily').getAttribute('aria-pressed'), 'false');
      const panel = root.querySelector<HTMLElement>('[data-panel="daily"]')!;
      assert.equal(panel.classList.contains('wv-lifted'), false);
      assert.equal('liftMode' in panel.dataset, false);
    });

    it('Enter drops as well', () => {
      const { grip, press, ends } = setup();
      press(grip('daily'), 'Enter');
      press(grip('daily'), 'Enter');
      assert.deepEqual(ends, ['drop:daily']);
    });

    it('Escape cancels: EVERY panel goes back to where it was at lift time, focus stays on the grip', () => {
      const { engine, said, grip, press, ends, lift } = setup();
      const before = engine.save();
      grip('daily').focus();
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      engine.dragTo('heatmap', { y: 50 }); // something displaced by the move
      const e = press(grip('daily'), 'Escape');

      assert.equal(e.defaultPrevented, true);
      assert.equal(lift.isLifted(), false);
      assert.deepEqual(engine.save(), before);
      assert.equal(said.at(-1), 'Cancelled. Alpha returned to column 1, row band 1.');
      assert.deepEqual(ends, ['cancel:daily']);
      assert.equal(document.activeElement, grip('daily'));
    });

    it('focus leaving the grip drops the panel (a lift never lingers invisibly)', () => {
      const { engine, said, grip, press, lift, ends, root } = setup();
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      root.querySelector('[data-act="hide"]')!.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
      assert.equal(lift.isLifted(), true, 'a focusout on some other element is none of its business');
      grip('daily').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
      assert.equal(lift.isLifted(), false);
      assert.deepEqual(ends, ['drop:daily']);
      assert.equal(said.at(-1), 'Alpha dropped at column 2, row band 1.');
      assert.equal(engine.rect('daily')!.x, 1);
      grip('daily').dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); // nothing lifted: ignored
      assert.equal(ends.length, 1);
    });

    it('ignores the focus loss caused by our own engine update (DOM re-sorting must not end the lift)', () => {
      class Blurring extends FakeEngine {
        override update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null {
          document.getElementById('grid')!.querySelector(`[data-panel="${id}"] [data-act="move"]`)!.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
          return super.update(id, patch);
        }
      }
      const { grip, press, lift } = setup(Blurring);
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      assert.equal(lift.isLifted(), true);
    });

    it('only the lifted grip drives the lift; other keys fall through untouched', () => {
      const { grip, press, lift, said, engine, root } = setup();
      press(grip('daily'), ' ');
      press(grip('heatmap'), 'ArrowRight'); // wrong target
      press(root.querySelector('[data-act="hide"]')!, 'Escape');
      assert.equal(lift.isLifted(), true);
      assert.deepEqual(engine.rect('heatmap'), r('heatmap', 2, 0, 2, 13));
      assert.equal(said.length, 1);
      for (const key of ['a', 'Tab', 'Home']) assert.equal(press(grip('daily'), key).defaultPrevented, false, key);
      for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) assert.equal(press(grip('daily'), 'ArrowRight', init).defaultPrevented, false);
      assert.equal(engine.rect('daily')!.x, 0);
    });

    it('cancel() ends a lift as a cancel (edit mode switched off) and is a no-op otherwise', () => {
      const { engine, grip, press, lift, ends } = setup();
      lift.cancel();
      assert.deepEqual(ends, []);
      press(grip('daily'), ' ');
      press(grip('daily'), 'ArrowRight');
      lift.cancel();
      assert.deepEqual(ends, ['cancel:daily']);
      assert.equal(engine.rect('daily')!.x, 0);
    });

    it('dispose() cancels a lift in progress and detaches every listener', () => {
      const { grip, press, lift, ends } = setup();
      press(grip('daily'), ' ');
      lift.dispose();
      assert.deepEqual(ends, ['cancel:daily']);
      lift.dispose(); // again: nothing lifted
      press(grip('daily'), ' ');
      assert.equal(lift.isLifted(), false);
      assert.deepEqual(ends, ['cancel:daily']);
    });

    it('reports onStart once per lift', () => {
      const { grip, press, starts } = setup();
      press(grip('daily'), ' ');
      press(grip('daily'), ' ');
      press(grip('heatmap'), ' ');
      assert.equal(starts(), 2);
    });
  });
});

describe('keyboard helpers', () => {
  const all = [r('a', 0, 0, 2, 7), r('b', 0, 7, 2, 13), r('c', 2, 0, 2, 7)];

  it('nextMove: one column sideways, clamped; past the nearest neighbour vertically; null when blocked', () => {
    assert.deepEqual(nextMove(all[0]!, all, 1, 0, 4), { x: 1 });
    assert.equal(nextMove(all[0]!, all, -1, 0, 4), null);
    assert.equal(nextMove(all[2]!, all, 1, 0, 4), null, 'already against the right edge');
    assert.deepEqual(nextMove(all[0]!, all, 0, 1, 4), { y: 20 }, 'below b');
    assert.equal(nextMove(all[0]!, all, 0, -1, 4), null);
    assert.deepEqual(nextMove(all[1]!, all, 0, -1, 4), { y: 0 }, 'onto a');
    assert.equal(nextMove(all[2]!, all, 0, 1, 4), null, 'nothing below c in its columns');
    assert.equal(nextMove(all[2]!, all, 0, -1, 4), null);
  });

  it('nextMove picks the NEAREST neighbour, not the first one found', () => {
    const col = [r('m', 0, 0, 1, 7), r('t', 0, 7, 1, 7), r('u', 0, 14, 1, 7), r('top', 0, 21, 1, 7)];
    assert.deepEqual(nextMove(col[0]!, col, 0, 1, 4), { y: 14 });
    assert.deepEqual(nextMove(col[3]!, col, 0, -1, 4), { y: 14 });
  });

  it('rowBand ranks the distinct row starts above a panel', () => {
    assert.equal(rowBand(all[0]!, all), 1);
    assert.equal(rowBand(all[2]!, all), 1, 'same start row as a');
    assert.equal(rowBand(all[1]!, all), 2);
  });

  it('nearestTier picks the closest tier index', () => {
    assert.equal(nearestTier(7, TIER_ROW_LIST), 0);
    assert.equal(nearestTier(12, TIER_ROW_LIST), 1);
    assert.equal(nearestTier(30, TIER_ROW_LIST), 2);
  });

  it('restoreFocus refocuses a connected element that lost focus, and leaves everything else alone', () => {
    document.body.innerHTML = '<button id="a">a</button><button id="b">b</button>';
    const a = document.getElementById('a')!;
    restoreFocus(a);
    assert.equal(document.activeElement, a);
    restoreFocus(a); // already focused: untouched
    assert.equal(document.activeElement, a);
    const gone = document.createElement('button');
    restoreFocus(gone); // not in the document
    assert.equal(document.activeElement, a);
    document.body.innerHTML = '';
  });
});

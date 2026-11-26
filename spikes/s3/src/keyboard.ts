/**
 * S3 spike: the custom keyboard layer that sits on TOP of `GridEngine.update()`.
 *
 * gridstack 14.1.1 ships zero keyboard/ARIA support (drag + resize are mouse/touch
 * only; the only key it listens to is Esc/R *during* a mouse drag), so everything
 * here is ours. It only talks to the `GridEngine` interface, so it is unit-testable
 * with `FakeEngine` (see test/keyboard.test.ts).
 *
 *  - Alt+Arrow on anything inside a panel header: move the panel one step.
 *  - Plain Arrow on a focused `[role=slider][data-axis]`: resize (w: columns, h: tier).
 *  - Every action is announced through `announce()` (aria-live) with the RESULT
 *    that the engine actually produced, not the requested value.
 *  - Focus is re-asserted on the same element after the engine update, because
 *    gridstack re-sorts DOM children (`_sortDom`) after each change and on browsers
 *    without `Element.moveBefore` the `appendChild` fallback blurs the focused node.
 */
import type { GridEngine, PanelRect } from './gridEngine';

export interface KeyboardOptions {
  /** Height tiers as ROW counts, ascending (compact, normal, tall). */
  tierRows: readonly number[];
  tierNames: readonly string[];
  titleOf(id: string): string;
  announce(message: string): void;
  /** Called once per handled key, for the spike's metrics. */
  onHandled?(info: { kind: 'move' | 'resize'; id: string; before: PanelRect; after: PanelRect }): void;
}

const ARROW: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const overlapsX = (a: PanelRect, b: PanelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w;

/**
 * User-facing row number. Raw gridstack `y` is in 24 px row units ("row 27" means nothing to a
 * person), so announce the ORDINAL of the panel's y among the distinct y starts: 1 = top band.
 */
export function rowBand(rect: PanelRect, all: readonly PanelRect[]): number {
  return 1 + new Set(all.map((p) => p.y).filter((y) => y < rect.y)).size;
}

/** Index of the tier whose row count is closest to `rows`. */
export function nearestTier(rows: number, tierRows: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < tierRows.length; i++) {
    if (Math.abs(tierRows[i]! - rows) < Math.abs(tierRows[best]! - rows)) best = i;
  }
  return best;
}

/**
 * Compute the next rect for an Alt+Arrow move. Horizontal: +-1 column. Vertical:
 * jump over the nearest panel above/below (gravity would undo a bare y+-1 nudge, so
 * a naive `update(el,{y:y+1})` is a no-op unless it passes the neighbour).
 */
export function nextMove(
  me: PanelRect,
  all: readonly PanelRect[],
  dx: number,
  dy: number,
  columns: number,
): Partial<PanelRect> | null {
  if (dx !== 0) {
    const x = Math.min(Math.max(me.x + dx, 0), columns - me.w);
    return x === me.x ? null : { x };
  }
  const others = all.filter((p) => p.id !== me.id && overlapsX(me, p));
  if (dy > 0) {
    const below = others.filter((p) => p.y >= me.y + me.h).sort((a, b) => a.y - b.y)[0];
    return below ? { y: below.y + below.h } : null;
  }
  const above = others.filter((p) => p.y + p.h <= me.y).sort((a, b) => b.y - a.y)[0];
  return above ? { y: above.y } : null;
}

export function attachKeyboardLayer(root: HTMLElement, engine: GridEngine, o: KeyboardOptions): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    const step = ARROW[e.key];
    if (!step || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const target = e.target as HTMLElement | null;
    const panel = target?.closest<HTMLElement>('[data-panel]');
    if (!target || !panel || engine.isStatic()) return; // only in edit mode
    const id = panel.dataset.panel!;
    const focusBefore = target;

    if (e.altKey && target.closest('.wv-panel-header')) {
      e.preventDefault();
      const before = engine.rect(id);
      if (!before) return;
      const patch = nextMove(before, engine.save(), step[0], step[1], engine.columns());
      const title = o.titleOf(id);
      if (!patch) {
        o.announce(`${title} cannot move further ${dirName(step)}.`);
        return;
      }
      const after = engine.update(id, patch)!;
      restoreFocus(focusBefore);
      o.announce(`${title} moved to column ${after.x + 1}, row ${rowBand(after, engine.save())}.`);
      o.onHandled?.({ kind: 'move', id, before, after });
      return;
    }

    const slider = target.closest<HTMLElement>('[role="slider"][data-axis]');
    if (slider && !e.altKey) {
      const axis = slider.dataset.axis as 'w' | 'h';
      // Left/Down shrink width/height respectively; Right/Up grow. Only the matching axis keys act.
      const grow = axis === 'w' ? step[0] : -step[1];
      const keyMatches = axis === 'w' ? step[0] !== 0 : step[1] !== 0;
      if (!keyMatches) return;
      e.preventDefault();
      const before = engine.rect(id);
      if (!before) return;
      const title = o.titleOf(id);
      let patch: Partial<PanelRect>;
      if (axis === 'w') {
        patch = { w: Math.min(Math.max(before.w + grow, 1), engine.columns() - before.x) };
      } else {
        const idx = nearestTier(before.h, o.tierRows);
        const next = Math.min(Math.max(idx + grow, 0), o.tierRows.length - 1);
        patch = { h: o.tierRows[next]! };
      }
      if ((patch.w ?? before.w) === before.w && (patch.h ?? before.h) === before.h) {
        o.announce(`${title} is already at its ${grow > 0 ? 'maximum' : 'minimum'} ${axis === 'w' ? 'width' : 'height'}.`);
        return;
      }
      const after = engine.update(id, patch)!;
      restoreFocus(focusBefore);
      syncSlider(slider, after, engine.columns(), o);
      o.announce(
        axis === 'w'
          ? `${title} resized to ${after.w} of ${engine.columns()} columns wide.`
          : `${title} resized to ${o.tierNames[nearestTier(after.h, o.tierRows)]} height, ${after.h} rows.`,
      );
      o.onHandled?.({ kind: 'resize', id, before, after });
    }
  };

  root.addEventListener('keydown', onKeyDown);
  return () => root.removeEventListener('keydown', onKeyDown);
}

function dirName(step: readonly [number, number]): string {
  return step[0] < 0 ? 'left' : step[0] > 0 ? 'right' : step[1] < 0 ? 'up' : 'down';
}

/** Re-assert focus on the very same element if a DOM re-sort dropped it. */
export function restoreFocus(el: HTMLElement): void {
  if (document.activeElement !== el && el.isConnected) {
    el.focus({ preventScroll: true });
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }
}

/** Keep `role=slider` aria-value* in sync with the engine's rect. */
export function syncSlider(slider: HTMLElement, rect: PanelRect, columns: number, o: Pick<KeyboardOptions, 'tierRows' | 'tierNames'>): void {
  if (slider.dataset.axis === 'w') {
    slider.setAttribute('aria-valuemin', '1');
    slider.setAttribute('aria-valuemax', String(columns));
    slider.setAttribute('aria-valuenow', String(rect.w));
    slider.setAttribute('aria-valuetext', `${rect.w} of ${columns} columns`);
  } else {
    const i = nearestTier(rect.h, o.tierRows);
    slider.setAttribute('aria-valuemin', '0');
    slider.setAttribute('aria-valuemax', String(o.tierRows.length - 1));
    slider.setAttribute('aria-valuenow', String(i));
    slider.setAttribute('aria-valuetext', `${o.tierNames[i]} (${rect.h} rows)`);
  }
}

/**
 * Keyboard operation of the dashboard grid: "lift mode" over `GridEngine.update()`.
 *
 * gridstack ships no keyboard or ARIA support (drag and resize are mouse and
 * touch only), so everything here is ours. The model is the common sortable-list
 * pattern, chosen over Alt+Arrow because VS Code binds Alt+Left/Right to
 * navigate back/forward on Windows and Linux:
 *
 *   - Focus a panel's grip (`[data-act="move"]` inside its header) and press
 *     Space or Enter to LIFT the panel.
 *   - Arrow keys move it one column left/right, or past the nearest panel
 *     above/below.
 *   - R switches to resize mode: Right/Left widen/narrow by one column,
 *     Down/Up grow/shrink by one height tier. R again goes back to moving.
 *   - Space or Enter DROPS it (the change is kept), Escape CANCELS (every
 *     panel goes back to where it was at lift time). Focus leaving the grip
 *     also drops it.
 *
 * Every step is announced through the caller's single `aria-live` region with
 * the RESULT the engine actually produced (an ordinal row band, never a raw
 * row number, plus any panel that was displaced). Focus is re-asserted on the
 * same grip after each engine update because gridstack re-sorts the DOM
 * (`_sortDom`) and, without `Element.moveBefore`, the re-append blurs the node.
 *
 * Only the `GridEngine` interface is used, so this is unit-tested against a
 * fake engine.
 */
import type { GridEngine, PanelRect } from './gridEngine';

export interface LiftOptions {
  /** Height tiers as ROW counts, ascending (compact, normal, tall). */
  tierRows: readonly number[];
  tierNames: readonly string[];
  titleOf(id: string): string;
  announce(message: string): void;
  /** A panel was lifted: the persistence layer must hold back until it ends. */
  onStart?(id: string): void;
  /** The lift ended: persist on 'drop', nothing to do on 'cancel'. */
  onEnd?(result: 'drop' | 'cancel', id: string): void;
}

export interface LiftController {
  isLifted(): boolean;
  /** End a lift in progress as a cancel (edit mode switched off, grid went narrow). */
  cancel(): void;
  dispose(): void;
}

const ARROW: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

const overlapsX = (a: PanelRect, b: PanelRect): boolean => a.x < b.x + b.w && b.x < a.x + a.w;
const sameRect = (a: PanelRect, b: PanelRect): boolean => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * User-facing row number. Raw gridstack `y` is in 24 px row units ("row 27"
 * means nothing to a person), so announce the ORDINAL of the panel's y among the
 * distinct y starts: 1 is the top band.
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
 * The patch for one arrow move. Horizontal: one column. Vertical: jump just
 * past the nearest panel above/below (with `mode:'top'` gravity a bare
 * `update(el, {y: y + 1})` is undone, so a nudge only sticks once it passes the
 * neighbour). Returns null when there is nowhere to go.
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

/** Re-assert focus on the very same element if a DOM re-sort dropped it. */
export function restoreFocus(el: HTMLElement): void {
  if (document.activeElement === el || !el.isConnected) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

const dirName = ([dx, dy]: readonly [number, number]): string => (dx < 0 ? 'left' : dx > 0 ? 'right' : dy < 0 ? 'up' : 'down');

interface Lift {
  id: string;
  grip: HTMLElement;
  panel: HTMLElement;
  /** Every panel's rect at lift time: what Escape restores. */
  snapshot: PanelRect[];
  resizing: boolean;
}

export function attachLiftKeyboard(root: HTMLElement, engine: GridEngine, o: LiftOptions): LiftController {
  let lift: Lift | null = null;
  /** True while WE change the grid, so the focus loss that DOM re-sorting causes is not read as the user leaving. */
  let busy = false;

  const run = <T>(fn: () => T): T => {
    busy = true;
    try {
      return fn();
    } finally {
      busy = false;
    }
  };
  const where = (r: PanelRect): string => `column ${r.x + 1}, row band ${rowBand(r, engine.save())}`;

  function begin(grip: HTMLElement): void {
    const panel = grip.closest<HTMLElement>('[data-panel]')!;
    const id = panel.dataset.panel!;
    const rect = engine.rect(id);
    if (!rect) return;
    lift = { id, grip, panel, snapshot: engine.save(), resizing: false };
    grip.setAttribute('aria-pressed', 'true');
    panel.classList.add('wv-lifted');
    panel.dataset.liftMode = 'move';
    o.onStart?.(id);
    o.announce(`${o.titleOf(id)} lifted. ${where(rect)}. Use arrow keys to move, R to resize, Space to drop, Escape to cancel.`);
  }

  function end(result: 'drop' | 'cancel'): void {
    const l = lift!;
    lift = null;
    l.grip.setAttribute('aria-pressed', 'false');
    l.panel.classList.remove('wv-lifted');
    delete l.panel.dataset.liftMode;
    if (result === 'cancel') {
      run(() => engine.load(l.snapshot));
      restoreFocus(l.grip);
    }
    o.onEnd?.(result, l.id);
    const at = where(engine.rect(l.id)!);
    const title = o.titleOf(l.id);
    o.announce(result === 'drop' ? `${title} dropped at ${at}.` : `Cancelled. ${title} returned to ${at}.`);
  }

  /** Names of the panels (other than the lifted one) that the last update moved or resized. */
  function displaced(before: readonly PanelRect[], id: string): string {
    const old = new Map(before.map((r) => [r.id, r]));
    const names = engine
      .save()
      .filter((r) => r.id !== id && old.has(r.id) && !sameRect(old.get(r.id)!, r))
      .map((r) => o.titleOf(r.id));
    if (names.length === 0) return '';
    return names.length <= 2 ? ` Displaced: ${names.join(' and ')}.` : ` Displaced: ${names[0]} and ${names.length - 1} others.`;
  }

  function move(l: Lift, step: readonly [number, number]): void {
    const before = engine.rect(l.id)!;
    const all = engine.save();
    const patch = nextMove(before, all, step[0], step[1], engine.columns());
    const after = patch ? run(() => engine.update(l.id, patch)) : null;
    if (!after || sameRect(before, after)) {
      o.announce(`${o.titleOf(l.id)} cannot move further ${dirName(step)}.`);
      return;
    }
    restoreFocus(l.grip);
    o.announce(`${o.titleOf(l.id)} moved to ${where(after)}.${displaced(all, l.id)}`);
  }

  function resize(l: Lift, step: readonly [number, number]): void {
    const before = engine.rect(l.id)!;
    const all = engine.save();
    const title = o.titleOf(l.id);
    const wide = step[0] !== 0;
    const grow = step[0] > 0 || step[1] > 0;
    let patch: Partial<PanelRect>;
    if (wide) {
      patch = { w: Math.min(Math.max(before.w + step[0], 1), engine.columns() - before.x) };
    } else {
      const next = grow ? o.tierRows.find((r) => r > before.h) : [...o.tierRows].reverse().find((r) => r < before.h);
      patch = { h: next ?? before.h };
    }
    const after = run(() => engine.update(l.id, patch))!;
    if (sameRect(before, after)) {
      o.announce(`${title} is already at its ${grow ? 'maximum' : 'minimum'} ${wide ? 'width' : 'height'}.`);
      return;
    }
    restoreFocus(l.grip);
    const size = wide
      ? `${after.w} of ${engine.columns()} columns wide`
      : `${o.tierNames[nearestTier(after.h, o.tierRows)]} height`;
    o.announce(`${title} resized to ${size}.${displaced(all, l.id)}`);
  }

  function toggleResize(l: Lift): void {
    l.resizing = !l.resizing;
    l.panel.dataset.liftMode = l.resizing ? 'resize' : 'move';
    o.announce(
      l.resizing
        ? `Resize mode. Right and Left change the width, Down and Up change the height. R to move again.`
        : `Move mode. Arrow keys move ${o.titleOf(l.id)}. R to resize.`,
    );
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    const confirm = e.key === ' ' || e.key === 'Enter';
    if (!lift) {
      const grip = target.closest<HTMLElement>('[data-act="move"]');
      if (!grip || !confirm || engine.isStatic()) return;
      e.preventDefault();
      begin(grip);
      return;
    }
    if (target !== lift.grip) return;
    const step = ARROW[e.key];
    if (step) {
      e.preventDefault();
      (lift.resizing ? resize : move)(lift, step);
    } else if (e.key === 'r' || e.key === 'R') {
      e.preventDefault();
      toggleResize(lift);
    } else if (confirm || e.key === 'Escape') {
      e.preventDefault();
      end(confirm ? 'drop' : 'cancel');
    }
  };

  // Space activates a button on keyup in some engines even when keydown was prevented.
  const onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === ' ' && (e.target as HTMLElement).closest('[data-act="move"]')) e.preventDefault();
  };

  const onFocusOut = (e: FocusEvent): void => {
    if (!lift || busy || e.target !== lift.grip) return;
    end('drop');
  };

  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('keyup', onKeyUp);
  root.addEventListener('focusout', onFocusOut);
  return {
    isLifted: () => lift !== null,
    cancel: () => {
      if (lift) end('cancel');
    },
    dispose: () => {
      if (lift) end('cancel');
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('keyup', onKeyUp);
      root.removeEventListener('focusout', onFocusOut);
    },
  };
}

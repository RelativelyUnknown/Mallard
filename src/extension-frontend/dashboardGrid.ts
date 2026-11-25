/**
 * The dashboard's analysis grid: keeps a `GridEngine` (gridstack) in step with
 * the persisted `LayoutV2`, and the page controls (edit toggle, reset, hide
 * buttons, the live region) in step with the engine.
 *
 *  - Panels are gridstack widgets. A panel that is hidden in the layout, or has
 *    no data, is REMOVED from the grid (`engine.unregister`, node and chart
 *    instance kept) instead of being `display:none`d, so it leaves no gap, and
 *    is re-added at its last rectangle when it comes back.
 *  - Edit mode toggles the grid static/non-static. A one-column (narrow) grid
 *    is always static and never persisted, so a narrow window cannot overwrite
 *    the wide layout.
 *  - Every user change reaches `onPersist` through a 250 ms debounce, from the
 *    engine's `change` events (pointer drag and resize, keyboard drops) or from
 *    hide/show/reset. Programmatic re-arrangements (host echoes, no-data
 *    toggles) never persist by themselves.
 *  - The keyboard layer (keyboard.ts) provides lift mode; every announcement
 *    goes through the one `aria-live` region.
 */
import type { LayoutV2 } from '../extension-backend/domain/contracts';
import { defaultLayout } from '../extension-backend/domain/layout';
import type { PanelRect, PanelV2 } from '../extension-backend/domain/layout';
import { COLUMNS, ENGINE_OPTIONS, TIER_NAMES, TIER_ROW_LIST } from './gridConstants';
import type { EngineOptions, GridEngine } from './gridEngine';
import { attachLiftKeyboard } from './keyboard';

export interface DashboardGridOptions {
  /** The `.grid-stack` element the panels live in. */
  root: HTMLElement;
  /** The `.grid-stack-item` element of every panel, by panel id. */
  items: Readonly<Record<string, HTMLElement>>;
  /** Panel titles by id (for announcements and button labels). */
  titles: Readonly<Record<string, string>>;
  engine: GridEngine;
  controls: {
    edit: HTMLElement;
    reset: HTMLElement;
    add: HTMLElement;
    /** Visible keyboard hint, shown while editing. */
    hint: HTMLElement;
    /** The single `aria-live="polite"` region. */
    live: HTMLElement;
  };
  /** Receives the layout to store (debounced); the host echoes it back through `apply`. */
  onPersist(layout: LayoutV2): void;
  engineOptions?: EngineOptions;
  /** Debounce before persisting a change (ms). */
  debounceMs?: number;
}

export interface DashboardGrid {
  /** Adopt a layout (initial, host echo, reset). A no-op when it is what the grid already shows. */
  apply(layout: LayoutV2): void;
  /** Panels with no data leave the grid (without touching the layout) until data arrives. */
  setNoData(id: string, noData: boolean): void;
  /** Un-hide a panel (the "Add chart" picker). */
  show(id: string): void;
  /** Panels hidden in the layout, for the "Add chart" picker. */
  hiddenPanels(): Array<{ id: string; title: string }>;
  isEditing(): boolean;
  setEditing(on: boolean): void;
  isNarrow(): boolean;
  /** Persist the current layout now instead of after the debounce. */
  flush(): void;
  destroy(): void;
}

export function mountDashboardGrid(opts: DashboardGridOptions): DashboardGrid {
  const { root, items, titles, engine, controls } = opts;
  const debounceMs = opts.debounceMs ?? 250;
  const titleOf = (id: string): string => titles[id]!;

  /** Every panel of the layout (unknown ids included, so they survive a save), keyed by id, in layout order. */
  let model = new Map<string, PanelV2>();
  const noData = new Set<string>();
  let started = false;
  let editing = false;
  let narrow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** JSON of the layout last handed to onPersist: the host's echo of it must not be applied again. */
  let lastPosted: string | undefined;
  let pending: LayoutV2 | undefined;

  function announce(message: string): void {
    // Clear first so repeating the same message is announced again.
    controls.live.textContent = '';
    requestAnimationFrame(() => {
      controls.live.textContent = message;
    });
  }

  const snapshot = (): LayoutV2 => ({ version: 2, panels: [...model.values()].map((p) => ({ ...p })) });

  function syncModel(rects: readonly PanelRect[]): void {
    for (const r of rects) model.set(r.id, { ...model.get(r.id)!, x: r.x, y: r.y, w: r.w, h: r.h });
  }

  function flush(): void {
    clearTimeout(timer);
    timer = undefined;
    if (engine.columns() !== COLUMNS) return;
    const layout = snapshot();
    lastPosted = JSON.stringify(layout);
    opts.onPersist(layout);
  }

  function schedulePersist(): void {
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  /** A panel is in the grid when it is visible in the layout and has data. */
  const wanted = (id: string): boolean => {
    const p = model.get(id);
    return !!p && !p.hidden && !noData.has(id);
  };

  function syncLabels(): void {
    for (const [id, item] of Object.entries(items)) {
      const label = `${model.get(id)?.hidden ? 'Show' : 'Hide'} ${titleOf(id)}`;
      const btn = item.querySelector<HTMLElement>('[data-act="hide"]');
      btn?.setAttribute('aria-label', label);
      btn?.setAttribute('title', label);
    }
  }

  /** Bring the engine in line with the model: remove what should be gone, add what should be there, move what differs. */
  function reconcile(): void {
    if (lift.isLifted()) return; // finished by onEnd
    const toAdd: Array<{ id: string; el: HTMLElement; rect: PanelRect }> = [];
    const toLoad: PanelRect[] = [];
    let changed = false;
    for (const [id, el] of Object.entries(items)) {
      const registered = engine.isRegistered(id);
      if (!wanted(id)) {
        const rect = registered ? engine.unregister(id) : null;
        if (rect) {
          model.set(id, { ...model.get(id)!, x: rect.x, y: rect.y, w: rect.w, h: rect.h });
          changed = true;
        }
        el.hidden = true;
        continue;
      }
      const { hidden: _hidden, ...rect } = model.get(id)!;
      if (!registered) {
        toAdd.push({ id, el, rect });
      } else {
        const now = engine.rect(id)!;
        if (now.x !== rect.x || now.y !== rect.y || now.w !== rect.w || now.h !== rect.h) toLoad.push(rect);
      }
    }
    if (!started) {
      started = true;
      engine.registerAll(toAdd);
    } else {
      for (const a of toAdd) engine.add(a.id, a.el, a.rect);
    }
    if (toLoad.length > 0) engine.load(toLoad);
    // Collisions and gravity may have moved other panels; the model must show what is on screen.
    if ((changed || toAdd.length > 0 || toLoad.length > 0) && engine.columns() === COLUMNS) syncModel(engine.save());
  }

  const lift = attachLiftKeyboard(root, engine, {
    tierRows: TIER_ROW_LIST,
    tierNames: TIER_NAMES,
    titleOf,
    announce,
    onEnd: (result) => {
      syncModel(engine.save()); // a cancel restored the old positions, a drop is the new truth
      if (result === 'drop') schedulePersist();
      if (!pending) {
        reconcile(); // catch up on no-data changes that arrived mid-lift
        return;
      }
      const next = pending;
      pending = undefined;
      adopt(next);
    },
  });

  function adopt(layout: LayoutV2): void {
    model = new Map(layout.panels.map((p) => [p.id, { ...p }]));
    reconcile();
    syncLabels();
  }

  function setEditing(on: boolean): void {
    if (on === editing || (on && narrow)) return;
    editing = on;
    if (!on) lift.cancel();
    engine.setStatic(!on);
    root.classList.toggle('wv-editing', on);
    controls.edit.setAttribute('aria-pressed', String(on));
    controls.reset.hidden = !on;
    controls.hint.hidden = !on;
    announce(on ? "Layout editing on. Focus a panel's move handle and press Space to lift it." : 'Layout editing off.');
  }

  function setNarrow(isNarrow: boolean): void {
    narrow = isNarrow;
    if (isNarrow) setEditing(false);
    const reason = isNarrow ? 'Layout editing is only available in the wide layout' : '';
    for (const b of [controls.edit, controls.add] as HTMLButtonElement[]) {
      b.disabled = isNarrow;
      b.title = reason;
    }
  }

  function hide(id: string): void {
    model.set(id, { ...model.get(id)!, hidden: true });
    reconcile();
    syncLabels();
    announce(`${titleOf(id)} hidden. Use Add chart to bring it back.`);
    // The hidden panel's own button just left the grid with the focus on it.
    controls.add.focus();
    schedulePersist();
  }

  engine.mount(root, opts.engineOptions ?? ENGINE_OPTIONS);
  engine.onChange((info) => {
    if (info.ignorable || info.column !== COLUMNS) return;
    syncModel(info.rects);
    if (!lift.isLifted()) schedulePersist();
  });
  engine.onColumnChange((columns) => setNarrow(columns !== COLUMNS));
  setNarrow(engine.columns() !== COLUMNS);

  controls.edit.addEventListener('click', () => setEditing(!editing));
  controls.reset.addEventListener('click', () => {
    adopt(defaultLayout());
    flush();
    announce('Layout reset to the default.');
  });
  root.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-act="hide"]');
    if (btn) hide(btn.closest<HTMLElement>('[data-panel]')!.dataset.panel!);
  });

  return {
    apply(layout) {
      const json = JSON.stringify(layout);
      if (json === lastPosted || json === JSON.stringify(snapshot())) return;
      if (lift.isLifted()) pending = layout;
      else adopt(layout);
    },
    setNoData(id, value) {
      if (noData.has(id) === value) return;
      if (value) noData.add(id);
      else noData.delete(id);
      reconcile();
    },
    show(id) {
      const p = model.get(id);
      if (!p?.hidden) return;
      model.set(id, { ...p, hidden: false });
      reconcile();
      syncLabels();
      announce(noData.has(id) ? `${titleOf(id)} added. It has no data yet, so it appears once there is some.` : `${titleOf(id)} added.`);
      schedulePersist();
    },
    hiddenPanels: () => [...model.values()].filter((p) => p.hidden && p.id in titles).map((p) => ({ id: p.id, title: titleOf(p.id) })),
    isEditing: () => editing,
    setEditing,
    isNarrow: () => narrow,
    flush,
    destroy() {
      clearTimeout(timer);
      lift.dispose();
      engine.destroy();
    },
  };
}

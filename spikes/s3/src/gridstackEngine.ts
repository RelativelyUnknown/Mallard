/**
 * S3 spike: the real gridstack-backed `GridEngine` (see gridEngine.ts for the interface).
 * Only this file imports gridstack.
 */
import { GridStack } from 'gridstack';
import type { GridItemHTMLElement, GridStackNode } from 'gridstack';
import { sanitizeRects } from './gridEngine';
import type { ChangeInfo, EngineOptions, GridEngine, PanelRect } from './gridEngine';

/**
 * NOTE (pitfall found by S3): `grid.save()` DELETES `w` when it equals 1 or `minW`, and `h` when it
 * equals 1 or `minH` ("default values, re-created on read"). With `minH: 7` a 7-row panel therefore
 * comes back WITHOUT `h`. Blindly defaulting a missing `h` to 1 silently corrupts the layout, so
 * the defaults must be resolved the same way gridstack's loader does: `w ?? minW ?? 1`.
 */
function toRect(n: GridStackNode): PanelRect {
  return { id: String(n.id), x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? n.minW ?? 1, h: n.h ?? n.minH ?? 1 };
}

export class GridstackEngine implements GridEngine {
  private grid: GridStack | null = null;
  private els = new Map<string, GridItemHTMLElement>();
  private parked = new Map<string, PanelRect>();
  private changeCbs = new Set<(i: ChangeInfo) => void>();
  private columnCbs = new Set<(c: number) => void>();
  private lastColumn = 0;
  private opts!: EngineOptions;

  mount(root: HTMLElement, opts: EngineOptions): void {
    this.opts = opts;
    const grid = GridStack.init(
      {
        column: opts.columns,
        // We register panels explicitly (so persisted rects win); do not auto-adopt DOM children.
        auto: false,
        // v14 replaced `float:false` with `mode:'top'` (vertical gravity). 'top' is the default.
        mode: 'top',
        cellHeight: opts.cellHeight,
        margin: opts.margin,
        animate: opts.animate,
        staticGrid: true, // start non-editing
        handle: opts.handle,
        draggable: { handle: opts.handle, cancel: opts.dragCancel, scroll: true },
        resizable: { handles: 'e,se,s' },
        alwaysShowResizeHandle: true,
        minRow: 1,
        // The 1-column breakpoint: replaces `@media (max-width:700px)`.
        columnOpts: {
          breakpoints: [{ w: opts.narrowBelowPx, c: 1 }],
          breakpointForWindow: true,
          columnMax: opts.columns,
          // 'moveScale' (not 'list'/'compact'): going 1 -> N restores the CACHED N-column x/y/w verbatim.
          // 'list'/'compact' only restore `w` and re-flow positions, so a 4 -> 1 -> 4 round trip would
          // rewrite the user's layout (S3 measured hourly x:2 -> x:1 after a round trip).
          layout: 'moveScale',
        },
      },
      root,
    );
    if (!grid) throw new Error('GridStack.init returned null (root not found)');
    this.grid = grid;
    this.lastColumn = grid.getColumn();
    grid.on('change', () => this.emitChange());
    // A breakpoint switch fires NO `change` event (S3 measured); `resizecontent` fires on every
    // ResizeObserver tick of the grid, so compare getColumn() there.
    grid.on('resizecontent', () => {
      const c = this.grid?.getColumn() ?? this.lastColumn;
      if (c !== this.lastColumn) {
        this.lastColumn = c;
        this.columnCbs.forEach((cb) => cb(c));
      }
    });
  }

  private g(): GridStack {
    if (!this.grid) throw new Error('GridstackEngine not mounted');
    return this.grid;
  }

  private emitChange(): void {
    const grid = this.g();
    const info: ChangeInfo = {
      rects: this.save(),
      column: grid.getColumn(),
      ignorable: grid.isIgnoreChangeCB(),
    };
    this.changeCbs.forEach((cb) => cb(info));
  }

  register(id: string, el: HTMLElement, rect: PanelRect): void {
    const grid = this.g();
    const item = el as GridItemHTMLElement;
    this.els.set(id, item);
    grid.makeWidget(item, { id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, minW: 1, minH: this.opts.minH });
  }

  registerAll(entries: ReadonlyArray<{ id: string; el: HTMLElement; rect: PanelRect }>): void {
    const grid = this.g();
    const byId = new Map(entries.map((e) => [e.id, e.el as GridItemHTMLElement]));
    for (const [id, el] of byId) this.els.set(id, el);
    const rects = sanitizeRects(entries.map((e) => e.rect), this.opts.columns, this.opts.minH).map((r) => ({ ...r, minW: 1, minH: this.opts.minH }));
    // load() + addRemoveCB: gridstack calls back for each id with `add=true` and we hand it the EXISTING node
    // (instead of letting it create an empty widget). Going through load() is what makes a restore into an
    // already-narrow grid cache the wide layout (see gridEngine.ts).
    grid.load(rects as any, ((_parent: HTMLElement, w: { id?: string }, add: boolean) => (add ? byId.get(String(w.id)) : undefined)) as any);
  }

  unregister(id: string): PanelRect | null {
    const grid = this.g();
    const el = this.els.get(id);
    const r = this.rect(id);
    if (!el || !r) return null;
    this.parked.set(id, r);
    // removeDOM=false keeps the node (and its ECharts instance); the DOM node then has to be
    // hidden/detached by the caller, otherwise it stays absolutely positioned at its old slot.
    grid.removeWidget(el, false);
    el.hidden = true;
    return r;
  }

  reregister(id: string, rect?: Partial<PanelRect>): void {
    const el = this.els.get(id);
    const prev = this.parked.get(id);
    if (!el) return;
    el.hidden = false;
    const r = { ...(prev ?? { x: 0, y: 0, w: 1, h: 1 }), ...rect };
    this.g().makeWidget(el, { id, x: r.x, y: r.y, w: r.w, h: r.h, minW: 1, minH: this.opts.minH });
    this.parked.delete(id);
  }

  isRegistered(id: string): boolean {
    const el = this.els.get(id);
    return !!el?.gridstackNode;
  }

  setStatic(isStatic: boolean): void {
    this.g().setStatic(isStatic);
  }

  isStatic(): boolean {
    return !!this.g().opts.staticGrid;
  }

  update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null {
    const el = this.els.get(id);
    if (!el?.gridstackNode) return null;
    this.g().update(el, patch);
    return toRect(el.gridstackNode);
  }

  rect(id: string): PanelRect | null {
    const n = this.els.get(id)?.gridstackNode;
    return n ? toRect(n) : null;
  }

  save(): PanelRect[] {
    // saveContent=false: do not serialise innerHTML (it would contain the whole chart DOM).
    return (this.g().save(false, false) as GridStackNode[]).map(toRect);
  }

  load(list: PanelRect[]): void {
    const known = sanitizeRects(list, this.opts.columns, this.opts.minH).filter((r) => this.els.has(r.id) && this.isRegistered(r.id));
    // addRemove=false: never create widgets for unknown ids and never remove panels that are
    // missing from the saved list.
    this.g().load(known as any, false);
  }

  columns(): number {
    return this.g().getColumn();
  }

  onChange(cb: (info: ChangeInfo) => void): () => void {
    this.changeCbs.add(cb);
    return () => this.changeCbs.delete(cb);
  }

  onColumnChange(cb: (c: number) => void): () => void {
    this.columnCbs.add(cb);
    return () => this.columnCbs.delete(cb);
  }

  /** Direct access for the spike's probes only; production code must not need this. */
  raw(): GridStack {
    return this.g();
  }

  destroy(): void {
    // removeDOM=false: leave our panel DOM alone, only tear down listeners/DD/ResizeObserver.
    this.grid?.destroy(false);
    this.grid = null;
    this.els.clear();
    this.parked.clear();
    this.changeCbs.clear();
    this.columnCbs.clear();
  }
}

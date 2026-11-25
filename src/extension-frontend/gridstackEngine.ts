/**
 * The real gridstack-backed `GridEngine` (see gridEngine.ts for the interface).
 * The only file that imports gridstack.
 */
import { GridStack } from 'gridstack';
import type { GridItemHTMLElement, GridStackNode } from 'gridstack';
import { sanitizeRects } from './gridEngine';
import type { ChangeInfo, EngineOptions, GridEngine, PanelRect } from './gridEngine';

/**
 * NOTE (pitfall found by S3): `grid.save()` DELETES `w` when it equals 1 or
 * `minW`, and `h` when it equals 1 or `minH` ("default values, re-created on
 * read"). With `minH: 7` a 7-row panel therefore comes back WITHOUT `h`. Blindly
 * defaulting a missing `h` to 1 silently corrupts the layout, so the defaults are
 * resolved the way gridstack's own loader does: `w ?? minW ?? 1`.
 */
function toRect(n: GridStackNode): PanelRect {
  return { id: String(n.id), x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? n.minW ?? 1, h: n.h ?? n.minH ?? 1 };
}

export class GridstackEngine implements GridEngine {
  private grid: GridStack | null = null;
  private els = new Map<string, GridItemHTMLElement>();
  private changeCbs = new Set<(i: ChangeInfo) => void>();
  private columnCbs = new Set<(c: number) => void>();
  private lastColumn = 0;
  private opts!: EngineOptions;

  mount(root: HTMLElement, opts: EngineOptions): void {
    this.opts = opts;
    const grid = GridStack.init(
      {
        column: opts.columns,
        // Panels are registered explicitly (so persisted rects win); never auto-adopt DOM children.
        auto: false,
        // v14 replaced `float:false` with `mode:'top'` (vertical gravity).
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
        // The 1-column breakpoint: replaces `@media (max-width: 700px)`.
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
    )!; // never null for an element (only an unknown selector gives null)
    this.grid = grid;
    this.lastColumn = grid.getColumn();
    grid.on('change', () => this.emitChange());
    // A breakpoint switch fires NO `change` event (S3 measured); `resizecontent` fires on every
    // ResizeObserver tick of the grid, so compare getColumn() there.
    grid.on('resizecontent', () => {
      const c = grid.getColumn();
      if (c === this.lastColumn) return;
      this.lastColumn = c;
      this.columnCbs.forEach((cb) => cb(c));
    });
  }

  private g(): GridStack {
    if (!this.grid) throw new Error('GridstackEngine not mounted');
    return this.grid;
  }

  private emitChange(): void {
    const grid = this.g();
    const info: ChangeInfo = { rects: this.save(), column: grid.getColumn(), ignorable: grid.isIgnoreChangeCB() };
    this.changeCbs.forEach((cb) => cb(info));
  }

  private widget(id: string, rect: PanelRect): GridStackNode {
    return { id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, minW: 1, minH: this.opts.minH };
  }

  registerAll(entries: ReadonlyArray<{ id: string; el: HTMLElement; rect: PanelRect }>): void {
    const grid = this.g();
    const byId = new Map(entries.map((e) => [e.id, e.el as GridItemHTMLElement]));
    for (const [id, el] of byId) this.els.set(id, el);
    const rects = sanitizeRects(entries.map((e) => e.rect), this.opts.columns, this.opts.minH).map((r) => this.widget(r.id, r));
    // load() + addRemoveCB: gridstack calls back for each id with `add=true` and we hand it the EXISTING
    // node instead of letting it create an empty widget. Going through load() is what makes a restore into
    // an already-narrow grid cache the wide layout (see GridEngine.registerAll).
    grid.load(rects, ((_parent: HTMLElement, w: GridStackNode, add: boolean) => (add ? byId.get(String(w.id)) : undefined)) as never);
  }

  /** Adopt one node. Not for startup (use registerAll): per-item adds into an already-narrow grid scramble its reading order. */
  add(id: string, el: HTMLElement, rect: PanelRect): void {
    const item = el as GridItemHTMLElement;
    this.els.set(id, item);
    item.hidden = false;
    this.g().makeWidget(item, this.widget(id, sanitizeRects([rect], this.opts.columns, this.opts.minH)[0]!));
  }

  unregister(id: string): PanelRect | null {
    const el = this.els.get(id);
    const r = this.rect(id);
    if (!el || !r) return null;
    // removeDOM=false keeps the node (and its chart instance), but leaves it absolutely positioned at its
    // old slot (S3), so hide it as well.
    this.g().removeWidget(el, false);
    el.hidden = true;
    return r;
  }

  isRegistered(id: string): boolean {
    return !!this.els.get(id)?.gridstackNode;
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
    // saveContent=false: do not serialise innerHTML (it would hold the whole chart DOM).
    return (this.g().save(false, false) as GridStackNode[]).map(toRect);
  }

  load(list: PanelRect[]): void {
    const known = sanitizeRects(list, this.opts.columns, this.opts.minH).filter((r) => this.isRegistered(r.id));
    // addRemove=false: never create widgets for unknown ids and never remove panels missing from the list.
    this.g().load(known.map((r) => this.widget(r.id, r)), false);
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

  destroy(): void {
    // removeDOM=false: leave the panel DOM alone, only tear down listeners, drag and drop and the ResizeObserver.
    this.g().destroy(false);
    this.grid = null;
    this.els.clear();
    this.changeCbs.clear();
    this.columnCbs.clear();
  }
}

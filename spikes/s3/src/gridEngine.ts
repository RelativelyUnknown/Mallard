/**
 * S3 spike: the `GridEngine` interface described in the plan (Stream D) + the pure helpers around it
 * (NO gridstack import here, so everything in this file is unit-testable under jsdom).
 *
 * `GridEngine` is the ONLY thing the dashboard/keyboard code talks to; tests use `FakeEngine`
 * (fakeEngine.ts). The real gridstack adapter lives in gridstackEngine.ts.
 */
/** Persisted shape of one panel (the plan's LayoutV2.panels[] element, minus `hidden`). */
export interface PanelRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ChangeInfo {
  /** Rects of every tracked panel, in visual (row-major) order. */
  rects: PanelRect[];
  /** Active column count when the change happened. */
  column: number;
  /** True while gridstack is applying a column switch / load (ignore for persistence). */
  ignorable: boolean;
}

export interface EngineOptions {
  /** Wide column count (4 in the plan; 12 is the alternative). */
  columns: number;
  /** Below this window width the grid collapses to ONE column. */
  narrowBelowPx: number;
  cellHeight: number;
  /** gridstack margin per side; the visible gap between panels is 2x this. */
  margin: number;
  animate: boolean;
  /** CSS selector of the pointer drag handle inside each panel. */
  handle: string;
  /** CSS selector of descendants that must NOT start a drag. */
  dragCancel: string;
  minH: number;
}

export interface GridEngine {
  mount(root: HTMLElement, opts: EngineOptions): void;
  /** Adopt an existing DOM node (keeps chart instances) as a tracked panel. */
  register(id: string, el: HTMLElement, rect: PanelRect): void;
  /**
   * Adopt several nodes at once from persisted WIDE rects. Use this at startup instead of N x register():
   * it goes through gridstack's load() so a layout restored while the grid is ALREADY 1-column is cached
   * as the wide layout (S3: per-item register() in a 1-column grid loses the wide coordinates).
   */
  registerAll(entries: ReadonlyArray<{ id: string; el: HTMLElement; rect: PanelRect }>): void;
  /** Remove from the grid but KEEP the DOM node (hidden / no-data panels). */
  unregister(id: string): PanelRect | null;
  /** Re-adopt a previously unregistered node. */
  reregister(id: string, rect?: Partial<PanelRect>): void;
  isRegistered(id: string): boolean;
  setStatic(isStatic: boolean): void;
  isStatic(): boolean;
  /** Apply a partial rect; returns the rect that actually resulted (after collisions). */
  update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null;
  rect(id: string): PanelRect | null;
  /** Tracked panels' rects, row-major. */
  save(): PanelRect[];
  /** Apply saved rects. Unknown ids are ignored; panels not in the list stay put. */
  load(list: PanelRect[]): void;
  columns(): number;
  onChange(cb: (info: ChangeInfo) => void): () => void;
  onColumnChange(cb: (columns: number) => void): () => void;
  destroy(): void;
}

/**
 * Pure input sanitiser for persisted/migrated rects. S3 finding: gridstack's `load()` does NOT clamp
 * an out-of-range saved rect to the current column count (w:9 at x:3 on a 4-col grid stayed 3,99,9x7
 * and broke compaction), because it treats oversize layouts as "saved for a wider grid". Since our
 * persisted layout is always for `columns` wide, clamp here (unit-testable without a DOM).
 */
export function sanitizeRects(list: readonly PanelRect[], columns: number, minH: number): PanelRect[] {
  const seen = new Set<string>();
  const out: PanelRect[] = [];
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue;
    const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : d);
    const w = Math.min(Math.max(n(r.w, 1), 1), columns);
    const x = Math.min(Math.max(n(r.x, 0), 0), columns - w);
    out.push({ id: r.id, x, y: Math.max(n(r.y, 0), 0), w, h: Math.max(n(r.h, minH), minH) });
    seen.add(r.id);
  }
  return out;
}

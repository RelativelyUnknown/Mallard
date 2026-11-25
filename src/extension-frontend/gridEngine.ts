/**
 * The `GridEngine` interface: the ONLY thing the dashboard controller and the
 * keyboard layer talk to. gridstackEngine.ts is the real implementation (the
 * one file that imports gridstack); tests use a fake. No gridstack import here,
 * so everything in this file is unit-testable under jsdom.
 */
import { clampRect } from '../extension-backend/domain/layout';
import type { PanelRect } from '../extension-backend/domain/layout';

export type { PanelRect };

export interface ChangeInfo {
  /** Rects of every tracked panel, in visual (row-major) order. */
  rects: PanelRect[];
  /** Active column count when the change happened. */
  column: number;
  /** True while gridstack is applying a column switch / load (ignore for persistence). */
  ignorable: boolean;
}

export interface EngineOptions {
  /** Wide column count. */
  columns: number;
  /** Window width at or below which the grid collapses to ONE column. */
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
  /**
   * Adopt several existing DOM nodes (keeping their chart instances) from
   * persisted WIDE rects. Use this at startup instead of one register() per
   * node: it goes through gridstack's load(), so a layout restored while the
   * grid is ALREADY one column wide is cached as the wide layout.
   */
  registerAll(entries: ReadonlyArray<{ id: string; el: HTMLElement; rect: PanelRect }>): void;
  /** Remove from the grid but KEEP the DOM node (hidden / no-data panels). Returns the rect it had. */
  unregister(id: string): PanelRect | null;
  /** Adopt one node (a panel shown after startup, or shown again) at `rect`. */
  add(id: string, el: HTMLElement, rect: PanelRect): void;
  isRegistered(id: string): boolean;
  setStatic(isStatic: boolean): void;
  isStatic(): boolean;
  /** Apply a partial rect; returns the rect that actually resulted (after collisions), or null for an unknown id. */
  update(id: string, patch: Partial<Omit<PanelRect, 'id'>>): PanelRect | null;
  rect(id: string): PanelRect | null;
  /** Tracked panels' rects, row-major. */
  save(): PanelRect[];
  /** Apply saved rects. Unknown and unregistered ids are ignored; panels not in the list stay put. */
  load(list: PanelRect[]): void;
  columns(): number;
  onChange(cb: (info: ChangeInfo) => void): () => void;
  onColumnChange(cb: (columns: number) => void): () => void;
  destroy(): void;
}

/**
 * Pure input sanitiser for persisted/migrated rects. S3 finding: gridstack's
 * `load()` does NOT clamp an out-of-range saved rect to the current column
 * count (w:9 at x:3 on a 4-column grid stayed 3,99,9x7 and broke compaction),
 * because it treats oversize layouts as "saved for a wider grid". Our layout is
 * always for `columns` wide, so clamp here. Duplicate and malformed entries are
 * dropped.
 */
export function sanitizeRects(list: readonly PanelRect[], columns: number, minH: number): PanelRect[] {
  const seen = new Set<string>();
  const out: PanelRect[] = [];
  for (const r of list) {
    if (!r || typeof r.id !== 'string' || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, ...clampRect(r, columns, minH) });
  }
  return out;
}

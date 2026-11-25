/**
 * Pure model of the dashboard layout (`LayoutV2`, persisted in globalState as
 * `mallard.layout.v2`). Free of vscode/DOM so the webview bundle and the host
 * share it and unit tests can drive it directly.
 *
 * Layout v2 is a rectangle per panel on a fixed 4-column grid: `x`/`w` are
 * columns, `y`/`h` are 24 px row units (see the frontend's gridConstants.ts for
 * the pixel sizes). The previous v1 layout was an ordered array of
 * `{id, span, hidden, size}`; {@link migrateV1} turns one into the other.
 *
 * Migration rule (documented here because it is the contract the golden
 * `layout` recording pins):
 *  - `span` becomes `w`, rounded and clamped to [1, 4] (a non-number is 1);
 *  - `size` becomes `h` through {@link TIER_ROWS} (compact 7, normal 13,
 *    tall 21 rows; a missing or unknown size is "normal");
 *  - array order becomes flow: each VISIBLE panel, in array order, takes the
 *    first free spot scanning rows top to bottom and columns left to right
 *    (what gridstack's `mode: 'top'` auto-placement does on a 4-column grid, so
 *    the migrated grid is already compact and gravity never moves anything);
 *    HIDDEN panels are then placed the same way after every visible one, so
 *    showing one later puts it after the visible panels, not in the middle;
 *  - unknown ids are kept (a newer build's panel survives a save by this one),
 *    hidden flags are kept, duplicate and malformed entries are dropped, and
 *    default panels missing from the stored layout are appended at their
 *    default size and visibility;
 *  - the output array keeps the input order.
 */
import type { LayoutV2 } from './contracts';
import type { ConfigPanelLayout, PanelSize } from './types';

export type PanelV2 = LayoutV2['panels'][number];
export type PanelRect = Pick<PanelV2, 'id' | 'x' | 'y' | 'w' | 'h'>;

/** Wide column count; the grid collapses to one column below the webview's 700 px breakpoint. */
export const GRID_COLUMNS = 4;
/** Row count per v1 height tier: a chart body of about 120 / 260 / 455 px at 24 px rows. */
export const TIER_ROWS: Readonly<Record<PanelSize, number>> = { compact: 7, normal: 13, tall: 21 };
/** Smallest panel height (the compact tier). */
export const MIN_ROWS = TIER_ROWS.compact;
/** Sanity bound for a persisted or received row coordinate. */
export const MAX_ROWS = 1000;

/** v1 layout entry: the shape persisted under `mallard.layout.v1` (and written by config.json's `dashboard.panels`). */
export interface LayoutV1Panel {
  id: string;
  span: number;
  hidden: boolean;
  size?: PanelSize;
}
export type LayoutV1 = LayoutV1Panel[];

/**
 * THE panel list: every dashboard panel with its default width, visibility and
 * height tier. Stock charts render by default, extras start hidden until added
 * from the "Add chart" picker. `CHART_REGISTRY` ids are typed from this list
 * and a parity test pins the rest (registry tier vs default visibility).
 */
const DEFAULT_PANELS = [
  { id: 'daily', span: 2, hidden: false, size: 'normal' },
  { id: 'heatmap', span: 2, hidden: false, size: 'normal' },
  { id: 'models', span: 1, hidden: false, size: 'normal' },
  { id: 'sankey', span: 1, hidden: false, size: 'normal' },
  { id: 'category', span: 1, hidden: false, size: 'normal' },
  { id: 'cumulative', span: 1, hidden: false, size: 'normal' },
  { id: 'weekday', span: 1, hidden: false, size: 'normal' },
  { id: 'hourly', span: 1, hidden: false, size: 'normal' },
  { id: 'repos', span: 1, hidden: true, size: 'normal' },
  { id: 'categoryTrend', span: 2, hidden: true, size: 'normal' },
  { id: 'tokens', span: 1, hidden: true, size: 'normal' },
  { id: 'billing', span: 1, hidden: true, size: 'normal' },
  { id: 'languages', span: 1, hidden: true, size: 'normal' },
] as const satisfies readonly LayoutV1Panel[];

export type PanelId = (typeof DEFAULT_PANELS)[number]['id'];
export const PANEL_IDS: readonly PanelId[] = DEFAULT_PANELS.map((p) => p.id);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const roundOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;

/** Clamp a rectangle onto the grid: width 1..columns, x inside it, y >= 0, height >= minH. Non-numbers take defaults. */
export function clampRect(
  r: Partial<Record<'x' | 'y' | 'w' | 'h', unknown>>,
  columns: number = GRID_COLUMNS,
  minH: number = MIN_ROWS,
): { x: number; y: number; w: number; h: number } {
  const w = Math.min(Math.max(roundOr(r.w, 1), 1), columns);
  return {
    x: Math.min(Math.max(roundOr(r.x, 0), 0), columns - w),
    y: Math.min(Math.max(roundOr(r.y, 0), 0), MAX_ROWS),
    w,
    h: Math.min(Math.max(roundOr(r.h, minH), minH), MAX_ROWS),
  };
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const intersects = (a: Box, b: Box): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** First free `w` x `h` spot among `taken`, scanning rows then columns (gridstack's `findEmptyPosition`). */
function firstFit(taken: readonly Box[], w: number, h: number): { x: number; y: number } {
  for (let cell = 0; ; cell++) {
    const x = cell % GRID_COLUMNS;
    const y = Math.floor(cell / GRID_COLUMNS);
    if (x + w <= GRID_COLUMNS && !taken.some((t) => intersects({ x, y, w, h }, t))) return { x, y };
  }
}

/** Pack panels in flow order (visible ones first, then hidden ones, each in array order); output keeps input order. */
export function flowPack(items: ReadonlyArray<{ id: string; w: number; h: number; hidden: boolean }>): PanelV2[] {
  const placed = new Map<string, Box>();
  const taken: Box[] = [];
  for (const it of [...items.filter((i) => !i.hidden), ...items.filter((i) => i.hidden)]) {
    const box = { ...firstFit(taken, it.w, it.h), w: it.w, h: it.h };
    taken.push(box);
    placed.set(it.id, box);
  }
  return items.map((it) => ({ id: it.id, ...placed.get(it.id)!, hidden: it.hidden }));
}

/** The default layout: the v1 default panels run through the migrator's flow packing. */
export function defaultLayout(): LayoutV2 {
  return {
    version: 2,
    panels: flowPack(DEFAULT_PANELS.map((p) => ({ id: p.id, w: p.span, h: TIER_ROWS[p.size], hidden: p.hidden }))),
  };
}

const VALID_SIZES: ReadonlySet<unknown> = new Set<PanelSize>(['compact', 'normal', 'tall']);

/** Clamp a stored span to a valid integer in [1, GRID_COLUMNS]. */
function validSpan(s: unknown): number {
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? Math.min(GRID_COLUMNS, Math.max(1, n)) : 1;
}

/**
 * Clean a stored v1 layout: keep valid entries in order (span clamped, hidden
 * coerced to a boolean, size defaulted to "normal"), drop duplicates and
 * malformed entries, KEEP unknown ids, then append the default panels that are
 * missing. Anything that is not an array counts as empty.
 */
export function normalizeV1(stored: unknown): LayoutV1 {
  const seen = new Set<string>();
  const out: LayoutV1 = [];
  for (const p of Array.isArray(stored) ? stored : []) {
    if (!isRecord(p) || typeof p.id !== 'string' || p.id === '' || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      span: validSpan(p.span),
      hidden: Boolean(p.hidden),
      size: VALID_SIZES.has(p.size) ? (p.size as PanelSize) : 'normal',
    });
  }
  for (const def of DEFAULT_PANELS) if (!seen.has(def.id)) out.push({ ...def });
  return out;
}

/** v1 layout (any stored shape) to v2 under the rule in this file's header. Pure; runs once per profile (see LayoutStore). */
export function migrateV1(stored: unknown): LayoutV2 {
  return {
    version: 2,
    panels: flowPack(normalizeV1(stored).map((p) => ({ id: p.id, w: p.span, h: TIER_ROWS[p.size ?? 'normal'], hidden: p.hidden }))),
  };
}

/**
 * Read a stored v2 layout. Returns undefined when `raw` is not a version-2
 * object (a missing key, a future version, garbage), so the caller can fall
 * back to migration or the default. Otherwise: entries are sanitised (rects
 * clamped onto the grid, duplicates and malformed entries dropped, unknown ids
 * kept) and default panels the stored layout lacks are appended in the first
 * free spot at their default size.
 */
export function parseLayoutV2(raw: unknown): LayoutV2 | undefined {
  if (!isRecord(raw) || raw.version !== 2 || !Array.isArray(raw.panels)) return undefined;
  const seen = new Set<string>();
  const panels: PanelV2[] = [];
  for (const p of raw.panels) {
    if (!isRecord(p) || typeof p.id !== 'string' || p.id === '' || seen.has(p.id)) continue;
    seen.add(p.id);
    panels.push({ id: p.id, ...clampRect(p), hidden: Boolean(p.hidden) });
  }
  for (const def of defaultLayout().panels) {
    if (seen.has(def.id)) continue;
    panels.push({ ...def, ...firstFit(panels, def.w, def.h) });
  }
  return { version: 2, panels };
}

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

/**
 * Strict structural check for layouts crossing the host/webview boundary (a
 * `layout` or `setLayout` message): version 2, a bounded list of panels with
 * unique non-empty string ids, integer rectangles inside the grid and a real
 * boolean `hidden`. Nothing is coerced; a layout that fails is dropped whole.
 */
export function isLayoutV2(v: unknown): v is LayoutV2 {
  if (!isRecord(v) || v.version !== 2 || !Array.isArray(v.panels) || v.panels.length > 200) return false;
  const ids = new Set<string>();
  return v.panels.every((p) => {
    if (!isRecord(p) || typeof p.id !== 'string' || p.id === '' || p.id.length > 128 || ids.has(p.id)) return false;
    ids.add(p.id);
    return (
      isInt(p.w, 1, GRID_COLUMNS) &&
      isInt(p.x, 0, GRID_COLUMNS - (p.w as number)) &&
      isInt(p.y, 0, MAX_ROWS) &&
      isInt(p.h, 1, MAX_ROWS) &&
      typeof p.hidden === 'boolean'
    );
  });
}

// ── Legacy config.json `dashboard.panels` (read only by the one-time importer) ──────────

/**
 * Parse a CSS grid-column shorthand like "span 3" into a span integer in
 * [1, GRID_COLUMNS]. Anything that does not match "span N" is 1.
 */
export function gridColumnToSpan(gridColumn: string | undefined): number {
  const m = /^span\s+(\d+)$/i.exec((gridColumn ?? '').trim());
  return m ? validSpan(parseInt(m[1]!, 10)) : 1;
}

/**
 * Convert config.json's legacy `dashboard.panels` block into a v1 layout. An
 * entry without `gridColumn` gets that panel's default span; a missing `hidden`
 * means visible and a missing `size` means "normal". {@link migrateV1} turns
 * the result into the current layout.
 */
export function configPanelsToLayout(panels: ConfigPanelLayout[] | undefined): LayoutV1 {
  return normalizeV1(
    (panels ?? []).map((p) => ({
      id: p.id,
      span: p.gridColumn !== undefined ? gridColumnToSpan(p.gridColumn) : (DEFAULT_PANELS.find((d) => d.id === p.id)?.span ?? 1),
      hidden: Boolean(p.hidden),
      size: p.size,
    })),
  );
}

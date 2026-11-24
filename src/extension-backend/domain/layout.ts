/* c8 ignore next */
/**
 * Pure helpers for the dashboard layout. Kept free of vscode/DOM so they can be
 * shared and unit-tested.
 */
import {
  ConfigPanelLayout,
  DashboardLayout,
  DashboardPanelLayout,
  DEFAULT_DASHBOARD_LAYOUT,
  MAX_PANEL_SPAN,
  PanelSize,
} from './types';

const VALID_SIZES = new Set<PanelSize>(['compact', 'normal', 'tall']);
function validSize(s: unknown): PanelSize | undefined {
  return VALID_SIZES.has(s as PanelSize) ? (s as PanelSize) : undefined;
}

/** Usable column count: an integer in [1, MAX_PANEL_SPAN]; anything unusable means "no narrower than the maximum". */
function validColumns(columns: unknown): number {
  const n = Math.round(Number(columns));
  return Number.isFinite(n) ? Math.min(MAX_PANEL_SPAN, Math.max(1, n)) : MAX_PANEL_SPAN;
}

/** Clamp a stored span to a valid integer in [1, maxSpan] (maxSpan = the grid's column count). */
function validSpan(s: unknown, maxSpan: number = MAX_PANEL_SPAN): number {
  const n = Math.round(Number(s));
  if (!Number.isFinite(n)) return 1;
  return Math.min(maxSpan, Math.max(1, n));
}

/** The span a panel gets when config.json does not state one: its default-layout span, else 1. */
function defaultSpan(id: string): number {
  return DEFAULT_DASHBOARD_LAYOUT.find((d) => d.id === id)?.span ?? 1;
}

/**
 * Keep stored entries (preserving their order/span/hidden), drop duplicates,
 * and append any panels missing from the stored layout using defaults. Panel
 * ids this version does not know (a newer config, or a panel since removed)
 * are PRESERVED so a save never silently deletes them; the dashboard ignores
 * ids it has no panel for. Spans are clamped to `columns` (the grid's column
 * count, at most MAX_PANEL_SPAN). This makes saved layouts forward/backward
 * compatible when the panel set changes between versions.
 */
export function normalizeLayout(stored?: DashboardLayout, columns: number = MAX_PANEL_SPAN): DashboardLayout {
  const maxSpan = validColumns(columns);
  const seen = new Set<string>();
  const out: DashboardPanelLayout[] = [];

  for (const p of stored ?? []) {
    if (!p || typeof p.id !== 'string' || p.id === '' || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push({
      id: p.id,
      span: validSpan(p.span, maxSpan),
      hidden: Boolean(p.hidden),
      size: validSize(p.size) ?? 'normal',
    });
  }
  for (const def of DEFAULT_DASHBOARD_LAYOUT) {
    if (!seen.has(def.id)) out.push({ ...def, span: Math.min(def.span, maxSpan) });
  }
  return out;
}

/**
 * Parse a CSS grid-column shorthand like "span 3" into a span integer in
 * [1, MAX_PANEL_SPAN]. Anything that doesn't match "span N" defaults to 1.
 */
export function gridColumnToSpan(gridColumn: string | undefined): number {
  if (!gridColumn) return 1;
  const m = /^span\s+(\d+)$/i.exec(gridColumn.trim());
  if (!m) return 1;
  return validSpan(parseInt(m[1]!, 10));
}

/**
 * Convert the config.json `dashboard.panels` block into a DashboardLayout.
 * Duplicates are dropped and missing panels appended by {@link normalizeLayout}
 * (unknown ids are kept), so a hand-edited file can never break the grid. An
 * entry without `gridColumn` gets that panel's default span; a missing
 * `hidden` means visible and a missing `size` means "normal".
 */
export function configPanelsToLayout(panels: ConfigPanelLayout[] | undefined, columns?: number): DashboardLayout {
  const raw: DashboardPanelLayout[] = (panels ?? []).map((p) => ({
    id: p.id,
    span: p.gridColumn !== undefined ? gridColumnToSpan(p.gridColumn) : defaultSpan(p.id),
    hidden: Boolean(p.hidden),
    size: validSize(p.size) ?? 'normal',
  }));
  return normalizeLayout(raw, columns);
}

/**
 * Serialize a DashboardLayout into the config.json `dashboard.panels` shape,
 * omitting values that match the defaults so the file stays readable: no
 * `gridColumn` for a panel at its default span, no `hidden` unless true (absent
 * means visible), no `size` unless it differs from "normal". Unknown panel ids
 * round-trip untouched.
 */
export function layoutToConfigPanels(layout: DashboardLayout): ConfigPanelLayout[] {
  return normalizeLayout(layout).map((p) => ({
    id: p.id,
    ...(p.span !== defaultSpan(p.id) ? { gridColumn: `span ${p.span}` } : {}),
    ...(p.hidden ? { hidden: true } : {}),
    ...(p.size && p.size !== 'normal' ? { size: p.size } : {}),
  }));
}

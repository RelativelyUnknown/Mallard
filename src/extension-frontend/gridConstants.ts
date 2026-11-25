/**
 * Dashboard grid constants (measured in Chromium by spike S3).
 *
 * gridstack sizes a panel as `h * CELL_HEIGHT - 2 * MARGIN` px. Inside it the
 * panel has a 1 px border top and bottom and a 39 px header, so the chart BODY
 * is
 *
 *     bodyPx = h * 24 - 12 - 2 - 39 = h * 24 - 53
 *
 *   compact  7 rows  -> body 115 px   (the old tier: 120)
 *   normal  13 rows  -> body 259 px   (260)
 *   tall    21 rows  -> body 451 px   (455)
 *
 * The row counts themselves live in domain/layout.ts (the v1 -> v2 migrator
 * needs them too); this file adds the pixel side and the engine option set.
 */
import { GRID_COLUMNS, MIN_ROWS, TIER_ROWS } from '../extension-backend/domain/layout';
import type { EngineOptions } from './gridEngine';

export const COLUMNS = GRID_COLUMNS;
/** Window width at or below which the grid collapses to ONE column (the old `@media (max-width: 700px)`). */
export const NARROW_BELOW_PX = 700;
export const CELL_HEIGHT = 24;
/** gridstack margin PER SIDE: the visible gap between panels is 2 x 6 = 12 px (the old grid gap). */
export const MARGIN = 6;

export const TIER_NAMES = ['compact', 'normal', 'tall'] as const;
/** Row count per height tier, ascending (compact, normal, tall). */
export const TIER_ROW_LIST: readonly number[] = [TIER_ROWS.compact, TIER_ROWS.normal, TIER_ROWS.tall];
export { MIN_ROWS };

export const ENGINE_OPTIONS: EngineOptions = {
  columns: COLUMNS,
  narrowBelowPx: NARROW_BELOW_PX,
  cellHeight: CELL_HEIGHT,
  margin: MARGIN,
  animate: false,
  handle: '.wv-panel-header',
  dragCancel: '.wv-panel-hide',
  minH: MIN_ROWS,
};

/** Chart body height in px for a panel `rows` grid rows tall (see the table above). */
export const bodyPx = (rows: number): number => rows * CELL_HEIGHT - 53;

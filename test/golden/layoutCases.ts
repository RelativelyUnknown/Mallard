/**
 * Inputs of the layout golden (test/golden/expected/layout.json) and of the v1 -> v2 migrator's unit
 * tests: stored v1 layouts and legacy config.json `dashboard.panels` blocks, junk included.
 */
import { normalizeV1 } from '../../src/extension-backend/domain/layout';
import type { ConfigPanelLayout } from '../../src/extension-backend/domain/types';

const L = (...panels: unknown[]): unknown[] => panels;

/**
 * Stored v1 layouts (an array of `{id, span, hidden, size}`, whatever junk the profile holds): the
 * INPUTS of the v1 -> v2 migrator. Exported so the migrator's unit tests drive the same shapes.
 */
export const LAYOUT_V1_CASES: Array<[string, unknown]> = [
  ['undefined', undefined],
  ['not an array', { id: 'daily', span: 2 }],
  ['empty array', L()],
  ['legacy: no size, no hidden', L({ id: 'models', span: 1 }, { id: 'daily', span: 2 })],
  ['legacy: span only, order kept', L({ id: 'tokens', span: 2 }, { id: 'daily', span: 1, hidden: true })],
  ['duplicates keep the first', L({ id: 'daily', span: 2 }, { id: 'daily', span: 1, hidden: true })],
  ['unknown ids are preserved', L({ id: 'future-panel', span: 3, hidden: false, size: 'tall' }, { id: 'daily', span: 1 })],
  ['bad ids are dropped', L(null, { id: '' }, { id: 7 }, { span: 2 }, 'models', { id: 'weekday', span: 2 })],
  ['spans clamp to 1..4 and round', L({ id: 'daily', span: 0 }, { id: 'heatmap', span: 9 }, { id: 'models', span: 2.6 }, { id: 'sankey', span: '3' }, { id: 'category', span: 'wide' }, { id: 'cumulative', span: NaN })],
  ['sizes: valid, invalid, missing', L({ id: 'daily', span: 2, size: 'compact' }, { id: 'heatmap', span: 2, size: 'huge' }, { id: 'models', span: 1, size: 'tall' }, { id: 'sankey', span: 1 })],
  ['hidden is coerced to boolean', L({ id: 'daily', span: 1, hidden: 1 }, { id: 'models', span: 1, hidden: 'yes' }, { id: 'sankey', span: 1, hidden: 0 }, { id: 'category', span: 1, hidden: null })],
  ['full default round trip', normalizeV1([]).map((p) => ({ ...p, hidden: !p.hidden }))],
  ['the default layout as shipped', normalizeV1([])],
  ['first fit fills the gap beside a wide panel', L({ id: 'daily', span: 3 }, { id: 'heatmap', span: 3 }, { id: 'models', span: 1 })],
  ['full-width panels stack', L({ id: 'daily', span: 4, size: 'tall' }, { id: 'heatmap', span: 4, size: 'compact' }, { id: 'models', span: 4 })],
  ['hidden panels are packed after the visible ones', L({ id: 'daily', span: 1, hidden: true }, { id: 'heatmap', span: 2 }, { id: 'models', span: 1 }, { id: 'sankey', span: 1, hidden: true })],
  ['a hidden panel can use the gap the visible ones leave', L({ id: 'daily', span: 3 }, { id: 'heatmap', span: 1, hidden: true }, { id: 'models', span: 3 })],
];

/** The legacy `dashboard.panels` of config.json (stream B's importer feeds these through `configPanelsToLayout`, then the migrator). */
export const LAYOUT_CONFIG_CASES: Array<[string, ConfigPanelLayout[] | undefined]> = [
  ['undefined panels', undefined],
  ['empty panels', []],
  ['gridColumn spans', [{ id: 'daily', gridColumn: 'span 1' }, { id: 'models', gridColumn: 'span 2' }, { id: 'sankey', gridColumn: 'SPAN 3' }]],
  ['gridColumn out of range clamps', [{ id: 'daily', gridColumn: 'span 9' }, { id: 'models', gridColumn: 'span 0' }]],
  ['gridColumn malformed defaults to 1', [{ id: 'daily', gridColumn: 'span' }, { id: 'models', gridColumn: '2' }, { id: 'sankey', gridColumn: '1 / 3' }, { id: 'category', gridColumn: ' span  2 ' }]],
  ['missing gridColumn takes the panel default', [{ id: 'daily' }, { id: 'heatmap' }, { id: 'models' }, { id: 'categoryTrend' }, { id: 'unknown-panel' }]],
  ['hidden and size', [{ id: 'daily', hidden: true, size: 'tall' }, { id: 'models', size: 'compact' }, { id: 'sankey', size: 'bogus' as never }]],
  ['gridRow is ignored', [{ id: 'daily', gridColumn: 'span 2', gridRow: 'span 3' }]],
  ['duplicates and unknown ids', [{ id: 'daily', gridColumn: 'span 2' }, { id: 'daily', gridColumn: 'span 1' }, { id: 'zz-new', gridColumn: 'span 2' }]],
];

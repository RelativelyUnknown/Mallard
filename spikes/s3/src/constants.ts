/**
 * Layout constants proposed by spike S3 (measured in Chromium, run-spike.mjs section 4).
 *
 * gridstack sizes a panel as `h * CELL_HEIGHT - 2 * MARGIN` px (the item box minus the inset of the
 * content on both sides). Inside it the repo's panel has a 1 px border top+bottom and a header of 39 px,
 * so the chart BODY (what `.wv-chart-body` is today) is:
 *
 *     bodyPx = h * 24 - 12 - 2 - 39 = h * 24 - 53        =>   h = round((bodyPx + 53) / 24)
 *
 *   compact  body 120  ->  h = 7   (measured body 115, -5 px)
 *   normal   body 260  ->  h = 13  (measured body 259, -1 px)
 *   tall     body 455  ->  h = 21  (measured body 451, -4 px)
 *
 * (Mini/heatmap bodies of 200 px map to h = 11, 120 px to h = 7.) Alternatives measured and rejected:
 * cellHeight 8 gives rows {22, 39, 63} (+3/-1/-4) with finer mouse-resize steps but 3x larger numbers
 * in the persisted layout; 25/26 px cells cannot hit all three tiers within 6 px.
 */
export const COLUMNS = 4;
/** Window width at/below which the grid collapses to ONE column (same boundary as `@media (max-width:700px)`). */
export const NARROW_BELOW_PX = 700;
export const CELL_HEIGHT = 24;
/** gridstack margin PER SIDE: the visible gap between panels is 2 x 6 = 12 px (= --w-s3, today's grid gap). */
export const MARGIN = 6;

export const TIER_NAMES = ['compact', 'normal', 'tall'] as const;
export const TIER_ROWS = [7, 13, 21] as const;
export const MIN_ROWS = TIER_ROWS[0];

/** Row count for an arbitrary legacy body height in px (v1 -> v2 migration of `data-size` / custom bodies). */
export const rowsForBodyPx = (bodyPx: number): number => Math.max(MIN_ROWS, Math.round((bodyPx + 53) / CELL_HEIGHT));

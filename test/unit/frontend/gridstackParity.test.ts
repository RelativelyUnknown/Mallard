/**
 * The v1 -> v2 migrator packs panels itself (pure, no DOM). Its rule is documented as "identical to
 * gridstack's `mode: 'top'` auto-placement on a 4-column grid"; this pins that claim against the real
 * library, over the golden layout inputs and a seeded random sweep.
 */
import { strict as assert } from 'assert';
import { GridStack } from 'gridstack';
import { flowPack, migrateV1, TIER_ROWS } from '../../../src/extension-backend/domain/layout';
import type { PanelV2 } from '../../../src/extension-backend/domain/layout';
import { CELL_HEIGHT, COLUMNS, MARGIN, MIN_ROWS } from '../../../src/extension-frontend/gridConstants';
import { LAYOUT_V1_CASES } from '../../golden/layoutCases';

const g = globalThis as unknown as { ResizeObserver?: unknown };

interface Item {
  id: string;
  w: number;
  h: number;
}

function newGrid(): { grid: GridStack; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const grid = GridStack.init(
    { column: COLUMNS, mode: 'top', cellHeight: CELL_HEIGHT, margin: MARGIN, animate: false, staticGrid: true, auto: false },
    root,
  )!;
  return { grid, root };
}

const positions = (grid: GridStack): Map<string, string> =>
  new Map((grid.save(false, false) as Array<{ id: string; x?: number; y?: number }>).map((n) => [n.id, `${n.x ?? 0},${n.y ?? 0}`]));

/** gridstack's own placement of `items` in order, with no coordinates given. */
function autoPlaced(items: Item[]): Map<string, string> {
  const { grid, root } = newGrid();
  for (const it of items) grid.addWidget({ id: it.id, w: it.w, h: it.h, minW: 1, minH: MIN_ROWS });
  const out = positions(grid);
  grid.destroy(false);
  root.remove();
  return out;
}

describe('v1 -> v2 packing is what gridstack does', () => {
  let stubbed = false;
  before(() => {
    if (!g.ResizeObserver) {
      g.ResizeObserver = class {
        observe() {}
        unobserve() {}
        disconnect() {}
      };
      stubbed = true;
    }
  });
  after(() => {
    if (stubbed) delete g.ResizeObserver;
  });

  const visibleOf = (panels: PanelV2[]): Item[] => panels.filter((p) => !p.hidden).map((p) => ({ id: p.id, w: p.w, h: p.h }));

  for (const [label, input] of LAYOUT_V1_CASES) {
    it(`${label}: the visible panels land where gridstack would auto-place them, and gravity moves nothing`, () => {
      const { panels } = migrateV1(input);
      const visible = visibleOf(panels);
      const placed = autoPlaced(visible);
      for (const p of panels.filter((q) => !q.hidden)) assert.equal(placed.get(p.id), `${p.x},${p.y}`, p.id);

      // The migrated rects, loaded explicitly, are a fixed point of 'top' gravity.
      const { grid, root } = newGrid();
      grid.load(visible.map((v) => ({ ...v, x: panels.find((p) => p.id === v.id)!.x, y: panels.find((p) => p.id === v.id)!.y, minW: 1, minH: MIN_ROWS })));
      const loaded = positions(grid);
      for (const p of panels.filter((q) => !q.hidden)) assert.equal(loaded.get(p.id), `${p.x},${p.y}`, `${p.id} stayed put`);
      grid.destroy(false);
      root.remove();
    });
  }

  it('matches gridstack on 200 seeded random layouts of 1..14 panels', () => {
    let seed = 20260101;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const tiers = [TIER_ROWS.compact, TIER_ROWS.normal, TIER_ROWS.tall];
    for (let t = 0; t < 200; t++) {
      const items = Array.from({ length: 1 + Math.floor(rnd() * 14) }, (_, i) => ({
        id: `p${i}`,
        w: 1 + Math.floor(rnd() * COLUMNS),
        h: tiers[Math.floor(rnd() * tiers.length)]!,
      }));
      const placed = autoPlaced(items);
      for (const p of flowPack(items.map((i) => ({ ...i, hidden: false })))) assert.equal(placed.get(p.id), `${p.x},${p.y}`, `case ${t} ${p.id}`);
    }
  });
});

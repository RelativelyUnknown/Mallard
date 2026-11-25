import { strict as assert } from 'assert';
import {
  clampRect,
  configPanelsToLayout,
  defaultLayout,
  flowPack,
  GRID_COLUMNS,
  gridColumnToSpan,
  isLayoutV2,
  MAX_ROWS,
  migrateV1,
  MIN_ROWS,
  normalizeV1,
  PANEL_IDS,
  parseLayoutV2,
  TIER_ROWS,
} from '../../src/extension-backend/domain/layout';
import type { PanelV2 } from '../../src/extension-backend/domain/layout';
import { LAYOUT_CONFIG_CASES, LAYOUT_V1_CASES } from '../golden/layoutCases';

const byId = (panels: readonly PanelV2[], id: string): PanelV2 => panels.find((p) => p.id === id)!;
const rect = (p: PanelV2): string => `${p.x},${p.y},${p.w}x${p.h}`;
const overlaps = (a: PanelV2, b: PanelV2): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe('layout v2: the default layout and the panel list', () => {
  it('lists the 13 panels once and defaults the stock charts visible, the extras hidden', () => {
    assert.equal(PANEL_IDS.length, 13);
    assert.equal(new Set(PANEL_IDS).size, 13);
    const { panels } = defaultLayout();
    assert.deepEqual(panels.map((p) => p.id), [...PANEL_IDS]);
    assert.deepEqual(panels.filter((p) => p.hidden).map((p) => p.id), ['repos', 'categoryTrend', 'tokens', 'billing', 'languages']);
  });

  it('is the migrated default of the v1 layout: daily and heatmap 2 wide, everything "normal" (13 rows), flowed', () => {
    const { version, panels } = defaultLayout();
    assert.equal(version, 2);
    assert.deepEqual(panels.slice(0, 8).map(rect), ['0,0,2x13', '2,0,2x13', '0,13,1x13', '1,13,1x13', '2,13,1x13', '3,13,1x13', '0,26,1x13', '1,26,1x13']);
    assert.deepEqual(defaultLayout(), migrateV1([]), 'an empty v1 layout IS the default');
    assert.deepEqual(defaultLayout(), migrateV1(undefined));
  });

  it('hands out a fresh object every time (callers mutate their copy)', () => {
    const a = defaultLayout();
    a.panels[0]!.x = 3;
    assert.equal(defaultLayout().panels[0]!.x, 0);
  });

  it('keeps the tier table and the grid constants the frontend builds on', () => {
    assert.deepEqual(TIER_ROWS, { compact: 7, normal: 13, tall: 21 });
    assert.equal(MIN_ROWS, 7);
    assert.equal(GRID_COLUMNS, 4);
  });
});

describe('layout v2: the v1 -> v2 migrator', () => {
  it('maps span to w, size tier to h, hidden through, in array order', () => {
    const out = migrateV1([
      { id: 'models', span: 3, hidden: false, size: 'tall' },
      { id: 'daily', span: 2, hidden: true, size: 'compact' },
      { id: 'sankey', span: 1, hidden: false },
    ]).panels;
    assert.deepEqual(out.slice(0, 3).map((p) => p.id), ['models', 'daily', 'sankey'], 'array order is kept');
    assert.deepEqual([out[0]!.w, out[0]!.h, out[0]!.hidden], [3, 21, false]);
    assert.deepEqual([out[1]!.w, out[1]!.h, out[1]!.hidden], [2, 7, true]);
    assert.deepEqual([out[2]!.w, out[2]!.h, out[2]!.hidden], [1, 13, false], 'a missing size is "normal"');
  });

  it('packs visible panels first-fit, rows top to bottom and columns left to right', () => {
    const out = migrateV1([
      { id: 'daily', span: 3 },
      { id: 'heatmap', span: 3 },
      { id: 'models', span: 1 },
    ]).panels;
    assert.equal(rect(byId(out, 'daily')), '0,0,3x13');
    assert.equal(rect(byId(out, 'heatmap')), '0,13,3x13', 'three more columns do not fit beside it');
    assert.equal(rect(byId(out, 'models')), '3,0,1x13', 'the 1-wide panel takes the gap beside the first');
  });

  it('packs hidden panels AFTER every visible one, so showing one adds it at the end instead of in the middle', () => {
    const out = migrateV1(
      PANEL_IDS.map((id) => ({ id, span: id === 'heatmap' ? 2 : 1, hidden: id !== 'heatmap' && id !== 'models' })),
    ).panels;
    assert.equal(rect(byId(out, 'heatmap')), '0,0,2x13');
    assert.equal(rect(byId(out, 'models')), '2,0,1x13');
    assert.equal(rect(byId(out, 'daily')), '3,0,1x13', 'the first hidden panel (first in the array) takes the next free cell');
    assert.equal(rect(byId(out, 'sankey')), '0,13,1x13', 'the next one follows');
    assert.equal(out[0]!.id, 'daily', 'the array keeps its order');
  });

  it('keeps unknown ids (a newer build\'s panel), drops duplicates and malformed entries, appends missing defaults', () => {
    const out = migrateV1([
      { id: 'daily', span: 2 },
      { id: 'daily', span: 1, hidden: true },
      { id: 'future-panel', span: 3, hidden: true, size: 'tall' },
      null,
      'models',
      { id: '', span: 1 },
      { id: 7, span: 1 },
      { span: 2 },
    ]).panels;
    assert.deepEqual([...out.map((p) => p.id)].sort(), [...PANEL_IDS, 'future-panel'].sort());
    assert.equal(out.filter((p) => p.id === 'daily').length, 1);
    assert.equal(byId(out, 'daily').w, 2, 'the first duplicate wins');
    assert.deepEqual(
      { w: byId(out, 'future-panel').w, h: byId(out, 'future-panel').h, hidden: byId(out, 'future-panel').hidden },
      { w: 3, h: 21, hidden: true },
    );
    assert.equal(byId(out, 'repos').hidden, true, 'a missing extra chart arrives hidden');
    assert.equal(byId(out, 'models').hidden, false, 'a missing stock chart arrives visible');
  });

  it('clamps spans to 1..4, coerces junk, and reads hidden as a boolean', () => {
    const w = (span: unknown) => migrateV1([{ id: 'daily', span }]).panels[0]!.w;
    assert.deepEqual([w(0), w(9), w(2.6), w('3'), w('wide'), w(NaN), w(undefined)], [1, 4, 3, 3, 1, 1, 1]);
    const hidden = (v: unknown) => migrateV1([{ id: 'daily', span: 1, hidden: v }]).panels[0]!.hidden;
    assert.deepEqual([hidden(1), hidden('yes'), hidden(0), hidden(null), hidden(undefined)], [true, true, false, false, false]);
    const h = (size: unknown) => migrateV1([{ id: 'daily', span: 1, size }]).panels[0]!.h;
    assert.deepEqual([h('compact'), h('normal'), h('tall'), h('huge'), h(5)], [7, 13, 21, 13, 13]);
  });

  it('treats anything that is not an array as an empty layout', () => {
    for (const junk of [undefined, null, 'daily', 7, { id: 'daily', span: 2 }]) assert.deepEqual(migrateV1(junk), defaultLayout());
  });

  it('reads the same things the v1 normaliser did: normalizeV1 keeps order, unknown ids and flags', () => {
    const v1 = normalizeV1([{ id: 'zz', span: 2, hidden: 1, size: 'tall' }, { id: 'daily', span: 9 }]);
    assert.deepEqual(v1.slice(0, 2), [
      { id: 'zz', span: 2, hidden: true, size: 'tall' },
      { id: 'daily', span: 4, hidden: false, size: 'normal' },
    ]);
    assert.equal(v1.length, PANEL_IDS.length + 1);
  });

  describe('over the golden layout inputs', () => {
    for (const [label, input] of LAYOUT_V1_CASES) {
      it(`${label}: a well-formed layout with every known panel once, no overlaps, nothing outside the grid`, () => {
        const { version, panels } = migrateV1(input);
        assert.equal(version, 2);
        assert.ok(isLayoutV2({ version, panels }), 'passes the strict message validator');
        for (const id of PANEL_IDS) assert.equal(panels.filter((p) => p.id === id).length, 1, id);
        for (const [i, a] of panels.entries()) for (const b of panels.slice(i + 1)) assert.equal(overlaps(a, b), false, `${a.id} vs ${b.id}`);
      });

      it(`${label}: visible panels are compact (nothing can move up or left), the packing mode:'top' leaves alone`, () => {
        const { panels } = migrateV1(input);
        const taken = panels.filter((p) => !p.hidden);
        for (const p of taken) {
          if (p.y > 0) {
            const up = { ...p, y: p.y - 1 };
            assert.ok(taken.some((q) => q !== p && overlaps(up, q)), `${p.id} could float up`);
          }
        }
      });
    }
  });
});

describe('layout v2: flowPack', () => {
  it('returns the input order and ids; an empty list packs to nothing', () => {
    assert.deepEqual(flowPack([]), []);
    const out = flowPack([
      { id: 'a', w: 4, h: 7, hidden: false },
      { id: 'b', w: 1, h: 7, hidden: false },
    ]);
    assert.deepEqual(out.map(rect), ['0,0,4x7', '0,7,1x7']);
  });
});

describe('layout v2: clampRect', () => {
  it('clamps width to the grid, x inside it, y to [0, MAX_ROWS], h up to the minimum', () => {
    assert.deepEqual(clampRect({ x: 9, y: -3, w: 99, h: 2 }), { x: 0, y: 0, w: 4, h: MIN_ROWS });
    assert.deepEqual(clampRect({ x: 3, y: 5, w: 2, h: 13 }), { x: 2, y: 5, w: 2, h: 13 });
    assert.deepEqual(clampRect({ x: 1.6, y: 2.4, w: 1.2, h: 13.5 }), { x: 2, y: 2, w: 1, h: 14 });
    assert.equal(clampRect({ x: 0, y: 99999, w: 1, h: 99999 }).y, MAX_ROWS);
    assert.equal(clampRect({ x: 0, y: 0, w: 1, h: 99999 }).h, MAX_ROWS);
  });

  it('gives non-numbers the defaults and honours a custom grid', () => {
    assert.deepEqual(clampRect({ x: 'a', y: NaN, w: undefined, h: null }), { x: 0, y: 0, w: 1, h: MIN_ROWS });
    assert.deepEqual(clampRect({}), { x: 0, y: 0, w: 1, h: MIN_ROWS });
    assert.deepEqual(clampRect({ x: 5, y: 0, w: 5, h: 1 }, 2, 3), { x: 0, y: 0, w: 2, h: 3 });
  });
});

describe('layout v2: parseLayoutV2 (a stored layout)', () => {
  it('rejects anything that is not a version-2 object so the caller can migrate or default', () => {
    for (const junk of [undefined, null, [], 'v2', 2, {}, { version: 1, panels: [] }, { version: 3, panels: [] }, { version: 2 }, { version: 2, panels: {} }]) {
      assert.equal(parseLayoutV2(junk), undefined);
    }
  });

  it('keeps stored rects (clamped), flags and unknown ids; drops duplicates and malformed entries', () => {
    const out = parseLayoutV2({
      version: 2,
      panels: [
        { id: 'daily', x: 1, y: 0, w: 3, h: 21, hidden: false },
        { id: 'daily', x: 0, y: 0, w: 1, h: 7, hidden: true },
        { id: 'future', x: 0, y: 40, w: 9, h: 2, hidden: 1 },
        null,
        { id: '', x: 0, y: 0, w: 1, h: 7 },
        { id: 3 },
      ],
    })!;
    assert.deepEqual(byId(out.panels, 'daily'), { id: 'daily', x: 1, y: 0, w: 3, h: 21, hidden: false });
    assert.deepEqual(byId(out.panels, 'future'), { id: 'future', x: 0, y: 40, w: 4, h: 7, hidden: true });
    assert.equal(out.panels.filter((p) => p.id === 'daily').length, 1);
    assert.equal(out.panels[0]!.id, 'daily');
  });

  it('appends the default panels a stored layout lacks in the first free spot, hidden or visible as by default', () => {
    const out = parseLayoutV2({ version: 2, panels: [{ id: 'daily', x: 0, y: 0, w: 4, h: 13, hidden: false }] })!;
    assert.equal(out.panels.length, PANEL_IDS.length);
    assert.equal(rect(byId(out.panels, 'heatmap')), '0,13,2x13');
    assert.equal(byId(out.panels, 'heatmap').hidden, false);
    assert.equal(byId(out.panels, 'repos').hidden, true);
    for (const [i, a] of out.panels.entries()) for (const b of out.panels.slice(i + 1)) assert.equal(overlaps(a, b), false, `${a.id} vs ${b.id}`);
  });

  it('is idempotent: parsing a parsed layout changes nothing', () => {
    const once = parseLayoutV2({ version: 2, panels: [{ id: 'sankey', x: 2, y: 5, w: 2, h: 9, hidden: true }] })!;
    assert.deepEqual(parseLayoutV2(once), once);
  });
});

describe('layout v2: isLayoutV2 (the message validator)', () => {
  const ok = { id: 'daily', x: 0, y: 0, w: 2, h: 13, hidden: false };
  const layout = (...panels: unknown[]) => ({ version: 2, panels });

  it('accepts the default layout and an empty one', () => {
    assert.equal(isLayoutV2(defaultLayout()), true);
    assert.equal(isLayoutV2(layout()), true);
    assert.equal(isLayoutV2(layout({ ...ok, x: 2, w: 2 })), true, 'right at the edge');
  });

  it('rejects the wrong envelope', () => {
    for (const v of [undefined, null, [], 'x', { version: 1, panels: [] }, { version: 2 }, { version: 2, panels: 'no' }, [ok]]) assert.equal(isLayoutV2(v), false);
    assert.equal(isLayoutV2({ version: 2, panels: Array.from({ length: 201 }, (_, i) => ({ ...ok, id: `p${i}` })) }), false, 'too many panels');
  });

  it('rejects malformed panels: ids, rects, flags, duplicates', () => {
    const bad = [
      null,
      'daily',
      { ...ok, id: 7 },
      { ...ok, id: '' },
      { ...ok, id: 'x'.repeat(129) },
      { ...ok, x: -1 },
      { ...ok, x: 3 }, // 3 + 2 > 4
      { ...ok, x: 0.5 },
      { ...ok, y: -1 },
      { ...ok, y: MAX_ROWS + 1 },
      { ...ok, w: 0 },
      { ...ok, w: 5 },
      { ...ok, w: '2' },
      { ...ok, h: 0 },
      { ...ok, h: MAX_ROWS + 1 },
      { ...ok, h: NaN },
      { ...ok, hidden: 'false' },
      { ...ok, hidden: undefined },
    ];
    for (const p of bad) assert.equal(isLayoutV2(layout(p)), false, JSON.stringify(p));
    assert.equal(isLayoutV2(layout(ok, ok)), false, 'a duplicate id');
  });
});

describe('legacy config.json dashboard.panels (read by the one-time importer, then migrated)', () => {
  const col = (s: string | undefined) => gridColumnToSpan(s);
  it('gridColumnToSpan reads "span N" into 1..4 and anything else as 1', () => {
    assert.deepEqual(['span 1', 'span 2', 'span 3', 'span 4', 'SPAN 2', ' span  3 '].map(col), [1, 2, 3, 4, 2, 3]);
    assert.deepEqual(['span 9', 'span 0'].map(col), [4, 1], 'clamped');
    assert.deepEqual([undefined, '', 'auto', 'span', '3', 'span 2.5'].map(col), [1, 1, 1, 1, 1, 1]);
  });

  it('configPanelsToLayout: spans from gridColumn, a missing one takes the panel default, hidden and size carry over', () => {
    const out = configPanelsToLayout([
      { id: 'models', gridColumn: 'span 2', hidden: true, size: 'tall' },
      { id: 'daily' },
      { id: 'futureChart' },
      { id: 'sankey', size: 'bogus' as never },
    ]);
    assert.deepEqual(out.slice(0, 4), [
      { id: 'models', span: 2, hidden: true, size: 'tall' },
      { id: 'daily', span: 2, hidden: false, size: 'normal' },
      { id: 'futureChart', span: 1, hidden: false, size: 'normal' },
      { id: 'sankey', span: 1, hidden: false, size: 'normal' },
    ]);
    assert.deepEqual(configPanelsToLayout(undefined), normalizeV1([]));
  });

  for (const [label, panels] of LAYOUT_CONFIG_CASES) {
    it(`${label}: converts to a v1 layout the migrator accepts`, () => {
      assert.ok(isLayoutV2(migrateV1(configPanelsToLayout(panels))));
    });
  }
});

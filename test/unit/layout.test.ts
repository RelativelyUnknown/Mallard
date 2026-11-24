import { strict as assert } from 'assert';
import { configPanelsToLayout, gridColumnToSpan, layoutToConfigPanels, normalizeLayout } from '../../src/extension-backend/domain/layout';
import { DASHBOARD_PANELS, DEFAULT_DASHBOARD_LAYOUT } from '../../src/extension-backend/domain/types';

describe('normalizeLayout', () => {
  it('returns the defaults when nothing is stored', () => {
    assert.deepEqual(normalizeLayout(undefined), DEFAULT_DASHBOARD_LAYOUT);
  });

  it('preserves stored order, span, and visibility', () => {
    const stored = [
      { id: 'category', span: 2 as const, hidden: false },
      { id: 'daily', span: 1 as const, hidden: true },
    ];
    const out = normalizeLayout(stored);
    assert.equal(out[0]!.id, 'category');
    assert.equal(out[0]!.span, 2);
    assert.equal(out[1]!.id, 'daily');
    assert.equal(out[1]!.hidden, true);
  });

  // Was "drops unknown and duplicate ids …": unknown ids are now preserved (a newer
  // config's panels must survive a save by an older build); duplicates are still dropped.
  it('keeps unknown ids, drops duplicates and appends missing panels', () => {
    const stored = [
      { id: 'daily', span: 2 as const, hidden: false },
      { id: 'daily', span: 1 as const, hidden: true }, // duplicate
      { id: 'bogus', span: 3 as const, hidden: true, size: 'tall' as const }, // unknown, but preserved
    ];
    const out = normalizeLayout(stored);
    // Every known panel appears exactly once, plus the unknown one.
    assert.deepEqual(
      [...out.map((p) => p.id)].sort(),
      [...DASHBOARD_PANELS, 'bogus'].sort(),
    );
    assert.equal(out.filter((p) => p.id === 'daily').length, 1);
    assert.deepEqual(out.find((p) => p.id === 'bogus'), { id: 'bogus', span: 3, hidden: true, size: 'tall' });
    // The kept 'daily' is the first occurrence (span 2).
    assert.equal(out.find((p) => p.id === 'daily')!.span, 2);
  });

  it('clamps an out-of-range span to the max (4)', () => {
    const out = normalizeLayout([{ id: 'models', span: 99, hidden: false }]);
    assert.equal(out.find((p) => p.id === 'models')!.span, 4);
  });

  it('coerces a non-numeric span to 1', () => {
    const out = normalizeLayout([{ id: 'models', span: NaN as unknown as number, hidden: false }]);
    assert.equal(out.find((p) => p.id === 'models')!.span, 1);
  });

  it('keeps spans 3 and 4', () => {
    const out = normalizeLayout([
      { id: 'models', span: 3, hidden: false },
      { id: 'sankey', span: 4, hidden: false },
    ]);
    assert.equal(out.find((p) => p.id === 'models')!.span, 3);
    assert.equal(out.find((p) => p.id === 'sankey')!.span, 4);
  });
});

describe('gridColumnToSpan', () => {
  it('parses "span 2" as 2', () => assert.equal(gridColumnToSpan('span 2'), 2));
  it('parses "span 1" as 1', () => assert.equal(gridColumnToSpan('span 1'), 1));
  it('parses "span 3" as 3', () => assert.equal(gridColumnToSpan('span 3'), 3));
  it('parses "span 4" as 4', () => assert.equal(gridColumnToSpan('span 4'), 4));
  it('returns 1 for undefined', () => assert.equal(gridColumnToSpan(undefined), 1));
  it('returns 1 for unrecognised strings', () => assert.equal(gridColumnToSpan('auto'), 1));
  it('clamps a span above the max to 4', () => assert.equal(gridColumnToSpan('span 9'), 4));
});

describe('configPanelsToLayout / layoutToConfigPanels', () => {
  it('returns the defaults for an empty or missing panels block', () => {
    assert.deepEqual(configPanelsToLayout(undefined), DEFAULT_DASHBOARD_LAYOUT);
    assert.deepEqual(configPanelsToLayout([]), DEFAULT_DASHBOARD_LAYOUT);
  });

  it('parses gridColumn spans and preserves order, hidden, and size', () => {
    const out = configPanelsToLayout([
      { id: 'models', gridColumn: 'span 2', hidden: true, size: 'tall' },
      { id: 'daily', gridColumn: 'span 3' },
    ]);
    assert.equal(out[0]!.id, 'models');
    assert.equal(out[0]!.span, 2);
    assert.equal(out[0]!.hidden, true);
    assert.equal(out[0]!.size, 'tall');
    assert.equal(out[1]!.id, 'daily');
    assert.equal(out[1]!.span, 3);
  });

  // Was "drops unknown ids and duplicates …" — unknown ids are preserved now.
  it('keeps unknown ids, drops duplicates, appending missing panels', () => {
    const out = configPanelsToLayout([
      { id: 'bogus' },
      { id: 'daily', gridColumn: 'span 2' },
      { id: 'daily', gridColumn: 'span 1' },
    ]);
    assert.deepEqual([...out.map((p) => p.id)].sort(), [...DASHBOARD_PANELS, 'bogus'].sort());
    assert.equal(out[0]!.id, 'bogus', 'unknown ids keep their position');
    assert.equal(out.find((p) => p.id === 'daily')!.span, 2);
  });

  it('round-trips a layout through the config.json shape', () => {
    const layout = normalizeLayout([
      { id: 'sankey', span: 4, hidden: true, size: 'compact' },
      { id: 'daily', span: 2, hidden: false, size: 'normal' },
    ]);
    assert.deepEqual(configPanelsToLayout(layoutToConfigPanels(layout)), layout);
  });

  it('omits default hidden/size/gridColumn values when serializing', () => {
    const panels = layoutToConfigPanels(DEFAULT_DASHBOARD_LAYOUT);
    const defaults = new Map(DEFAULT_DASHBOARD_LAYOUT.map((d) => [d.id, d]));
    for (const p of panels) {
      // hidden is serialized only when true (the extra charts default hidden).
      assert.equal('hidden' in p, defaults.get(p.id)!.hidden);
      assert.equal('size' in p, false);
      // Every panel in the default layout is at its default span, so no gridColumn
      // (the old code always wrote one, contradicting its own "omit defaults" comment).
      assert.equal('gridColumn' in p, false, `${p.id} at its default span`);
    }
  });
});

describe('layout — defaults, clamping and unknown panels', () => {
  const columnsOf = (layout: ReturnType<typeof normalizeLayout>, id: string) => layout.find((p) => p.id === id)!.span;

  it('REGRESSION: spans are clamped to the grid column count when one is given', () => {
    const stored = [
      { id: 'daily', span: 4, hidden: false },
      { id: 'models', span: 3, hidden: false },
      { id: 'heatmap', span: 1, hidden: false },
    ];
    const two = normalizeLayout(stored, 2);
    assert.equal(columnsOf(two, 'daily'), 2);
    assert.equal(columnsOf(two, 'models'), 2);
    assert.equal(columnsOf(two, 'heatmap'), 1);
    const one = normalizeLayout(stored, 1);
    assert.ok(one.every((p) => p.span === 1), 'a single column fits every panel in one span');
    // Appended defaults (daily/heatmap default to span 2) are clamped too.
    assert.ok(normalizeLayout(undefined, 1).every((p) => p.span === 1));
    // No column count (or nonsense) keeps the full [1, MAX_PANEL_SPAN] range.
    assert.equal(columnsOf(normalizeLayout(stored), 'daily'), 4);
    assert.equal(columnsOf(normalizeLayout(stored, NaN), 'daily'), 4);
    assert.equal(columnsOf(normalizeLayout(stored, 99), 'daily'), 4);
    assert.equal(columnsOf(normalizeLayout(stored, 0), 'daily'), 1);
  });

  it('REGRESSION: configPanelsToLayout clamps to the configured column count', () => {
    const out = configPanelsToLayout([{ id: 'daily', gridColumn: 'span 4' }], 2);
    assert.equal(columnsOf(out, 'daily'), 2);
  });

  it('REGRESSION: unknown panel ids from a newer config round-trip instead of being dropped', () => {
    const fromConfig = configPanelsToLayout([
      { id: 'daily', gridColumn: 'span 3' },
      { id: 'futureChart', gridColumn: 'span 2', hidden: true, size: 'tall' },
    ]);
    const unknown = fromConfig.find((p) => p.id === 'futureChart');
    assert.deepEqual(unknown, { id: 'futureChart', span: 2, hidden: true, size: 'tall' });
    // The webview round-trips the layout it was given; saving must keep the unknown entry.
    const saved = layoutToConfigPanels(fromConfig);
    assert.deepEqual(saved.find((p) => p.id === 'futureChart'), {
      id: 'futureChart',
      gridColumn: 'span 2',
      hidden: true,
      size: 'tall',
    });
    assert.deepEqual(configPanelsToLayout(saved), fromConfig);
  });

  it('ignores entries without a usable string id and duplicate unknown ids', () => {
    const out = normalizeLayout([
      { id: '', span: 1, hidden: false },
      { id: 7 as unknown as string, span: 1, hidden: false },
      { id: 'x', span: 1, hidden: false },
      { id: 'x', span: 4, hidden: true },
    ]);
    assert.equal(out.filter((p) => p.id === 'x').length, 1);
    assert.equal(out.find((p) => p.id === 'x')!.span, 1);
    assert.equal(out.length, DASHBOARD_PANELS.length + 1);
  });

  it('REGRESSION: an entry without gridColumn gets that panel\'s default span (daily=2), not 1', () => {
    const out = configPanelsToLayout([{ id: 'daily' }, { id: 'models' }, { id: 'futureChart' }]);
    assert.equal(columnsOf(out, 'daily'), 2);
    assert.equal(columnsOf(out, 'models'), 1);
    assert.equal(columnsOf(out, 'futureChart'), 1, 'unknown panels default to 1');
  });

  it('REGRESSION: gridColumn is written only when the span differs from the panel default', () => {
    const layout = normalizeLayout([
      { id: 'daily', span: 2, hidden: false }, // default
      { id: 'heatmap', span: 3, hidden: false }, // differs
      { id: 'models', span: 1, hidden: false }, // default
      { id: 'sankey', span: 2, hidden: false }, // differs
    ]);
    const panels = layoutToConfigPanels(layout);
    const byId = new Map(panels.map((p) => [p.id, p]));
    assert.equal('gridColumn' in byId.get('daily')!, false);
    assert.equal(byId.get('heatmap')!.gridColumn, 'span 3');
    assert.equal('gridColumn' in byId.get('models')!, false);
    assert.equal(byId.get('sankey')!.gridColumn, 'span 2');
    assert.deepEqual(configPanelsToLayout(panels), layout, 'and it still round-trips');
  });

  it('keeps reading config files written before defaults were omitted (explicit gridColumn everywhere)', () => {
    const legacy = DEFAULT_DASHBOARD_LAYOUT.map((d) => ({
      id: d.id,
      gridColumn: `span ${d.span}`,
      ...(d.hidden ? { hidden: true } : {}),
    }));
    assert.deepEqual(configPanelsToLayout(legacy), DEFAULT_DASHBOARD_LAYOUT);
  });
});

import * as assert from 'assert';
import { mergeConfig } from '../../src/extension-backend/app/mergeConfig';

describe('mergeConfig', () => {
  it('falls back to defaults for negative numbers', () => {
    const out = mergeConfig({ monthlyBudget: -1, includedCredits: -5 });
    assert.equal(out.monthlyBudget, 0);
    assert.equal(out.includedCredits, 300);
  });

  it('falls back to defaults for missing fields', () => {
    const out = mergeConfig({});
    assert.equal(out.monthlyBudget, 0);
    assert.equal(out.includedCredits, 300);
  });

  it('accepts a boolean velocityEnabled', () => {
    const out = mergeConfig({ alerts: { velocityEnabled: true, velocityCreditsPerHour: 50 } });
    assert.equal(out.alerts.velocityEnabled, true);
    assert.equal(out.alerts.velocityCreditsPerHour, 50);
  });

  it('preserves branchBudgets when present', () => {
    const out = mergeConfig({ branchBudgets: { main: 200, 'feature/x': 500 } });
    assert.deepEqual(out.branchBudgets, { main: 200, 'feature/x': 500 });
  });

  it('omits branchBudgets when not present', () => {
    const out = mergeConfig({});
    assert.equal(out.branchBudgets, undefined);
  });

  it('preserves v2 fields when present', () => {
    const out = mergeConfig({
      version: 2,
      vars: { x: 1 },
      groups: [{ id: 'g', active: true as const }],
      rules: [{ id: 'r', severity: 'warning' as const, message: '', when: true as const }],
      budget: { monthlyUsd: 50, includedCredits: 300 },
    });
    assert.equal(out.version, 2);
    assert.deepEqual(out.vars, { x: 1 });
    assert.equal(out.rules?.length, 1);
    assert.equal(out.budget?.monthlyUsd, 50);
  });

  describe('nested block validation', () => {
    it('keeps a 3-letter currency, upper-cased, and drops anything else', () => {
      assert.equal(mergeConfig({ currency: 'eur' }).currency, 'EUR');
      for (const bad of ['EURO', 'E', '', '<img src=x onerror=alert(1)>', '12$']) {
        assert.equal(mergeConfig({ currency: bad }).currency, undefined, JSON.stringify(bad));
      }
      assert.equal(mergeConfig({ currency: 42 as unknown as string }).currency, undefined);
    });

    it('keeps in-range integer display numbers and drops the rest per field', () => {
      const out = mergeConfig({ display: { dailyBarsWindow: 30, heatmapWeeks: 0, topN: 2.5 } });
      assert.deepEqual(out.display, { dailyBarsWindow: 30 });
    });

    it('rejects out-of-range and non-finite display numbers', () => {
      for (const display of [
        { dailyBarsWindow: 0 },
        { dailyBarsWindow: -5 },
        { dailyBarsWindow: 367 },
        { dailyBarsWindow: 1e9 },
        { heatmapWeeks: NaN },
        { heatmapWeeks: Infinity },
        { topN: 1000 },
      ]) {
        assert.equal(mergeConfig({ display }).display, undefined, JSON.stringify(display));
      }
    });

    it('accepts the documented display boundaries', () => {
      const display = { dailyBarsWindow: 366, heatmapWeeks: 1, topN: 1 };
      assert.deepEqual(mergeConfig({ display }).display, display);
    });

    it('drops an out-of-range dashboard.columns but keeps the panels', () => {
      const panels = [{ id: 'daily', hidden: true }];
      assert.deepEqual(mergeConfig({ dashboard: { columns: 3, panels } }).dashboard, { columns: 3, panels });
      for (const columns of [0, 5, -1, 2.5, NaN]) {
        assert.deepEqual(mergeConfig({ dashboard: { columns, panels } }).dashboard, { panels }, String(columns));
      }
    });
  });
});

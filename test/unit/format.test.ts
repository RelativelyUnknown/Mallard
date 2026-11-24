import { strict as assert } from 'assert';
import {
  formatMoney,
  formatNumber,
  formatTokens,
  formatCredits,
  formatMetric,
} from '../../src/extension-backend/domain/format';
import type { Metric } from '../../src/extension-backend/domain/types';

describe('formatMoney', () => {
  it('formats zero', () => {
    const r = formatMoney(0);
    assert.ok(r.includes('0'), `expected "0" in "${r}"`);
  });

  it('formats a positive amount in USD', () => {
    const r = formatMoney(1234.56);
    assert.ok(r.includes('1') && r.includes('234'), `unexpected: ${r}`);
  });

  it('uses a different currency when specified', () => {
    const r = formatMoney(10, 'EUR');
    // Either the Intl formatter worked (€) or the fallback string (EUR 10.00)
    assert.ok(r.includes('EUR') || r.includes('€'), `unexpected: ${r}`);
  });

  it('returns a string for a negative amount', () => {
    assert.equal(typeof formatMoney(-5), 'string');
  });

  it('falls back gracefully for an invalid currency code', () => {
    const r = formatMoney(10, 'THISISNOTACURRENCY');
    assert.equal(typeof r, 'string');
    assert.ok(r.length > 0);
  });
});

describe('formatNumber', () => {
  it('rounds to integer and formats with separators', () => {
    const r = formatNumber(1_234_567);
    // Locale-independent check: remove non-digits and check for the digits
    assert.ok(r.replace(/[^0-9]/g, '').includes('1234567'), `unexpected: ${r}`);
  });

  it('rounds fractional values', () => {
    const r = formatNumber(1.7);
    assert.ok(r.includes('2'), `expected "2" in "${r}"`);
  });

  it('handles zero', () => {
    assert.ok(formatNumber(0).includes('0'));
  });
});

describe('formatTokens', () => {
  it('formats values below 1k as plain numbers', () => {
    assert.equal(formatTokens(500), '500');
  });

  it('formats values >= 1k with k suffix', () => {
    assert.equal(formatTokens(1500), '1.5k');
    assert.equal(formatTokens(1000), '1.0k');
  });

  it('formats values >= 1M with M suffix', () => {
    assert.equal(formatTokens(1_500_000), '1.5M');
    assert.equal(formatTokens(1_000_000), '1.0M');
  });

  it('rounds sub-unit values', () => {
    const r = formatTokens(999);
    assert.equal(r, '999');
  });
});

describe('formatCredits', () => {
  it('formats whole credits without decimals', () => {
    const r = formatCredits(100);
    assert.ok(r.includes('100'), `unexpected: ${r}`);
  });

  it('rounds to 1 decimal place', () => {
    const r = formatCredits(1234.55);
    // 1234.55 * 10 = 12345.5 → round → 12346 → 12346/10 = 1234.6
    // formatCredits renders via toLocaleString(), so compare against the same
    // locale-dependent rendering instead of hardcoding en-US separators.
    assert.equal(r, (1234.6).toLocaleString(), `unexpected: ${r}`);
  });

  it('returns a string', () => {
    assert.equal(typeof formatCredits(0), 'string');
  });
});

describe('formatMetric', () => {
  it('cost delegates to formatMoney', () => {
    const r = formatMetric(10, 'cost' as Metric);
    assert.equal(r, formatMoney(10));
  });

  it('credits includes "cr" suffix', () => {
    const r = formatMetric(50, 'credits' as Metric);
    assert.ok(r.includes('cr'), `expected "cr" in "${r}"`);
  });

  it('tokens includes "tok" suffix', () => {
    const r = formatMetric(5000, 'tokens' as Metric);
    assert.ok(r.includes('tok'), `expected "tok" in "${r}"`);
  });

  it('throws for an unknown metric', () => {
    assert.throws(() => formatMetric(1, 'unknown' as Metric));
  });
});

describe('formatTokens — unit rollover', () => {
  it('promotes a value that rounds up to 1000k into M instead of printing "1000.0k"', () => {
    assert.equal(formatTokens(999_950), '1.0M');
    assert.equal(formatTokens(999_999), '1.0M');
    assert.equal(formatTokens(999_949), '999.9k');
  });

  it('promotes a value that rounds up to 1000 into k', () => {
    assert.equal(formatTokens(999.6), '1.0k');
    assert.equal(formatTokens(999.4), '999');
  });
});

describe('formatMoney — sub-cent amounts', () => {
  it('shows a floor instead of a misleading zero for a positive sub-cent amount', () => {
    const r = formatMoney(0.004);
    assert.ok(r.startsWith('<'), `expected a "<" floor, got "${r}"`);
    assert.equal(r, `<${formatMoney(0.01)}`);
  });

  it('keeps exact zero, cents and larger amounts as they were', () => {
    assert.equal(formatMoney(0), new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(0));
    assert.ok(!formatMoney(0.01).startsWith('<'));
    assert.ok(!formatMoney(12.5).startsWith('<'));
  });

  it('uses the currency\'s own smallest unit (no minor units for JPY)', () => {
    const r = formatMoney(0.4, 'JPY');
    assert.ok(r.startsWith('<'), r);
    assert.ok(!formatMoney(1, 'JPY').startsWith('<'));
  });
});

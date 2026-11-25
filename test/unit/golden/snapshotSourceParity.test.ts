import { strict as assert } from 'assert';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import type { PricingSnapshot, RawEvent } from '../../../src/extension-backend/domain/contracts';
import type { PricingManifest, TokenPrices } from '../../../src/extension-backend/domain/pricing';
import { priceUsage } from '../../../src/extension-backend/domain/pricing';
import { buildSnapshotSource } from '../../../src/extension-backend/domain/snapshotSource';
import type { SnapshotSourceData } from '../../../src/extension-backend/domain/snapshotSource';
import type { RecordFilter } from '../../../src/extension-backend/store/EventRepository';
import { groupsFor, toRawEvent } from '../../golden/groupEvents';
import type { NormalizedEvent } from '../../golden/pipeline';
import { canon, expectedPath } from '../../golden/support/canon';
import { diffGolden } from '../../golden/support/diff';
import { GOLDEN_TZS, withTzSync } from '../../golden/support/time';

/**
 * Acceptance gate of stream A1: the pure read-time engine (`priceUsage` +
 * `buildSnapshotSource` over pre-aggregated groups) reproduces what today's
 * DuckDB stack recorded in test/golden/expected/, in every golden zone, at
 * every recorded `now` and filter, except the differences listed in
 * test/golden/INTENDED_DIFFERENCES.md (each test names its D-id).
 *
 * The input is the recording's own mapped events (`events.json`, which carry
 * cache and thinking tokens: D2) priced with the frozen inputs under
 * test/golden/fixtures/pricing/ (D1: equal under frozen pricing).
 */

const PRICING_DIR = path.join(__dirname, '..', '..', 'golden', 'fixtures', 'pricing');
const MANIFEST = JSON.parse(readFileSync(path.join(PRICING_DIR, 'manifest.json'), 'utf8')) as PricingManifest;
const TOKEN_PRICES = JSON.parse(readFileSync(path.join(PRICING_DIR, 'token-prices.json'), 'utf8')) as TokenPrices;

const FROZEN: PricingSnapshot = {
  manifest: MANIFEST,
  tokenPrices: TOKEN_PRICES,
  pricePerCredit: MANIFEST.pricePerCredit,
  version: 'golden-frozen',
};

interface RecordedEvents {
  events: NormalizedEvent[];
}

interface SnapshotRecord {
  label: string;
  nowLabel: string;
  now: string;
  read: { path: 'cache' | 'filtered'; recordFilter: RecordFilter | null };
  data: SnapshotSourceData | { reduced: string; totals: SnapshotSourceData['totals']; estimatedEventCount: number; daily: { days: number; first: number | null; last: number | null } };
}

/** A recorded golden: the zone-specific file when the recorder wrote one, else the zone-independent one. */
function loadExpectedSync(name: string, tz: string): unknown {
  const file = existsSync(expectedPath(name, tz)) ? expectedPath(name, tz) : expectedPath(name);
  return JSON.parse(readFileSync(file, 'utf8')) as unknown;
}

function loadEvents(tz: string): { recorded: NormalizedEvent[]; raw: RawEvent[] } {
  const { events } = loadExpectedSync('events', tz) as RecordedEvents;
  return { recorded: events, raw: events.map(toRawEvent) };
}

describe('golden parity — priceUsage reproduces the recorded event prices (D1, D17)', () => {
  const { recorded, raw } = loadEvents('UTC');

  it('has the fixture events, with cache/thinking tokens present on the mapped events (D2)', () => {
    assert.equal(recorded.length, 162);
    assert.ok(recorded.some((e) => e.cacheReadTokens !== null && e.cacheReadTokens > 0));
    assert.ok(recorded.some((e) => e.cacheCreationTokens !== null && e.cacheCreationTokens > 0));
    assert.ok(recorded.some((e) => e.thinkingTokens !== null && e.thinkingTokens > 0));
  });

  it('credits, cost and costByCategory of every event equal the ingest-time recording', () => {
    for (const [i, e] of recorded.entries()) {
      const priced = priceUsage(raw[i]!, FROZEN);
      assert.deepEqual(
        canon({ credits: priced.credits, cost: priced.cost, costByCategory: priced.costByCategory ?? null }),
        canon({ credits: e.credits, cost: e.cost, costByCategory: e.costByCategory }),
        `${e.id} (${e.model})`,
      );
    }
  });

  it('covers every path: token cost, credit cost with a split, credit cost without, feed, bundled list, no price', () => {
    const paths = new Set<string>();
    for (const [i, e] of recorded.entries()) {
      const cats = priceUsage(raw[i]!, FROZEN).costByCategory;
      paths.add(`${e.source}/${e.cost > 0 ? 'cost' : 'free'}/${cats ? Object.keys(cats).length : 'nosplit'}`);
    }
    assert.ok(paths.has('claude-code/free/nosplit'), 'claude-fable-9: in neither price list');
    assert.ok(paths.has('local/cost/nosplit'), 'null tokens: credit cost, nothing to split');
    assert.ok(paths.has('local/free/nosplit'), 'a free model without tokens');
    assert.ok([...paths].some((p) => p.startsWith('claude-code/cost/') && p !== 'claude-code/cost/nosplit'));
  });

  describe('D1: prices are read-time, so a change re-prices old rows', () => {
    const find = (pred: (e: NormalizedEvent) => boolean): number => {
      const i = recorded.findIndex(pred);
      assert.ok(i >= 0);
      return i;
    };
    const scaleFeed = (k: number): PricingSnapshot => ({
      ...FROZEN,
      tokenPrices: Object.fromEntries(Object.entries(TOKEN_PRICES).map(([m, p]) => [m, { ...p, input: p.input * k, output: p.output * k }])),
      version: `x${k}`,
    });

    it('a feed price change moves a feed-priced Claude row, not a row priced from the bundled list', () => {
      const fed = find((e) => e.source === 'claude-code' && e.model.startsWith('claude-sonnet-4-5') && !e.cacheReadTokens && !e.cacheCreationTokens && !e.thinkingTokens);
      const listed = find((e) => e.model === 'claude-3-5-sonnet-20241022');
      near(priceUsage(raw[fed]!, scaleFeed(2)).cost, 2 * priceUsage(raw[fed]!, FROZEN).cost);
      assert.equal(priceUsage(raw[listed]!, scaleFeed(2)).cost, priceUsage(raw[listed]!, FROZEN).cost);
    });

    it('a multiplier change moves the credits, and a price-per-credit change a credit-priced Copilot row', () => {
      const creditPriced = find((e) => e.id.includes('map-007'));
      const doubledModel: PricingSnapshot = { ...FROZEN, manifest: { ...MANIFEST, models: { ...MANIFEST.models, 'gpt-4o': 0.66 } } };
      near(priceUsage(raw[creditPriced]!, doubledModel).credits, 2 * priceUsage(raw[creditPriced]!, FROZEN).credits);
      const dearer: PricingSnapshot = { ...FROZEN, tokenPrices: undefined, pricePerCredit: 0.08 };
      near(priceUsage(raw[creditPriced]!, dearer).cost, 2 * recorded[creditPriced]!.credits * MANIFEST.pricePerCredit);
    });
  });
});

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, Math.abs(expected)), `${actual} vs ${expected}`);
}

for (const tz of GOLDEN_TZS) {
  describe(`golden parity — buildSnapshotSource vs snapshots.${tz}`, () => {
    const { raw } = loadEvents(tz);
    const records = loadExpectedSync('snapshots', tz) as SnapshotRecord[];

    it('covers the whole recorded matrix (19 filters at main, 4 at each of 4 edge nows)', () => {
      assert.equal(records.length, 35);
    });

    for (const rec of records) {
      it(`${rec.label} @ ${rec.nowLabel}: same SnapshotSourceData`, () => {
        const filter = rec.read.recordFilter ?? {};
        const actual = withTzSync(tz, () => buildSnapshotSource(groupsFor(raw, filter), Date.parse(rec.now), FROZEN));
        if ('reduced' in rec.data) {
          // The recorder keeps only totals and the daily extent of an unfiltered read at an edge now.
          const days = actual.daily;
          const reduced = {
            totals: actual.totals,
            estimatedEventCount: actual.estimatedEventCount,
            daily: { days: days.length, first: days[0]?.dayStart ?? null, last: days[days.length - 1]?.dayStart ?? null },
          };
          const { reduced: _note, ...expected } = rec.data;
          void _note;
          assert.equal(diffGolden(reduced, expected), null);
        } else {
          assert.equal(diffGolden(actual, rec.data), null);
        }
      });
    }
  });
}

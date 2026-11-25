import { strict as assert } from 'assert';
import type { RawEvent } from '../../../src/extension-backend/domain/contracts';
import { priceTokens, priceUsage } from '../../../src/extension-backend/domain/pricing';
import { buildSnapshotSource } from '../../../src/extension-backend/domain/snapshotSource';
import type { SnapshotSourceData } from '../../../src/extension-backend/domain/snapshotSource';
import type { RecordFilter } from '../../../src/extension-backend/store/EventRepository';
import { nextBucketStart, startOf } from '../../../src/extension-backend/util/time';
import { FROZEN, loadExpectedSync, loadGoldenEvents } from '../../golden/frozen';
import { groupsFor, matchesRecordFilter, rollUpEvents } from '../../golden/groupEvents';
import type { NormalizedEvent } from '../../golden/pipeline';
import { GOLDEN_TZS, withTzSync } from '../../golden/support/time';

/**
 * Parity of the post-compaction goldens (`compaction.<zone>.json`): the rolled
 * rows and the snapshots read after today's rollup. The rollup is simulated
 * by `rollUpEvents` (the planned store behaviour: one row per local day,
 * model, surface, source and repo label, summed `requests` and tokens), and
 * the rolled rows are priced at read time. Differences are exactly the
 * compaction entries of INTENDED_DIFFERENCES.md:
 *
 *  D3  Claude rolled cost/costByCategory: price of the summed tokens vs the sum
 *      of per-event costs (equal up to float rounding, compared at 1e-9);
 *  D4  Copilot credit-priced rolled split: bounded by the spread of the
 *      members' token ratios (zero for every rolled row of the fixtures);
 *  D5  rolled rows sit at local midnight, so the hour-0 quirk and the dropped
 *      branch/language are reproduced and compared as recorded;
 *  D6  counts are sums of `requests` again: compared against the number of
 *      events, not the recorded row count.
 */

interface CompactionGolden {
  at: string;
  retentionDays: number;
  rowCount: number;
  rawRowCount: number;
  rolled: NormalizedEvent[];
  snapshots: Array<{ label: string; read: { path: 'cache' | 'filtered'; recordFilter: RecordFilter | null }; data: SnapshotSourceData }>;
}

/** Equal up to the float noise left by a different summation order (the recordings keep 10 significant digits). */
function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)) + 1e-15;
}

/** Differences between two JSON values, numbers compared with {@link closeTo}; paths for which `skip` is true are ignored. */
function diffClose(actual: unknown, expected: unknown, at: string, skip: (at: string) => boolean, out: string[] = []): string[] {
  if (skip(at) || out.length >= 6) return out;
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (!closeTo(actual, expected)) out.push(`${at}: recorded ${expected}, got ${actual}`);
  } else if (Array.isArray(actual) && Array.isArray(expected)) {
    if (actual.length !== expected.length) out.push(`${at}: recorded ${expected.length} entries, got ${actual.length}`);
    for (let i = 0; i < Math.min(actual.length, expected.length); i++) diffClose(actual[i], expected[i], `${at}[${i}]`, skip, out);
  } else if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    for (const k of new Set([...Object.keys(a), ...Object.keys(e)])) {
      if (!(k in a) || !(k in e)) out.push(`${at}.${k}: present on one side only`);
      else diffClose(a[k], e[k], `${at}.${k}`, skip, out);
    }
  } else if (actual !== expected) {
    out.push(`${at}: recorded ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return out;
}

/** D6: the numbers of events (not rows) a read must count, derived from the events themselves. */
function eventCounts(raw: RawEvent[], recorded: NormalizedEvent[], filter: RecordFilter, now: number) {
  const hits = raw.map((_, i) => i).filter((i) => matchesRecordFilter(raw[i]!, filter));
  const within = (ts: number, lo: number, hi: number): boolean => ts >= lo && ts < hi;
  const daily = new Map<number, number>();
  const sankey = new Map<string, number>();
  for (const i of hits) {
    const e = raw[i]!;
    daily.set(startOf(e.ts, 'day'), (daily.get(startOf(e.ts, 'day')) ?? 0) + 1);
    if (recorded[i]!.credits > 0) sankey.set(`${e.modelId}\0${e.surface}`, (sankey.get(`${e.modelId}\0${e.surface}`) ?? 0) + 1);
  }
  return {
    all: hits.length,
    mtd: hits.filter((i) => within(raw[i]!.ts, startOf(now, 'month'), nextBucketStart(now, 'month'))).length,
    today: hits.filter((i) => within(raw[i]!.ts, startOf(now, 'day'), nextBucketStart(now, 'day'))).length,
    daily,
    sankey,
  };
}

const COUNT_PATHS = /(\.eventCount|\.count|\.estimatedEventCount)$/;

for (const tz of GOLDEN_TZS) {
  describe(`golden parity — compaction.${tz}`, () => {
    const golden = loadExpectedSync('compaction', tz) as CompactionGolden;
    const { raw, recorded } = loadGoldenEvents(tz);
    const at = Date.parse(golden.at);
    const rollup = withTzSync(tz, () => rollUpEvents(raw, at, golden.retentionDays));

    it('rolls the same days up into the same rows (D5: local-midnight rows, no branch or language)', () => {
      assert.equal(rollup.rows.length, golden.rowCount);
      assert.equal(rollup.rolled.length, golden.rolled.length);
      assert.equal(rollup.rows.length - rollup.rolled.length, golden.rawRowCount);
      assert.deepEqual(rollup.rolled.map((r) => r.id), golden.rolled.map((r) => r.id));
      for (const [i, row] of rollup.rolled.entries()) {
        const want = golden.rolled[i]!;
        assert.equal(row.ts, want.ts, row.id);
        assert.equal(row.repo, want.repo, row.id);
        assert.equal(row.attribution, want.attribution, row.id);
        assert.equal(row.branch, null);
        assert.equal(row.language, null);
        assert.equal(row.promptTokens ?? 0, want.promptTokens, `${row.id} prompt tokens`);
        assert.equal(row.completionTokens ?? 0, want.completionTokens, `${row.id} completion tokens`);
      }
      assert.ok(rollup.rolled.some((r) => r.requests > 1), 'the fixtures roll several requests into one row');
    });

    it('D3: a rolled row priced at read time matches the sum of the per-event prices it replaced', () => {
      let merged = 0;
      for (const [i, row] of rollup.rolled.entries()) {
        const want = golden.rolled[i]!;
        const priced = priceUsage(row, FROZEN);
        assert.ok(closeTo(priced.credits, want.credits), `${row.id} credits ${priced.credits} vs ${want.credits}`);
        assert.ok(closeTo(priced.cost, want.cost), `${row.id} cost ${priced.cost} vs ${want.cost}`);
        const cats = priced.costByCategory ?? {};
        const wantCats = want.costByCategory ?? {};
        assert.deepEqual(Object.keys(cats).sort(), Object.keys(wantCats).sort(), `${row.id} categories`);
        for (const [cat, value] of Object.entries(wantCats)) {
          assert.ok(closeTo(cats[cat as keyof typeof cats]!, value), `${row.id} ${cat}`);
        }
        if (rollup.members.get(row.id)!.length > 1) merged++;
      }
      assert.ok(merged >= 10, `${merged} merged rows exercised`);
    });

    it('D4: every merged Copilot row of the fixtures has a feed price, so its split is the exact token split', () => {
      let merged = 0;
      for (const row of rollup.rolled) {
        if (row.source === 'claude-code' || rollup.members.get(row.id)!.length < 2) continue;
        merged++;
        assert.ok(priceTokens(row.modelId, { prompt: 1 }, FROZEN.tokenPrices) !== undefined, `${row.modelId} has no feed price`);
      }
      assert.ok(merged > 0);
    });

    for (const [n, rec] of golden.snapshots.entries()) {
      it(`D5/D6: snapshot "${rec.label}" after compaction matches, with counts back to the number of events`, () => {
        const filter = rec.read.recordFilter ?? {};
        const actual = withTzSync(tz, () => buildSnapshotSource(groupsFor(rollup.rows, filter), at, FROZEN));

        // Everything but the counts: credits, cost, tokens, categories, hourly (D5 quirk included), weekday, dims, ranked lists.
        const diffs = diffClose(actual, rec.data, '$', (p) => COUNT_PATHS.test(p));
        assert.deepEqual(diffs, [], `${rec.label}\n${diffs.join('\n')}`);

        // D6: counts are the number of events, where the recording counted stored rows.
        const want = withTzSync(tz, () => eventCounts(raw, recorded, filter, at));
        assert.equal(actual.totals.all.eventCount, want.all);
        assert.equal(actual.totals.mtd.eventCount, want.mtd);
        assert.equal(actual.totals.today.eventCount, want.today);
        assert.equal(actual.estimatedEventCount, want.all);
        assert.deepEqual(new Map(actual.daily.map((d) => [d.dayStart, d.eventCount])), want.daily);
        assert.deepEqual(new Map(actual.sankey.map((s) => [`${s.model}\0${s.surface}`, s.count])), want.sankey);
        if (n === 0) {
          // The unfiltered read is where compaction hides requests: 147 stored rows stood for 162 requests.
          assert.equal(rec.data.totals.all.eventCount, golden.rowCount);
          assert.equal(actual.totals.all.eventCount, recorded.length);
        }
      });
    }

    it('D5: the rolled days still land in hour 0 and the recorded hour-0 total is reproduced', () => {
      const none = golden.snapshots.find((s) => s.label === 'none')!;
      const actual = withTzSync(tz, () => buildSnapshotSource(groupsFor(rollup.rows, {}), at, FROZEN));
      const hour0 = actual.hourly.find((h) => h.hourLocal === 0)!;
      assert.ok(closeTo(hour0.credits, none.data.hourly.find((h) => h.hourLocal === 0)!.credits));
      const rawOnly = withTzSync(tz, () => buildSnapshotSource(groupsFor(raw, {}), at, FROZEN));
      assert.ok(hour0.credits > (rawOnly.hourly.find((h) => h.hourLocal === 0)?.credits ?? 0), 'rolled credits pile up at hour 0');
    });
  });
}

describe('golden parity — D4: a credit-priced rolled row splits by the summed tokens', () => {
  const event = (id: string, prompt: number, completion: number): RawEvent => ({
    id, ts: Date.parse('2026-01-06T10:00:00Z'), modelId: 'o3-mini', surface: 'chat', source: 'local', repo: null, branch: null,
    attribution: null, language: null, requests: 1, promptTokens: prompt, completionTokens: completion,
    cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
  });

  /** Today's split (sum of per-event splits) vs the new one (split of the summed tokens), and the bound the doc allows. */
  function compare(members: RawEvent[]): { cost: number; summedCost: number; delta: number; allowed: number; splitTotal: number } {
    const { rolled } = withTzSync('UTC', () => rollUpEvents(members, Date.parse('2026-11-02T00:00:00Z'), 30));
    assert.equal(rolled.length, 1);
    const row = priceUsage(rolled[0]!, FROZEN);
    // o3-mini has no per-token price in the frozen feed, so every event costs credits x pricePerCredit.
    const each = members.map((m) => priceUsage(m, FROZEN));
    const ratios = members.map((m) => m.promptTokens! / (m.promptTokens! + m.completionTokens!));
    const sumOfSplits = each.reduce((a, p) => a + (p.costByCategory!.input ?? 0), 0);
    return {
      cost: row.cost,
      summedCost: each.reduce((a, p) => a + p.cost, 0),
      delta: Math.abs(row.costByCategory!.input! - sumOfSplits),
      allowed: row.cost * (Math.max(...ratios) - Math.min(...ratios)),
      splitTotal: row.costByCategory!.input! + row.costByCategory!.output!,
    };
  }

  it('keeps the cost exact, and the split still sums to it', () => {
    const r = compare([event('a', 100, 300), event('b', 300, 100), event('c', 200, 200)]);
    assert.ok(closeTo(r.cost, r.summedCost), 'cost is linear in requests');
    assert.ok(closeTo(r.splitTotal, r.cost));
  });

  it('is the same split when every member has the same token ratio', () => {
    const r = compare([event('a', 100, 300), event('b', 50, 150)]);
    assert.ok(r.delta <= 1e-15);
  });

  it('moves the split, by at most the spread of the members token ratios, when the ratios differ', () => {
    const r = compare([event('d', 10, 90), event('e', 500, 500)]);
    assert.ok(r.delta > 1e-9, 'the approximation is real');
    assert.ok(r.delta <= r.allowed + 1e-15, `moved by ${r.delta}, allowed ${r.allowed}`);
  });
});

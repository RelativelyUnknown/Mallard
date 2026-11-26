/**
 * One behavioural contract for every `IUsageStore`: the SQLite store (in memory
 * and on a file) and the in-memory fallback must agree on insert/fresh, the
 * Claude max-upsert, aggregation, windowed reads, compaction, export and the
 * meta / ingest-state API. The TypeScript reference (`domain/groupEvents.ts`)
 * is the oracle, and the golden recordings are the data.
 */
import { strict as assert } from 'assert';
import type { AggregateGroup, IUsageStore, RawEvent } from '../../../../src/extension-backend/domain/contracts';
import { filterEvents, groupEvents, rollUpEvents } from '../../../../src/extension-backend/domain/groupEvents';
import type { RecordFilter } from '../../../../src/extension-backend/store/EventRepository';
import { dayStartOffset, startOf } from '../../../../src/extension-backend/util/time';
import { loadExpectedSync, loadGoldenEvents } from '../../../golden/frozen';
import { COMPACTION_RETENTION_DAYS } from '../../../golden/scenarios';
import { GOLDEN_TZS, withTz } from '../../../golden/support/time';

export interface StoreHarness {
  store: IUsageStore;
  cleanup(): Promise<void>;
}
export interface StoreOpts {
  now?: () => number;
  retentionDays?: number;
  maxRawEvents?: number;
}
export type StoreFactory = (opts?: StoreOpts) => Promise<StoreHarness>;

const ALL = { fromMs: 0, toMs: 4_000_000_000_000 };
const T = (iso: string): number => Date.parse(iso);
const DAY = 86_400_000;

export function ev(partial: Partial<RawEvent> = {}): RawEvent {
  return {
    id: 'e1', ts: T('2026-03-15T10:07:00Z'), modelId: 'gpt-4o', surface: 'chat', source: 'local',
    repo: null, branch: null, attribution: null, language: null, requests: 1,
    promptTokens: null, completionTokens: null, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
    ...partial,
  };
}

const byId = (rows: readonly RawEvent[]): RawEvent[] => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

async function exported(store: IUsageStore, chunk?: number): Promise<RawEvent[]> {
  const rows: RawEvent[] = [];
  for await (const part of store.exportRows(chunk)) rows.push(...part);
  return rows;
}

/** The distinct read filters the golden scenarios use (`snapshots.<zone>.json`), plus a few the dashboard can send. */
function scenarioFilters(): Array<{ label: string; filter: RecordFilter }> {
  const records = loadExpectedSync('snapshots', 'UTC') as Array<{ label: string; read: { recordFilter: RecordFilter | null } }>;
  const seen = new Map<string, { label: string; filter: RecordFilter }>();
  for (const r of records) {
    const filter = r.read.recordFilter ?? {};
    const key = JSON.stringify(filter);
    if (!seen.has(key)) seen.set(key, { label: r.label, filter });
  }
  const extra: Array<{ label: string; filter: RecordFilter }> = [
    { label: 'empty lists', filter: { models: [], surfaces: [], sources: [], branches: [], repos: [] } },
    { label: 'repo-gamma-missing', filter: { repos: ['gamma-does-not-exist'] } },
    { label: 'range-empty', filter: { range: { start: T('2026-01-01T00:00:00Z'), end: T('2026-01-01T00:00:00Z') } } },
    { label: 'surfaces+branches+models', filter: { surfaces: ['chat', 'agent'], branches: ['main', 'feature/x'], models: ['gpt-4.1', 'claude-sonnet-4-5-20250929'] } },
    { label: 'limit/offset ignored', filter: { limit: 1, offset: 5 } },
  ];
  return [...seen.values(), ...extra];
}

export function storeContract(name: string, make: StoreFactory): void {
  describe(`store contract: ${name}`, () => {
    let harnesses: StoreHarness[] = [];
    let store: IUsageStore;
    const raw = loadGoldenEvents('UTC').raw;

    async function open(opts?: StoreOpts): Promise<IUsageStore> {
      const h = await make(opts);
      harnesses.push(h);
      store = h.store;
      return store;
    }
    afterEach(async () => {
      for (const h of harnesses) await h.cleanup();
      harnesses = [];
    });

    describe('insert', () => {
      it('reports which rows are new, in input order, and is idempotent', async () => {
        await open();
        const first = await store.insert(raw);
        assert.equal(first.inserted, raw.length);
        assert.deepEqual(first.fresh.map((e) => e.id), raw.map((e) => e.id));
        assert.equal(first.updated, 0);
        assert.equal(first.rejected, 0);
        assert.equal(await store.countEvents(), raw.length);

        const again = await store.insert(raw);
        assert.deepEqual([again.inserted, again.fresh.length, again.updated], [0, 0, 0]);
        assert.equal(await store.countEvents(), raw.length);

        const mixed = await store.insert([...raw.slice(0, 3), ev({ id: 'brand-new' })]);
        assert.deepEqual(mixed.fresh.map((e) => e.id), ['brand-new']);
        assert.equal(await store.countEvents(), raw.length + 1);
      });

      it('stores every column of every golden row exactly', async () => {
        await open();
        await store.insert(raw);
        assert.deepEqual(byId(await exported(store)), byId(raw));
      });

      it('an empty insert does nothing', async () => {
        await open();
        const v = store.dataVersion();
        assert.deepEqual(await store.insert([]), { inserted: 0, fresh: [], updated: 0, rejected: 0 });
        assert.equal(store.dataVersion(), v);
      });

      it('in one call, the first occurrence of an id wins (Copilot rows are immutable)', async () => {
        await open();
        const r = await store.insert([ev({ id: 'c', promptTokens: 1 }), ev({ id: 'c', promptTokens: 99, repo: 'other' })]);
        assert.deepEqual(r.fresh.map((e) => [e.id, e.promptTokens, e.repo]), [['c', 1, null]]);
        assert.deepEqual((await exported(store)).map((e) => [e.promptTokens, e.repo]), [[1, null]]);
      });

      it('in one call, a repeated Claude row keeps the larger token counts, and fresh carries what was stored', async () => {
        await open();
        const r = await store.insert([
          ev({ id: 'claude:1', source: 'claude-code', promptTokens: 10, completionTokens: 5, cacheReadTokens: 7 }),
          ev({ id: 'claude:1', source: 'claude-code', promptTokens: 4, completionTokens: 50, cacheCreationTokens: 3, thinkingTokens: 2 }),
        ]);
        const expected = ev({ id: 'claude:1', source: 'claude-code', promptTokens: 10, completionTokens: 50, cacheReadTokens: 7, cacheCreationTokens: 3, thinkingTokens: 2 });
        assert.deepEqual(r.fresh, [expected]);
        assert.deepEqual(await exported(store), [expected]);
      });

      it('a later Claude line of a stored message raises its tokens (msg_late: 5 -> 400), never lowers them, keeps the rest', async () => {
        await open();
        const late = raw.find((e) => e.id === 'claude-code:msg_late:req_late')!;
        assert.equal(late.completionTokens, 5);
        await store.insert([late]);
        const bump = (t: Partial<RawEvent>): RawEvent => ({ ...late, surface: 'agent', ...t });
        assert.equal((await store.insert([bump({ completionTokens: 180 })])).updated, 1);
        assert.equal((await store.insert([bump({ completionTokens: 400, thinkingTokens: 6 })])).updated, 1);
        const lower = await store.insert([bump({ completionTokens: 100, promptTokens: 1 })]);
        assert.deepEqual([lower.inserted, lower.updated], [0, 0]);
        const [stored] = await exported(store);
        assert.deepEqual(stored, { ...late, completionTokens: 400, thinkingTokens: 6 });
        assert.equal(stored!.surface, 'chat');
      });

      it('the Claude max handles NULL like the SQL guard: NULL < any positive count, NULL stays NULL below it', async () => {
        await open();
        const base = ev({ id: 'claude:n', source: 'claude-code', promptTokens: null, completionTokens: 9 });
        await store.insert([base]);
        await store.insert([{ ...base, promptTokens: 0, completionTokens: null }]);
        assert.deepEqual((await exported(store)).map((e) => [e.promptTokens, e.completionTokens]), [[null, 9]]);
        await store.insert([{ ...base, promptTokens: 7, completionTokens: null }]);
        assert.deepEqual((await exported(store)).map((e) => [e.promptTokens, e.completionTokens]), [[7, 9]]);
      });

      it('Copilot rows stay immutable across calls', async () => {
        await open();
        const c = ev({ id: 'copilot:1', promptTokens: 10, completionTokens: 10 });
        await store.insert([c]);
        const r = await store.insert([{ ...c, promptTokens: 999, completionTokens: 999, cacheReadTokens: 5 }]);
        assert.deepEqual([r.inserted, r.updated], [0, 0]);
        assert.deepEqual(await exported(store), [c]);
      });

      it('refuses invalid rows (and stores the valid ones)', async () => {
        await open();
        const bad: Array<Partial<RawEvent>> = [
          { id: '' }, { ts: NaN }, { ts: -1 }, { ts: 1.5 }, { ts: 2 ** 53 }, { modelId: '' }, { requests: -1 },
          { promptTokens: NaN }, { completionTokens: 0.5 }, { cacheReadTokens: -1 }, { repo: 5 as unknown as string },
          { surface: undefined as unknown as 'chat' },
        ];
        const r = await store.insert([...bad.map((b, i) => ev({ id: `bad-${i}`, ...b })), ev({ id: 'good' })]);
        assert.deepEqual([r.inserted, r.rejected], [1, bad.length]);
        assert.deepEqual((await exported(store)).map((e) => e.id), ['good']);
      });
    });

    describe('aggregate', () => {
      for (const { label, filter } of scenarioFilters()) {
        it(`equals the TypeScript GROUP BY for the filter "${label}"`, async () => {
          await open();
          await store.insert(raw);
          const expected = groupEvents(filterEvents(raw, filter));
          assert.deepEqual(await store.aggregate(filter, ALL), expected);
          assert.deepEqual(await store.aggregateRange(filter, ALL), expected);
        });
      }

      it('covers the whole matrix of golden filters (27 distinct)', () => {
        assert.ok(scenarioFilters().length >= 30);
      });

      it('groups on 15-minute UTC buckets and splits on tokensKnown (> 0), not on NULL', async () => {
        await open();
        const t0 = T('2026-03-15T10:00:00Z');
        await store.insert([
          ev({ id: 'a', ts: t0 + 1, promptTokens: 10, completionTokens: 5, requests: 2 }),
          ev({ id: 'b', ts: t0 + 899_999, promptTokens: 1, completionTokens: null, cacheReadTokens: 3 }),
          ev({ id: 'c', ts: t0 + 900_000, promptTokens: 1 }),
          ev({ id: 'zero', ts: t0 + 2, promptTokens: 0, completionTokens: 0, requests: 4 }),
          ev({ id: 'null', ts: t0 + 3, promptTokens: null, completionTokens: null }),
        ]);
        const groups = await store.aggregate({}, ALL);
        assert.deepEqual(groups.map((g) => [g.bucketStartMs - t0, g.tokensKnown, g.requests, g.promptTokens, g.completionTokens, g.cacheReadTokens]), [
          [0, false, 5, 0, 0, 0], // 0/0 and NULL/NULL rows price through credits: one group
          [0, true, 3, 11, 5, 3],
          [900_000, true, 1, 1, 0, 0],
        ]);
      });

      it('orders groups by bucket, then by the dimensions with NULL first', async () => {
        await open();
        await store.insert([
          ev({ id: '1', ts: T('2026-03-15T10:30:00Z'), modelId: 'b' }),
          ev({ id: '2', ts: T('2026-03-15T10:00:00Z'), modelId: 'z', repo: 'r' }),
          ev({ id: '3', ts: T('2026-03-15T10:00:00Z'), modelId: 'z', repo: null }),
          ev({ id: '4', ts: T('2026-03-15T10:00:00Z'), modelId: 'a' }),
        ]);
        const groups = await store.aggregate({}, ALL);
        assert.deepEqual(groups.map((g) => [g.modelId, g.repo]), [['a', null], ['z', null], ['z', 'r'], ['b', null]]);
        assert.deepEqual(groups, groupEvents(await exported(store)));
      });

      it('reads the window [fromMs, toMs) intersected with the filter range', async () => {
        await open();
        const a = T('2026-03-15T00:00:00Z');
        await store.insert([0, 1, 2, 3].map((i) => ev({ id: `w${i}`, ts: a + i * DAY })));
        const ids = async (f: RecordFilter, from: number, to: number): Promise<number[]> =>
          (await store.aggregate(f, { fromMs: from, toMs: to })).map((g) => g.bucketStartMs);
        assert.deepEqual(await ids({}, a + DAY, a + 3 * DAY), [a + DAY, a + 2 * DAY]);
        assert.deepEqual(await ids({ range: { start: a, end: a + 2 * DAY } }, a + DAY, a + 4 * DAY), [a + DAY]);
        assert.deepEqual(await ids({}, a + DAY, a + DAY), []);
        assert.deepEqual(await ids({ range: { start: a + 3 * DAY, end: a + 3 * DAY } }, a, a + 9 * DAY), []);
      });

      it('a windowed aggregateRange over several 7-day windows equals one big aggregate (edges and unaligned starts included)', async () => {
        await open();
        const origin = T('2026-01-05T00:00:00Z');
        const rows: RawEvent[] = [];
        let n = 0;
        // Rows around every plausible window edge of a range starting at an unaligned instant, over ~4 weeks.
        const from = origin + 7 * 60_000 + 123;
        for (let k = 0; k <= 4; k++) {
          const edge = Math.floor(from / 900_000) * 900_000 + k * 7 * DAY;
          for (const d of [-900_001, -900_000, -1, 0, 1, 899_999, 900_000]) {
            rows.push(ev({ id: `r${n++}`, ts: edge + d, modelId: n % 2 ? 'm1' : 'm2', promptTokens: n, requests: 1 + (n % 3) }));
          }
        }
        // Same bucket and dimensions on both sides of an edge: must stay ONE group.
        rows.push(ev({ id: 'x1', ts: from + 7 * DAY - 900_000 + 10, modelId: 'edge' }), ev({ id: 'x2', ts: from + 7 * DAY - 900_000 + 20, modelId: 'edge' }));
        await store.insert(rows);
        const range = { fromMs: from, toMs: from + 28 * DAY + 5 };
        const whole = await store.aggregate({}, range);
        const windowed = await store.aggregateRange({}, range);
        assert.deepEqual(windowed, whole);
        assert.deepEqual(windowed, groupEvents(filterEvents(rows, { range: { start: range.fromMs, end: range.toMs } })));
        assert.equal(windowed.filter((g) => g.modelId === 'edge').length, 1);
        assert.deepEqual(await store.aggregateRange({}, { fromMs: from, toMs: from }), []);
        assert.deepEqual(await store.aggregateRange({ models: ['m1'] }, { fromMs: from, toMs: from + 2 * DAY }), groupEvents(filterEvents(rows, { models: ['m1'], range: { start: from, end: from + 2 * DAY } })));
      });
    });

    describe('requestsByModelForBranch', () => {
      it('sums the requests of each model on the branch (rolled rows have no branch)', async () => {
        await open();
        await store.insert([
          ev({ id: '1', branch: 'main', modelId: 'b', requests: 2 }),
          ev({ id: '2', branch: 'main', modelId: 'a' }),
          ev({ id: '3', branch: 'main', modelId: 'b' }),
          ev({ id: '4', branch: 'other', modelId: 'a' }),
          ev({ id: '5', branch: null, modelId: 'a' }),
        ]);
        assert.deepEqual(await store.requestsByModelForBranch('main'), [{ modelId: 'a', requests: 1 }, { modelId: 'b', requests: 3 }]);
        assert.deepEqual(await store.requestsByModelForBranch('nope'), []);
        await store.clear();
        await store.insert(raw);
        const expected = new Map<string, number>();
        for (const e of raw) if (e.branch === 'main') expected.set(e.modelId, (expected.get(e.modelId) ?? 0) + e.requests);
        assert.ok(expected.size > 0);
        assert.deepEqual(
          new Map((await store.requestsByModelForBranch('main')).map((r) => [r.modelId, r.requests])),
          expected,
        );
      });
    });

    describe('exportRows', () => {
      it('is empty for an empty store', async () => {
        await open();
        assert.deepEqual(await exported(store), []);
      });

      it('streams every row newest first (ts DESC, id DESC) in chunks of the requested size', async () => {
        await open();
        const rows = Array.from({ length: 11 }, (_, i) => ev({ id: `id${String(i).padStart(2, '0')}`, ts: 1_000 + Math.floor(i / 2) }));
        await store.insert(rows);
        const chunks: RawEvent[][] = [];
        for await (const c of store.exportRows(4)) chunks.push(c);
        assert.deepEqual(chunks.map((c) => c.length), [4, 4, 3]);
        const flat = chunks.flat();
        assert.deepEqual(flat.map((e) => e.id), [...rows].sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : -1)).map((e) => e.id));
        // A row count that is an exact multiple of the chunk size ends cleanly too.
        const exact: number[] = [];
        for await (const c of store.exportRows(11)) exact.push(c.length);
        assert.deepEqual(exact, [11]);
        // The default chunk holds everything for a small store, and an early break leaves the store usable.
        for await (const c of store.exportRows()) assert.equal(c.length, 11);
        for await (const c of store.exportRows(2)) {
          assert.equal(c.length, 2);
          break;
        }
        assert.equal(await store.countEvents(), 11);
      });

      it('lets the consumer call the store between chunks', async () => {
        await open();
        await store.insert(Array.from({ length: 6 }, (_, i) => ev({ id: `x${i}`, ts: 100 + i })));
        const seen: number[] = [];
        for await (const c of store.exportRows(2)) {
          seen.push(c.length);
          await store.setMeta('progress', String(seen.length));
        }
        assert.deepEqual(seen, [2, 2, 2]);
        assert.equal(await store.getMeta('progress'), '3');
      });
    });

    describe('compact', () => {
      for (const tz of GOLDEN_TZS) {
        it(`rolls up exactly like rollUpEvents under ${tz}`, async () => {
          await withTz(tz, async () => {
            const NOW = T('2026-11-02T09:30:00Z');
            await open({ now: () => NOW, retentionDays: COMPACTION_RETENTION_DAYS });
            await store.insert(raw);
            await store.compact(NOW);
            const expected = rollUpEvents(raw, NOW, COMPACTION_RETENTION_DAYS);
            assert.ok(expected.rolled.length > 0 && expected.rows.length < raw.length);
            assert.deepEqual(byId(await exported(store)), byId(expected.rows));
            // Idempotent: nothing is left to roll.
            const before = store.dataVersion();
            await store.compact(NOW);
            assert.equal(store.dataVersion(), before);
            assert.deepEqual(byId(await exported(store)), byId(expected.rows));
          });
        });
      }

      it('uses the clock the store was given when `now` is omitted', async () => {
        const NOW = T('2026-11-02T09:30:00Z');
        await open({ now: () => NOW, retentionDays: COMPACTION_RETENTION_DAYS });
        await store.insert(raw);
        await store.compact();
        assert.deepEqual(byId(await exported(store)), byId(rollUpEvents(raw, NOW, COMPACTION_RETENTION_DAYS).rows));
      });

      it('keeps the total of requests and tokens; only branch and language detail goes', async () => {
        const NOW = T('2026-11-02T09:30:00Z');
        await open({ now: () => NOW, retentionDays: COMPACTION_RETENTION_DAYS });
        await store.insert(raw);
        const total = (g: AggregateGroup[]): number[] => [
          g.reduce((a, x) => a + x.requests, 0), g.reduce((a, x) => a + x.promptTokens, 0), g.reduce((a, x) => a + x.completionTokens, 0),
          g.reduce((a, x) => a + x.cacheReadTokens, 0), g.reduce((a, x) => a + x.cacheCreationTokens, 0), g.reduce((a, x) => a + x.thinkingTokens, 0),
        ];
        const before = total(await store.aggregateRange({}, ALL));
        await store.compact();
        assert.deepEqual(total(await store.aggregateRange({}, ALL)), before);
      });

      it('adds late events of an already rolled day into its roll row (sums, NULL only if all NULL, heuristic wins)', async () => {
        const NOW = T('2026-11-02T09:30:00Z');
        await open({ now: () => NOW, retentionDays: 30 });
        const day = T('2026-01-10T12:00:00Z');
        const a = [
          ev({ id: 'a1', ts: day, repo: 'r', attribution: 'authoritative', promptTokens: null, completionTokens: null, requests: 2, cacheReadTokens: 1 }),
          ev({ id: 'z1', ts: day, repo: 'q', attribution: null, promptTokens: 5 }),
        ];
        const b = [
          ev({ id: 'a2', ts: day + 1000, repo: 'r', attribution: 'heuristic', promptTokens: null, completionTokens: 3, cacheCreationTokens: 4, thinkingTokens: 5 }),
          ev({ id: 'a3', ts: day + 2000, repo: 'r', attribution: null, promptTokens: null, completionTokens: null, requests: 3 }),
          ev({ id: 'z2', ts: day + 1000, repo: 'q', attribution: null, promptTokens: null }),
        ];
        await store.insert(a);
        await store.compact();
        await store.insert(b);
        await store.compact();
        assert.deepEqual(byId(await exported(store)), byId(rollUpEvents([...a, ...b], NOW, 30).rows));
        const rolled = byId(await exported(store));
        assert.deepEqual(rolled.map((r) => [r.repo, r.requests, r.promptTokens, r.completionTokens, r.attribution]), [
          ['q', 2, 5, null, null],
          ['r', 6, null, 3, 'heuristic'],
        ]);
        // A rolled row never rolls again, and 'authoritative' alone stays authoritative.
        await store.compact(NOW + 365 * DAY);
        assert.equal((await exported(store)).length, 2);
      });

      it('rolls a repo literally named "unattributed" as no repo', async () => {
        const NOW = T('2026-11-02T09:30:00Z');
        await open({ now: () => NOW, retentionDays: 30 });
        const day = T('2026-01-10T12:00:00Z');
        await store.insert([ev({ id: 'u1', ts: day, repo: 'unattributed' }), ev({ id: 'u2', ts: day, repo: null })]);
        await store.compact();
        const rows = await exported(store);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.repo, null);
        assert.equal(rows[0]!.requests, 2);
      });

      it('past the raw-row cap rolls the oldest whole days, never today', async () => {
        const NOW = T('2026-11-02T15:00:00Z');
        await open({ now: () => NOW, retentionDays: 3650, maxRawEvents: 5 });
        const today = startOf(NOW, 'day');
        const rows: RawEvent[] = [];
        for (let d = 6; d >= 1; d--) for (const h of [3, 9]) rows.push(ev({ id: `d${d}h${h}`, ts: dayStartOffset(NOW, -d) + h * 3_600_000, repo: `r${d}` }));
        for (const h of [1, 2, 3]) rows.push(ev({ id: `today${h}`, ts: today + h * 3_600_000 }));
        // 15 raw rows, cap 5: the oldest ten (five whole days) roll up; the insert that crossed the cap already did it.
        await store.insert(rows);
        const left = (await exported(store)).filter((e) => !e.id.startsWith('roll:')).map((e) => e.id).sort();
        assert.deepEqual(left, ['d1h3', 'd1h9', 'today1', 'today2', 'today3']);
        assert.equal((await exported(store)).filter((e) => e.id.startsWith('roll:')).length, 5);
        // Everything within today: nothing can be rolled to meet the cap.
        const s2 = await open({ now: () => NOW, retentionDays: 3650, maxRawEvents: 2 });
        await s2.insert([1, 2, 3, 4].map((h) => ev({ id: `t${h}`, ts: today + h * 3_600_000 })));
        assert.equal(await s2.countEvents(), 4);
      });

      it('a compaction below the cap and inside the retention window changes nothing', async () => {
        const NOW = T('2026-11-02T15:00:00Z');
        await open({ now: () => NOW, retentionDays: 90 });
        await store.insert([ev({ id: 'recent', ts: NOW - DAY })]);
        const v = store.dataVersion();
        await store.compact();
        assert.equal(store.dataVersion(), v);
        assert.equal(await store.countEvents(), 1);
      });

      it('rolls a large old day (more rows than one slice and one yield interval)', async () => {
        const NOW = T('2026-11-02T09:30:00Z');
        await open({ now: () => NOW, retentionDays: 30, maxRawEvents: 1_000_000 });
        const day = T('2026-01-10T00:00:00Z');
        const rows = Array.from({ length: 5_300 }, (_, i) => ev({ id: `big${i}`, ts: day + i * 1000, promptTokens: 2, completionTokens: 1, requests: 1 }));
        await store.insert(rows);
        await store.compact();
        const left = await exported(store);
        assert.equal(left.length, 1);
        assert.deepEqual([left[0]!.requests, left[0]!.promptTokens, left[0]!.completionTokens], [5_300, 10_600, 5_300]);
      });
    });

    describe('clear, meta and ingest state', () => {
      it('clear wipes events, meta and ingest state, and bumps the version', async () => {
        await open();
        await store.insert([ev()]);
        await store.setMeta('k', 'v');
        await store.setIngestState({ file: '/a.jsonl', size: 1, mtimeMs: 2, byteOffset: 1, headHash: 'h' });
        const v = store.dataVersion();
        await store.clear();
        assert.ok(store.dataVersion() > v);
        assert.equal(await store.countEvents(), 0);
        assert.equal(await store.getMeta('k'), null);
        assert.deepEqual(await store.listIngestState(), []);
        assert.deepEqual(await exported(store), []);
        await store.clear(); // clearing an empty store is fine
      });

      it('meta is a key-value store', async () => {
        await open();
        assert.equal(await store.getMeta('missing'), null);
        await store.setMeta('k', 'one');
        await store.setMeta('k', 'two');
        await store.setMeta('empty', '');
        assert.equal(await store.getMeta('k'), 'two');
        assert.equal(await store.getMeta('empty'), '');
      });

      it('ingest state is per file: get, upsert, list (sorted), delete', async () => {
        await open();
        const a = { file: '/logs/a.jsonl', size: 100, mtimeMs: 1_700_000_000_123.5, byteOffset: 90, headHash: 'aa' };
        const b = { file: '/logs/b.jsonl', size: 5, mtimeMs: 7, byteOffset: 0, headHash: 'bb' };
        assert.equal(await store.getIngestState(a.file), null);
        await store.setIngestState(b);
        await store.setIngestState(a);
        assert.deepEqual(await store.getIngestState(a.file), a);
        await store.setIngestState({ ...a, size: 200, byteOffset: 190 });
        assert.deepEqual(await store.getIngestState(a.file), { ...a, size: 200, byteOffset: 190 });
        assert.deepEqual((await store.listIngestState()).map((s) => s.file), [a.file, b.file]);
        await store.deleteIngestState(a.file);
        await store.deleteIngestState(a.file);
        assert.deepEqual((await store.listIngestState()).map((s) => s.file), [b.file]);
      });
    });

    describe('dataVersion', () => {
      it('changes with every change of the data and stays put otherwise', async () => {
        await open({ now: () => T('2026-11-02T09:30:00Z'), retentionDays: 30 });
        const v0 = store.dataVersion();
        assert.equal(store.dataVersion(), v0);
        await store.insert([ev({ id: 'v1', ts: T('2026-01-10T00:00:00Z'), source: 'claude-code', promptTokens: 1 })]);
        const v1 = store.dataVersion();
        assert.notEqual(v1, v0);
        await store.insert([ev({ id: 'v1', ts: T('2026-01-10T00:00:00Z'), source: 'claude-code', promptTokens: 1 })]);
        assert.equal(store.dataVersion(), v1, 'a re-insert that changes nothing');
        await store.insert([ev({ id: 'v1', ts: T('2026-01-10T00:00:00Z'), source: 'claude-code', promptTokens: 9 })]);
        const v2 = store.dataVersion();
        assert.notEqual(v2, v1, 'a raised Claude row');
        await store.compact();
        assert.notEqual(store.dataVersion(), v2, 'a compaction that rolled rows');
        await store.checkpoint();
      });
    });

    describe('dispose', () => {
      it('close() and dispose() are idempotent', async () => {
        await open();
        await store.insert([ev()]);
        await store.close();
        await store.close();
        store.dispose();
      });
    });
  });
}

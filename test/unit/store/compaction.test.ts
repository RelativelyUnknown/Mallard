import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../../../src/extension-backend/store/EventStore';
import { readRows } from '../../../src/extension-backend/store/dbUtils';
import { UsageEvent } from '../../../src/extension-backend/domain/types';
import { dayStartOffset } from '../../../src/extension-backend/util/time';
import { makeEvent } from '../helpers';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-compact-'));
}

/** Run `fn` with the process timezone set (DuckDB's session tz follows it at open). */
async function withTimeZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const original = process.env.TZ;
  process.env.TZ = tz;
  try {
    assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, tz, 'timezone switch took effect');
    return await fn();
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
}

async function rolledRows(store: EventStore): Promise<UsageEvent[]> {
  return (await store.reader.find()).filter((e) => e.id.startsWith('roll:'));
}

async function factRows(store: EventStore): Promise<Array<{ dateId: number; eventCount: number }>> {
  return readRows(
    store.conn,
    'SELECT date_id, SUM(event_count) AS n FROM fact_daily_usage GROUP BY date_id ORDER BY date_id',
    (r) => ({ dateId: Number(r['date_id']), eventCount: Number(r['n']) }),
  );
}

describe('compaction rollup', () => {
  const now = new Date(2026, 5, 15, 12).getTime(); // cutoff = 2026-03-17 00:00 local (90 days back)
  const oldDay = new Date(2026, 0, 10, 12).getTime();

  it('adds late events into the roll row of an already-compacted day', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([
        makeEvent({ id: 'o1', ts: oldDay, repo: 'r', credits: 2, cost: 0.08, promptTokens: 10, completionTokens: 5,
          costByCategory: { input: 0.06, output: 0.02 } }),
      ]);
      await store.compact(now);
      const [first] = await rolledRows(store);
      assert.ok(first, 'first compaction produces a roll row');
      assert.equal(first.credits, 2);
      assert.deepEqual(first.costByCategory, { input: 0.06, output: 0.02 }, 'category split survives the rollup');

      // The same day/group receives a late event (e.g. a connector enabled afterwards).
      await store.writer.insert([
        makeEvent({ id: 'o2', ts: oldDay + 1000, repo: 'r', credits: 3, cost: 0.12, promptTokens: 20, completionTokens: 7,
          costByCategory: { input: 0.1, tool: 0.02 } }),
      ]);
      await store.compact(now);

      const rows = await rolledRows(store);
      assert.equal(rows.length, 1, 'merged into the existing roll row, not dropped or duplicated');
      assert.equal(rows[0]!.credits, 5);
      assert.ok(Math.abs(rows[0]!.cost - 0.2) < 1e-9);
      assert.equal(rows[0]!.promptTokens, 30);
      assert.equal(rows[0]!.completionTokens, 12);
      const cats = rows[0]!.costByCategory!;
      assert.ok(Math.abs((cats['input'] ?? 0) - 0.16) < 1e-9);
      assert.ok(Math.abs((cats['output'] ?? 0) - 0.02) < 1e-9);
      assert.ok(Math.abs((cats['tool'] ?? 0) - 0.02) < 1e-9);
      assert.equal(await store.count(), 1, 'no raw rows left behind');
    } finally { store.dispose(); }
  });

  it('keeps a repo literally named "unattributed" and NULL-repo events from colliding', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([
        makeEvent({ id: 'n', ts: oldDay, credits: 3 }),                          // repo NULL
        makeEvent({ id: 'u', ts: oldDay + 1000, repo: 'unattributed', credits: 4 }),
      ]);
      await store.compact(now);
      const rows = await rolledRows(store);
      assert.equal(rows.length, 1, 'both are the unattributed sentinel — one roll row');
      assert.equal(rows[0]!.credits, 7, 'neither group may be silently dropped');
      assert.equal(rows[0]!.repo, undefined);
    } finally { store.dispose(); }
  });

  it('sums token counts past the INTEGER range', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([
        makeEvent({ id: 't1', ts: oldDay, promptTokens: 2_000_000_000, completionTokens: 1_500_000_000 }),
        makeEvent({ id: 't2', ts: oldDay + 1000, promptTokens: 2_000_000_000, completionTokens: 1_500_000_000 }),
      ]);
      await store.compact(now);
      const [row] = await rolledRows(store);
      assert.equal(row!.promptTokens, 4_000_000_000);
      assert.equal(row!.completionTokens, 3_000_000_000);
    } finally { store.dispose(); }
  });

  it('rolls events strictly before the day-aligned cutoff; an event exactly at it stays raw', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      const cutoff = dayStartOffset(now, -90);
      assert.equal(cutoff, new Date(2026, 2, 17).getTime());
      await store.writer.insert([
        makeEvent({ id: 'before', ts: cutoff - 1 }),          // 23:59:59.999 the day before
        makeEvent({ id: 'at', ts: cutoff }),                  // 00:00:00.000 on the cutoff day
        makeEvent({ id: 'later', ts: cutoff + 12 * 3_600_000 }),
      ]);
      await store.compact(now);
      const ids = (await store.reader.find()).map((e) => e.id);
      assert.ok(ids.includes('at'), 'event exactly at the cutoff stays raw');
      assert.ok(ids.includes('later'));
      assert.ok(!ids.includes('before'), 'event just before the cutoff is rolled');
      assert.equal(ids.filter((i) => i.startsWith('roll:')).length, 1);
    } finally { store.dispose(); }
  });

  it('computes the cutoff in calendar days across a DST shift', async () => {
    await withTimeZone('America/New_York', async () => {
      const store = await EventStore.open(await tmpDir());
      try {
        // 00:30 EDT on 2026-03-30; 90×24h earlier is 23:30 EST on Dec 29 — one
        // calendar day too early, which kept Dec 29 raw for an extra day.
        const dstNow = new Date(2026, 2, 30, 0, 30).getTime();
        await store.writer.insert([
          makeEvent({ id: 'dec29', ts: new Date(2025, 11, 29, 12).getTime() }), // 91 days old
          makeEvent({ id: 'dec30', ts: new Date(2025, 11, 30, 12).getTime() }), // 90 days old
        ]);
        await store.compact(dstNow);
        const ids = (await store.reader.find()).map((e) => e.id);
        assert.ok(!ids.includes('dec29'), 'Dec 29 is older than 90 calendar days and is rolled');
        assert.ok(ids.includes('dec30'), 'Dec 30 is inside the window and stays raw');
      } finally { store.dispose(); }
    });
  });

  it('rolls up and deletes atomically — a failure leaves the raw events untouched', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([makeEvent({ id: 'o1', ts: oldDay }), makeEvent({ id: 'o2', ts: oldDay + 1 })]);
      await store.conn.run('DROP TABLE dim_surface'); // makes the post-rollup fact rebuild throw
      await assert.rejects(store.compact(now));
      assert.deepEqual((await store.reader.find()).map((e) => e.id), ['o1', 'o2']);
    } finally { store.dispose(); }
  });

  it('rebuilds facts so the rolled days stay represented', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([
        makeEvent({ id: 'o1', ts: oldDay }),
        makeEvent({ id: 'r1', ts: now - 1000 }),
      ]);
      await store.compact(now);
      const facts = await factRows(store);
      assert.deepEqual(facts.map((f) => f.dateId), [20260110, 20260615]);
    } finally { store.dispose(); }
  });
});

describe('EventWriter.insert — fact refresh window', () => {
  it('covers the last hour of a 25h DST fall-back day', async () => {
    await withTimeZone('America/New_York', async () => {
      const store = await EventStore.open(await tmpDir());
      try {
        // 2026-11-01 is 25 hours long in New York; startOf(day) + 24h = 23:00.
        await store.writer.insert([makeEvent({ id: 'late', ts: new Date(2026, 10, 1, 23, 30).getTime() })]);
        assert.deepEqual(await factRows(store), [{ dateId: 20261101, eventCount: 1 }]);
      } finally { store.dispose(); }
    });
  });

  it('is atomic with the event insert — a failed refresh leaves no events behind', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.conn.run('DROP TABLE dim_surface'); // makes the fact refresh throw
      await assert.rejects(store.writer.insert([makeEvent({ id: 'a', ts: 1000 })]));
      assert.equal(await store.count(), 0);
    } finally { store.dispose(); }
  });
});

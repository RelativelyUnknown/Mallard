import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../../../src/extension-backend/store/EventStore';
import { EventWriter } from '../../../src/extension-backend/store/EventWriter';
import { readRows } from '../../../src/extension-backend/store/dbUtils';
import { makeEvent } from '../helpers';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-writer-'));
}

async function factEventCount(store: EventStore): Promise<number> {
  const rows = await readRows(
    store.conn,
    'SELECT COALESCE(SUM(event_count), 0) AS n FROM fact_daily_usage',
    (r) => Number(r['n']),
  );
  return rows[0] ?? 0;
}

describe('EventWriter — serialised mutations', () => {
  it('keeps concurrent inserts, compact, remove and setPrices consistent', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      const base = new Date(2026, 5, 10, 12).getTime();
      const batch = (b: number) =>
        Array.from({ length: 40 }, (_, i) =>
          makeEvent({ id: `b${b}-${i}`, ts: base + b * 60_000 + i, modelId: b === 2 ? 'drop-me' : 'gpt-4o' }),
        );

      // Fired without awaiting in between — the writer queues them in call order.
      const results = await Promise.all([
        store.writer.insert(batch(0)),
        store.writer.insert(batch(1)),
        store.writer.insert(batch(2)),
        store.writer.setPrices([{ modelId: 'gpt-4o', multiplier: 2 }]),
        store.writer.compact(base),
        store.writer.remove({ models: ['drop-me'] }),
        store.writer.insert(batch(3)),
      ]);

      assert.deepEqual([results[0], results[1], results[2], results[6]], [40, 40, 40, 40],
        'each insert reports exactly its own rows (they share the staging table)');
      assert.equal(results[5], 40, 'remove sees the rows inserted before it in the queue');
      assert.equal(await store.count(), 120);
      assert.equal(await factEventCount(store), 120, 'facts match the events');
    } finally { store.dispose(); }
  });

  it('keeps accepting work after a mutation fails', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.conn.run('DROP TABLE dim_surface');
      await assert.rejects(store.writer.insert([makeEvent({ id: 'a', ts: 1000 })]));
      await store.conn.run(`CREATE TABLE dim_surface (id TINYINT PRIMARY KEY, name VARCHAR UNIQUE NOT NULL)`);
      await store.conn.run(`INSERT INTO dim_surface VALUES (0,'chat'),(1,'inline'),(2,'agent'),(3,'edit'),(4,'unknown')`);
      assert.equal(await store.writer.insert([makeEvent({ id: 'b', ts: 2000 })]), 1);
      assert.equal(await store.count(), 1, 'the failed insert was rolled back, the next one committed');
    } finally { store.dispose(); }
  });
});

describe('EventWriter.insert — re-reads', () => {
  it('leaves the snapshot memo alone when every row was already stored', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      const token = { version: 0 };
      const writer = new EventWriter(store.conn, 90, token);
      const events = [makeEvent({ id: 'a', ts: 1000 }), makeEvent({ id: 'b', ts: 2000 })];
      assert.equal(await writer.insert(events), 2);
      assert.equal(token.version, 1);
      // The watermark re-read hands back the same rows on every ingest tick.
      assert.equal(await writer.insert(events), 0);
      assert.equal(token.version, 1, 'no new rows, no invalidation');
    } finally { store.dispose(); }
  });
});

describe('EventWriter.remove', () => {
  it('refreshes the facts of the affected days', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      const day = new Date(2026, 5, 10, 12).getTime();
      await store.writer.insert([
        makeEvent({ id: 'a', ts: day, modelId: 'gpt-4o' }),
        makeEvent({ id: 'b', ts: day + 1000, modelId: 'claude-sonnet-4' }),
      ]);
      assert.equal(await factEventCount(store), 2);
      assert.equal(await store.writer.remove({ models: ['gpt-4o'] }), 1);
      assert.equal(await factEventCount(store), 1, 'no stale fact row for the removed model');
    } finally { store.dispose(); }
  });

  it('deletes nothing and returns 0 for a filter with only limit/offset', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([makeEvent({ id: 'a', ts: 1000 }), makeEvent({ id: 'b', ts: 2000 })]);
      assert.equal(await store.writer.remove({ limit: 1 }), 0);
      assert.equal(await store.writer.remove({ offset: 1 }), 0);
      assert.equal(await store.writer.remove({ limit: 1, offset: 1 }), 0);
      assert.equal(await store.count(), 2);
    } finally { store.dispose(); }
  });

  it('ignores limit/offset next to a real filter (every match is removed)', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([
        makeEvent({ id: 'a', ts: 1000, modelId: 'gpt-4o' }),
        makeEvent({ id: 'b', ts: 2000, modelId: 'gpt-4o' }),
      ]);
      assert.equal(await store.writer.remove({ models: ['gpt-4o'], limit: 1 }), 2);
    } finally { store.dispose(); }
  });

  it('filters by repos, branches and the unattributed sentinel like the reader does', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([
        makeEvent({ id: 'a', ts: 1000, repo: 'org/a', branch: 'main' }),
        makeEvent({ id: 'b', ts: 2000, repo: 'org/b', branch: 'dev' }),
        makeEvent({ id: 'c', ts: 3000 }),
      ]);
      assert.equal(await store.writer.remove({ repos: ['org/a', 'unattributed'], branches: ['main'] }), 1);
      assert.deepEqual((await store.reader.find()).map((e) => e.id), ['b', 'c']);
    } finally { store.dispose(); }
  });
});

describe('EventWriter.setPrices', () => {
  it('bumps the snapshot cache token even for an empty list', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      const token = { version: 0 };
      const writer = new EventWriter(store.conn, 90, token);
      await writer.setPrices([]);
      assert.equal(token.version, 1);
    } finally { store.dispose(); }
  });

  it('replaces atomically — a failing entry leaves the previous prices in place', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.setPrices([{ modelId: 'gpt-4o', multiplier: 2 }]);
      await assert.rejects(
        store.writer.setPrices([
          { modelId: 'dup', multiplier: 1 },
          { modelId: 'dup', multiplier: 3 }, // primary-key violation
        ]),
      );
      const prices = await readRows(store.conn, 'SELECT modelId, multiplier FROM prices', (r) => ({
        modelId: String(r['modelId']), multiplier: Number(r['multiplier']),
      }));
      assert.deepEqual(prices, [{ modelId: 'gpt-4o', multiplier: 2 }]);
    } finally { store.dispose(); }
  });
});

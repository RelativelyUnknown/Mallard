import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventReader } from '../../../src/extension-backend/store/EventReader';
import { EventStore } from '../../../src/extension-backend/store/EventStore';
import { makeEvent } from '../helpers';

async function withStore<T>(fn: (store: EventStore) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-eventreader-'));
  const store = await EventStore.open(dir);
  try {
    return await fn(store);
  } finally {
    store.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Run `fn` with console.warn captured (the reader reports skipped rows there). */
async function capturingWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const original = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(' '));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe('EventReader.exportTo', () => {
  it('rejects an unsupported format before touching the database', async () => {
    const reader = new EventReader({} as never);
    await assert.rejects(
      reader.exportTo('/tmp/whatever.out', 'xml' as never),
      /Invalid export format/,
    );
  });
});

describe('EventReader — rows that do not fit the event schema', () => {
  const insertRaw = (store: EventStore, id: string, credits: string, extraCols = '', extraVals = '') =>
    store.conn.run(
      `INSERT INTO events (id, ts, modelId, surface, source, credits, cost, estimated${extraCols}) ` +
        `VALUES ('${id}', 1000, 'gpt-4o', 'chat', 'local', ${credits}, 0.04, false${extraVals})`,
    );

  it('skips (and reports) a row with a non-finite number instead of failing the whole read', async () => {
    await withStore(async (store) => {
      await store.writer.insert([makeEvent({ id: 'good', ts: 2000, credits: 2 })]);
      await insertRaw(store, 'bad', `'NaN'::DOUBLE`);

      const { result: all, warnings } = await capturingWarnings(() => store.reader.find());
      assert.deepEqual(all.map((e) => e.id), ['good'], 'the malformed row is left out, the good one survives');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /skipping malformed row/);

      const { result: filtered } = await capturingWarnings(() => store.reader.find({ models: ['gpt-4o'] }));
      assert.deepEqual(filtered.map((e) => e.id), ['good'], 'the filtered path skips it too');
      const { result: byId } = await capturingWarnings(() => store.reader.findById('bad'));
      assert.equal(byId, null, 'a malformed row is not found by id either');
      assert.equal((await store.reader.findById('good'))?.credits, 2);
    });
  });

  it('keeps the event when only its costByCategory is unreadable JSON, just without the breakdown', async () => {
    await withStore(async (store) => {
      await insertRaw(store, 'cats-bad', '3', ', costByCategory', `, 'not json {'`);
      await insertRaw(store, 'cats-ok', '4', ', costByCategory', `, '{"input":0.5}'`);
      const byId = new Map((await store.reader.find()).map((e) => [e.id, e]));
      assert.equal(byId.get('cats-bad')?.credits, 3);
      assert.equal('costByCategory' in byId.get('cats-bad')!, false);
      assert.deepEqual(byId.get('cats-ok')?.costByCategory, { input: 0.5 });
    });
  });
});

describe('EventReader.find — stored events round-trip', () => {
  it('returns every optional column exactly as it was written, and omits the ones that were never set', async () => {
    await withStore(async (store) => {
      const full = makeEvent({
        id: 'full', ts: 1000, credits: 2, cost: 0.08, estimated: true,
        promptTokens: 120, completionTokens: 30, repo: 'org/x', branch: 'main',
        attribution: 'heuristic', language: 'typescript', costByCategory: { input: 0.05, output: 0.03 },
      });
      const bare = makeEvent({ id: 'bare', ts: 2000 });
      await store.writer.insert([full, bare]);
      const byId = new Map((await store.reader.find()).map((e) => [e.id, e]));
      assert.deepEqual(byId.get('full'), full);
      assert.deepEqual(byId.get('bare'), bare);
      for (const key of ['promptTokens', 'completionTokens', 'repo', 'branch', 'attribution', 'language', 'costByCategory']) {
        assert.equal(key in byId.get('bare')!, false, `${key} is absent, not null/undefined`);
      }
    });
  });

  it('pages with limit and offset, and ignores a limit that is not an integer', async () => {
    await withStore(async (store) => {
      await store.writer.insert(Array.from({ length: 5 }, (_, i) => makeEvent({ id: `e${i}`, ts: 1000 + i })));
      const ids = async (filter: Parameters<EventReader['find']>[0]) => (await store.reader.find(filter)).map((e) => e.id);
      assert.deepEqual(await ids({ limit: 2 }), ['e0', 'e1']);
      assert.deepEqual(await ids({ limit: 2, offset: 2 }), ['e2', 'e3']);
      assert.deepEqual(await ids({ limit: 1.5 }), ['e0', 'e1', 'e2', 'e3', 'e4'], 'a fractional limit is not spliced into the SQL');
    });
  });
});

describe('EventReader — pivot and rank sanitise their column arguments', () => {
  it('pivot() falls back to surface/credits for names that are not plain identifiers', async () => {
    await withStore(async (store) => {
      await store.writer.insert([
        makeEvent({ id: 'a', ts: 1000, surface: 'chat', credits: 3, modelId: 'gpt-4o' }),
        makeEvent({ id: 'b', ts: 2000, surface: 'inline', credits: 2, modelId: 'gpt-4o' }),
      ]);
      const expected = await store.reader.pivot({}, 'surface', 'credits');
      const sanitised = await store.reader.pivot({}, 'surface; DROP TABLE events', 'credits) --');
      assert.deepEqual(sanitised, expected);
      assert.deepEqual(sanitised.columnKeys.sort(), ['chat', 'inline']);
      assert.equal(await store.count(), 2, 'nothing was injected');
    });
  });

  it('pivot() on a nullable column leaves the NULL group out of the columns', async () => {
    await withStore(async (store) => {
      await store.writer.insert([
        makeEvent({ id: 'a', ts: 1000, repo: 'org/x', credits: 3 }),
        makeEvent({ id: 'b', ts: 2000, credits: 2 }), // no repo
      ]);
      const result = await store.reader.pivot({}, 'repo', 'credits');
      assert.deepEqual(result.columnKeys, ['org/x']);
      assert.equal(result.rows[0]!['org/x'], 3);
    });
  });

  it('rank() falls back to ranking by credits, and to a limit of 10, for unusable arguments', async () => {
    await withStore(async (store) => {
      await store.writer.insert(
        Array.from({ length: 12 }, (_, i) => makeEvent({ id: `m${i}`, ts: 1000 + i, modelId: `model-${i}`, credits: i + 1 })),
      );
      const bad = await store.reader.rank({}, 'credits; --', 0);
      assert.equal(bad.length, 10, 'a non-positive limit means the default of 10');
      assert.equal(bad[0]!.key, 'model-11', 'highest credits first');
      const fractional = await store.reader.rank({}, 'credits', 2.5);
      assert.equal(fractional.length, 10, 'a non-integer limit is not trusted either');
      const three = await store.reader.rank({}, 'credits', 3);
      assert.deepEqual(three.map((r) => r.key), ['model-11', 'model-10', 'model-9']);
    });
  });
});

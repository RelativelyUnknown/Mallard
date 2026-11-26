import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import type { RawEvent } from '../../../../src/extension-backend/domain/contracts';
import type { Logger } from '../../../../src/extension-backend/util/logger';
import { Db, SqliteUnavailableError, isBusyError } from '../../../../src/extension-backend/store/sqlite/Db';
import { invalidReason } from '../../../../src/extension-backend/store/eventRules';
import { PartialInsertError, SqliteEventStore } from '../../../../src/extension-backend/store/sqlite/SqliteEventStore';
import type { SqliteStoreOptions } from '../../../../src/extension-backend/store/sqlite/SqliteEventStore';
import { FAST_RETRY, flakyLoader, removeDir, spawnDbChild, tempDir } from './helpers';
import type { DbChild } from './helpers';
import { ev } from './storeContract';

const DAY = 86_400_000;
const T = (iso: string): number => Date.parse(iso);

function rows(n: number, over: (i: number) => Partial<RawEvent> = () => ({})): RawEvent[] {
  return Array.from({ length: n }, (_, i) => ev({ id: `r${i}`, ts: T('2026-03-01T00:00:00Z') + i * 1000, ...over(i) }));
}

function recorder(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const at = (level: string) => (tag: string, msg: string): void => { lines.push(`${level} ${tag} ${msg}`); };
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

/** Counts event-loop turns while `fn` runs: proof that the work yields between its slices. */
async function turnsDuring<T>(fn: () => Promise<T>): Promise<{ result: T; turns: number }> {
  let turns = 0;
  let stop = false;
  const tick = (): void => {
    turns++;
    if (!stop) setImmediate(tick);
  };
  setImmediate(tick);
  const result = await fn();
  stop = true;
  return { result, turns };
}

describe('SqliteEventStore', () => {
  let dir: string;
  const open_: SqliteEventStore[] = [];
  const children: DbChild[] = [];
  const open = async (opts: SqliteStoreOptions = {}, where?: string): Promise<SqliteEventStore> => {
    const s = await SqliteEventStore.open(where ?? dir, { busy: FAST_RETRY, ...opts });
    open_.push(s);
    return s;
  };
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    for (const c of children.splice(0)) c.kill();
    for (const s of open_.splice(0)) await s.close();
    await removeDir(dir);
  });

  describe('opening', () => {
    it('creates the directory and events.sqlite in WAL mode, and keeps its contents across reopen', async () => {
      const nested = path.join(dir, 'a', 'b');
      const s = await open({}, nested);
      await s.insert(rows(3));
      await s.setMeta('k', 'v');
      await s.setIngestState({ file: '/f', size: 1, mtimeMs: 2.5, byteOffset: 3, headHash: 'h' });
      await s.close();
      assert.ok(fs.existsSync(path.join(nested, 'events.sqlite')));
      const again = await open({}, nested);
      assert.equal(await again.countEvents(), 3);
      assert.equal(await again.getMeta('k'), 'v');
      assert.deepEqual(await again.getIngestState('/f'), { file: '/f', size: 1, mtimeMs: 2.5, byteOffset: 3, headHash: 'h' });
    });

    it('rejects with SqliteUnavailableError when the driver cannot be loaded', async () => {
      await assert.rejects(
        SqliteEventStore.open(dir, { loader: () => { throw new Error('ERR_UNKNOWN_BUILTIN_MODULE'); } }),
        (e: unknown) => e instanceof SqliteUnavailableError && /1\.101/.test(e.message),
      );
    });

    it('retries a busy open (another window creating the file) and then works', async () => {
      const { loader, faults } = flakyLoader({ open: 2 });
      const s = await open({ loader });
      assert.equal(faults.opens, 3);
      assert.equal((await s.insert(rows(1))).inserted, 1);
    });

    it('warns when a file database cannot use WAL, but not for :memory:', async () => {
      const a = recorder();
      await open({ loader: flakyLoader({ journal: 'delete' }).loader, logger: a.logger });
      assert.ok(a.lines.some((l) => /could not switch to WAL \(journal mode "delete"\)/.test(l)), a.lines.join('\n'));
      const b = recorder();
      await open({ logger: b.logger }, ':memory:');
      assert.deepEqual(b.lines, []);
    });
  });

  describe('insert', () => {
    it('commits in batches of `rows` rows or `ms` milliseconds, yielding to the event loop between them', async () => {
      const { loader, faults } = flakyLoader();
      const s = await open({ loader, batch: { rows: 3 } });
      const opened = faults.begins; // the migration's own BEGIN IMMEDIATE
      const { result, turns } = await turnsDuring(() => s.insert(rows(10)));
      assert.equal(result.inserted, 10);
      assert.equal(faults.begins - opened, 4, '3 + 3 + 3 + 1 rows');
      assert.ok(turns >= 3, `turns ${turns}`);

      // Time box: the clock jumps 20 ms per reading, checked every 64 rows: batches of 64.
      let t = 0;
      const timed = await open({ loader: flakyLoader().loader, batch: { rows: 1000, ms: 15, clock: () => (t += 20) } }, ':memory:');
      const before = t;
      assert.equal((await timed.insert(rows(130))).inserted, 130);
      assert.equal((t - before) / 20, 3 + 2, 'three batches: a start reading each, and a check after 64 rows in two of them');
      assert.deepEqual((await (async () => { const out: string[] = []; for await (const c of timed.exportRows(1000)) out.push(...c.map((e) => e.id)); return out; })()).length, 130);
    });

    it('retries BEGIN IMMEDIATE while busy, with no busy wait, and keeps the rows exact', async () => {
      const { loader, faults } = flakyLoader();
      const s = await open({ loader });
      const opened = faults.begins;
      faults.begin = 3;
      const r = await s.insert(rows(5));
      assert.deepEqual([r.inserted, faults.begins - opened], [5, 4]);
      assert.equal(await s.countEvents(), 5);
    });

    it('waits for a real competing connection that holds the write lock, then writes', async () => {
      const s = await open({ busy: { ...FAST_RETRY, attempts: 50 } });
      const rival = Db.open(path.join(dir, 'events.sqlite'));
      rival.exec('BEGIN IMMEDIATE');
      let sleeps = 0;
      const s2 = await open({ busy: { sleep: async () => { if (++sleeps === 3) rival.exec('COMMIT'); }, random: () => 0 } });
      const r = await s2.insert(rows(4));
      rival.close();
      assert.deepEqual([r.inserted, sleeps], [4, 3]);
      assert.equal(await s.countEvents(), 4);
    });

    it('a failure before anything was committed is the plain error; after some batches it is a PartialInsertError carrying what was committed', async () => {
      const first = flakyLoader();
      const s = await open({ loader: first.loader, batch: { rows: 2 }, busy: { ...FAST_RETRY, attempts: 2 } }, ':memory:');
      first.faults.begin = Infinity;
      await assert.rejects(s.insert(rows(4)), (e: unknown) => isBusyError(e) && !(e instanceof PartialInsertError));

      const second = flakyLoader();
      const p = await open({ loader: second.loader, batch: { rows: 2 }, busy: { ...FAST_RETRY, attempts: 2 } }, ':memory:');
      second.faults.beginAfter = second.faults.begins + 2;
      const before = p.dataVersion();
      await assert.rejects(p.insert(rows(7, (i) => (i === 0 ? { source: 'claude-code' } : {}))), (e: unknown) => {
        assert.ok(e instanceof PartialInsertError);
        assert.equal(e.name, 'PartialInsertError');
        assert.ok(isBusyError(e.cause));
        assert.deepEqual(e.partial.fresh.map((r) => r.id), ['r0', 'r1', 'r2', 'r3']);
        assert.deepEqual([e.partial.inserted, e.partial.updated, e.partial.rejected], [4, 0, 0]);
        return true;
      });
      assert.notEqual(p.dataVersion(), before);
      assert.equal(await p.countEvents(), 4);
    });

    it('refuses invalid rows with a warning that names the first one', async () => {
      const r = recorder();
      const s = await open({ logger: r.logger });
      const out = await s.insert([ev({ id: 'bad1', ts: NaN }), ev({ id: 'bad2', requests: -3 }), ev({ id: 'ok' })]);
      assert.deepEqual([out.inserted, out.rejected], [1, 2]);
      assert.deepEqual(r.lines, ['warn store refused 2 invalid event(s), e.g. bad1 (ts)']);
      assert.equal(invalidReason(ev()), null);
    });

    it('rolls up automatically once an insert pushes the raw rows past the cap', async () => {
      const NOW = T('2026-03-10T12:00:00Z');
      const s = await open({ now: () => NOW, maxRawEvents: 10, retentionDays: 3650 });
      const old = rows(8, (i) => ({ id: `old${i}`, ts: T('2026-03-01T10:00:00Z') + i * 1000 }));
      const recent = rows(4, (i) => ({ id: `new${i}`, ts: T('2026-03-09T10:00:00Z') + i * 1000 }));
      await s.insert([...old, ...recent]);
      const left: string[] = [];
      for await (const c of s.exportRows()) left.push(...c.map((e) => e.id));
      assert.deepEqual(left.sort(), ['new0', 'new1', 'new2', 'new3', 'roll:2026-03-01:gpt-4o:unattributed:chat:local']);
    });
  });

  describe('the >2^53 guard', () => {
    it('sums above 2^53 read back saturated instead of throwing', async () => {
      const s = await open();
      const big = 2 ** 53 - 1;
      await s.insert([ev({ id: 'g1', cacheReadTokens: big, promptTokens: 3 }), ev({ id: 'g2', cacheReadTokens: big, promptTokens: 4 })]);
      const [g] = await s.aggregate({}, { fromMs: 0, toMs: 4e12 });
      assert.equal(g!.cacheReadTokens, Number.MAX_SAFE_INTEGER);
      assert.equal(g!.promptTokens, 7);
      assert.deepEqual((await s.aggregateRange({}, { fromMs: 0, toMs: 4e12 }))[0]!.cacheReadTokens, Number.MAX_SAFE_INTEGER);
    });
  });

  describe('serialisation and lifecycle', () => {
    it('operations issued together never interleave their transactions', async () => {
      const NOW = T('2026-11-02T09:30:00Z');
      const s = await open({ batch: { rows: 5 }, compactChunkRows: 4, now: () => NOW, retentionDays: 30 });
      await s.insert(rows(40, (i) => ({ id: `o${i}`, ts: T('2026-01-01T00:00:00Z') + i * 3_600_000 })));
      const results = await Promise.all([
        s.compact(),
        s.insert(rows(30, (i) => ({ id: `n${i}`, ts: NOW - DAY + i * 1000 }))),
        s.aggregateRange({}, { fromMs: 0, toMs: 4e12 }),
        s.clear().then(() => s.insert(rows(3, (i) => ({ id: `c${i}`, ts: NOW })))),
        s.setMeta('a', 'b'),
      ]);
      assert.equal((results[3] as { inserted: number }).inserted, 3);
      assert.equal(await s.countEvents(), 3);
    });

    it('dispose() lets running work finish, checkpoints the WAL, closes, and refuses later work', async () => {
      const s = await open({ batch: { rows: 100 } });
      const pending = s.insert(rows(500));
      s.dispose();
      s.dispose();
      assert.equal((await pending).inserted, 500);
      await s.close();
      assert.equal(s.dataVersion(), s.dataVersion(), 'dataVersion still answers after the close');
      for (const call of [
        () => s.insert(rows(1)), () => s.aggregate({}, { fromMs: 0, toMs: 1 }), () => s.aggregateRange({}, { fromMs: 0, toMs: 1 }),
        () => s.compact(), () => s.clear(), () => s.countEvents(), () => s.getMeta('k'), () => s.setMeta('k', 'v'),
        () => s.checkpoint(), () => s.requestsByModelForBranch('b'), () => s.listIngestState(),
        async () => { for await (const c of s.exportRows()) void c; },
      ]) await assert.rejects(call(), /disposed/);
      const wal = path.join(dir, 'events.sqlite-wal');
      assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'the WAL was folded into the main file');
      // And the data is all there for the next window.
      assert.equal(await (await open()).countEvents(), 500);
    });

    it('a failing checkpoint is logged, not thrown', async () => {
      const r = recorder();
      const { loader } = flakyLoader({ checkpoint: true });
      const s = await open({ loader, logger: r.logger });
      await s.checkpoint();
      await s.close();
      assert.equal(r.lines.filter((l) => /wal checkpoint skipped/.test(l)).length, 2);
    });
  });

  describe('windows and aggregation', () => {
    it('aggregateRange reads 7-day windows and yields between them', async () => {
      const s = await open();
      const start = T('2026-01-01T00:00:00Z');
      await s.insert(rows(10, (i) => ({ id: `w${i}`, ts: start + i * 6 * DAY })));
      const { result, turns } = await turnsDuring(() => s.aggregateRange({}, { fromMs: start, toMs: start + 60 * DAY }));
      assert.equal(result.length, 10);
      assert.ok(turns >= 8, `turns ${turns}`);
    });
  });

  describe('another window / process', () => {
    it('two stores on one file: dataVersion follows the other one\'s commits, fresh detection stays exact', async () => {
      const a = await open();
      const b = await open();
      const va = a.dataVersion();
      const vb = b.dataVersion();
      assert.equal(a.dataVersion(), va, 'stable while nothing changes');
      const ra = await a.insert(rows(5));
      assert.equal(ra.inserted, 5);
      assert.notEqual(a.dataVersion(), va, 'own commit');
      assert.notEqual(b.dataVersion(), vb, "another connection's commit");
      const seen = b.dataVersion();
      assert.equal(b.dataVersion(), seen);
      // The same rows through the other connection are not fresh there.
      const rb = await b.insert([...rows(5), ev({ id: 'extra' })]);
      assert.deepEqual(rb.fresh.map((e) => e.id), ['extra']);
      assert.equal(await a.countEvents(), 6);
      // A Claude row raised by one window is visible to the other.
      await a.insert([ev({ id: 'claude-code:m:1', source: 'claude-code', completionTokens: 5 })]);
      await b.insert([ev({ id: 'claude-code:m:1', source: 'claude-code', completionTokens: 400 })]);
      const [group] = (await a.aggregate({ sources: ['claude-code'] }, { fromMs: 0, toMs: 4e12 }));
      assert.equal(group!.completionTokens, 400);
    });

    it('dataVersion follows a commit of another PROCESS', async () => {
      const s = await open();
      await s.insert(rows(1));
      const child = spawnDbChild();
      children.push(child);
      await child.call('open', { path: path.join(dir, 'events.sqlite'), pragmas: ['PRAGMA busy_timeout=5000'] });
      const v = s.dataVersion();
      assert.equal(s.dataVersion(), v);
      assert.equal(await child.call('insertIds', { prefix: 'child', from: 0, to: 10, batch: 5 }), 10);
      assert.notEqual(s.dataVersion(), v);
      assert.equal(await s.countEvents(), 11);
      await child.call('close');
    });

    it('rows written by this window and a second process at the same time are fresh in exactly one of them', async () => {
      const s = await open({ batch: { rows: 200 }, busy: { attempts: 1000, minDelayMs: 1, maxDelayMs: 4, sleep: DEFAULT_SLEEP, random: Math.random } });
      const child = spawnDbChild();
      children.push(child);
      await child.call('open', { path: path.join(dir, 'events.sqlite'), pragmas: ['PRAGMA busy_timeout=5000'] });
      const N = 6000;
      const [mine, theirs] = await Promise.all([
        s.insert(rows(N, (i) => ({ id: `shared${i}`, ts: 1_700_000_000_000 + i, source: 'local' }))),
        child.call<number>('insertIds', { prefix: 'shared', from: 0, to: N, batch: 150, source: 'local' }),
      ]);
      assert.equal(mine.inserted + theirs, N, `window ${mine.inserted} + process ${theirs}`);
      assert.equal(await s.countEvents(), N);
    });
  });
});

const DEFAULT_SLEEP = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

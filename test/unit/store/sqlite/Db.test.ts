import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import * as path from 'path';
import {
  DEFAULT_BUSY_RETRY,
  Db,
  MIN_VSCODE_VERSION,
  SqliteUnavailableError,
  defaultSqliteLoader,
  intParam,
  isBusyError,
  isOutOfRangeError,
  isSafeSqlInt,
  loadSqlite,
  num,
  requireSqlite,
  retryBusy,
  saturate,
  text,
  withoutSqliteExperimentalWarning,
} from '../../../../src/extension-backend/store/sqlite/Db';
import type { BusyRetry, SqliteModule } from '../../../../src/extension-backend/store/sqlite/Db';
import { FAST_RETRY, busyError, flakyLoader, removeDir, tempDir } from './helpers';

const DB_TS = path.resolve(__dirname, '../../../../src/extension-backend/store/sqlite/Db.ts');

describe('sqlite/Db: loading the driver', () => {
  it('loads node:sqlite by default', () => {
    const mod = loadSqlite();
    assert.equal(typeof mod.DatabaseSync, 'function');
    assert.equal(defaultSqliteLoader().DatabaseSync, mod.DatabaseSync);
  });

  it('turns any loader failure into a SqliteUnavailableError that names the minimum VS Code version', () => {
    const cause = new Error('ERR_UNKNOWN_BUILTIN_MODULE');
    assert.throws(
      () => loadSqlite(() => { throw cause; }),
      (err: unknown) => {
        assert.ok(err instanceof SqliteUnavailableError);
        assert.equal(err.name, 'SqliteUnavailableError');
        assert.equal(MIN_VSCODE_VERSION, '1.101');
        assert.match(err.message, /VS Code to 1\.101 or later/);
        assert.match(err.message, /in memory only/);
        assert.equal(err.cause, cause);
        return true;
      },
    );
  });

  it('passes a SqliteUnavailableError from the loader through unchanged', () => {
    const own = new SqliteUnavailableError('custom');
    assert.throws(() => loadSqlite(() => { throw own; }), (err: unknown) => err === own);
  });

  it('requireSqlite rejects a require that throws, and a module without DatabaseSync', () => {
    assert.throws(() => requireSqlite(() => { throw new Error('nope'); }), /could not be loaded/);
    assert.throws(() => requireSqlite(() => ({})), /no DatabaseSync/);
    assert.throws(() => requireSqlite(() => undefined), /no DatabaseSync/);
    const ok = { DatabaseSync: class {} } as unknown as SqliteModule;
    assert.equal(requireSqlite(() => ok), ok);
  });

  describe('ExperimentalWarning suppression', () => {
    let original: typeof process.emitWarning;
    let seen: unknown[][];
    beforeEach(() => {
      original = process.emitWarning;
      seen = [];
      process.emitWarning = ((...args: unknown[]) => { seen.push(args); }) as typeof process.emitWarning;
    });
    afterEach(() => {
      process.emitWarning = original;
    });

    it('drops the SQLite ExperimentalWarning in every form Node uses, only while the function runs', () => {
      const wrapped = process.emitWarning;
      const result = withoutSqliteExperimentalWarning(() => {
        assert.notEqual(process.emitWarning, wrapped);
        process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
        process.emitWarning('SQLite is an experimental feature', { type: 'ExperimentalWarning' });
        process.emitWarning(Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' }));
        return 42;
      });
      assert.equal(result, 42);
      assert.deepEqual(seen, []);
      assert.equal(process.emitWarning, wrapped, 'the previous emitWarning is restored');
    });

    it('lets every other warning through, with its arguments', () => {
      withoutSqliteExperimentalWarning(() => {
        process.emitWarning('something else is experimental', 'ExperimentalWarning');
        process.emitWarning('SQLite is deprecated', 'DeprecationWarning');
        process.emitWarning('plain');
      });
      assert.deepEqual(seen, [
        ['something else is experimental', 'ExperimentalWarning'],
        ['SQLite is deprecated', 'DeprecationWarning'],
        ['plain'],
      ]);
    });

    it('restores emitWarning when the function throws', () => {
      const wrapped = process.emitWarning;
      assert.throws(() => withoutSqliteExperimentalWarning(() => { throw new Error('boom'); }), /boom/);
      assert.equal(process.emitWarning, wrapped);
    });
  });

  it('a real first load of node:sqlite prints no ExperimentalWarning through loadSqlite (and does without it)', () => {
    const run = (code: string): string =>
      spawnSync(process.execPath, ['--require', 'tsx/cjs', '-e', code], { encoding: 'utf8', cwd: path.resolve(__dirname, '../../../..') }).stderr;
    const viaWrapper = run(`require(${JSON.stringify(DB_TS)}).loadSqlite()`);
    const bare = run("require('node:sqlite')");
    assert.doesNotMatch(viaWrapper, /ExperimentalWarning/);
    // Control: this Node does print it, so the assertion above means something.
    assert.match(bare, /ExperimentalWarning: SQLite/);
  });
});

describe('sqlite/Db: error classification and numbers', () => {
  it('isBusyError matches the numeric error code (extended codes included), never other codes', () => {
    for (const code of [5, 6, 261, 517, 773]) assert.equal(isBusyError(busyError(code)), true, String(code));
    for (const code of [1, 14, 19]) assert.equal(isBusyError(busyError(code)), false, String(code));
    // A message alone is not enough when the driver reports a code.
    assert.equal(isBusyError(Object.assign(new Error('database is locked'), { errcode: 1 })), false);
  });

  it('without an errcode (older runtimes) it falls back to the SQLite wording of BUSY/LOCKED on ERR_SQLITE_ERROR only', () => {
    const e = (code: string, message: string): Error => Object.assign(new Error(message), { code });
    assert.equal(isBusyError(e('ERR_SQLITE_ERROR', 'database is locked')), true);
    assert.equal(isBusyError(e('ERR_SQLITE_ERROR', 'database table is locked')), true);
    assert.equal(isBusyError(e('ERR_SQLITE_ERROR', 'no such table: x')), false);
    assert.equal(isBusyError(e('ERR_OTHER', 'database is locked')), false);
    assert.equal(isBusyError(null), false);
    assert.equal(isBusyError('database is locked'), false);
    assert.equal(isBusyError({ code: 'ERR_SQLITE_ERROR' }), false);
  });

  it('isOutOfRangeError', () => {
    assert.equal(isOutOfRangeError(Object.assign(new RangeError('x'), { code: 'ERR_OUT_OF_RANGE' })), true);
    assert.equal(isOutOfRangeError(new Error('x')), false);
    assert.equal(isOutOfRangeError(undefined), false);
  });

  it('intParam binds integers as bigint and refuses unsafe numbers', () => {
    assert.equal(intParam(5), 5n);
    assert.equal(intParam(-3), -3n);
    for (const bad of [1.5, NaN, Infinity, 2 ** 53]) assert.throws(() => intParam(bad), RangeError);
  });

  it('isSafeSqlInt, saturate, num and text', () => {
    assert.deepEqual([5, -5, 2 ** 53 - 1, 2 ** 53, 1.5, NaN, '5', null].map(isSafeSqlInt), [true, true, true, false, false, false, false, false]);
    assert.equal(saturate(5n), 5);
    assert.equal(saturate(2n ** 60n), Number.MAX_SAFE_INTEGER);
    assert.equal(saturate(-(2n ** 60n)), -Number.MAX_SAFE_INTEGER);
    assert.equal(num(7), 7);
    assert.equal(num(2n ** 60n), Number.MAX_SAFE_INTEGER);
    assert.equal(text(null), null);
    assert.equal(text(undefined), null);
    assert.equal(text('a'), 'a');
    assert.equal(text(5), '5');
  });
});

describe('sqlite/Db: retryBusy', () => {
  const retry = (over: Partial<BusyRetry> = {}): BusyRetry => ({ ...DEFAULT_BUSY_RETRY, attempts: 4, ...over });

  it('returns the result at once when nothing is busy', async () => {
    assert.equal(await retryBusy(() => 'ok', retry({ sleep: () => Promise.reject(new Error('must not sleep')) })), 'ok');
  });

  it('pauses asynchronously between tries, with a jitter inside [min, max]', async () => {
    const pauses: number[] = [];
    let calls = 0;
    const randoms = [0, 1, 0.5];
    const result = await retryBusy(
      () => {
        if (++calls < 4) throw busyError();
        return calls;
      },
      retry({ sleep: (ms) => { pauses.push(ms); return Promise.resolve(); }, random: () => randoms.shift()! }),
    );
    assert.equal(result, 4);
    assert.deepEqual(pauses, [3, 15, 9]);
  });

  it('gives up after the attempt limit and rethrows the busy error', async () => {
    let calls = 0;
    let sleeps = 0;
    const err = busyError();
    await assert.rejects(
      retryBusy(() => { calls++; throw err; }, retry({ sleep: () => { sleeps++; return Promise.resolve(); } })),
      (e: unknown) => e === err,
    );
    assert.deepEqual([calls, sleeps], [4, 3]);
  });

  it('rethrows any other error at once', async () => {
    let calls = 0;
    await assert.rejects(retryBusy(() => { calls++; throw new Error('syntax'); }, retry()), /syntax/);
    assert.equal(calls, 1);
  });

  it('defaults: 300 tries, 3 to 15 ms, a real timer', async () => {
    assert.deepEqual([DEFAULT_BUSY_RETRY.attempts, DEFAULT_BUSY_RETRY.minDelayMs, DEFAULT_BUSY_RETRY.maxDelayMs], [300, 3, 15]);
    const t0 = Date.now();
    await DEFAULT_BUSY_RETRY.sleep(5);
    assert.ok(Date.now() - t0 >= 3);
    const r = DEFAULT_BUSY_RETRY.random();
    assert.ok(r >= 0 && r < 1);
  });
});

describe('sqlite/Db: connection', () => {
  let dir: string;
  const dbs: Db[] = [];
  const open = (file: string, o: Parameters<typeof Db.open>[1] = {}): Db => {
    const db = Db.open(file, o);
    dbs.push(db);
    return db;
  };
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    for (const d of dbs.splice(0)) d.close();
    await removeDir(dir);
  });

  it('applies the PRAGMAs: WAL for a file, no busy wait, no synchronous FULL, foreign keys off', () => {
    const db = open(path.join(dir, 'a.sqlite'));
    assert.equal(db.journalMode, 'wal');
    assert.equal(db.get('PRAGMA busy_timeout')!['timeout'], 0);
    assert.equal(db.get('PRAGMA synchronous')!['synchronous'], 1);
    assert.equal(db.get('PRAGMA foreign_keys')!['foreign_keys'], 0);
    assert.equal(open(':memory:').journalMode, 'memory');
  });

  it('opens read-only without touching the journal mode', () => {
    const file = path.join(dir, 'ro.sqlite');
    const w = open(file);
    w.exec('CREATE TABLE t(a)');
    w.run('INSERT INTO t VALUES (?)', 1);
    const ro = open(file, { readOnly: true });
    assert.equal(ro.journalMode, 'read-only');
    assert.equal(ro.get('SELECT count(*) AS c FROM t')!['c'], 1);
    assert.throws(() => ro.exec('INSERT INTO t VALUES (2)'), /readonly/i);
  });

  it('closes the raw connection and rethrows when a PRAGMA fails', () => {
    let closed = false;
    const loader = (): SqliteModule => ({
      DatabaseSync: class {
        exec(): void { throw new Error('pragma failed'); }
        prepare(): never { throw new Error('unused'); }
        close(): void { closed = true; }
      },
    });
    assert.throws(() => Db.open(':memory:', { loader }), /pragma failed/);
    assert.equal(closed, true);
  });

  it('prepare caches per SQL text; prepareFresh does not; run/get/rows work', () => {
    const db = open(':memory:');
    db.exec('CREATE TABLE t(a INTEGER, b TEXT)');
    assert.equal(db.prepare('SELECT 1 AS x'), db.prepare('SELECT 1 AS x'));
    assert.notEqual(db.prepareFresh('SELECT 1 AS x'), db.prepare('SELECT 1 AS x'));
    assert.equal(db.run('INSERT INTO t VALUES (?, ?), (?, ?)', 1, 'x', 2, 'y'), 2);
    assert.equal(db.run('DELETE FROM t WHERE a = ?', 99), 0);
    assert.deepEqual(db.get('SELECT b FROM t WHERE a = ?', 2) && { ...db.get('SELECT b FROM t WHERE a = ?', 2) }, { b: 'y' });
    assert.equal(db.get('SELECT b FROM t WHERE a = ?', 3), undefined);
    assert.deepEqual(db.rows('SELECT a FROM t ORDER BY a').map((r) => r['a']), [1, 2]);
  });

  it('reads integers above 2^53 as bigints on a retry (saturating through num) and still reads normally afterwards', () => {
    const db = open(':memory:');
    db.exec('CREATE TABLE t(v INTEGER)');
    db.run('INSERT INTO t VALUES (?), (?), (?)', 2 ** 53 - 1, 2 ** 53 - 1, 5);
    assert.throws(() => db.get('SELECT sum(v) AS s FROM t'), isOutOfRangeError);
    const [row] = db.rows('SELECT sum(v) AS s FROM t');
    assert.equal(typeof row!['s'], 'bigint');
    assert.equal(num(row!['s']), Number.MAX_SAFE_INTEGER);
    assert.deepEqual(db.rows('SELECT sum(v) AS s FROM t WHERE v < 10').map((r) => r['s']), [5]);
    assert.throws(() => db.rows('SELECT nope FROM t'), /no such column/);
  });

  describe('transaction', () => {
    it('commits what fn did, returns its value, awaits an async fn', async () => {
      const db = open(path.join(dir, 't.sqlite'));
      db.exec('CREATE TABLE t(a)');
      const r = await db.transaction(async () => {
        db.run('INSERT INTO t VALUES (?)', 1);
        await new Promise((resolve) => setImmediate(resolve));
        db.run('INSERT INTO t VALUES (?)', 2);
        return 'done';
      });
      assert.equal(r, 'done');
      assert.equal(await db.transaction(() => 7), 7);
      assert.equal(open(path.join(dir, 't.sqlite')).get('SELECT count(*) AS c FROM t')!['c'], 2);
    });

    it('rolls back and rethrows when fn throws', async () => {
      const db = open(':memory:');
      db.exec('CREATE TABLE t(a)');
      await assert.rejects(db.transaction(() => { db.run('INSERT INTO t VALUES (1)'); throw new Error('mid'); }), /mid/);
      assert.equal(db.get('SELECT count(*) AS c FROM t')!['c'], 0);
      await db.transaction(() => db.run('INSERT INTO t VALUES (2)')); // the connection is usable again
    });

    it('reports the original error when even ROLLBACK fails (the transaction is already gone)', async () => {
      const db = open(':memory:');
      await assert.rejects(db.transaction(() => { db.exec('ROLLBACK'); }), /no transaction is active/);
    });

    it('retries BEGIN IMMEDIATE asynchronously while another connection holds the write lock', async () => {
      const file = path.join(dir, 'busy.sqlite');
      const holder = open(file);
      holder.exec('CREATE TABLE t(a)');
      let sleeps = 0;
      const writer = open(file, {
        busy: { sleep: () => { if (++sleeps === 2) holder.exec('COMMIT'); return Promise.resolve(); }, random: () => 0 },
      });
      holder.exec('BEGIN IMMEDIATE');
      await writer.transaction(() => writer.run('INSERT INTO t VALUES (1)'));
      assert.equal(sleeps, 2);
      assert.equal(writer.get('SELECT count(*) AS c FROM t')!['c'], 1);
    });

    it('fails with the busy error once the attempts are used up, and leaves no transaction open', async () => {
      const file = path.join(dir, 'busy2.sqlite');
      const holder = open(file);
      holder.exec('CREATE TABLE t(a)');
      const writer = open(file, { busy: { ...FAST_RETRY, attempts: 3 } });
      holder.exec('BEGIN IMMEDIATE');
      await assert.rejects(writer.transaction(() => 1), isBusyError);
      holder.exec('COMMIT');
      assert.equal(await writer.transaction(() => 'free again'), 'free again');
    });
  });

  it('openWithRetry retries a busy open asynchronously, and gives up on other errors at once', async () => {
    const { loader, faults } = flakyLoader({ open: 2 });
    const db = await Db.openWithRetry(':memory:', { loader, busy: FAST_RETRY });
    dbs.push(db);
    assert.equal(faults.opens, 3);
    await assert.rejects(Db.openWithRetry(path.join(dir, 'no', 'such', 'dir', 'x.sqlite'), { busy: FAST_RETRY }), /unable to open/);
    await assert.rejects(Db.openWithRetry(':memory:', { loader: () => { throw new Error('no driver'); } }), SqliteUnavailableError);
  });

  it('dataVersion follows other connections\' commits only; close is idempotent', () => {
    const file = path.join(dir, 'dv.sqlite');
    const a = open(file);
    const b = open(file);
    a.exec('CREATE TABLE t(x)');
    const v0 = a.dataVersion();
    a.exec('INSERT INTO t VALUES (1)');
    assert.equal(a.dataVersion(), v0, 'own commit');
    b.exec('INSERT INTO t VALUES (2)');
    assert.notEqual(a.dataVersion(), v0, "another connection's commit");
    assert.equal(a.isClosed, false);
    a.close();
    a.close();
    assert.equal(a.isClosed, true);
  });
});

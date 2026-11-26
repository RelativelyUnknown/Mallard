import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../../../../src/extension-backend/store/sqlite/Db';
import type { BusyRetry } from '../../../../src/extension-backend/store/sqlite/Db';
import { MIGRATIONS, SCHEMA_VERSION, SchemaTooNewError, migrate, readUserVersion } from '../../../../src/extension-backend/store/sqlite/schema';
import type { Migration } from '../../../../src/extension-backend/store/sqlite/schema';
import { SqliteEventStore } from '../../../../src/extension-backend/store/sqlite/SqliteEventStore';
import { FAST_RETRY, removeDir, tempDir } from './helpers';

describe('sqlite/schema', () => {
  let dir: string;
  const dbs: Db[] = [];
  const open = (file: string, busy: Partial<BusyRetry> = FAST_RETRY): Db => {
    const db = Db.open(file, { busy });
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

  const names = (db: Db, type: string): string[] =>
    db.rows('SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE ? ORDER BY name', type, 'sqlite_%').map((r) => String(r['name']));

  it('version 1 is the events/meta/ingest_state schema with its indexes', async () => {
    assert.equal(SCHEMA_VERSION, 1);
    const db = open(':memory:');
    assert.equal(readUserVersion(db), 0);
    await migrate(db);
    assert.equal(readUserVersion(db), 1);
    assert.deepEqual(names(db, 'table'), ['events', 'ingest_state', 'meta']);
    assert.deepEqual(names(db, 'index'), ['events_model', 'events_repo', 'events_ts']);
    const cols = (t: string): string[] =>
      db.rows(`PRAGMA table_info(${t})`).map((r) => `${r['name']} ${r['type']}${r['notnull'] ? ' NOT NULL' : ''}${r['dflt_value'] !== null ? ` DEFAULT ${r['dflt_value']}` : ''}${r['pk'] ? ' PK' : ''}`);
    assert.deepEqual(cols('events'), [
      'id TEXT PK', 'ts INTEGER NOT NULL', 'modelId TEXT NOT NULL', 'surface TEXT NOT NULL', 'source TEXT NOT NULL',
      'repo TEXT', 'branch TEXT', 'attribution TEXT', 'language TEXT', 'requests INTEGER NOT NULL DEFAULT 1',
      'promptTokens INTEGER', 'completionTokens INTEGER', 'cacheReadTokens INTEGER NOT NULL DEFAULT 0',
      'cacheCreationTokens INTEGER NOT NULL DEFAULT 0', 'thinkingTokens INTEGER NOT NULL DEFAULT 0',
    ]);
    assert.deepEqual(cols('meta'), ['key TEXT PK', 'value TEXT']);
    assert.deepEqual(cols('ingest_state'), ['file TEXT PK', 'size INTEGER', 'mtimeMs INTEGER', 'byteOffset INTEGER', 'headHash TEXT']);
  });

  it('an up-to-date database is recognised without the write lock', async () => {
    const file = path.join(dir, 'a.sqlite');
    const a = open(file);
    await migrate(a);
    const holder = open(file);
    holder.exec('BEGIN IMMEDIATE');
    const b = open(file, { ...FAST_RETRY, attempts: 1 });
    await migrate(b); // would throw SQLITE_BUSY if it tried to begin a transaction
    holder.exec('ROLLBACK');
  });

  it('refuses a database from a newer Mallard, and leaves it exactly as it was', async () => {
    const file = path.join(dir, 'new.sqlite');
    const db = open(file);
    await migrate(db);
    db.exec("INSERT INTO meta VALUES ('keep', 'me'); PRAGMA user_version = 7");
    await assert.rejects(migrate(db), (e: unknown) => {
      assert.ok(e instanceof SchemaTooNewError);
      assert.deepEqual([e.found, e.supported, e.name], [7, 1, 'SchemaTooNewError']);
      assert.match(e.message, /schema version 7/);
      assert.match(e.message, /only understands up to 1/);
      assert.match(e.message, /left untouched/);
      return true;
    });
    assert.equal(readUserVersion(db), 7);
    assert.equal(db.get("SELECT value FROM meta WHERE key = 'keep'")!['value'], 'me');
  });

  it('the store refuses a newer database file and closes its connection', async () => {
    const sub = path.join(dir, 'store');
    fs.mkdirSync(sub);
    const file = path.join(sub, 'events.sqlite');
    const db = Db.open(file);
    await migrate(db);
    db.exec('PRAGMA user_version = 9');
    db.close();
    await assert.rejects(SqliteEventStore.open(sub), SchemaTooNewError);
    const again = Db.open(file);
    assert.equal(readUserVersion(again), 9);
    again.close();
  });

  const m = (version: number, sql: string): Migration => ({ version, sql });

  it('applies the migrations above the current version, in order, and records the version', async () => {
    const list = [m(1, 'CREATE TABLE a(x)'), m(2, 'ALTER TABLE a ADD COLUMN y'), m(3, 'CREATE TABLE b(z)')];
    const fresh = open(':memory:');
    await migrate(fresh, list);
    assert.equal(readUserVersion(fresh), 3);
    assert.deepEqual(names(fresh, 'table'), ['a', 'b']);

    // From version 1: only 2 and 3 run (re-running 1 would fail: the table exists).
    const half = open(path.join(dir, 'half.sqlite'));
    await migrate(half, [list[0]!]);
    await migrate(half, list);
    assert.equal(readUserVersion(half), 3);
    assert.deepEqual(half.rows('PRAGMA table_info(a)').map((r) => r['name']), ['x', 'y']);
    await migrate(half, list); // current: nothing to do
  });

  it('a failing migration rolls everything back, version included', async () => {
    const db = open(path.join(dir, 'fail.sqlite'));
    await assert.rejects(migrate(db, [m(1, 'CREATE TABLE a(x)'), m(2, 'CREATE TABLE a(x)')]), /already exists/);
    assert.equal(readUserVersion(db), 0);
    assert.deepEqual(names(db, 'table'), []);
  });

  it('two windows opening at once: the second finds the migration done once it gets the lock', async () => {
    const file = path.join(dir, 'race.sqlite');
    const holder = open(file);
    let sleeps = 0;
    const second = open(file, {
      sleep: async () => {
        if (++sleeps === 1) {
          holder.exec(MIGRATIONS[0]!.sql);
          holder.exec('PRAGMA user_version = 1; COMMIT');
        }
      },
      random: () => 0,
    });
    holder.exec('BEGIN IMMEDIATE');
    await migrate(second);
    assert.equal(sleeps, 1);
    assert.equal(readUserVersion(second), 1);
    assert.deepEqual(names(second, 'table'), ['events', 'ingest_state', 'meta']);
  });

  it('... or finds a newer version there and refuses', async () => {
    const file = path.join(dir, 'race2.sqlite');
    const holder = open(file);
    const second = open(file, {
      sleep: async () => {
        holder.exec('PRAGMA user_version = 5; COMMIT');
      },
      random: () => 0,
    });
    holder.exec('BEGIN IMMEDIATE');
    await assert.rejects(migrate(second), SchemaTooNewError);
    assert.equal(readUserVersion(second), 5);
  });
});

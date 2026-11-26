import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { MemoryEventStore } from '../../../../src/extension-backend/store/MemoryEventStore';
import { openEventStore } from '../../../../src/extension-backend/store/openEventStore';
import { Db, SqliteUnavailableError } from '../../../../src/extension-backend/store/sqlite/Db';
import { SchemaTooNewError, migrate, readUserVersion } from '../../../../src/extension-backend/store/sqlite/schema';
import { SqliteEventStore } from '../../../../src/extension-backend/store/sqlite/SqliteEventStore';
import { removeDir, tempDir } from './helpers';
import { ev } from './storeContract';

const missing = (): never => {
  throw new Error('ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite');
};

describe('openEventStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempDir();
  });
  afterEach(async () => {
    await removeDir(dir);
  });

  it('opens the SQLite store when the driver is there', async () => {
    const opened = await openEventStore(dir);
    assert.ok(opened.store instanceof SqliteEventStore);
    assert.equal(opened.unavailable, undefined);
    assert.ok(fs.existsSync(path.join(dir, 'events.sqlite')));
    await opened.store.close();
  });

  it('driver missing: a working in-memory store, and the one error to show', async () => {
    const opened = await openEventStore(dir, { loader: missing });
    assert.ok(opened.store instanceof MemoryEventStore);
    assert.ok(opened.unavailable instanceof SqliteUnavailableError);
    assert.match(opened.unavailable.message, /VS Code to 1\.101 or later/);
    assert.ok(!fs.existsSync(path.join(dir, 'events.sqlite')), 'nothing was written');
    const r = await opened.store.insert([ev({ id: 'a' }), ev({ id: 'a' })]);
    assert.equal(r.inserted, 1);
    assert.equal((await opened.store.aggregate({}, { fromMs: 0, toMs: 4e12 })).length, 1);
  });

  it('the fallback keeps the options (retention, clock, raw-row cap, logger)', async () => {
    const warnings: string[] = [];
    const NOW = Date.parse('2026-11-02T09:30:00Z');
    const logger = { debug: () => undefined, info: () => undefined, warn: (_t: string, m: string) => { warnings.push(m); }, error: () => undefined };
    const { store } = await openEventStore(dir, { loader: missing, now: () => NOW, retentionDays: 30, maxRawEvents: 100, logger });
    await store.insert([ev({ id: 'old', ts: Date.parse('2026-01-10T12:00:00Z') }), ev({ id: 'new', ts: NOW }), ev({ id: 'bad', ts: -5 })]);
    assert.match(warnings.join(), /refused 1 invalid/);
    await store.compact();
    assert.equal(await store.countEvents(), 2);
  });

  it('a database from a newer Mallard: in-memory fallback with the reason, file untouched', async () => {
    const file = path.join(dir, 'events.sqlite');
    const db = Db.open(file);
    await migrate(db);
    db.exec('PRAGMA user_version = 4');
    db.close();
    const before = fs.readFileSync(file);
    const opened = await openEventStore(dir);
    assert.ok(opened.store instanceof MemoryEventStore);
    assert.ok(opened.unavailable instanceof SchemaTooNewError);
    assert.deepEqual(fs.readFileSync(file), before);
    const again = Db.open(file);
    assert.equal(readUserVersion(again), 4);
    again.close();
  });

  it('any other failure propagates (it is not a missing driver)', async () => {
    const notADir = path.join(dir, 'file');
    fs.writeFileSync(notADir, 'x');
    await assert.rejects(openEventStore(path.join(notADir, 'sub')), /ENOTDIR|EEXIST/);
  });
});

import { strict as assert } from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../../../../src/extension-backend/store/sqlite/Db';
import { openReadOnly } from '../../../../src/extension-backend/store/sqlite/openReadOnly';
import type { OpenReadOnlyOptions, ReadOnlyHandle } from '../../../../src/extension-backend/store/sqlite/openReadOnly';
import { removeDir, spawnDbChild, tempDir } from './helpers';
import type { DbChild } from './helpers';

const count = (h: ReadOnlyHandle): number => Number(h.db.get('SELECT count(*) AS c FROM spans')!['c']);

describe('sqlite/openReadOnly (a database another process owns)', () => {
  let dir: string;
  let tmp: string;
  let file: string;
  let writer: DbChild;
  const handles: ReadOnlyHandle[] = [];
  const open = (opts: OpenReadOnlyOptions = {}, target = file): ReadOnlyHandle => {
    const h = openReadOnly(target, { tmpDir: tmp, ...opts });
    handles.push(h);
    return h;
  };

  /** A "Copilot" writer: its own process, WAL, auto-checkpoint off so every span stays in the -wal. */
  async function startWriter(): Promise<void> {
    writer = spawnDbChild();
    await writer.call('open', { path: file, pragmas: ['PRAGMA journal_mode=WAL', 'PRAGMA wal_autocheckpoint=0', 'PRAGMA synchronous=NORMAL'] });
    await writer.call('exec', {
      sql: `CREATE TABLE spans(span_id TEXT PRIMARY KEY, ts_ns INTEGER);
            WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 100)
            INSERT INTO spans SELECT 'span' || i, i FROM c`,
    });
  }

  beforeEach(async () => {
    dir = await tempDir();
    tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    file = path.join(dir, 'spans.db');
  });
  afterEach(async () => {
    for (const h of handles.splice(0)) h.close();
    writer?.kill();
    await removeDir(dir);
  });

  describe('a live writer', () => {
    it('is read directly, un-checkpointed WAL content included, and follows its later commits', async () => {
      await startWriter();
      const h = open();
      assert.equal(h.mode, 'direct');
      assert.equal(count(h), 100);
      await writer.call('exec', { sql: "INSERT INTO spans VALUES ('late1', 1), ('late2', 2)" });
      assert.equal(count(h), 102);
      assert.deepEqual(fs.readdirSync(dir).filter((f) => f !== 'tmp').sort(), ['spans.db', 'spans.db-shm', 'spans.db-wal']);
      assert.deepEqual(fs.readdirSync(tmp), [], 'no temp copy was needed');
    });

    it('never blocks the writer, and sees only committed state while the writer is mid-transaction', async () => {
      await startWriter();
      await writer.call('exec', { sql: "BEGIN IMMEDIATE; INSERT INTO spans VALUES ('uncommitted', 1)" });
      const h = open();
      assert.equal(count(h), 100);
      await writer.call('exec', { sql: 'COMMIT' });
      assert.equal(count(h), 101);
      assert.throws(() => h.db.exec("INSERT INTO spans VALUES ('mine', 1)"), /readonly/i);
    });

    it('a stage that cannot read falls back to a VACUUM INTO snapshot, which does not follow later writes', async () => {
      await startWriter();
      const stages: string[] = [];
      const h = open({ probe: (_db, stage) => { stages.push(stage); if (stage === 'direct') throw new Error('unable to open database file'); } });
      assert.deepEqual(stages, ['direct', 'snapshot']);
      assert.equal(h.mode, 'snapshot');
      assert.equal(count(h), 100);
      await writer.call('exec', { sql: "INSERT INTO spans VALUES ('after', 1)" });
      assert.equal(count(h), 100);
      assert.ok(fs.readdirSync(tmp).length > 0);
      h.close();
      h.close();
      assert.deepEqual(fs.readdirSync(tmp), [], 'the temp copy is removed on close');
    });

    it('then falls back to copying the file and its WAL', async () => {
      await startWriter();
      const stages: string[] = [];
      const h = open({ probe: (_db, stage) => { stages.push(stage); if (stage !== 'copy') throw new Error('no'); } });
      assert.deepEqual(stages, ['direct', 'snapshot', 'copy']);
      assert.equal(h.mode, 'copy');
      assert.equal(count(h), 100, 'the un-checkpointed rows came along in the copied -wal');
      h.close();
      assert.deepEqual(fs.readdirSync(tmp), []);
    });
  });

  describe('no writer', () => {
    beforeEach(async () => {
      const db = Db.open(file);
      db.exec('CREATE TABLE spans(span_id TEXT PRIMARY KEY, ts_ns INTEGER); INSERT INTO spans VALUES (\'a\', 1), (\'b\', 2)');
      db.close();
    });

    it('copies a bare database file (no -wal) when snapshot and direct both fail', () => {
      assert.ok(!fs.existsSync(`${file}-wal`));
      const h = open({ probe: (_db, stage) => { if (stage !== 'copy') throw new Error('no'); } });
      assert.equal(h.mode, 'copy');
      assert.equal(count(h), 2);
    });

    it('gives up (and cleans the temp directory) when even the copy cannot be read', () => {
      assert.throws(() => open({ probe: () => { throw new Error('unreadable'); } }), /unreadable/);
      assert.deepEqual(fs.readdirSync(tmp), []);
    });

    it('fails on a file that does not exist', () => {
      assert.throws(() => open({}, path.join(dir, 'missing.db')), /unable to open/);
      assert.deepEqual(fs.readdirSync(tmp), []);
    });

    it('uses the OS temp dir when none is given', () => {
      const h = openReadOnly(file, { probe: (_db, stage) => { if (stage === 'direct') throw new Error('no'); } });
      handles.push(h);
      assert.equal(h.mode, 'snapshot');
      assert.equal(count(h), 2);
    });

    describe('on a real read-only filesystem', () => {
      let view: string;
      let mounted = false;
      beforeEach(function () {
        view = path.join(dir, 'view');
        fs.mkdirSync(view);
        try {
          execFileSync('mount', ['--bind', dir, view], { stdio: 'pipe' });
          execFileSync('mount', ['-o', 'remount,ro,bind', view], { stdio: 'pipe' });
          mounted = true;
        } catch {
          try { execFileSync('umount', ['-l', view], { stdio: 'pipe' }); } catch { /* not mounted */ }
          this.skip();
        }
      });
      afterEach(() => {
        for (const h of handles.splice(0)) h.close();
        if (mounted) {
          try { execFileSync('umount', [view], { stdio: 'pipe' }); } catch { execFileSync('umount', ['-l', view], { stdio: 'pipe' }); }
          mounted = false;
        }
      });

      it('the plain read-only open fails (no -wal/-shm can be created), so the file is copied and read', () => {
        // The failure this module exists for: the open succeeds, the first read does not.
        const plain = Db.open(path.join(view, 'spans.db'), { readOnly: true });
        assert.throws(() => plain.get('SELECT count(*) AS c FROM spans'), /unable to open database file/);
        assert.throws(() => plain.exec(`VACUUM INTO '${path.join(tmp, 'x.db')}'`), /unable to open database file/);
        plain.close();
        const h = open({}, path.join(view, 'spans.db'));
        assert.equal(h.mode, 'copy');
        assert.equal(count(h), 2);
        h.close();
        assert.deepEqual(fs.readdirSync(tmp), []);
      });
    });
  });
});

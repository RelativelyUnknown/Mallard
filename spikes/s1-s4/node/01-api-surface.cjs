'use strict';
// S1 item 2: exact node:sqlite API surface for the Node it is run with.
// Usage: <node> 01-api-surface.cjs   -> prints one JSON document on stdout.
// Warnings (ExperimentalWarning) go to stderr and are captured separately.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const out = {
  node: process.versions.node,
  electron: process.versions.electron || null,
  sqliteVersionHint: process.versions.sqlite || null,
  loads: false,
  loadError: null,
  moduleExports: [],
  databaseSyncProto: [],
  statementSyncProto: [],
  checks: {},
};

let sqlite;
try {
  sqlite = require('node:sqlite');
  out.loads = true;
} catch (e) {
  out.loadError = String(e && e.message);
}

function members(proto) {
  return Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor').sort();
}

if (sqlite) {
  out.moduleExports = Object.keys(sqlite).sort();
  const { DatabaseSync, StatementSync } = sqlite;
  out.databaseSyncProto = members(DatabaseSync.prototype);
  // Some accessors (isOpen, isTransaction) are installed on the instance, not the prototype.
  {
    const probe = new DatabaseSync(':memory:');
    const own = Object.getOwnPropertyNames(probe);
    const viaIn = ['isOpen', 'isTransaction'].filter((k) => k in probe);
    out.databaseSyncProto = [...new Set([...out.databaseSyncProto, ...own, ...viaIn])].sort();
    probe.close();
  }
  out.statementSyncProto = members(StatementSync.prototype);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-api-'));
  const dbPath = path.join(dir, 'api.db');
  const c = out.checks;
  const t = (name, fn) => {
    try {
      const r = fn();
      c[name] = { ok: true, value: r === undefined ? null : r };
    } catch (e) {
      c[name] = { ok: false, error: `${e && e.code ? e.code + ': ' : ''}${e && e.message}` };
    }
  };

  const db = new DatabaseSync(dbPath);
  t('exec', () => db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a INTEGER, b TEXT)'));
  t('prepare().run', () => {
    const r = db.prepare('INSERT INTO t(a,b) VALUES (?,?)').run(1, 'x');
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid, typeofRowid: typeof r.lastInsertRowid };
  });
  t('prepare().get', () => db.prepare('SELECT * FROM t WHERE id=?').get(1));
  t('prepare().all', () => db.prepare('SELECT * FROM t').all());
  t('prepare().iterate', () => {
    const it = db.prepare('SELECT * FROM t').iterate();
    const rows = [];
    for (const r of it) rows.push(r);
    return rows;
  });
  t('named params', () => db.prepare('SELECT * FROM t WHERE a=:a').get({ a: 1 }));
  t('isOpen (property)', () => {
    if (db.isOpen === undefined) throw new Error('isOpen is undefined');
    return db.isOpen;
  });
  t('isTransaction (property)', () => {
    if (db.isTransaction === undefined) throw new Error('isTransaction is undefined');
    return db.isTransaction;
  });
  t('location()', () => db.location());
  t('function()', () => {
    db.function('dbl', (x) => x * 2);
    return db.prepare('SELECT dbl(21) AS v').get();
  });
  t('aggregate()', () => {
    db.aggregate('mysum', { start: 0, step: (acc, v) => acc + v });
    return db.prepare('SELECT mysum(a) AS v FROM t').get();
  });
  t('createTagStore()', () => {
    const tag = db.createTagStore(10);
    return tag.get`SELECT count(*) AS n FROM t`;
  });
  t('StatementSync.setReadBigInts', () => {
    const s = db.prepare('SELECT 1 AS n');
    s.setReadBigInts(true);
    return { v: String(s.get().n), type: typeof s.get().n };
  });
  t('StatementSync.setAllowBareNamedParameters', () => {
    const s = db.prepare('SELECT :a AS v');
    s.setAllowBareNamedParameters(true);
    return s.get({ a: 5 });
  });
  t('StatementSync.setAllowUnknownNamedParameters', () => {
    const s = db.prepare('SELECT :a AS v');
    s.setAllowUnknownNamedParameters(true);
    return s.get({ a: 5, zz: 1 });
  });
  t('StatementSync.setReturnArrays', () => {
    const s = db.prepare('SELECT 1 AS a, 2 AS b');
    s.setReturnArrays(true);
    return s.get();
  });
  t('StatementSync.columns()', () => db.prepare('SELECT a, b FROM t').columns());
  t('StatementSync.sourceSQL / expandedSQL', () => {
    const s = db.prepare('SELECT ? AS v');
    s.get(7);
    return { sourceSQL: s.sourceSQL, expandedSQL: s.expandedSQL };
  });
  t('sqlite.backup() function', () => {
    if (typeof sqlite.backup !== 'function') throw new Error('sqlite.backup is ' + typeof sqlite.backup);
    return 'function';
  });
  t('DatabaseSync.prototype.enableLoadExtension', () => typeof db.enableLoadExtension);
  t('DatabaseSync.prototype.loadExtension', () => typeof db.loadExtension);
  t('DatabaseSync.prototype.createSession/applyChangeset', () => ({
    createSession: typeof db.createSession,
    applyChangeset: typeof db.applyChangeset,
  }));
  t('Symbol.dispose on DatabaseSync', () => {
    if (typeof db[Symbol.dispose] !== 'function') throw new Error('absent');
    return 'function';
  });
  t('close()', () => db.close());
  t('isOpen after close', () => db.isOpen);
  t('exec after close throws', () => {
    try {
      db.exec('select 1');
      return 'did not throw';
    } catch (e) {
      return `threw: ${e.code || ''} ${e.message}`;
    }
  });

  // constructor options
  t('opt: open:false then open()', () => {
    const d = new DatabaseSync(path.join(dir, 'lazy.db'), { open: false });
    const before = d.isOpen;
    d.open();
    const after = d.isOpen;
    d.close();
    return { before, after };
  });
  t('opt: readOnly:true on existing db', () => {
    const d = new DatabaseSync(dbPath, { readOnly: true });
    let writeErr = null;
    try {
      d.exec("INSERT INTO t(a,b) VALUES (9,'z')");
    } catch (e) {
      writeErr = e.message;
    }
    const n = d.prepare('SELECT count(*) AS n FROM t').get().n;
    d.close();
    return { n, writeErr };
  });
  t('opt: timeout:1234 is effective (PRAGMA busy_timeout == 1234)', () => {
    const d = new DatabaseSync(path.join(dir, 'to.db'), { timeout: 1234 });
    const r = d.prepare('PRAGMA busy_timeout').get();
    d.close();
    if (r.timeout !== 1234) throw new Error('option ignored, busy_timeout=' + r.timeout);
    return r;
  });
  t('PRAGMA busy_timeout via exec is effective', () => {
    const d = new DatabaseSync(path.join(dir, 'to2.db'));
    d.exec('PRAGMA busy_timeout=4321');
    const r = d.prepare('PRAGMA busy_timeout').get();
    d.close();
    if (r.timeout !== 4321) throw new Error('busy_timeout=' + r.timeout);
    return r;
  });
  t('opt: enableForeignKeyConstraints:false', () => {
    const d = new DatabaseSync(path.join(dir, 'fk.db'), { enableForeignKeyConstraints: false });
    const r = d.prepare('PRAGMA foreign_keys').get();
    d.close();
    return r;
  });
  t('opt: enableDoubleQuotedStringLiterals', () => {
    const d = new DatabaseSync(path.join(dir, 'dq.db'), { enableDoubleQuotedStringLiterals: true });
    d.close();
    return 'accepted';
  });
  t('opt: allowExtension', () => {
    const d = new DatabaseSync(path.join(dir, 'ext.db'), { allowExtension: false });
    d.close();
    return 'accepted';
  });
  t('opt: readBigInts (db-level)', () => {
    const d = new DatabaseSync(path.join(dir, 'rb.db'), { readBigInts: true });
    const v = d.prepare('SELECT 1 AS n').get().n;
    d.close();
    return typeof v;
  });
  t('opt: returnArrays (db-level)', () => {
    const d = new DatabaseSync(path.join(dir, 'ra.db'), { returnArrays: true });
    const v = d.prepare('SELECT 1 AS n').get();
    d.close();
    return v;
  });
  t('opt: unknown option is ignored or throws', () => {
    const d = new DatabaseSync(path.join(dir, 'unk.db'), { bogusOption: true });
    d.close();
    return 'ignored';
  });
  t('URI filename (file:...?mode=ro) accepted by constructor', () => {
    const d = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    const n = d.prepare('SELECT count(*) AS n FROM t').get().n;
    d.close();
    return n;
  });
  t('Buffer path accepted', () => {
    const d = new DatabaseSync(Buffer.from(path.join(dir, 'buf.db')));
    d.close();
    return 'accepted';
  });
  t('URL path accepted', () => {
    const d = new DatabaseSync(new URL('file://' + path.join(dir, 'url.db')));
    d.close();
    return 'accepted';
  });
  t('sqlite_version()', () => {
    const d = new DatabaseSync(':memory:');
    const v = d.prepare('select sqlite_version() as v').get().v;
    d.close();
    return v;
  });
  t('constants', () => sqlite.constants || null);
}
process.stdout.write(JSON.stringify(out, null, 2) + '\n');

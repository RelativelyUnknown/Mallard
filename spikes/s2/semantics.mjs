// Executable notes on node:sqlite / SQLite behaviours the A2 design leans on. Throws on any surprise.
//   node --disable-warning=ExperimentalWarning spikes/s2/semantics.mjs
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { scratchDir, rmrf } from './lib/stats.mjs';

const out = [];
const note = (s) => { out.push(s); console.log(`ok  ${s}`); };
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE t(id TEXT PRIMARY KEY, n INTEGER)');

// 1. scalar max() propagates NULL (so `max(promptTokens, excluded.promptTokens)` never repairs a NULL)
assert.equal(db.prepare('SELECT max(NULL, 5) v').get().v, null);
assert.equal(db.prepare('SELECT max(coalesce(NULL,0), 5) v').get().v, 5);
note('scalar max(NULL, 5) is NULL: use coalesce() or a guarded WHERE in the upsert');

// 2. upsert: changes=1 for both insert and update; lastInsertRowid only moves on a real insert
const up = db.prepare('INSERT INTO t VALUES(?,?) ON CONFLICT(id) DO UPDATE SET n = max(n, excluded.n)');
const a = up.run('a', 1), a2 = up.run('a', 5), b = up.run('b', 1), b2 = up.run('b', 0);
assert.deepEqual([a.changes, a2.changes, b.changes, b2.changes], [1, 1, 1, 1]);
assert.equal(Number(a2.lastInsertRowid), Number(a.lastInsertRowid));
assert.equal(Number(b2.lastInsertRowid), Number(b.lastInsertRowid));
assert.ok(Number(b.lastInsertRowid) > Number(a.lastInsertRowid));
note('upsert: changes is 1 for insert AND update; lastInsertRowid is unchanged by the update path');

// 3. ... but lastInsertRowid is connection state: stale after deleting the tail row (why F2 must seed from max(rowid))
db.prepare('DELETE FROM t WHERE id = ?').run('b'); // max rowid now 1, connection still remembers 2
const stale = up.run('a', 9);
assert.equal(Number(stale.lastInsertRowid), 2, 'stale lastInsertRowid from the deleted row');
note('lastInsertRowid goes stale after a tail delete (compare against max(rowid) read at txn start, never raw state)');

// 4. DO NOTHING + changes is exact; RETURNING yields no row for the conflict
const dn = db.prepare('INSERT INTO t VALUES(?,?) ON CONFLICT(id) DO NOTHING');
assert.equal(dn.run('c', 1).changes, 1);
assert.equal(dn.run('c', 2).changes, 0);
const dnr = db.prepare('INSERT INTO t VALUES(?,?) ON CONFLICT(id) DO NOTHING RETURNING id');
dnr.setReturnArrays(true);
assert.deepEqual(dnr.get('d', 1), ['d']);
assert.equal(dnr.get('d', 2), undefined);
note('DO NOTHING: changes===1 iff inserted; RETURNING get() is undefined on conflict');

// 5. multi-row VALUES upsert with a duplicate id inside the same statement works (no "cannot affect row a second time")
const m = db.prepare('INSERT INTO t VALUES (?,?),(?,?),(?,?) ON CONFLICT(id) DO UPDATE SET n = max(n, excluded.n) RETURNING id, rowid');
m.setReturnArrays(true);
const rows = m.all('x', 1, 'y', 2, 'x', 7);
assert.equal(rows.length, 3);
assert.equal(rows[0][1], rows[2][1]);
assert.equal(db.prepare("SELECT n FROM t WHERE id='x'").get().n, 7);
note('multi-row upsert with in-batch duplicate ids is legal; RETURNING reports both rows with the same rowid');

// 6. integers beyond 2^53 throw instead of rounding (SUM(ts) over a big table would)
db.exec('CREATE TABLE big(v INTEGER)');
db.prepare('INSERT INTO big VALUES (?)').run(2 ** 52);
db.prepare('INSERT INTO big VALUES (?)').run(2 ** 52);
db.prepare('INSERT INTO big VALUES (?)').run(2 ** 52);
assert.throws(() => db.prepare('SELECT sum(v) s FROM big').get(), /too large|ERR_OUT_OF_RANGE/);
const bs = db.prepare('SELECT sum(v) s FROM big'); bs.setReadBigInts(true);
assert.equal(bs.get().s, 3n * 2n ** 52n);
note('integers > 2^53 throw ERR_OUT_OF_RANGE (setReadBigInts(true) for such aggregates); token/credit sums stay far below');

// 7. PRAGMA data_version: bumps on another connection's commit, not on our own
const dir = scratchDir('semantics');
const f = path.join(dir, 's.sqlite');
for (const s of ['', '-wal', '-shm']) rmrf(f + s);
const w = new DatabaseSync(f), r = new DatabaseSync(f);
w.exec('PRAGMA journal_mode=WAL; CREATE TABLE t(x)');
const dv = (d) => d.prepare('PRAGMA data_version').get().data_version;
const r0 = dv(r), w0 = dv(w);
w.exec('INSERT INTO t VALUES (1)');
assert.equal(dv(w), w0, 'own commit does not bump own data_version');
assert.notEqual(dv(r), r0, "other connection's commit bumps data_version");
const r1 = dv(r);
assert.equal(dv(r), r1, 'stable when nothing changed');
note('PRAGMA data_version: bumps for other connections\' commits only (own writes need an in-process version counter)');

// 8. deferred BEGIN + read-then-write => SQLITE_BUSY_SNAPSHOT (517) even with busy_timeout; BEGIN IMMEDIATE waits instead
r.exec('PRAGMA busy_timeout=2000');
r.exec('BEGIN');
r.prepare('SELECT count(*) FROM t').get(); // read snapshot taken
w.exec('INSERT INTO t VALUES (2)'); // another connection commits
let code = null;
try { r.exec('INSERT INTO t VALUES (3)'); } catch (e) { code = e.errcode; }
assert.equal(code, 517);
r.exec('ROLLBACK');
note('deferred BEGIN: SELECT then INSERT after another commit fails immediately with SQLITE_BUSY_SNAPSHOT (517); use BEGIN IMMEDIATE');

// 9. readOnly open of a live WAL database works while a writer holds it open
const ro = new DatabaseSync(f, { readOnly: true });
assert.equal(ro.prepare('SELECT count(*) c FROM t').get().c, 2);
assert.throws(() => ro.exec('INSERT INTO t VALUES (9)'), /readonly/i);
ro.close(); w.close(); r.close();
note('new DatabaseSync(path, { readOnly: true }) reads a live WAL db (S1 still has to prove the Copilot span DB case)');

for (const s of ['', '-wal', '-shm']) rmrf(f + s);
console.log(`\nsemantics OK (${out.length} checks), sqlite ${process.versions.sqlite}`);

'use strict';
// S1 item 4: two OS processes, one WAL file. The parent (this process: Node, or the VS Code extension host)
// is connection A; a spawned child running the SAME runtime is connection B.
const fs = require('node:fs');
const path = require('node:path');
const { spawnWorker } = require('./spawnWorker.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTwoProcessChecks({ sqlite, dir, execPath = process.execPath, env = {} }) {
  const { DatabaseSync } = sqlite;
  const results = [];
  const check = async (id, item, fn) => {
    try {
      const evidence = await fn();
      results.push({ id, item, pass: true, evidence: evidence === undefined ? null : evidence });
    } catch (e) {
      results.push({ id, item, pass: false, evidence: `${e && e.code ? e.code + ': ' : ''}${e && e.message}` });
    }
  };
  const must = (c, m) => {
    if (!c) throw new Error(m);
  };
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, 'shared.sqlite');

  const B = spawnWorker({ execPath, env });
  const callOk = async (op, args) => {
    const r = await B.call(op, args);
    if (!r.ok) throw new Error(`B.${op}: ${r.error}`);
    return r;
  };
  const info = await callOk('info');

  // A: create + WAL
  const A = new DatabaseSync(dbPath);
  A.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL');
  A.exec(`CREATE TABLE ev(id INTEGER PRIMARY KEY, who TEXT, v INTEGER);
          CREATE TABLE contention(id INTEGER PRIMARY KEY, who TEXT, seq INTEGER)`);
  await callOk('open', { path: dbPath, pragmas: ['PRAGMA busy_timeout=5000', 'PRAGMA synchronous=NORMAL'] });
  const dv = () => A.prepare('PRAGMA data_version').get().data_version;
  const count = (t = 'ev') => A.prepare(`SELECT count(*) AS n FROM ${t}`).get().n;

  await check('4a', 'writer commit in B is visible to A on the same connection (no reopen)', async () => {
    const before = count();
    await callOk('exec', { sql: "INSERT INTO ev(who,v) VALUES ('B',1),('B',2),('B',3)" });
    const after = count();
    must(after === before + 3, `before=${before} after=${after}`);
    return { before, after, childNode: info.value.node, childElectron: info.value.electron };
  });
  await check('4b', "PRAGMA data_version changes in A after B commits; unchanged by A's own commit", async () => {
    const d0 = dv();
    await callOk('exec', { sql: "INSERT INTO ev(who,v) VALUES ('B',4)" });
    const d1 = dv();
    A.exec("INSERT INTO ev(who,v) VALUES ('A',5)");
    const d2 = dv();
    const d3 = dv();
    await callOk('exec', { sql: "INSERT INTO ev(who,v) VALUES ('B',6)" });
    const d4 = dv();
    must(d1 !== d0, 'data_version did not change after foreign commit');
    must(d2 === d1, 'own commit changed data_version');
    must(d3 === d2, 'unstable without commits');
    must(d4 !== d3, 'did not change on second foreign commit');
    return { d0, afterForeignCommit: d1, afterOwnCommit: d2, repeat: d3, afterSecondForeign: d4 };
  });
  await check('4c', 'snapshot isolation: open read tx in A is not blocked by B writing, and keeps its snapshot', async () => {
    A.exec('BEGIN');
    const n0 = count();
    const t0 = Date.now();
    await callOk('exec', { sql: "INSERT INTO ev(who,v) VALUES ('B',7)" });
    const bMs = Date.now() - t0;
    const nIn = count();
    A.exec('COMMIT');
    const nAfter = count();
    must(nIn === n0 && nAfter === n0 + 1, `n0=${n0} inTx=${nIn} after=${nAfter}`);
    return { n0, countInsideReadTx: nIn, countAfterCommit: nAfter, writerWaitedMs: bMs };
  });
  await check('4d', 'busy_timeout honoured: A waits for B-held BEGIN IMMEDIATE and then succeeds', async () => {
    const hold = B.call('holdImmediate', { ms: 700 });
    await sleep(150);
    A.exec('PRAGMA busy_timeout=4000');
    const t0 = Date.now();
    A.exec('BEGIN IMMEDIATE');
    const waited = Date.now() - t0;
    A.exec('COMMIT');
    await hold;
    must(waited >= 300 && waited < 3000, 'waited ' + waited);
    return { aWaitedMs: waited, expected: '~550 (B held 700 - 150 head start)' };
  });
  await check('4e', 'busy_timeout honoured: A gives up with "database is locked" after ~timeout', async () => {
    const hold = B.call('holdImmediate', { ms: 2500 });
    await sleep(150);
    A.exec('PRAGMA busy_timeout=600');
    const t0 = Date.now();
    let err = null;
    try {
      A.exec('BEGIN IMMEDIATE');
      A.exec('ROLLBACK');
    } catch (e) {
      err = `${e.code || ''}: ${e.message}`;
    }
    const waited = Date.now() - t0;
    await hold;
    A.exec('PRAGMA busy_timeout=5000');
    must(err && /locked|busy/i.test(err), 'expected locked error, got ' + err);
    must(waited >= 500 && waited < 1500, 'waited ' + waited);
    return { aWaitedMs: waited, error: err };
  });
  await check('4f', 'default busy_timeout=0 fails immediately (PRAGMA must be set on every connection)', async () => {
    const A2 = new DatabaseSync(dbPath);
    const hold = B.call('holdImmediate', { ms: 500 });
    await sleep(150);
    const t0 = Date.now();
    let err = null;
    try {
      A2.exec('BEGIN IMMEDIATE');
      A2.exec('ROLLBACK');
    } catch (e) {
      err = `${e.code || ''}: ${e.message}`;
    }
    const waited = Date.now() - t0;
    A2.close();
    await hold;
    must(err && waited < 100, `err=${err} waited=${waited}`);
    return { waitedMs: waited, error: err };
  });
  await check('4g', 'reverse direction: B waits (busy_timeout) for A-held BEGIN IMMEDIATE, then succeeds', async () => {
    A.exec('BEGIN IMMEDIATE');
    const p = B.call('exec', { sql: 'BEGIN IMMEDIATE' });
    await sleep(600);
    A.exec('COMMIT');
    const r = await p;
    must(r.ok, 'B failed: ' + r.error);
    await callOk('exec', { sql: 'COMMIT' });
    must(r.ms >= 400 && r.ms < 4000, 'B waited ' + r.ms);
    return { bWaitedMs: r.ms };
  });
  await check('4h', 'both processes run 20000 x (BEGIN IMMEDIATE; INSERT; COMMIT) concurrently (overlapping): zero busy failures, 40000 rows', async () => {
    const N = 20000;
    const pB = B.call('loopInsert', { n: N, who: 'B' });
    await sleep(30); // let B start its loop
    const t0 = Date.now();
    let aFail = 0;
    let aMax = 0;
    const ins = A.prepare('INSERT INTO contention(who, seq) VALUES (?, ?)');
    for (let i = 0; i < N; i++) {
      const s = Date.now();
      try {
        A.exec('BEGIN IMMEDIATE');
        ins.run('A', i);
        A.exec('COMMIT');
      } catch (e) {
        aFail++;
        try {
          A.exec('ROLLBACK');
        } catch (_) {
          /* none */
        }
      }
      aMax = Math.max(aMax, Date.now() - s);
    }
    const aEnd = Date.now();
    const aMs = aEnd - t0;
    const rb = await pB;
    must(rb.ok, 'B: ' + rb.error);
    const total = count('contention');
    const overlapMs = Math.min(aEnd, rb.value.endedAt) - Math.max(t0, rb.value.startedAt);
    must(aFail === 0 && rb.value.failures === 0 && total === 2 * N, `aFail=${aFail} bFail=${rb.value.failures} total=${total}`);
    must(overlapMs > 50, 'loops did not overlap: ' + overlapMs);
    return { aFailures: aFail, bFailures: rb.value.failures, rows: total, overlapMs, aLoopMs: aMs, bLoopMs: rb.value.endedAt - rb.value.startedAt, aMaxTxMs: aMax, bMaxTxMs: rb.value.maxTxMs };
  });
  await check('4i', 'B SIGKILLed mid-write-transaction: lock released, uncommitted rows invisible, A can write', async () => {
    await callOk('exec', { sql: 'BEGIN IMMEDIATE' });
    await callOk('exec', { sql: "INSERT INTO ev(who,v) VALUES ('B-uncommitted', 99)" });
    const before = A.prepare("SELECT count(*) AS n FROM ev WHERE who='B-uncommitted'").get().n;
    B.kill();
    await sleep(300);
    A.exec('PRAGMA busy_timeout=2000');
    const t0 = Date.now();
    A.exec('BEGIN IMMEDIATE');
    A.exec("INSERT INTO ev(who,v) VALUES ('A-after-kill', 1)");
    A.exec('COMMIT');
    const ms = Date.now() - t0;
    const after = A.prepare("SELECT count(*) AS n FROM ev WHERE who='B-uncommitted'").get().n;
    must(before === 0 && after === 0, `uncommitted visible: before=${before} after=${after}`);
    return { uncommittedVisibleBeforeKill: before, afterKill: after, aWriteAfterKillMs: ms };
  });
  A.close();
  B.kill();
  results.push({ id: '4z', item: 'child runtime', pass: true, evidence: info.value });
  return results;
}

module.exports = { runTwoProcessChecks };

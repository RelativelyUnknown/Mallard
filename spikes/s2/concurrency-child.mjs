// Child process for bench-concurrency.mjs. Roles: writer | reader.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { genEvents, bind, applyMode, UPSERT_SQL } from './lib/data.mjs';
import { summarize, tick, sleep, nowMs } from './lib/stats.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const role = arg('role');
const dbFile = arg('db');
const busy = +arg('busy', 5000);
const goFile = arg('go');
const stopFile = arg('stop');

const isBusy = (e) => e && (e.errcode === 5 || e.errcode === 6 || (e.errcode & 0xff) === 5 || (e.errcode & 0xff) === 6 || /locked|busy/i.test(String(e.message)));
const errKey = (e) => `${e.errcode ?? '?'}:${e.errstr ?? e.message}`;

async function waitGo() {
  console.log('ready');
  while (!fs.existsSync(goFile)) await sleep(2);
}

if (role === 'writer') {
  const idx = +arg('idx', 0);
  const rows = +arg('rows', 60_000);
  const batch = +arg('batch', 2000);
  const begin = arg('begin', 'immediate'); // immediate | deferred
  const retry = arg('retry', '0') === '1';
  const preselect = arg('preselect', '0') === '1';
  const all = genEvents(rows, { seed: 31 });
  const half = Math.floor(rows / 2) * idx;
  const events = [...all.slice(half), ...all.slice(0, half)]; // same ids, different order per writer => real conflicts
  const db = new DatabaseSync(dbFile);
  applyMode(db, 'wal', busy);
  const stmt = db.prepare(UPSERT_SQL);
  const selCache = new Map();
  const preSel = (ids) => {
    let s = selCache.get(ids.length);
    if (!s) { s = db.prepare(`SELECT id FROM events WHERE id IN (${Array(ids.length).fill('?').join(',')})`); s.setReturnArrays(true); selCache.set(ids.length, s); }
    return s.all(...ids);
  };
  await waitGo();
  const attemptMs = [];
  const batchMs = [];
  const busyErrors = {};
  let busyCount = 0, retries = 0, failedBatches = 0, doneBatches = 0;
  const t0 = nowMs();
  for (let i = 0; i < events.length; i += batch) {
    const slice = events.slice(i, i + batch);
    const b0 = nowMs();
    let attempts = 0;
    for (;;) {
      attempts++;
      const a0 = nowMs();
      let inTxn = false;
      try {
        db.exec(begin === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN');
        inTxn = true;
        if (preselect) preSel(slice.map((r) => r[0]));
        for (const r of slice) bind(stmt, r);
        db.exec('COMMIT');
        inTxn = false;
        attemptMs.push(nowMs() - a0);
        doneBatches++;
        break;
      } catch (e) {
        if (inTxn) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } }
        attemptMs.push(nowMs() - a0);
        if (!isBusy(e)) throw e;
        busyCount++;
        const k = errKey(e);
        busyErrors[k] = (busyErrors[k] ?? 0) + 1;
        if (!retry || attempts > 400) { failedBatches++; break; }
        retries++;
        await sleep(3 + Math.random() * 12); // async back-off: the event loop stays free while waiting
      }
    }
    batchMs.push(nowMs() - b0);
    await tick();
  }
  const total = nowMs() - t0;
  const walBytes = (() => { try { return fs.statSync(`${dbFile}-wal`).size; } catch { return 0; } })();
  db.close();
  console.log(JSON.stringify({ role, idx, totalMs: total, doneBatches, failedBatches, busyCount, retries, busyErrors, attempt: summarize(attemptMs), batch: summarize(batchMs), walBytes }));
} else if (role === 'reader') {
  const db = new DatabaseSync(dbFile);
  applyMode(db, 'wal', busy);
  const verStmt = db.prepare('PRAGMA data_version');
  const snap = db.prepare('SELECT modelId, repo, promptTokens, completionTokens, cacheReadTokens, ts FROM events WHERE ts >= ?');
  snap.setReturnArrays(true);
  await waitGo();
  const verCostUs = [];
  const readMs = [];
  const rowCounts = [];
  const busyErrors = {};
  let busyCount = 0, bumps = 0, lastVer = verStmt.get().data_version, polls = 0, reads = 0;
  const t0 = nowMs();
  let lastRead = -1e9;
  while (!fs.existsSync(stopFile)) {
    const p0 = nowMs();
    let ver;
    try { ver = verStmt.get().data_version; } catch (e) { if (isBusy(e)) { busyCount++; busyErrors[errKey(e)] = (busyErrors[errKey(e)] ?? 0) + 1; continue; } throw e; }
    verCostUs.push((nowMs() - p0) * 1000);
    polls++;
    const changed = ver !== lastVer;
    if (changed) bumps++;
    lastVer = ver;
    if (changed || nowMs() - lastRead > 1000) {
      const r0 = nowMs();
      try {
        let n = 0, sum = 0;
        for (const r of snap.iterate(0)) { n++; sum += (r[2] ?? 0) + (r[3] ?? 0); }
        readMs.push(nowMs() - r0);
        rowCounts.push(n);
        reads++;
      } catch (e) { if (isBusy(e)) { busyCount++; busyErrors[errKey(e)] = (busyErrors[errKey(e)] ?? 0) + 1; } else throw e; }
      lastRead = nowMs();
    }
    await sleep(20); // polling cadence
  }
  const total = nowMs() - t0;
  db.close();
  const monotonic = rowCounts.every((v, i) => i === 0 || v >= rowCounts[i - 1]);
  console.log(JSON.stringify({ role, totalMs: total, polls, bumps, reads, busyCount, busyErrors, dataVersionCallUs: summarize(verCostUs), read: summarize(readMs), rowsFirst: rowCounts[0], rowsLast: rowCounts.at(-1), monotonic }));
}
process.exit(0);

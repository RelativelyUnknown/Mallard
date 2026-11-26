// S2.1: insert 100k synthetic events with prepared upserts in transactions of N rows, setImmediate between batches.
// Measures per-batch wall time (= event-loop block), throughput and an independent monitorEventLoopDelay histogram.
//
//   node --disable-warning=ExperimentalWarning spikes/s2/bench-insert.mjs [--rows 100000] [--runs 5]
//        [--batches 1000,2000,5000,10000,t15] [--modes wal,wal-off,wal-ckpt0,wal-ckpt-big,wal-full,default]
//
// A batch spec "t15" means time-boxed: keep inserting until 15 ms elapsed (checked every 50 rows, cap 10000), then COMMIT.
// Each (mode,batch) cell runs RUNS times on fresh DB files after one discarded warm-up run per process.
import { DatabaseSync } from 'node:sqlite';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import path from 'node:path';
import { genEvents, bind, openDb, UPSERT_SQL } from './lib/data.mjs';
import { summarize, histMs, fmt, mdTable, scratchDir, rmrf, saveResult, tick, nowMs, median } from './lib/stats.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const ROWS = +arg('rows', 100_000);
const RUNS = +arg('runs', 5);
const BATCHES = arg('batches', '1000,2000,5000,10000,t15').split(',');
const MODES = arg('modes', 'wal,wal-off,wal-ckpt0,wal-ckpt-big,wal-full,default').split(',');
const CKPT_EVERY_ROWS = 20_000; // wal-ckpt0: explicit PASSIVE checkpoint cadence
const TAG = arg('tag', '');
const RES_MS = 1; // timer resolution of the EL histogram

const dir = scratchDir('insert');
const events = genEvents(ROWS, { seed: 11 });
console.log(`generated ${events.length} events, e.g. id length ${events[0][0].length}`);

const clean = (file) => { for (const s of ['', '-wal', '-shm', '-journal']) rmrf(file + s); };

async function runOnce(mode, spec, runIdx, rowsLimit = events.length) {
  const file = path.join(dir, `bench-${mode}-${spec}-${runIdx}.sqlite`);
  clean(file);
  const db = openDb(DatabaseSync, file, mode);
  const stmt = db.prepare(UPSERT_SQL);
  const timeBoxMs = spec.startsWith('t') ? +spec.slice(1) : 0;
  const batchSize = timeBoxMs ? 10_000 : +spec;
  const h = monitorEventLoopDelay({ resolution: RES_MS });
  await tick();
  h.enable();
  const batchMs = [], commitMs = [], ckptMs = [], batchRows = [];
  const t0 = nowMs();
  let batchNo = 0;
  let i = 0;
  while (i < rowsLimit) {
    const cap = Math.min(rowsLimit, i + batchSize);
    const b0 = nowMs();
    db.exec('BEGIN IMMEDIATE');
    let j = i;
    if (timeBoxMs) {
      while (j < cap) {
        const stop = Math.min(cap, j + 50);
        for (; j < stop; j++) bind(stmt, events[j]);
        if (nowMs() - b0 >= timeBoxMs) break;
      }
    } else for (; j < cap; j++) bind(stmt, events[j]);
    const c0 = nowMs();
    db.exec('COMMIT');
    const b1 = nowMs();
    batchMs.push(b1 - b0);
    commitMs.push(b1 - c0);
    batchRows.push(j - i);
    i = j;
    await tick(); // yield: timers/IO get a turn between batches
    if (mode === 'wal-ckpt0' && ++batchNo % Math.max(1, Math.round(CKPT_EVERY_ROWS / (batchRows.at(-1) || 1))) === 0) {
      const k0 = nowMs();
      db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      ckptMs.push(nowMs() - k0);
      await tick();
    }
  }
  const total = nowMs() - t0;
  h.disable();
  const count = db.prepare('SELECT count(*) c FROM events').get().c;
  db.close();
  clean(file);
  if (count !== rowsLimit) throw new Error(`row count ${count} != ${rowsLimit}`);
  return { batchMs, commitMs, ckptMs, batchRows, totalMs: total, rowsPerSec: (rowsLimit / total) * 1000, el: histMs(h, RES_MS) };
}

// warm-up: JIT + page cache, discarded
await runOnce('wal', '2000', 'warm', 30_000);

const results = [];
for (const mode of MODES) {
  for (const spec of BATCHES) {
    const runs = [];
    for (let r = 0; r < RUNS; r++) {
      runs.push(await runOnce(mode, spec, r));
      process.stdout.write('.');
    }
    const pooled = summarize(runs.flatMap((r) => r.batchMs));
    const commit = summarize(runs.flatMap((r) => r.commitMs));
    const ckpt = summarize(runs.flatMap((r) => r.ckptMs));
    const rowsPer = summarize(runs.flatMap((r) => r.batchRows));
    const row = {
      mode, batch: spec, batchStats: pooled, commit, ckpt, rowsPerBatch: rowsPer,
      medianOfRunP95: median(runs.map((r) => summarize(r.batchMs).p95)),
      worstRunMax: Math.max(...runs.map((r) => summarize(r.batchMs).max)),
      rowsPerSec: median(runs.map((r) => r.rowsPerSec)),
      totalMs: median(runs.map((r) => r.totalMs)),
      el: {
        p50: median(runs.map((r) => r.el.p50)), p95: median(runs.map((r) => r.el.p95)),
        p99: median(runs.map((r) => r.el.p99)), max: Math.max(...runs.map((r) => r.el.max)),
      },
      runs: runs.map((r) => ({ totalMs: r.totalMs, rowsPerSec: r.rowsPerSec, batchP95: summarize(r.batchMs).p95, batchMax: summarize(r.batchMs).max, el: r.el })),
    };
    results.push(row);
    console.log(`\n${mode} batch=${spec}: batch p95 ${fmt(pooled.p95)} ms, max ${fmt(pooled.max)} ms, ${fmt(row.rowsPerSec, 0)} rows/s`);
  }
}

const table = mdTable(
  ['mode', 'batch', 'n batches', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'COMMIT p95/max ms', 'explicit ckpt p95/max (n)', 'rows/s (median run)', 'total s', 'ELdelay p50/p95/p99/max ms'],
  results.map((r) => [
    r.mode, r.batch === `t15` ? `t15 (~${fmt(r.rowsPerBatch.p50, 0)} rows)` : r.batch, r.batchStats.n, fmt(r.batchStats.p50), fmt(r.batchStats.p95), fmt(r.batchStats.p99), fmt(r.batchStats.max),
    `${fmt(r.commit.p95)}/${fmt(r.commit.max)}`, r.ckpt.n ? `${fmt(r.ckpt.p95)}/${fmt(r.ckpt.max)} (${r.ckpt.n})` : '-', fmt(r.rowsPerSec, 0), fmt(r.totalMs / 1000, 2),
    `${fmt(r.el.p50)}/${fmt(r.el.p95)}/${fmt(r.el.p99)}/${fmt(r.el.max)}`,
  ]),
);
console.log(`\n${table}`);
saveResult(`insert${TAG}`, { rows: ROWS, runs: RUNS, results, table });
rmrf(dir);

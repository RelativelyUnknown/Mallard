// S2.5: worker_thread variant. node:sqlite runs inside a worker; the main thread posts requests and receives results.
// Reports added latency vs in-thread and the main-thread block (monitorEventLoopDelay + explicit postMessage timings).
//
//   TZ=America/Los_Angeles node --disable-warning=ExperimentalWarning spikes/s2/bench-worker.mjs [--runs 7]
import { Worker } from 'node:worker_threads';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { genEvents, genRollups, bind, openDb, UPSERT_SQL, COLS, DAY_MS } from './lib/data.mjs';
import { Aggregator, BUCKET_MS } from './lib/aggregate.mjs';
import { summarize, histMs, fmt, mdTable, scratchDir, rmrf, saveResult, tick, nowMs } from './lib/stats.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const RUNS = +arg('runs', 7);
const NOW = Date.UTC(2026, 10, 24, 12);
const FROM = NOW - 365 * DAY_MS, TO = NOW + DAY_MS;
const workerFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker-db.mjs');
const dir = scratchDir('worker');
const file = path.join(dir, 'w.sqlite');
const clean = () => { for (const s of ['', '-wal', '-shm']) rmrf(file + s); };

function seedDb() {
  clean();
  const db = openDb(DatabaseSync, file, 'wal');
  const st = db.prepare(UPSERT_SQL);
  db.exec('BEGIN IMMEDIATE');
  for (const r of [...genEvents(50_000, { seed: 21, endTs: NOW }), ...genRollups(5_000, { endTs: NOW })]) bind(st, r);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); ANALYZE;');
  db.close();
}

class WorkerClient {
  constructor() {
    this.w = new Worker(workerFile, { workerData: { db: file } });
    this.pending = new Map();
    this.seq = 0;
    this.t0 = nowMs();
    this.ready = new Promise((res) => { this.onReady = res; });
    this.w.on('message', (m) => {
      if (m.type === 'ready') { this.readyMs = nowMs() - this.t0; this.workerStartMs = m.startMs; this.onReady(); return; }
      const p = this.pending.get(m.id);
      if (p) { this.pending.delete(m.id); p(m); }
    });
  }
  request(msg) {
    return new Promise((res) => {
      const id = ++this.seq;
      this.pending.set(id, res);
      const p0 = nowMs();
      this.w.postMessage({ ...msg, id });
      this.lastPostMs = nowMs() - p0;
    });
  }
  async close() { this.w.postMessage({ type: 'close' }); await new Promise((r) => this.w.once('exit', r)); }
}

// Independent main-thread block probe: a setImmediate spin loop records the longest gap between two turns of the loop
// (precise to microseconds, unlike the 1 ms timer behind monitorEventLoopDelay). Burns one core; the box has four.
function startGapProbe() {
  let last = performance.now(), max = 0, stop = false;
  const loop = () => { const n = performance.now(); if (n - last > max) max = n - last; last = n; if (!stop) setImmediate(loop); };
  setImmediate(loop);
  // one extra turn so the gap that ended with our own continuation (e.g. a big message deserialised just before) is recorded
  return async () => { await tick(); await tick(); stop = true; return max; };
}
async function withEL(fn) {
  const h = monitorEventLoopDelay({ resolution: 1 });
  await tick();
  h.enable();
  const stopProbe = startGapProbe();
  const out = await fn();
  const gap = await stopProbe();
  h.disable();
  return { out, el: { ...histMs(h, 1), gap } };
}

seedDb();
const results = {};

// ---- T0: startup ----
{
  const ready = [], inWorker = [];
  for (let i = 0; i < RUNS; i++) {
    const c = new WorkerClient();
    await c.ready;
    ready.push(c.readyMs); inWorker.push(c.workerStartMs);
    await c.close();
  }
  results.startup = { readyMs: summarize(ready), inWorkerMs: summarize(inWorker) };
  console.log(`worker startup (spawn -> ready): p50 ${fmt(results.startup.readyMs.p50)} ms, max ${fmt(results.startup.readyMs.max)} ms`);
}

let client = new WorkerClient();
await client.ready;

// ---- T1/T2: snapshots ----
function inThreadSnapshot(source) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000');
  const COLS14 = 'ts, modelId, surface, source, repo, branch, attribution, language, requests, promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens, thinkingTokens';
  const st = source === 'raw'
    ? db.prepare(`SELECT ${COLS14} FROM events WHERE ts >= ? AND ts < ?`)
    : db.prepare(`SELECT (ts / ${BUCKET_MS}) * ${BUCKET_MS} AS ts, modelId, surface, source, repo, branch, attribution, language, sum(requests) AS requests, sum(promptTokens) AS promptTokens, sum(completionTokens) AS completionTokens, sum(cacheReadTokens) AS cacheReadTokens, sum(cacheCreationTokens) AS cacheCreationTokens, sum(thinkingTokens) AS thinkingTokens FROM events WHERE ts >= ? AND ts < ? GROUP BY ts / ${BUCKET_MS}, modelId, surface, source, repo, branch, attribution, language`);
  return () => {
    const agg = new Aggregator(true);
    for (const r of st.iterate(FROM, TO)) agg.add(r.ts, r.modelId, r.surface, r.source, r.repo, r.branch, r.attribution, r.language, r.requests, r.promptTokens, r.completionTokens, r.cacheReadTokens, r.cacheCreationTokens, r.thinkingTokens);
    return agg.digest();
  };
}

results.snapshots = [];
for (const source of ['raw', 'sql15']) {
  const inThread = inThreadSnapshot(source);
  inThread(); // warm
  const base = { ms: [], el: [], gap: [] };
  for (let i = 0; i < RUNS; i++) {
    const { out, el } = await withEL(async () => { const t = nowMs(); inThread(); return nowMs() - t; });
    base.ms.push(out); base.el.push(el.max); base.gap.push(el.gap);
  }
  await client.request({ type: 'snapshot', source, from: FROM, to: TO }); // warm
  const lat = [], inW = [], elMax = [], elP99 = [], post = [], gaps = [];
  for (let i = 0; i < RUNS; i++) {
    const { out, el } = await withEL(async () => {
      const t = nowMs();
      const p = client.request({ type: 'snapshot', source, from: FROM, to: TO });
      post.push(client.lastPostMs);
      const m = await p;
      return { total: nowMs() - t, inWorker: m.ms };
    });
    lat.push(out.total); inW.push(out.inWorker); elMax.push(el.max); elP99.push(el.p99); gaps.push(el.gap);
  }
  const row = {
    source,
    inThread: { ms: summarize(base.ms), elMax: summarize(base.el), gap: summarize(base.gap) },
    worker: { latency: summarize(lat), inWorkerMs: summarize(inW), addedLatencyMs: summarize(lat.map((l, i) => l - inW[i])), mainElMax: summarize(elMax), mainGap: summarize(gaps), mainElP99: summarize(elP99), postMs: summarize(post) },
  };
  results.snapshots.push(row);
  console.log(`snapshot ${source}: in-thread p50 ${fmt(row.inThread.ms.p50)} ms (block = same) | worker latency p50 ${fmt(row.worker.latency.p50)} ms (worker ${fmt(row.worker.inWorkerMs.p50)} ms, +${fmt(row.worker.addedLatencyMs.p50)} ms), main-thread max gap p50/max ${fmt(row.worker.mainGap.p50)}/${fmt(row.worker.mainGap.max)} ms`);
}

// raw rows to the main thread (what happens if the worker only runs the SELECT)
{
  await client.request({ type: 'rows', from: FROM, to: TO });
  const lat = [], elMax = [], inW = [], gapsR = [];
  for (let i = 0; i < RUNS; i++) {
    const { out, el } = await withEL(async () => { const t = nowMs(); const m = await client.request({ type: 'rows', from: FROM, to: TO }); return { total: nowMs() - t, inWorker: m.ms, n: m.rows.length }; });
    lat.push(out.total); inW.push(out.inWorker); elMax.push(el.max); gapsR.push(el.gap);
  }
  results.rowsToMain = { latency: summarize(lat), inWorkerMs: summarize(inW), mainElMax: summarize(elMax), mainGap: summarize(gapsR) };
  console.log(`worker returns 54k raw rows: latency p50 ${fmt(results.rowsToMain.latency.p50)} ms, main gap p50/max ${fmt(results.rowsToMain.mainGap.p50)}/${fmt(results.rowsToMain.mainGap.max)} ms`);
}

// ---- T3: write pipeline (100k rows, batches of 2000, 2 in flight) ----
async function pipeline({ useWorker, batch = 2000, rows = 100_000, window = 2 }) {
  const events = genEvents(rows, { seed: 77, idPrefix: 'wk' });
  let inThreadDb, insIgnore, bumpG;
  if (!useWorker) {
    inThreadDb = new DatabaseSync(file);
    inThreadDb.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000');
    insIgnore = inThreadDb.prepare(`INSERT INTO events (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')}) ON CONFLICT(id) DO NOTHING`);
    bumpG = inThreadDb.prepare('UPDATE events SET promptTokens = ? WHERE id = ? AND coalesce(?,0) > coalesce(promptTokens,0)');
  }
  const postMs = [], handlerMs = [], batchLat = [], completionTimes = [];
  let freshCount = 0;
  const { out, el } = await withEL(async () => {
    const t0 = nowMs();
    if (!useWorker) {
      for (let i = 0; i < events.length; i += batch) {
        const b0 = nowMs();
        inThreadDb.exec('BEGIN IMMEDIATE');
        const fresh = [];
        for (const r of events.slice(i, i + batch)) {
          if (insIgnore.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14]).changes === 1) fresh.push(r[0]);
          else bumpG.run(r[10], r[0], r[10]);
        }
        inThreadDb.exec('COMMIT');
        freshCount += fresh.length;
        batchLat.push(nowMs() - b0);
        completionTimes.push(nowMs());
        await tick();
      }
      inThreadDb.close();
    } else {
      let next = 0, inflight = 0;
      await new Promise((resolve) => {
        const pump = () => {
          while (inflight < window && next < events.length) {
            const slice = events.slice(next, next + batch);
            next += batch;
            inflight++;
            const s = nowMs();
            const p = client.request({ type: 'insert', rows: slice });
            postMs.push(client.lastPostMs);
            p.then((m) => {
              const h0 = nowMs();
              freshCount += m.fresh.length;
              inflight--;
              batchLat.push(nowMs() - s);
              completionTimes.push(nowMs());
              handlerMs.push(nowMs() - h0);
              if (next >= events.length && inflight === 0) resolve(); else pump();
            });
          }
        };
        pump();
      });
    }
    return nowMs() - t0;
  });
  const gaps = completionTimes.slice(1).map((t, i) => t - completionTimes[i]);
  return { totalMs: out, rowsPerSec: (rows / out) * 1000, el, gap: el.gap, postMs: summarize(postMs), handlerMs: summarize(handlerMs), batchLat: summarize(batchLat), gaps: summarize(gaps), freshCount };
}

results.write = {};
for (const useWorker of [false, true]) {
  const runs = [];
  for (let i = 0; i < Math.max(3, Math.floor(RUNS / 2)); i++) {
    seedDb();
    if (useWorker) { await client.close(); client = new WorkerClient(); await client.ready; }
    runs.push(await pipeline({ useWorker }));
  }
  const key = useWorker ? 'worker' : 'inThread';
  results.write[key] = {
    totalMs: summarize(runs.map((r) => r.totalMs)), rowsPerSec: summarize(runs.map((r) => r.rowsPerSec)),
    mainElMax: summarize(runs.map((r) => r.el.max)), mainElP99: summarize(runs.map((r) => r.el.p99)), mainGap: summarize(runs.map((r) => r.gap)),
    postMs: summarize(runs.flatMap((r) => (r.postMs.n ? [r.postMs.p50, r.postMs.p95, r.postMs.max] : []))),
    postMsMax: Math.max(0, ...runs.map((r) => r.postMs.max || 0)),
    handlerMsMax: Math.max(0, ...runs.map((r) => r.handlerMs.max || 0)),
    batchLatencyP95: summarize(runs.map((r) => r.batchLat.p95)), freshCounts: runs.map((r) => r.freshCount),
  };
  console.log(`write 100k rows ${key}: total p50 ${fmt(results.write[key].totalMs.p50, 0)} ms, ${fmt(results.write[key].rowsPerSec.p50, 0)} rows/s, main gap p50/max ${fmt(results.write[key].mainGap.p50)}/${fmt(results.write[key].mainGap.max)} ms, postMessage max ${fmt(results.write[key].postMsMax)} ms`);
}

await client.close();
rmrf(dir);

const t1 = mdTable(
  ['snapshot @ 54k rows', 'in-thread total = main block p50 / p95 ms', 'worker latency p50 / p95 ms', 'work inside worker p50 ms', 'added latency p50 ms', 'main-thread longest loop gap, p50 / worst of runs ms', 'postMessage call ms (p50)'],
  results.snapshots.map((r) => [
    r.source === 'raw' ? 'raw rows (objects)' : 'SQL 15-min GROUP BY',
    `${fmt(r.inThread.ms.p50)} / ${fmt(r.inThread.ms.p95)}`, `${fmt(r.worker.latency.p50)} / ${fmt(r.worker.latency.p95)}`, fmt(r.worker.inWorkerMs.p50), fmt(r.worker.addedLatencyMs.p50),
    `${fmt(r.worker.mainGap.p50)} / ${fmt(r.worker.mainGap.max)}`, fmt(r.worker.postMs.p50, 3),
  ]),
);
const w = results.write;
const t2 = mdTable(
  ['100k-row ingest, 2000/batch', 'total ms (p50)', 'rows/s (p50)', 'main-thread longest loop gap, p50 / worst ms', 'main EL-delay p99 ms (p50)', 'postMessage(2000 rows) p50 / worst ms'],
  [
    ['in-thread (F4g)', fmt(w.inThread.totalMs.p50, 0), fmt(w.inThread.rowsPerSec.p50, 0), `${fmt(w.inThread.mainGap.p50)} / ${fmt(w.inThread.mainGap.max)}`, fmt(w.inThread.mainElP99.p50), '-'],
    ['worker (2 batches in flight)', fmt(w.worker.totalMs.p50, 0), fmt(w.worker.rowsPerSec.p50, 0), `${fmt(w.worker.mainGap.p50)} / ${fmt(w.worker.mainGap.max)}`, fmt(w.worker.mainElP99.p50), `${fmt(w.worker.postMs.p50)} / ${fmt(w.worker.postMsMax)}`],
  ],
);
console.log(`\n${t1}\n\n${t2}\n\nworker returning raw rows: latency p50 ${fmt(results.rowsToMain.latency.p50)} ms, main longest gap p50/worst ${fmt(results.rowsToMain.mainGap.p50)}/${fmt(results.rowsToMain.mainGap.max)} ms; worker spawn->ready p50 ${fmt(results.startup.readyMs.p50)} ms`);
saveResult('worker', { runs: RUNS, results, tables: { snapshots: t1, write: t2 } });

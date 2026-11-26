// S2.2: snapshot read = filtered SELECT feeding a JS aggregator (local day/hour/weekday buckets, per-model/repo/branch
// totals, read-time pricing). Factor grid: raw rows vs SQL pre-aggregation into 15-minute UTC buckets, .all() vs
// .iterate(), row objects vs arrays (setReturnArrays needs Node >= 22.16: skipped when missing), naive (repo-style
// `new Date(y,m,d)` per row) vs cached-per-15-min-bucket local fields, plus fetch-only timings and a sliced+yielding run.
//
//   TZ=America/Los_Angeles node --disable-warning=ExperimentalWarning --expose-gc spikes/s2/bench-read.mjs \
//        [--runs 7] [--data clustered|uniform] [--raw 50000] [--rollups 5000] [--verify-only]
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { genEvents, genRollups, bind, openDb, UPSERT_SQL, MODELS, REPOS, DAY_MS } from './lib/data.mjs';
import { summarize, fmt, mdTable, scratchDir, rmrf, saveResult, tick, nowMs } from './lib/stats.mjs';
import { Aggregator, firstDiff, BUCKET_MS } from './lib/aggregate.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const RUNS = +arg('runs', 7);
const DATA = arg('data', 'clustered');
const RAW = +arg('raw', 50_000);
const ROLLUPS = +arg('rollups', 5_000);
const VERIFY_ONLY = process.argv.includes('--verify-only');
const NOW = Date.UTC(2026, 10, 24, 12);
const gc = globalThis.gc ?? (() => {});

// ---------- DB ----------
const dir = scratchDir(`read-${DATA}`);
const file = path.join(dir, 'read.sqlite');
for (const f of [file, `${file}-wal`, `${file}-shm`]) rmrf(f);
const db = openDb(DatabaseSync, file, 'wal');
{
  const st = db.prepare(UPSERT_SQL);
  const rows = [...genEvents(RAW, { seed: 21, mode: DATA, endTs: NOW }), ...genRollups(ROLLUPS, { endTs: NOW })];
  db.exec('BEGIN IMMEDIATE');
  for (const r of rows) bind(st, r);
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); ANALYZE;');
}
const total = db.prepare('SELECT count(*) c FROM events').get().c;
console.log(`db: ${total} rows (${RAW} raw ${DATA} + ${ROLLUPS} rollups), TZ=${process.env.TZ ?? 'system'}`);

// ---------- queries ----------
const HAS_ARRAYS = typeof db.prepare('SELECT 1').setReturnArrays === 'function';
console.log(`setReturnArrays available: ${HAS_ARRAYS} (node ${process.version})`);
const COLS14 = 'ts, modelId, surface, source, repo, branch, attribution, language, requests, promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens, thinkingTokens';
const topModels = MODELS.slice(0, 3);
const someRepos = REPOS.slice(0, 5);
const SCENARIOS = [
  { name: 'range 365d (default; all rows)', from: NOW - 365 * DAY_MS, to: NOW + DAY_MS, models: null, repos: null },
  { name: 'range 30d', from: NOW - 30 * DAY_MS, to: NOW + DAY_MS, models: null, repos: null },
  { name: '365d + 3 models', from: NOW - 365 * DAY_MS, to: NOW + DAY_MS, models: topModels, repos: null },
  { name: '365d + 3 models + 5 repos', from: NOW - 365 * DAY_MS, to: NOW + DAY_MS, models: topModels, repos: someRepos },
];
function where(s) {
  const parts = ['ts >= ? AND ts < ?'];
  const params = [s.from, s.to];
  if (s.models) { parts.push(`modelId IN (${s.models.map(() => '?').join(',')})`); params.push(...s.models); }
  if (s.repos) { parts.push(`repo IN (${s.repos.map(() => '?').join(',')})`); params.push(...s.repos); }
  return { sql: parts.join(' AND '), params };
}
const SQL = {
  raw: (w) => `SELECT ${COLS14} FROM events WHERE ${w}`,
  'raw-ordered': (w) => `SELECT ${COLS14} FROM events WHERE ${w} ORDER BY ts`,
  // SQL pre-aggregation: one row per (15-min UTC bucket, model, surface, source, repo, branch, attribution, language)
  sql15: (w) => `SELECT (ts / ${BUCKET_MS}) * ${BUCKET_MS} AS ts, modelId, surface, source, repo, branch, attribution, language,
       sum(requests) AS requests, sum(promptTokens) AS promptTokens, sum(completionTokens) AS completionTokens,
       sum(cacheReadTokens) AS cacheReadTokens, sum(cacheCreationTokens) AS cacheCreationTokens, sum(thinkingTokens) AS thinkingTokens
  FROM events WHERE ${w}
 GROUP BY ts / ${BUCKET_MS}, modelId, surface, source, repo, branch, attribution, language`,
};
const stmtCache = new Map();
function stmtFor(source, shape, sql) {
  const key = `${source}|${shape}|${sql}`;
  let st = stmtCache.get(key);
  if (!st) {
    st = db.prepare(SQL[source](sql));
    if (shape === 'arr') st.setReturnArrays(true);
    stmtCache.set(key, st);
  }
  return st;
}
const feedObj = (agg, r) => agg.add(r.ts, r.modelId, r.surface, r.source, r.repo, r.branch, r.attribution, r.language, r.requests, r.promptTokens, r.completionTokens, r.cacheReadTokens, r.cacheCreationTokens, r.thinkingTokens);
const feedArr = (agg, r) => agg.add(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13]);

function makeVariant({ source, fetch, shape, bucket = 'cached', agg = true }) {
  const name = `${source} ${fetch}() ${shape}${agg ? ` ${bucket}-local` : ' (fetch only)'}`;
  return {
    name, source, fetch, shape, bucket, agg,
    needsArrays: shape === 'arr',
    run(s) {
      const w = where(s);
      const st = stmtFor(source, shape, w.sql);
      const aggr = agg ? new Aggregator(bucket === 'cached') : null;
      const feed = shape === 'arr' ? feedArr : feedObj;
      let n = 0;
      if (fetch === 'all') {
        const rows = st.all(...w.params);
        n = rows.length;
        if (aggr) for (const r of rows) feed(aggr, r);
      } else {
        for (const r of st.iterate(...w.params)) { n++; if (aggr) feed(aggr, r); }
      }
      return { agg: aggr, n };
    },
  };
}
const GRID = [];
for (const shape of ['obj', 'arr']) {
  for (const bucket of ['naive', 'cached']) for (const fetch of ['all', 'iterate']) GRID.push({ source: 'raw', fetch, shape, bucket });
  for (const fetch of ['all', 'iterate']) GRID.push({ source: 'sql15', fetch, shape, bucket: 'cached' });
  GRID.push({ source: 'raw', fetch: 'all', shape, agg: false }, { source: 'raw', fetch: 'iterate', shape, agg: false }, { source: 'sql15', fetch: 'all', shape, agg: false });
}
GRID.push({ source: 'raw-ordered', fetch: 'iterate', shape: 'obj', bucket: 'cached' });
const VARIANTS = GRID.map(makeVariant).filter((v) => HAS_ARRAYS || !v.needsArrays);

// Sliced + yielding: 7-day windows, one iterate() each, setImmediate between windows; aggregator state carries across.
async function slicedRun(s, { source, shape }) {
  const agg = new Aggregator(true); let n = 0;
  const slices = [];
  const step = 7 * DAY_MS;
  const base = s.from - (((s.from % step) + step) % step);
  const feed = shape === 'arr' ? feedArr : feedObj;
  for (let a = base; a < s.to; a += step) {
    const w = where({ ...s, from: Math.max(a, s.from), to: Math.min(a + step, s.to) });
    const st = stmtFor(source, shape, w.sql);
    const t0 = nowMs();
    for (const r of st.iterate(...w.params)) { feed(agg, r); n++; }
    slices.push(nowMs() - t0);
    await tick();
  }
  return { agg, n, slices };
}

// ---------- verify: all aggregating variants (and the sliced one) agree ----------
{
  let ok = true;
  for (const s of SCENARIOS) {
    let ref = null;
    const check = (label, agg) => {
      const d = agg.digest();
      if (ref === null) { ref = d; return; }
      const diff = firstDiff(ref, d);
      if (diff) { ok = false; console.log(`MISMATCH in "${s.name}" variant "${label}": ${diff}`); }
    };
    for (const v of VARIANTS) if (v.agg) check(v.name, v.run(s).agg);
    for (const source of ['raw', 'sql15']) check(`sliced ${source}`, (await slicedRun(s, { source, shape: 'obj' })).agg);
  }
  console.log(`verify (TZ=${process.env.TZ ?? 'system'}): ${ok ? 'all variants identical (raw vs 15-min SQL pre-aggregation vs sliced)' : 'MISMATCHES FOUND'}`);
  if (VERIFY_ONLY) { saveResult(`verify-${(process.env.TZ ?? 'system').replace(/\W/g, '_')}-${DATA}`, { ok }); db.close(); rmrf(dir); process.exit(ok ? 0 : 1); }
}

// ---------- measure ----------
const results = [];
for (const s of SCENARIOS) {
  for (const v of VARIANTS) {
    const times = [];
    let n = 0, heap = 0;
    for (let i = 0; i < RUNS + 1; i++) {
      gc();
      const h0 = process.memoryUsage().heapUsed;
      const t0 = nowMs();
      const out = v.run(s);
      const dt = nowMs() - t0;
      if (i === 0) n = out.n;
      heap = Math.max(heap, process.memoryUsage().heapUsed - h0);
      times.push(dt);
      await tick();
    }
    results.push({ scenario: s.name, variant: v.name, rowsIn: n, cold: times[0], warm: summarize(times.slice(1)), heapDeltaMB: heap / 2 ** 20 });
    process.stdout.write('.');
  }
  for (const source of ['raw', 'sql15']) {
    for (const shape of HAS_ARRAYS ? ['obj', 'arr'] : ['obj']) {
      const name = `${source} sliced 7d windows + yields ${shape}`;
      const totals = [], maxSlice = [], allSlices = [];
      let n = 0;
      for (let i = 0; i < RUNS + 1; i++) {
        gc();
        const t0 = nowMs();
        const out = await slicedRun(s, { source, shape });
        const dt = nowMs() - t0;
        if (i === 0) { n = out.n; continue; }
        totals.push(dt); maxSlice.push(Math.max(...out.slices)); allSlices.push(...out.slices);
      }
      results.push({ scenario: s.name, variant: name, rowsIn: n, cold: NaN, warm: summarize(totals), maxSlice: summarize(maxSlice), slices: summarize(allSlices), heapDeltaMB: NaN });
      process.stdout.write('.');
    }
  }
}
console.log('');

const rows = results.map((r) => [
  r.scenario, r.variant, r.rowsIn, fmt(r.cold), fmt(r.warm.p50), fmt(r.warm.p95), fmt(r.warm.max),
  r.maxSlice ? `slice p95 ${fmt(r.slices.p95)} / max ${fmt(r.slices.max)}` : '-', Number.isFinite(r.heapDeltaMB) ? fmt(r.heapDeltaMB, 1) : '-',
]);
const table = mdTable(['scenario', 'variant', 'rows from SQLite', 'cold ms (run 1)', 'p50 ms', 'p95 ms', 'max ms', 'event-loop block when sliced', 'heap growth during call MB (uncollected)'], rows);
console.log(table);
saveResult(`read-${DATA}${HAS_ARRAYS ? '' : '-noarrays'}`, { data: DATA, raw: RAW, rollups: ROLLUPS, runs: RUNS, hasReturnArrays: HAS_ARRAYS, results, table });
db.close();
rmrf(dir);

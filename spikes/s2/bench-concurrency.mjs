// S2.4: multi-process sanity check. N writer processes (same event ids, different order => real conflicts, like two
// VS Code windows ingesting the same logs) + one reader that polls PRAGMA data_version and re-reads 50k+ rows on every
// bump. Counts SQLITE_BUSY and measures how long a writer's batch blocks its own thread.
//
//   node --disable-warning=ExperimentalWarning spikes/s2/bench-concurrency.mjs [--runs 5] [--rows 60000]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { genEvents, bind, openDb, UPSERT_SQL } from './lib/data.mjs';
import { summarize, fmt, mdTable, scratchDir, rmrf, saveResult, sleep, median } from './lib/stats.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const RUNS = +arg('runs', 5);
const ROWS = +arg('rows', 60_000);
const child = path.join(path.dirname(fileURLToPath(import.meta.url)), 'concurrency-child.mjs');
const dir = scratchDir('concurrency');

const SCENARIOS = [
  { name: '1W+1R  busy=5000  BEGIN IMMEDIATE', writers: 1, busy: 5000, begin: 'immediate', retry: 0, preselect: 0 },
  { name: '1W+1R  busy=0     BEGIN IMMEDIATE', writers: 1, busy: 0, begin: 'immediate', retry: 0, preselect: 0 },
  { name: '2W+1R  busy=5000  BEGIN IMMEDIATE (sync wait in busy handler)', writers: 2, busy: 5000, begin: 'immediate', retry: 0, preselect: 0 },
  { name: '2W+1R  busy=250   BEGIN IMMEDIATE', writers: 2, busy: 250, begin: 'immediate', retry: 0, preselect: 0 },
  { name: '2W+1R  busy=0     BEGIN IMMEDIATE + async retry/backoff', writers: 2, busy: 0, begin: 'immediate', retry: 1, preselect: 0 },
  { name: '2W+1R  busy=0     BEGIN IMMEDIATE, no retry (batch dropped)', writers: 2, busy: 0, begin: 'immediate', retry: 0, preselect: 0 },
  { name: '2W+1R  busy=5000  deferred BEGIN + pre-SELECT then write', writers: 2, busy: 5000, begin: 'deferred', retry: 0, preselect: 1 },
  { name: '2W+1R  busy=5000  BEGIN IMMEDIATE + pre-SELECT then write', writers: 2, busy: 5000, begin: 'immediate', retry: 0, preselect: 1 },
];

function run(cmdArgs) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', child, ...cmdArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  const ready = new Promise((res) => { p.stdout.on('data', (d) => { buf += d; if (buf.includes('ready')) res(); }); });
  const done = new Promise((res, rej) => { p.on('exit', (c) => (c === 0 ? res(JSON.parse(buf.trim().split('\n').filter((l) => l.startsWith('{')).pop())) : rej(new Error(`child exit ${c}: ${buf}`)))); });
  return { ready, done };
}

async function oneRun(sc, runIdx) {
  const db = path.join(dir, `c-${runIdx}.sqlite`);
  const go = path.join(dir, `go-${runIdx}`), stop = path.join(dir, `stop-${runIdx}`);
  for (const f of [db, `${db}-wal`, `${db}-shm`, go, stop]) rmrf(f);
  const seed = openDb(DatabaseSync, db, 'wal');
  const st = seed.prepare(UPSERT_SQL);
  seed.exec('BEGIN IMMEDIATE');
  for (const r of genEvents(50_000, { seed: 32 })) bind(st, r);
  seed.exec('COMMIT');
  seed.close();
  const common = ['--db', db, '--busy', String(sc.busy), '--go', go, '--stop', stop];
  const writers = Array.from({ length: sc.writers }, (_, i) =>
    run(['--role', 'writer', '--idx', String(i), '--rows', String(ROWS), '--begin', sc.begin, '--retry', String(sc.retry), '--preselect', String(sc.preselect), ...common]));
  const reader = run(['--role', 'reader', ...common]);
  await Promise.all([reader.ready, ...writers.map((w) => w.ready)]);
  fs.writeFileSync(go, '1');
  const w = await Promise.all(writers.map((x) => x.done));
  fs.writeFileSync(stop, '1');
  const r = await reader.done;
  const check = new DatabaseSync(db);
  const rows = check.prepare('SELECT count(*) c FROM events').get().c;
  const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
  check.close();
  for (const f of [db, `${db}-wal`, `${db}-shm`, go, stop]) rmrf(f);
  return { w, r, rows, integrity };
}

const results = [];
for (const sc of SCENARIOS) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) { runs.push(await oneRun(sc, i)); process.stdout.write('.'); }
  const writers = runs.flatMap((x) => x.w);
  const sum = (f) => runs.reduce((a, x) => a + f(x), 0);
  const res = {
    scenario: sc.name,
    busyWriter: sum((x) => x.w.reduce((a, w) => a + w.busyCount, 0)),
    busyReader: sum((x) => x.r.busyCount),
    busyErrors: runs.flatMap((x) => [...x.w.map((w) => w.busyErrors), x.r.busyErrors]).reduce((a, e) => { for (const [k, v] of Object.entries(e)) a[k] = (a[k] ?? 0) + v; return a; }, {}),
    failedBatches: sum((x) => x.w.reduce((a, w) => a + w.failedBatches, 0)),
    attempt: summarize(writers.flatMap((w) => [w.attempt.p50, w.attempt.p95, w.attempt.max])), // coarse; see per-run below
    attemptP95: median(writers.map((w) => w.attempt.p95)), attemptMax: Math.max(...writers.map((w) => w.attempt.max)),
    batchP95: median(writers.map((w) => w.batch.p95)), batchMax: Math.max(...writers.map((w) => w.batch.max)),
    writerSecs: median(writers.map((w) => w.totalMs)) / 1000,
    readP50: median(runs.map((x) => x.r.read.p50)), readP95: median(runs.map((x) => x.r.read.p95)), readMax: Math.max(...runs.map((x) => x.r.read.max)),
    reads: median(runs.map((x) => x.r.reads)), bumps: median(runs.map((x) => x.r.bumps)),
    dvUsP50: median(runs.map((x) => x.r.dataVersionCallUs.p50)), dvUsMax: Math.max(...runs.map((x) => x.r.dataVersionCallUs.max)),
    walMB: Math.max(...writers.map((w) => w.walBytes)) / 2 ** 20,
    rowsFinal: runs.map((x) => x.rows), integrityOk: runs.every((x) => x.integrity === 'ok'), monotonic: runs.every((x) => x.r.monotonic),
    raw: runs,
  };
  results.push(res);
  console.log(`\n${sc.name}: BUSY writers ${res.busyWriter} readers ${res.busyReader}, failed batches ${res.failedBatches}, writer attempt p95/max ${fmt(res.attemptP95)}/${fmt(res.attemptMax)} ms`);
}
const table = mdTable(
  ['scenario (5 runs each)', 'BUSY seen by writers', 'BUSY seen by reader', 'batches dropped', 'writer sync block p95 / max ms', 'writer batch incl. waits p95 / max ms', 'reader 50k+ read p50 / p95 / max ms', 'data_version call us p50/max', 'reader saw bumps (median)', 'max WAL MB', 'integrity'],
  results.map((r) => [
    r.scenario, `${r.busyWriter}${Object.keys(r.busyErrors).length ? ` (${Object.entries(r.busyErrors).map(([k, v]) => `${k}x${v}`).join(', ')})` : ''}`, r.busyReader, r.failedBatches,
    `${fmt(r.attemptP95)} / ${fmt(r.attemptMax)}`, `${fmt(r.batchP95)} / ${fmt(r.batchMax)}`, `${fmt(r.readP50)} / ${fmt(r.readP95)} / ${fmt(r.readMax)}`,
    `${fmt(r.dvUsP50, 0)} / ${fmt(r.dvUsMax, 0)}`, r.bumps, fmt(r.walMB, 0), r.integrityOk ? 'ok' : 'FAIL',
  ]),
);
console.log(`\n${table}`);
saveResult('concurrency', { runs: RUNS, rows: ROWS, results: results.map(({ raw, attempt, ...x }) => x), table });
rmrf(dir);

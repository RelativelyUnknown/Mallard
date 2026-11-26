// S2.1c: cold-start probe. The first batches in a fresh process pay JIT + statement-prepare + first-file costs.
// Spawns N child processes; each opens a fresh WAL DB and inserts 4 batches of B rows, printing per-batch ms.
//
//   node --disable-warning=ExperimentalWarning spikes/s2/bench-cold.mjs [--procs 7] [--batch 2000]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { genEvents, bind, openDb, UPSERT_SQL } from './lib/data.mjs';
import { summarize, fmt, mdTable, scratchDir, rmrf, saveResult, nowMs } from './lib/stats.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};

if (process.argv.includes('--child')) {
  const B = +arg('batch', 2000);
  const dir = scratchDir('cold');
  const file = path.join(dir, `cold-${process.pid}.sqlite`);
  const events = genEvents(B * 4, { seed: 5 });
  const t00 = nowMs();
  const db = openDb(DatabaseSync, file, 'wal');
  const stmt = db.prepare(UPSERT_SQL);
  const openMs = nowMs() - t00;
  const out = [];
  for (let b = 0; b < 4; b++) {
    const t0 = nowMs();
    db.exec('BEGIN IMMEDIATE');
    for (let j = b * B; j < (b + 1) * B; j++) bind(stmt, events[j]);
    db.exec('COMMIT');
    out.push(nowMs() - t0);
  }
  db.close();
  for (const s of ['', '-wal', '-shm']) rmrf(file + s);
  console.log(JSON.stringify({ openMs, out }));
  process.exit(0);
}

const PROCS = +arg('procs', 7);
const B = +arg('batch', 2000);
const me = fileURLToPath(import.meta.url);
const samples = [];
for (let i = 0; i < PROCS; i++) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', me, '--child', '--batch', String(B)], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  samples.push(JSON.parse(r.stdout.trim().split('\n').pop()));
}
const col = (k) => summarize(samples.map((s) => s.out[k]));
const table = mdTable(
  ['batch #', 'p50 ms', 'p95 ms', 'max ms (n=' + PROCS + ' fresh processes)'],
  [0, 1, 2, 3].map((k) => [`${k + 1}${k === 0 ? ' (cold)' : ''}`, fmt(col(k).p50), fmt(col(k).p95), fmt(col(k).max)]),
);
console.log(`batch=${B} rows; open+prepare p50 ${fmt(summarize(samples.map((s) => s.openMs)).p50)} ms`);
console.log(table);
saveResult('cold', { batch: B, procs: PROCS, samples, table });

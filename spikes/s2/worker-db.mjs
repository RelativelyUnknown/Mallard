// worker_thread prototype: node:sqlite lives entirely inside the worker; the main thread only posts messages.
//   {type:'snapshot', id, source:'raw'|'sql15', from, to}  -> {id, result: <aggregator digest>, ms}
//   {type:'rows', id, from, to}                             -> {id, rows: [[...14 cols]...]}   (anti-pattern: returns raw rows)
//   {type:'insert', id, rows}                               -> {id, fresh: [ids], ms}           (DO NOTHING + changes + guarded UPDATE)
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { applyMode, COLS } from './lib/data.mjs';
import { Aggregator, BUCKET_MS } from './lib/aggregate.mjs';

const t0 = performance.now();
const db = new DatabaseSync(workerData.db);
applyMode(db, 'wal', 5000);

const COLS14 = 'ts, modelId, surface, source, repo, branch, attribution, language, requests, promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens, thinkingTokens';
const rawStmt = db.prepare(`SELECT ${COLS14} FROM events WHERE ts >= ? AND ts < ?`);
const sql15Stmt = db.prepare(`SELECT (ts / ${BUCKET_MS}) * ${BUCKET_MS} AS ts, modelId, surface, source, repo, branch, attribution, language,
  sum(requests) AS requests, sum(promptTokens) AS promptTokens, sum(completionTokens) AS completionTokens,
  sum(cacheReadTokens) AS cacheReadTokens, sum(cacheCreationTokens) AS cacheCreationTokens, sum(thinkingTokens) AS thinkingTokens
  FROM events WHERE ts >= ? AND ts < ? GROUP BY ts / ${BUCKET_MS}, modelId, surface, source, repo, branch, attribution, language`);
const rowsStmt = db.prepare(`SELECT ${COLS14} FROM events WHERE ts >= ? AND ts < ?`);
if (typeof rowsStmt.setReturnArrays === 'function') rowsStmt.setReturnArrays(true);
const insIgnore = db.prepare(`INSERT INTO events (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')}) ON CONFLICT(id) DO NOTHING`);
const bumpG = db.prepare('UPDATE events SET promptTokens = ? WHERE id = ? AND coalesce(?,0) > coalesce(promptTokens,0)');

parentPort.postMessage({ type: 'ready', startMs: performance.now() - t0 });

parentPort.on('message', (m) => {
  const s0 = performance.now();
  if (m.type === 'snapshot') {
    const agg = new Aggregator(true);
    for (const r of (m.source === 'raw' ? rawStmt : sql15Stmt).iterate(m.from, m.to)) {
      agg.add(r.ts, r.modelId, r.surface, r.source, r.repo, r.branch, r.attribution, r.language, r.requests, r.promptTokens, r.completionTokens, r.cacheReadTokens, r.cacheCreationTokens, r.thinkingTokens);
    }
    const d = agg.digest();
    parentPort.postMessage({ type: 'snapshot', id: m.id, result: d, ms: performance.now() - s0 });
  } else if (m.type === 'rows') {
    const rows = rowsStmt.all(m.from, m.to);
    parentPort.postMessage({ type: 'rows', id: m.id, rows, ms: performance.now() - s0 });
  } else if (m.type === 'insert') {
    const fresh = [];
    db.exec('BEGIN IMMEDIATE');
    for (const r of m.rows) {
      if (insIgnore.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14]).changes === 1) fresh.push(r[0]);
      else bumpG.run(r[10], r[0], r[10]);
    }
    db.exec('COMMIT');
    parentPort.postMessage({ type: 'insert', id: m.id, fresh, ms: performance.now() - s0 });
  } else if (m.type === 'close') {
    db.close();
    process.exit(0);
  }
});

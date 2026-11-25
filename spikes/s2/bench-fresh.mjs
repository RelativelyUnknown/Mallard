// S2.1b: cheapest *correct* way to learn which rows of a batch were freshly inserted (the export stream needs them).
//
// Strategies (all must keep the "max(promptTokens)" upsert semantics unless noted):
//   F0  upsert, no detection                        (baseline: the floor we cannot beat)
//   F1  SELECT id WHERE id IN (...5000) + upsert    (the current writer's pattern)
//   F2  upsert, per-row run().lastInsertRowid       (cheap; correctness depends on connection state, see README)
//   F3  upsert ... RETURNING rowid via get()        (fresh iff rowid > max(rowid) captured at txn start, first sighting)
//   F4  INSERT .. ON CONFLICT DO NOTHING + changes, then UPDATE for the conflicting rows (max semantics kept)
//   F5  INSERT .. ON CONFLICT DO NOTHING RETURNING id via get(), then UPDATE for conflicts
//   F6  INSERT OR IGNORE + changes                  (legacy semantics: NO max() update; shown for reference only)
//   F8  multi-row VALUES upsert ... RETURNING id,rowid via all()  (one native call per ~1000 rows)
//   F0g/F2g/F4g  = F0/F2/F4 with a *guarded* update: only write when the incoming token count is higher
//                  (`... DO UPDATE SET promptTokens = excluded.promptTokens WHERE coalesce(excluded.promptTokens,0) > coalesce(promptTokens,0)`)
// Scenarios: fresh (all new ids + 2% in-batch duplicates), mixed (50% already stored, half higher/half lower), reingest (100% identical, already stored).
//
//   node --disable-warning=ExperimentalWarning spikes/s2/bench-fresh.mjs [--runs 5] [--batches 2000,5000]
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { genEvents, bind, openDb, COLS, UPSERT_SQL, mulberry32 } from './lib/data.mjs';
import { summarize, fmt, mdTable, scratchDir, rmrf, saveResult, tick, nowMs, median } from './lib/stats.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const RUNS = +arg('runs', 5);
const BATCHES = arg('batches', '2000,5000').split(',').map(Number);
const BASE = +arg('base', 100_000);
const NEW = +arg('new', 40_000);
const only = arg('only', '');
const EXTRA_PRAGMA = arg('pragma', ''); // e.g. --pragma "PRAGMA cache_size=-65536;"
const SCEN = arg('scenarios', 'fresh,mixed,reingest').split(',');
const TAG = arg('tag', '');

const dir = scratchDir('fresh');

// ---------- data ----------
const baseRows = genEvents(BASE, { seed: 11 });
function withInBatchDups(rows, r) {
  // ~2% of rows are immediately followed by a "streamed partial" duplicate with higher promptTokens (same id)
  const out = [];
  for (const row of rows) {
    out.push(row);
    if (r() < 0.02) out.push([...row.slice(0, 10), row[10] + 1 + Math.floor(r() * 500), ...row.slice(11)]);
  }
  return out;
}
function buildScenario(kind) {
  const r = mulberry32(99);
  const fresh = genEvents(NEW, { seed: 12 });
  if (kind === 'fresh') return withInBatchDups(fresh, r);
  if (kind === 'reingest') return baseRows.slice(0, NEW).map((x) => [...x]); // identical rows, all already stored
  // mixed: ~50% already-existing ids (half with higher tokens, half lower), 50% new
  const out = [];
  for (let i = 0; i < NEW; i++) {
    if (r() < 0.5) {
      const old = baseRows[Math.floor(r() * baseRows.length)];
      const delta = r() < 0.5 ? 1 + Math.floor(r() * 300) : -Math.floor(r() * old[10] * 0.5);
      out.push([...old.slice(0, 10), old[10] + delta, ...old.slice(11)]);
    } else out.push(fresh[i]);
  }
  return withInBatchDups(out, r);
}

// ---------- template db ----------
const tmpl = path.join(dir, 'template.sqlite');
{
  rmrf(tmpl);
  const db = openDb(DatabaseSync, tmpl, 'wal');
  const st = db.prepare(UPSERT_SQL);
  for (let i = 0; i < baseRows.length; i += 5000) {
    db.exec('BEGIN IMMEDIATE');
    for (let j = i; j < Math.min(baseRows.length, i + 5000); j++) bind(st, baseRows[j]);
    db.exec('COMMIT');
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

// ---------- strategies ----------
const rowsPlaceholder = (n) => Array.from({ length: n }, () => `(${COLS.map(() => '?').join(',')})`).join(',');
const INS_COLS = `INSERT INTO events (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`;
const UPSERT_TAIL = 'ON CONFLICT(id) DO UPDATE SET promptTokens = max(promptTokens, excluded.promptTokens)';
const UPSERT_G_TAIL = 'ON CONFLICT(id) DO UPDATE SET promptTokens = excluded.promptTokens WHERE coalesce(excluded.promptTokens,0) > coalesce(promptTokens,0)';

function makeStrategies(db) {
  const maxRowid = db.prepare('SELECT coalesce(max(rowid),0) m FROM events');
  const upsert = db.prepare(UPSERT_SQL);
  const upsertG = db.prepare(`${INS_COLS} ${UPSERT_G_TAIL}`);
  const bumpG = db.prepare('UPDATE events SET promptTokens = ? WHERE id = ? AND coalesce(?,0) > coalesce(promptTokens,0)');
  const selCache = new Map();
  const selStmt = (n) => {
    let s = selCache.get(n);
    if (!s) {
      s = db.prepare(`SELECT id FROM events WHERE id IN (${Array(n).fill('?').join(',')})`);
      s.setReturnArrays(true);
      selCache.set(n, s);
    }
    return s;
  };
  const upsertRet = db.prepare(`${INS_COLS} ${UPSERT_TAIL} RETURNING rowid`);
  upsertRet.setReturnArrays(true);
  const insIgnore = db.prepare(`${INS_COLS} ON CONFLICT(id) DO NOTHING`);
  const insIgnoreRet = db.prepare(`${INS_COLS} ON CONFLICT(id) DO NOTHING RETURNING id`);
  insIgnoreRet.setReturnArrays(true);
  const orIgnore = db.prepare(INS_COLS.replace('INSERT INTO', 'INSERT OR IGNORE INTO'));
  const bumpTokens = db.prepare('UPDATE events SET promptTokens = max(promptTokens, ?) WHERE id = ?');
  const multiCache = new Map();
  const multi = (n) => {
    let s = multiCache.get(n);
    if (!s) {
      s = db.prepare(`INSERT INTO events (${COLS.join(',')}) VALUES ${rowsPlaceholder(n)} ${UPSERT_TAIL} RETURNING id, rowid`);
      s.setReturnArrays(true);
      multiCache.set(n, s);
    }
    return s;
  };

  return {
    'F0 upsert, no detection': (rows) => {
      for (const r of rows) bind(upsert, r);
      return null;
    },
    'F0g guarded upsert, no detection': (rows) => {
      for (const r of rows) bind(upsertG, r);
      return null;
    },
    'F1 pre-SELECT IN(5000) + upsert': (rows) => {
      const seen = new Set();
      const unique = [];
      for (const r of rows) if (!seen.has(r[0])) { seen.add(r[0]); unique.push(r); }
      const existing = new Set();
      for (let i = 0; i < unique.length; i += 5000) {
        const chunk = unique.slice(i, i + 5000);
        for (const [id] of selStmt(chunk.length).all(...chunk.map((e) => e[0]))) existing.add(id);
      }
      for (const r of rows) bind(upsert, r);
      return unique.filter((r) => !existing.has(r[0]));
    },
    'F2 upsert + run().lastInsertRowid': (rows) => {
      let last = maxRowid.get().m;
      const fresh = [];
      for (const r of rows) {
        const rid = Number(bind(upsert, r).lastInsertRowid);
        if (rid > last) { last = rid; fresh.push(r); }
      }
      return fresh;
    },
    'F2g guarded upsert + run().lastInsertRowid': (rows) => {
      let last = maxRowid.get().m;
      const fresh = [];
      for (const r of rows) {
        const rid = Number(bind(upsertG, r).lastInsertRowid);
        if (rid > last) { last = rid; fresh.push(r); }
      }
      return fresh;
    },
    'F3 upsert RETURNING rowid (get)': (rows) => {
      let last = maxRowid.get().m;
      const fresh = [];
      for (const r of rows) {
        const got = upsertRet.get(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14]);
        const rid = got[0];
        if (rid > last) { last = rid; fresh.push(r); }
      }
      return fresh;
    },
    'F4 DO NOTHING + changes, UPDATE on conflict': (rows) => {
      const fresh = [];
      for (const r of rows) {
        if (bind(insIgnore, r).changes === 1) fresh.push(r);
        else bumpTokens.run(r[10], r[0]);
      }
      return fresh;
    },
    'F4g DO NOTHING + changes, guarded UPDATE on conflict': (rows) => {
      const fresh = [];
      for (const r of rows) {
        if (bind(insIgnore, r).changes === 1) fresh.push(r);
        else bumpG.run(r[10], r[0], r[10]);
      }
      return fresh;
    },
    'F5 DO NOTHING RETURNING id (get), UPDATE on conflict': (rows) => {
      const fresh = [];
      for (const r of rows) {
        const got = insIgnoreRet.get(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10], r[11], r[12], r[13], r[14]);
        if (got !== undefined) fresh.push(r);
        else bumpTokens.run(r[10], r[0]);
      }
      return fresh;
    },
    'F6 INSERT OR IGNORE + changes (no max upsert)': (rows) => {
      const fresh = [];
      for (const r of rows) if (bind(orIgnore, r).changes === 1) fresh.push(r);
      return fresh;
    },
    'F8 multi-row upsert RETURNING id,rowid (all)': (rows) => {
      const base = maxRowid.get().m;
      const byRowid = new Map();
      const CH = 1000; // 15k params < 32766
      for (let i = 0; i < rows.length; i += CH) {
        const chunk = rows.slice(i, i + CH);
        const params = [];
        for (const r of chunk) for (let c = 0; c < 15; c++) params.push(r[c]);
        const out = multi(chunk.length).all(...params);
        for (let k = 0; k < out.length; k++) {
          const [, rid] = out[k];
          if (rid > base && !byRowid.has(rid)) byRowid.set(rid, chunk[k]); // first sighting wins
        }
      }
      return [...byRowid.values()];
    },
  };
}

// ---------- harness ----------
function checksum(db) {
  const r = db.prepare('SELECT count(*) c, sum(promptTokens) s, sum(ts % 1000003) t FROM events').get();
  return `${r.c}/${r.s}/${r.t}`;
}

const results = [];
for (const kind of SCEN) {
  const scenario = buildScenario(kind);
  // ground truth per batch size computed with plain JS sets (independent of SQL)
  const knownBase = new Set(baseRows.map((r) => r[0]));
  let refChecksum = null;
  for (const batchSize of BATCHES) {
    const truth = [];
    {
      const known = new Set(knownBase);
      for (let i = 0; i < scenario.length; i += batchSize) {
        const ids = new Set();
        for (const r of scenario.slice(i, i + batchSize)) if (!known.has(r[0])) ids.add(r[0]);
        for (const id of ids) known.add(id);
        truth.push(ids);
      }
    }
    const names = Object.keys(makeStrategies(openDb(DatabaseSync, ':memory:', 'default')));
    for (const name of names) {
      if (only && !name.startsWith(only)) continue;
      const runs = [];
      let correct = true;
      let cs = '';
      for (let run = 0; run < RUNS; run++) {
        const file = path.join(dir, `run.sqlite`);
        rmrf(file); rmrf(`${file}-wal`); rmrf(`${file}-shm`);
        fs.copyFileSync(tmpl, file);
        const db = new DatabaseSync(file);
        db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; ${EXTRA_PRAGMA}`);
        const strat = makeStrategies(db)[name];
        const batchMs = [];
        let bi = 0;
        for (let i = 0; i < scenario.length; i += batchSize, bi++) {
          const rows = scenario.slice(i, i + batchSize);
          const t0 = nowMs();
          db.exec('BEGIN IMMEDIATE');
          const fresh = strat(rows);
          db.exec('COMMIT');
          batchMs.push(nowMs() - t0);
          if (fresh) {
            const got = new Set(fresh.map((r) => r[0]));
            const want = truth[bi];
            if (got.size !== fresh.length || got.size !== want.size || [...want].some((id) => !got.has(id))) correct = false;
          }
          await tick();
        }
        cs = checksum(db);
        db.close();
        runs.push(batchMs);
      }
      if (!name.startsWith('F6') && name.startsWith('F0')) refChecksum ??= cs;
      const pooled = summarize(runs.flat());
      const perBatchRows = batchSize;
      const row = {
        scenario: kind, batchSize, strategy: name, correct: name.startsWith('F0') ? null : correct,
        stateMatchesUpsert: refChecksum === null ? null : cs === refChecksum,
        batch: pooled, rowsPerSec: perBatchRows / (median(runs.flat()) / 1000),
      };
      results.push(row);
      console.log(`${kind} b=${batchSize} ${name}: p50 ${fmt(pooled.p50)} p95 ${fmt(pooled.p95)} max ${fmt(pooled.max)} ms correct=${row.correct} state=${row.stateMatchesUpsert}`);
    }
  }
}

const table = mdTable(
  ['scenario', 'batch', 'strategy', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', 'fresh set correct', 'table state = F0'],
  results.map((r) => [
    r.scenario, r.batchSize, r.strategy, fmt(r.batch.p50), fmt(r.batch.p95), fmt(r.batch.p99), fmt(r.batch.max),
    r.correct === null ? '-' : r.correct ? 'yes' : 'NO', r.stateMatchesUpsert === null ? '-' : r.stateMatchesUpsert ? 'yes' : 'no',
  ]),
);
console.log(`\n${table}`);
saveResult(`fresh${TAG}`, { extraPragma: EXTRA_PRAGMA, runs: RUNS, base: BASE, new: NEW, results, table });
rmrf(dir);

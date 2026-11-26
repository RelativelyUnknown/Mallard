'use strict';
// S1 items 1, 3, 7: single-process node:sqlite behaviour. Runs identically in plain Node and in the
// VS Code extension host (the caller passes `sqlite` = require('node:sqlite') and a scratch `dir`).
const fs = require('node:fs');
const path = require('node:path');

/** @returns {{id:string,item:string,pass:boolean,evidence:any}[]} */
function runSqliteChecks({ sqlite, dir }) {
  const { DatabaseSync } = sqlite;
  const results = [];
  const check = (id, item, fn) => {
    try {
      const evidence = fn();
      results.push({ id, item, pass: true, evidence: evidence === undefined ? null : evidence });
    } catch (e) {
      results.push({ id, item, pass: false, evidence: `${e && e.code ? e.code + ': ' : ''}${e && e.message}` });
    }
  };
  const must = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };
  fs.mkdirSync(dir, { recursive: true });

  // ---- item 1: open in a globalStorage-like dir, WAL + busy_timeout + synchronous via exec ----
  const dbPath = path.join(dir, 'events.sqlite');
  const db = new DatabaseSync(dbPath);
  check('1a', 'new DatabaseSync(path) in globalStorage-like dir', () => {
    must(fs.existsSync(dbPath), 'db file not created on open');
    return { dbPath, existsAfterOpen: true };
  });
  check('1b', 'exec PRAGMA journal_mode=WAL (+ read back)', () => {
    db.exec('PRAGMA journal_mode=WAL');
    const jm = db.prepare('PRAGMA journal_mode').get().journal_mode;
    must(jm === 'wal', 'journal_mode=' + jm);
    return jm;
  });
  check('1c', 'exec PRAGMA busy_timeout=5000 (+ read back)', () => {
    db.exec('PRAGMA busy_timeout=5000');
    const v = db.prepare('PRAGMA busy_timeout').get().timeout;
    must(v === 5000, 'busy_timeout=' + v);
    return v;
  });
  check('1d', 'exec PRAGMA synchronous=NORMAL (+ read back = 1)', () => {
    db.exec('PRAGMA synchronous=NORMAL');
    const v = db.prepare('PRAGMA synchronous').get().synchronous;
    must(v === 1, 'synchronous=' + v);
    return v;
  });
  check('1e', 'WAL file artefacts appear next to the db after a write', () => {
    db.exec('CREATE TABLE IF NOT EXISTS probe(id INTEGER PRIMARY KEY, v)');
    db.prepare('INSERT INTO probe(v) VALUES (?)').run('x');
    return fs.readdirSync(dir).filter((f) => f.startsWith('events.sqlite')).sort();
  });

  // ---- item 3: SQL features ----
  db.exec(`CREATE TABLE ev(
    id TEXT PRIMARY KEY, ts INTEGER NOT NULL, model TEXT, repo TEXT,
    prompt INTEGER, completion INTEGER, attrs TEXT)`);
  check('3a', 'ON CONFLICT(id) DO UPDATE SET a = max(a, excluded.a)', () => {
    const ins = db.prepare(
      `INSERT INTO ev(id, ts, model, prompt, completion) VALUES (?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET prompt = max(prompt, excluded.prompt), completion = max(completion, excluded.completion)`,
    );
    ins.run('m1', 1_700_000_000_000, 'claude', 10, 5);
    ins.run('m1', 1_700_000_000_000, 'claude', 7, 20); // prompt stays 10, completion -> 20
    ins.run('m1', 1_700_000_000_000, 'claude', 12, 1); // prompt -> 12, completion stays 20
    const row = db.prepare('SELECT prompt, completion FROM ev WHERE id=?').get('m1');
    must(row.prompt === 12 && row.completion === 20, JSON.stringify(row));
    return row;
  });
  check('3a2', 'ON CONFLICT upsert with NULL prior value: max(NULL, x) semantics', () => {
    db.exec(`INSERT INTO ev(id, ts, model, prompt) VALUES ('m2', 1, 'x', NULL)`);
    db.exec(`INSERT INTO ev(id, ts, model, prompt) VALUES ('m2', 1, 'x', 9)
             ON CONFLICT(id) DO UPDATE SET prompt = max(prompt, excluded.prompt)`);
    const r = db.prepare("SELECT prompt FROM ev WHERE id='m2'").get().prompt;
    // SQLite scalar max() returns NULL if ANY argument is NULL -> a COALESCE is required.
    db.exec(`INSERT INTO ev(id, ts, model, prompt) VALUES ('m2', 1, 'x', 9)
             ON CONFLICT(id) DO UPDATE SET prompt = max(coalesce(prompt,0), excluded.prompt)`);
    const r2 = db.prepare("SELECT prompt FROM ev WHERE id='m2'").get().prompt;
    return { withoutCoalesce: r, withCoalesce: r2, note: 'scalar max() with a NULL arg yields NULL' };
  });
  check('3b', 'json_extract / ->> / json_each', () => {
    db.prepare('UPDATE ev SET attrs=? WHERE id=?').run(JSON.stringify({ gen_ai: { usage: { input_tokens: 42 } }, tags: ['a', 'b'] }), 'm1');
    const a = db.prepare("SELECT json_extract(attrs,'$.gen_ai.usage.input_tokens') AS n FROM ev WHERE id='m1'").get().n;
    let arrow = 'unsupported';
    try {
      arrow = db.prepare("SELECT attrs->>'$.gen_ai.usage.input_tokens' AS n FROM ev WHERE id='m1'").get().n;
    } catch (e) {
      arrow = 'ERR ' + e.message;
    }
    const tags = db.prepare("SELECT value FROM ev, json_each(ev.attrs,'$.tags') WHERE ev.id='m1'").all().map((r) => r.value);
    must(a === 42, 'json_extract=' + a);
    return { json_extract: a, arrow, json_each: tags };
  });
  check('3c', "strftime / date(...,'localtime') / unixepoch()", () => {
    const r = db.prepare(
      `SELECT strftime('%Y-%m-%d %H', ts/1000, 'unixepoch') AS utcHour,
              strftime('%w', ts/1000, 'unixepoch') AS dow,
              date(ts/1000, 'unixepoch', 'localtime') AS localDay,
              strftime('%s','2023-11-14 22:13:20') AS epochS
         FROM ev WHERE id='m1'`,
    ).get();
    must(r.utcHour === '2023-11-14 22', JSON.stringify(r));
    let unix = 'n/a';
    try {
      unix = db.prepare('SELECT unixepoch(1700000000, "unixepoch") AS u').get();
    } catch (_) {
      try {
        unix = db.prepare("SELECT unixepoch('2023-11-14 22:13:20') AS u").get().u;
      } catch (e) {
        unix = 'ERR ' + e.message;
      }
    }
    return { ...r, unixepoch: unix };
  });
  check('3d', 'BEGIN IMMEDIATE / COMMIT / ROLLBACK via exec; isTransaction where available', () => {
    db.exec('BEGIN IMMEDIATE');
    const during = db.isTransaction; // undefined on < 22.16
    db.prepare("INSERT INTO ev(id, ts, model) VALUES ('tx1', 1, 'x')").run();
    db.exec('ROLLBACK');
    const gone = db.prepare("SELECT count(*) AS n FROM ev WHERE id='tx1'").get().n;
    db.exec('BEGIN IMMEDIATE');
    db.prepare("INSERT INTO ev(id, ts, model) VALUES ('tx2', 1, 'x')").run();
    db.exec('COMMIT');
    const kept = db.prepare("SELECT count(*) AS n FROM ev WHERE id='tx2'").get().n;
    must(gone === 0 && kept === 1, `gone=${gone} kept=${kept}`);
    return { isTransactionDuringTx: during, rolledBackRows: gone, committedRows: kept };
  });
  check('3e', 'PRAGMA data_version readable (integer, stable without foreign commits)', () => {
    const a = db.prepare('PRAGMA data_version').get();
    const b = db.prepare('PRAGMA data_version').get();
    must(typeof a.data_version === 'number', JSON.stringify(a));
    return { first: a.data_version, second: b.data_version, note: 'own-connection commits do NOT change data_version; see two-process test' };
  });
  check('3f', 'INSERT ... RETURNING (run() vs get()/all())', () => {
    const r = db.prepare("INSERT INTO ev(id, ts, model) VALUES ('ret1', 5, 'x') RETURNING id, ts").get();
    must(r && r.id === 'ret1' && r.ts === 5, JSON.stringify(r));
    const all = db.prepare("INSERT INTO ev(id, ts, model) VALUES ('ret2', 6, 'x'), ('ret3', 7, 'y') RETURNING id").all();
    must(all.length === 2, JSON.stringify(all));
    return { single: r, multi: all.map((x) => x.id) };
  });
  check('3g', 'window functions (SUM OVER, row_number, lag)', () => {
    db.exec(`CREATE TABLE w(day TEXT, model TEXT, credits REAL);
             INSERT INTO w VALUES ('d1','a',1),('d2','a',2),('d3','a',3),('d1','b',10),('d2','b',20)`);
    const rows = db.prepare(
      `SELECT day, model, credits,
              SUM(credits) OVER (PARTITION BY model ORDER BY day) AS running,
              row_number() OVER (PARTITION BY model ORDER BY credits DESC) AS rk,
              lag(credits) OVER (PARTITION BY model ORDER BY day) AS prev
         FROM w ORDER BY model, day`,
    ).all();
    const a3 = rows.find((r) => r.model === 'a' && r.day === 'd3');
    must(a3.running === 6 && a3.rk === 1 && a3.prev === 2, JSON.stringify(a3));
    return { sample: a3, rows: rows.length };
  });
  check('3h', 'sqlite_version() and compile options', () => {
    const v = db.prepare('select sqlite_version() as v').get().v;
    const opts = db.prepare('PRAGMA compile_options').all().map((r) => r.compile_options);
    return {
      sqlite_version: v,
      threadsafe: opts.filter((o) => o.startsWith('THREADSAFE')),
      json: opts.filter((o) => /JSON/i.test(o)),
      fts: opts.filter((o) => /FTS/i.test(o)),
      count: opts.length,
    };
  });
  check('3i', 'statement caching: prepare once, run many (perf smoke: 20k rows in one tx)', () => {
    db.exec('CREATE TABLE bulk(id INTEGER PRIMARY KEY, ts INTEGER, tokens INTEGER)');
    const ins = db.prepare('INSERT INTO bulk(ts, tokens) VALUES (?, ?)');
    const t0 = process.hrtime.bigint();
    db.exec('BEGIN IMMEDIATE');
    for (let i = 0; i < 20000; i++) ins.run(1_700_000_000_000 + i, i);
    db.exec('COMMIT');
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const n = db.prepare('SELECT count(*) AS n FROM bulk').get().n;
    must(n === 20000, 'n=' + n);
    return { rows: n, insertMs: Math.round(ms) };
  });

  // ---- item 7: integer handling ----
  check('7a', 'INTEGER > 2^31 (token counts, epoch ms) round-trips as JS number by default', () => {
    db.exec('CREATE TABLE ints(k TEXT PRIMARY KEY, v INTEGER)');
    const ins = db.prepare('INSERT INTO ints VALUES (?, ?)');
    ins.run('tokens_3e9', 3_000_000_000);
    ins.run('epoch_ms', 1_763_000_000_000);
    ins.run('2pow40', 2 ** 40);
    ins.run('maxsafe', Number.MAX_SAFE_INTEGER);
    const get = (k) => db.prepare('SELECT v, typeof(v) AS t FROM ints WHERE k=?').get(k);
    const out = { tokens_3e9: get('tokens_3e9'), epoch_ms: get('epoch_ms'), pow40: get('2pow40'), maxsafe: get('maxsafe') };
    must(out.tokens_3e9.v === 3_000_000_000 && typeof out.tokens_3e9.v === 'number', JSON.stringify(out));
    must(out.epoch_ms.v === 1_763_000_000_000, JSON.stringify(out));
    must(out.maxsafe.v === Number.MAX_SAFE_INTEGER, JSON.stringify(out));
    return { ...out, jsTypeofTokens: typeof out.tokens_3e9.v };
  });
  check('7b', 'how JS numbers bind: typeof(?) for integer-valued Number, fractional, BigInt', () => {
    const q = (x) => db.prepare('SELECT typeof(?) AS t').get(x).t;
    return { int5: q(5), big3e9: q(3_000_000_000), frac: q(1.5), bigint: q(5n), string: q('a'), nul: q(null) };
  });
  check('7c', 'INTEGER above 2^53 read with default settings', () => {
    db.prepare('INSERT INTO ints VALUES (?, ?)').run('2pow53p1', 9007199254740993n);
    db.prepare('INSERT INTO ints VALUES (?, ?)').run('maxint64', 9223372036854775807n);
    const r = {};
    for (const k of ['2pow53p1', 'maxint64']) {
      try {
        const row = db.prepare('SELECT v FROM ints WHERE k=?').get(k);
        r[k] = { read: String(row.v), type: typeof row.v };
      } catch (e) {
        r[k] = { threw: `${e.code || ''}: ${e.message}` };
      }
    }
    return r; // informational: records whether it throws or silently loses precision
  });
  check('7d', 'INTEGER above 2^53 with setReadBigInts(true) is exact', () => {
    const s = db.prepare('SELECT v FROM ints WHERE k=?');
    s.setReadBigInts(true);
    const v = s.get('maxint64').v;
    must(typeof v === 'bigint' && v === 9223372036854775807n, String(v));
    return { value: String(v), type: typeof v };
  });
  check('7e', 'aggregates: sum() of INTEGER stays exact; sum overflow of int64; total() is float', () => {
    const s = db.prepare('SELECT sum(v) AS s, total(v) AS t FROM ints WHERE k IN (?,?)').get('tokens_3e9', 'epoch_ms');
    let overflow;
    try {
      db.prepare('SELECT sum(v) AS s FROM ints WHERE k IN (?,?)').get('maxint64', 'maxsafe');
      overflow = 'no throw';
    } catch (e) {
      overflow = `${e.code || ''}: ${e.message}`;
    }
    return { sumTypeof: typeof s.s, sum: s.s, total: s.t, sumOverflow: overflow };
  });
  check('7f', 'JS Number > 2^53 binds as REAL, INTEGER affinity converts it, reading it back then throws', () => {
    const v = 2 ** 60 + 1; // not representable exactly
    db.prepare('INSERT INTO ints VALUES (?, ?)').run('float60', v);
    const s = db.prepare('SELECT v, typeof(v) AS t FROM ints WHERE k=?');
    s.setReadBigInts(true);
    const row = s.get('float60');
    let defaultRead;
    try {
      db.prepare('SELECT v FROM ints WHERE k=?').get('float60');
      defaultRead = 'no throw';
    } catch (e) {
      defaultRead = `${e.code || ''}: ${e.message}`;
    }
    return { storedAsBigInt: String(row.v), sqliteType: row.t, defaultRead };
  });
  check('7g', 'GOTCHA: bound JS integers are REAL, so `x / ?` is float division and `x % ?` is float modulo', () => {
    const q = db.prepare('SELECT 7 / ? AS div, 7 % ? AS mod, 7 / CAST(? AS INTEGER) AS divCast, 7 / ? AS divBig').get(2, 2, 2, 2n);
    must(q.div === 3.5, 'expected float division, got ' + q.div);
    return q;
  });
  check('7h', 'GOTCHA: BigInt params above int64 throw; Number NaN/Infinity bind as NULL/real', () => {
    let big;
    try {
      db.prepare('SELECT ? AS v').get(2n ** 64n);
      big = 'no throw';
    } catch (e) {
      big = `${e.code || ''}: ${e.message}`;
    }
    const nan = db.prepare('SELECT typeof(?) AS t, ? AS v').get(NaN, NaN);
    return { bigintOverInt64: big, nan };
  });
  check('3a3', 'null-safe upsert: coalesce(max(a, excluded.a), a, excluded.a)', () => {
    const up = (id, v) =>
      db.prepare(`INSERT INTO ev(id, ts, model, prompt) VALUES (?, 1, 'x', ?)
        ON CONFLICT(id) DO UPDATE SET prompt = coalesce(max(prompt, excluded.prompt), prompt, excluded.prompt)`).run(id, v);
    up('n1', null);
    up('n1', 5);
    up('n1', null);
    up('n1', 3);
    const r = db.prepare("SELECT prompt FROM ev WHERE id='n1'").get().prompt;
    must(r === 5, 'prompt=' + r);
    return { prompt: r };
  });

  check('1z', 'close() then isOpen / use-after-close error', () => {
    db.close();
    const open = db.isOpen;
    let err = null;
    try {
      db.exec('select 1');
    } catch (e) {
      err = `${e.code || ''}: ${e.message}`;
    }
    return { isOpenAfterClose: open, useAfterCloseError: err };
  });
  return results;
}

module.exports = { runSqliteChecks };

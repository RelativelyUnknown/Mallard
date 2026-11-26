'use strict';
// S1 item 5: read-only open of a WAL-mode SQLite database that another process currently has open for
// writing (mimics Copilot's OTel span DB being live). Reader = this process; writer = spawned child
// (same runtime). A real read-only filesystem view is made with `mount --bind` + `remount,ro,bind`
// (needs root + CAP_SYS_ADMIN; scenarios that need it are reported SKIPPED when mount is refused).
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { spawnWorker } = require('./spawnWorker.cjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ls = (d) => fs.readdirSync(d).sort();

function tryMountRo(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  try {
    execFileSync('mount', ['--bind', src, dst], { stdio: 'pipe' });
    execFileSync('mount', ['-o', 'remount,ro,bind', dst], { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    umount(dst);
    return { ok: false, error: String(e.stderr || e.message).trim() };
  }
}
function umount(dst) {
  for (const args of [[dst], ['-l', dst]]) {
    try {
      execFileSync('umount', args, { stdio: 'pipe' });
      return;
    } catch (_) {
      /* not mounted, or busy: retry lazily */
    }
  }
}

async function runReadonlyChecks({ sqlite, dir, execPath = process.execPath, env = {}, uriSupported = true }) {
  const { DatabaseSync } = sqlite;
  const results = [];
  const rec = (id, item, status, evidence) => results.push({ id, item, pass: status === 'PASS', status, evidence });
  const run = async (id, item, fn) => {
    try {
      const r = await fn();
      if (r && r.__status) rec(id, item, r.__status, r.evidence);
      else rec(id, item, 'PASS', r === undefined ? null : r);
    } catch (e) {
      rec(id, item, 'FAIL', `${e && e.code ? e.code + ': ' : ''}${e && e.message}`);
    }
  };
  const must = (c, m) => {
    if (!c) throw new Error(m);
  };
  const outcome = (fn) => {
    try {
      return { ok: true, value: fn() };
    } catch (e) {
      return { ok: false, error: `${e.code ? e.code + ': ' : ''}${e.message}` };
    }
  };
  /** open, run fn(db), ALWAYS close (a leaked fd on the ro mount would make umount fail with EBUSY). */
  const withDb = (file, opts, fn) => {
    const d = new DatabaseSync(file, opts);
    try {
      return fn(d);
    } finally {
      try {
        d.close();
      } catch (_) {
        /* already closed */
      }
    }
  };
  const countSpans = (r) => r.prepare('SELECT count(*) AS n FROM spans').get().n;

  const live = path.join(dir, 'live');
  const roview = path.join(dir, 'roview');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(tmp, { recursive: true });
  const dbFile = path.join(live, 'spans.db');

  const W = spawnWorker({ execPath, env });
  const w = async (op, args) => {
    const r = await W.call(op, args);
    if (!r.ok) throw new Error(`W.${op}: ${r.error}`);
    return r.value;
  };
  let mounted = false;
  try {
    // ---- the "Copilot" writer: WAL, autocheckpoint OFF so the -wal keeps un-checkpointed spans ----
    await w('open', { path: dbFile, pragmas: ['PRAGMA journal_mode=WAL', 'PRAGMA wal_autocheckpoint=0', 'PRAGMA synchronous=NORMAL'] });
    await w('exec', {
      sql: `CREATE TABLE spans(span_id TEXT PRIMARY KEY, ts_ns INTEGER, attributes TEXT);
            WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<100)
            INSERT INTO spans SELECT 'span'||i, 1700000000000000000 + i, '{"gen_ai.usage.input_tokens":'||i||'}' FROM c`,
    });
    const filesLive = ls(live);

    await run('5a', 'live WAL writer, writable dir: new DatabaseSync(p,{readOnly:true}) reads rows incl. un-checkpointed WAL content', async () => {
      return withDb(dbFile, { readOnly: true }, (r) => {
        const n = countSpans(r);
        const jm = r.prepare('PRAGMA journal_mode').get().journal_mode;
        const walBytes = fs.statSync(dbFile + '-wal').size;
        must(n === 100, 'n=' + n);
        return { rows: n, journal_mode: jm, walBytes, filesWhileLive: filesLive };
      });
    });
    await run('5b', 'live writer keeps committing: the SAME read-only connection sees new commits; data_version changes', async () => {
      const r = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const dv0 = r.prepare('PRAGMA data_version').get().data_version;
        const n0 = countSpans(r);
        await w('exec', { sql: "INSERT INTO spans VALUES ('late1', 1700000000000000999, '{}'), ('late2', 1700000000000001000, '{}')" });
        const dv1 = r.prepare('PRAGMA data_version').get().data_version;
        const n1 = countSpans(r);
        must(n1 === n0 + 2 && dv1 !== dv0, `n0=${n0} n1=${n1} dv0=${dv0} dv1=${dv1}`);
        return { n0, n1, dv0, dv1 };
      } finally {
        r.close();
      }
    });
    await run('5c', 'live writer holds an UNCOMMITTED write tx: read-only reader is not blocked and sees committed state only', async () => {
      await w('beginAndHold');
      await w('exec', { sql: "INSERT INTO spans VALUES ('uncommitted', 1, '{}')" });
      try {
        return withDb(dbFile, { readOnly: true }, (r) => {
          r.exec('PRAGMA busy_timeout=500');
          const t0 = Date.now();
          const n = r.prepare("SELECT count(*) AS n FROM spans WHERE span_id='uncommitted'").get().n;
          const ms = Date.now() - t0;
          must(n === 0 && ms < 400, `n=${n} ms=${ms}`);
          return { uncommittedVisible: n, readMs: ms };
        });
      } finally {
        await w('release', { rollback: true });
      }
    });
    await run('5d', 'reader never creates/removes files while the writer is live (no -wal/-shm pollution)', async () => {
      const before = ls(live);
      withDb(dbFile, { readOnly: true }, (r) => countSpans(r));
      const after = ls(live);
      must(JSON.stringify(before) === JSON.stringify(after), `${before} -> ${after}`);
      return { before, after };
    });

    // ---- read-only filesystem view of a LIVE db (-wal/-shm exist, writer connected) ----
    const m = tryMountRo(live, roview);
    mounted = m.ok;
    if (!m.ok) {
      for (const id of ['5e', '5f', '5g']) rec(id, 'needs read-only mount', 'SKIPPED', m.error);
    } else {
      const roDb = path.join(roview, 'spans.db');
      await run('5e', 'READ-ONLY FILESYSTEM + live writer (-wal/-shm exist): readOnly:true open + read', async () => {
        const o = outcome(() => withDb(roDb, { readOnly: true }, countSpans));
        return o.ok ? { rows: o.value } : { __status: 'FAIL', evidence: o.error };
      });
      await run('5f', 'READ-ONLY FILESYSTEM + live writer, then writer commits: reader (same connection) sees new rows', async () => {
        const r = new DatabaseSync(roDb, { readOnly: true });
        try {
          const n0 = countSpans(r);
          await w('exec', { sql: "INSERT INTO spans VALUES ('late3', 1700000000000002000, '{}')" });
          const n1 = countSpans(r);
          return { __status: n1 === n0 + 1 ? 'PASS' : 'FAIL', evidence: { n0, n1, sawNewCommit: n1 === n0 + 1 } };
        } finally {
          r.close();
        }
      });
      await run('5g', 'NEGATIVE CONTROL: READ-ONLY FILESYSTEM + live writer with un-checkpointed WAL: immutable=1 URI (ignores -wal => stale/empty)', async () => {
        if (!uriSupported) return { __status: 'N/A', evidence: 'DatabaseSync does not accept file: URIs on this runtime' };
        const o = outcome(() => withDb(`file:${roDb}?immutable=1`, { readOnly: true }, countSpans));
        const liveN = (await w('get', { sql: 'SELECT count(*) AS n FROM spans' })).n;
        // the live writer has autocheckpoint off, so ALL rows are still in the -wal: immutable=1 cannot see them
        return o.ok
          ? { __status: o.value < liveN ? 'EXPECTED-STALE' : 'PASS', evidence: { immutableRows: o.value, liveRows: liveN, note: 'WAL content ignored' } }
          : { __status: 'EXPECTED-FAIL', evidence: o.error };
      });
    }

    // ---- fallbacks against a LIVE writer in a writable dir ----
    await run('5h', 'fallback VACUUM INTO from a read-only connection (consistent snapshot copy, live writer)', async () => {
      const dest = path.join(tmp, 'vacuumed.db');
      const ms = withDb(dbFile, { readOnly: true }, (r) => {
        const t0 = Date.now();
        r.exec(`VACUUM INTO '${dest}'`);
        return Date.now() - t0;
      });
      const liveN = (await w('get', { sql: 'SELECT count(*) AS n FROM spans' })).n;
      return withDb(dest, { readOnly: true }, (c) => {
        const n = countSpans(c);
        const ic = c.prepare('PRAGMA integrity_check').get().integrity_check;
        must(n === liveN && ic === 'ok', `copy=${n} live=${liveN} ic=${ic}`);
        return { rows: n, integrity: ic, vacuumMs: ms };
      });
    });
    await run('5i', 'fallback copy db+wal+shm to temp dir while writer is live, then open the copy (torn-copy hunt: up to 40 copies under write load + checkpoints)', async () => {
      await w('exec', { sql: 'PRAGMA wal_autocheckpoint=200' });
      await w('exec', { sql: 'CREATE TABLE IF NOT EXISTS contention(id INTEGER PRIMARY KEY, who TEXT, seq INTEGER)' });
      const load = W.call('loopInsert', { n: 40000, who: 'W' });
      let torn = 0;
      let copies = 0;
      let lastN = 0;
      let monotonicViolations = 0;
      const errors = [];
      const t0 = Date.now();
      while (copies < 40 && Date.now() - t0 < 8000) {
        const cd = path.join(tmp, `copy${copies}`);
        fs.mkdirSync(cd);
        try {
          for (const suffix of ['-wal', '', '-shm']) {
            try {
              fs.copyFileSync(dbFile + suffix, path.join(cd, 'spans.db' + suffix));
            } catch (_) {
              /* may vanish mid-checkpoint */
            }
          }
          withDb(path.join(cd, 'spans.db'), {}, (c) => {
            const ic = c.prepare('PRAGMA integrity_check').get().integrity_check;
            const n = countSpans(c);
            if (ic !== 'ok') torn++;
            if (n < lastN) monotonicViolations++;
            lastN = Math.max(lastN, n);
          });
        } catch (e) {
          torn++;
          errors.push(e.message);
        }
        copies++;
        await sleep(5);
      }
      const lo = await load;
      return {
        __status: torn === 0 && monotonicViolations === 0 ? 'PASS' : 'FAIL',
        evidence: { copies, tornOrErrored: torn, monotonicViolations, errors: errors.slice(0, 3), loadFailures: lo.ok ? lo.value.failures : lo.error, note: 'racy by construction (no torn copy observed is not proof); VACUUM INTO (5h) is the safe snapshot' },
      };
    });
    await run('5j', 'readOnly:true reader of a live DB under write load: 2000 reads, zero errors; writer never blocked', async () => {
      const r = new DatabaseSync(dbFile, { readOnly: true });
      try {
        r.exec('PRAGMA busy_timeout=2000');
        const load = W.call('loopInsert', { n: 20000, who: 'W2' });
        let errs = 0;
        let reads = 0;
        let maxMs = 0;
        const t0 = Date.now();
        while (reads < 2000) {
          const s = Date.now();
          try {
            r.prepare('SELECT count(*) AS n FROM contention').get();
          } catch (_) {
            errs++;
          }
          maxMs = Math.max(maxMs, Date.now() - s);
          reads++;
          if (reads % 50 === 0) await sleep(1);
        }
        const readMs = Date.now() - t0;
        const lo = await load;
        must(errs === 0 && lo.ok && lo.value.failures === 0, `errs=${errs} writerFailures=${lo.ok ? lo.value.failures : lo.error}`);
        return { reads, readErrors: errs, maxReadMs: maxMs, totalReadMs: readMs, writerFailures: lo.value.failures, writerMaxTxMs: lo.value.maxTxMs };
      } finally {
        r.close();
      }
    });

    // ---- writer gone: clean close => -wal/-shm deleted by SQLite ----
    await w('close');
    const afterClose = ls(live);
    await run('5k', 'writer closed cleanly: -wal/-shm removed; then readOnly open of the bare WAL-mode file in a WRITABLE dir (does the reader leave files behind?)', async () => {
      const r = new DatabaseSync(dbFile, { readOnly: true });
      let n;
      let jm;
      let during;
      try {
        n = countSpans(r);
        jm = r.prepare('PRAGMA journal_mode').get().journal_mode;
        during = ls(live);
      } finally {
        r.close();
      }
      const after = ls(live);
      return { filesAfterWriterClose: afterClose, filesWhileReaderOpen: during, filesAfterReaderClose: after, rows: n, journal_mode: jm };
    });
    if (mounted) {
      for (const s of ['-wal', '-shm']) fs.rmSync(dbFile + s, { force: true }); // ensure bare state for the ro-mount scenarios
      await run('5l', 'READ-ONLY FILESYSTEM, no -wal/-shm, WAL-mode header: plain readOnly:true open', async () => {
        const o = outcome(() => withDb(path.join(roview, 'spans.db'), { readOnly: true }, countSpans));
        return o.ok ? { rows: o.value } : { __status: 'FAIL', evidence: o.error };
      });
      await run('5m', 'READ-ONLY FILESYSTEM, no -wal/-shm: immutable=1 URI fallback', async () => {
        if (!uriSupported) return { __status: 'N/A', evidence: 'DatabaseSync does not accept file: URIs on this runtime' };
        const o = outcome(() => withDb(`file:${path.join(roview, 'spans.db')}?immutable=1`, { readOnly: true }, countSpans));
        return o.ok ? { rows: o.value } : { __status: 'FAIL', evidence: o.error };
      });
      await run('5n', 'READ-ONLY FILESYSTEM, no -wal/-shm: copy db to temp dir and open the copy', async () => {
        const cd = path.join(tmp, 'rocopy');
        fs.mkdirSync(cd, { recursive: true });
        fs.copyFileSync(path.join(roview, 'spans.db'), path.join(cd, 'spans.db'));
        return { rows: withDb(path.join(cd, 'spans.db'), { readOnly: true }, countSpans) };
      });
    } else {
      for (const id of ['5l', '5m', '5n']) rec(id, 'needs read-only mount', 'SKIPPED', 'mount refused');
    }

    // ---- rollback-journal (DELETE mode) DB with a writer committing in a loop ----
    await run('5o', 'rollback-journal (non-WAL) DB, writer committing in a loop: readOnly reader errors with busy_timeout 0 vs 2000 (informational)', async () => {
      const p = path.join(live, 'delete-mode.db');
      await w('open', { path: p, pragmas: ['PRAGMA journal_mode=DELETE', 'PRAGMA synchronous=OFF'] });
      await w('exec', { sql: "CREATE TABLE contention(id INTEGER PRIMARY KEY, who TEXT, seq INTEGER); INSERT INTO contention(who,seq) VALUES ('a',1)" });
      const poll = (timeout) =>
        withDb(p, { readOnly: true }, (r) => {
          r.exec('PRAGMA busy_timeout=' + timeout);
          let errs = 0;
          let reads = 0;
          for (let i = 0; i < 3000; i++) {
            try {
              r.prepare('SELECT count(*) AS n FROM contention').get();
            } catch (_) {
              errs++;
            }
            reads++;
          }
          return { reads, errs };
        });
      const load = W.call('loopInsert', { n: 30000, who: 'W' });
      await sleep(20);
      const busyTimeout0 = poll(0);
      const busyTimeout2000 = poll(2000);
      await load;
      return { busyTimeout0, busyTimeout2000, note: 'Copilot DB journal mode unknown; WAL (5j) gave zero reader errors' };
    });
  } finally {
    umount(roview);
    W.kill();
  }
  return results;
}

module.exports = { runReadonlyChecks };

'use strict';
// Child-process side of the two-process tests: a tiny RPC server over the IPC channel that holds ONE
// DatabaseSync connection. Spawned with the same runtime as the parent (Node, or Electron with
// ELECTRON_RUN_AS_NODE=1), so it exercises exactly the node:sqlite build under test.
const sqlite = require('node:sqlite');
const { DatabaseSync } = sqlite;

let db = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ops = {
  info: () => ({ node: process.versions.node, electron: process.versions.electron || null, pid: process.pid }),
  open: ({ path, options, pragmas }) => {
    db = new DatabaseSync(path, options || {});
    for (const p of pragmas || []) db.exec(p);
    return { isOpen: db.isOpen };
  },
  exec: ({ sql }) => {
    db.exec(sql);
    return null;
  },
  run: ({ sql, params }) => {
    const r = db.prepare(sql).run(...(params || []));
    return { changes: r.changes };
  },
  all: ({ sql, params }) => db.prepare(sql).all(...(params || [])),
  get: ({ sql, params }) => db.prepare(sql).get(...(params || [])),
  /** BEGIN IMMEDIATE, hold the write lock for `ms` (event loop free), then COMMIT. */
  holdImmediate: async ({ ms, insert }) => {
    const t0 = Date.now();
    db.exec('BEGIN IMMEDIATE');
    if (insert) db.prepare(insert).run();
    await sleep(ms);
    db.exec('COMMIT');
    return { heldMs: Date.now() - t0 };
  },
  /** Open a write tx and leave it open (no commit) until `release`. */
  beginAndHold: () => {
    db.exec('BEGIN IMMEDIATE');
    return null;
  },
  release: ({ rollback }) => {
    db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
    return null;
  },
  /** n x (BEGIN IMMEDIATE; INSERT; COMMIT) synchronously: contention loop. */
  loopInsert: ({ n, who }) => {
    let busy = 0;
    let maxMs = 0;
    const startedAt = Date.now();
    const ins = db.prepare('INSERT INTO contention(who, seq) VALUES (?, ?)');
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      try {
        db.exec('BEGIN IMMEDIATE');
        ins.run(who, i);
        db.exec('COMMIT');
      } catch (e) {
        busy++;
        try {
          db.exec('ROLLBACK');
        } catch (_) {
          /* no tx */
        }
      }
      maxMs = Math.max(maxMs, Date.now() - t0);
    }
    return { n, failures: busy, maxTxMs: maxMs, startedAt, endedAt: Date.now() };
  },
  close: () => {
    if (db) db.close();
    db = null;
    return null;
  },
  exit: () => {
    setImmediate(() => process.exit(0));
    return null;
  },
};

process.on('message', async (msg) => {
  const { id, op, args } = msg;
  const t0 = Date.now();
  try {
    const value = await ops[op](args || {});
    process.send({ id, ok: true, value, ms: Date.now() - t0 });
  } catch (e) {
    process.send({ id, ok: false, error: `${e.code ? e.code + ': ' : ''}${e.message}`, ms: Date.now() - t0 });
  }
});
process.send({ ready: true });

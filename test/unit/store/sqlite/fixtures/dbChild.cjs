'use strict';
// A child process with one node:sqlite connection, driven over IPC by the store tests: another "VS Code window"
// (or another program, for openReadOnly) sharing a database file.
const { DatabaseSync } = require('node:sqlite');

let db = null;

const ops = {
  open: ({ path, readOnly, pragmas }) => {
    db = new DatabaseSync(path, { readOnly: readOnly === true });
    for (const p of pragmas || []) db.exec(p);
    return null;
  },
  exec: ({ sql }) => {
    db.exec(sql);
    return null;
  },
  all: ({ sql, params }) => db.prepare(sql).all(...(params || [])).map((r) => ({ ...r })),
  /** BEGIN IMMEDIATE; INSERT ... ON CONFLICT DO NOTHING; COMMIT in batches; returns how many rows THIS process inserted. */
  insertIds: ({ prefix, from, to, batch, source }) => {
    const stmt = db.prepare(
      "INSERT INTO events (id, ts, modelId, surface, source) VALUES (?, ?, 'm', 'chat', ?) ON CONFLICT(id) DO NOTHING",
    );
    let inserted = 0;
    for (let i = from; i < to; i += batch) {
      db.exec('BEGIN IMMEDIATE');
      for (let j = i; j < Math.min(to, i + batch); j++) inserted += Number(stmt.run(`${prefix}${j}`, 1_700_000_000_000 + j, source || 'local').changes);
      db.exec('COMMIT');
    }
    return inserted;
  },
  close: () => {
    if (db) db.close();
    db = null;
    return null;
  },
};

process.on('message', (msg) => {
  try {
    const value = ops[msg.op](msg.args || {});
    process.send({ id: msg.id, ok: true, value });
  } catch (e) {
    process.send({ id: msg.id, ok: false, error: `${e.code || ''} ${e.message}` });
  }
});
process.send({ ready: true });

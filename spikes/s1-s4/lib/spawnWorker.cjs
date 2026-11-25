'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

/**
 * Spawn lib/worker.cjs with `execPath` (default: the current runtime). Returns { call, kill }.
 * `env` is merged over process.env; use { ELECTRON_RUN_AS_NODE: '1' } when execPath is an Electron binary.
 */
function spawnWorker({ execPath = process.execPath, env = {}, execArgv = [] } = {}) {
  const child = spawn(execPath, [...execArgv, path.join(__dirname, 'worker.cjs')], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(String(d)));
  child.stdout.on('data', () => {});
  let nextId = 1;
  const pending = new Map();
  let readyResolve;
  const ready = new Promise((r) => (readyResolve = r));
  child.on('message', (m) => {
    if (m.ready) return readyResolve();
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      p(m);
    }
  });
  child.on('exit', (code) => {
    for (const p of pending.values()) p({ ok: false, error: 'child exited ' + code });
    readyResolve();
  });
  const call = async (op, args) => {
    await ready;
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.send({ id, op, args });
    });
  };
  return { call, child, stderr: () => stderr.join(''), kill: () => child.kill('SIGKILL') };
}

module.exports = { spawnWorker };

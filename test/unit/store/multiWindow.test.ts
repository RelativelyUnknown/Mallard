import { strict as assert } from 'assert';
import { ChildProcess, spawn } from 'child_process';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../../../src/extension-backend/store/EventStore';
import type { Logger } from '../../../src/extension-backend/util/logger';
import type { UsageEvent } from '../../../src/extension-backend/domain/types';
import { makeEvent } from '../helpers';

/** Another "window": a separate process holding events.duckdb read-write. */
async function holdDatabase(file: string): Promise<ChildProcess> {
  const script = `
    const { DuckDBInstance } = require('@duckdb/node-api');
    DuckDBInstance.create(${JSON.stringify(file)}).then(async (i) => {
      await i.connect();
      console.log('READY');
      setInterval(() => {}, 1000);
    }).catch((e) => { console.error(String(e)); process.exit(1); });`;
  const repoRoot = path.resolve(__dirname, '..', '..', '..'); // where node_modules resolves from
  const child = spawn(process.execPath, ['-e', script], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (d: Buffer) => { if (String(d).includes('READY')) resolve(); });
    child.once('exit', () => reject(new Error('lock-holder process exited early')));
  });
  return child;
}

async function release(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await exited;
}

function captureLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug: () => undefined,
    info: () => undefined,
    warn: (_tag, msg) => { warnings.push(msg); },
    error: () => undefined,
  };
}

describe('EventStore.open — a second window', () => {
  it('opens read-write when nobody else holds the database', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-win-'));
    const logger = captureLogger();
    const store = await EventStore.open(dir, undefined, logger);
    try {
      assert.equal(store.inMemory, false);
      assert.deepEqual(logger.warnings, []);
    } finally { store.dispose(); }
  });

  it('falls back to a private in-memory store (with a warning) when another process holds the file', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-win-'));
    const holder = await holdDatabase(path.join(dir, 'events.duckdb'));
    try {
      const logger = captureLogger();
      const store = await EventStore.open(dir, undefined, logger);
      try {
        assert.equal(store.inMemory, true);
        assert.equal(logger.warnings.length, 1);
        assert.match(logger.warnings[0]!, /locked by another VS Code window/);

        // The dashboard path keeps working against the private store…
        const streamed: UsageEvent[][] = [];
        store.writer.onInserted = (events) => streamed.push(events);
        const ts = new Date(2026, 5, 10, 12).getTime();
        assert.equal(await store.writer.insert([makeEvent({ id: 'a', ts, credits: 4 })]), 1);
        const snapshot = await store.reader.readSnapshotCache();
        assert.equal(snapshot.totals.all.credits, 4);
        // …but it must not re-stream the rebuilt history to the exporter: the
        // window that owns the file already does.
        assert.deepEqual(streamed, []);
      } finally { store.dispose(); }
    } finally { await release(holder); }
  });

  it('does not swallow other open failures (e.g. a corrupt database file)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-win-'));
    await fs.writeFile(path.join(dir, 'events.duckdb'), 'this is not a duckdb file '.repeat(200));
    const logger = captureLogger();
    await assert.rejects(EventStore.open(dir, undefined, logger));
    assert.deepEqual(logger.warnings, [], 'no in-memory fallback for a non-lock failure');
  });
});

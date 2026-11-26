import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSqlite } from '../../../../src/extension-backend/store/sqlite/Db';
import type { SqliteDatabase, SqliteLoader, SqliteModule } from '../../../../src/extension-backend/store/sqlite/Db';

/** The error node:sqlite throws for SQLITE_BUSY ("database is locked"). */
export function busyError(errcode = 5): Error {
  return Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode, errstr: 'database is locked' });
}

export interface Faults {
  /** `new DatabaseSync` throws BUSY this many more times. */
  open: number;
  /** `exec('BEGIN IMMEDIATE')` throws BUSY this many more times (Infinity: always). */
  begin: number;
  /** Every `BEGIN IMMEDIATE` after this many successful ones throws BUSY. */
  beginAfter: number;
  /** `PRAGMA wal_checkpoint` throws a plain error. */
  checkpoint: boolean;
  /** `PRAGMA journal_mode` reads back as this. */
  journal: string;
  /** Counters. */
  begins: number;
  opens: number;
}

/** The real driver with injectable BUSY failures, as a loader. */
export function flakyLoader(initial: Partial<Faults> = {}): { loader: SqliteLoader; faults: Faults } {
  const real = loadSqlite();
  const faults: Faults = { open: 0, begin: 0, beginAfter: Infinity, checkpoint: false, journal: '', begins: 0, opens: 0, ...initial };
  class Flaky extends real.DatabaseSync {
    constructor(p: string, o?: { readOnly?: boolean }) {
      faults.opens++;
      if (faults.open > 0) {
        faults.open--;
        throw busyError();
      }
      super(p, o);
    }
    override exec(sql: string): void {
      if (sql === 'BEGIN IMMEDIATE') {
        faults.begins++;
        if (faults.begin > 0 || faults.begins > faults.beginAfter) {
          faults.begin--;
          throw busyError();
        }
      }
      if (faults.checkpoint && sql.startsWith('PRAGMA wal_checkpoint')) throw new Error('checkpoint failed');
      super.exec(sql);
    }
    override prepare(sql: string): ReturnType<SqliteDatabase['prepare']> {
      if (faults.journal && sql === 'PRAGMA journal_mode') return { get: () => ({ journal_mode: faults.journal }) } as unknown as ReturnType<SqliteDatabase['prepare']>;
      return super.prepare(sql);
    }
  }
  const mod: SqliteModule = { DatabaseSync: Flaky };
  return { loader: () => mod, faults };
}

export async function tempDir(prefix = 'mallard-sq-'): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await fs.promises.rm(dir, { recursive: true, force: true });
}

/** A busy-retry setup that never really sleeps. */
export const FAST_RETRY = { sleep: (): Promise<void> => new Promise((r) => setImmediate(r)), random: () => 0.5 };

export interface DbChild {
  call<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T>;
  kill(): void;
}

/** A child Node process holding its own SQLite connection (test/unit/store/sqlite/fixtures/dbChild.cjs), driven over IPC. */
export function spawnDbChild(): DbChild {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'fixtures', 'dbChild.cjs')], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => { stderr += String(d); });
  let nextId = 1;
  const pending = new Map<number, (m: { ok: boolean; value?: unknown; error?: string }) => void>();
  const ready = new Promise<void>((resolve) => {
    child.on('message', (m: { ready?: boolean; id?: number; ok?: boolean; value?: unknown; error?: string }) => {
      if (m.ready) resolve();
      else if (m.id !== undefined) pending.get(m.id)?.({ ok: m.ok === true, value: m.value, error: m.error });
    });
    child.on('exit', () => resolve());
  });
  return {
    async call<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
      await ready;
      const id = nextId++;
      const answer = new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve) => pending.set(id, resolve));
      child.send({ id, op, args });
      const r = await answer;
      if (!r.ok) throw new Error(`child ${op}: ${r.error} ${stderr}`);
      return r.value as T;
    },
    kill: () => { child.kill('SIGKILL'); },
  };
}

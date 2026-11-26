/**
 * Thin wrapper over Node's built-in `node:sqlite` (`DatabaseSync`).
 *
 * - The driver is loaded lazily through an injectable loader, so "the driver is
 *   missing" (VS Code older than 1.101, a fork without it) is a testable,
 *   recoverable condition (`SqliteUnavailableError`) instead of a crash at import.
 * - It declares its own minimal interface, limited to the Node 22.13 API
 *   (`exec`, `prepare().run/get/all/iterate`, `close`, `setReadBigInts`). The
 *   newer members (`timeout` option, `isOpen`, URI paths, `aggregate`, `columns`,
 *   `setReturnArrays`, `isTransaction`) are NOT assumed: VS Code 1.101 ships Node
 *   22.15 and the `@types/node` of this repo is newer than that.
 * - Connection settings are PRAGMAs run through `exec`: WAL, `synchronous=NORMAL`,
 *   `busy_timeout=0` (a synchronous busy wait blocks the extension host's event
 *   loop; contention is retried asynchronously instead, see `Db.transaction`) and
 *   foreign keys OFF (node:sqlite turns them ON by default).
 */
import type { Logger } from '../../util/logger';

/** First VS Code release whose extension host (Electron 35, Node 22) has `node:sqlite`. */
export const MIN_VSCODE_VERSION = '1.101';

// ── Driver surface ────────────────────────────────────────────────────────────

export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlParam = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  run(...params: SqlParam[]): SqliteRunResult;
  get(...params: SqlParam[]): SqlRow | undefined;
  all(...params: SqlParam[]): SqlRow[];
  iterate(...params: SqlParam[]): IterableIterator<SqlRow>;
  setReadBigInts(enabled: boolean): void;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

/** Returns the driver module, or throws (anything thrown becomes a {@link SqliteUnavailableError}). */
export type SqliteLoader = () => SqliteModule;

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * `node:sqlite` is not available in this runtime. The message is written to be
 * shown to the user as is: it names the minimum VS Code version and what to do.
 */
export class SqliteUnavailableError extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(
      `Mallard stores usage in Node's built-in SQLite (node:sqlite), which this editor does not provide (${reason}). ` +
        `Update VS Code to ${MIN_VSCODE_VERSION} or later (or a fork built on it); until then Mallard keeps usage in memory only, ` +
        'so it is lost when the window closes.',
      options,
    );
    this.name = 'SqliteUnavailableError';
  }
}

// ── Loading ───────────────────────────────────────────────────────────────────

/**
 * Runs `fn` with `process.emitWarning` wrapped so the one-off
 * "SQLite is an experimental feature" ExperimentalWarning (printed by Node 22 on
 * the first `require('node:sqlite')`, i.e. VS Code 1.101 to 1.115) is dropped.
 * An extension cannot pass `--disable-warning` to the extension host. Every
 * other warning still goes through, and the original function is always restored.
 */
export function withoutSqliteExperimentalWarning<T>(fn: () => T): T {
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const first = rest[0];
    const type = typeof first === 'string' ? first : (first as { type?: string } | undefined)?.type ?? (warning as Error).name;
    const text = typeof warning === 'string' ? warning : warning.message;
    if (type === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    (original as (...args: unknown[]) => void).call(this, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    return fn();
  } finally {
    process.emitWarning = original;
  }
}

/** The default loader: `require('node:sqlite')` with the experimental warning silenced. */
export const defaultSqliteLoader: SqliteLoader = () => requireSqlite(require);

/**
 * `require('node:sqlite')` through `requireFn`, checked. Split from the default
 * loader so tests can pass a `requireFn` that misbehaves.
 */
export function requireSqlite(requireFn: (id: string) => unknown): SqliteModule {
  let mod: unknown;
  try {
    mod = withoutSqliteExperimentalWarning(() => requireFn('node:sqlite'));
  } catch (err) {
    throw new SqliteUnavailableError('node:sqlite could not be loaded', { cause: err });
  }
  if (typeof (mod as Partial<SqliteModule> | undefined)?.DatabaseSync !== 'function') {
    throw new SqliteUnavailableError('node:sqlite has no DatabaseSync');
  }
  return mod as SqliteModule;
}

/** Runs the loader; anything it throws that is not already a SqliteUnavailableError becomes one. */
export function loadSqlite(loader: SqliteLoader = defaultSqliteLoader): SqliteModule {
  try {
    return loader();
  } catch (err) {
    if (err instanceof SqliteUnavailableError) throw err;
    throw new SqliteUnavailableError('the SQLite loader failed', { cause: err });
  }
}

// ── Error classification ──────────────────────────────────────────────────────

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * True for SQLITE_BUSY / SQLITE_LOCKED (including the extended codes, e.g.
 * BUSY_SNAPSHOT 517): another connection holds the lock. Matched on the numeric
 * `errcode` the driver attaches to its errors, never on message text. Only for a
 * runtime whose errors carry no `errcode` at all (not verified for Node 22.13 to
 * 22.15) does it fall back to the SQLite wording of those two result codes.
 */
export function isBusyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { errcode, code, message } = err as { errcode?: unknown; code?: unknown; message?: unknown };
  if (typeof errcode === 'number') return (errcode & 0xff) === SQLITE_BUSY || (errcode & 0xff) === SQLITE_LOCKED;
  return code === 'ERR_SQLITE_ERROR' && /database (table )?is locked/i.test(String(message));
}

/** True for the RangeError node:sqlite throws when an INTEGER does not fit a JS number (above 2^53). */
export function isOutOfRangeError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ERR_OUT_OF_RANGE';
}

// ── Integers ──────────────────────────────────────────────────────────────────

/**
 * A JS number as an INTEGER-typed SQL parameter. JS numbers bind as REAL, which
 * turns `x / ?` into float division and `x % ?` into a float modulo, and makes
 * `LIMIT ?` / `OFFSET ?` type-sensitive; a bigint binds as INTEGER. Throws for
 * anything that is not a safe integer. (Plain values stored into an INTEGER
 * column need no helper: the column affinity converts a whole REAL.)
 */
export function intParam(n: number): bigint {
  if (!Number.isSafeInteger(n)) throw new RangeError(`not a safe integer: ${n}`);
  return BigInt(n);
}

/** True when `n` is a JS number SQLite can store as an INTEGER and read back exactly (|n| <= 2^53 - 1). */
export function isSafeSqlInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isSafeInteger(n);
}

/** A bigint read back as a number, saturating at +/-(2^53 - 1): a token sum that large is a bug, not a number to show. */
export function saturate(v: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (v > max) return Number.MAX_SAFE_INTEGER;
  if (v < -max) return -Number.MAX_SAFE_INTEGER;
  return Number(v);
}

/** A column value as a number: numbers pass, bigints (a read that had to use bigints) saturate. */
export function num(v: SqlValue | undefined): number {
  return typeof v === 'bigint' ? saturate(v) : (v as number);
}

/** A column value as a string or null. */
export function text(v: SqlValue | undefined): string | null {
  return v === null || v === undefined ? null : String(v);
}

// ── Retry ─────────────────────────────────────────────────────────────────────

export interface BusyRetry {
  /** Maximum number of tries (the first included). */
  attempts: number;
  /** Jitter window of the pause between tries, in milliseconds. */
  minDelayMs: number;
  maxDelayMs: number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

export const DEFAULT_BUSY_RETRY: BusyRetry = {
  // About 2.7 s of waiting at the mean pause: a competing window's write batch
  // takes 10 to 100 ms (spike S2: batch latency incl. waits p95 102 ms, max 232 ms).
  attempts: 300,
  minDelayMs: 3,
  maxDelayMs: 15,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/**
 * Runs `attempt` (synchronous, so it blocks the event loop only for its own
 * duration) and, while it fails with SQLITE_BUSY, pauses ASYNCHRONOUSLY for a
 * jittered 3 to 15 ms and tries again, up to `retry.attempts` tries; the last
 * error is rethrown. Any other error is rethrown at once.
 */
export async function retryBusy<T>(attempt: () => T, retry: BusyRetry): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return attempt();
    } catch (err) {
      if (!isBusyError(err) || n >= retry.attempts) throw err;
      await retry.sleep(retry.minDelayMs + retry.random() * (retry.maxDelayMs - retry.minDelayMs));
    }
  }
}

// ── Db ────────────────────────────────────────────────────────────────────────

export interface DbOptions {
  /** Open read-only (no journal-mode change; the file must exist). */
  readOnly?: boolean;
  loader?: SqliteLoader;
  busy?: Partial<BusyRetry>;
  logger?: Logger;
}

export class Db {
  private readonly cache = new Map<string, SqliteStatement>();
  private closed = false;
  /** The journal mode the connection ended up in ('wal' for a file database; 'memory' for ':memory:'). */
  readonly journalMode: string;
  private readonly retry: BusyRetry;

  private constructor(
    private readonly raw: SqliteDatabase,
    readonly path: string,
    readOnly: boolean,
    busy: Partial<BusyRetry> | undefined,
  ) {
    this.retry = { ...DEFAULT_BUSY_RETRY, ...busy };
    try {
      this.raw.exec(readOnly ? 'PRAGMA busy_timeout=0' : 'PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=0; PRAGMA foreign_keys=OFF');
      this.journalMode = String(this.raw.prepare('PRAGMA journal_mode').get()?.['journal_mode']);
    } catch (err) {
      this.raw.close();
      throw err;
    }
  }

  /**
   * Opens `path` (a file, or ':memory:') and applies the connection PRAGMAs.
   * Synchronous: if another process is in the middle of switching the file to
   * WAL this can throw SQLITE_BUSY; `openWithRetry` is the asynchronous variant.
   */
  static open(path: string, opts: DbOptions = {}): Db {
    const { DatabaseSync } = loadSqlite(opts.loader);
    const readOnly = opts.readOnly === true;
    return new Db(new DatabaseSync(path, readOnly ? { readOnly: true } : undefined), path, readOnly, opts.busy);
  }

  /** {@link Db.open}, retried asynchronously while another process holds the file locked. */
  static async openWithRetry(path: string, opts: DbOptions = {}): Promise<Db> {
    return retryBusy(() => Db.open(path, opts), { ...DEFAULT_BUSY_RETRY, ...opts.busy });
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** A prepared statement, compiled once per SQL text. Do not run two `iterate()`s of one statement at the same time. */
  prepare(sql: string): SqliteStatement {
    let stmt = this.cache.get(sql);
    if (stmt === undefined) {
      stmt = this.raw.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  /** A statement that is not cached, for a long-lived `iterate()` that must not be reset by another user of the same SQL. */
  prepareFresh(sql: string): SqliteStatement {
    return this.raw.prepare(sql);
  }

  /** Runs a write statement; returns the number of rows it changed. */
  run(sql: string, ...params: SqlParam[]): number {
    return Number(this.prepare(sql).run(...params).changes);
  }

  get(sql: string, ...params: SqlParam[]): SqlRow | undefined {
    return this.prepare(sql).get(...params);
  }

  /** All rows of a query through a cached statement (see {@link queryRows}). */
  rows(sql: string, ...params: SqlParam[]): SqlRow[] {
    return queryRows(this.prepare(sql), params);
  }

  /**
   * Runs `fn` inside `BEGIN IMMEDIATE` ... `COMMIT`; `ROLLBACK` and rethrow if it
   * throws. IMMEDIATE takes the write lock up front: a deferred BEGIN followed by
   * a read and then a write fails with SQLITE_BUSY_SNAPSHOT as soon as another
   * connection commits in between, and `busy_timeout` does not help (spike S2).
   * With `busy_timeout=0` the BEGIN fails at once when another connection holds the
   * lock, and is retried asynchronously (jittered 3 to 15 ms, bounded) so the
   * event loop is never parked in a busy wait. `fn` may be async (it can yield to
   * the event loop with the transaction open; nothing else may use this
   * connection meanwhile).
   */
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    await retryBusy(() => this.raw.exec('BEGIN IMMEDIATE'), this.retry);
    try {
      const result = await fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // The transaction is already gone (or was never open): the original error is the one to report.
      }
      throw err;
    }
  }

  /** `PRAGMA data_version`: changes when ANOTHER connection commits to the database (never for this connection's own commits). */
  dataVersion(): number {
    return Number(this.prepare('PRAGMA data_version').get()?.['data_version']);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Closes the connection. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    this.raw.close();
  }
}

/**
 * All rows of `stmt`, built through `iterate()`. A value above 2^53 makes the
 * driver throw ERR_OUT_OF_RANGE; the query is then repeated reading INTEGERs as
 * bigints, for the caller to turn into numbers with {@link num} (which
 * saturates at 2^53 - 1).
 */
export function queryRows(stmt: SqliteStatement, params: SqlParam[]): SqlRow[] {
  try {
    return collect(stmt, params);
  } catch (err) {
    if (!isOutOfRangeError(err)) throw err;
  }
  stmt.setReadBigInts(true);
  try {
    return collect(stmt, params);
  } finally {
    stmt.setReadBigInts(false);
  }
}

function collect(stmt: SqliteStatement, params: SqlParam[]): SqlRow[] {
  const out: SqlRow[] = [];
  for (const row of stmt.iterate(...params)) out.push(row);
  return out;
}

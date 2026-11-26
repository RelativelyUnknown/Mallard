/**
 * The `node:sqlite` event store (`events.sqlite`), implementing `IEventStore`.
 *
 * One synchronous `DatabaseSync` connection on the extension host's main thread;
 * everything that could block is kept short or sliced (spike S2):
 *  - writes: batches of 2,000 rows or 15 ms, one `BEGIN IMMEDIATE` transaction
 *    each, a `setImmediate` yield between batches;
 *  - reads: SQL pre-aggregation in 15-minute UTC buckets, read in 7-day windows
 *    with a yield between them;
 *  - `busy_timeout=0` plus an asynchronous jittered retry, so a second VS Code
 *    window writing the same file never parks this event loop.
 *
 * All operations run one at a time (`exclusive`): a transaction is per
 * connection, and the multi-step operations (insert, compaction, the windowed
 * read) yield to the event loop in the middle.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AggregateGroup, IngestState, InsertResult, IUsageStore, RawEvent } from '../../domain/contracts';
import { BUCKET_MS, bucketStart, capCutoff, mergeRolledRow, retentionCutoff, rollId, toRolledRow } from '../../domain/groupEvents';
import type { RepoAttribution, SourceKind, Surface } from '../../domain/types';
import type { Logger } from '../../util/logger';
import { nextBucketStart } from '../../util/time';
import type { RecordFilter } from '../EventRepository';
import { MAX_RAW_EVENTS, RAW_WINDOW_DAYS } from '../schema/constants';
import { Db, intParam, num, queryRows, text } from './Db';
import type { BusyRetry, SqlParam, SqlRow, SqliteLoader } from './Db';
import { prepareRows } from '../eventRules';
import { whereFor } from './filterSql';
import { DB_FILE_NAME, migrate } from './schema';

// ── Tuning ────────────────────────────────────────────────────────────────────

/** Rows per insert transaction (spike S2: p95 32 ms per batch at 2,000 rows, 58 ms at 5,000). */
export const INSERT_BATCH_ROWS = 2_000;
/** Time box of one insert transaction. */
export const INSERT_BATCH_MS = 15;
/** Width of one read window of `aggregateRange`; a multiple of the 15-minute bucket, so no bucket straddles two windows. */
export const READ_WINDOW_MS = 7 * 86_400_000;
/** Rows per chunk of `exportRows`. */
export const EXPORT_CHUNK_ROWS = 5_000;
/** Raw rows rolled per compaction transaction (the transaction ends at a local midnight, so it can hold a bit more). */
export const COMPACT_CHUNK_ROWS = 20_000;
const ROLL_YIELD_ROWS = 5_000;
const DELETE_SLICE_ROWS = 2_000;
/** How often (in rows) an insert transaction looks at the clock. */
const CLOCK_CHECK_ROWS = 64;

export const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── Types ─────────────────────────────────────────────────────────────────────

export type { IngestState, InsertResult };

export interface SqliteStoreOptions {
  /** Days of raw events kept before they roll up (default 90). */
  retentionDays?: number;
  /** Clock, for compaction (default `Date.now`). */
  now?: () => number;
  /** Driver loader (default: `require('node:sqlite')`); inject one to test the driver-missing path. */
  loader?: SqliteLoader;
  logger?: Logger;
  busy?: Partial<BusyRetry>;
  /** Raw-row cap that triggers rolling the oldest days (default MAX_RAW_EVENTS). */
  maxRawEvents?: number;
  /** Raw rows per compaction transaction (default 20,000). */
  compactChunkRows?: number;
  /** Insert batching: rows, milliseconds and the clock that measures them. */
  batch?: { rows?: number; ms?: number; clock?: () => number };
}

/** The insert failed after some batches were already committed; `partial` is what those batches did. */
export class PartialInsertError extends Error {
  constructor(message: string, readonly partial: InsertResult, options: { cause: unknown }) {
    super(message, options);
    this.name = 'PartialInsertError';
  }
}

// ── SQL ───────────────────────────────────────────────────────────────────────

const COLUMNS = 'id, ts, modelId, surface, source, repo, branch, attribution, language, requests, promptTokens, completionTokens, cacheReadTokens, cacheCreationTokens, thinkingTokens';
const NOT_ROLLED = "substr(id, 1, 5) <> 'roll:'";

const INSERT_SQL = `INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`;

/**
 * A later line of the same Claude message (streamed usage grows) raises each
 * token column to the larger value. Not `max(a, b)`: SQLite's scalar max() is
 * NULL when either side is NULL. Copilot rows are immutable (`source` guard).
 * ?1 prompt, ?2 completion, ?3 cache read, ?4 cache creation, ?5 thinking, ?6 id.
 */
const RAISE_TOKENS_SQL = `
UPDATE events SET
  promptTokens        = CASE WHEN ?1 > coalesce(promptTokens, 0)     THEN ?1 ELSE promptTokens END,
  completionTokens    = CASE WHEN ?2 > coalesce(completionTokens, 0) THEN ?2 ELSE completionTokens END,
  cacheReadTokens     = CASE WHEN ?3 > cacheReadTokens     THEN ?3 ELSE cacheReadTokens END,
  cacheCreationTokens = CASE WHEN ?4 > cacheCreationTokens THEN ?4 ELSE cacheCreationTokens END,
  thinkingTokens      = CASE WHEN ?5 > thinkingTokens      THEN ?5 ELSE thinkingTokens END
WHERE id = ?6 AND source = 'claude-code' AND (
  coalesce(?1, 0) > coalesce(promptTokens, 0) OR coalesce(?2, 0) > coalesce(completionTokens, 0) OR
  ?3 > cacheReadTokens OR ?4 > cacheCreationTokens OR ?5 > thinkingTokens)`;

/** Rolled rows: sums into an existing roll row, NULL tokens stay NULL only when both sides are, 'heuristic' wins. */
const ROLL_UPSERT_SQL = `
INSERT INTO events (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  requests = requests + excluded.requests,
  promptTokens = CASE WHEN promptTokens IS NULL AND excluded.promptTokens IS NULL THEN NULL
                      ELSE coalesce(promptTokens, 0) + coalesce(excluded.promptTokens, 0) END,
  completionTokens = CASE WHEN completionTokens IS NULL AND excluded.completionTokens IS NULL THEN NULL
                          ELSE coalesce(completionTokens, 0) + coalesce(excluded.completionTokens, 0) END,
  cacheReadTokens = cacheReadTokens + excluded.cacheReadTokens,
  cacheCreationTokens = cacheCreationTokens + excluded.cacheCreationTokens,
  thinkingTokens = thinkingTokens + excluded.thinkingTokens,
  attribution = CASE WHEN attribution = 'heuristic' OR excluded.attribution = 'heuristic' THEN 'heuristic'
                     WHEN attribution = 'authoritative' OR excluded.attribution = 'authoritative' THEN 'authoritative'
                     ELSE NULL END`;

function aggregateSql(where: string): string {
  return `
SELECT ts - ts % ${BUCKET_MS} AS bucketStartMs, modelId, surface, source, repo, branch, language, attribution,
       (COALESCE(promptTokens, 0) + COALESCE(completionTokens, 0) > 0) AS tokensKnown,
       SUM(requests) AS requests,
       SUM(COALESCE(promptTokens, 0)) AS promptTokens, SUM(COALESCE(completionTokens, 0)) AS completionTokens,
       SUM(cacheReadTokens) AS cacheReadTokens, SUM(cacheCreationTokens) AS cacheCreationTokens, SUM(thinkingTokens) AS thinkingTokens
FROM events ${where}
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
ORDER BY 1, 2, 3, 4, 5, 6, 7, 8, 9`;
}

// ── Row mapping and validation ────────────────────────────────────────────────

function nullableNum(v: SqlRow[string] | undefined): number | null {
  return v === null || v === undefined ? null : num(v);
}

function toEvent(row: SqlRow): RawEvent {
  return {
    id: String(row['id']),
    ts: num(row['ts']),
    modelId: String(row['modelId']),
    surface: row['surface'] as Surface,
    source: row['source'] as SourceKind,
    repo: text(row['repo']),
    branch: text(row['branch']),
    attribution: text(row['attribution']) as RepoAttribution | null,
    language: text(row['language']),
    requests: num(row['requests']),
    promptTokens: nullableNum(row['promptTokens']),
    completionTokens: nullableNum(row['completionTokens']),
    cacheReadTokens: num(row['cacheReadTokens']),
    cacheCreationTokens: num(row['cacheCreationTokens']),
    thinkingTokens: num(row['thinkingTokens']),
  };
}

function toGroup(row: SqlRow): AggregateGroup {
  return {
    bucketStartMs: num(row['bucketStartMs']),
    modelId: String(row['modelId']),
    surface: row['surface'] as Surface,
    source: row['source'] as SourceKind,
    repo: text(row['repo']),
    branch: text(row['branch']),
    language: text(row['language']),
    attribution: text(row['attribution']) as RepoAttribution | null,
    tokensKnown: num(row['tokensKnown']) === 1,
    requests: num(row['requests']),
    promptTokens: num(row['promptTokens']),
    completionTokens: num(row['completionTokens']),
    cacheReadTokens: num(row['cacheReadTokens']),
    cacheCreationTokens: num(row['cacheCreationTokens']),
    thinkingTokens: num(row['thinkingTokens']),
  };
}

const eventParams = (e: RawEvent): SqlParam[] => [
  e.id, e.ts, e.modelId, e.surface, e.source, e.repo, e.branch, e.attribution, e.language,
  e.requests, e.promptTokens, e.completionTokens, e.cacheReadTokens, e.cacheCreationTokens, e.thinkingTokens,
];

// ── Store ─────────────────────────────────────────────────────────────────────

export class SqliteEventStore implements IUsageStore {
  private tail: Promise<void> = Promise.resolve();
  private active = 0;
  private disposed = false;
  private closing: Promise<void> | undefined;
  /** Bumped by every change this connection commits. */
  private ownVersion = 0;
  /** Bumped when `PRAGMA data_version` shows another connection (another window) committed. */
  private foreignVersion = 0;
  private lastDataVersion: number;

  private constructor(
    private readonly db: Db,
    private readonly retentionDays: number,
    private readonly now: () => number,
    private readonly logger: Logger,
    private readonly maxRawEvents: number,
    private readonly batchRows: number,
    private readonly batchMs: number,
    private readonly clock: () => number,
    private readonly compactChunkRows: number,
  ) {
    this.lastDataVersion = db.dataVersion();
  }

  /**
   * Opens (creating it if needed) `events.sqlite` in `dir`, or a private
   * in-memory database for ':memory:'. Throws `SqliteUnavailableError` when the
   * driver cannot be loaded and `SchemaTooNewError` for a file from a newer Mallard.
   */
  static async open(dir: string, opts: SqliteStoreOptions = {}): Promise<SqliteEventStore> {
    const logger = opts.logger ?? SILENT;
    const memory = dir === ':memory:';
    if (!memory) await fs.promises.mkdir(dir, { recursive: true });
    const file = memory ? dir : path.join(dir, DB_FILE_NAME);
    const db = await Db.openWithRetry(file, { ...(opts.loader ? { loader: opts.loader } : {}), ...(opts.busy ? { busy: opts.busy } : {}) });
    try {
      await migrate(db);
    } catch (err) {
      db.close();
      throw err;
    }
    if (!memory && db.journalMode !== 'wal') logger.warn('store', `${file} could not switch to WAL (journal mode "${db.journalMode}"); several windows may contend for it`);
    return new SqliteEventStore(
      db,
      opts.retentionDays ?? RAW_WINDOW_DAYS,
      opts.now ?? Date.now,
      logger,
      opts.maxRawEvents ?? MAX_RAW_EVENTS,
      opts.batch?.rows ?? INSERT_BATCH_ROWS,
      opts.batch?.ms ?? INSERT_BATCH_MS,
      opts.batch?.clock ?? (() => performance.now()),
      opts.compactChunkRows ?? COMPACT_CHUNK_ROWS,
    );
  }

  // ── Serialisation ───────────────────────────────────────────────────────────

  private acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const previous = this.tail;
    this.tail = previous.then(() => mine);
    this.active++;
    return previous.then(() => () => {
      this.active--;
      release();
    });
  }

  private async exclusive<T>(task: () => Promise<T> | T): Promise<T> {
    // Work requested before dispose() still runs; work requested after it is refused.
    const refused = this.disposed;
    const release = await this.acquire();
    try {
      if (refused) throw new Error('SqliteEventStore is disposed');
      return await task();
    } finally {
      release();
    }
  }

  // ── Writes ──────────────────────────────────────────────────────────────────

  async insert(events: RawEvent[]): Promise<InsertResult> {
    const { rows, rejected, firstRejected } = prepareRows(events);
    if (rejected > 0) this.logger.warn('store', `refused ${rejected} invalid event(s), e.g. ${firstRejected}`);
    if (rows.length === 0) return { inserted: 0, fresh: [], updated: 0, rejected };
    return this.exclusive(async () => {
      const fresh: RawEvent[] = [];
      let updated = 0;
      const result = (): InsertResult => ({ inserted: fresh.length, fresh, updated, rejected });
      const insertStmt = this.db.prepare(INSERT_SQL);
      const raiseStmt = this.db.prepare(RAISE_TOKENS_SQL);
      let i = 0;
      try {
        while (i < rows.length) {
          const batchFresh: RawEvent[] = [];
          let batchUpdated = 0;
          await this.db.transaction(() => {
            const start = this.clock();
            for (let n = 1; i < rows.length && n <= this.batchRows; n++) {
              const e = rows[i++]!;
              if (Number(insertStmt.run(...eventParams(e)).changes) === 1) batchFresh.push(e);
              else if (e.source === 'claude-code') {
                const raised = raiseStmt.run(e.promptTokens, e.completionTokens, e.cacheReadTokens, e.cacheCreationTokens, e.thinkingTokens, e.id);
                batchUpdated += Number(raised.changes);
              }
              if (n % CLOCK_CHECK_ROWS === 0 && this.clock() - start >= this.batchMs) break;
            }
          });
          fresh.push(...batchFresh);
          updated += batchUpdated;
          if (batchFresh.length + batchUpdated > 0) this.ownVersion++;
          if (i < rows.length) await yieldToLoop();
        }
        if (fresh.length > 0 && this.countRaw() > this.maxRawEvents) await this.compactLocked(this.now());
      } catch (err) {
        if (fresh.length + updated > 0) throw new PartialInsertError(`insert failed after committing ${fresh.length} new row(s): ${String(err)}`, result(), { cause: err });
        throw err;
      }
      return result();
    });
  }

  compact(now: number = this.now()): Promise<void> {
    return this.exclusive(() => this.compactLocked(now));
  }

  /** Wipes events, meta and ingest state (the "rebuild from the logs" command): the tailer must start over too. */
  clear(): Promise<void> {
    return this.exclusive(async () => {
      await this.db.transaction(() => {
        this.db.exec('DELETE FROM events; DELETE FROM meta; DELETE FROM ingest_state');
      });
      this.ownVersion++;
    });
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  /** Groups of ONE time window (see `aggregateRange` for a long range). Ignores `filter.limit/offset`. */
  aggregate(filter: RecordFilter, window: { fromMs: number; toMs: number }): Promise<AggregateGroup[]> {
    return this.exclusive(() => this.aggregateLocked(filter, window.fromMs, window.toMs));
  }

  /**
   * `aggregate` over a long range, in 7-day windows with a yield between them,
   * concatenated. Interior window edges are multiples of the 15-minute bucket,
   * so no bucket (hence no group) is split between two windows.
   */
  aggregateRange(filter: RecordFilter, range: { fromMs: number; toMs: number }): Promise<AggregateGroup[]> {
    return this.exclusive(async () => {
      const out: AggregateGroup[] = [];
      const firstEdge = bucketStart(range.fromMs) + READ_WINDOW_MS;
      for (let from = range.fromMs, edge = firstEdge; from < range.toMs; from = edge, edge += READ_WINDOW_MS) {
        for (const g of this.aggregateLocked(filter, from, Math.min(edge, range.toMs))) out.push(g);
        if (edge < range.toMs) await yieldToLoop();
      }
      return out;
    });
  }

  private aggregateLocked(filter: RecordFilter, fromMs: number, toMs: number): AggregateGroup[] {
    const lo = Math.max(fromMs, filter.range?.start ?? -Infinity);
    const hi = Math.min(toMs, filter.range?.end ?? Infinity);
    if (!(lo < hi)) return [];
    const where = whereFor(filter, lo, hi);
    return queryRows(this.db.prepareFresh(aggregateSql(where.sql)), where.params).map(toGroup);
  }

  requestsByModelForBranch(branch: string): Promise<Array<{ modelId: string; requests: number }>> {
    return this.exclusive(() =>
      this.db
        .rows('SELECT modelId, SUM(requests) AS requests FROM events WHERE branch = ? GROUP BY modelId ORDER BY modelId', branch)
        .map((r) => ({ modelId: String(r['modelId']), requests: num(r['requests']) })),
    );
  }

  /**
   * Every stored row, newest first (ts DESC, id DESC), in chunks, with a yield
   * between chunks. Each chunk is its own short read (keyset pagination), so a
   * consumer may call other store methods while iterating; rows changed by a
   * concurrent insert or compaction may or may not appear.
   */
  async *exportRows(chunkRows: number = EXPORT_CHUNK_ROWS): AsyncGenerator<RawEvent[]> {
    const select = `SELECT ${COLUMNS} FROM events`;
    const order = `ORDER BY ts DESC, id DESC LIMIT CAST(? AS INTEGER)`;
    const limit = intParam(chunkRows);
    let after: RawEvent | undefined;
    for (;;) {
      const prior = after;
      const chunk = await this.exclusive(() => {
        const stmt = this.db.prepareFresh(prior ? `${select} WHERE ts < ? OR (ts = ? AND id < ?) ${order}` : `${select} ${order}`);
        const params: SqlParam[] = prior ? [prior.ts, prior.ts, prior.id, limit] : [limit];
        return queryRows(stmt, params).map(toEvent);
      });
      if (chunk.length === 0) return;
      yield chunk;
      if (chunk.length < chunkRows) return;
      after = chunk[chunk.length - 1];
      await yieldToLoop();
    }
  }

  /** Number of stored rows (raw and rolled). */
  countEvents(): Promise<number> {
    return this.exclusive(() => num(this.db.get('SELECT count(*) AS c FROM events')!['c']));
  }

  // ── Meta and ingest state ───────────────────────────────────────────────────

  getMeta(key: string): Promise<string | null> {
    return this.exclusive(() => text(this.db.get('SELECT value FROM meta WHERE key = ?', key)?.['value']));
  }

  setMeta(key: string, value: string): Promise<void> {
    return this.exclusive(() => {
      this.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
    });
  }

  getIngestState(file: string): Promise<IngestState | null> {
    return this.exclusive(() => {
      const row = this.db.get('SELECT file, size, mtimeMs, byteOffset, headHash FROM ingest_state WHERE file = ?', file);
      return row === undefined ? null : toIngestState(row);
    });
  }

  /**
   * Remembers how far `file` has been consumed. Write it AFTER the `insert` of
   * the rows read up to `byteOffset`: a crash in between only re-reads rows the
   * insert already knows (ids dedupe), the other order would lose them.
   */
  setIngestState(state: IngestState): Promise<void> {
    return this.exclusive(() => {
      this.db.run(
        `INSERT INTO ingest_state (file, size, mtimeMs, byteOffset, headHash) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(file) DO UPDATE SET size = excluded.size, mtimeMs = excluded.mtimeMs, byteOffset = excluded.byteOffset, headHash = excluded.headHash`,
        state.file, state.size, state.mtimeMs, state.byteOffset, state.headHash,
      );
    });
  }

  deleteIngestState(file: string): Promise<void> {
    return this.exclusive(() => {
      this.db.run('DELETE FROM ingest_state WHERE file = ?', file);
    });
  }

  listIngestState(): Promise<IngestState[]> {
    return this.exclusive(() => this.db.rows('SELECT file, size, mtimeMs, byteOffset, headHash FROM ingest_state ORDER BY file').map(toIngestState));
  }

  // ── Versions and lifecycle ──────────────────────────────────────────────────

  /**
   * Changes whenever the data changed: by this connection (own counter) or by
   * another window/process (`PRAGMA data_version`, polled here, at call time).
   * Keys read caches.
   */
  dataVersion(): number {
    if (!this.db.isClosed) {
      const seen = this.db.dataVersion();
      if (seen !== this.lastDataVersion) {
        this.lastDataVersion = seen;
        this.foreignVersion++;
      }
    }
    return this.ownVersion + this.foreignVersion;
  }

  /** Folds the WAL back into the main file and truncates it. Best effort; call when idle. */
  checkpoint(): Promise<void> {
    return this.exclusive(() => {
      this.tryCheckpoint();
    });
  }

  private tryCheckpoint(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (err) {
      this.logger.debug('store', `wal checkpoint skipped: ${String(err)}`);
    }
  }

  /** Stops accepting work, finishes what is running, checkpoints the WAL and closes. Idempotent. */
  close(): Promise<void> {
    if (this.closing === undefined) {
      this.disposed = true;
      this.closing = this.acquire().then((release) => {
        this.tryCheckpoint();
        this.db.close();
        release();
      });
    }
    return this.closing;
  }

  /** Synchronous `close()` for `Disposable`: the connection closes once running work is done. */
  dispose(): void {
    void this.close();
  }

  // ── Compaction ──────────────────────────────────────────────────────────────

  private countRaw(): number {
    return num(this.db.get(`SELECT count(*) AS c FROM events WHERE ${NOT_ROLLED}`)!['c']);
  }

  /**
   * Rolls raw events older than `retentionDays` (a local midnight cutoff) into
   * per-local-day rows, and, if more than `maxRawEvents` raw rows would still
   * remain, the oldest whole days beyond that (never today). Each chunk of days is
   * one transaction: the rollup upsert and the delete of the rows it replaced
   * commit together, and the event loop is released between slices.
   */
  private async compactLocked(now: number): Promise<void> {
    let cutoff = retentionCutoff(now, this.retentionDays);
    const kept = num(this.db.get(`SELECT count(*) AS c FROM events WHERE ts >= ? AND ${NOT_ROLLED}`, cutoff)!['c']);
    if (kept > this.maxRawEvents) {
      const over = this.db.get(`SELECT ts FROM events WHERE ts >= ? AND ${NOT_ROLLED} ORDER BY ts LIMIT 1 OFFSET ?`, cutoff, intParam(kept - this.maxRawEvents - 1))!;
      cutoff = Math.max(cutoff, capCutoff(num(over['ts']), now));
    }
    let changed = false;
    for (;;) {
      const oldest = this.db.get(`SELECT ts FROM events WHERE ts < ? AND ${NOT_ROLLED} ORDER BY ts LIMIT 1`, cutoff);
      if (oldest === undefined) break;
      const edge = this.db.get(`SELECT ts FROM events WHERE ts < ? AND ${NOT_ROLLED} ORDER BY ts LIMIT 1 OFFSET ?`, cutoff, intParam(this.compactChunkRows));
      const chunkCutoff = edge === undefined ? cutoff : Math.min(cutoff, nextBucketStart(num(edge['ts']), 'day'));
      await this.rollChunk(chunkCutoff);
      changed = true;
      if (chunkCutoff >= cutoff) break;
      await yieldToLoop();
    }
    if (changed) this.ownVersion++;
  }

  private async rollChunk(chunkCutoff: number): Promise<void> {
    await this.db.transaction(async () => {
      const rolled = new Map<string, RawEvent>();
      let n = 0;
      for (const row of this.db.prepareFresh(`SELECT ${COLUMNS} FROM events WHERE ts < ? AND ${NOT_ROLLED}`).iterate(chunkCutoff)) {
        const e = toEvent(row);
        const id = rollId(e);
        const add = toRolledRow(e, id);
        const into = rolled.get(id);
        rolled.set(id, into === undefined ? add : mergeRolledRow(into, add));
        if (++n % ROLL_YIELD_ROWS === 0) await yieldToLoop();
      }
      const upsert = this.db.prepare(ROLL_UPSERT_SQL);
      for (const r of rolled.values()) {
        upsert.run(r.id, r.ts, r.modelId, r.surface, r.source, r.repo, r.attribution, r.requests, r.promptTokens, r.completionTokens, r.cacheReadTokens, r.cacheCreationTokens, r.thinkingTokens);
      }
      const slice = `DELETE FROM events WHERE rowid IN (SELECT rowid FROM events WHERE ts < ? AND ${NOT_ROLLED} ORDER BY ts LIMIT ?)`;
      for (let removed = DELETE_SLICE_ROWS; removed === DELETE_SLICE_ROWS; ) {
        removed = this.db.run(slice, chunkCutoff, intParam(DELETE_SLICE_ROWS));
        if (removed === DELETE_SLICE_ROWS) await yieldToLoop();
      }
    });
  }
}

function toIngestState(row: SqlRow): IngestState {
  return {
    file: String(row['file']),
    size: num(row['size']),
    mtimeMs: num(row['mtimeMs']),
    byteOffset: num(row['byteOffset']),
    headHash: String(row['headHash']),
  };
}

const SILENT: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

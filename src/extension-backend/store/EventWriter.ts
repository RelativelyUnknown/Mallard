/* c8 ignore next */
import { DuckDBConnection } from '@duckdb/node-api';
import { UsageEvent } from '../domain/types';
import { UNATTRIBUTED_REPO } from '../domain/aggregate';
import { dayStartOffset, nextBucketStart, startOf } from '../util/time';
import {
  CLEAR_ALL_SQL,
  CLEAR_STAGING,
  COMPACT_CHECK_SQL,
  COMPACT_DELETE_SQL,
  COMPACT_ROLLUP_SQL,
  COUNT_EVENTS_SQL,
  DELETE_FACTS_WINDOW_SQL,
  INSERT_STAGING_MERGE,
  MAX_RAW_EVENTS,
  RAW_WINDOW_DAYS,
  REFRESH_FACTS_INSERT_MODELS_SQL,
  REFRESH_FACTS_INSERT_REPOS_SQL,
  REFRESH_FACTS_SQL,
} from './schema';
import type { RecordFilter } from './EventRepository';
import type { SnapshotCacheToken } from './EventReader';
import { FilterClauseBuilder } from './FilterClauseBuilder';
import { dateToId, readPrepared, readRows, runPrepared } from './dbUtils';

/** Latest epoch-ms a JS Date can represent — "no upper bound" for a fact window. */
const MAX_DATE_MS = 8_640_000_000_000_000;

// ── Interface ─────────────────────────────────────────────────────────────────

export interface IEventWriter {
  insert(records: UsageEvent[]): Promise<number>;
  remove(filter: RecordFilter): Promise<number>;
  compact(now?: number): Promise<void>;
  clear(): Promise<void>;
  setPrices(entries: ReadonlyArray<{ modelId: string; multiplier: number }>): Promise<void>;
}

// ── Implementation ────────────────────────────────────────────────────────────

/**
 * All mutations run one at a time (`exclusive`) on a connection nothing else
 * uses, and each multi-statement mutation is a single transaction. Without
 * that, two concurrent writers shared the `events_staging` table and each
 * other's half-finished statements (an insert racing a compact could roll up
 * rows it then deleted before they were merged).
 *
 * `conn` must be dedicated to this writer: a transaction is per-connection, so
 * anything else running on it would join the open transaction. Readers use a
 * separate connection and only ever see committed state.
 */
export class EventWriter implements IEventWriter {
  private readonly retentionDays: number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly conn: DuckDBConnection,
    retentionDays = RAW_WINDOW_DAYS,
    private readonly cacheToken: SnapshotCacheToken = { version: 0 },
    /**
     * False for a private in-memory store (see EventStore.open): that store
     * re-ingests the whole history, which must not be streamed to the exporter
     * a second time.
     */
    private readonly emitInserted = true,
  ) {
    this.retentionDays = retentionDays;
  }

  /** Invalidate the reader's memoized no-filter snapshot after any mutation. */
  private bumpCache(): void {
    this.cacheToken.version++;
  }

  /** Run `task` after every earlier mutation has settled (success or failure). */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** BEGIN/COMMIT around `fn`; ROLLBACK (and rethrow) on error. Call inside `exclusive`. */
  private async transaction<T>(fn: () => Promise<T>): Promise<T> {
    await this.conn.run('BEGIN TRANSACTION');
    try {
      const result = await fn();
      await this.conn.run('COMMIT');
      return result;
    } catch (err) {
      await this.conn.run('ROLLBACK').catch(() => undefined);
      throw err;
    }
  }

  insert(records: UsageEvent[]): Promise<number> {
    if (records.length === 0) return Promise.resolve(0);
    return this.exclusive(async () => {
      // Refresh facts over the actual day-span of the inserted records, not just
      // today. Ingesting historical logs (a backfill of older sessions) writes
      // rows dated in the past; refreshing only today's window left those days'
      // fact_daily_usage empty until compact() eventually ran a full rebuild.
      let minTs = records[0]!.ts;
      let maxTs = records[0]!.ts;
      for (const r of records) {
        if (r.ts < minTs) minTs = r.ts;
        if (r.ts > maxTs) maxTs = r.ts;
      }
      // Events and their facts commit together. The window end is the next local
      // midnight — `+ DAY_MS` falls an hour short on a 25h (DST fall-back) day
      // and dropped that day's last hour from the facts.
      const { inserted, fresh } = await this.transaction(async () => {
        const result = await this.insertAll(records);
        if (result.inserted > 0) {
          await this.rebuildFacts(startOf(minTs, 'day'), nextBucketStart(maxTs, 'day'));
        }
        return result;
      });
      // Every row already stored (a re-read at the ingest watermark): nothing
      // changed, so keep the facts and the snapshot memo as they are.
      if (inserted === 0) return 0;
      // After the commit, so a reader that sees the new version also sees the data.
      this.bumpCache();
      if (fresh.length > 0 && this.emitInserted) this.onInserted?.(fresh);
      if ((await this.countAll()) > MAX_RAW_EVENTS) await this.compactLocked();
      return inserted;
    });
  }

  /**
   * Deletes every event matching `filter`'s range/models/surfaces/sources/
   * branches/repos. `limit`/`offset` are read-pagination controls and are
   * ignored: a filter carrying nothing else matches no rows and removes
   * nothing (returns 0) rather than wiping the table.
   */
  remove(filter: RecordFilter): Promise<number> {
    const fb = new FilterClauseBuilder()
      .addRange(filter.range, 'ts')
      .addIn(filter.models, 'modelId')
      .addIn(filter.surfaces, 'surface')
      .addIn(filter.sources, 'source')
      .addIn(filter.branches, 'branch')
      .addRepos(filter.repos, 'repo', 'repo IS NULL');
    const clause = fb.build();
    if (!clause) return Promise.resolve(0);

    return this.exclusive(async () => {
      const removed = await this.transaction(async () => {
        const [span] = await readPrepared(
          this.conn,
          `SELECT MIN(ts) AS lo, MAX(ts) AS hi FROM events ${clause}`,
          fb.params,
          (r) => (r['lo'] == null ? null : { lo: Number(r['lo']), hi: Number(r['hi']) }),
        );
        const count = await runPrepared(this.conn, `DELETE FROM events ${clause}`, fb.params);
        // Facts of the affected days no longer match the events — rebuild them.
        if (count > 0 && span) {
          await this.rebuildFacts(startOf(span.lo, 'day'), nextBucketStart(span.hi, 'day'));
        }
        return count;
      });
      this.bumpCache();
      return removed;
    });
  }

  compact(now = Date.now()): Promise<void> {
    return this.exclusive(() => this.compactLocked(now));
  }

  async clear(): Promise<void> {
    await this.exclusive(async () => {
      await this.transaction(() => this.conn.run(CLEAR_ALL_SQL));
      this.bumpCache();
    });
  }

  async setPrices(entries: ReadonlyArray<{ modelId: string; multiplier: number }>): Promise<void> {
    await this.exclusive(async () => {
      // DELETE + INSERT are one unit: a failing entry must not leave the table empty.
      await this.transaction(async () => {
        await this.conn.run('DELETE FROM prices');
        if (entries.length === 0) return;
        const stmt = await this.conn.prepare(
          `INSERT INTO prices (modelId, multiplier) VALUES (?, ?)`,
        );
        for (const e of entries) {
          stmt.bindVarchar(1, e.modelId);
          stmt.bindDouble(2, e.multiplier);
          await stmt.run();
        }
      });
      this.bumpCache();
    });
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async countAll(): Promise<number> {
    const rows = await readRows(this.conn, COUNT_EVENTS_SQL, (r) => Number(r['c']));
    /* c8 ignore next */
    return rows[0] ?? 0;
  }

  /**
   * Roll raw events older than the retention window up into per-day rows.
   * The cutoff is a local midnight (calendar-day arithmetic, DST-correct) and
   * events strictly before it are rolled — an event exactly at the cutoff stays
   * raw. Day alignment matters: the rollup groups whole local days, so a
   * mid-day cutoff would fold a day's later events into the roll row while
   * leaving them raw too (double count).
   *
   * Rollup (an upsert that adds into existing roll rows) + delete + fact
   * rebuild are one transaction. Known limit: raw events deleted by an earlier
   * compaction cannot be recognised if a log is re-ingested from scratch, so
   * such re-reads are counted again.
   */
  private async compactLocked(now = Date.now()): Promise<void> {
    const cutoff = BigInt(dayStartOffset(now, -this.retentionDays));
    const [count] = await readPrepared(this.conn, COMPACT_CHECK_SQL, [cutoff], (r) => Number(r['c']));
    /* c8 ignore next */
    if (!count) return;

    await this.transaction(async () => {
      await runPrepared(this.conn, COMPACT_ROLLUP_SQL, [cutoff]);
      await runPrepared(this.conn, COMPACT_DELETE_SQL, [cutoff]);
      await this.rebuildFacts();
    });
    this.bumpCache();
  }

  /**
   * Called with the events that actually survived the INSERT OR IGNORE merge
   * (new ids only, in-batch duplicates collapsed) — the hook the streaming
   * exporter hangs off. Deliberately a plain callback, not a vscode
   * EventEmitter: the store layer stays framework-free.
   */
  onInserted?: (events: UsageEvent[]) => void;

  /** Merges `events` into the table (inside the caller's transaction). */
  private async insertAll(events: UsageEvent[]): Promise<{ inserted: number; fresh: UsageEvent[] }> {
    // Collapse in-batch duplicates (first occurrence wins, matching INSERT OR
    // IGNORE) and find which ids already exist so the merge delta is exact.
    const seen = new Set<string>();
    const unique = events.filter((e) => !seen.has(e.id) && (seen.add(e.id), true));
    const existing = new Set<string>();
    const CHUNK = 5_000;
    for (let i = 0; i < unique.length; i += CHUNK) {
      const chunk = unique.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = await readPrepared(
        this.conn,
        `SELECT id FROM events WHERE id IN (${placeholders})`,
        chunk.map((e) => e.id),
        (r) => String(r['id']),
      );
      for (const id of rows) existing.add(id);
    }

    await this.conn.run('DELETE FROM events_staging');

    const appender = await this.conn.createAppender('events_staging');
    for (const e of events) {
      appender.appendVarchar(e.id);
      appender.appendBigInt(BigInt(e.ts));
      appender.appendVarchar(e.modelId);
      appender.appendVarchar(e.surface);
      appender.appendVarchar(e.source);
      appender.appendDouble(e.credits);
      appender.appendDouble(e.cost);
      if (e.promptTokens != null)     appender.appendInteger(e.promptTokens);     else appender.appendNull();
      if (e.completionTokens != null) appender.appendInteger(e.completionTokens); else appender.appendNull();
      appender.appendBoolean(e.estimated);
      if (e.repo != null)             appender.appendVarchar(e.repo);             else appender.appendNull();
      if (e.costByCategory)           appender.appendVarchar(JSON.stringify(e.costByCategory)); else appender.appendNull();
      if (e.branch != null)           appender.appendVarchar(e.branch);           else appender.appendNull();
      if (e.attribution != null)      appender.appendVarchar(e.attribution);      else appender.appendNull();
      if (e.language != null)         appender.appendVarchar(e.language);         else appender.appendNull();
      appender.endRow();
    }
    appender.flushSync();
    appender.closeSync();

    const before = await this.countAll();
    await this.conn.run(INSERT_STAGING_MERGE);
    const after  = await this.countAll();
    await this.conn.run(CLEAR_STAGING);

    return { inserted: after - before, fresh: unique.filter((e) => !existing.has(e.id)) };
  }

  /**
   * Rebuilds `fact_daily_usage` for the day window [windowStart, windowEnd) —
   * everything when no window is given. Must run inside a transaction. The
   * window is cleared first: INSERT OR REPLACE alone never deletes a group
   * whose events were removed or rolled away, leaving stale facts. Window
   * bounds are local midnights, so the date_id range and the ts range select
   * the same rows.
   */
  private async rebuildFacts(windowStart = 0, windowEnd = MAX_DATE_MS): Promise<void> {
    await this.conn.run(REFRESH_FACTS_INSERT_MODELS_SQL);
    await this.conn.run(REFRESH_FACTS_INSERT_REPOS_SQL);
    await runPrepared(this.conn, DELETE_FACTS_WINDOW_SQL, [dateToId(windowStart), dateToId(windowEnd)]);
    await runPrepared(this.conn, REFRESH_FACTS_SQL, [BigInt(windowStart), BigInt(windowEnd)]);
  }
/* c8 ignore next */
}

export { UNATTRIBUTED_REPO };

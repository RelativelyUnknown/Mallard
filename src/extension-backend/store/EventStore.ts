/* c8 ignore next */
/**
 * Lifecycle facade for the DuckDB-backed event store.
 *
 * Responsibilities: open/close the database, run DDL, construct and expose the
 * purpose-built reader, writer, meta, and file-reader objects. All business
 * logic lives in those classes — EventStore stays thin.
 */
import { mkdirSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DuckDBInstance, DuckDBConnection } from '@duckdb/node-api';
import { CREATE_SQL } from './schema';
import { EventWriter } from './EventWriter';
import { EventReader } from './EventReader';
import { MetaStore } from './MetaStore';
import { DuckDBFileReader } from './DuckDBFileReader';
import { runMigrations } from './migrations';
import { defaultLogger, Logger } from '../util/logger';

/**
 * DuckDB allows one read-write process per database file. The error text
 * differs per platform ("Conflicting lock is held in …" on POSIX, "being used
 * by another process" on Windows).
 */
const LOCK_CONFLICT = /Could not set lock|Conflicting lock|being used by another process|database is locked/i;

async function openInstance(
  file: string,
  logger: Logger,
): Promise<{ instance: DuckDBInstance; inMemory: boolean }> {
  try {
    return { instance: await DuckDBInstance.create(file), inMemory: false };
  } catch (err) {
    if (!LOCK_CONFLICT.test(String(err))) throw err;
    // Another VS Code window owns the file. A read-only open cannot coexist
    // with that read-write holder, so this window gets a private in-memory
    // store: it rebuilds its history from the logs, persists nothing, and never
    // re-exports it (see EventWriter's `emitInserted`).
    logger.warn(
      'store',
      `${file} is locked by another VS Code window (${String(err)}); ` +
        'using a private in-memory store for this window — usage is rebuilt from the logs and not persisted.',
    );
    return { instance: await DuckDBInstance.create(':memory:'), inMemory: true };
  }
}

export class EventStore implements vscode.Disposable {
  readonly reader: EventReader;
  readonly writer: EventWriter;
  readonly meta: MetaStore;
  readonly fileReader: DuckDBFileReader;

  /**
   * True when events.duckdb was locked by another window and this store is a
   * private, non-persistent in-memory database instead.
   */
  readonly inMemory: boolean;

  /**
   * Connections: `conn` serves meta and the file reader, `readConn` the reader
   * (committed state only), `writeConn` belongs to the writer alone — its
   * transactions would otherwise swallow other users' statements.
   */
  private constructor(
    private readonly instance: DuckDBInstance,
    readonly conn: DuckDBConnection,
    private readonly readConn: DuckDBConnection,
    private readonly writeConn: DuckDBConnection,
    inMemory: boolean,
    retentionDays?: number,
  ) {
    this.inMemory   = inMemory;
    this.meta       = new MetaStore(conn);
    // Shared token: the writer bumps it on every mutation so the reader's
    // no-filter snapshot memo self-invalidates without a separate materialization.
    const cacheToken = { version: 0 };
    this.reader     = new EventReader(readConn, cacheToken);
    this.writer     = new EventWriter(writeConn, retentionDays, cacheToken, !inMemory);
    this.fileReader = new DuckDBFileReader(conn, this.writer);
  }

  static async open(
    dir: string,
    retentionDays?: number,
    logger: Logger = defaultLogger,
  ): Promise<EventStore> {
    mkdirSync(dir, { recursive: true });
    const { instance, inMemory } = await openInstance(path.join(dir, 'events.duckdb'), logger);
    const conn = await instance.connect();
    const readConn = await instance.connect();
    const writeConn = await instance.connect();

    // Set session timezone so all TIMESTAMPTZ operations use local time (DST-correct).
    // It is a per-connection setting, so every connection gets it.
    /* c8 ignore start */
    let tz: string;
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone; }
    catch { tz = 'UTC'; }
    /* c8 ignore stop */
    for (const c of [conn, readConn, writeConn]) {
      await c.run(`SET TimeZone = '${tz.replace(/'/g, "''")}'`);
    }

    await conn.run(CREATE_SQL);
    await runMigrations(conn, new MetaStore(conn));
    return new EventStore(instance, conn, readConn, writeConn, inMemory, retentionDays);
  }

  // ── Convenience passthroughs ───────────────────────────────────────────────

  count(filter?: Parameters<EventReader['count']>[0]): Promise<number> {
    return this.reader.count(filter);
  }

  getMeta(key: string): Promise<string | null> { return this.meta.get(key); }
  setMeta(key: string, value: string): Promise<void> { return this.meta.set(key, value); }
  compact(now?: number): Promise<void> { return this.writer.compact(now); }

  /** Full wipe — events, meta, facts, dimension tables, snap cache. */
  clear(): Promise<void> { return this.writer.clear(); }

  dispose(): void {
    for (const c of [this.conn, this.readConn, this.writeConn]) {
      /* c8 ignore next */
      try { c.closeSync(); } catch { /* ignore */ }
    }
    /* c8 ignore next */
    try { this.instance.closeSync(); } catch { /* ignore */ }
  }
}

// ── rollupEvents ──────────────────────────────────────────────────────────────

import { CostCategory, UsageEvent } from '../domain/types';
import { UNATTRIBUTED_REPO } from '../domain/aggregate';
import { startOf } from '../util/time';

type Categories = Partial<Record<CostCategory, number>>;

function addCategories(a?: Categories, b?: Categories): Categories | undefined {
  if (!a && !b) return undefined;
  /* c8 ignore next */
  const out: Categories = { ...(a ?? {}) };
  /* c8 ignore next */
  for (const [k, v] of Object.entries(b ?? {})) {
    /* c8 ignore next */
    out[k as CostCategory] = (out[k as CostCategory] ?? 0) + (v ?? 0);
  }
  return out;
}

/** Collapse old per-request events into one row per day/model/repo/surface. */
/* c8 ignore next */
export function rollupEvents(old: UsageEvent[]): UsageEvent[] {
  const map = new Map<string, UsageEvent>();
  for (const e of old) {
    const day = startOf(e.ts, 'day');
    /* c8 ignore next */
    const key = `roll:${day}:${e.modelId}:${e.repo ?? UNATTRIBUTED_REPO}:${e.surface}`;
    const existing = map.get(key);
    if (existing) {
      existing.credits += e.credits;
      existing.cost += e.cost;
      existing.promptTokens = (existing.promptTokens ?? 0) + (e.promptTokens ?? 0);
      existing.completionTokens = (existing.completionTokens ?? 0) + (e.completionTokens ?? 0);
      const merged = addCategories(existing.costByCategory, e.costByCategory);
      if (merged) existing.costByCategory = merged;
    } else {
      map.set(key, { ...e, id: key, ts: day, estimated: true });
    }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts);
}

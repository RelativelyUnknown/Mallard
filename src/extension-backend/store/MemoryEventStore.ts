/**
 * In-memory `IUsageStore` for the driver-missing path (no `node:sqlite`): the
 * same insert/fresh/Claude-upsert/aggregate/compact/export semantics as the
 * SQLite store, built on the TypeScript reference in `domain/groupEvents.ts`,
 * with no persistence (history is rebuilt from the logs on every start).
 */
import type { AggregateGroup, IngestState, InsertResult, IUsageStore, RawEvent } from '../domain/contracts';
import { capCutoff, filterEvents, groupEvents, isRolledId, mergeRolledRow, retentionCutoff, rollUpGroups } from '../domain/groupEvents';
import type { Logger } from '../util/logger';
import type { RecordFilter } from './EventRepository';
import { mergeClaudeDuplicate, prepareRows } from './eventRules';
import { MAX_RAW_EVENTS, RAW_WINDOW_DAYS } from './schema/constants';

export interface MemoryStoreOptions {
  retentionDays?: number;
  now?: () => number;
  maxRawEvents?: number;
  logger?: Logger;
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class MemoryEventStore implements IUsageStore {
  private readonly events = new Map<string, RawEvent>();
  private readonly meta = new Map<string, string>();
  private readonly ingest = new Map<string, IngestState>();
  private version = 0;
  private readonly retentionDays: number;
  private readonly now: () => number;
  private readonly maxRawEvents: number;
  private readonly logger: Logger | undefined;

  constructor(opts: MemoryStoreOptions = {}) {
    this.retentionDays = opts.retentionDays ?? RAW_WINDOW_DAYS;
    this.now = opts.now ?? Date.now;
    this.maxRawEvents = opts.maxRawEvents ?? MAX_RAW_EVENTS;
    this.logger = opts.logger;
  }

  insert(events: RawEvent[]): Promise<InsertResult> {
    const { rows, rejected, firstRejected } = prepareRows(events);
    if (rejected > 0) this.logger?.warn('store', `refused ${rejected} invalid event(s), e.g. ${firstRejected}`);
    const fresh: RawEvent[] = [];
    let updated = 0;
    for (const e of rows) {
      const stored = this.events.get(e.id);
      if (stored === undefined) {
        this.events.set(e.id, e);
        fresh.push(e);
      } else if (e.source === 'claude-code' && stored.source === 'claude-code') {
        const merged = mergeClaudeDuplicate(stored, e);
        if (JSON.stringify(merged) !== JSON.stringify(stored)) {
          this.events.set(e.id, merged);
          updated++;
        }
      }
    }
    if (fresh.length + updated > 0) this.version++;
    if (fresh.length > 0 && this.rawRows().length > this.maxRawEvents) this.compactNow(this.now());
    return Promise.resolve({ inserted: fresh.length, fresh, updated, rejected });
  }

  aggregate(filter: RecordFilter, window: { fromMs: number; toMs: number }): Promise<AggregateGroup[]> {
    const range = { start: Math.max(window.fromMs, filter.range?.start ?? -Infinity), end: Math.min(window.toMs, filter.range?.end ?? Infinity) };
    return Promise.resolve(groupEvents(filterEvents([...this.events.values()], { ...filter, range })));
  }

  aggregateRange(filter: RecordFilter, range: { fromMs: number; toMs: number }): Promise<AggregateGroup[]> {
    return this.aggregate(filter, range);
  }

  requestsByModelForBranch(branch: string): Promise<Array<{ modelId: string; requests: number }>> {
    const byModel = new Map<string, number>();
    for (const e of this.events.values()) if (e.branch === branch) byModel.set(e.modelId, (byModel.get(e.modelId) ?? 0) + e.requests);
    return Promise.resolve([...byModel.entries()].sort(([a], [b]) => byText(a, b)).map(([modelId, requests]) => ({ modelId, requests })));
  }

  async *exportRows(chunkRows = 5_000): AsyncGenerator<RawEvent[]> {
    const all = [...this.events.values()].sort((a, b) => b.ts - a.ts || byText(b.id, a.id));
    for (let i = 0; i < all.length; i += chunkRows) {
      yield all.slice(i, i + chunkRows);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  compact(now: number = this.now()): Promise<void> {
    this.compactNow(now);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.events.clear();
    this.meta.clear();
    this.ingest.clear();
    this.version++;
    return Promise.resolve();
  }

  dataVersion(): number {
    return this.version;
  }

  countEvents(): Promise<number> {
    return Promise.resolve(this.events.size);
  }

  getMeta(key: string): Promise<string | null> {
    return Promise.resolve(this.meta.get(key) ?? null);
  }

  setMeta(key: string, value: string): Promise<void> {
    this.meta.set(key, value);
    return Promise.resolve();
  }

  getIngestState(file: string): Promise<IngestState | null> {
    const s = this.ingest.get(file);
    return Promise.resolve(s === undefined ? null : { ...s });
  }

  setIngestState(state: IngestState): Promise<void> {
    this.ingest.set(state.file, { ...state });
    return Promise.resolve();
  }

  deleteIngestState(file: string): Promise<void> {
    this.ingest.delete(file);
    return Promise.resolve();
  }

  listIngestState(): Promise<IngestState[]> {
    return Promise.resolve([...this.ingest.values()].sort((a, b) => byText(a.file, b.file)).map((s) => ({ ...s })));
  }

  checkpoint(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  dispose(): void {
    // Nothing to release.
  }

  private rawRows(): RawEvent[] {
    return [...this.events.values()].filter((e) => !isRolledId(e.id));
  }

  /** Same algorithm as the SQLite store: retention cutoff, then the oldest whole days beyond the raw-row cap (never today). */
  private compactNow(now: number): void {
    let cutoff = retentionCutoff(now, this.retentionDays);
    const kept = this.rawRows().filter((e) => e.ts >= cutoff).sort((a, b) => a.ts - b.ts);
    if (kept.length > this.maxRawEvents) cutoff = Math.max(cutoff, capCutoff(kept[kept.length - this.maxRawEvents - 1]!.ts, now));
    const old = this.rawRows().filter((e) => e.ts < cutoff);
    if (old.length === 0) return;
    for (const r of rollUpGroups(old).rolled) {
      const existing = this.events.get(r.id);
      this.events.set(r.id, existing === undefined ? r : mergeRolledRow(existing, r));
    }
    for (const e of old) this.events.delete(e.id);
    this.version++;
  }
}

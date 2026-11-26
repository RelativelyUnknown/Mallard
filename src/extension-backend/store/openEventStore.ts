/**
 * The store the extension runs on: SQLite when `node:sqlite` is available, an
 * in-memory fallback when it is not (VS Code older than 1.101, a fork without
 * the module) or when the file was written by a newer Mallard. The fallback
 * result carries the reason, so the wiring shows ONE actionable message and
 * carries on.
 */
import { MemoryEventStore } from './MemoryEventStore';
import { SqliteUnavailableError } from './sqlite/Db';
import { SchemaTooNewError } from './sqlite/schema';
import { SqliteEventStore } from './sqlite/SqliteEventStore';
import type { SqliteStoreOptions } from './sqlite/SqliteEventStore';

export type StoreUnavailableError = SqliteUnavailableError | SchemaTooNewError;

export type OpenedEventStore =
  | { store: SqliteEventStore; unavailable?: undefined }
  | { store: MemoryEventStore; unavailable: StoreUnavailableError };

/**
 * Opens `<dir>/events.sqlite` (or ':memory:'); falls back to a
 * {@link MemoryEventStore} on SqliteUnavailableError / SchemaTooNewError. Other
 * errors (disk, permissions, corruption) propagate.
 */
export async function openEventStore(dir: string, opts: SqliteStoreOptions = {}): Promise<OpenedEventStore> {
  try {
    return { store: await SqliteEventStore.open(dir, opts) };
  } catch (err) {
    if (err instanceof SqliteUnavailableError || err instanceof SchemaTooNewError) {
      return {
        store: new MemoryEventStore({
          ...(opts.retentionDays !== undefined ? { retentionDays: opts.retentionDays } : {}),
          ...(opts.now ? { now: opts.now } : {}),
          ...(opts.maxRawEvents !== undefined ? { maxRawEvents: opts.maxRawEvents } : {}),
          ...(opts.logger ? { logger: opts.logger } : {}),
        }),
        unavailable: err,
      };
    }
    throw err;
  }
}

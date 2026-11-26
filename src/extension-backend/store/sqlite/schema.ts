/**
 * Schema and migrations of `events.sqlite`.
 *
 * The schema version lives in `PRAGMA user_version`. Version 1 is the schema
 * below. A migration list is applied in order inside one `BEGIN IMMEDIATE`
 * transaction (so two windows opening the same file at once migrate it once),
 * and a database written by a NEWER Mallard is refused, never downgraded or wiped.
 */
import type { Db } from './Db';

/** Name of the database file inside the store directory. */
export const DB_FILE_NAME = 'events.sqlite';

export interface Migration {
  /** The `user_version` this migration produces. Strictly increasing from 1. */
  version: number;
  sql: string;
}

const V1 = `
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  modelId TEXT NOT NULL,
  surface TEXT NOT NULL,
  source TEXT NOT NULL,
  repo TEXT,
  branch TEXT,
  attribution TEXT,
  language TEXT,
  requests INTEGER NOT NULL DEFAULT 1,
  promptTokens INTEGER,
  completionTokens INTEGER,
  cacheReadTokens INTEGER NOT NULL DEFAULT 0,
  cacheCreationTokens INTEGER NOT NULL DEFAULT 0,
  thinkingTokens INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX events_ts ON events(ts);
CREATE INDEX events_model ON events(modelId);
CREATE INDEX events_repo ON events(repo);
CREATE INDEX events_agg ON events(ts, modelId, surface, source);

CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE ingest_state (
  file TEXT PRIMARY KEY,
  size INTEGER,
  mtimeMs INTEGER,
  byteOffset INTEGER,
  headHash TEXT
);
`;

export const MIGRATIONS: readonly Migration[] = [{ version: 1, sql: V1 }];

/** The newest schema version this build writes. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** The file was written by a newer Mallard than this one. Nothing was changed. */
export class SchemaTooNewError extends Error {
  constructor(readonly found: number, readonly supported: number) {
    super(
      `${DB_FILE_NAME} has schema version ${found}, but this version of Mallard only understands up to ${supported}. ` +
        'It was written by a newer Mallard: update the extension. The file was left untouched; ' +
        'until then Mallard keeps usage in memory only, so it is lost when the window closes.',
    );
    this.name = 'SchemaTooNewError';
  }
}

export function readUserVersion(db: Db): number {
  return Number(db.get('PRAGMA user_version')?.['user_version']);
}

/**
 * Brings the database to the newest version. Up-to-date databases are
 * recognised without taking the write lock. Throws {@link SchemaTooNewError}
 * for a database from the future.
 */
export async function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  const latest = migrations[migrations.length - 1]!.version;
  const check = (found: number): boolean => {
    if (found > latest) throw new SchemaTooNewError(found, latest);
    return found === latest;
  };
  if (check(readUserVersion(db))) return;
  await db.transaction(() => {
    // Re-read under the write lock: another window may have migrated meanwhile.
    const found = readUserVersion(db);
    if (check(found)) return;
    for (const m of migrations) {
      if (m.version <= found) continue;
      db.exec(m.sql);
      // PRAGMA takes no bound parameter; the version is a number from the table above.
      db.exec(`PRAGMA user_version = ${Math.trunc(m.version)}`);
    }
  });
}

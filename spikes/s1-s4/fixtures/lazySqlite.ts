// Mirrors the plan's store/sqlite/Db.ts loader shape (A2): lazy require in try/catch with an INJECTABLE
// loader so the "driver missing" path is unit-testable. Type-only import is erased by esbuild.
import type * as SqliteNS from 'node:sqlite';

export type SqliteModule = typeof SqliteNS;
export type LoadResult =
  | { ok: true; mod: SqliteModule }
  | { ok: false; code: string | undefined; message: string };

export function loadSqlite(loader: () => SqliteModule = () => require('node:sqlite')): LoadResult {
  try {
    return { ok: true, mod: loader() };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { ok: false, code: err.code, message: err.message };
  }
}

export async function loadSqliteViaImport(): Promise<LoadResult> {
  try {
    return { ok: true, mod: await import('node:sqlite') };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return { ok: false, code: err.code, message: err.message };
  }
}

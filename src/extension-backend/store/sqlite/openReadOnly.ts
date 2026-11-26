/**
 * Read-only access to a SQLite database another program owns (Copilot's span
 * database), possibly while that program is writing to it.
 *
 * `{readOnly: true}` reads a live WAL database fine, including its
 * un-checkpointed content, and never creates files next to it (spike S1 5a to
 * 5d, 5j). It fails on a READ-ONLY FILESYSTEM when the `-wal`/`-shm` files do
 * not exist: the open succeeds, the first read fails with "unable to open
 * database file" (errcode 14; S1 5l, reproduced with a real read-only bind mount).
 * Then, in order:
 *  1. `VACUUM INTO` a temp file from the read-only connection (a consistent
 *     snapshot; works whenever that connection can read at all, e.g. after a
 *     transient failure);
 *  2. copy the database file (and its `-wal` if there is one) to a temp
 *     directory and open the copy (S1 5n). A cleanly closed writer leaves no
 *     `-wal`, which is exactly the situation in which the plain open fails, so the
 *     bare file is a complete snapshot.
 * `immutable=1` is not used: it ignores a live WAL and needs URI paths, which
 * Electron 35.0 to 35.4 lacks.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from './Db';
import type { DbOptions } from './Db';

export type ReadOnlyMode = 'direct' | 'snapshot' | 'copy';

export interface ReadOnlyHandle {
  db: Db;
  /** 'direct': the file itself; 'snapshot': a `VACUUM INTO` copy; 'copy': a file copy. The last two do not follow later writes. */
  mode: ReadOnlyMode;
  /** Closes the connection and removes the temp copy, if any. Idempotent. */
  close(): void;
}

export interface OpenReadOnlyOptions extends Pick<DbOptions, 'loader'> {
  /** Directory for the fallback copies (default: the OS temp dir). */
  tmpDir?: string;
  /** Checks that `db` can really read (default: read the schema table). Called for each stage; throw to reject it. Tests inject failures. */
  probe?: (db: Db, stage: ReadOnlyMode) => void;
}

const defaultProbe = (db: Db): void => {
  db.get('SELECT count(*) AS c FROM sqlite_master');
};

export function openReadOnly(file: string, opts: OpenReadOnlyOptions = {}): ReadOnlyHandle {
  const probe = opts.probe ?? defaultProbe;
  const open = (target: string): Db => Db.open(target, { readOnly: true, ...(opts.loader ? { loader: opts.loader } : {}) });
  const verified = (target: string, stage: ReadOnlyMode): Db => {
    const db = open(target);
    try {
      probe(db, stage);
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  };

  const direct = open(file);
  try {
    probe(direct, 'direct');
    return { db: direct, mode: 'direct', close: () => direct.close() };
  } catch {
    // Fall through to the copies below.
  }

  const dir = fs.mkdtempSync(path.join(opts.tmpDir ?? os.tmpdir(), 'mallard-ro-'));
  const handle = (db: Db, mode: ReadOnlyMode): ReadOnlyHandle => ({
    db,
    mode,
    close: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
  try {
    const snapshot = path.join(dir, 'snapshot.sqlite');
    try {
      direct.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
      return handle(verified(snapshot, 'snapshot'), 'snapshot');
    } catch {
      fs.rmSync(snapshot, { force: true });
    } finally {
      direct.close();
    }
    const copy = path.join(dir, 'copy.sqlite');
    fs.copyFileSync(file, copy);
    if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
    return handle(verified(copy, 'copy'), 'copy');
  } catch (err) {
    direct.close();
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

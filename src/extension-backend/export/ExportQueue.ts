/**
 * Durable backlog for metric exports that failed to send. Persisted as a
 * JSON file in the extension's storage directory, following the same
 * pattern as RestrictionEngine: best-effort read/write, a
 * malformed file degrades to an empty queue rather than throwing.
 *
 * No `vscode` or `mqtt` imports on purpose — this stays a plain class so it
 * can be exercised directly in the unit-test runner (see
 * test/unit/exportQueue.test.ts and the stub in test/unit/metricExporter.test.ts).
 */
import * as crypto from 'crypto';
import { readdirSync, unlinkSync } from 'fs';
import * as path from 'path';
import { JsonFileStore } from '../util/JsonFileStore';

const QUEUE_FILE = 'export-queue.json';

/**
 * Queue file for an export target: the primary target (no name) uses the
 * historical `export-queue.json`; a named target gets `export-queue-<name>.json`.
 * Characters outside [a-z0-9._-] are replaced, which on its own maps distinct
 * names onto the same file ("a/b" and "a_b"), so any name that needed
 * replacing also carries a short hash of the original — distinct targets can
 * never share (and corrupt) one queue. Names that need no replacing keep
 * their historical file, so existing backlogs survive the upgrade.
 */
export function queueFileFor(name: string | undefined): string {
  if (name === undefined) return QUEUE_FILE;
  const safe = name.replace(/[^a-z0-9._-]/gi, '_');
  if (safe === name) return `export-queue-${safe}.json`;
  const hash = crypto.createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `export-queue-${safe}-${hash}.json`;
}

const isQueueFile = (name: string): boolean =>
  name === QUEUE_FILE || (name.startsWith('export-queue-') && name.endsWith('.json'));

/** Delete every export queue file in `dir` (the full wipe). Best-effort; returns the names removed. */
export function deleteQueueFiles(dir: string): string[] {
  const removed: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!isQueueFile(name)) continue;
    try {
      unlinkSync(path.join(dir, name));
      removed.push(name);
    } catch {
      /* already gone or locked: best-effort */
    }
  }
  return removed;
}

function isQueuedExport(v: unknown): v is QueuedExport {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e['id'] === 'string' &&
    e['id'].length > 0 &&
    typeof e['topic'] === 'string' &&
    typeof e['payload'] === 'object' &&
    e['payload'] !== null &&
    !Array.isArray(e['payload']) &&
    typeof e['enqueuedAt'] === 'number' &&
    Number.isFinite(e['enqueuedAt'])
  );
}

/**
 * Oldest-evicted-first cap once exceeded. This is a count, not a duration,
 * but since `mallard.refreshIntervalMinutes` is user-configurable (1-60 min)
 * the time window it represents varies: ~83 hours of buffered history at the
 * 10-minute default, ~500 hours at the 60-minute max.
 */
const MAX_QUEUE_SIZE = 500;

export interface QueuedExport {
  readonly id: string;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly enqueuedAt: number;
}

export class ExportQueue {
  private entries: QueuedExport[];
  private readonly store: JsonFileStore<QueuedExport[]>;

  /**
   * @param queueFile persisted file name. Each fanout target gets its own queue
   *   file so a partial outage only re-delivers to the target that failed.
   */
  constructor(storageDir: string, queueFile: string = QUEUE_FILE) {
    this.store = new JsonFileStore<QueuedExport[]>(storageDir, queueFile);
    this.entries = this.readFromDisk();
  }

  /** A snapshot of the current queue, oldest first. Safe to iterate while calling dequeue(). */
  peekAll(): QueuedExport[] {
    return [...this.entries];
  }

  enqueue(topic: string, payload: Record<string, unknown>): void {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.entries.push({ id, topic, payload, enqueuedAt: Date.now() });
    if (this.entries.length > MAX_QUEUE_SIZE) {
      this.entries.splice(0, this.entries.length - MAX_QUEUE_SIZE);
    }
    this.writeToDisk();
  }

  dequeue(id: string): void {
    const next = this.entries.filter((e) => e.id !== id);
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.writeToDisk();
  }

  private readFromDisk(): QueuedExport[] {
    const parsed = this.store.read();
    if (!Array.isArray(parsed)) return [];
    // A hand-edited or half-corrupt file must not feed malformed entries to
    // the protocol (e.g. a null payload would throw inside send()).
    return parsed.filter(isQueuedExport).slice(-MAX_QUEUE_SIZE);
  }

  private writeToDisk(): void {
    this.store.write(this.entries);
  }
}

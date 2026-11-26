/**
 * Byte-offset NDJSON tailer.
 *
 * Replaces DuckDB's `read_ndjson` plus its timestamp watermark: a plain TypeScript reader that
 * remembers how far into each file it got, so a later call only touches the bytes appended since.
 *
 * ## What it guarantees
 *
 * - Reads fixed-size chunks (1 MiB by default) with positional reads on an `fs.promises` file handle
 *   and splits on byte `0x0A` of the raw buffer. Offsets are exact BYTE offsets (never character
 *   offsets), whatever straddles a chunk edge: multi-byte UTF-8, CRLF, a line longer than a chunk.
 *   Nothing is decoded until a whole line is in hand.
 * - NEVER consumes an unterminated final line. `byteOffset` always points at a line start, so a line
 *   a writer is still flushing is simply picked up by the next call, whole.
 * - A cheap Buffer-level `prefilter` (no string decode) runs before `JSON.parse`; lines that fail it
 *   cost one `Buffer.indexOf`. Bad JSON, and JSON that is not an object, is skipped and counted
 *   (the old `ignore_errors := true` semantics): it never throws.
 * - Yields to the event loop (`setImmediate`) whenever `yieldEveryMs` of synchronous work has passed.
 * - Rewrites are detected (file truncated or rotated, head bytes changed, offset no longer on a line
 *   start); the file is then re-read from byte 0 and the result says so (`restarted`).
 * - A missing or unreadable file is a RESULT, not an exception.
 *
 * ## Contract for the caller (the connectors, stream A3)
 *
 * ```ts
 * const prior = store.getIngestState(file);                  // TailState | undefined (never read)
 * const result = await runTail(file, prior, { prefilter }, async (batch) => {
 *   await store.insert(batch.map(map));                       // idempotent: ids dedupe
 * });
 * if (result.status === 'ok') store.setIngestState(file, result.state);   // ONLY AFTER the inserts
 * ```
 *
 * - **Persist `result.state` only after every batch of this call has been inserted.** The state is
 *   a pure function of (file bytes, prior state): if the process dies before it is persisted, the
 *   next call starts from the OLD state and yields exactly the same lines again. Re-reading is
 *   harmless because event ids dedupe in the store; losing lines is not, which is why the offset
 *   must never run ahead of the inserts.
 * - The returned `state.byteOffset` is the offset after the last COMPLETE line of the snapshot taken
 *   when the file was opened. Bytes appended while the scan runs are picked up by the next call.
 * - Dropping the iterator early (`break`, a throw in the consumer) closes the file handle and yields
 *   no state: persist nothing in that case.
 * - Two readers (two windows) never coordinate; each one's state is its own.
 *
 * ## `TailState` and rewrite detection
 *
 * `TailState` is the `ingest_state` row of the SQLite store: `file, size, mtimeMs, byteOffset,
 * headHash`. Persist `mtimeMs` as a REAL (an INTEGER truncation only costs the unchanged fast path:
 * both sides are compared at millisecond resolution).
 *
 * - `headHash` is the SHA-1 of the first `min(4096, byteOffset)` bytes: the part of the file that was
 *   already consumed. (Hashing `min(4096, size)` would make every append to a file smaller than
 *   4 KiB look like a rewrite, because the hashed prefix itself grows.)
 * - On resume the call restarts from byte 0 when the file is now smaller than `byteOffset`
 *   (`'truncated'`), the head hash differs (`'headChanged'`), or the byte before `byteOffset` is not a
 *   newline (`'misaligned'`: the offset is not a line start, e.g. a corrupted row or a rewrite that kept
 *   the head). A misaligned offset is never "re-aligned" forward, because that would silently drop the
 *   rest of a line; re-reading from the start is safe (ids dedupe).
 * - Known limit: a rewrite that keeps the first 4 KiB, keeps the size, and leaves a newline right
 *   before the old offset is not detected. Id dedupe in the store is the safety net, as planned.
 * - If `size` and `mtimeMs` equal the prior state's, nothing was written: the call returns
 *   `unchanged: true` after a single `stat`, without opening the file. That is what keeps a
 *   watcher tick over hundreds of session files cheap.
 *
 * ## Paths and `fileKeyOf`
 *
 * Copilot event ids embed `fileKeyOf(filename)` (a djb2 hash of the path STRING). The old path got
 * that string from DuckDB's `filename` column, which echoed the glob spelling the connectors built
 * with forward slashes (`path.join(...).replace(/\\/g, '/')`), so on Windows the key was computed
 * over `C:/Users/me/.../otel.jsonl`, never `C:\Users\me\...`. To keep every id identical, hash
 * `duckDbFilename(file)`, not the native path. The native path is what you pass to `tailNdjson`
 * and what keys `ingest_state`. On POSIX the two are the same string.
 */
import { createHash } from 'crypto';
import { promises as fsp } from 'fs';

const NL = 0x0a;
const CR = 0x0d;

/** Bytes per positional read. 1 MiB measured best: 64 KiB doubles the time, 4 MiB adds 4-8 ms slices. */
export const DEFAULT_CHUNK_BYTES = 1 << 20;
/** Lines longer than this (terminator included) are skipped and counted, not buffered. */
export const DEFAULT_MAX_LINE_BYTES = 64 << 20;
/** Parsed lines per yielded batch. */
export const DEFAULT_BATCH_LINES = 500;
/** Synchronous work allowed before a `setImmediate` yield. */
export const DEFAULT_YIELD_EVERY_MS = 8;
/** The head hash covers at most this many leading bytes (and never more than were consumed). */
export const HEAD_HASH_BYTES = 4096;

// ── Public types ────────────────────────────────────────────────────────────────────────────────

/** What to persist per file (the `ingest_state` row). */
export interface TailState {
  /** File size when it was opened (the snapshot the scan read up to). */
  size: number;
  /** File mtime when it was opened, epoch ms. */
  mtimeMs: number;
  /** Byte offset of the first unconsumed line start: everything before it is consumed. */
  byteOffset: number;
  /** Hex SHA-1 of the first `min(HEAD_HASH_BYTES, byteOffset)` bytes of the file. */
  headHash: string;
}

/** A line's JSON object. Lines that parse to anything else (numbers, arrays, null) are bad lines. */
export type TailObject = Record<string, unknown>;

export interface TailLine {
  value: TailObject;
  /**
   * Absolute byte offset of the first byte of the line in the file. Stable across calls, chunk sizes
   * and restarts, so mappers can build ids from it. (A line NUMBER is deliberately not offered: the
   * prefilter skips lines unseen and a resumed call has no line count.)
   */
  lineStartOffset: number;
}

export type TailBatch = readonly TailLine[];

export type TailRestartReason = 'truncated' | 'headChanged' | 'misaligned';

export interface TailStats {
  /** Bytes read from the file this call (the head-hash reads are not counted). */
  bytesRead: number;
  chunks: number;
  /** Complete lines consumed, blank lines and prefiltered-out lines included. */
  lines: number;
  /** Lines yielded as objects. */
  parsed: number;
  /** Lines that passed the prefilter but were not a JSON object. */
  badLines: number;
  /** Lines longer than `maxLineBytes` that were skipped. */
  oversizeLines: number;
  /** `setImmediate` yields this call made. */
  yields: number;
  /** Longest stretch of this call's own synchronous work between two hand-backs, ms. */
  maxSliceMs: number;
  elapsedMs: number;
}

export interface TailOk {
  status: 'ok';
  /** Persist this once the call's batches are inserted. Equal to the prior state when `unchanged`. */
  state: TailState;
  /** True when previously consumed bytes were discarded and the file was re-read from byte 0. */
  restarted: boolean;
  restartReason: TailRestartReason | undefined;
  /** True when size and mtime matched the prior state: the file was not opened. */
  unchanged: boolean;
  stats: TailStats;
}

/** The file does not exist (ENOENT, or a path component is not a directory). Log quietly. */
export interface TailMissing {
  status: 'missing';
}

/** The file exists but cannot be read (EACCES, EISDIR as `ENOTFILE`, EIO ...). */
export interface TailUnreadable {
  status: 'unreadable';
  code: string;
  message: string;
  /** True the first time this file failed (per `errorMemo`): log it then, stay quiet afterwards. */
  firstReport: boolean;
}

export type TailResult = TailOk | TailMissing | TailUnreadable;

/** The few `fs.promises` calls the tailer makes, so tests can inject faults. */
export interface TailFileStat {
  size: number;
  mtimeMs: number;
}
export interface TailHandle {
  stat(): Promise<TailFileStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface TailFs {
  stat(file: string): Promise<TailFileStat & { isFile(): boolean }>;
  open(file: string): Promise<TailHandle>;
}

export interface TailOptions {
  /**
   * Cheap test on the raw line bytes (no trailing CR/LF, never decoded). Lines it rejects are not
   * parsed and not counted as bad. Claude Code: `needlePrefilter('"usage"')`.
   */
  prefilter?: (line: Buffer) => boolean;
  /** Bytes per read (default 1 MiB). Tests use 1..N to hit every straddle. */
  chunkSize?: number;
  /** Longest line kept, terminator included (default 64 MiB); longer lines are skipped and counted. */
  maxLineBytes?: number;
  /** Parsed lines per yielded batch (default 500). */
  batchSize?: number;
  /** Synchronous work allowed before yielding to the event loop, ms (default 8; 0 yields at every chance). */
  yieldEveryMs?: number;
  /** Clock in ms (default `performance.now`); injected by tests. */
  now?: () => number;
  /** The yield itself (default `setImmediate`); injected by tests. */
  yieldToEventLoop?: () => Promise<void>;
  fs?: TailFs;
  /**
   * A set the caller keeps between calls. A file that fails to open is reported (`firstReport`) once,
   * until it reads fine or goes missing again.
   */
  errorMemo?: Set<string>;
}

// ── Helpers exported for the connectors ─────────────────────────────────────────────────────────

/** A prefilter that keeps lines containing `needle` (bytes, via `Buffer.indexOf`; nothing is decoded). */
export function needlePrefilter(needle: string | Buffer): (line: Buffer) => boolean {
  const bytes = typeof needle === 'string' ? Buffer.from(needle, 'utf8') : Buffer.from(needle);
  return (line) => line.indexOf(bytes) !== -1;
}

/** The spelling DuckDB reported in its `filename` column: forward slashes. Feed this to `fileKeyOf`. */
export function duckDbFilename(file: string): string {
  return file.replace(/\\/g, '/');
}

// ── Internals ───────────────────────────────────────────────────────────────────────────────────

const REAL_FS: TailFs = {
  stat: (file) => fsp.stat(file),
  open: (file) => fsp.open(file, 'r'),
};

const yieldToImmediate = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

interface Resolved {
  chunkSize: number;
  maxLineBytes: number;
  batchSize: number;
  yieldEveryMs: number;
  now: () => number;
  yieldToEventLoop: () => Promise<void>;
  fs: TailFs;
  prefilter: ((line: Buffer) => boolean) | undefined;
  errorMemo: Set<string> | undefined;
}

function resolveOptions(opts: TailOptions): Resolved {
  const chunkSize = Math.max(1, Math.trunc(opts.chunkSize ?? DEFAULT_CHUNK_BYTES));
  return {
    chunkSize,
    maxLineBytes: Math.max(chunkSize, Math.trunc(opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES)),
    batchSize: Math.max(1, Math.trunc(opts.batchSize ?? DEFAULT_BATCH_LINES)),
    yieldEveryMs: opts.yieldEveryMs ?? DEFAULT_YIELD_EVERY_MS,
    now: opts.now ?? (() => performance.now()),
    yieldToEventLoop: opts.yieldToEventLoop ?? yieldToImmediate,
    fs: opts.fs ?? REAL_FS,
    prefilter: opts.prefilter,
    errorMemo: opts.errorMemo,
  };
}

/** Tracks synchronous slices and decides when to hand the loop back. */
class Pacer {
  maxSliceMs = 0;
  yields = 0;
  private sliceStart: number;
  private lastTurn: number;

  constructor(private readonly o: Resolved) {
    this.sliceStart = this.lastTurn = o.now();
  }

  /** A read (or a yield) just completed: the loop has turned since the last synchronous work. */
  turn(): void {
    this.sliceStart = this.lastTurn = this.o.now();
  }

  /** Our own work pauses (batch handed to the consumer, or about to await). */
  endSlice(): void {
    this.maxSliceMs = Math.max(this.maxSliceMs, this.o.now() - this.sliceStart);
  }

  resumeSlice(): void {
    this.sliceStart = this.o.now();
  }

  async maybeYield(): Promise<void> {
    if (this.o.now() - this.lastTurn < this.o.yieldEveryMs) return;
    this.endSlice();
    await this.o.yieldToEventLoop();
    this.yields++;
    this.turn();
  }
}

function isUsableOffset(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/** Same millisecond: tolerant of an mtime that went through an INTEGER column. */
function sameStamp(prior: TailState, st: TailFileStat): boolean {
  return prior.size === st.size && Math.floor(prior.mtimeMs) === Math.floor(st.mtimeMs);
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Up to `length` bytes at `position` (fewer when the file is shorter). */
async function readAt(handle: TailHandle, position: number, length: number): Promise<Buffer> {
  if (length === 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

/**
 * Decides whether `prior` can be resumed. Returns why it cannot, or undefined when the first
 * `byteOffset` bytes are still the ones that were consumed and the offset sits on a line start.
 */
async function checkResume(handle: TailHandle, prior: TailState, size: number): Promise<TailRestartReason | undefined> {
  const offset = prior.byteOffset;
  if (!isUsableOffset(offset)) return 'misaligned';
  if (size < offset) return 'truncated';
  const head = await readAt(handle, 0, Math.min(HEAD_HASH_BYTES, offset));
  if (sha1(head) !== prior.headHash) return 'headChanged';
  const before = offset <= HEAD_HASH_BYTES ? head[offset - 1] : (await readAt(handle, offset - 1, 1))[0];
  return before === NL ? undefined : 'misaligned';
}

/** JSON object of one line, or undefined (bad JSON, or JSON that is not an object). */
function parseLine(line: Buffer): TailObject | undefined {
  let text = line.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM at the start of the file
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TailObject) : undefined;
  } catch {
    return undefined;
  }
}

/** Node's errno-style code (`ENOENT`, `EACCES` ...) of a filesystem error, else undefined. */
function fsErrorCode(err: unknown): string | undefined {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return typeof code === 'string' && /^E[A-Z0-9]+$/.test(code) ? code : undefined;
}

function failure(file: string, code: string, message: string, memo: Set<string> | undefined): TailMissing | TailUnreadable {
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    memo?.delete(file);
    return { status: 'missing' };
  }
  const firstReport = memo === undefined || !memo.has(file);
  memo?.add(file);
  return { status: 'unreadable', code, message, firstReport };
}

/**
 * The read loop. Returns the offset after the last complete line consumed.
 *
 * `pos` is where the next read starts; `committed` only ever moves over whole lines, so it is
 * the line start the next call resumes at. They differ only while an oversize line is being skipped.
 */
async function* scanLines(
  handle: TailHandle,
  start: number,
  size: number,
  o: Resolved,
  stats: TailStats,
  pacer: Pacer,
): AsyncGenerator<TailBatch, number, undefined> {
  let committed = start;
  let pos = start;
  let skipping = false;
  let buf = Buffer.allocUnsafe(o.chunkSize);
  let batch: TailLine[] = [];

  while (pos < size) {
    const want = Math.min(buf.length, size - pos);
    const { bytesRead } = await handle.read(buf, 0, want, pos);
    pacer.turn(); // a read completion resumes us on a fresh loop turn
    if (bytesRead === 0) break;
    stats.bytesRead += bytesRead;
    stats.chunks++;
    const atEnd = bytesRead < want || pos + bytesRead >= size;
    const region = buf.subarray(0, bytesRead);

    if (skipping) {
      // Discarding the rest of an oversize line.
      const nl = region.indexOf(NL);
      if (nl < 0) {
        if (atEnd) break; // unterminated: committed still points at the line's start
        pos += bytesRead;
        continue;
      }
      pos += nl + 1;
      committed = pos;
      skipping = false;
      continue;
    }

    const lastNl = region.lastIndexOf(NL);
    if (lastNl < 0) {
      if (atEnd) break; // unterminated final line: leave it for the next call
      if (buf.length >= o.maxLineBytes) {
        stats.oversizeLines++;
        skipping = true;
        pos += bytesRead;
        continue;
      }
      // A line longer than the buffer: retry from the same position with more room.
      buf = Buffer.allocUnsafe(Math.min(buf.length * 2, o.maxLineBytes));
      continue;
    }

    const end = lastNl + 1; // region[0, end) holds only complete lines
    let cur = 0;
    while (cur < end) {
      const nl = region.indexOf(NL, cur);
      let lineEnd = nl;
      if (lineEnd > cur && region[lineEnd - 1] === CR) lineEnd--;
      stats.lines++;
      if (lineEnd > cur) {
        const line = region.subarray(cur, lineEnd);
        if (o.prefilter === undefined || o.prefilter(line)) {
          const value = parseLine(line);
          if (value === undefined) {
            stats.badLines++;
          } else {
            stats.parsed++;
            batch.push({ value, lineStartOffset: pos + cur });
            if (batch.length >= o.batchSize) {
              const full = batch;
              batch = [];
              pacer.endSlice();
              yield full;
              pacer.resumeSlice();
            }
          }
          await pacer.maybeYield();
        }
      }
      cur = nl + 1;
    }
    pos += end;
    committed = pos;
    if (atEnd) break; // whatever follows the last newline is unterminated
    await pacer.maybeYield();
  }

  if (batch.length > 0) {
    pacer.endSlice();
    yield batch;
    pacer.resumeSlice();
  }
  return committed;
}

// ── The tailer ──────────────────────────────────────────────────────────────────────────────────

/**
 * Reads the lines of `file` that `prior` has not consumed yet, as batches of parsed objects, and
 * returns the state to persist (see the module comment for the contract).
 *
 * The return value of an async generator is invisible to `for await`; use `runTail` unless you
 * drive `next()` yourself.
 */
export async function* tailNdjson(
  file: string,
  prior: TailState | undefined,
  opts: TailOptions = {},
): AsyncGenerator<TailBatch, TailResult, undefined> {
  const o = resolveOptions(opts);
  const started = o.now();
  let handle: TailHandle | undefined;
  try {
    const pathStat = await o.fs.stat(file);
    if (!pathStat.isFile()) throw Object.assign(new Error(`not a regular file: ${file}`), { code: 'ENOTFILE' });

    const stats: TailStats = {
      bytesRead: 0, chunks: 0, lines: 0, parsed: 0, badLines: 0, oversizeLines: 0, yields: 0, maxSliceMs: 0, elapsedMs: 0,
    };
    if (prior !== undefined && isUsableOffset(prior.byteOffset) && prior.byteOffset <= pathStat.size && sameStamp(prior, pathStat)) {
      o.errorMemo?.delete(file);
      return { status: 'ok', state: { ...prior }, restarted: false, restartReason: undefined, unchanged: true, stats };
    }

    handle = await o.fs.open(file);
    const snap = await handle.stat(); // the snapshot: bytes appended after this belong to the next call
    let start = 0;
    let restartReason: TailRestartReason | undefined;
    if (prior !== undefined && prior.byteOffset !== 0) {
      restartReason = await checkResume(handle, prior, snap.size);
      if (restartReason === undefined) start = prior.byteOffset;
    }

    const pacer = new Pacer(o);
    const committed = yield* scanLines(handle, start, snap.size, o, stats, pacer);
    pacer.endSlice();

    const headHash = sha1(await readAt(handle, 0, Math.min(HEAD_HASH_BYTES, committed)));
    o.errorMemo?.delete(file);
    stats.yields = pacer.yields;
    stats.maxSliceMs = pacer.maxSliceMs;
    stats.elapsedMs = o.now() - started;
    return {
      status: 'ok',
      state: { size: snap.size, mtimeMs: snap.mtimeMs, byteOffset: committed, headHash },
      restarted: restartReason !== undefined,
      restartReason,
      unchanged: false,
      stats,
    };
  } catch (err) {
    const code = fsErrorCode(err);
    if (code === undefined) throw err; // a bug (a throwing prefilter, say), not a filesystem condition
    return failure(file, code, (err as Error).message, o.errorMemo);
  } finally {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // nothing useful to do about a failed close of a read-only handle
      }
    }
  }
}

/**
 * Drives `tailNdjson`, awaits `onBatch` for every batch (backpressure: the next chunk is not read
 * until it settles) and returns the final result. The handle is closed even when `onBatch` throws.
 */
export async function runTail(
  file: string,
  prior: TailState | undefined,
  opts: TailOptions,
  onBatch: (batch: TailBatch) => void | Promise<void>,
): Promise<TailResult> {
  const it = tailNdjson(file, prior, opts);
  try {
    let step = await it.next();
    while (!step.done) {
      await onBatch(step.value);
      step = await it.next();
    }
    return step.value;
  } finally {
    // A no-op once the generator finished; closes the file handle when onBatch threw.
    await it.return({ status: 'missing' });
  }
}

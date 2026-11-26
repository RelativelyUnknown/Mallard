/** Shared pieces for the NDJSON tailer tests: an independent oracle, fault-injecting fs, tiny utilities. */
import { strict as assert } from 'assert';
import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HEAD_HASH_BYTES,
  runTail,
  type TailFileStat,
  type TailFs,
  type TailHandle,
  type TailLine,
  type TailOk,
  type TailOptions,
  type TailResult,
  type TailState,
} from '../../../src/extension-backend/ingest/ndjsonTail';

// ── Files ───────────────────────────────────────────────────────────────────────────────────────

export async function makeTmpDir(label: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), `mallard-tail-${label}-`));
}

export async function removeDir(dir: string): Promise<void> {
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Deterministic PRNG so generated files are the same on every run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

/** Gives `file` an mtime that differs from any other write (so an equal-size rewrite is not "unchanged"). */
export async function setMtime(file: string, ms: number): Promise<void> {
  await fsp.utimes(file, new Date(ms), new Date(ms));
}

export function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** The head hash a correct tailer stores for a file whose consumed prefix ends at `offset`. */
export function headHashAt(bytes: Buffer, offset: number): string {
  return sha1(bytes.subarray(0, Math.min(HEAD_HASH_BYTES, offset)));
}

/** A hand-made state for a file whose bytes are `bytes`, with an mtime that never matches a real one. */
export function craftState(bytes: Buffer, byteOffset: number): TailState {
  return { size: bytes.length, mtimeMs: 1, byteOffset, headHash: headHashAt(bytes, byteOffset) };
}

// ── Oracle: an independent byte-by-byte splitter (no indexOf, no chunking) ──────────────────────

export interface Expected {
  objects: Array<{ offset: number; value: unknown }>;
  badLines: number;
  /** Complete lines, blank ones included. */
  lines: number;
  /** Offset after the last newline: where an unterminated tail begins. */
  next: number;
  /** Line start offsets of every complete line. */
  starts: number[];
}

function contains(line: Buffer, needle: Buffer): boolean {
  outer: for (let i = 0; i + needle.length <= line.length; i++) {
    for (let j = 0; j < needle.length; j++) if (line[i + j] !== needle[j]) continue outer;
    return true;
  }
  return needle.length === 0;
}

export function oracle(bytes: Buffer, start = 0, needle: string | null = null): Expected {
  const needleBytes = needle === null ? null : utf8(needle);
  const out: Expected = { objects: [], badLines: 0, lines: 0, next: start, starts: [] };
  let lineStart = start;
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] !== 0x0a) continue;
    let lineEnd = i;
    if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd--;
    out.lines++;
    out.starts.push(lineStart);
    if (lineEnd > lineStart) {
      const line = bytes.subarray(lineStart, lineEnd);
      if (needleBytes === null || contains(line, needleBytes)) {
        let value: unknown;
        try {
          value = JSON.parse(line.toString('utf8').replace(/^\uFEFF/, ''));
        } catch {
          value = undefined;
        }
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) out.objects.push({ offset: lineStart, value });
        else out.badLines++;
      }
    }
    lineStart = i + 1;
  }
  out.next = lineStart;
  return out;
}

// ── Running the tailer ──────────────────────────────────────────────────────────────────────────

export interface Collected {
  lines: TailLine[];
  batches: TailLine[][];
  result: TailResult;
}

export async function collect(file: string, prior: TailState | undefined, opts: TailOptions = {}): Promise<Collected> {
  const batches: TailLine[][] = [];
  const result = await runTail(file, prior, opts, (batch) => {
    batches.push([...batch]);
  });
  return { lines: batches.flat(), batches, result };
}

export function okOf(result: TailResult): TailOk {
  assert.equal(result.status, 'ok', `expected ok, got ${JSON.stringify(result)}`);
  return result as TailOk;
}

export const pairs = (lines: TailLine[]): Array<{ offset: number; value: unknown }> =>
  lines.map((l) => ({ offset: l.lineStartOffset, value: l.value }));

// ── Fault injection ─────────────────────────────────────────────────────────────────────────────

export function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code });
}

export interface FsProbe {
  stats: number;
  opens: number;
  reads: number;
  closes: number;
}

export interface FsHooks {
  /** Throw to fail `stat(path)`. */
  stat?: () => void;
  /** Throw to fail `open` (after `stat` succeeded: a file removed in between). */
  open?: () => void;
  /** Replace what the handle reports from `fstat`. */
  handleStat?: (real: TailFileStat) => TailFileStat;
  /** Called before the n-th read (1-based); may throw, or return a result to replace the real read. */
  read?: (n: number) => { bytesRead: number } | undefined;
  /** Throw from `close` (after the real close ran). */
  close?: () => void;
}

const REAL: TailFs = {
  stat: (file) => fsp.stat(file),
  open: (file) => fsp.open(file, 'r'),
};

/** The real filesystem with counters and optional faults. */
export function probeFs(hooks: FsHooks = {}): { fs: TailFs; probe: FsProbe } {
  const probe: FsProbe = { stats: 0, opens: 0, reads: 0, closes: 0 };
  const fs: TailFs = {
    async stat(file) {
      probe.stats++;
      hooks.stat?.();
      return REAL.stat(file);
    },
    async open(file) {
      probe.opens++;
      hooks.open?.();
      const real = await REAL.open(file);
      const handle: TailHandle = {
        stat: async () => {
          const st = await real.stat();
          return hooks.handleStat ? hooks.handleStat({ size: st.size, mtimeMs: st.mtimeMs }) : st;
        },
        read: async (buffer, offset, length, position) => {
          probe.reads++;
          const replaced = hooks.read?.(probe.reads);
          return replaced ?? real.read(buffer, offset, length, position);
        },
        close: async () => {
          probe.closes++;
          await real.close();
          hooks.close?.();
        },
      };
      return handle;
    },
  };
  return { fs, probe };
}

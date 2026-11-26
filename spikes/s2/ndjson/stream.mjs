// Buffer-scanning NDJSON streamer (A3 prototype).
//
// Guarantees:
//  - reads fixed-size chunks with positional reads; never decodes partial lines
//  - splits on 0x0A only (a trailing 0x0D is trimmed); offsets are exact byte offsets into the file
//  - never consumes an unterminated final line: `nextOffset` always points at a line start
//  - optional byte prefilter (the connector's cheap `"usage"` check) runs on raw bytes before any decode/parse
//  - yields to the event loop whenever `yieldEveryMs` has elapsed since the last yield (checked per hit and per chunk)
//  - a line longer than the chunk grows the buffer (doubling) up to `maxLineBytes`; longer lines are skipped and counted
//
// Two scan strategies:
//  'needle-first' (default): memmem for the needle over the chunk, then find the enclosing line by searching for the
//                  neighbouring 0x0A bytes. Lines without the needle are never visited individually.
//  'line-split'  : visit every line (indexOf 0x0A), apply the needle per line. Simple reference implementation.
import fs from 'node:fs';

const NL = 0x0a;

/**
 * @param {string} file
 * @param {{
 *   startOffset?: number, chunkSize?: number, needle?: Buffer|string|null,
 *   onLine: (line: Buffer, offset: number) => void,
 *   strategy?: 'needle-first'|'line-split', yieldEveryMs?: number, maxLineBytes?: number,
 * }} opts
 */
export async function scanFile(file, opts) {
  const {
    startOffset = 0, chunkSize = 1 << 20, strategy = 'needle-first', yieldEveryMs = 8,
    maxLineBytes = 64 << 20, onLine,
  } = opts;
  const needle = opts.needle == null ? null : Buffer.from(opts.needle);
  const stats = { nextOffset: startOffset, lines: 0, hits: 0, bytesRead: 0, chunks: 0, yields: 0, skippedOversize: 0, maxSyncMs: 0, elapsedMs: 0 };
  const t00 = performance.now();
  const fh = await fs.promises.open(file, 'r');
  let lastYield = performance.now();
  let syncStart = lastYield;
  const noteSync = () => { const d = performance.now() - syncStart; if (d > stats.maxSyncMs) stats.maxSyncMs = d; };
  const maybeYield = async () => {
    const now = performance.now();
    if (now - lastYield >= yieldEveryMs) {
      noteSync();
      await new Promise((r) => setImmediate(r));
      stats.yields++;
      lastYield = performance.now();
      syncStart = lastYield;
    }
  };
  try {
    const size = (await fh.stat()).size; // snapshot: bytes appended after this are picked up by the next call
    let pos = startOffset;
    let buf = Buffer.allocUnsafe(chunkSize);
    let skipping = false;
    while (pos < size) {
      const want = Math.min(buf.length, size - pos);
      const { bytesRead } = await fh.read(buf, 0, want, pos);
      syncStart = performance.now(); // a read completion resumes us on a fresh loop turn
      lastYield = syncStart;
      if (bytesRead === 0) break;
      stats.bytesRead += bytesRead;
      stats.chunks++;
      const region = buf.subarray(0, bytesRead);
      if (skipping) { // discarding the tail of an oversize line
        const nl = region.indexOf(NL);
        if (nl < 0) { if (pos + bytesRead >= size) break; pos += bytesRead; stats.nextOffset = pos; continue; }
        pos += nl + 1; stats.nextOffset = pos; skipping = false; continue;
      }
      const lastNl = region.lastIndexOf(NL);
      if (lastNl < 0) {
        if (pos + bytesRead >= size) break; // unterminated final line: leave it for the next call
        if (buf.length >= maxLineBytes) { stats.skippedOversize++; skipping = true; continue; }
        buf = Buffer.allocUnsafe(buf.length * 2); // line longer than the buffer: retry from the same pos with more room
        continue;
      }
      const end = lastNl + 1; // [0,end) holds only complete lines
      const complete = region.subarray(0, end);
      if (strategy === 'line-split' || needle === null) {
        let cur = 0;
        while (cur < end) {
          const nl = complete.indexOf(NL, cur);
          let le = nl;
          if (le > cur && complete[le - 1] === 0x0d) le--;
          stats.lines++;
          if (needle === null || complete.subarray(cur, le).indexOf(needle) !== -1) {
            stats.hits++;
            onLine(complete.subarray(cur, le), pos + cur);
            await maybeYield();
          }
          cur = nl + 1;
        }
      } else {
        let cur = 0;
        while (cur < end) {
          const hit = complete.indexOf(needle, cur);
          if (hit < 0) break;
          const ls = complete.lastIndexOf(NL, hit) + 1; // >= cur because cur-1 is a newline (or cur === 0)
          const nl = complete.indexOf(NL, hit);
          let le = nl;
          if (le > ls && complete[le - 1] === 0x0d) le--;
          stats.hits++;
          onLine(complete.subarray(ls, le), pos + ls);
          cur = nl + 1;
          await maybeYield();
        }
      }
      pos += end;
      stats.nextOffset = pos;
      await maybeYield();
      noteSync(); // the slice ends here: the next `await fh.read` hands the loop back
    }
    noteSync();
  } finally {
    await fh.close();
  }
  stats.elapsedMs = performance.now() - t00;
  return stats;
}

/** Cheap rewrite detection helpers (A3: "size shrank or head hash changed => re-read"). */
import crypto from 'node:crypto';
export async function headHash(file, bytes = 4096) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const b = Buffer.allocUnsafe(bytes);
    const { bytesRead } = await fh.read(b, 0, bytes, 0);
    return crypto.createHash('sha1').update(b.subarray(0, bytesRead)).digest('hex');
  } finally {
    await fh.close();
  }
}

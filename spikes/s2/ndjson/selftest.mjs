// Correctness tests for the NDJSON streamer. Run: node spikes/s2/ndjson/selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { scanFile } from './stream.mjs';
import { scratchDir, rmrf } from '../lib/stats.mjs';
import { mulberry32 } from '../lib/data.mjs';

const dir = scratchDir('ndjson-selftest');
const f = path.join(dir, 't.jsonl');
const NEEDLE = '"usage"';

function reference(bytes, start = 0) {
  // exact reference: split at every 0x0A, track offsets, only complete lines
  const out = [];
  let ls = start;
  for (let i = start; i < bytes.length; i++) {
    if (bytes[i] === 0x0a) {
      let le = i;
      if (le > ls && bytes[le - 1] === 0x0d) le--;
      out.push({ off: ls, len: le - ls });
      ls = i + 1;
    }
  }
  return { lines: out, next: ls };
}

async function check(label, bytes, { chunkSize, strategy, start = 0, needle = NEEDLE }) {
  fs.writeFileSync(f, bytes);
  const hits = [];
  const st = await scanFile(f, {
    startOffset: start, chunkSize, strategy, needle: needle === null ? null : Buffer.from(needle),
    onLine: (line, off) => hits.push({ off, text: Buffer.from(line).toString('utf8') }),
    yieldEveryMs: 0, // force a yield at every opportunity
  });
  const ref = reference(bytes, start);
  const want = ref.lines
    .map((l) => ({ off: l.off, text: bytes.subarray(l.off, l.off + l.len).toString('utf8') }))
    .filter((l) => needle === null || Buffer.from(l.text).indexOf(needle) !== -1);
  assert.deepEqual(hits, want, `${label}: hits (chunk=${chunkSize}, ${strategy})`);
  assert.equal(st.nextOffset, ref.next, `${label}: nextOffset (chunk=${chunkSize}, ${strategy})`);
  // every reported offset must address the exact line bytes in the file
  for (const h of hits) assert.equal(bytes.subarray(h.off, h.off + Buffer.byteLength(h.text)).toString('utf8'), h.text);
  return st;
}

const cases = [];
const mk = (s) => Buffer.from(s, 'utf8');
cases.push(['simple', mk('{"a":1,"usage":{}}\n{"b":2}\n{"usage":3}\n')]);
cases.push(['unterminated tail with needle', mk('{"usage":1}\n{"usage":2')]);
cases.push(['unterminated tail no newline at all', mk('{"usage":1}')]);
cases.push(['empty lines + CRLF', mk('\n\r\n{"usage":1}\r\n\n{"x":"usage"}\n{"usage":2}\r\n')]);
cases.push(['multibyte straddling chunks', mk(`{"t":"é日本語🚀","usage":1}\n{"t":"😀😀😀😀","usage":2}\n{"t":"ñ"}\n`)]);
cases.push(['needle at very start/end of line', mk('"usage"\n x"usage"\n"usage"y\n')]);
cases.push(['long line > chunk', mk(`{"p":"${'x'.repeat(5000)}","usage":1}\n{"usage":2}\n{"q":"${'y'.repeat(3000)}"}\n`)]);
cases.push(['needle on last complete line before unterminated', mk(`{"a":1}\n{"usage":2}\n{"usage":3,"part`)]);
{ // randomised file
  const r = mulberry32(42);
  let s = '';
  const alphabet = ['a', 'é', '日', '🚀', ' ', '"', '\\', 'u'];
  for (let i = 0; i < 400; i++) {
    let line = '';
    const len = Math.floor(r() * (r() < 0.05 ? 3000 : 120));
    for (let j = 0; j < len; j++) line += alphabet[Math.floor(r() * alphabet.length)];
    if (r() < 0.3) line += '"usage"';
    s += line.replace(/\n/g, '') + (r() < 0.1 ? '\r\n' : '\n');
  }
  s += '{"usage":"unterminated';
  cases.push(['random', mk(s)]);
}

let n = 0;
for (const [label, bytes] of cases) {
  for (const strategy of ['needle-first', 'line-split']) {
    for (const chunkSize of [1, 2, 3, 7, 64, 1000, 4096, 1 << 20]) {
      if (chunkSize < 8 && bytes.length > 3000) continue; // keep runtime sane
      await check(label, bytes, { chunkSize, strategy });
      await check(`${label} [no prefilter]`, bytes, { chunkSize, strategy, needle: null });
      n += 2;
    }
  }
}

// resume from a stored offset, including offsets that are mid-file line starts
{
  const bytes = mk('{"usage":1}\n{"x":1}\n{"usage":2}\n{"usage":3,"é":"日本"}\n{"usage":4');
  const ref = reference(bytes);
  for (const l of ref.lines) for (const strategy of ['needle-first', 'line-split']) { await check('resume', bytes, { chunkSize: 5, strategy, start: l.off }); n++; }
}

// incremental append: scan, append partial, scan, complete the partial line, scan => union equals single full scan
{
  const parts = ['{"usage":1}\n{"x":2}\n{"usage":', '2,"é":"日本"}\n{"y":3}\n{"usage":4}\n{"usa', 'ge":5}\n'];
  fs.writeFileSync(f, '');
  let off = 0;
  const seen = [];
  for (const p of parts) {
    fs.appendFileSync(f, p, 'utf8');
    const st = await scanFile(f, { startOffset: off, chunkSize: 16, needle: NEEDLE, onLine: (l) => seen.push(Buffer.from(l).toString('utf8')) });
    off = st.nextOffset;
  }
  assert.deepEqual(seen, ['{"usage":1}', '{"usage":2,"é":"日本"}', '{"usage":4}', '{"usage":5}'].map((x) => x));
  assert.equal(off, fs.statSync(f).size);
  n++;
}

rmrf(dir);
console.log(`ndjson streamer selftest OK (${n} scenarios)`);

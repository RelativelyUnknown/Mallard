import { strict as assert } from 'assert';
import { promises as fsp } from 'fs';
import * as path from 'path';
import {
  HEAD_HASH_BYTES,
  duckDbFilename,
  needlePrefilter,
  runTail,
  tailNdjson,
  type TailOptions,
  type TailState,
} from '../../../src/extension-backend/ingest/ndjsonTail';
import { fileKeyOf } from '../../../src/extension-backend/ingest/connectorUtils';
import {
  collect,
  craftState,
  fsError,
  headHashAt,
  makeTmpDir,
  mulberry32,
  okOf,
  oracle,
  pairs,
  probeFs,
  removeDir,
  setMtime,
  sha1,
  utf8,
} from './ndjsonTailHelpers';

/**
 * The spike's selftest (spikes/s2/ndjson/selftest.mjs, 265 scenarios) ported onto the real module,
 * plus everything the production contract adds: state, rewrite detection, faults, pacing.
 */

const NEEDLE = '"usage"';
const CHUNKS = [1, 2, 3, 7, 64, 1000, 4096, 1 << 20];

let dir: string;
let file: string;
let scenarios = 0;

before(async () => {
  dir = await makeTmpDir('unit');
  file = path.join(dir, 't.jsonl');
});

after(async () => {
  await removeDir(dir);
});

const optsFor = (chunkSize: number, needle: string | null, extra: TailOptions = {}): TailOptions => ({
  chunkSize,
  ...(needle === null ? {} : { prefilter: needlePrefilter(needle) }),
  ...extra,
});

async function write(bytes: Buffer | string, target = file): Promise<void> {
  await fsp.writeFile(target, bytes);
}

// ── Scan equivalence against an independent oracle ──────────────────────────────────────────────

function randomFile(): Buffer {
  const r = mulberry32(42);
  const alphabet = ['a', 'é', '日', '🚀', ' ', '"', '\\', 'u'];
  let s = '';
  for (let i = 0; i < 400; i++) {
    let line: string;
    if (r() < 0.7) {
      const text = Array.from({ length: Math.floor(r() * 40) }, () => alphabet[Math.floor(r() * alphabet.length)]).join('');
      line = JSON.stringify({ i, t: text, ...(r() < 0.5 ? { usage: { input_tokens: i } } : {}) });
    } else {
      const len = Math.floor(r() * (r() < 0.05 ? 3000 : 120));
      line = Array.from({ length: len }, () => alphabet[Math.floor(r() * alphabet.length)]).join('') + (r() < 0.3 ? NEEDLE : '');
      line = line.replace(/\n/g, '');
    }
    s += line + (r() < 0.1 ? '\r\n' : '\n');
  }
  return utf8(`${s}{"usage":"unterminated`);
}

const CASES: Array<[string, Buffer]> = [
  ['simple', utf8('{"a":1,"usage":{}}\n{"b":2}\n{"usage":3}\n')],
  ['unterminated tail with needle', utf8('{"usage":1}\n{"usage":2')],
  ['unterminated tail, no newline at all', utf8('{"usage":1}')],
  ['empty lines and CRLF', utf8('\n\r\n{"usage":1}\r\n\n{"x":"usage"}\n{"usage":2}\r\n')],
  ['multibyte straddling chunks', utf8('{"t":"é日本語🚀","usage":1}\n{"t":"😀😀😀😀","usage":2}\n{"t":"ñ"}\n')],
  ['needle at the very start/end of a line', utf8('"usage"\n x"usage"\n"usage"y\n')],
  ['line longer than the chunk', utf8(`{"p":"${'x'.repeat(5000)}","usage":1}\n{"usage":2}\n{"q":"${'y'.repeat(3000)}"}\n`)],
  ['needle on the last complete line before an unterminated one', utf8('{"a":1}\n{"usage":2}\n{"usage":3,"part')],
  ['empty file', utf8('')],
  ['a single newline', utf8('\n')],
  ['only a partial line', utf8('{"usage":1,"par')],
  ['scalars, arrays and null are bad lines', utf8('123\n"s"\nnull\n[1,2]\ntrue\n{"usage":1}\n  \n{}\n')],
  ['a BOM before the first line', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8('{"usage":1}\n{"usage":2}\n')])],
  ['CR-only terminators are not line breaks', utf8('{"usage":1}\r{"usage":2}\n')],
  ['random', randomFile()],
];

describe('ndjsonTail: scanning', () => {
  for (const [name, bytes] of CASES) {
    for (const chunkSize of CHUNKS) {
      if (chunkSize < 8 && bytes.length > 3000) continue; // keeps the 1-byte chunk runs short
      it(`${name} / chunk ${chunkSize}`, async () => {
        await write(bytes);
        for (const needle of [null, NEEDLE]) {
          const label = `${name} [chunk ${chunkSize}, prefilter ${needle ?? 'none'}]`;
          const expected = oracle(bytes, 0, needle);
          // yieldEveryMs 0 hands the loop back at every opportunity, so every yield point is exercised.
          const c = await collect(file, undefined, optsFor(chunkSize, needle, { yieldEveryMs: 0 }));
          const r = okOf(c.result);
          assert.deepEqual(pairs(c.lines), expected.objects, `${label}: lines`);
          assert.equal(r.state.byteOffset, expected.next, `${label}: byteOffset`);
          assert.equal(r.state.size, bytes.length, `${label}: size`);
          assert.equal(r.state.headHash, headHashAt(bytes, expected.next), `${label}: headHash`);
          assert.equal(r.stats.lines, expected.lines, `${label}: stats.lines`);
          assert.equal(r.stats.parsed, expected.objects.length, `${label}: stats.parsed`);
          assert.equal(r.stats.badLines, expected.badLines, `${label}: stats.badLines`);
          assert.equal(r.restarted, false);
          assert.equal(r.unchanged, false);
          // Every reported offset addresses exactly the bytes of its line.
          for (const l of c.lines) {
            const end = bytes.indexOf(0x0a, l.lineStartOffset);
            const text = bytes.subarray(l.lineStartOffset, end).toString('utf8').replace(/\r$/, '').replace(/^\ufeff/, '');
            assert.deepEqual(JSON.parse(text), l.value, `${label}: offset ${l.lineStartOffset}`);
          }
          scenarios += 2;
        }
      });
    }
  }
});

// ── Resume ──────────────────────────────────────────────────────────────────────────────────────

describe('ndjsonTail: resume', () => {
  const small = utf8('{"usage":1}\n{"x":1}\n{"usage":2}\r\n{"usage":3,"é":"日本"}\n{"🚀":0}\n{"usage":4');

  for (const chunkSize of [5, 1 << 20]) {
    it(`a file cut at every byte, then completed, yields the union exactly once (chunk ${chunkSize})`, async () => {
      for (const needle of [null, NEEDLE]) {
        const all = oracle(small, 0, needle);
        for (let k = 0; k <= small.length; k++) {
          await write(small.subarray(0, k));
          const first = await collect(file, undefined, optsFor(chunkSize, needle));
          const s1 = okOf(first.result).state;
          assert.equal(s1.byteOffset, oracle(small.subarray(0, k)).next, `cut ${k}: first offset`);
          await write(small);
          const second = await collect(file, s1, optsFor(chunkSize, needle));
          const r2 = okOf(second.result);
          assert.equal(r2.restarted, false, `cut ${k}: restarted`);
          assert.deepEqual([...pairs(first.lines), ...pairs(second.lines)], all.objects, `cut ${k}: union`);
          assert.equal(r2.state.byteOffset, all.next, `cut ${k}: final offset`);
          scenarios++;
        }
      }
    });
  }

  it('resumes from every line boundary of a larger file and never skips or repeats a line', async () => {
    const bytes = randomFile();
    const all = oracle(bytes, 0, NEEDLE);
    const whole = oracle(bytes);
    for (const start of [...whole.starts, whole.next]) {
      await write(bytes.subarray(0, start));
      const first = await collect(file, undefined, optsFor(4096, NEEDLE));
      const s1 = okOf(first.result).state;
      assert.equal(s1.byteOffset, start, `boundary ${start}`);
      await write(bytes);
      const second = await collect(file, s1, optsFor(4096, NEEDLE));
      assert.equal(okOf(second.result).restarted, false, `boundary ${start}`);
      assert.deepEqual([...pairs(first.lines), ...pairs(second.lines)], all.objects, `boundary ${start}`);
      scenarios++;
    }
  });

  it('an offset that is not a line start restarts from byte 0 (misaligned), never skipping into a line', async () => {
    await write(small);
    const all = oracle(small);
    const starts = new Set(all.starts.concat(all.next));
    let tried = 0;
    for (let k = 1; k <= small.length; k++) {
      if (starts.has(k)) continue;
      const c = await collect(file, craftState(small, k), optsFor(5, null));
      const r = okOf(c.result);
      assert.equal(r.restarted, true, `offset ${k}`);
      assert.equal(r.restartReason, 'misaligned', `offset ${k}`);
      assert.deepEqual(pairs(c.lines), oracle(small).objects, `offset ${k}`);
      assert.equal(r.state.byteOffset, all.next);
      tried++;
      scenarios++;
    }
    assert.ok(tried > 40, `only ${tried} mid-line offsets tried`);
  });

  it('checks alignment with a separate read when the offset is past the head-hash window', async () => {
    const long = `{"p":"${'x'.repeat(HEAD_HASH_BYTES + 900)}"}\n`;
    const bytes = utf8(`${long}{"n":2}\n{"n":3}\n`);
    await write(bytes);
    const mid = craftState(bytes, HEAD_HASH_BYTES + 500); // inside the first line
    const bad = okOf((await collect(file, mid, { chunkSize: 1000 })).result);
    assert.equal(bad.restartReason, 'misaligned');
    const boundary = long.length;
    const good = await collect(file, craftState(bytes, boundary), { chunkSize: 1000 });
    assert.equal(okOf(good.result).restarted, false);
    assert.deepEqual(good.lines.map((l) => l.lineStartOffset), [boundary, boundary + 8]);
  });

  it('rejects offsets that cannot be a position in the file', async () => {
    const bytes = utf8('{"n":1}\n{"n":2}\n');
    await write(bytes);
    const st = await fsp.stat(file);
    for (const [label, byteOffset, reason] of [
      ['NaN', Number.NaN, 'misaligned'],
      ['negative', -3, 'misaligned'],
      ['fractional', 2.5, 'misaligned'],
      ['past the end', bytes.length + 1, 'truncated'],
    ] as const) {
      // Same size and mtime as the real file, so only the offset can make this state unusable.
      const prior: TailState = { size: st.size, mtimeMs: st.mtimeMs, byteOffset, headHash: sha1(bytes) };
      const r = okOf((await collect(file, prior)).result);
      assert.equal(r.unchanged, false, label);
      assert.equal(r.restartReason, reason, label);
      assert.equal(r.state.byteOffset, bytes.length, label);
    }
  });
});

// ── Unterminated tails ──────────────────────────────────────────────────────────────────────────

describe('ndjsonTail: unterminated final line', () => {
  it('a file holding only a partial line consumes nothing, then yields the line once it is finished', async () => {
    await write('{"usage":1,"par');
    const first = await collect(file, undefined);
    const s1 = okOf(first.result).state;
    assert.equal(first.lines.length, 0);
    assert.equal(first.batches.length, 0);
    assert.deepEqual(s1, { size: 15, mtimeMs: s1.mtimeMs, byteOffset: 0, headHash: sha1(Buffer.alloc(0)) });
    await write('{"usage":1,"par":2}\n');
    const second = await collect(file, s1);
    assert.deepEqual(pairs(second.lines), [{ offset: 0, value: { usage: 1, par: 2 } }]);
    assert.equal(okOf(second.result).state.byteOffset, 20);
  });

  it('complete lines are consumed, the cut line is left whole for the next call', async () => {
    await write('{"n":1}\n{"n":2}\n{"n":3');
    const first = await collect(file, undefined);
    const s1 = okOf(first.result).state;
    assert.equal(s1.byteOffset, 16);
    assert.deepEqual(first.lines.map((l) => l.value), [{ n: 1 }, { n: 2 }]);
    await fsp.appendFile(file, ',"m":4}\n{"n":5}\n');
    const second = await collect(file, s1);
    assert.deepEqual(pairs(second.lines), [{ offset: 16, value: { n: 3, m: 4 } }, { offset: 30, value: { n: 5 } }]);
  });

  it('a multi-byte character cut in half is never decoded until the line is whole', async () => {
    const line = utf8('{"t":"😀 ok"}\n');
    const cut = line.indexOf(0xf0) + 2; // two of the emoji's four bytes
    await write(line.subarray(0, cut));
    const first = await collect(file, undefined, { chunkSize: 3 });
    const s1 = okOf(first.result).state;
    assert.equal(first.lines.length, 0);
    assert.equal(s1.byteOffset, 0);
    await fsp.appendFile(file, line.subarray(cut));
    const second = await collect(file, s1, { chunkSize: 3 });
    assert.deepEqual(second.lines.map((l) => l.value), [{ t: '😀 ok' }]);
  });

  it('a file that is only a newline holds one blank line', async () => {
    await write('\n');
    const r = okOf((await collect(file, undefined)).result);
    assert.equal(r.state.byteOffset, 1);
    assert.equal(r.stats.lines, 1);
    assert.equal(r.stats.parsed, 0);
    assert.equal(r.stats.badLines, 0);
  });

  it('an empty file is a valid, empty state', async () => {
    await write('');
    const c = await collect(file, undefined);
    const r = okOf(c.result);
    assert.equal(c.lines.length, 0);
    assert.equal(r.stats.chunks, 0);
    assert.deepEqual(r.state, { size: 0, mtimeMs: r.state.mtimeMs, byteOffset: 0, headHash: sha1(Buffer.alloc(0)) });
  });
});

// ── Rewrites, growth and the unchanged fast path ────────────────────────────────────────────────

describe('ndjsonTail: rewrite detection', () => {
  const lines = (n: number, key = 'n'): string => Array.from({ length: n }, (_, i) => JSON.stringify({ [key]: i })).join('\n') + '\n';

  it('append-only growth resumes at the stored offset, again and again, for a small file and a big one', async () => {
    for (const pad of [0, 3000]) {
      let state: TailState | undefined;
      let expectedOffset = 0;
      await write('');
      for (let round = 0; round < 5; round++) {
        const add = `${JSON.stringify({ round, pad: 'p'.repeat(pad) })}\n`;
        await fsp.appendFile(file, add);
        const c = await collect(file, state);
        const r = okOf(c.result);
        assert.equal(r.restarted, false, `pad ${pad} round ${round}`);
        assert.deepEqual(pairs(c.lines), [{ offset: expectedOffset, value: { round, pad: 'p'.repeat(pad) } }]);
        expectedOffset += Buffer.byteLength(add);
        assert.equal(r.state.byteOffset, expectedOffset);
        state = r.state;
      }
    }
  });

  it('hashes the consumed prefix, not the live tail: its hash is stable while a short file grows', async () => {
    await write('{"a":1}\n');
    const s1 = okOf((await collect(file, undefined)).result).state;
    assert.equal(s1.headHash, sha1(utf8('{"a":1}\n')));
    await fsp.appendFile(file, '{"b":2}\n');
    const r2 = okOf((await collect(file, s1)).result);
    assert.equal(r2.restarted, false);
    assert.equal(r2.state.headHash, sha1(utf8('{"a":1}\n{"b":2}\n')));
  });

  it('size below the stored offset: truncated, re-read from byte 0', async () => {
    await write(lines(5));
    const s1 = okOf((await collect(file, undefined)).result).state;
    await write('{"fresh":1}\n');
    const c = await collect(file, s1);
    const r = okOf(c.result);
    assert.equal(r.restarted, true);
    assert.equal(r.restartReason, 'truncated');
    assert.deepEqual(pairs(c.lines), [{ offset: 0, value: { fresh: 1 } }]);
    assert.equal(r.state.byteOffset, 12);
  });

  it('truncated and regrown with the same first lines still restarts when the file is now shorter', async () => {
    await write(lines(6));
    const s1 = okOf((await collect(file, undefined)).result).state;
    await write(lines(2));
    await fsp.appendFile(file, '{"extra":true}\n');
    const c = await collect(file, s1);
    const r = okOf(c.result);
    assert.equal(r.restartReason, 'truncated');
    assert.equal(c.lines.length, 3);
  });

  it('head bytes changed although the file grew: headChanged, re-read from byte 0', async () => {
    await write(lines(3));
    const s1 = okOf((await collect(file, undefined)).result).state;
    await write(lines(6, 'other'));
    const c = await collect(file, s1);
    const r = okOf(c.result);
    assert.equal(r.restarted, true);
    assert.equal(r.restartReason, 'headChanged');
    assert.equal(c.lines.length, 6);
    assert.equal(r.state.byteOffset, utf8(lines(6, 'other')).length);
  });

  it('same size, different bytes, new mtime: headChanged', async () => {
    await write('{"a":"x"}\n{"a":"y"}\n');
    await setMtime(file, 1_600_000_000_000);
    const s1 = okOf((await collect(file, undefined)).result).state;
    await write('{"a":"p"}\n{"a":"q"}\n');
    await setMtime(file, 1_600_000_005_000);
    const c = await collect(file, s1);
    assert.equal(okOf(c.result).restartReason, 'headChanged');
    assert.deepEqual(c.lines.map((l) => l.value), [{ a: 'p' }, { a: 'q' }]);
  });

  it('documents the limit: a rewrite that keeps the first 4 KiB and the line structure is not detected', async () => {
    const big = (tail: string): string => `{"p":"${'x'.repeat(HEAD_HASH_BYTES + 200)}","t":"${tail}"}\n`;
    await write(big('aaaa'));
    await setMtime(file, 1_600_000_000_000);
    const s1 = okOf((await collect(file, undefined)).result).state;
    await write(big('bbbb'));
    await setMtime(file, 1_600_000_005_000);
    const c = await collect(file, s1);
    const r = okOf(c.result);
    assert.equal(r.restarted, false);
    assert.equal(c.lines.length, 0); // the id dedupe in the store is the safety net for this case
  });

  it('identical size and mtime: unchanged after one stat, the file is never opened', async () => {
    await write(lines(3));
    const first = probeFs();
    const s1 = okOf((await collect(file, undefined, { fs: first.fs })).result).state;
    assert.equal(first.probe.opens, 1);
    const again = probeFs();
    const c = await collect(file, s1, { fs: again.fs });
    const r = okOf(c.result);
    assert.equal(r.unchanged, true);
    assert.equal(r.restarted, false);
    assert.deepEqual(r.state, s1);
    assert.notEqual(r.state, s1); // a copy: callers may mutate it
    assert.equal(c.lines.length, 0);
    assert.deepEqual({ stats: again.probe.stats, opens: again.probe.opens, reads: again.probe.reads }, { stats: 1, opens: 0, reads: 0 });
  });

  it('an mtime stored through an INTEGER column still counts as unchanged', async () => {
    await write(lines(2));
    await setMtime(file, 1_600_000_000_123);
    const s1 = okOf((await collect(file, undefined)).result).state;
    const truncated: TailState = { ...s1, mtimeMs: Math.floor(s1.mtimeMs) };
    assert.equal(okOf((await collect(file, truncated)).result).unchanged, true);
  });

  it('same size but a new mtime is read, finds nothing new and records the new mtime', async () => {
    await write(lines(2));
    await setMtime(file, 1_600_000_000_000);
    const s1 = okOf((await collect(file, undefined)).result).state;
    await setMtime(file, 1_600_000_009_000);
    const c = await collect(file, s1);
    const r = okOf(c.result);
    assert.equal(r.unchanged, false);
    assert.equal(r.restarted, false);
    assert.equal(c.lines.length, 0);
    assert.equal(r.state.mtimeMs, 1_600_000_009_000);
    assert.equal(r.state.byteOffset, s1.byteOffset);
  });

  it('a prior state with a zero offset is not a restart, however the file changed', async () => {
    await write(lines(2));
    const c = await collect(file, { size: 999, mtimeMs: 1, byteOffset: 0, headHash: 'whatever' });
    const r = okOf(c.result);
    assert.equal(r.restarted, false);
    assert.equal(c.lines.length, 2);
  });
});

// ── Missing and unreadable files ────────────────────────────────────────────────────────────────

describe('ndjsonTail: files that cannot be read', () => {
  it('a missing file is a result, not an exception', async () => {
    const c = await collect(path.join(dir, 'nope.jsonl'), undefined);
    assert.deepEqual(c.result, { status: 'missing' });
    assert.equal(c.batches.length, 0);
  });

  it('a path below a regular file counts as missing too (ENOTDIR)', async () => {
    await write('{"a":1}\n');
    assert.deepEqual((await collect(path.join(file, 'child.jsonl'), undefined)).result, { status: 'missing' });
  });

  it('a file removed between stat and open is missing', async () => {
    await write('{"a":1}\n');
    const { fs, probe } = probeFs({ open: () => { throw fsError('ENOENT'); } });
    const c = await collect(file, undefined, { fs });
    assert.deepEqual(c.result, { status: 'missing' });
    assert.deepEqual({ stats: probe.stats, opens: probe.opens, closes: probe.closes }, { stats: 1, opens: 1, closes: 0 });
  });

  it('a permission error is unreadable and reported once per file until it recovers', async () => {
    await write('{"a":1}\n');
    const memo = new Set<string>();
    const denied = probeFs({ open: () => { throw fsError('EACCES'); } });
    const run = (fs = denied.fs) => collect(file, undefined, { fs, errorMemo: memo });

    const first = (await run()).result;
    assert.equal(first.status, 'unreadable');
    assert.ok(first.status === 'unreadable' && first.code === 'EACCES' && first.firstReport && /EACCES/.test(first.message));
    const second = (await run()).result;
    assert.ok(second.status === 'unreadable' && second.firstReport === false);

    assert.equal((await collect(file, undefined, { errorMemo: memo })).result.status, 'ok'); // readable again
    assert.equal(memo.has(file), false);
    const third = (await run()).result;
    assert.ok(third.status === 'unreadable' && third.firstReport);

    await run(); // reported, memo now holds the file again
    await fsp.rm(file);
    assert.equal((await collect(file, undefined, { errorMemo: memo })).result.status, 'missing');
    assert.equal(memo.has(file), false); // gone: a later failure is news again
  });

  it('without an errorMemo every failure counts as a first report', async () => {
    await write('{"a":1}\n');
    const { fs } = probeFs({ open: () => { throw fsError('EACCES'); } });
    for (let i = 0; i < 2; i++) {
      const r = (await collect(file, undefined, { fs })).result;
      assert.ok(r.status === 'unreadable' && r.firstReport);
    }
  });

  it('an unchanged file also clears its failure memo', async () => {
    await write('{"a":1}\n');
    const s1 = okOf((await collect(file, undefined)).result).state;
    const memo = new Set<string>([file]);
    assert.equal(okOf((await collect(file, s1, { errorMemo: memo })).result).unchanged, true);
    assert.equal(memo.size, 0);
  });

  it('a failing stat is unreadable', async () => {
    const { fs } = probeFs({ stat: () => { throw fsError('EPERM'); } });
    const r = (await collect(file, undefined, { fs })).result;
    assert.ok(r.status === 'unreadable' && r.code === 'EPERM');
  });

  it('a directory is unreadable (ENOTFILE), not opened', async () => {
    const { fs, probe } = probeFs();
    const r = (await collect(dir, undefined, { fs })).result;
    assert.ok(r.status === 'unreadable' && r.code === 'ENOTFILE' && r.firstReport);
    assert.equal(probe.opens, 0);
  });

  it('a read error mid-scan is unreadable: earlier batches were delivered, no state comes back, the handle is closed', async () => {
    await write('{"n":1}\n{"n":2}\n{"n":3}\n');
    const { fs, probe } = probeFs({ read: (n) => { if (n === 2) throw fsError('EIO'); return undefined; } });
    const c = await collect(file, undefined, { fs, chunkSize: 8, batchSize: 1 });
    assert.ok(c.result.status === 'unreadable' && c.result.code === 'EIO');
    assert.equal(c.lines.length, 1);
    assert.equal(probe.closes, probe.opens);
  });

  it('a failing close is ignored', async () => {
    await write('{"n":1}\n');
    const { fs, probe } = probeFs({ close: () => { throw fsError('EIO'); } });
    const c = await collect(file, undefined, { fs });
    assert.equal(okOf(c.result).state.byteOffset, 8);
    assert.equal(probe.closes, 1);
  });

  it('errors that are not filesystem conditions propagate and still close the handle', async () => {
    await write('{"n":1}\n');
    const thrown: unknown[] = [new Error('boom'), 'a string', Object.assign(new Error('x'), { code: 'ERR_X' }), Object.assign(new Error('y'), { code: 5 })];
    for (const err of thrown) {
      const { fs, probe } = probeFs();
      const prefilter = (): boolean => { throw err; };
      await assert.rejects(collect(file, undefined, { fs, prefilter }), (e) => e === err);
      assert.equal(probe.closes, 1);
    }
  });

  it('a read that comes back short or empty (the file shrank after the snapshot) ends the scan cleanly', async () => {
    // 16 bytes on disk, but the snapshot claims 70: the third read returns nothing.
    await write('{"a":1}\n{"b":2}\n');
    const inflate = probeFs({ handleStat: (st) => ({ ...st, size: 70 }) });
    const empty = await collect(file, undefined, { fs: inflate.fs, chunkSize: 8 });
    assert.deepEqual(empty.lines.map((l) => l.value), [{ a: 1 }, { b: 2 }]);
    assert.equal(okOf(empty.result).state.byteOffset, 16);

    // 24 bytes on disk, snapshot 70, chunk 16: the second read is short (8 of 16) and ends the scan.
    await write('{"a":1}\n{"b":2}\n{"c":3}\n');
    const shortRead = probeFs({ handleStat: (st) => ({ ...st, size: 70 }) });
    const c = await collect(file, undefined, { fs: shortRead.fs, chunkSize: 16 });
    assert.deepEqual(c.lines.map((l) => l.value), [{ a: 1 }, { b: 2 }, { c: 3 }]);
    assert.equal(okOf(c.result).state.byteOffset, 24);

    // A short read that ends inside a line leaves that line for the next call.
    await write('{"a":1}\n{"b":2}\n{"c"');
    const midLine = probeFs({ handleStat: (st) => ({ ...st, size: 70 }) });
    const m = await collect(file, undefined, { fs: midLine.fs, chunkSize: 8 });
    assert.deepEqual(m.lines.map((l) => l.value), [{ a: 1 }, { b: 2 }]);
    assert.equal(okOf(m.result).state.byteOffset, 16);
  });
});

// ── Prefilter, bad lines, batches ───────────────────────────────────────────────────────────────

describe('ndjsonTail: prefilter, bad lines and batches', () => {
  it('the prefilter sees raw line bytes without the terminator, before any parse', async () => {
    await write('{"usage":1}\r\n{"other":2}\n');
    const seen: Buffer[] = [];
    await collect(file, undefined, { prefilter: (line) => { seen.push(Buffer.from(line)); return true; } });
    assert.deepEqual(seen.map((b) => b.toString()), ['{"usage":1}', '{"other":2}']);
    assert.ok(seen.every((b) => Buffer.isBuffer(b)));
  });

  it('lines the prefilter rejects are neither parsed nor counted as bad; accepted garbage is counted', async () => {
    const text = 'not json at all\n{"usage":1}\n"usage" but not json\n{"x":1}\n';
    await write(text);
    const filtered = okOf((await collect(file, undefined, { prefilter: needlePrefilter(NEEDLE) })).result);
    assert.equal(filtered.stats.lines, 4);
    assert.equal(filtered.stats.parsed, 1);
    assert.equal(filtered.stats.badLines, 1); // the false positive: it carries the needle but is not JSON
    const unfiltered = okOf((await collect(file, undefined)).result);
    assert.equal(unfiltered.stats.parsed, 2);
    assert.equal(unfiltered.stats.badLines, 2);
  });

  it('needlePrefilter takes a string or bytes and matches anywhere in the line', () => {
    const byString = needlePrefilter('"usage"');
    const byBytes = needlePrefilter(Buffer.from('"usage"'));
    for (const f of [byString, byBytes]) {
      assert.equal(f(utf8('{"a":{"usage":{}}}')), true);
      assert.equal(f(utf8('{"a":"usage"}')), true); // false positive by design
      assert.equal(f(utf8('{"a":1}')), false);
      assert.equal(f(utf8('')), false);
    }
    assert.equal(needlePrefilter('é日')(utf8('{"a":"é日"}')), true);
  });

  it('bad JSON never throws and never stops the scan', async () => {
    await write('{"a":1}\n{broken\n\u0000\u0001\n{"b":2}\n{"c":\n{"d":4}\n');
    const c = await collect(file, undefined);
    assert.deepEqual(c.lines.map((l) => l.value), [{ a: 1 }, { b: 2 }, { d: 4 }]);
    assert.equal(okOf(c.result).stats.badLines, 3);
  });

  it('yields batches of at most batchSize lines, in order, and nothing when there is nothing', async () => {
    const text = Array.from({ length: 10 }, (_, i) => JSON.stringify({ i })).join('\n') + '\n';
    await write(text);
    const c = await collect(file, undefined, { batchSize: 3, chunkSize: 16 });
    assert.deepEqual(c.batches.map((b) => b.length), [3, 3, 3, 1]);
    assert.deepEqual(c.lines.map((l) => (l.value as { i: number }).i), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const exact = await collect(file, undefined, { batchSize: 5 });
    assert.deepEqual(exact.batches.map((b) => b.length), [5, 5]);
    const one = await collect(file, undefined);
    assert.deepEqual(one.batches.map((b) => b.length), [10]);
    await write('not json\n');
    assert.equal((await collect(file, undefined)).batches.length, 0);
  });
});

// ── Long lines ──────────────────────────────────────────────────────────────────────────────────

describe('ndjsonTail: oversize lines', () => {
  const small = (n: number): string => `{"n":${n}}\n`;
  const sized = (total: number): string => `{"p":"${'x'.repeat(total - 9)}"}\n`; // `total` bytes including the newline
  const OPTS: TailOptions = { chunkSize: 8, maxLineBytes: 32 };

  it('a line that fits the cap exactly is kept, one byte more is skipped and counted', async () => {
    await write(small(1) + sized(32) + sized(33) + small(2));
    const c = await collect(file, undefined, OPTS);
    const r = okOf(c.result);
    assert.deepEqual(c.lines.map((l) => Object.keys(l.value)[0]), ['n', 'p', 'n']);
    assert.equal(r.stats.oversizeLines, 1);
    assert.equal(r.stats.parsed, 3);
    assert.equal(r.state.byteOffset, 8 + 32 + 33 + 8);
    assert.equal(c.lines[2]?.lineStartOffset, 8 + 32 + 33);
  });

  it('skips a very long line that spans many reads and carries on at exact offsets', async () => {
    const huge = `{"p":"${'y'.repeat(400)}"}\n`;
    const bytes = utf8(small(1) + huge + small(2) + huge + small(3));
    await write(bytes);
    const c = await collect(file, undefined, OPTS);
    const r = okOf(c.result);
    assert.deepEqual(pairs(c.lines), [
      { offset: 0, value: { n: 1 } },
      { offset: 8 + huge.length, value: { n: 2 } },
      { offset: 16 + 2 * huge.length, value: { n: 3 } },
    ]);
    assert.equal(r.stats.oversizeLines, 2);
    assert.equal(r.state.byteOffset, bytes.length);
  });

  it('an oversize line still being written is not consumed; it is skipped once it ends', async () => {
    const huge = 'x'.repeat(200);
    await write(small(1) + `{"p":"${huge}`);
    const first = await collect(file, undefined, OPTS);
    const s1 = okOf(first.result).state;
    assert.equal(s1.byteOffset, 8); // the start of the unfinished line
    assert.deepEqual(first.lines.map((l) => l.value), [{ n: 1 }]);
    await fsp.appendFile(file, `"}\n${small(2)}`);
    const second = await collect(file, s1, OPTS);
    assert.deepEqual(second.lines.map((l) => l.value), [{ n: 2 }]);
    assert.equal(okOf(second.result).state.byteOffset, 8 + huge.length + 9 + 8);
  });

  it('a chunk larger than the cap lifts the cap to the chunk', async () => {
    await write(sized(40) + small(1));
    const c = await collect(file, undefined, { chunkSize: 64, maxLineBytes: 4 });
    assert.equal(c.lines.length, 2);
    assert.equal(okOf(c.result).stats.oversizeLines, 0);
  });
});

// ── Pacing ──────────────────────────────────────────────────────────────────────────────────────

describe('ndjsonTail: event-loop pacing', () => {
  const manyLines = (n: number): string => Array.from({ length: n }, (_, i) => JSON.stringify({ i, usage: i })).join('\n') + '\n';

  it('hands the loop back at least every yieldEveryMs of work (injected clock)', async () => {
    await write(manyLines(60));
    let t = 0;
    const clock = (): number => (t += 3);

    const recorded: number[] = [];
    const r = okOf((await collect(file, undefined, {
      now: clock,
      yieldEveryMs: 10,
      yieldToEventLoop: async () => { recorded.push(t); },
    })).result);
    assert.ok(r.stats.yields >= 10, `only ${r.stats.yields} yields`);
    assert.equal(r.stats.yields, recorded.length);
    assert.ok(r.stats.maxSliceMs > 0 && Number.isFinite(r.stats.maxSliceMs));

    // Same file, counting how many lines the consumer got between two consecutive yields.
    t = 0;
    let delivered = 0;
    let atLastYield = 0;
    const gaps: number[] = [];
    await runTail(file, undefined, {
      now: clock,
      yieldEveryMs: 10,
      batchSize: 1,
      yieldToEventLoop: async () => { gaps.push(delivered - atLastYield); atLastYield = delivered; },
    }, (batch) => { delivered += batch.length; });
    assert.equal(delivered, 60);
    assert.ok(gaps.length > 0);
    assert.ok(Math.max(...gaps) <= 4, `lines between yields: ${gaps.join(',')}`);
  });

  it('with a huge budget it never yields; with a zero budget it yields at every parsed line (real setImmediate)', async () => {
    await write(manyLines(300));
    const never = okOf((await collect(file, undefined, { yieldEveryMs: 1e12 })).result);
    assert.equal(never.stats.yields, 0);

    let ticks = 0;
    let stop = false;
    const tick = (): void => {
      if (stop) return;
      ticks++;
      setImmediate(tick);
    };
    setImmediate(tick);
    const eager = okOf((await collect(file, undefined, { yieldEveryMs: 0 })).result);
    stop = true;
    assert.ok(eager.stats.yields >= 300, `yields ${eager.stats.yields}`);
    assert.ok(ticks >= eager.stats.yields - 2, `a concurrent setImmediate loop got ${ticks} turns for ${eager.stats.yields} yields`);
  });

  it('yields between chunks even when no line passes the prefilter', async () => {
    await write(Array.from({ length: 40 }, (_, i) => `{"skip":${i}}`).join('\n') + '\n');
    let t = 0;
    const r = okOf((await collect(file, undefined, {
      chunkSize: 64,
      now: () => (t += 100),
      yieldEveryMs: 50,
      yieldToEventLoop: async () => undefined,
      prefilter: needlePrefilter(NEEDLE),
    })).result);
    assert.ok(r.stats.chunks > 5);
    assert.ok(r.stats.yields >= r.stats.chunks - 1, `${r.stats.yields} yields over ${r.stats.chunks} chunks`);
    assert.equal(r.stats.parsed, 0);
  });

  it('the default clock produces plausible slice and elapsed times', async () => {
    await write(manyLines(2000));
    const r = okOf((await collect(file, undefined)).result);
    assert.ok(r.stats.maxSliceMs >= 0 && r.stats.maxSliceMs <= r.stats.elapsedMs + 1);
    assert.ok(r.stats.elapsedMs >= 0);
    assert.equal(r.stats.bytesRead, (await fsp.stat(file)).size);
  });
});

// ── Persist contract and iterator behaviour ─────────────────────────────────────────────────────

describe('ndjsonTail: persistence contract', () => {
  it('a crash before the state is persisted re-reads the same lines from the old state; persisting then moves on', async () => {
    const part1 = '{"n":1}\n{"n":2}\n';
    await write(part1);
    const s0 = okOf((await collect(file, undefined)).result).state;
    await fsp.appendFile(file, '{"n":3}\n{"n":4}\n{"n":5');
    const attempt1 = await collect(file, s0);
    const attempt2 = await collect(file, s0); // the process "died" before persisting attempt1's state
    assert.deepEqual(attempt1.lines, attempt2.lines);
    assert.deepEqual(okOf(attempt1.result).state, okOf(attempt2.result).state);
    assert.deepEqual(attempt1.lines.map((l) => l.value), [{ n: 3 }, { n: 4 }]);

    const s1 = okOf(attempt1.result).state; // persisted this time
    await fsp.appendFile(file, '}\n{"n":6}\n');
    const next = await collect(file, s1);
    assert.deepEqual(next.lines.map((l) => l.value), [{ n: 5 }, { n: 6 }]);
    assert.equal(okOf(next.result).restarted, false);
  });

  it('stopping early closes the handle and returns control without a state', async () => {
    await write('{"n":1}\n{"n":2}\n{"n":3}\n');
    const { fs, probe } = probeFs();
    const it = tailNdjson(file, undefined, { fs, batchSize: 1 });
    const first = await it.next();
    assert.equal(first.done, false);
    assert.equal(probe.closes, 0);
    const end = await it.return({ status: 'missing' });
    assert.equal(end.done, true);
    assert.equal(probe.closes, 1);
  });

  it('runTail awaits each batch before reading on, and closes the handle when the consumer throws', async () => {
    await write('{"n":1}\n{"n":2}\n{"n":3}\n');
    const order: string[] = [];
    const { fs, probe } = probeFs({ read: () => { order.push('read'); return undefined; } });
    const result = await runTail(file, undefined, { fs, batchSize: 1, chunkSize: 8 }, async (batch) => {
      order.push(`batch:${(batch[0]?.value as { n: number }).n}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
      order.push('done');
    });
    assert.equal(result.status, 'ok');
    assert.equal(order.join(' '), 'read batch:1 done read batch:2 done read batch:3 done read'); // the last read is the head hash
    assert.equal(probe.closes, 1);

    const failing = probeFs();
    await assert.rejects(runTail(file, undefined, { fs: failing.fs, batchSize: 1 }, () => { throw new Error('insert failed'); }), /insert failed/);
    assert.equal(failing.probe.closes, 1);
  });

  it('works for a missing file through runTail without calling the consumer', async () => {
    let calls = 0;
    const r = await runTail(path.join(dir, 'absent.jsonl'), undefined, {}, () => { calls++; });
    assert.equal(r.status, 'missing');
    assert.equal(calls, 0);
  });
});

// ── Paths ───────────────────────────────────────────────────────────────────────────────────────

describe('ndjsonTail: duckDbFilename', () => {
  it('spells paths the way DuckDB reported them: forward slashes', () => {
    assert.equal(duckDbFilename('C:\\Users\\me\\AppData\\Code\\logs\\otel.jsonl'), 'C:/Users/me/AppData/Code/logs/otel.jsonl');
    assert.equal(duckDbFilename('/home/me/.claude/projects/x/a.jsonl'), '/home/me/.claude/projects/x/a.jsonl');
    // The Copilot event id key is a pure function of that spelling.
    assert.equal(fileKeyOf(duckDbFilename('C:\\a\\b.jsonl')), fileKeyOf('C:/a/b.jsonl'));
    assert.notEqual(fileKeyOf('C:\\a\\b.jsonl'), fileKeyOf('C:/a/b.jsonl'));
  });
});

// ── Golden fixtures: two passes over a growing tree ─────────────────────────────────────────────

const FIXTURES = path.resolve(__dirname, '../../golden/fixtures');

async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(path.join(root, rel), { withFileTypes: true })) {
    const next = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, next)));
    else if (entry.name.endsWith('.jsonl')) out.push(next);
  }
  return out.sort();
}

async function copyTree(from: string, to: string): Promise<void> {
  await fsp.mkdir(to, { recursive: true });
  for (const rel of await walk(from)) {
    await fsp.mkdir(path.dirname(path.join(to, rel)), { recursive: true });
    await fsp.copyFile(path.join(from, rel), path.join(to, rel));
  }
}

async function appendTree(from: string, to: string): Promise<void> {
  for (const rel of await walk(from)) await fsp.appendFile(path.join(to, rel), await fsp.readFile(path.join(from, rel)));
}

const msgId = (v: unknown): string | undefined => ((v as { message?: { id?: string } }).message?.id);

describe('ndjsonTail: golden fixtures, pass 1 then pass 2 via saved state', () => {
  let root: string;
  before(async () => {
    root = await makeTmpDir('golden');
  });
  after(async () => {
    await removeDir(root);
  });

  /** One ingest pass over every file of a tree with a shared in-memory `ingest_state`. */
  async function pass(tree: string, states: Map<string, TailState>, opts: TailOptions) {
    const lines = new Map<string, Array<{ offset: number; value: unknown }>>();
    const results = new Map<string, ReturnType<typeof okOf>>();
    for (const rel of await walk(tree)) {
      const f = path.join(tree, rel);
      const c = await collect(f, states.get(rel), opts);
      const r = okOf(c.result);
      states.set(rel, r.state); // persisted only after the lines were handed over
      lines.set(rel, pairs(c.lines));
      results.set(rel, r);
    }
    return { lines, results };
  }

  it('Claude: pass 2 yields exactly the new lines, completes the unterminated and cut lines, and reads the old-timestamp line', async () => {
    const tree = path.join(root, 'claude');
    await copyTree(path.join(FIXTURES, 'claude'), tree);
    const opts: TailOptions = { prefilter: needlePrefilter(NEEDLE), chunkSize: 4096 };
    const states = new Map<string, TailState>();

    const one = await pass(tree, states, opts);
    await appendTree(path.join(FIXTURES, 'claude-pass2'), tree);
    const two = await pass(tree, states, opts);

    const ids = (p: typeof one): string[] => [...p.lines.values()].flat().map((l) => msgId(l.value) ?? '');
    const pass1Ids = ids(one);
    const pass2Ids = ids(two);

    // The unterminated and cut lines of pass 1 are not consumed...
    for (const id of ['msg_unterm', 'msg_cut']) {
      assert.ok(!pass1Ids.includes(id), `${id} must wait for its newline`);
      assert.equal(pass2Ids.filter((x) => x === id).length, 1, `${id} arrives once, whole, in pass 2`);
    }
    // ...the lines written after them, and the late lines of an already-seen message (B1), are.
    assert.deepEqual(pass2Ids.filter((id) => id.startsWith('msg_after') || id.startsWith('msg_post')).sort(), ['msg_afterterm', 'msg_postcut']);
    assert.equal(pass1Ids.filter((id) => id === 'msg_late').length, 1);
    assert.equal(pass2Ids.filter((id) => id === 'msg_late').length, 2);
    const late = [...two.lines.values()].flat().filter((l) => msgId(l.value) === 'msg_late').map((l) => (l.value as { message: { usage: { output_tokens: number } } }).message.usage.output_tokens);
    assert.deepEqual(late, [180, 400]);

    // B2: a new message whose timestamp is older than everything pass 1 saw is not skipped.
    const stamp = (v: unknown): number => Date.parse((v as { timestamp: string }).timestamp);
    const watermark = Math.max(...[...one.lines.values()].flat().map((l) => stamp(l.value)));
    const oldLate = [...two.lines.values()].flat().find((l) => msgId(l.value) === 'msg_old_late');
    assert.ok(oldLate, 'msg_old_late is read');
    assert.ok(stamp(oldLate.value) < watermark, 'and it is older than the pass-1 watermark');

    // Pass 2 touched exactly the appended files; the rest were not even opened.
    const touched = ['-work-alpha/aaaaaaaa-1111-4111-8111-000000000001.jsonl', '-work-beta/bbbbbbbb-2222-4222-8222-000000000001.jsonl', '-work-beta/bbbbbbbb-2222-4222-8222-000000000003.jsonl', '-work-gamma/cccccccc-3333-4333-8333-000000000001.jsonl'];
    for (const [rel, r] of two.results) {
      assert.equal(r.restarted, false, rel);
      assert.equal(r.unchanged, !touched.includes(rel), rel);
    }
    assert.equal(pass2Ids.length, 10);

    // Nothing skipped, nothing read twice: both passes together are a single read of the final tree.
    const fresh = await pass(tree, new Map(), opts);
    for (const rel of await walk(tree)) {
      assert.deepEqual([...(one.lines.get(rel) ?? []), ...(two.lines.get(rel) ?? [])], fresh.lines.get(rel), rel);
      const offsets = [...(one.lines.get(rel) ?? []), ...(two.lines.get(rel) ?? [])].map((l) => l.offset);
      assert.deepEqual(offsets, [...new Set(offsets)].sort((a, b) => a - b), `${rel}: offsets strictly increase`);
      const bytes = await fsp.readFile(path.join(tree, rel));
      for (const l of fresh.lines.get(rel) ?? []) {
        assert.deepEqual(JSON.parse(bytes.subarray(l.offset, bytes.indexOf(0x0a, l.offset)).toString('utf8')), l.value, `${rel}@${l.offset}`);
      }
      assert.equal(states.get(rel)?.byteOffset, bytes.length, `${rel}: fully consumed`);
      scenarios++;
    }
  });

  it('Claude: without a prefilter the garbage line is counted, not fatal, and every line is accounted for', async () => {
    const tree = path.join(root, 'claude-nofilter');
    await copyTree(path.join(FIXTURES, 'claude'), tree);
    const states = new Map<string, TailState>();
    const one = await pass(tree, states, {});
    let bad = 0;
    let lines = 0;
    let parsed = 0;
    for (const r of one.results.values()) {
      bad += r.stats.badLines;
      lines += r.stats.lines;
      parsed += r.stats.parsed;
    }
    assert.equal(bad, 1); // "this is not json {{{"
    assert.equal(parsed + bad, lines); // no blank lines in the fixtures
    const prefiltered = await pass(tree, new Map(), { prefilter: needlePrefilter(NEEDLE) });
    assert.equal([...prefiltered.results.values()].reduce((n, r) => n + r.stats.badLines, 0), 0);
  });

  it('Copilot: pass 2 delivers the appended spans, including the replay of an old span, with nothing skipped or repeated', async () => {
    const tree = path.join(root, 'copilot');
    await copyTree(path.join(FIXTURES, 'copilot'), tree);
    const states = new Map<string, TailState>();
    const one = await pass(tree, states, {});
    await appendTree(path.join(FIXTURES, 'copilot-pass2'), tree);
    const two = await pass(tree, states, {});

    const spanIds = (p: typeof one, rel: string): string[] => (p.lines.get(rel) ?? []).map((l) => String((l.value as { spanId?: string }).spanId));
    assert.deepEqual(spanIds(two, 'otel.jsonl'), ['live-001', 'live-002', 'live-003', 'sp-002']);
    assert.ok(spanIds(one, 'otel.jsonl').includes('sp-002'), 'the replayed span was already there: the store dedupes it by id');
    assert.equal(two.results.get('otel-map.jsonl')?.unchanged, true);
    assert.equal(two.results.get('otel-mixed.jsonl')?.unchanged, true);

    const fresh = await pass(tree, new Map(), {});
    assert.deepEqual([...(one.lines.get('otel.jsonl') ?? []), ...(two.lines.get('otel.jsonl') ?? [])], fresh.lines.get('otel.jsonl'));
    for (const r of fresh.results.values()) assert.equal(r.stats.badLines, 0);
  });

  it('Copilot: mixed attribute shapes and number-like strings survive line by line (B3, B4)', async () => {
    const mixed = await collect(path.join(FIXTURES, 'copilot', 'otel-mixed.jsonl'), undefined);
    const attrs = mixed.lines.map((l) => (l.value as { attributes: unknown }).attributes);
    assert.equal(attrs.length, 2, 'both spans survive');
    assert.ok(Array.isArray(attrs[0]), 'OTLP array form');
    assert.ok(!Array.isArray(attrs[1]) && typeof attrs[1] === 'object', 'plain map form');

    const map = await collect(path.join(FIXTURES, 'copilot', 'otel-map.jsonl'), undefined);
    const seven = map.lines.map((l) => l.value as { spanId: string; attributes: Record<string, unknown> }).find((v) => v.spanId === 'map-007');
    assert.equal(seven?.attributes['gen_ai.usage.input_tokens'], '55', 'a number-like string stays the string "55"');
    const one = map.lines.map((l) => l.value as { spanId: string; attributes: Record<string, unknown> }).find((v) => v.spanId === 'map-001');
    assert.equal(one?.attributes['gen_ai.usage.input_tokens'], 1000, 'while numbers stay numbers');
  });
});

describe('ndjsonTail: parity with the spike selftest', () => {
  it('ran at least the 265 scenarios of spikes/s2/ndjson/selftest.mjs', function () {
    if (scenarios === 0) this.skip(); // the file was filtered with --grep
    assert.ok(scenarios >= 265, `only ${scenarios} scenarios`);
  });
});

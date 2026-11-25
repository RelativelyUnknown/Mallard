// S2.3: NDJSON tail benchmark. Each measurement runs in a fresh child process (clean JIT/RSS, 5 runs each).
//
//   node --disable-warning=ExperimentalWarning spikes/s2/ndjson/bench.mjs [--mb 500] [--runs 5] [--keep]
//
// Variants:
//   nf-1MB   needle-first Buffer scan, 1 MiB chunks, prefilter '"usage"', JSON.parse only on hits   (proposed A3 design)
//   ls-1MB   line-split Buffer scan (visit every line), same prefilter
//   nf-64K / nf-256K / nf-4MB  chunk-size sensitivity of the proposed design
//   rl-all   readline + JSON.parse of every line                                                    (naive baseline)
//   rl-pre   readline + string.includes('"usage"') prefilter + JSON.parse on hits
//   incremental: after a full scan, append 1000 lines (last one unterminated), resume from stored offset
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { scanFile, headHash } from './stream.mjs';
import { generateFile, LineGen } from './gen.mjs';
import { summarize, fmt, mdTable, scratchDir, rmrf, saveResult, histMs, median } from '../lib/stats.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const me = fileURLToPath(import.meta.url);
const NEEDLE = '"usage"';

function newState() {
  return { parsed: 0, assistant: 0, outTokens: 0 };
}
function consume(text, st) {
  const o = JSON.parse(text);
  st.parsed++;
  if (o.type === 'assistant' && o.message?.usage) {
    st.assistant++;
    st.outTokens += o.message.usage.output_tokens;
  }
}

async function runVariant(variant, file) {
  const st = newState();
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  let out;
  const t0 = performance.now();
  if (variant.startsWith('nf-') || variant.startsWith('ls-')) {
    const chunk = { '1MB': 1 << 20, '64K': 64 << 10, '256K': 256 << 10, '4MB': 4 << 20 }[variant.slice(3)];
    const s = await scanFile(file, {
      chunkSize: chunk, needle: NEEDLE, strategy: variant.startsWith('nf-') ? 'needle-first' : 'line-split',
      onLine: (line) => consume(line.toString('utf8'), st),
    });
    out = { maxSyncMs: s.maxSyncMs, nextOffset: s.nextOffset, hits: s.hits, chunks: s.chunks, lines: s.lines };
  } else {
    const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
    let lines = 0;
    for await (const line of rl) {
      lines++;
      if (variant === 'rl-all' || line.includes(NEEDLE)) consume(line, st);
    }
    out = { lines };
  }
  const elapsedMs = performance.now() - t0;
  h.disable();
  return { variant, elapsedMs, el: histMs(h, 1), ...st, ...out, maxRssMB: process.resourceUsage().maxRSS / 1024 };
}

async function incremental(file) {
  const st = newState();
  const t0 = performance.now();
  const full = await scanFile(file, { needle: NEEDLE, onLine: (l) => consume(l.toString('utf8'), st) });
  const fullMs = performance.now() - t0;
  let offset = full.nextOffset;
  const size0 = fs.statSync(file).size;
  if (offset !== size0) throw new Error(`full scan offset ${offset} != size ${size0}`);
  const gen = new LineGen({ seed: 9001 });
  const rounds = [];
  for (let round = 0; round < 6; round++) {
    // append 1000 lines; the last one is cut in the middle (writer mid-flush)
    const lines = [];
    for (let i = 0; i < 1000; i++) lines.push(gen.next());
    const expectHits = lines.slice(0, 999).filter((l) => l.includes(NEEDLE)).length;
    const last = lines[999];
    const cut = Math.floor(last.length * 0.4);
    const head = `${lines.slice(0, 999).join('\n')}\n${last.slice(0, cut)}`;
    fs.appendFileSync(file, head);
    const sizeAfterAppend = fs.statSync(file).size;
    const expectNext = sizeAfterAppend - Buffer.byteLength(last.slice(0, cut));
    const stA = newState();
    const a0 = performance.now();
    const h0 = await headHash(file);
    const a1 = performance.now();
    const sa = await scanFile(file, { startOffset: offset, needle: NEEDLE, onLine: (l) => consume(l.toString('utf8'), stA) });
    const aMs = performance.now() - a1;
    const headMs = a1 - a0;
    if (sa.hits !== expectHits || sa.nextOffset !== expectNext) throw new Error(`incremental mismatch: hits ${sa.hits}/${expectHits} next ${sa.nextOffset}/${expectNext}`);
    offset = sa.nextOffset;
    // writer finishes the line
    fs.appendFileSync(file, `${last.slice(cut)}\n`);
    const stB = newState();
    const b0 = performance.now();
    const sb = await scanFile(file, { startOffset: offset, needle: NEEDLE, onLine: (l) => consume(l.toString('utf8'), stB) });
    const bMs = performance.now() - b0;
    const expectLast = last.includes(NEEDLE) ? 1 : 0;
    if (sb.hits !== expectLast || sb.nextOffset !== fs.statSync(file).size) throw new Error('resume after partial line mismatch');
    offset = sb.nextOffset;
    rounds.push({ appendedBytes: sizeAfterAppend - size0, headHashMs: headMs, scan1000Ms: aMs, scan1000Block: sa.maxSyncMs, hits: sa.hits, resumeLastLineMs: bMs, h0 });
  }
  return { fullMs, rounds };
}

if (process.argv.includes('--child')) {
  const variant = arg('variant');
  const file = arg('file');
  const res = variant === 'incremental' ? await incremental(file) : await runVariant(variant, file);
  console.log(JSON.stringify(res));
  process.exit(0);
}

// ---------- parent ----------
const MB = +arg('mb', 500);
const RUNS = +arg('runs', 5);
const dir = scratchDir('ndjson-bench');
const file = path.join(dir, 'big.jsonl');
const t0 = performance.now();
const gen = generateFile(file, MB, 3);
const meta = gen.stats;
console.log(`generated ${(meta.bytes / 2 ** 20).toFixed(0)} MiB, ${meta.lines} lines, ${meta.assistant} assistant, ${meta.falsePositives} prefilter false positives in ${((performance.now() - t0) / 1000).toFixed(1)} s`);

function runChild(variant) {
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', me, '--child', '--variant', variant, '--file', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`${variant}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const variants = ['nf-1MB', 'ls-1MB', 'nf-64K', 'nf-256K', 'nf-4MB', 'rl-all', 'rl-pre'];
const results = [];
for (const v of variants) {
  const runs = [];
  for (let i = 0; i < RUNS; i++) {
    const r = runChild(v);
    if (r.assistant !== meta.assistant || r.outTokens !== meta.outputTokens) {
      throw new Error(`${v}: wrong totals assistant ${r.assistant}/${meta.assistant} tokens ${r.outTokens}/${meta.outputTokens}`);
    }
    runs.push(r);
    process.stdout.write('.');
  }
  results.push({
    variant: v,
    elapsed: summarize(runs.map((r) => r.elapsedMs)),
    block: runs[0].maxSyncMs !== undefined ? summarize(runs.map((r) => r.maxSyncMs)) : null,
    elMax: summarize(runs.map((r) => r.el.max)),
    elP99: summarize(runs.map((r) => r.el.p99)),
    parsed: runs[0].parsed, hits: runs[0].hits ?? null, maxRssMB: median(runs.map((r) => r.maxRssMB)),
    mbPerSec: (meta.bytes / 2 ** 20) / (median(runs.map((r) => r.elapsedMs)) / 1000),
  });
  console.log(`\n${v}: median ${fmt(results.at(-1).elapsed.p50, 0)} ms, EL max ${fmt(results.at(-1).elMax.p50)} ms`);
}

// cold page cache (needs root: echo 3 > /proc/sys/vm/drop_caches); skipped silently otherwise
const coldResults = [];
const dropCaches = () => {
  try { spawnSync('sync'); fs.writeFileSync('/proc/sys/vm/drop_caches', '3'); return true; } catch { return false; }
};
if (dropCaches()) {
  for (const v of ['nf-1MB', 'rl-all']) {
    const runs = [];
    for (let i = 0; i < 3; i++) { dropCaches(); runs.push(runChild(v)); process.stdout.write('c'); }
    coldResults.push({ variant: v, elapsed: summarize(runs.map((r) => r.elapsedMs)), elMax: summarize(runs.map((r) => r.el.max)) });
    console.log(`\ncold-cache ${v}: median ${fmt(coldResults.at(-1).elapsed.p50, 0)} ms (EL max ${fmt(coldResults.at(-1).elMax.max)} ms)`);
  }
}

// incremental, run in one child process (the file gets appended to, so it goes last)
const inc = runChild('incremental');
const incRounds = inc.rounds;
const incSummary = {
  fullScanMs: inc.fullMs,
  scan1000: summarize(incRounds.slice(1).map((r) => r.scan1000Ms)),
  scan1000First: incRounds[0].scan1000Ms,
  block: summarize(incRounds.map((r) => r.scan1000Block)),
  resumeLast: summarize(incRounds.map((r) => r.resumeLastLineMs)),
  headHash: summarize(incRounds.map((r) => r.headHashMs)),
  hitsPerRound: incRounds.map((r) => r.hits),
};

const table = mdTable(
  ['variant', 'full file p50 ms', 'p95 ms', 'max ms', 'MiB/s', 'JSON.parse calls', 'longest sync slice ms (p50/max)', 'EL-delay max ms (p50/max of runs)', 'EL-delay p99 ms (p50)', 'max RSS MB'],
  results.map((r) => [
    r.variant, fmt(r.elapsed.p50, 0), fmt(r.elapsed.p95, 0), fmt(r.elapsed.max, 0), fmt(r.mbPerSec, 0), r.parsed,
    r.block ? `${fmt(r.block.p50)}/${fmt(r.block.max)}` : 'n/a (stream callbacks)',
    `${fmt(r.elMax.p50)}/${fmt(r.elMax.max)}`, fmt(r.elP99.p50), fmt(r.maxRssMB, 0),
  ]),
);
console.log(`\n${table}`);
console.log('\nincremental:', JSON.stringify(incSummary));
saveResult('ndjson', { mb: MB, runs: RUNS, meta, results, coldResults, incremental: { ...incSummary, rounds: incRounds }, table });
if (!process.argv.includes('--keep')) rmrf(dir);

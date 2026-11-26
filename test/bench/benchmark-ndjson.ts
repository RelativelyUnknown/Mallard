/**
 * Benchmark of the byte-offset NDJSON tailer (stream A2b).
 *
 *     npx tsx test/bench/benchmark-ndjson.ts            # = `bun run bench:ndjson`
 *     npx tsx test/bench/benchmark-ndjson.ts --mb 100 --runs 3
 *
 * Generates one synthetic Claude-Code-style JSONL file (default ~100 MB; the S2 spike used 524 MB),
 * then measures, each in a fresh child process (clean JIT and RSS, median of --runs):
 *   - `tail`      the tailer with the `"usage"` prefilter, 1 MiB chunks (the proposed A3 design);
 *   - `readline`  readline + `includes('"usage"')` + JSON.parse, the naive baseline;
 * and in one more child the incremental case: after a full read, append 1000 lines (the last one cut
 * in half), resume from the stored state, then finish the line and resume again.
 * Reported: full-read throughput, longest synchronous slice (the tailer's own, plus perf_hooks
 * event-loop delay), incremental resume time, max RSS, against the spike's numbers (printed below).
 *
 * NOT part of the mocha suite. The temp file is removed afterwards.
 */
import { spawnSync } from 'child_process';
import { createReadStream, promises as fsp } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as readline from 'readline';
import { needlePrefilter, runTail, type TailState } from '../../src/extension-backend/ingest/ndjsonTail';

const NEEDLE = '"usage"';

// The spike's numbers (spikes/s2/RESULTS.md section 3, 524 MB file, same design).
const SPIKE = { mbPerSec: 1213, fullMs524: 412, readlineMbPerSec: 175, slice: 1.6, resume: 3.9, rss: 51 };

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

// ── Generator (port of spikes/s2/ndjson/gen.mjs) ────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ('const let function return import export async await class interface type string number boolean undefined null if else for ' +
  'while switch case break continue try catch finally throw new this super extends implements readonly private public protected static ' +
  'abstract enum namespace module declare require process env path file dir src test build dist node_modules package json yaml config ' +
  'server client request response error warn info debug usage tokens model repo branch commit merge rebase diff patch lint format compile ' +
  'bundle deploy release version héllo wörld naïve façade 日本語のテキスト 中文字符 한국어 🚀 ✅ ❌ — “quoted” ‘single’ \\n \\t \\\\ \\"q\\" \\u001b[31m').split(' ');

const hex = (r: () => number, n: number): string => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
const uuid = (r: () => number): string => `${hex(r, 8)}-${hex(r, 4)}-4${hex(r, 3)}-8${hex(r, 3)}-${hex(r, 12)}`;

class LineGen {
  private readonly r: () => number;
  private readonly master: string;
  private ts = Date.UTC(2026, 9, 1);
  private readonly sessionId: string;
  private parent: string;
  private msgId: string | null = null;
  bytes = 0;
  lines = 0;
  usageLines = 0;

  constructor(seed: number) {
    this.r = mulberry32(seed);
    const parts: string[] = [];
    let n = 0;
    while (n < 6 << 20) {
      const w = WORDS[Math.floor(this.r() * WORDS.length)] ?? '';
      parts.push(w, this.r() < 0.08 ? '\\n ' : ' ');
      n += w.length + 2;
    }
    this.master = parts.join('');
    this.sessionId = uuid(this.r);
    this.parent = uuid(this.r);
  }

  private text(minBytes: number, maxBytes: number): string {
    const r = this.r;
    const len = Math.floor(minBytes + r() * r() * (maxBytes - minBytes));
    let s = Math.floor(r() * (this.master.length - maxBytes - 2));
    s = this.master.indexOf(' ', s) + 1;
    let e = this.master.indexOf(' ', s + len);
    if (e < 0) e = s + len;
    return this.master.slice(s, e);
  }

  private base(type: string): { head: string; uid: string; ts: string } {
    this.ts += 1000 + Math.floor(this.r() * 30000);
    const uid = uuid(this.r);
    const head = `{"parentUuid":"${this.parent}","isSidechain":${this.r() < 0.05},"userType":"external","cwd":"/home/dev/projects/repo-${Math.floor(this.r() * 9)}","sessionId":"${this.sessionId}","version":"2.0.31","gitBranch":"main","type":"${type}"`;
    this.parent = uid;
    return { head, uid, ts: new Date(this.ts).toISOString() };
  }

  next(): string {
    const r = this.r;
    const x = r();
    let line: string;
    if (x < 1 / 6) {
      const dup = this.msgId !== null && r() < 0.25;
      const msgId = dup && this.msgId ? this.msgId : `msg_${hex(r, 24)}`;
      this.msgId = msgId;
      const { head, uid, ts } = this.base('assistant');
      const model = r() < 0.7 ? 'claude-sonnet-4-5-20250929' : r() < 0.5 ? 'claude-opus-4-1-20250805' : 'claude-haiku-4-5-20251001';
      const out = Math.floor(10 + r() * 3000);
      const inp = Math.floor(r() * 50);
      const cr = Math.floor(r() * 150000);
      const cw = r() < 0.3 ? Math.floor(r() * 9000) : 0;
      const content = r() < 0.5
        ? `[{"type":"text","text":"${this.text(200, 6000)}"}]`
        : `[{"type":"tool_use","id":"toolu_${hex(r, 22)}","name":"Bash","input":{"command":"${this.text(40, 400)}","description":"${this.text(20, 120)}"}}]`;
      line = `${head},"message":{"id":"${msgId}","type":"message","role":"assistant","model":"${model}","content":${content},"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":${inp},"cache_creation_input_tokens":${cw},"cache_read_input_tokens":${cr},"output_tokens":${out},"service_tier":"standard"}},"requestId":"req_${hex(r, 22)}","uuid":"${uid}","timestamp":"${ts}"}`;
      this.usageLines++;
    } else if (x < 1 / 6 + 0.58) {
      const { head, uid, ts } = this.base('user');
      const fp = r() < 0.008; // a subagent result carrying a usage object: prefilter false positive
      const body = this.text(2000, 20000);
      const tur = fp
        ? `{"status":"completed","totalDurationMs":${Math.floor(r() * 90000)},"totalTokens":${Math.floor(r() * 90000)},"usage":{"input_tokens":3,"output_tokens":${Math.floor(r() * 900)},"cache_read_input_tokens":0},"content":[{"type":"text","text":"${this.text(100, 800)}"}]}`
        : `{"stdout":"${this.text(100, 1500)}","stderr":"","interrupted":false}`;
      line = `${head},"message":{"role":"user","content":[{"tool_use_id":"toolu_${hex(r, 22)}","type":"tool_result","content":"${body}"}]},"uuid":"${uid}","timestamp":"${ts}","toolUseResult":${tur}}`;
      if (fp) this.usageLines++;
    } else if (x < 1 / 6 + 0.58 + 0.12) {
      const { head, uid, ts } = this.base('user');
      line = `${head},"message":{"role":"user","content":"${this.text(300, 6000)}"},"uuid":"${uid}","timestamp":"${ts}"}`;
    } else {
      line = r() < 0.5
        ? `{"type":"summary","summary":"${this.text(40, 200)}","leafUuid":"${uuid(r)}"}`
        : `{"parentUuid":"${this.parent}","type":"system","subtype":"informational","content":"${this.text(40, 400)}","level":"info","uuid":"${uuid(r)}","timestamp":"${new Date(this.ts).toISOString()}"}`;
    }
    this.lines++;
    this.bytes += Buffer.byteLength(line) + 1;
    return line;
  }
}

async function generate(file: string, mb: number): Promise<LineGen> {
  const gen = new LineGen(3);
  const fh = await fsp.open(file, 'w');
  try {
    let pending: string[] = [];
    let pendingBytes = 0;
    const flush = async (): Promise<void> => {
      await fh.write(`${pending.join('\n')}\n`);
      pending = [];
      pendingBytes = 0;
    };
    while (gen.bytes < mb * 1024 * 1024) {
      const l = gen.next();
      pending.push(l);
      pendingBytes += l.length;
      if (pendingBytes > 4 << 20) await flush();
    }
    if (pending.length > 0) await flush();
  } finally {
    await fh.close();
  }
  return gen;
}

// ── Measurements (run in child processes) ───────────────────────────────────────────────────────

interface Totals {
  parsed: number;
  assistant: number;
  outTokens: number;
}

function consume(text: string, t: Totals): void {
  const o = JSON.parse(text) as { type?: string; message?: { usage?: { output_tokens?: number } } };
  t.parsed++;
  if (o.type === 'assistant' && o.message?.usage) {
    t.assistant++;
    t.outTokens += o.message.usage.output_tokens ?? 0;
  }
}

async function measure(variant: 'tail' | 'readline', file: string): Promise<Record<string, number>> {
  const t: Totals = { parsed: 0, assistant: 0, outTokens: 0 };
  const hist = monitorEventLoopDelay({ resolution: 1 });
  hist.enable();
  const t0 = performance.now();
  let slice = Number.NaN;
  if (variant === 'tail') {
    const r = await runTail(file, undefined, { prefilter: needlePrefilter(NEEDLE) }, (batch) => {
      for (const l of batch) {
        t.parsed++;
        const o = l.value as { type?: string; message?: { usage?: { output_tokens?: number } } };
        if (o.type === 'assistant' && o.message?.usage) {
          t.assistant++;
          t.outTokens += o.message.usage.output_tokens ?? 0;
        }
      }
    });
    if (r.status !== 'ok') throw new Error(`tail: ${r.status}`);
    slice = r.stats.maxSliceMs;
  } else {
    const rl = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of rl) if (line.includes(NEEDLE)) consume(line, t);
  }
  const elapsedMs = performance.now() - t0;
  hist.disable();
  return { elapsedMs, ...t, sliceMs: slice, elMaxMs: hist.max / 1e6, elP99Ms: hist.percentile(99) / 1e6, rssMB: process.resourceUsage().maxRSS / 1024 };
}

async function incremental(file: string): Promise<Record<string, number>> {
  const opts = { prefilter: needlePrefilter(NEEDLE) };
  const noop = (): void => undefined;
  const t0 = performance.now();
  const full = await runTail(file, undefined, opts, noop);
  const fullMs = performance.now() - t0;
  if (full.status !== 'ok') throw new Error('full read failed');
  let state: TailState = full.state;
  const gen = new LineGen(9001);
  const resume: number[] = [];
  const finish: number[] = [];
  const unchanged: number[] = [];
  const slice: number[] = [];
  for (let round = 0; round < 6; round++) {
    const lines = Array.from({ length: 1000 }, () => gen.next());
    const last = lines[999] ?? '';
    const cut = Math.floor(last.length * 0.4);
    await fsp.appendFile(file, `${lines.slice(0, 999).join('\n')}\n${last.slice(0, cut)}`);
    let a0 = performance.now();
    const a = await runTail(file, state, opts, noop);
    resume.push(performance.now() - a0);
    if (a.status !== 'ok' || a.restarted) throw new Error('resume failed');
    slice.push(a.stats.maxSliceMs);
    state = a.state;
    await fsp.appendFile(file, `${last.slice(cut)}\n`);
    a0 = performance.now();
    const b = await runTail(file, state, opts, noop);
    finish.push(performance.now() - a0);
    if (b.status !== 'ok' || b.restarted || b.state.byteOffset !== (await fsp.stat(file)).size) throw new Error('finish failed');
    state = b.state;
    a0 = performance.now();
    const c = await runTail(file, state, opts, noop);
    unchanged.push(performance.now() - a0);
    if (c.status !== 'ok' || !c.unchanged) throw new Error('expected unchanged');
  }
  const med = (xs: number[]): number => [...xs].sort((p, q) => p - q)[Math.floor(xs.length / 2)] ?? 0;
  return { fullMs, resume1000: med(resume.slice(1)), resume1000First: resume[0] ?? 0, finishLine: med(finish), unchangedStat: med(unchanged), sliceMax: Math.max(...slice) };
}

// ── Parent ──────────────────────────────────────────────────────────────────────────────────────

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const fmt = (n: number, d = 1): string => n.toFixed(d);

async function main(): Promise<void> {
  if (process.argv.includes('--child')) {
    const variant = arg('variant', 'tail');
    const file = arg('file', '');
    const res = variant === 'incremental' ? await incremental(file) : await measure(variant as 'tail' | 'readline', file);
    console.log(JSON.stringify(res));
    return;
  }

  const mb = Number(arg('mb', '100'));
  const runs = Number(arg('runs', '3'));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mallard-ndjson-bench-'));
  const file = path.join(dir, 'big.jsonl');
  try {
    const g0 = performance.now();
    const gen = await generate(file, mb);
    const sizeMiB = gen.bytes / 2 ** 20;
    console.log(`generated ${fmt(sizeMiB, 0)} MiB, ${gen.lines} lines, ${gen.usageLines} with "usage" in ${fmt((performance.now() - g0) / 1000)} s`);

    const child = (variant: string): Record<string, number> => {
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--require', 'tsx/cjs', __filename, '--child', '--variant', variant, '--file', file], { encoding: 'utf8', maxBuffer: 1 << 26 });
      if (r.status !== 0) throw new Error(`${variant}: ${r.stderr}`);
      return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Record<string, number>;
    };
    const rows: Record<string, Record<string, number>> = {};
    for (const variant of ['tail', 'readline']) {
      const results: Array<Record<string, number>> = [];
      for (let i = 0; i < runs; i++) {
        const r = child(variant);
        if (r['assistant'] !== undefined && r['parsed'] !== undefined && i > 0 && r['outTokens'] !== results[0]?.['outTokens']) throw new Error(`${variant}: totals differ between runs`);
        results.push(r);
        process.stdout.write('.');
      }
      const pick = (k: string): number => median(results.map((r) => r[k] ?? 0));
      rows[variant] = { elapsedMs: pick('elapsedMs'), sliceMs: pick('sliceMs'), elMaxMs: pick('elMaxMs'), elP99Ms: pick('elP99Ms'), rssMB: pick('rssMB'), parsed: results[0]?.['parsed'] ?? 0, outTokens: results[0]?.['outTokens'] ?? 0 };
      console.log(` ${variant}: ${fmt(rows[variant]['elapsedMs'] ?? 0, 0)} ms`);
    }
    if (rows['tail']?.['outTokens'] !== rows['readline']?.['outTokens']) throw new Error('tail and readline disagree on token totals');
    const inc = child('incremental');

    const t = rows['tail'] ?? {};
    const rl = rows['readline'] ?? {};
    const mbps = (r: Record<string, number>): number => sizeMiB / ((r['elapsedMs'] ?? 1) / 1000);
    console.log('\n| variant | full read ms | MiB/s | JSON.parse calls | longest sync slice ms | event-loop delay max / p99 ms | max RSS MB |');
    console.log('|---|---|---|---|---|---|---|');
    console.log(`| tailNdjson (1 MiB chunks, prefilter) | ${fmt(t['elapsedMs'] ?? 0, 0)} | ${fmt(mbps(t), 0)} | ${t['parsed']} | ${fmt(t['sliceMs'] ?? 0)} | ${fmt(t['elMaxMs'] ?? 0)} / ${fmt(t['elP99Ms'] ?? 0)} | ${fmt(t['rssMB'] ?? 0, 0)} |`);
    console.log(`| readline + includes + parse | ${fmt(rl['elapsedMs'] ?? 0, 0)} | ${fmt(mbps(rl), 0)} | ${rl['parsed']} | n/a | ${fmt(rl['elMaxMs'] ?? 0)} / ${fmt(rl['elP99Ms'] ?? 0)} | ${fmt(rl['rssMB'] ?? 0, 0)} |`);
    console.log(`\nspeedup over readline: ${fmt((rl['elapsedMs'] ?? 0) / (t['elapsedMs'] ?? 1))}x`);
    console.log(`incremental (append 1000 lines, last one cut): resume ${fmt(inc['resume1000'] ?? 0)} ms (first ${fmt(inc['resume1000First'] ?? 0)}), finish the cut line ${fmt(inc['finishLine'] ?? 0)} ms, unchanged file ${fmt(inc['unchangedStat'] ?? 0, 2)} ms, longest slice ${fmt(inc['sliceMax'] ?? 0)} ms`);
    console.log(`spike (524 MB, S2): ${SPIKE.mbPerSec} MiB/s (${SPIKE.fullMs524} ms), readline ${SPIKE.readlineMbPerSec} MiB/s, longest slice ${SPIKE.slice} ms, resume ${SPIKE.resume} ms, RSS ${SPIKE.rss} MB`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

/**
 * Baseline benchmark for the DuckDB-backed event store (Phase 1a).
 *
 *     npx tsx test/bench/benchmark.ts            # = `bun run bench`
 *     npx tsx test/bench/benchmark.ts --sizes 10000,50000 --ingest-mb 10 --out /tmp/x.json
 *
 * Measures, at 10k / 50k / 100k events:
 *   - batch insert time through `EventWriter.insert` (and per-batch p50/p95/max);
 *   - `readSnapshotCache` (cold, then memoised) and `readFilteredSnapshot` (several filters);
 * plus the ingest of one generated ~50 MB Claude Code JSONL file through the
 * real connector + `read_ndjson` path. Event-loop delay (perf_hooks
 * `monitorEventLoopDelay`) is recorded around every measurement, next to an idle
 * baseline, because the point of the baseline is how long the extension host's
 * main thread is blocked. The results are printed as a table and written to
 * test/bench/baseline.duckdb.json together with machine info.
 *
 * This is NOT part of the mocha suite (it lives outside test/unit and has no
 * `.test.ts` suffix); the new store is expected to meet the same numbers
 * (Plan S2: p95 main-thread block < 50 ms per batch, snapshot read < 150 ms).
 * Everything it generates lives in a temp dir that is removed afterwards.
 */
import '../golden/support/env';
import { promises as fs, createWriteStream } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { ClaudeCodeConnector } from '../../src/extension-backend/ingest/ClaudeCodeConnector';
import { NoopFsWatcher } from '../../src/extension-backend/ingest/IFsWatcher';
import type { PricingService } from '../../src/extension-backend/pricing/PricingService';
import type { UsageEvent } from '../../src/extension-backend/domain/types';
import { EventStore } from '../../src/extension-backend/store/EventStore';
import { DAY_MS } from '../../src/extension-backend/util/time';

const HERE = __dirname;
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };

// ── Args ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const SIZES = (arg('sizes') ?? '10000,50000,100000').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const INGEST_MB = Number(arg('ingest-mb') ?? 50);
const BATCH = Number(arg('batch') ?? 5000);
const OUT = arg('out') ?? path.join(HERE, 'baseline.duckdb.json');
const REPEATS = 3;

// ── Measurement ───────────────────────────────────────────────────────────────

interface Delay {
  /** Event-loop delay percentiles in milliseconds (histogram resolution 5 ms; an idle loop reads ~5 ms). */
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}
interface Measured<T> {
  ms: number;
  delay: Delay;
  value: T;
}

const ms = (ns: number): number => Math.round((ns / 1e6) * 100) / 100;

async function measure<T>(fn: () => Promise<T>): Promise<Measured<T>> {
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const t0 = process.hrtime.bigint();
  const value = await fn();
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6;
  // Let the sampler observe the loop once more so a long final block is not lost.
  await new Promise<void>((r) => setImmediate(r));
  h.disable();
  return {
    ms: Math.round(elapsed * 100) / 100,
    value,
    delay: { meanMs: ms(h.mean), p50Ms: ms(h.percentile(50)), p95Ms: ms(h.percentile(95)), p99Ms: ms(h.percentile(99)), maxMs: ms(h.max) },
  };
}

function stats(values: number[]): { min: number; median: number; max: number } {
  const s = [...values].sort((a, b) => a - b);
  return { min: s[0]!, median: s[Math.floor(s.length / 2)]!, max: s[s.length - 1]! };
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

// ── Data generation (deterministic) ────────────────────────────────────────────

const MODELS = [
  'claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101', 'claude-haiku-4-5-20251001', 'gpt-4.1', 'gpt-4o', 'gpt-5-mini',
  'gemini-2.5-pro', 'o3-mini', 'claude-3-5-haiku-20241022', 'claude-sonnet-4-20250514', 'gpt-5.1-codex', 'raptor-mini',
];
const REPOS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const BRANCHES = ['main', 'feature/x', 'fix/y', 'release/1.2'];
const SURFACES = ['chat', 'agent', 'inline', 'edit', 'unknown'] as const;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** `count` events spread over the last 85 days (inside the 90-day raw window, so nothing is rolled up). */
function* generateEvents(count: number, now: number, seed = 1): Generator<UsageEvent> {
  const rnd = lcg(seed);
  for (let i = 0; i < count; i++) {
    const model = MODELS[Math.floor(rnd() * MODELS.length)]!;
    const prompt = 200 + Math.floor(rnd() * 6000);
    const completion = 50 + Math.floor(rnd() * 1500);
    const claude = model.startsWith('claude');
    const cost = prompt * 3e-6 + completion * 15e-6;
    const repo = rnd() < 0.15 ? undefined : REPOS[Math.floor(rnd() * REPOS.length)];
    const branch = rnd() < 0.3 ? undefined : BRANCHES[Math.floor(rnd() * BRANCHES.length)];
    yield {
      id: `bench:${seed}:${i}`,
      ts: now - Math.floor(rnd() * 85 * DAY_MS),
      modelId: model,
      surface: SURFACES[Math.floor(rnd() * SURFACES.length)]!,
      source: claude ? 'claude-code' : 'local',
      promptTokens: prompt,
      completionTokens: completion,
      credits: Math.round(rnd() * 600) / 100,
      cost,
      estimated: true,
      ...(repo ? { repo, attribution: rnd() < 0.2 ? ('heuristic' as const) : ('authoritative' as const) } : {}),
      ...(branch ? { branch } : {}),
      ...(rnd() < 0.5 ? { language: ['typescript', 'python', 'go', 'rust'][Math.floor(rnd() * 4)]! } : {}),
      costByCategory: { input: prompt * 3e-6, output: completion * 15e-6 },
    };
  }
}

// ── Scenarios ──────────────────────────────────────────────────────────────────

interface SizeResult {
  events: number;
  insert: { totalMs: number; eventsPerSec: number; batches: number; batchMs: { p50: number; p95: number; max: number }; delay: Delay };
  readSnapshotCache: { coldMs: number; coldDelay: Delay; memoisedMs: number };
  readFilteredSnapshot: Record<string, { ms: { min: number; median: number; max: number }; delay: Delay }>;
}

async function benchSize(count: number, dir: string): Promise<SizeResult> {
  const now = Date.now();
  const store = await EventStore.open(path.join(dir, `db-${count}`), undefined, SILENT);
  try {
    const batchMs: number[] = [];
    const insert = await measure(async () => {
      let batch: UsageEvent[] = [];
      for (const e of generateEvents(count, now)) {
        batch.push(e);
        if (batch.length === BATCH) {
          const t0 = process.hrtime.bigint();
          await store.writer.insert(batch);
          batchMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
          batch = [];
        }
      }
      if (batch.length > 0) {
        const t0 = process.hrtime.bigint();
        await store.writer.insert(batch);
        batchMs.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
    });

    const cold = await measure(() => store.reader.readSnapshotCache());
    const memo = await measure(() => store.reader.readSnapshotCache());

    const day = now - (now % DAY_MS);
    const filters: Record<string, Parameters<typeof store.reader.readFilteredSnapshot>[0]> = {
      'empty filter': {},
      'range 30d': { range: { start: day - 30 * DAY_MS, end: day + DAY_MS } },
      'model + range 365d': { models: [MODELS[0]!], range: { start: day - 365 * DAY_MS, end: day + DAY_MS } },
      'repo + surface + source': { repos: ['alpha', 'unattributed'], surfaces: ['agent', 'chat'], sources: ['claude-code'], range: { start: day - 365 * DAY_MS, end: day + DAY_MS } },
    };
    const filtered: SizeResult['readFilteredSnapshot'] = {};
    for (const [label, filter] of Object.entries(filters)) {
      const runs: Array<Measured<unknown>> = [];
      for (let i = 0; i < REPEATS; i++) runs.push(await measure(() => store.reader.readFilteredSnapshot(filter)));
      const worst = runs.reduce((a, b) => (b.delay.p95Ms > a.delay.p95Ms ? b : a));
      filtered[label] = { ms: stats(runs.map((r) => r.ms)), delay: worst.delay };
    }

    return {
      events: count,
      insert: {
        totalMs: insert.ms,
        eventsPerSec: Math.round(count / (insert.ms / 1000)),
        batches: batchMs.length,
        batchMs: { p50: Math.round(pct(batchMs, 50) * 100) / 100, p95: Math.round(pct(batchMs, 95) * 100) / 100, max: Math.round(Math.max(...batchMs) * 100) / 100 },
        delay: insert.delay,
      },
      readSnapshotCache: { coldMs: cold.ms, coldDelay: cold.delay, memoisedMs: memo.ms },
      readFilteredSnapshot: filtered,
    };
  } finally {
    store.dispose();
  }
}

interface IngestResult {
  fileMB: number;
  lines: number;
  generateMs: number;
  ingestMs: number;
  mbPerSec: number;
  eventsInserted: number;
  delay: Delay;
  rssPeakMB: number;
}

async function writeJsonl(file: string, targetBytes: number): Promise<{ lines: number; bytes: number }> {
  const out = createWriteStream(file);
  const rnd = lcg(7);
  // Inside the 90-day raw window: older rows would be rolled up the moment the row count passes MAX_RAW_EVENTS.
  const base = Date.now() - 30 * DAY_MS;
  let bytes = 0;
  let lines = 0;
  for (; bytes < targetBytes; lines++) {
    const model = MODELS[Math.floor(rnd() * 6)]!;
    const ts = new Date(base + lines * 1500).toISOString();
    const line = `${JSON.stringify({
      parentUuid: null, isSidechain: rnd() < 0.1, userType: 'external', cwd: '/work/alpha', sessionId: `bench-session-${Math.floor(lines / 500).toString().padStart(8, '0')}`,
      version: '2.0.31', gitBranch: BRANCHES[Math.floor(rnd() * BRANCHES.length)], type: 'assistant',
      message: {
        id: `msg_bench_${lines}`, type: 'message', role: 'assistant', model,
        content: [{ type: 'text', text: 'x'.repeat(200 + Math.floor(rnd() * 400)) }, ...(rnd() < 0.3 ? [{ type: 'tool_use', id: `toolu_${lines}`, name: 'Bash', input: { command: 'ls -la' } }] : [])],
        stop_reason: null,
        usage: { input_tokens: 100 + Math.floor(rnd() * 5000), cache_creation_input_tokens: Math.floor(rnd() * 800), cache_read_input_tokens: Math.floor(rnd() * 20000), output_tokens: 20 + Math.floor(rnd() * 1500), service_tier: 'standard' },
      },
      requestId: `req_bench_${lines}`, uuid: `00000000-0000-4000-8000-${String(lines).padStart(12, '0')}`, timestamp: ts,
    })}\n`;
    bytes += Buffer.byteLength(line);
    if (!out.write(line)) await new Promise<void>((r) => out.once('drain', r));
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  return { lines, bytes };
}

class BenchClaude extends ClaudeCodeConnector {
  constructor(store: EventStore, private readonly dir: string) {
    super({ pricePerCredit: 0.04, currentManifest: undefined, tokenPrices: undefined } as unknown as PricingService, store.meta, store.fileReader, { resolve: () => undefined }, new NoopFsWatcher(), SILENT);
  }
  protected override async discover(): Promise<{ globs: string[]; allowedRoots: string[]; searchedDirs: string[] }> {
    return { globs: [path.join(this.dir, '**', '*.jsonl').replace(/\\/g, '/')], allowedRoots: [this.dir], searchedDirs: [this.dir] };
  }
}

async function benchIngest(dir: string): Promise<IngestResult> {
  const logs = path.join(dir, 'logs');
  await fs.mkdir(logs, { recursive: true });
  const file = path.join(logs, 'bench.jsonl');
  const g0 = Date.now();
  const { lines, bytes } = await writeJsonl(file, INGEST_MB * 1024 * 1024);
  const generateMs = Date.now() - g0;

  const store = await EventStore.open(path.join(dir, 'db-ingest'), undefined, SILENT);
  let rssPeak = 0;
  const sampler = setInterval(() => (rssPeak = Math.max(rssPeak, process.memoryUsage().rss)), 100);
  try {
    const connector = new BenchClaude(store, logs);
    const run = await measure(() => connector.start());
    const inserted = await store.reader.count();
    return {
      fileMB: Math.round((bytes / 1024 / 1024) * 10) / 10,
      lines,
      generateMs,
      ingestMs: run.ms,
      mbPerSec: Math.round((bytes / 1024 / 1024 / (run.ms / 1000)) * 10) / 10,
      eventsInserted: inserted,
      delay: run.delay,
      rssPeakMB: Math.round(rssPeak / 1024 / 1024),
    };
  } finally {
    clearInterval(sampler);
    store.dispose();
    await fs.rm(file, { force: true });
  }
}

// ── Reporting ──────────────────────────────────────────────────────────────────

function machine(): Record<string, unknown> {
  const cpus = os.cpus();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const duckdbVersion = (require('@duckdb/node-api/package.json') as { version: string }).version;
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    cpu: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
    duckdbNodeApi: duckdbVersion,
  };
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => r.map((cell, c) => (c === 0 ? cell.padEnd(widths[c]!) : cell.padStart(widths[c]!))).join('  ')).join('\n');
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-bench-'));
  try {
    const idle = await measure(() => new Promise<void>((r) => setTimeout(r, 1000)));
    const sizes: SizeResult[] = [];
    for (const n of SIZES) {
      console.log(`benchmarking ${n} events ...`);
      sizes.push(await benchSize(n, dir));
    }
    console.log(`ingesting a ~${INGEST_MB} MB JSONL file ...`);
    const ingest = INGEST_MB > 0 ? await benchIngest(dir) : undefined;

    const result = {
      about: 'Baseline of the DuckDB event store, recorded before the node:sqlite replacement. Lower is better; event-loop delay is the main-thread block seen while the operation ran.',
      machine: machine(),
      settings: { batchSize: BATCH, sizes: SIZES, ingestTargetMB: INGEST_MB, repeats: REPEATS },
      idleEventLoop: idle.delay,
      sizes,
      ingest,
    };
    await fs.writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);

    console.log('\nIdle event-loop delay (ms): ' + JSON.stringify(idle.delay));
    console.log('\n' + table([
      ['events', 'insert ms', 'ev/s', 'batch p95', 'batch max', 'loop p95', 'loop max', 'snap cold', 'snap memo'],
      ...sizes.map((s) => [
        String(s.events), String(s.insert.totalMs), String(s.insert.eventsPerSec), String(s.insert.batchMs.p95), String(s.insert.batchMs.max),
        String(s.insert.delay.p95Ms), String(s.insert.delay.maxMs), String(s.readSnapshotCache.coldMs), String(s.readSnapshotCache.memoisedMs),
      ]),
    ]));
    for (const s of sizes) {
      console.log(`\nreadFilteredSnapshot @ ${s.events} events (median ms | loop p95 ms | loop max ms)`);
      console.log(table([['filter', 'median', 'loop p95', 'loop max'], ...Object.entries(s.readFilteredSnapshot).map(([k, v]) => [k, String(v.ms.median), String(v.delay.p95Ms), String(v.delay.maxMs)])]));
    }
    if (ingest) {
      console.log(`\ningest ${ingest.fileMB} MB / ${ingest.lines} lines: ${ingest.ingestMs} ms (${ingest.mbPerSec} MB/s), ${ingest.eventsInserted} events, loop p95 ${ingest.delay.p95Ms} ms, max ${ingest.delay.maxMs} ms, peak RSS ${ingest.rssPeakMB} MB`);
    }
    console.log(`\nwrote ${OUT}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

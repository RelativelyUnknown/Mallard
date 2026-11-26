/**
 * Benchmark of the `node:sqlite` event store against the Phase 0 / spike S2 budgets.
 *
 *     npx tsx test/bench/benchmark-sqlite.ts            # = `bun run bench:sqlite`
 *     npx tsx test/bench/benchmark-sqlite.ts --rows 100000 --repeats 7 --out /tmp/x.json --strict
 *
 * Measures, on the real `SqliteEventStore` (a file in a temp dir, WAL):
 *   - `insert()` of 100k rows in one call: the store slices it into 2,000-row / 15 ms
 *     transactions with a `setImmediate` yield between them. The block per batch is read
 *     with a microsecond `setImmediate` probe (the gap between two turns of the event loop
 *     is the synchronous work in between) next to `monitorEventLoopDelay`;
 *   - re-ingest of the same rows (every row already stored: the guarded no-op path);
 *   - `aggregateRange` over ~54k rows (50k raw + 4k rolled-up rows, 365 days) and over 30
 *     days, then `buildSnapshotSource` on the groups (what a dashboard refresh costs);
 *   - a compaction that rolls ~30k old rows.
 * Budgets (spike S2): p95 main-thread block per write batch under 50 ms at 2,000 rows,
 * snapshot read under 150 ms. The result and the verdict go to
 * test/bench/baseline.sqlite.json with machine info. NOT part of the mocha suite.
 */
import '../golden/support/env';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import type { RawEvent } from '../../src/extension-backend/domain/contracts';
import { buildSnapshotSource } from '../../src/extension-backend/domain/snapshotSource';
import { SqliteEventStore } from '../../src/extension-backend/store/sqlite/SqliteEventStore';
import { DAY_MS } from '../../src/extension-backend/util/time';
import { FROZEN } from '../golden/frozen';

const HERE = __dirname;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ROWS = Number(arg('rows') ?? 100_000);
const REPEATS = Number(arg('repeats') ?? 7);
const OUT = arg('out') ?? path.join(HERE, 'baseline.sqlite.json');
const STRICT = process.argv.includes('--strict');

/** The spike S2 budgets (plan, Phase 0). */
const BUDGET = { writeBlockP95Ms: 50, snapshotReadMs: 150 };
/** What spike S2 measured on the same VM (Linux, 4 vCPU Xeon 2.1 GHz, Node 22.23), for comparison. */
const S2 = { write2kP95Ms: 32.3, sql15ReadMs: 92, sql15SlicedReadMs: 89, rawRowObjectsReadMs: 262 };

// ── Data (deterministic; sessions of requests in one repo/branch/model, like real use) ──

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const MODELS = ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'gpt-4.1', 'gpt-5', 'gpt-5-mini', 'o4-mini', 'gemini-2.5-pro', 'claude-3-5-haiku', 'grok-code-fast-1'];
const LANGS = ['typescript', 'python', 'rust', 'go', 'markdown', 'json'];
const REPOS = Array.from({ length: 40 }, (_, i) => `repo-${String(i).padStart(2, '0')}`);

function clustered(count: number, endTs: number, days: number, seed: number, prefix: string): RawEvent[] {
  const rnd = lcg(seed);
  const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() ** 2.2 * a.length)]!;
  const out: RawEvent[] = [];
  const start = endTs - days * DAY_MS;
  while (out.length < count) {
    const sessionStart = start + Math.floor(rnd() * days) * DAY_MS + Math.floor(rnd() * 20 * 3_600_000);
    const n = Math.min(count - out.length, 20 + Math.floor(rnd() * 380));
    const repo = rnd() < 0.12 ? null : pick(REPOS);
    const branch = repo && rnd() < 0.8 ? (rnd() < 0.5 ? 'main' : `feat/${Math.floor(rnd() * 5)}`) : null;
    const model = pick(MODELS);
    const source = rnd() < 0.7 ? 'claude-code' : 'local';
    const surface = rnd() < 0.65 ? 'agent' : 'chat';
    const language = rnd() < 0.25 ? null : pick(LANGS);
    const session = Math.floor(rnd() * 1e9).toString(36);
    let ts = sessionStart;
    for (let i = 0; i < n; i++) {
      ts += Math.floor(-Math.log(1 - rnd()) * 20_000);
      out.push({
        id: `${prefix}:${session}:${ts}:${out.length}`, ts, modelId: model, surface, source, repo, branch,
        attribution: repo ? (rnd() < 0.75 ? 'authoritative' : 'heuristic') : null, language, requests: 1,
        promptTokens: 100 + Math.floor(rnd() * 6000), completionTokens: 50 + Math.floor(rnd() * 1500),
        cacheReadTokens: source === 'claude-code' ? Math.floor(rnd() * 30_000) : 0,
        cacheCreationTokens: source === 'claude-code' && rnd() < 0.3 ? Math.floor(rnd() * 3000) : 0,
        thinkingTokens: rnd() < 0.2 ? Math.floor(rnd() * 800) : 0,
      });
    }
  }
  return out;
}

/** Rolled-up-like rows: one per day x model x surface x source x repo, older than the raw range. */
function rolled(count: number, endTs: number, seed: number): RawEvent[] {
  const rnd = lcg(seed);
  const seen = new Set<string>();
  const out: RawEvent[] = [];
  const endDay = Math.floor(endTs / DAY_MS) * DAY_MS;
  while (out.length < count) {
    const day = endDay - (91 + Math.floor(rnd() * 270)) * DAY_MS;
    const modelId = MODELS[Math.floor(rnd() ** 2 * MODELS.length)]!;
    const surface = rnd() < 0.65 ? 'agent' : 'chat';
    const source = rnd() < 0.7 ? 'claude-code' : 'local';
    const repo = REPOS[Math.floor(rnd() ** 2 * REPOS.length)]!;
    const id = `roll:${day}:${modelId}:${repo}:${surface}:${source}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const requests = 5 + Math.floor(rnd() * 60);
    out.push({
      id, ts: day, modelId, surface, source, repo, branch: null, attribution: 'authoritative', language: null, requests,
      promptTokens: requests * 300, completionTokens: requests * 450, cacheReadTokens: source === 'claude-code' ? requests * 20_000 : 0,
      cacheCreationTokens: requests * 500, thinkingTokens: requests * 40,
    });
  }
  return out;
}

// ── Measurement ────────────────────────────────────────────────────────────────

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

function pct(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

interface Dist {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}
function dist(values: number[]): Dist {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, p50: round(pct(s, 50)), p95: round(pct(s, 95)), p99: round(pct(s, 99)), max: round(s[s.length - 1] ?? 0) };
}

interface Probed<T> {
  value: T;
  ms: number;
  /** Synchronous stretches (>= 1 ms) between two turns of the event loop while `fn` ran: the main-thread blocks. */
  blocks: Dist;
  /** monitorEventLoopDelay (1 ms resolution, subtracted). */
  el: { p50: number; p95: number; p99: number; max: number };
}

/** Run `fn` while a `setImmediate` loop measures how long the event loop is held between turns. */
async function probed<T>(fn: () => Promise<T>): Promise<Probed<T>> {
  const gaps: number[] = [];
  let running = true;
  let last = process.hrtime.bigint();
  const tick = (): void => {
    const now = process.hrtime.bigint();
    gaps.push(Number(now - last) / 1e6);
    last = now;
    if (running) setImmediate(tick);
  };
  const h = monitorEventLoopDelay({ resolution: 1 });
  h.enable();
  setImmediate(tick);
  const t0 = process.hrtime.bigint();
  const value = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  running = false;
  await new Promise<void>((r) => setImmediate(r));
  h.disable();
  const f = (ns: number): number => round(Math.max(0, ns / 1e6 - 1));
  return { value, ms: round(ms), blocks: dist(gaps.filter((g) => g >= 1)), el: { p50: f(h.percentile(50)), p95: f(h.percentile(95)), p99: f(h.percentile(99)), max: f(h.max) } };
}

async function repeat<T>(n: number, fn: () => Promise<T>): Promise<{ ms: Dist; blocks: Dist; last: T }> {
  const ms: number[] = [];
  const blocks: number[] = [];
  let last!: T;
  for (let i = 0; i < n; i++) {
    const r = await probed(fn);
    ms.push(r.ms);
    blocks.push(r.blocks.max);
    last = r.value;
  }
  return { ms: dist(ms), blocks: dist(blocks), last };
}

function machine(): Record<string, unknown> {
  const cpus = os.cpus();
  return {
    platform: os.platform(), release: os.release(), arch: os.arch(), cpu: cpus[0]?.model ?? 'unknown', cpuCount: cpus.length,
    totalMemGB: round(os.totalmem() / 1024 ** 3, 1), node: process.version, sqlite: process.versions['sqlite'] ?? 'unknown',
    tz: process.env['TZ'] ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function open(dir: string, name: string): Promise<SqliteEventStore> {
  // No automatic roll-up while measuring inserts (it would add its own cost to the figures).
  return SqliteEventStore.open(path.join(dir, name), { maxRawEvents: Number.MAX_SAFE_INTEGER, retentionDays: 3650 });
}

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-bench-sqlite-'));
  const now = Date.now();
  try {
    console.log(`generating ${ROWS} events ...`);
    const events = clustered(ROWS, now, 85, 11, 'bench');

    // 1. Writes: one insert() of ROWS rows into an empty store, then the same rows again.
    console.log('insert ...');
    const w = await open(dir, 'write');
    const insert = await probed(() => w.insert(events));
    const inserted = insert.value.inserted;
    const reingest = await probed(() => w.insert(events));
    await w.checkpoint();
    await w.close();

    // 2. Reads: ~50k raw rows (85 days) + rolled-up rows (91 to 360 days back).
    console.log('reads ...');
    const rawCount = Math.min(50_000, ROWS);
    const store = await open(dir, 'read');
    await store.insert(clustered(rawCount, now, 85, 12, 'read'));
    await store.insert(rolled(4_000, now, 13));
    const total = await store.countEvents();
    const full = { fromMs: now - 365 * DAY_MS, toMs: now + DAY_MS };
    const last30 = { fromMs: now - 30 * DAY_MS, toMs: now + DAY_MS };
    await store.aggregateRange({}, full); // warm the page cache and the JIT
    const read365 = await repeat(REPEATS, () => store.aggregateRange({}, full));
    const read30 = await repeat(REPEATS, () => store.aggregateRange({}, last30));
    const filtered = await repeat(REPEATS, () => store.aggregateRange({ models: [MODELS[0]!, MODELS[3]!], sources: ['claude-code'] }, full));
    const snapshot = await repeat(REPEATS, async () => {
      const groups = await store.aggregateRange({}, full);
      return buildSnapshotSource({ groups }, now, FROZEN);
    });
    const groups365 = read365.last.length;
    const version = await repeat(1, async () => {
      let v = 0;
      for (let i = 0; i < 1000; i++) v += store.dataVersion();
      return v;
    });
    await store.close();

    // 3. Compaction: roll ~30k rows older than the retention window.
    console.log('compaction ...');
    const c = await SqliteEventStore.open(path.join(dir, 'compact'), { retentionDays: 90, maxRawEvents: Number.MAX_SAFE_INTEGER });
    const oldRows = clustered(30_000, now - 120 * DAY_MS, 100, 14, 'old');
    await c.insert(oldRows);
    const compaction = await probed(() => c.compact(now));
    const afterCompaction = await c.countEvents();
    await c.close();

    const verdict = {
      writeBlockP95: { budgetMs: BUDGET.writeBlockP95Ms, measuredMs: insert.blocks.p95, pass: insert.blocks.p95 < BUDGET.writeBlockP95Ms },
      snapshotRead: { budgetMs: BUDGET.snapshotReadMs, measuredMs: snapshot.ms.p50, p95Ms: snapshot.ms.p95, pass: snapshot.ms.p95 < BUDGET.snapshotReadMs },
    };
    const result = {
      about: 'Baseline of the node:sqlite event store (SqliteEventStore). Lower is better. "blocks" are the synchronous stretches (>= 1 ms) between two turns of the event loop while the operation ran; spike S2 numbers are for comparison (same VM class, raw SQLite).',
      machine: machine(),
      settings: { rows: ROWS, repeats: REPEATS, insertBatch: '2000 rows or 15 ms', readWindow: '7 days', bucket: '15 minutes' },
      budgets: BUDGET,
      spikeS2: S2,
      verdict,
      insert: { rows: ROWS, inserted, ms: insert.ms, rowsPerSec: Math.round(ROWS / (insert.ms / 1000)), blocks: insert.blocks, eventLoopDelay: insert.el },
      reingestIdentical: { rows: ROWS, ms: reingest.ms, rowsPerSec: Math.round(ROWS / (reingest.ms / 1000)), blocks: reingest.blocks, eventLoopDelay: reingest.el },
      reads: {
        storedRows: total,
        groups365d: groups365,
        aggregateRange365d: { ms: read365.ms, longestBlock: read365.blocks },
        aggregateRange30d: { ms: read30.ms, longestBlock: read30.blocks },
        aggregateRange365dFiltered: { ms: filtered.ms, longestBlock: filtered.blocks },
        snapshot365d: { note: 'aggregateRange + buildSnapshotSource', ms: snapshot.ms, longestBlock: snapshot.blocks },
        dataVersionPollMsPer1000: version.ms.p50,
      },
      compaction: { rolledRows: oldRows.length, rowsAfter: afterCompaction, ms: compaction.ms, blocks: compaction.blocks, eventLoopDelay: compaction.el },
    };
    await fs.writeFile(OUT, `${JSON.stringify(result, null, 2)}\n`);

    const line = (label: string, v: string): string => `  ${label.padEnd(34)} ${v}`;
    console.log('\nnode:sqlite event store');
    console.log(line('insert, 1 call', `${insert.ms} ms, ${Math.round(ROWS / (insert.ms / 1000))} rows/s`));
    console.log(line('  write block p50/p95/p99/max', `${insert.blocks.p50} / ${insert.blocks.p95} / ${insert.blocks.p99} / ${insert.blocks.max} ms (n=${insert.blocks.n}); S2 p95 ${S2.write2kP95Ms}`));
    console.log(line('  event-loop delay p95/max', `${insert.el.p95} / ${insert.el.max} ms`));
    console.log(line('re-ingest identical rows', `${reingest.ms} ms, block p95 ${reingest.blocks.p95} ms`));
    console.log(line(`aggregateRange 365d (${groups365} groups)`, `p50 ${read365.ms.p50} / p95 ${read365.ms.p95} ms, longest block ${read365.blocks.max} ms; S2 ${S2.sql15SlicedReadMs}`));
    console.log(line('aggregateRange 30d', `p50 ${read30.ms.p50} / p95 ${read30.ms.p95} ms`));
    console.log(line('snapshot (read + buildSnapshotSource)', `p50 ${snapshot.ms.p50} / p95 ${snapshot.ms.p95} ms`));
    console.log(line('compaction (30k rows)', `${compaction.ms} ms, block p95 ${compaction.blocks.p95} / max ${compaction.blocks.max} ms, ${afterCompaction} rows left`));
    console.log(`\nbudget: write block p95 < ${BUDGET.writeBlockP95Ms} ms: ${verdict.writeBlockP95.pass ? 'PASS' : 'FAIL'};  snapshot read p95 < ${BUDGET.snapshotReadMs} ms: ${verdict.snapshotRead.pass ? 'PASS' : 'FAIL'}`);
    console.log(`written ${path.relative(process.cwd(), OUT)}`);
    if (STRICT && !(verdict.writeBlockP95.pass && verdict.snapshotRead.pass)) process.exitCode = 1;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

void main();

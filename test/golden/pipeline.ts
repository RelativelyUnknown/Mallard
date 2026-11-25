/**
 * Characterisation harness ("goldens") for Mallard's data pipeline.
 *
 * Every function here drives TODAY's implementation (DuckDB `EventStore`,
 * connectors over `read_ndjson`/sqlite scanner, `UsageService`,
 * `RestrictionEngine`, `buildStreamBatch`, `domain/layout`) and returns plain,
 * store-agnostic data. The signatures deliberately do NOT mention DuckDB: the
 * node:sqlite stack (and the flat-alert / gridstack streams) re-implement the
 * same functions against their own code and are checked against the committed
 * recordings in test/golden/expected/ (see record.ts), except for the written
 * list of intended differences (INTENDED_DIFFERENCES.md).
 *
 *   ingestFixtures({tz, now})    -> mapped events (+ what the store persisted)
 *   snapshot(filter, {tz, now})  -> SnapshotSourceData for a dashboard filter
 *   exportCsv() / exportJson()   -> the "Export usage data" files
 *   streamBatch()                -> the exact wire JSON sent to the server
 *   alertSequence({tz})          -> built-in alerts, alert rules and restriction states over time
 *   layoutVectors()              -> layout migration inputs -> outputs
 *
 * Determinism: the zone is pinned with `withTz` (same technique as
 * test/unit/store/ndjsonIngest.test.ts), `Date.now()` is frozen around every
 * call that reads the clock, and file-path hashes inside ids are replaced by
 * stable labels (ids embed `fileKeyOf(absolute path)`, which differs per run).
 */
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscodeApi from 'vscode';
import { DuckDBInstance } from '@duckdb/node-api';
import { ClaudeCodeConnector } from '../../src/extension-backend/ingest/ClaudeCodeConnector';
import { CopilotConnector } from '../../src/extension-backend/ingest/CopilotConnector';
import { NoopFsWatcher } from '../../src/extension-backend/ingest/IFsWatcher';
import { fileKeyOf } from '../../src/extension-backend/ingest/connectorUtils';
import type { ParseContext } from '../../src/extension-backend/ingest/otelParse';
import { WorkspaceFolderMatcher } from '../../src/extension-backend/ingest/WorkspaceFolderMatcher';
import type { CopilotOtelSource } from '../../src/extension-backend/config';
import { EventStore } from '../../src/extension-backend/store/EventStore';
import { EventReader } from '../../src/extension-backend/store/EventReader';
import type { IEventSnapshotReader, SnapshotSourceData } from '../../src/extension-backend/store/EventReader';
import type { RecordFilter } from '../../src/extension-backend/store/EventRepository';
import { UsageService } from '../../src/extension-backend/app/UsageService';
import type { IConfigService } from '../../src/extension-backend/app/ConfigService';
import { RestrictionEngine } from '../../src/extension-backend/app/RestrictionEngine';
import type { IngestService } from '../../src/extension-backend/ingest/IngestService';
import type { CurrencyService } from '../../src/extension-backend/pricing/CurrencyService';
import type { PricingService } from '../../src/extension-backend/pricing/PricingService';
import { buildStreamBatch, chunkEvents } from '../../src/extension-backend/export/payload';
import type { StreamBatch } from '../../src/extension-backend/export/payload';
import { initRepoAttribution } from '../../src/extension-backend/util/repo';
import type { Logger } from '../../src/extension-backend/util/logger';
import {
  CLAUDE_FALLBACK_TOKEN_PRICES,
  normalizeModelId,
  priceRequest,
  priceTokens,
  resolveMultiplier,
  DEFAULT_MULTIPLIERS,
} from '../../src/extension-backend/domain/pricing';
import type { PricingManifest, TokenPrices } from '../../src/extension-backend/domain/pricing';
import {
  configPanelsToLayout,
  defaultLayout,
  gridColumnToSpan,
  migrateV1,
  PANEL_IDS,
} from '../../src/extension-backend/domain/layout';
import { LAYOUT_CONFIG_CASES, LAYOUT_V1_CASES } from './layoutCases';
import { startOf } from '../../src/extension-backend/util/time';
import type {
  AlertRule,
  Filter,
  SnapshotData,
  UsageEvent,
  UserConfig,
} from '../../src/extension-backend/domain/types';
import {
  COMPACTION_RETENTION_DAYS,
  EDITOR_STATE,
  INGEST_NOW_1,
  INGEST_NOW_2,
  NOW_SPECS,
} from './scenarios';
import type { FilterSpec, NowSpec } from './scenarios';
import { iso, localInstant, withClock, withFrozenDateSync, withTz, withTzSync } from './support/time';
import type { GoldenTz } from './support/time';

export const FIXTURES = path.join(__dirname, 'fixtures');

type Json = Record<string, unknown>;

// ── Public data shapes ────────────────────────────────────────────────────────

/**
 * A usage event as the connectors map it (before any storage). Optional
 * numeric fields are `null` rather than absent so a comparison against a
 * different implementation cannot confuse "missing" with "undefined".
 */
export interface NormalizedEvent {
  id: string;
  ts: number;
  model: string;
  surface: string;
  source: string;
  repo: string | null;
  branch: string | null;
  attribution: string | null;
  language: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheCreationTokens: number | null;
  cacheReadTokens: number | null;
  thinkingTokens: number | null;
  credits: number;
  cost: number;
  estimated: boolean;
  costByCategory: Record<string, number> | null;
}

export interface IngestPassReport {
  pass: 'backfill' | 'live';
  /** The frozen clock the pass ran at. */
  at: string;
  /** Rows the store accepted per connector label (re-reads of known ids add nothing). */
  inserted: Record<string, number>;
  status: Record<string, string>;
}

export interface IngestResult {
  /** Every event the store accepted, in (ts, id) order, as the connectors mapped them. */
  events: NormalizedEvent[];
  /** What the store actually persisted: cache/thinking tokens are not stored, so they read back null. */
  stored: NormalizedEvent[];
  passes: IngestPassReport[];
}

export interface CsvExport {
  header: string;
  /** Data lines, ordered by ts descending then id (ties are unordered in DuckDB's output). */
  rows: string[];
}

export interface SnapshotRecord {
  label: string;
  nowLabel: string;
  now: string;
  /** The filter as resolved to concrete instants (range in epoch ms). */
  filter: Filter;
  /** How UsageService read it: the memoised no-filter path, or the filtered path with this RecordFilter. */
  read: { path: 'cache' | 'filtered'; recordFilter: RecordFilter | null };
  data: SnapshotSourceData;
}

export interface AlertStep {
  local: string;
  at: string;
  action: string | null;
  /** Toasts shown, in order (built-in alerts first, then rule alerts). */
  warnings: string[];
  restriction: {
    active: boolean;
    ruleId: string;
    reasonMessage: string;
    firedAt: string | null;
    userOverrideUntil: string | null;
    isRestricted: boolean;
  };
}

// ── Shared fixtures ───────────────────────────────────────────────────────────

const SILENT: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export interface FrozenPricing {
  pricePerCredit: number;
  currentManifest: PricingManifest;
  tokenPrices: TokenPrices;
}

export async function loadPricing(): Promise<FrozenPricing> {
  const manifest = JSON.parse(await fs.readFile(path.join(FIXTURES, 'pricing', 'manifest.json'), 'utf8')) as PricingManifest;
  const tokenPrices = JSON.parse(await fs.readFile(path.join(FIXTURES, 'pricing', 'token-prices.json'), 'utf8')) as TokenPrices;
  return { pricePerCredit: manifest.pricePerCredit, currentManifest: manifest, tokenPrices };
}

const pricingService = (p: FrozenPricing): PricingService => p as unknown as PricingService;

/** Workspace folders the Claude connector resolves a session's `cwd` against. */
const FOLDER_MATCHER = new WorkspaceFolderMatcher(() => [
  { name: 'alpha', uri: { fsPath: '/work/alpha' }, index: 0 },
  { name: 'beta', uri: { fsPath: '/work/beta' }, index: 1 },
] as never);

// ── Connectors pointed at the temp copy of the fixtures ─────────────────────────

function withEditorState(ctx: ParseContext): ParseContext {
  return { ...ctx, repo: EDITOR_STATE.repo, branch: EDITOR_STATE.branch, language: EDITOR_STATE.language };
}

class GoldenClaude extends ClaudeCodeConnector {
  constructor(store: EventStore, pricing: FrozenPricing, private readonly dir: string) {
    super(pricingService(pricing), store.meta, store.fileReader, FOLDER_MATCHER, new NoopFsWatcher(), SILENT);
  }
  protected override async discover(): Promise<{ globs: string[]; allowedRoots: string[]; searchedDirs: string[] }> {
    return { globs: [path.join(this.dir, '**', '*.jsonl').replace(/\\/g, '/')], allowedRoots: [this.dir], searchedDirs: [this.dir] };
  }
  protected override async buildContext(globs: string[], watermarkMs: number | null = null): Promise<ParseContext> {
    return withEditorState(await super.buildContext(globs, watermarkMs));
  }
}

class GoldenCopilot extends CopilotConnector {
  constructor(store: EventStore, pricing: FrozenPricing, source: CopilotOtelSource, private readonly key: string) {
    super(pricingService(pricing), store.meta, store.fileReader, () => source, [], new NoopFsWatcher(), SILENT);
  }
  /** One watermark per source: the production connector is the only one in a store. */
  protected override get watermarkKey(): string {
    return `copilot:${this.key}:watermark`;
  }
  protected override async buildContext(globs: string[], watermarkMs: number | null = null): Promise<ParseContext> {
    return withEditorState(await super.buildContext(globs, watermarkMs));
  }
}

// ── World: one store, ingested in two passes ───────────────────────────────────

export interface World {
  readonly tz: string;
  readonly store: EventStore;
  readonly root: string;
  readonly pricing: FrozenPricing;
  readonly passes: IngestPassReport[];
  /** False when DuckDB's sqlite extension cannot be installed (offline): span-DB events are then absent. */
  readonly sqliteAvailable: boolean;
  /** Every event the store accepted, as the connectors mapped them (full UsageEvent objects). */
  readonly freshRaw: readonly UsageEvent[];
  /** The same events grouped by `onInserted` call (one per connector pass): what the exporter is handed. */
  readonly insertCalls: ReadonlyArray<readonly UsageEvent[]>;
  events(): NormalizedEvent[];
  stored(): Promise<NormalizedEvent[]>;
  labelId(id: string): string;
  close(): Promise<void>;
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(src, dest);
    else await fs.copyFile(src, dest);
  }
}

async function appendTree(from: string, to: string): Promise<void> {
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) await appendTree(src, dest);
    else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.appendFile(dest, await fs.readFile(src));
    }
  }
}

function normalize(e: UsageEvent, label: (id: string) => string): NormalizedEvent {
  const cats = e.costByCategory;
  return {
    id: label(e.id),
    ts: e.ts,
    model: e.modelId,
    surface: e.surface,
    source: e.source,
    repo: e.repo ?? null,
    branch: e.branch ?? null,
    attribution: e.attribution ?? null,
    language: e.language ?? null,
    promptTokens: e.promptTokens ?? null,
    completionTokens: e.completionTokens ?? null,
    cacheCreationTokens: e.cacheCreationTokens ?? null,
    cacheReadTokens: e.cacheReadTokens ?? null,
    thinkingTokens: e.thinkingTokens ?? null,
    credits: e.credits,
    cost: e.cost,
    estimated: e.estimated,
    costByCategory: cats && Object.keys(cats).length > 0 ? { ...(cats as Record<string, number>) } : null,
  };
}

const byTsThenId = (a: NormalizedEvent, b: NormalizedEvent): number => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Open a store in zone `tz` and ingest the fixtures in two passes: a backfill
 * (no watermark yet, so nothing is "live") and a later live pass over the
 * appended bytes, which exercises the watermark, partial lines and the
 * active-editor heuristics. `now` overrides the live pass's clock.
 */
export async function openWorld(opts: { tz: string; now?: number; retentionDays?: number }): Promise<World> {
  const { tz } = opts;
  const liveNow = opts.now ?? INGEST_NOW_2;
  const firstNow = Math.min(INGEST_NOW_1, liveNow - 30 * 60_000);
  return withTz(tz, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-golden-'));
    const claudeDir = path.join(root, 'claude');
    const copilotDir = path.join(root, 'copilot');
    await copyTree(path.join(FIXTURES, 'claude'), claudeDir);
    await copyTree(path.join(FIXTURES, 'copilot'), copilotDir);
    const pricing = await loadPricing();

    const store = await EventStore.open(path.join(root, 'db'), opts.retentionDays, SILENT);

    const raw: UsageEvent[] = [];
    const insertCalls: UsageEvent[][] = [];
    store.writer.onInserted = (events) => {
      const copy = events.map((e) => ({ ...e }));
      insertCalls.push(copy);
      raw.push(...copy);
    };

    const otel = (name: string, kind: CopilotOtelSource['kind']): CopilotOtelSource => ({ kind, path: path.join(copilotDir, name) });
    const connectors: Array<[string, { start(): Promise<void>; getStatus(): string; dispose(): void }]> = [
      ['claude', new GoldenClaude(store, pricing, claudeDir)],
      ['copilot-otel', new GoldenCopilot(store, pricing, otel('otel.jsonl', 'ndjson'), 'otel')],
      ['copilot-map', new GoldenCopilot(store, pricing, otel('otel-map.jsonl', 'ndjson'), 'map')],
      ['copilot-mixed', new GoldenCopilot(store, pricing, otel('otel-mixed.jsonl', 'ndjson'), 'mixed')],
      ['copilot-sqlite', new GoldenCopilot(store, pricing, otel('spans.db', 'sqlite'), 'sqlite')],
    ];

    const passes: IngestPassReport[] = [];
    const runPass = async (pass: IngestPassReport['pass'], at: number): Promise<void> => {
      const report: IngestPassReport = { pass, at: iso(at), inserted: {}, status: {} };
      await withClock(at, async () => {
        for (const [label, connector] of connectors) {
          const before = raw.length;
          await connector.start();
          report.inserted[label] = raw.length - before;
          report.status[label] = connector.getStatus();
        }
      });
      passes.push(report);
    };

    await runPass('backfill', firstNow);
    await appendTree(path.join(FIXTURES, 'claude-pass2'), claudeDir);
    await appendTree(path.join(FIXTURES, 'copilot-pass2'), copilotDir);
    await runPass('live', liveNow);
    connectors.forEach(([, c]) => c.dispose());

    // Ids embed fileKeyOf(absolute path) for ndjson spans without a hash of their own: swap in stable labels.
    const keyLabels = new Map<string, string>();
    for (const name of ['otel.jsonl', 'otel-map.jsonl', 'otel-mixed.jsonl']) {
      const file = path.join(copilotDir, name);
      keyLabels.set(fileKeyOf(file), name);
      keyLabels.set(fileKeyOf(await fs.realpath(file)), name);
    }
    const labelId = (id: string): string => {
      const m = /^local:([0-9a-z]+):/.exec(id);
      const name = m ? keyLabels.get(m[1]!) : undefined;
      return name ? id.replace(`local:${m![1]!}:`, `local:{${name}}:`) : id;
    };

    return {
      tz,
      store,
      root,
      pricing,
      passes,
      // The span DB is read through DuckDB's sqlite extension; offline, that read fails quietly and yields no rows.
      sqliteAvailable: raw.some((e) => e.id.startsWith('local:cp:')),
      freshRaw: raw,
      insertCalls,
      labelId,
      events: () => raw.map((e) => normalize(e, labelId)).sort(byTsThenId),
      stored: async () => withTz(tz, async () => (await store.reader.find()).map((e) => normalize(e, labelId)).sort(byTsThenId)),
      close: async () => {
        store.dispose();
        await fs.rm(root, { recursive: true, force: true });
      },
    };
  });
}

/** True when DuckDB's `sqlite` extension can be installed and loaded (it is downloaded on first use; offline it may not be). */
export async function sqliteExtensionAvailable(): Promise<boolean> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  try {
    await conn.run('INSTALL sqlite');
    await conn.run('LOAD sqlite');
    return true;
  } catch {
    return false;
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

/** Ingest the fixtures and return what the connectors produced (see {@link openWorld}). */
export async function ingestFixtures(opts: { tz: string; now?: number }): Promise<IngestResult> {
  const world = await openWorld(opts);
  try {
    return { events: world.events(), stored: await world.stored(), passes: world.passes };
  } finally {
    await world.close();
  }
}

// ── Snapshots (through the real UsageService) ───────────────────────────────────

export function resolveNow(tz: GoldenTz, spec: NowSpec): number {
  return withTzSync(tz, () => localInstant(spec.local(tz)));
}

/** The dashboard filter a spec stands for, resolved in the current zone. */
export function resolveFilter(spec: FilterSpec): Filter {
  return {
    ...(spec.models ? { models: spec.models } : {}),
    ...(spec.surfaces ? { surfaces: spec.surfaces } : {}),
    ...(spec.repos ? { repos: spec.repos } : {}),
    ...(spec.branches ? { branches: spec.branches } : {}),
    ...(spec.sources ? { sources: spec.sources } : {}),
    ...(spec.rangePreset ? { rangePreset: spec.rangePreset } : {}),
    ...(spec.rangeLocal
      ? { range: { start: localInstant(`${spec.rangeLocal[0]}T00:00`), end: localInstant(`${spec.rangeLocal[1]}T00:00`) } }
      : {}),
  };
}

const NO_BILLING_USER_CONFIG: UserConfig = {
  monthlyBudget: 100,
  includedCredits: 300,
  dailyCreditAlert: 0,
  alerts: { velocityEnabled: false, velocityCreditsPerHour: 0 },
  version: 1,
};

/**
 * DuckDB's `ORDER BY credits DESC` leaves ties in an unspecified (run-to-run)
 * order and the sankey list has no ORDER BY at all, so a recording must not
 * depend on either: break ties by name and sort the sankey by model, surface.
 * (Listed in INTENDED_DIFFERENCES.md as unspecified order, not behaviour.)
 */
function stabilise(d: SnapshotSourceData): SnapshotSourceData {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  const byCredits = <T extends { credits: number }>(name: (t: T) => string) => (a: T, b: T): number =>
    b.credits - a.credits || cmp(name(a), name(b));
  return {
    ...d,
    models: [...d.models].sort(byCredits((m) => m.modelId)),
    repos: [...d.repos].sort(byCredits((r) => r.repo)),
    languages: [...d.languages].sort(byCredits((l) => l.language)),
    sankey: [...d.sankey].sort((a, b) => cmp(a.model, b.model) || cmp(a.surface, b.surface)),
  };
}

interface Kit {
  svc: UsageService;
  readPaths: Array<SnapshotRecord['read']>;
  /** The SnapshotSourceData each read returned, parallel to `readPaths`. */
  reads: SnapshotSourceData[];
  unfiltered: SnapshotData[];
  warnings: string[];
  fired: string[];
  setConfig(c: UserConfig): void;
  dispose(): void;
}

function makeKit(
  reader: IEventSnapshotReader,
  pricing: FrozenPricing,
  opts: { config?: UserConfig; rates?: Record<string, number>; currency?: string } = {},
): Kit {
  let config: UserConfig = { ...(opts.config ?? NO_BILLING_USER_CONFIG), ...(opts.currency ? { currency: opts.currency } : {}) };
  const readPaths: Array<SnapshotRecord['read']> = [];
  const reads: SnapshotSourceData[] = [];
  const spy: IEventSnapshotReader = {
    readSnapshotCache: async () => {
      readPaths.push({ path: 'cache', recordFilter: null });
      const data = stabilise(await reader.readSnapshotCache());
      reads.push(data);
      return data;
    },
    readFilteredSnapshot: async (f) => {
      const { range, models, surfaces, repos, branches, sources } = f;
      readPaths.push({
        path: 'filtered',
        recordFilter: {
          ...(range ? { range } : {}),
          ...(models ? { models } : {}),
          ...(surfaces ? { surfaces } : {}),
          ...(repos ? { repos } : {}),
          ...(branches ? { branches } : {}),
          ...(sources ? { sources } : {}),
        },
      });
      const data = stabilise(await reader.readFilteredSnapshot(f));
      reads.push(data);
      return data;
    },
    creditsByBranch: (b) => reader.creditsByBranch(b),
  };
  const userConfig = { get: () => config, onDidChange: () => ({ dispose() {} }) } as unknown as IConfigService;
  const ingest = { getStatus: () => ({ kind: 'ok' as const }), start: async () => {}, dispose() {} } as unknown as IngestService;
  const currency = { currentRates: () => opts.rates ?? {} } as unknown as CurrencyService;
  const warnings: string[] = [];
  const host = { showWarningMessage: async (m: string) => void warnings.push(m), executeCommand: async () => undefined };
  const svc = new UsageService(spy, pricingService(pricing), ingest, userConfig, currency, undefined, host as never, SILENT);
  const kit: Kit = { svc, readPaths, reads, unfiltered: [], warnings, fired: [], setConfig: (c) => void (config = c), dispose: () => svc.dispose() };
  svc.onDidComputeUnfiltered((s) => kit.unfiltered.push(s));
  svc.onAlertFired((a) => kit.fired.push(a.message));
  return kit;
}

/**
 * The snapshot source data UsageService reads for `filter` at epoch-ms `now`,
 * together with how it read it: the memoised no-filter path, or the filtered
 * path with the default 365-day range when the filter has none.
 */
export async function readSnapshot(
  world: World,
  filter: Filter,
  now: number,
): Promise<{ read: SnapshotRecord['read']; data: SnapshotSourceData }> {
  return withTz(world.tz, async () => {
    // A fresh reader per call (its no-filter memo is keyed on the write version, which a bare reader never sees bump).
    const reader = new EventReader(world.store.conn, { version: 0 }, () => now);
    const kit = makeKit(reader, world.pricing);
    try {
      await withClock(now, () => kit.svc.setFilter(filter));
      return { read: kit.readPaths[kit.readPaths.length - 1]!, data: kit.reads[kit.reads.length - 1]! };
    } finally {
      kit.dispose();
    }
  });
}

/** One golden snapshot entry: a labelled filter spec read at a labelled local `now`. */
export async function snapshotRecord(world: World, spec: FilterSpec, nowSpec: NowSpec): Promise<SnapshotRecord> {
  const tz = world.tz as GoldenTz;
  const { now, filter } = withTzSync(tz, () => ({ now: localInstant(nowSpec.local(tz)), filter: resolveFilter(spec) }));
  const { read, data } = await readSnapshot(world, filter, now);
  return { label: spec.label, nowLabel: nowSpec.label, now: iso(now), filter, read, data };
}

/** `snapshot(filter, {tz, now})`: ingest the fixtures in `tz`, read the snapshot source data for `filter` at `now` (epoch ms), close. */
export async function snapshot(filter: Filter, opts: { tz: string; now: number }): Promise<SnapshotSourceData> {
  const world = await openWorld({ tz: opts.tz });
  try {
    return (await readSnapshot(world, filter, opts.now)).data;
  } finally {
    await world.close();
  }
}

/** Composed wire snapshot (budget, forecast, chart data) for a few configurations: UsageService's `current`. */
export async function usageSnapshot(
  world: World,
  spec: FilterSpec,
  nowSpec: NowSpec,
  opts: { currency?: string; rates?: Record<string, number>; config?: Partial<UserConfig> } = {},
): Promise<Json> {
  const tz = world.tz as GoldenTz;
  return withTz(tz, async () => {
    const now = localInstant(nowSpec.local(tz));
    const reader = new EventReader(world.store.conn, { version: 0 }, () => now);
    const config: UserConfig = { ...NO_BILLING_USER_CONFIG, ...(opts.config ?? {}) };
    const kit = makeKit(reader, world.pricing, { config, ...(opts.rates ? { rates: opts.rates } : {}), ...(opts.currency ? { currency: opts.currency } : {}) });
    try {
      await withClock(now, () => kit.svc.setFilter(resolveFilter(spec)));
      const cur = kit.svc.current!;
      const { chartData, ...rest } = cur;
      return {
        ...rest,
        chartData: {
          ...chartData,
          // 364 cells, almost all zero: keep the cells that carry data.
          heatmap: { max: chartData.heatmap.max, cells: chartData.heatmap.cells.filter((c) => c.value !== 0) },
        },
      } as unknown as Json;
    } finally {
      kit.dispose();
    }
  });
}

/** Credits per branch (the branch-cap alert's input). */
export async function creditsByBranch(world: World, branches: string[]): Promise<Record<string, number>> {
  return withTz(world.tz, async () => {
    const out: Record<string, number> = {};
    for (const b of branches) out[b] = await world.store.reader.creditsByBranch(b);
    return out;
  });
}

// ── Exports ──────────────────────────────────────────────────────────────────

async function exportText(world: World, format: 'csv' | 'json'): Promise<string[]> {
  const file = path.join(world.root, `export.${format}`);
  await withTz(world.tz, () => world.store.reader.exportTo(file, format));
  const text = await fs.readFile(file, 'utf8');
  return text.split('\n').filter((l) => l.length > 0).map((l) => labelLine(world, l));
}

function labelLine(world: World, line: string): string {
  // Only ids can embed a path hash; relabel the id field wherever it appears.
  return line.replace(/local:[0-9a-z]+:[^,"]+/g, (m) => world.labelId(m));
}

function lineTs(line: string, format: 'csv' | 'json'): { ts: number; id: string } {
  if (format === 'json') {
    const o = JSON.parse(line) as { ts: number; id: string };
    return { ts: Number(o.ts), id: o.id };
  }
  const [id, ts] = line.split(',', 2);
  return { ts: Number(ts), id: id! };
}

function sortExport(lines: string[], format: 'csv' | 'json'): string[] {
  return [...lines].sort((a, b) => {
    const x = lineTs(a, format);
    const y = lineTs(b, format);
    return y.ts - x.ts || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  });
}

/** "Export usage data" as CSV: DuckDB's `COPY events TO ... (FORMAT CSV, HEADER true)`. */
export async function exportCsv(world: World): Promise<CsvExport> {
  const lines = await exportText(world, 'csv');
  return { header: lines[0]!, rows: sortExport(lines.slice(1), 'csv') };
}

/** "Export usage data" as JSON: newline-delimited rows, parsed. */
export async function exportJson(world: World): Promise<Json[]> {
  return sortExport(await exportText(world, 'json'), 'json').map((l) => JSON.parse(l) as Json);
}

/**
 * The exact payloads the exporter would send for the freshly ingested events,
 * in the order container.ts produces them: per `onInserted` call (one per
 * connector pass), chunked oldest-first at 100 and built by `buildStreamBatch`, with
 * the clock frozen at `now` (including `new Date()`, which supplies
 * `tz_offset_minutes`) and the machine id supplied by the vscode mock.
 */
export function streamBatch(world: World, opts: { now: number }): StreamBatch[] {
  return withTzSync(world.tz, () =>
    withFrozenDateSync(opts.now, () =>
      world.insertCalls.flatMap((events) =>
        chunkEvents(events).map((chunk) => {
          const batch = buildStreamBatch(chunk);
          return { ...batch, events: batch.events.map((e) => ({ ...e, id: world.labelId(e.id) })) };
        }),
      ),
    ),
  );
}

// ── Compaction (rollups) ─────────────────────────────────────────────────────────

/** Roll old raw events up into per-day rows at `now`; returns the stored rows afterwards. */
export async function compact(world: World, now: number): Promise<NormalizedEvent[]> {
  await withTz(world.tz, () => withClock(now, () => world.store.compact(now)));
  return world.stored();
}

// ── Alerts and restriction ───────────────────────────────────────────────────────

interface ScriptStep {
  local: string;
  today: number;
  todayCost: number;
  mtd: number;
  mtdCost: number;
  branchCredits: number;
  action?: 'snooze-restriction-30m';
}

const ALERT_SCRIPT: ScriptStep[] = [
  { local: '2026-01-31T21:00', today: 10, todayCost: 0.4, mtd: 150, mtdCost: 60, branchCredits: 20 },
  { local: '2026-01-31T21:30', today: 30, todayCost: 1.2, mtd: 170, mtdCost: 70, branchCredits: 25 },
  { local: '2026-01-31T22:00', today: 60, todayCost: 2.4, mtd: 200, mtdCost: 82, branchCredits: 38 },
  { local: '2026-01-31T22:30', today: 95, todayCost: 3.8, mtd: 235, mtdCost: 85, branchCredits: 41 },
  // Irregular spacing: with 5+ samples in the window the built-in (first-to-last) and rule (least-squares) velocities disagree.
  { local: '2026-01-31T22:40', today: 125, todayCost: 5, mtd: 240, mtdCost: 85.5, branchCredits: 42 },
  { local: '2026-01-31T22:45', today: 132, todayCost: 5.3, mtd: 245, mtdCost: 86, branchCredits: 42 },
  { local: '2026-01-31T23:00', today: 160, todayCost: 6.4, mtd: 300, mtdCost: 99, branchCredits: 45 },
  { local: '2026-01-31T23:30', today: 165, todayCost: 6.6, mtd: 306, mtdCost: 101, branchCredits: 46, action: 'snooze-restriction-30m' },
  { local: '2026-02-01T00:00', today: 5, todayCost: 0.2, mtd: 5, mtdCost: 2, branchCredits: 0 },
  { local: '2026-02-01T00:30', today: 12, todayCost: 0.5, mtd: 12, mtdCost: 5, branchCredits: 3 },
  { local: '2026-02-01T01:00', today: 55, todayCost: 2.2, mtd: 55, mtdCost: 86, branchCredits: 41 },
  { local: '2026-02-01T01:30', today: 56, todayCost: 2.3, mtd: 56, mtdCost: 86, branchCredits: 41 },
  { local: '2026-02-01T05:30', today: 57, todayCost: 2.3, mtd: 57, mtdCost: 86, branchCredits: 41 },
  { local: '2026-02-01T09:30', today: 90, todayCost: 3.6, mtd: 90, mtdCost: 88, branchCredits: 41 },
  { local: '2026-02-01T09:35', today: 91, todayCost: 3.6, mtd: 91, mtdCost: 88, branchCredits: 41 },
];

const SONNET_ID = 'claude-sonnet-4-5-20250929';

function alertRules(snoozeUntil: string): AlertRule[] {
  return [
    { id: 'busy-day', severity: 'warning', cooldown: '2h', message: 'Busy day: {{today.credits}} credits so far', conditions: [{ field: 'today.credits', op: '>', value: 80 }] },
    {
      id: 'month-escalation', severity: 'info', message: 'Month at {{month.credits}} credits',
      thresholds: [
        { field: 'month.credits', op: '>', value: 200, severity: 'info', cooldown: '45m' },
        { field: 'month.credits', op: '>', value: 260, severity: 'warning', cooldown: '45m' },
        { field: 'month.credits', op: '>', value: 300, severity: 'critical', cooldown: '45m' },
      ],
    },
    { id: 'sonnet-heavy', severity: 'info', cooldown: '1h', message: 'Sonnet used {{ model["claude-sonnet-4-5-20250929"].credits }} credits', when: { '>': [{ var: `model["${SONNET_ID}"].credits` }, 120] } },
    { id: 'velocity-rule', severity: 'info', cooldown: '15m', message: 'Rule velocity {{velocity.creditsPerHour}} cr/h', when: { '>': [{ var: 'velocity.creditsPerHour' }, 90] } },
    { id: 'needs-signin', severity: 'warning', requiresAuth: true, message: 'Signed-in only rule', conditions: [{ field: 'today.credits', op: '>', value: 0 }] },
    { id: 'restrict-over-budget', severity: 'critical', message: 'Budget exceeded', when: { '>=': [{ var: 'budget.percentOfBudget' }, 1] }, restrict: { reEnableWhen: { '<': [{ var: 'budget.percentOfBudget' }, 0.9] } } },
    { id: 'restrict-heavy-day', severity: 'critical', message: 'Heavy day', conditions: [{ field: 'today.credits', op: '>', value: 150 }], restrict: {} },
    { id: 'restrict-snoozed', severity: 'warning', message: 'Snoozed rule', conditions: [{ field: 'today.credits', op: '>', value: 20 }], snoozeUntil, restrict: {} },
    { id: 'restrict-velocity', severity: 'warning', message: 'Spending fast', when: { '>': [{ var: 'velocity.creditsPerHour' }, 1] }, restrict: {} },
  ];
}

function scriptData(step: ScriptStep, now: number): SnapshotSourceData {
  const totals = (credits: number, cost: number, count: number) => ({ credits, cost, tokens: credits * 1000, eventCount: count });
  return {
    totals: { all: totals(step.mtd, step.mtdCost, 40), mtd: totals(step.mtd, step.mtdCost, 40), today: totals(step.today, step.todayCost, 6) },
    estimatedEventCount: 40,
    daily: [{ dayStart: startOf(now, 'day'), credits: step.today, cost: step.todayCost, tokens: step.today * 1000, eventCount: 6, catInput: 0, catOutput: 0, catCacheRead: 0, catCacheCreation: 0, catThinking: 0, catTool: 0 }],
    models: [{ modelId: SONNET_ID, credits: step.mtd * 0.6, cost: step.mtdCost * 0.6, tokens: step.mtd * 600 }, { modelId: 'gpt-4.1', credits: step.mtd * 0.4, cost: step.mtdCost * 0.4, tokens: step.mtd * 400 }],
    repos: [{ repo: 'alpha', credits: step.mtd, cost: step.mtdCost, tokens: step.mtd * 1000, heuristicShare: 0 }],
    languages: [],
    hourly: [],
    categories: [],
    sankey: [],
    dims: { models: [SONNET_ID, 'gpt-4.1'], surfaces: ['chat'], sources: ['claude-code'], repos: ['alpha'] },
    weekday: [0, 0, 0, 0, 0, 0, 0],
  };
}

/** Make `activeBranch()` report `branch` for the duration of `fn` (the vscode.git API is module-global state). */
async function withGitBranch<T>(branch: string, fn: () => Promise<T>): Promise<T> {
  const vscode = vscodeApi as unknown as { extensions: { getExtension: unknown } };
  const realGetExtension = vscode.extensions.getExtension;
  const install = async (api: unknown): Promise<void> => {
    vscode.extensions.getExtension = () => ({ isActive: true, exports: { getAPI: () => api } });
    await initRepoAttribution();
  };
  await install({
    repositories: [{ rootUri: { fsPath: '/work/alpha' }, state: { remotes: [], HEAD: { name: branch } } }],
    getRepository: () => null,
  });
  try {
    return await fn();
  } finally {
    await install(undefined);
    vscode.extensions.getExtension = realGetExtension;
  }
}

/**
 * Drive today's alert/restriction wiring through a scripted series of
 * snapshots crossing a month boundary and local midnight: the real
 * `UsageService` (history window, 24h cooldown pruning, `evaluateAlerts`,
 * `evaluateAlertRules`, `shouldNotify`) feeding a real `RestrictionEngine`
 * exactly as container.ts wires them (reconcile with the unfiltered snapshot,
 * no history, signed-out billing). Reports the toasts and restriction state
 * after every step.
 */
export async function alertSequence(opts: { tz: string }): Promise<AlertStep[]> {
  const tz = opts.tz as GoldenTz;
  const pricing = await loadPricing();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-golden-alerts-'));
  try {
    return await withTz(tz, () => withGitBranch('feature/x', async () => {
      const times = ALERT_SCRIPT.map((s) => localInstant(s.local));
      // The snoozed rule is un-snoozed at the 05:30 step.
      const rules = alertRules(iso(localInstant('2026-02-01T05:00')));
      const config: UserConfig = {
        monthlyBudget: 100,
        includedCredits: 300,
        dailyCreditAlert: 50,
        alerts: { velocityEnabled: true, velocityCreditsPerHour: 100 },
        version: 1,
        rules,
        branchBudgets: { 'feature/x': 40 },
      };
      let current = 0;
      const reader: IEventSnapshotReader = {
        readSnapshotCache: async () => scriptData(ALERT_SCRIPT[current]!, times[current]!),
        readFilteredSnapshot: async () => scriptData(ALERT_SCRIPT[current]!, times[current]!),
        creditsByBranch: async () => ALERT_SCRIPT[current]!.branchCredits,
      };
      const kit = makeKit(reader, pricing, { config });
      const engine = new RestrictionEngine(dir);
      const pending: Array<Promise<unknown>> = [];
      kit.svc.onDidComputeUnfiltered((snapshot) => {
        pending.push(engine.reconcile({ snapshot, rules, signedIn: snapshot.authStatus === 'signed-in', branchBudgets: config.branchBudgets! }));
      });
      const steps: AlertStep[] = [];
      try {
        for (let i = 0; i < ALERT_SCRIPT.length; i++) {
          current = i;
          const step = ALERT_SCRIPT[i]!;
          const now = times[i]!;
          await withClock(now, async () => {
            kit.warnings.length = 0;
            await kit.svc.setFilter({});
            await Promise.all(pending.splice(0));
            if (step.action === 'snooze-restriction-30m') await engine.snooze(30);
          });
          const st = engine.getState();
          steps.push({
            local: step.local,
            at: iso(now),
            action: step.action ?? null,
            warnings: [...kit.warnings],
            restriction: {
              active: st.active,
              ruleId: st.ruleId,
              reasonMessage: st.reasonMessage,
              firedAt: st.firedAt ? iso(st.firedAt) : null,
              userOverrideUntil: st.userOverrideUntil ? iso(st.userOverrideUntil) : null,
              isRestricted: engine.isRestricted(now),
            },
          });
        }
      } finally {
        engine.dispose();
        kit.dispose();
      }
      return steps;
    }));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ── Layout migration vectors ─────────────────────────────────────────────────────

/**
 * v1 inputs in, v2 layouts out (pure; zone-independent). The recording was originally the v1
 * normaliser's output; the v1 INPUTS are unchanged and the migrator's outputs are the recording now
 * (INTENDED_DIFFERENCES D16).
 */
export function layoutVectors(): Json {
  return {
    panelIds: [...PANEL_IDS],
    defaultLayout: defaultLayout(),
    gridColumnToSpan: ['', 'span 1', 'span 4', 'span 5', 'span 0', 'SPAN 2', 'span', 'span  3 ', '3', 'span 2.5', undefined].map((v) => ({ input: v ?? null, output: gridColumnToSpan(v) })),
    migrateV1: LAYOUT_V1_CASES.map(([label, input]) => ({ label, input: input ?? null, output: migrateV1(input) })),
    configPanelsToLayout: LAYOUT_CONFIG_CASES.map(([label, panels]) => ({ label, panels: panels ?? null, output: migrateV1(configPanelsToLayout(panels)) })),
  };
}

// ── Pricing vectors ──────────────────────────────────────────────────────────────

const PRICE_PROBES = [
  'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'gpt-5-mini', 'gpt-5.1-codex', 'o3-mini', 'gemini-2.5-pro',
  'claude-sonnet-4-5-20250929', 'claude-sonnet-4.5', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219',
  'claude-opus-4-5-20251101', 'claude-opus-4.5', 'claude-opus-4-1-20250805', 'claude-haiku-4-5-20251001', 'claude-3-5-haiku-20241022',
  'us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'anthropic/claude-opus-4.5', 'claude-fable-9', 'mystery-model-x', '', 'GPT-4O',
];

/** Credit multipliers and per-token costs for a set of model spellings against the frozen pricing inputs. */
export async function pricingVectors(): Promise<Json> {
  const pricing = await loadPricing();
  const million = { prompt: 1e6, completion: 1e6, cacheCreation: 1e6, cacheRead: 1e6, thinking: 1e6 };
  return {
    pricePerCredit: pricing.pricePerCredit,
    defaultMultipliers: DEFAULT_MULTIPLIERS,
    models: PRICE_PROBES.map((model) => ({
      model,
      normalized: normalizeModelId(model),
      multiplierManifest: resolveMultiplier(model, undefined, pricing.currentManifest),
      multiplierDefaults: resolveMultiplier(model),
      request: priceRequest(model, { pricePerCredit: pricing.pricePerCredit, currency: 'USD', manifest: pricing.currentManifest }),
      feedCostPer1MEach: priceTokens(model, million, pricing.tokenPrices) ?? null,
      bundledCostPer1MEach: priceTokens(model, million, CLAUDE_FALLBACK_TOKEN_PRICES) ?? null,
    })),
  };
}

export { NOW_SPECS, COMPACTION_RETENTION_DAYS };

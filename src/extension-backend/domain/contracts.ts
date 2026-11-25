/**
 * Shared type contracts for the overhaul streams (see the plan: store and
 * read-time pricing, flat alerts, gridstack layout). TYPES ONLY — no runtime
 * code lives here, so importing this file never loads anything and it is safe
 * for the webview-safe domain code. Each stream implements the contract named
 * in the doc comment of the type; changing a shape here is a cross-stream
 * decision, not a local one.
 */
import type { RecordFilter } from '../store/EventRepository';
import type { PricingManifest, TokenPrices } from './pricing';
import type { RepoAttribution, SourceKind, Surface } from './types';

// ── Read-time pricing (stream A) ─────────────────────────────────────────────

/**
 * Everything needed to price a stored row at read time. `version` is a content
 * hash that changes only when the prices change, so it can key snapshot
 * caches. Implemented by stream A (`PricingService` produces it, `priceRow` and
 * `buildSnapshotSource` consume it).
 */
export interface PricingSnapshot {
  manifest: PricingManifest;
  /** Per-token USD prices (OpenRouter/LiteLLM feed); undefined until the feed has loaded. */
  tokenPrices: TokenPrices | undefined;
  /** USD per Copilot premium-request credit. */
  pricePerCredit: number;
  /** Content hash of the above; bumps only when the prices actually change. */
  version: string;
}

// ── Event store (stream A) ───────────────────────────────────────────────────

/**
 * One stored usage row with no price attached: credits and cost are derived
 * at read time from a {@link PricingSnapshot}. Nullable columns are `null`
 * (not absent) because this is the row as stored. Implemented by stream A
 * (the `events` table in `events.sqlite`).
 */
export interface RawEvent {
  id: string;
  /** Epoch ms. */
  ts: number;
  /** Normalised model id. */
  modelId: string;
  surface: Surface;
  source: SourceKind;
  repo: string | null;
  branch: string | null;
  attribution: RepoAttribution | null;
  language: string | null;
  /** Number of requests this row stands for (rollup rows carry more than 1). Defaults to 1. */
  requests: number;
  /** null when the source did not report prompt tokens (prices through the credit path). */
  promptTokens: number | null;
  /** null when the source did not report completion tokens. */
  completionTokens: number | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
}

/**
 * What the store returns from SQL pre-aggregation: one row per 15-minute UTC
 * bucket and distinct dimension tuple, summing requests and every token
 * column. Pricing is linear in tokens and requests, so aggregating before
 * pricing is exact. `tokensKnown` (prompt or completion token not NULL) is in
 * the grouping key so the token-price vs credit-price branch of `priceRow`
 * stays exact. Implemented by stream A (`IEventStore.aggregate`).
 */
export interface AggregateGroup {
  /** Start of the 15-minute UTC bucket, epoch ms. */
  bucketStartMs: number;
  modelId: string;
  surface: Surface;
  source: SourceKind;
  repo: string | null;
  branch: string | null;
  language: string | null;
  attribution: RepoAttribution | null;
  /** True when promptTokens or completionTokens was not NULL on the grouped rows. */
  tokensKnown: boolean;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
}

/**
 * The event store as the rest of the extension sees it. Implemented by stream
 * A (the `node:sqlite` store). Semantics:
 *
 * - `insert` dedupes by id and reports which rows were new (`fresh`), which is
 *   what the exporter streams. A later row for an existing id may raise its
 *   token counts but never lowers them.
 * - `aggregate` is a read over ONE time window. Callers slice a longer range
 *   into 7-day windows and yield to the event loop (`setImmediate`) between
 *   them, so a large read never blocks the extension host.
 * - `requestsByModelForBranch` replaces the old per-branch credit query: the
 *   caller applies each model's multiplier, so no price is stored or read.
 * - `exportRows` streams every stored row in batches (for CSV/JSON export).
 * - `dataVersion` changes whenever any window's commit changes the data, and
 *   keys read caches.
 */
export interface IEventStore {
  insert(events: RawEvent[]): Promise<{ inserted: number; fresh: RawEvent[] }>;
  aggregate(filter: RecordFilter, window: { fromMs: number; toMs: number }): Promise<AggregateGroup[]>;
  requestsByModelForBranch(branch: string): Promise<Array<{ modelId: string; requests: number }>>;
  exportRows(): AsyncIterable<RawEvent[]>;
  compact(now?: number): Promise<void>;
  clear(): Promise<void>;
  dataVersion(): number;
  dispose(): void;
}

// ── Flat alerts (stream C) ───────────────────────────────────────────────────

/**
 * The fixed set of metrics a flat alert rule can compare, plus the keyed
 * per-model and per-repo forms. Implemented by stream C (the metric lookup
 * that replaces the rules language's variable context).
 */
export type FlatAlertMetric =
  | 'today.credits'
  | 'today.cost'
  | 'month.credits'
  | 'month.cost'
  | 'budget.percentOfBudget'
  | 'budget.percentOfIncluded'
  | 'forecast.projectedCredits'
  | 'forecast.projectedCost'
  | 'velocity.creditsPerHour'
  | 'window7d.credits'
  | 'currentBranchCredits'
  | `model:${string}.credits`
  | `model:${string}.cost`
  | `repo:${string}.credits`
  | `repo:${string}.cost`;

/**
 * One flat threshold rule: `metric op value`. Replaces the JSONLogic rules
 * language. Implemented by stream C (`AlertService` evaluates it,
 * `RestrictionEngine` honours `restrict`).
 */
export interface FlatAlertRule {
  id: string;
  metric: FlatAlertMetric;
  op: '>' | '>=' | '<' | '<=' | '==' | '!=';
  value: number;
  /** Minimum time between firings: a positive number + m/h/d/w ("30m", "1.5h", "2d"). */
  cooldown: string;
  severity: 'info' | 'warning' | 'critical';
  /** Show a notification when the rule fires. */
  notify?: boolean;
  /** Engage the (notification-only) restriction while the rule matches. */
  restrict?: boolean;
  /** Lift the restriction once the metric falls below this value (instead of as soon as the rule stops matching). */
  clearBelow?: number;
}

// ── Dashboard layout (stream D) ──────────────────────────────────────────────

/**
 * The gridstack dashboard layout persisted in `globalState` under
 * `mallard.layout.v2`: one rectangle per panel in grid units. Implemented by
 * stream D (a pure v1-to-v2 migrator and the `GridEngine` adapter).
 */
export interface LayoutV2 {
  version: 2;
  panels: Array<{ id: string; x: number; y: number; w: number; h: number; hidden: boolean }>;
}

/* c8 ignore next */
/**
 * Model → credit (premium-request) weight and cost helpers.
 *
 * GitHub bills "premium requests": one request costs `multiplier` credits
 * depending on the model. Default multipliers come from the bundled
 * pricing manifest and are refreshed daily — settings are only needed
 * for non-standard enterprise plans.
 */
import type { PricingSnapshot } from './contracts';
import type { CostCategory, SourceKind } from './types';
import { splitCostSimple } from '../ingest/connectorUtils';

export interface PricingManifest {
  version: number;
  pricePerCredit: number;
  updatedAt: string;
  models: Record<string, number>;
}

/** USD per token for one model, from OpenRouter/LiteLLM. */
export interface ModelTokenPrice {
  input: number;
  output: number;
  /** Reading from prompt cache. Falls back to `input` when absent. */
  cacheRead?: number;
  /** Writing to prompt cache. Falls back to `input` when absent. */
  cacheWrite?: number;
  /** Reasoning/thinking tokens. Falls back to `output` when absent. */
  thinking?: number;
}

/** Model-id substring → per-token USD prices. */
export type TokenPrices = Record<string, ModelTokenPrice>;

/** Anthropic list price (USD per million tokens) → per-token rates; the
 *  published cache multipliers are 1.25× input to write, 0.1× input to read. */
function listPrice(inputPerMtok: number, outputPerMtok: number): ModelTokenPrice {
  return {
    input: inputPerMtok / 1e6,
    output: outputPerMtok / 1e6,
    cacheWrite: (inputPerMtok * 1.25) / 1e6,
    cacheRead: (inputPerMtok * 0.1) / 1e6,
  };
}

/**
 * Offline last resort for Claude-family models, used only when the live price
 * feed (OpenRouter/LiteLLM, or its cache) has no entry. Costs derived from it
 * are estimates. This exists so Claude Code rows are never priced with the
 * Copilot credit multiplier, which has no relation to what Anthropic bills.
 */
export const CLAUDE_FALLBACK_TOKEN_PRICES: TokenPrices = {
  'claude-opus-4.5': listPrice(5, 25),
  'claude-opus-4.6': listPrice(5, 25),
  'claude-opus-4.7': listPrice(5, 25),
  'claude-opus-4.8': listPrice(5, 25),
  'claude-opus': listPrice(15, 75),
  'claude-sonnet': listPrice(3, 15),
  'claude-haiku-3.5': listPrice(0.8, 4),
  'claude-haiku': listPrice(1, 5),
};

export interface PricingConfig {
  pricePerCredit: number;
  currency: string;
  manifest?: PricingManifest;
}

/**
 * Default premium-request multipliers, keyed by a model-id substring.
 * Mirrors media/pricing-manifest.json (GitHub's published multiplier table,
 * last synced 2026-07-03); the manifest is the refreshed source of truth and
 * this constant is only the compiled-in fallback.
 */
export const DEFAULT_MULTIPLIERS: Record<string, number> = {
  'gpt-4o-mini': 0.33,
  'gpt-4.1-mini': 0,
  'gpt-4.1-nano': 0,
  'gpt-4.1': 0,
  'gpt-4o': 0.33,
  'gpt-5.1-codex-mini': 0.33,
  'gpt-5.1-codex-max': 3,
  'gpt-5.1-codex': 3,
  'gpt-5.1': 3,
  'gpt-5.3-codex': 6,
  'gpt-5.4-mini': 6,
  'gpt-5.4': 6,
  'gpt-5.5': 57,
  'gpt-5-mini': 0.33,
  'gpt-5': 1,
  'o4-mini': 0.33,
  'o3-mini': 0.33,
  o3: 10,
  'claude-3.5-haiku': 0.33,
  'claude-haiku-4-5': 0.33,
  'claude-haiku': 0.33,
  'claude-3.5-sonnet': 1,
  'claude-3.7-sonnet': 1.25,
  'claude-sonnet-4-5': 6,
  'claude-sonnet-4-6': 9,
  'claude-sonnet-4': 1,
  'claude-opus-4-5': 15,
  'claude-opus-4-6': 27,
  'claude-opus-4-7': 27,
  'claude-opus-4-8': 27,
  'claude-opus-4': 10,
  'claude-opus': 15,
  'gemini-2.0-flash': 0.25,
  'gemini-2.5-flash': 0.25,
  'gemini-2.5-pro': 1,
  'gemini-3-flash': 0.33,
  'gemini-3.5-flash': 14,
  'gemini-3.1-pro': 6,
  'gemini-3-pro': 6,
  'raptor-mini': 0.33,
  'mai-code-1-flash': 0.33,
  unknown: 1,
};

/** Coarse family label for display/grouping. */
/* c8 ignore next */
export function modelFamily(modelId: string): string {
  const id = (modelId || '').toLowerCase();
  if (id.includes('gpt')) return 'gpt';
  if (id.includes('claude')) return 'claude';
  if (id.startsWith('o') && /o\d/.test(id)) return 'o-series';
  if (id.includes('gemini')) return 'gemini';
  return 'other';
}

const normalizeMemo = new Map<string, string>();

/**
 * Canonical, spelling-independent form of a model id, used on BOTH sides of
 * every lookup (credit multipliers and token prices). Copilot sends dotted ids
 * (`claude-opus-4.5`), Claude Code sends dashed dated ids
 * (`claude-opus-4-5-20251101`), and the manifest/LiteLLM/OpenRouter mix both,
 * so each id is reduced to: lowercase, no provider prefix, no `:variant` or
 * date suffix, minor-version dashes as dots, and Claude family-first order
 * (`claude-3-5-sonnet` → `claude-sonnet-3.5`).
 */
export function normalizeModelId(modelId: string): string {
  const raw = modelId || '';
  const memo = normalizeMemo.get(raw);
  if (memo !== undefined) return memo;

  let id = raw.trim().toLowerCase();
  const slash = id.lastIndexOf('/');
  if (slash >= 0) id = id.slice(slash + 1);
  // Bedrock-style prefixes ("us.anthropic.claude-…").
  const claudeAt = id.indexOf('.claude');
  if (claudeAt >= 0) id = id.slice(claudeAt + 1);
  const colon = id.indexOf(':');
  if (colon >= 0) id = id.slice(0, colon).replace(/-v\d+$/, '');
  id = id.replace(/[-@](?:\d{8}|\d{4}-\d{2}-\d{2})(?=-|$)/, '');
  id = id.replace(/-(\d)-(\d)(?!\d)/, '-$1.$2');
  id = id.replace(/^claude-(\d+\.?\d*)-(opus|sonnet|haiku)(?=-|$)/, 'claude-$2-$1');

  if (normalizeMemo.size >= 1024) normalizeMemo.clear();
  normalizeMemo.set(raw, id);
  return id;
}

interface KeyEntry {
  /** Normalized key, matched as a substring of the normalized model id. */
  norm: string;
  /** Original key, to read the (possibly mutated) value from the record. */
  key: string;
}

const keyIndex = new WeakMap<object, { count: number; entries: KeyEntry[] }>();

/** Record keys normalized and ordered longest-first, so the most specific wins. */
function sortedKeys(rec: Record<string, unknown>): KeyEntry[] {
  const keys = Object.keys(rec);
  const hit = keyIndex.get(rec);
  if (hit && hit.count === keys.length) return hit.entries;
  const entries = keys
    .map((key) => ({ key, norm: normalizeModelId(key) }))
    .sort((a, b) => b.norm.length - a.norm.length);
  keyIndex.set(rec, { count: keys.length, entries });
  return entries;
}

/** Value of the longest record key contained in the (normalized) model id. */
function lookupLongest<T>(
  id: string,
  rec: Record<string, T>,
  skipKey?: string,
): T | undefined {
  for (const { key, norm } of sortedKeys(rec)) {
    if (norm === skipKey) continue;
    if (id.includes(norm)) return rec[key];
  }
  return undefined;
}

/**
 * Resolve the credit multiplier for a model id.
 * Priority: overrides → manifest → defaults → 1 (unknown).
 */
export function resolveMultiplier(
  modelId: string,
  overrides?: Record<string, number>,
  manifest?: PricingManifest,
): number {
  const id = normalizeModelId(modelId);

  if (overrides) {
    const hit = lookupLongest(id, overrides);
    if (hit !== undefined) return hit;
  }

  const source = manifest?.models ?? DEFAULT_MULTIPLIERS;
  const hit = lookupLongest(id, source, 'unknown');
  if (hit !== undefined) return hit;
  /* c8 ignore next */
  return source['unknown'] ?? DEFAULT_MULTIPLIERS['unknown']!;
}

export function costForCredits(credits: number, pricePerCredit: number): number {
  return credits * pricePerCredit;
}

/** Longest matching key in `prices` whose (normalized) key appears in `modelId`. */
function resolveTokenPrice(
  modelId: string,
  prices: TokenPrices,
): ModelTokenPrice | undefined {
  return lookupLongest(normalizeModelId(modelId), prices);
}

export interface TokenUsage {
  prompt?: number;
  completion?: number;
  cacheCreation?: number;
  cacheRead?: number;
  thinking?: number;
}

export interface TokenCost {
  total: number;
  byCategory: {
    input?: number;
    output?: number;
    cache_creation?: number;
    cache_read?: number;
    thinking?: number;
  };
}

/**
 * Exact per-token cost for a request, when a token price is known for the
 * model. Returns undefined when the model has no token price or the usage
 * carries no tokens — callers fall back to the credit-multiplier estimate.
 * Thinking tokens use the dedicated reasoning rate when the feed provides
 * one, else the output rate.
 */
export function priceTokens(
  modelId: string,
  usage: TokenUsage,
  prices: TokenPrices | undefined,
): TokenCost | undefined {
  if (!prices) return undefined;
  return costAtPrice(resolveTokenPrice(modelId, prices), usage);
}

/** {@link priceTokens} for a price that is already resolved (undefined: the model has none). */
function costAtPrice(p: ModelTokenPrice | undefined, usage: TokenUsage): TokenCost | undefined {
  if (!p) return undefined;

  const cacheRead = p.cacheRead ?? p.input;
  const cacheWrite = p.cacheWrite ?? p.input;
  const thinking = p.thinking ?? p.output;
  const byCategory: TokenCost['byCategory'] = {};
  if (usage.prompt) byCategory.input = usage.prompt * p.input;
  if (usage.completion) byCategory.output = usage.completion * p.output;
  if (usage.cacheCreation) byCategory.cache_creation = usage.cacheCreation * cacheWrite;
  if (usage.cacheRead) byCategory.cache_read = usage.cacheRead * cacheRead;
  if (usage.thinking) byCategory.thinking = usage.thinking * thinking;

  const total = Object.values(byCategory).reduce((a, v) => a + v, 0);
  if (total <= 0) return undefined;
  return { total, byCategory };
}

/** Compute credits + cost for a single request of `modelId`. */
/* c8 ignore next */
export function priceRequest(
  modelId: string,
  cfg: PricingConfig,
): { credits: number; cost: number } {
  const credits = resolveMultiplier(modelId, undefined, cfg.manifest);
  return { credits, cost: costForCredits(credits, cfg.pricePerCredit) };
}

// ── Read-time pricing of stored usage ────────────────────────────────────────

/**
 * What prices a stored row or a pre-aggregated group: the part shared by
 * `RawEvent` (one request, nullable token columns) and `AggregateGroup` (the
 * sum of many requests, `tokensKnown` from the grouping key). Both are
 * assignable to it.
 */
export interface PricedUsage {
  source: SourceKind;
  /** Any spelling; the multiplier and token-price lookups normalise it. */
  modelId: string;
  /** Requests this row or group stands for. */
  requests: number;
  /**
   * Whether the source reported prompt or completion tokens. Aggregation keeps
   * it in the grouping key; for a single row it is derived (see
   * {@link hasKnownTokens}). A row prices by token only when it also has
   * tokens to price, so a group key of "not NULL" lumps a known 0/0 row (credit
   * price) with token-bearing rows (token price); a key of "tokens > 0" would
   * not.
   */
  tokensKnown?: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
}

/** Credits, cost (USD) and the per-category split of that cost, as priced by {@link priceUsage}. */
export interface UsageCost {
  credits: number;
  cost: number;
  costByCategory?: Partial<Record<CostCategory, number>>;
}

/**
 * The "tokens known" rule: the source reported a prompt or a completion count
 * (a count of 0 is known, `null` is not). An explicit `tokensKnown`, which the
 * store's aggregation puts in the grouping key, wins over the counts.
 */
export function hasKnownTokens(u: Pick<PricedUsage, 'tokensKnown' | 'promptTokens' | 'completionTokens'>): boolean {
  return u.tokensKnown ?? (u.promptTokens !== null || u.completionTokens !== null);
}

/** Everything about a model that does not depend on the row: looked up once per model, not once per row. */
interface ModelPricing {
  perRequest: { credits: number; cost: number };
  feed: ModelTokenPrice | undefined;
  list: ModelTokenPrice | undefined;
}

/**
 * Price a stored row, or an aggregate group of rows, with the current prices.
 * It reproduces what the connectors used to compute once at ingest, so
 * `priceUsage(row)` equals the credits, cost and `costByCategory` they stored
 * under the same prices. Everything is linear in `requests` and the token
 * sums, which is why pricing a group equals the sum of pricing its rows.
 *
 * Copilot (any source but `claude-code`):
 *  - `credits` = credit multiplier of the model x `requests`;
 *  - `cost` = per-token cost of the PROMPT and COMPLETION tokens (cache and
 *    thinking tokens are not priced) when {@link hasKnownTokens} holds and the
 *    feed knows the model and the tokens cost something; otherwise
 *    `credits x pricePerCredit`;
 *  - `costByCategory` = the token cost's own split, else (cost and tokens both
 *    positive) the cost split input/output by token ratio, else absent.
 *
 * Claude Code:
 *  - `credits` = credit multiplier x `requests` (a Copilot-equivalent weight);
 *  - `cost` = per-token cost of all five token categories from the feed, else
 *    from the bundled list prices, else 0. The credit multiplier never prices
 *    a Claude row; `tokensKnown` plays no part.
 */
export function priceUsage(u: PricedUsage, snapshot: PricingSnapshot): UsageCost {
  return createPricer(snapshot)(u);
}

/**
 * {@link priceUsage} bound to one snapshot, remembering each model's lookups
 * (multiplier, feed price, bundled price) so pricing many groups of a few
 * dozen models does not rescan the price tables per group. The snapshot must
 * not be mutated while the pricer is in use.
 */
export function createPricer(snapshot: PricingSnapshot): (u: PricedUsage) => UsageCost {
  const models = new Map<string, ModelPricing>();
  const modelPricing = (modelId: string): ModelPricing => {
    let m = models.get(modelId);
    if (m === undefined) {
      m = {
        perRequest: priceRequest(modelId, { pricePerCredit: snapshot.pricePerCredit, currency: 'USD', manifest: snapshot.manifest }),
        feed: snapshot.tokenPrices ? resolveTokenPrice(modelId, snapshot.tokenPrices) : undefined,
        list: resolveTokenPrice(modelId, CLAUDE_FALLBACK_TOKEN_PRICES),
      };
      models.set(modelId, m);
    }
    return m;
  };

  return (u) => {
    const { perRequest, feed, list } = modelPricing(u.modelId);
    const credits = perRequest.credits * u.requests;

    if (u.source === 'claude-code') {
      const tokens: TokenUsage = {
        prompt: u.promptTokens ?? 0,
        completion: u.completionTokens ?? 0,
        cacheCreation: u.cacheCreationTokens,
        cacheRead: u.cacheReadTokens,
        thinking: u.thinkingTokens,
      };
      const tokenCost = costAtPrice(feed, tokens) ?? costAtPrice(list, tokens);
      return {
        credits,
        cost: tokenCost?.total ?? 0,
        ...(tokenCost ? { costByCategory: tokenCost.byCategory } : {}),
      };
    }

    const known = hasKnownTokens(u);
    const prompt = known ? (u.promptTokens ?? 0) : 0;
    const completion = known ? (u.completionTokens ?? 0) : 0;
    const tokenCost = costAtPrice(feed, { prompt, completion });
    const cost = tokenCost?.total ?? perRequest.cost * u.requests;
    const totalTokens = prompt + completion;
    const costByCategory =
      tokenCost?.byCategory ??
      (cost > 0 && totalTokens > 0 ? splitCostSimple(cost, prompt, totalTokens) : undefined);
    return { credits, cost, ...(costByCategory ? { costByCategory } : {}) };
  };
}

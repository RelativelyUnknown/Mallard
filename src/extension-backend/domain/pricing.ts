/* c8 ignore next */
/**
 * Model → credit (premium-request) weight and cost helpers.
 *
 * GitHub bills "premium requests": one request costs `multiplier` credits
 * depending on the model. Default multipliers come from the bundled
 * pricing manifest and are refreshed daily — settings are only needed
 * for non-standard enterprise plans.
 */

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
  const p = resolveTokenPrice(modelId, prices);
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

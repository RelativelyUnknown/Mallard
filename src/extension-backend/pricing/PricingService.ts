/**
 * Loads and caches model pricing from two independent layers:
 *
 * 1. Copilot credit multipliers (the "manifest"): hand-maintained by this
 *    project because GitHub publishes no machine-readable source for premium
 *    request multipliers. Priority: repo URL → cached (< 24h) → bundled, where
 *    a bundled manifest newer than the cached/remote one always wins.
 * 2. Per-token USD prices for exact Claude Code costing: fetched daily from
 *    OpenRouter's public models API, with LiteLLM's community price sheet as
 *    fallback. Only families Mallard tracks are kept.
 *
 * All payloads are validated before caching — never executed.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { ModelTokenPrice, PricingManifest, TokenPrices } from '../domain/pricing';
import { fetchJson } from './httpJson';

const CACHE_FILE = 'pricing-manifest.json';
const TOKEN_PRICES_CACHE_FILE = 'token-prices.json';
const REMOTE_URL =
  'https://raw.githubusercontent.com/RelativelyUnknown/mallard/main/media/pricing-manifest.json';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A cached token-price sheet older than a day is refreshed but, if the
 * refresh fails (offline), still beats having no per-token prices at all. */
const TOKEN_PRICES_MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** How long the first load waits for the price feed so the first ingest is
 * priced; a slower feed keeps going in the background. */
const TOKEN_PRICES_FIRST_FETCH_WAIT_MS = 5_000;
/** pricePerCredit sanity bound (USD); GitHub's is $0.04. */
const MAX_PRICE_PER_CREDIT = 10;

/** Model families Mallard can encounter in Copilot/Claude Code logs. */
const RELEVANT_MODEL_RE = /claude|gpt|gemini|^o\d|llama|mistral|raptor|mai-code/;

/** Strip the provider prefix OpenRouter uses ("anthropic/claude-…"). */
function stripProviderPrefix(id: string): string {
  const slash = id.lastIndexOf('/');
  return (slash >= 0 ? id.slice(slash + 1) : id).toLowerCase();
}

function positiveNum(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Parse OpenRouter GET /api/v1/models into a TokenPrices map (USD/token). */
export function parseOpenRouterModels(payload: unknown): TokenPrices {
  const out: TokenPrices = {};
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return out;
  for (const item of data) {
    const m = item as { id?: unknown; pricing?: Record<string, unknown> };
    if (typeof m.id !== 'string' || !m.pricing) continue;
    const id = stripProviderPrefix(m.id);
    if (!RELEVANT_MODEL_RE.test(id)) continue;
    const input = positiveNum(m.pricing['prompt']);
    const output = positiveNum(m.pricing['completion']);
    if (input === undefined || output === undefined) continue;
    const price: ModelTokenPrice = { input, output };
    const cacheRead = positiveNum(m.pricing['input_cache_read']);
    const cacheWrite = positiveNum(m.pricing['input_cache_write']);
    const thinking = positiveNum(m.pricing['internal_reasoning']);
    if (cacheRead !== undefined) price.cacheRead = cacheRead;
    if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
    if (thinking !== undefined) price.thinking = thinking;
    out[id] = price;
  }
  return out;
}

/** Parse LiteLLM's model_prices_and_context_window.json into a TokenPrices map. */
export function parseLiteLlmPrices(payload: unknown): TokenPrices {
  const out: TokenPrices = {};
  if (!payload || typeof payload !== 'object') return out;
  for (const [rawId, entry] of Object.entries(payload as Record<string, unknown>)) {
    const e = entry as Record<string, unknown>;
    const id = stripProviderPrefix(rawId);
    if (!RELEVANT_MODEL_RE.test(id)) continue;
    const input = positiveNum(e['input_cost_per_token']);
    const output = positiveNum(e['output_cost_per_token']);
    if (input === undefined || output === undefined) continue;
    const price: ModelTokenPrice = { input, output };
    const cacheRead = positiveNum(e['cache_read_input_token_cost']);
    const cacheWrite = positiveNum(e['cache_creation_input_token_cost']);
    const thinking = positiveNum(e['output_cost_per_reasoning_token']);
    if (cacheRead !== undefined) price.cacheRead = cacheRead;
    if (cacheWrite !== undefined) price.cacheWrite = cacheWrite;
    if (thinking !== undefined) price.thinking = thinking;
    // LiteLLM lists the same model under several provider aliases; first one wins.
    if (!(id in out)) out[id] = price;
  }
  return out;
}

function isValidManifest(v: unknown): v is PricingManifest {
  if (!v || typeof v !== 'object') return false;
  const m = v as Record<string, unknown>;
  if (
    typeof m.version !== 'number' || !Number.isFinite(m.version) ||
    typeof m.pricePerCredit !== 'number' || !Number.isFinite(m.pricePerCredit) ||
    m.pricePerCredit <= 0 || m.pricePerCredit > MAX_PRICE_PER_CREDIT ||
    typeof m.updatedAt !== 'string' ||
    typeof m.models !== 'object' || m.models === null || Array.isArray(m.models)
  ) {
    return false;
  }
  // One poisoned multiplier would mis-price every request of that model.
  return Object.values(m.models).every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0);
}

/** True when `a` is strictly older than `b` (by version, then content date). */
function isOlder(a: PricingManifest, b: PricingManifest): boolean {
  if (a.version !== b.version) return a.version < b.version;
  const da = Date.parse(a.updatedAt);
  const db = Date.parse(b.updatedAt);
  return Number.isFinite(da) && Number.isFinite(db) && da < db;
}

function isValidTokenPrice(p: unknown): p is ModelTokenPrice {
  if (!p || typeof p !== 'object') return false;
  const r = p as Record<string, unknown>;
  return ['input', 'output'].every((k) => typeof r[k] === 'number' && Number.isFinite(r[k]) && (r[k] as number) > 0);
}

async function fetchManifest(url: string): Promise<PricingManifest> {
  const parsed = await fetchJson(url);
  if (!isValidManifest(parsed)) throw new Error('Invalid manifest shape');
  return parsed;
}

export class PricingService {
  private manifest: PricingManifest;
  private readonly bundled: PricingManifest;
  private tokenPrices_: TokenPrices = {};
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly storageDir: string,
    bundled: PricingManifest,
    private readonly remoteUrl: string = REMOTE_URL,
    private readonly firstFetchWaitMs: number = TOKEN_PRICES_FIRST_FETCH_WAIT_MS,
  ) {
    this.manifest = bundled;
    this.bundled = bundled;
  }

  get pricePerCredit(): number {
    return this.manifest.pricePerCredit;
  }

  get currentManifest(): PricingManifest {
    return this.manifest;
  }

  /** Per-token USD prices from the daily feed, or undefined before the first
   * successful fetch (callers fall back to credit-multiplier estimates). */
  get tokenPrices(): TokenPrices | undefined {
    return Object.keys(this.tokenPrices_).length > 0 ? this.tokenPrices_ : undefined;
  }

  allPrices(): ReadonlyArray<{ modelId: string; multiplier: number }> {
    return Object.entries(this.manifest.models ?? {}).map(([modelId, multiplier]) => ({
      modelId,
      multiplier: typeof multiplier === 'number' ? multiplier : 1,
    }));
  }

  async load(): Promise<void> {
    const cached = await this.loadCached();
    if (cached && !isOlder(cached, this.bundled)) {
      this.manifest = cached;
    }
    const cachedTokenPrices = await this.loadCachedTokenPrices();
    if (cachedTokenPrices) {
      this.tokenPrices_ = cachedTokenPrices.prices;
    }
    // The manifest refresh stays non-blocking.
    void this.tryRemoteRefresh();
    // Per-token prices gate Claude Code costing, and ingest starts right after
    // load(): without a price table the first ingest would permanently store
    // rows priced by the fallback (inserts never update). So wait briefly for
    // the first fetch when there is no fresh cache; a stale cache (<= 30 days)
    // is already in place and survives a failed refresh.
    if (!cachedTokenPrices || cachedTokenPrices.ageMs >= REFRESH_INTERVAL_MS) {
      await this.withTimeout(this.tryTokenPricesRefresh(), this.firstFetchWaitMs);
    }
  }

  /** Resolve when `p` settles or after `ms`, whichever is first (never rejects). */
  private withTimeout(p: Promise<void>, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      void p.finally(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  startDailyRefresh(): void {
    this.refreshTimer = setInterval(() => {
      /* c8 ignore next 2 */
      void this.tryRemoteRefresh();
      void this.tryTokenPricesRefresh();
    }, REFRESH_INTERVAL_MS);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  /** Delete the cached pricing data from disk (used by the full-reset command). */
  async clearCache(): Promise<void> {
    try {
      await fs.rm(path.join(this.storageDir, CACHE_FILE), { force: true });
      await fs.rm(path.join(this.storageDir, TOKEN_PRICES_CACHE_FILE), { force: true });
    } /* c8 ignore next 2 */ catch {
      // Nothing cached, or already gone.
    }
  }

  private async loadCached(): Promise<PricingManifest | null> {
    const file = path.join(this.storageDir, CACHE_FILE);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isValidManifest(parsed)) return null;
      // `fetchedAt` is when the cache was written; `updatedAt` stays the
      // manifest's own content date (older caches stored fetch time there).
      const fetchedAt = (parsed as { fetchedAt?: unknown }).fetchedAt;
      const age = Date.now() - Date.parse(typeof fetchedAt === 'string' ? fetchedAt : parsed.updatedAt);
      if (Number.isFinite(age) && age < REFRESH_INTERVAL_MS) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  private async tryRemoteRefresh(): Promise<void> {
    if (!this.remoteUrl) return;
    try {
      const fetched = await fetchManifest(this.remoteUrl);
      // Never let an older remote copy downgrade the manifest shipped with
      // this build (e.g. a stale CDN or a rolled-back main).
      if (isOlder(fetched, this.bundled)) return;
      this.manifest = fetched;
      await this.cache(fetched);
    } catch {
      // Network failures are silent — we continue with the current manifest.
    }
  }

  private async cache(m: PricingManifest): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      await fs.writeFile(
        path.join(this.storageDir, CACHE_FILE),
        JSON.stringify({ ...m, fetchedAt: new Date().toISOString() }),
        'utf8',
      );
    } catch {
      // Cache write failures are silent.
    }
  }

  // ── Per-token price feed ────────────────────────────────────────────────────

  /** Cached token prices up to 30 days old, with their age so callers can
   * tell fresh from stale. Invalid entries are dropped. */
  private async loadCachedTokenPrices(): Promise<{ prices: TokenPrices; ageMs: number } | null> {
    try {
      const raw = await fs.readFile(path.join(this.storageDir, TOKEN_PRICES_CACHE_FILE), 'utf8');
      const parsed = JSON.parse(raw) as { fetchedAt?: string; prices?: Record<string, unknown> };
      if (!parsed.prices || typeof parsed.prices !== 'object') return null;
      const ageMs = Date.now() - Date.parse(parsed.fetchedAt ?? '');
      if (!Number.isFinite(ageMs) || ageMs >= TOKEN_PRICES_MAX_STALE_MS) return null;
      const prices: TokenPrices = {};
      for (const [id, p] of Object.entries(parsed.prices)) {
        if (isValidTokenPrice(p)) prices[id] = p;
      }
      return Object.keys(prices).length > 0 ? { prices, ageMs } : null;
    } catch {
      return null;
    }
  }

  private async tryTokenPricesRefresh(): Promise<void> {
    // OpenRouter's public models API is the primary feed; LiteLLM's community
    // price sheet covers an OpenRouter outage or a model it doesn't list.
    for (const [url, parse] of [
      [OPENROUTER_MODELS_URL, parseOpenRouterModels],
      [LITELLM_PRICES_URL, parseLiteLlmPrices],
    ] as const) {
      try {
        const prices = parse(await fetchJson(url));
        if (Object.keys(prices).length > 0) {
          this.tokenPrices_ = prices;
          await this.cacheTokenPrices(prices);
          return;
        }
      } catch {
        // Try the next source; keep the current prices on total failure.
      }
    }
  }

  private async cacheTokenPrices(prices: TokenPrices): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      await fs.writeFile(
        path.join(this.storageDir, TOKEN_PRICES_CACHE_FILE),
        JSON.stringify({ fetchedAt: new Date().toISOString(), prices }),
        'utf8',
      );
    } /* c8 ignore next 2 */ catch {
      // Cache write failures are silent.
    }
  }
}

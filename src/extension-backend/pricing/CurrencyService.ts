/**
 * Fetches USD-based FX rates from the Frankfurter open API and caches them
 * for 24 hours. When offline it keeps serving the last cached rates (up to 30
 * days old) and only falls back to USD-only (all rates = 1.0) without one.
 *
 * Endpoint: https://api.frankfurter.app/latest?from=USD
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import { defaultLogger, Logger } from '../util/logger';
import { fetchJson } from './httpJson';

const CACHE_FILE = 'fx-rates.json';
const API_URL = 'https://api.frankfurter.app/latest?from=USD';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Stale rates are approximate but beat showing every amount in USD. */
const MAX_STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** A full Frankfurter rates payload is well under 4 KB. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type FxRates = Record<string, number>;

interface CachePayload {
  fetchedAt: string;
  rates: FxRates;
}

/**
 * Keep only usable rates: a finite number above zero (a 0, negative or NaN rate
 * would zero out or invert every converted amount). Undefined when none survive.
 */
function sanitizeRates(raw: unknown): FxRates | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: FxRates = {};
  for (const [code, rate] of Object.entries(raw)) {
    if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) out[code] = rate;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

async function fetchRates(): Promise<FxRates> {
  const body = (await fetchJson(API_URL, { maxBytes: MAX_RESPONSE_BYTES })) as { rates?: unknown } | null;
  const rates = sanitizeRates(body?.rates);
  if (!rates) throw new Error('Unexpected Frankfurter response shape');
  // Include USD itself at 1.0 so callers never need a special case.
  return { ...rates, USD: 1 };
}

export class CurrencyService {
  private rates: FxRates = { USD: 1 };
  private refreshTimer?: ReturnType<typeof setInterval>;

  /** Invoked after a background refresh actually changes the rates, so the
   *  dashboard can recompute (the initial load never blocks on the network). */
  onRatesUpdated?: () => void;

  constructor(
    private readonly storageDir: string,
    private readonly logger: Logger = defaultLogger,
  ) {}

  /** Returns the latest cached rates (USD = 1.0, others relative to USD). */
  currentRates(): FxRates {
    return this.rates;
  }

  async load(): Promise<void> {
    // Never block activation on the network. Populate from the local cache when
    // available (USD-only default otherwise), and always refresh in the
    // background; onRatesUpdated triggers a recompute once real rates arrive.
    // Previously a cold/stale cache awaited the fetch here, which could stall
    // activation for up to ~20s (redirects × 5s timeouts) on a slow network.
    const cached = await this.loadCached();
    if (cached) this.rates = cached;
    void this.tryRefresh();
  }

  startDailyRefresh(): void {
    this.refreshTimer = setInterval(() => void this.tryRefresh(), REFRESH_INTERVAL_MS);
  }

  dispose(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  async clearCache(): Promise<void> {
    try {
      await fs.rm(path.join(this.storageDir, CACHE_FILE), { force: true });
    } /* c8 ignore next 2 */ catch {
      // Nothing cached.
    }
  }

  private async loadCached(): Promise<FxRates | null> {
    const file = path.join(this.storageDir, CACHE_FILE);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const payload = JSON.parse(raw) as CachePayload;
      const rates = sanitizeRates(payload.rates);
      if (!rates) return null;
      // Stale rates are still served (the background refresh replaces them
      // when the network is up); only a cache too old to be meaningful is dropped.
      const age = Date.now() - Date.parse(payload.fetchedAt);
      if (Number.isFinite(age) && age < MAX_STALE_MS) return { ...rates, USD: 1 };
      return null;
    } catch {
      return null;
    }
  }

  private async tryRefresh(): Promise<void> {
    try {
      const rates = await fetchRates();
      const changed = JSON.stringify(rates) !== JSON.stringify(this.rates);
      this.rates = rates;
      await this.writeCache(rates);
      if (changed) this.onRatesUpdated?.();
    } catch (err) {
      // Keep the last known rates; log so a stuck USD-only selector is diagnosable.
      this.logger.debug('currency', `FX refresh failed: ${String(err)}`);
    }
  }

  private async writeCache(rates: FxRates): Promise<void> {
    try {
      await fs.mkdir(this.storageDir, { recursive: true });
      const payload: CachePayload = { fetchedAt: new Date().toISOString(), rates };
      await fs.writeFile(path.join(this.storageDir, CACHE_FILE), JSON.stringify(payload), 'utf8');
    } /* c8 ignore next 2 */ catch {
      // Cache write failures are silent.
    }
  }
}

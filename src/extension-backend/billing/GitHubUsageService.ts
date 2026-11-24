/* c8 ignore next */
/**
 * Fetches authoritative Copilot usage data from the GitHub API.
 *
 * Two endpoints:
 *   - copilot_internal/user          → quota/plan info (no extra scope needed)
 *   - /users/{user}/settings/billing/ai_credit/usage → per-model cost breakdown
 *   - /orgs/{org}/settings/billing/ai_credit/usage   → org-level billing
 *
 * Returns Result<GitHubBillingData> — never throws. Failures are errors, not
 * empty data: a request that fails (auth, HTTP, network, size) yields an Err
 * carrying a typed {@link BillingError.kind}, unless the other endpoint still
 * produced data, in which case the partial result is returned but not cached.
 * Only a fully healthy result is cached (per scope, 5 minutes). Retries use
 * p-retry (3 attempts, exponential backoff) for network/5xx errors only.
 */
import pRetry, { AbortError } from 'p-retry';
import { err, ok, ResultAsync } from 'neverthrow';
import { z } from 'zod';
import * as vscode from 'vscode';
import type { IAuthProvider, IBillingProvider } from './IBillingProvider';
import { GitHubBillingData, GitHubBillingItem, GitHubQuota } from '../domain/types';

const CACHE_TTL = 5 * 60 * 1000;
const FETCH_TIMEOUT = 5_000;
/** Billing/quota payloads are a few KB; anything larger is not GitHub. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const GH_API = 'https://api.github.com';
const API_VERSION = '2026-03-10';

// ── Zod schemas ──────────────────────────────────────────────────────────────

const QuotaSchema = z.object({
  copilot_plan: z.string().optional(),
  quota_snapshots: z
    .object({
      premium_interactions: z
        .object({
          entitlement: z.number(),
          percent_remaining: z.number(),
          unlimited: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
  quota_reset_date: z.string().optional(),
});

/** Why a billing fetch failed; lets callers branch without parsing messages. */
export type BillingErrorKind =
  | 'not-signed-in'
  | 'auth'
  | 'http'
  | 'network'
  | 'too-large'
  | 'invalid-response';

/** An Error carrying a typed failure kind (and HTTP status when there is one). */
export class BillingError extends Error {
  readonly kind: BillingErrorKind;
  readonly status?: number;

  constructor(kind: BillingErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'BillingError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/** The typed kind of a billing error, or undefined for any other error. */
export function billingErrorKind(e: unknown): BillingErrorKind | undefined {
  return e instanceof BillingError ? e.kind : undefined;
}

const BillingItemSchema = z.object({
  model: z.string().optional(),
  sku: z.string().optional(),
  grossQuantity: z.number().optional(),
  grossAmount: z.number(),
  netAmount: z.number(),
});

// Items are validated one by one (see parseItems) so a single malformed entry
// does not discard the rest of the response.
const BillingResponseSchema = z.object({
  usageItems: z.array(z.unknown()).optional(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
  };
}

function tooLarge(url: string): BillingError {
  return new BillingError('too-large', `GitHub API response exceeds ${MAX_RESPONSE_BYTES} bytes: ${url}`);
}

/** Read a response body as text, aborting as soon as it passes the size cap. */
async function readCapped(res: Response, url: string): Promise<string> {
  if (!res.body) {
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw tooLarge(url);
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw tooLarge(url);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchJson(url: string, token: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
  } catch (e) {
    throw new BillingError('network', `GitHub API request failed: ${url} (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!res.ok) {
    await res.body?.cancel();
    const kind = res.status === 401 || res.status === 403 ? 'auth' : 'http';
    throw new BillingError(kind, `GitHub API ${res.status}: ${url}`, res.status);
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel();
    throw tooLarge(url);
  }
  const body = await readCapped(res, url);
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new BillingError('invalid-response', `GitHub API returned invalid JSON: ${url}`);
  }
}

/** Only network failures and 5xx can plausibly succeed on a repeat attempt. */
function isRetryable(e: unknown): boolean {
  if (!(e instanceof BillingError)) return false;
  return e.kind === 'network' || (e.kind === 'http' && (e.status ?? 0) >= 500);
}

function fetchWithRetry(url: string, token: string): Promise<unknown> {
  return pRetry(
    async () => {
      try {
        return await fetchJson(url, token);
      } catch (e) {
        // 4xx (bad token, missing scope, unknown org) and oversize/garbage
        // bodies are deterministic; retrying only delays the error.
        if (!isRetryable(e)) throw new AbortError(e instanceof Error ? e : new Error(String(e)));
        throw e;
      }
    },
    {
      retries: 2,
      minTimeout: 500,
      maxTimeout: 2000,
      factor: 2,
    },
  );
}

/** Normalise any rejection to a BillingError so callers always get a kind. */
function toBillingError(e: unknown): BillingError {
  if (e instanceof BillingError) return e;
  return new BillingError('network', e instanceof Error ? e.message : String(e));
}

// ── Service ──────────────────────────────────────────────────────────────────

export class GitHubUsageService implements IBillingProvider {
  readonly name = 'GitHub billing';

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  /** Cache keyed by scope URI (or 'user' for the global scope). */
  private readonly cache = new Map<string, { data: GitHubBillingData; at: number }>();
  private readonly _sub: vscode.Disposable;

  constructor(readonly session: IAuthProvider) {
    this._sub = session.onDidChange(() => {
      this.cache.clear();
      this._onDidChange.fire();
    });
  }

  /** Trigger an interactive sign-in prompt (no-op if using PAT auth). */
  async signIn(): Promise<void> {
    await this.session.getToken(true);
  }

  async needsPat(): Promise<boolean> {
    return this.session.needsPat();
  }

  /** Fetch quota + billing data. Returns cached result if fresh enough. */
  fetch(scope?: vscode.WorkspaceFolder): ResultAsync<GitHubBillingData, Error> {
    return ResultAsync.fromPromise(this._fetch(scope), (e) =>
      e instanceof Error ? e : new Error(String(e)),
    );
  }

  dispose(): void {
    this._sub.dispose();
    this._onDidChange.dispose();
  }

  private cacheKey(scope?: vscode.WorkspaceFolder): string {
    return scope ? scope.uri.toString() : 'user';
  }

  private async _fetch(scope?: vscode.WorkspaceFolder): Promise<GitHubBillingData> {
    const key = this.cacheKey(scope);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL) return cached.data;

    const auth = await this.session.getToken(false, scope);
    if (!auth) throw new BillingError('not-signed-in', 'Not signed in');

    const { token } = auth;
    const org = this.session.getOrg(scope);

    const billingUrl = org
      ? `${GH_API}/orgs/${encodeURIComponent(org)}/settings/billing/ai_credit/usage?apiVersion=${API_VERSION}`
      : auth.username
        ? `${GH_API}/users/${encodeURIComponent(auth.username)}/settings/billing/ai_credit/usage?apiVersion=${API_VERSION}`
        : null;

    const [quotaRes, billingRes] = await Promise.allSettled([
      fetchWithRetry(`${GH_API}/copilot_internal/user`, token),
      billingUrl ? fetchWithRetry(billingUrl, token) : Promise.resolve(null),
    ]);

    const failures = [quotaRes, billingRes]
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => toBillingError(r.reason));
    // Every requested endpoint failed: that is an error, not an empty result.
    // (Without a billing URL only the quota request was made.)
    const requested = billingUrl ? 2 : 1;
    if (failures.length >= requested) {
      throw failures.find((f) => f.kind === 'auth') ?? failures[0]!;
    }

    const quota = quotaRes.status === 'fulfilled' ? parseQuota(quotaRes.value) : null;
    const parsedItems = billingRes.status === 'fulfilled' && billingUrl ? parseItems(billingRes.value) : null;
    const items = parsedItems ?? [];
    const totalNetAmount = items.reduce((s, i) => s + i.netAmount, 0);

    const data: GitHubBillingData = { quota, items, fetchedAt: Date.now(), totalNetAmount };
    // Cache only a fully healthy response; a partial or malformed one is
    // returned for display but retried on the next refresh.
    const healthy = failures.length === 0 && (billingUrl === null || parsedItems !== null);
    if (healthy) this.cache.set(key, { data, at: Date.now() });
    return data;
  }
}

function parseQuota(raw: unknown): GitHubQuota | null {
  const parsed = QuotaSchema.safeParse(raw);
  if (!parsed.success) return null;
  const parsedData = parsed.data;
  const pi = parsedData.quota_snapshots?.premium_interactions;
  if (!pi) return null;
  // percent_remaining is 0-100 (e.g. 81.25), not a 0-1 fraction.
  const used = Math.round(pi.entitlement * (1 - pi.percent_remaining / 100));
  const resetDate = parsedData.quota_reset_date ? new Date(parsedData.quota_reset_date).getTime() : null;
  return {
    plan: parsedData.copilot_plan ?? 'unknown',
    entitlement: pi.entitlement,
    used,
    resetDate: Number.isFinite(resetDate) ? resetDate : null,
    unlimited: pi.unlimited ?? false,
  };
}

/** Valid billing items, or null when the response is not a billing payload at all. */
function parseItems(raw: unknown): GitHubBillingItem[] | null {
  const parsed = BillingResponseSchema.safeParse(raw);
  if (!parsed.success) return null;
  const items: GitHubBillingItem[] = [];
  for (const entry of parsed.data.usageItems ?? []) {
    const item = BillingItemSchema.safeParse(entry);
    if (!item.success) continue;
    const i = item.data;
    items.push({
      model: i.model ?? 'unknown',
      sku: i.sku ?? 'unknown',
      grossAmount: i.grossAmount,
      netAmount: i.netAmount,
      grossQuantity: i.grossQuantity ?? 0,
    });
  }
  return items;
}

// Re-export for tests
export { ok, err };

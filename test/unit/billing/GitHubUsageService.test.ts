import { strict as assert } from 'assert';
import { billingErrorKind, GitHubUsageService } from '../../../src/extension-backend/billing/GitHubUsageService';
import type { IAuthProvider } from '../../../src/extension-backend/billing/IBillingProvider';

type Listener = () => void;

function makeSession(over: Partial<IAuthProvider> = {}): IAuthProvider & { fireChange(): void } {
  const listeners: Listener[] = [];
  return {
    getToken: async () => ({ token: 'tok', username: 'octocat' }),
    getOrg: () => undefined,
    onDidChange: (l: Listener) => {
      listeners.push(l);
      return { dispose() {} };
    },
    fireChange: () => listeners.forEach((l) => l()),
    ...over,
  } as IAuthProvider & { fireChange(): void };
}

const QUOTA_RESPONSE = {
  copilot_plan: 'copilot_pro',
  quota_snapshots: {
    premium_interactions: { entitlement: 300, percent_remaining: 75, unlimited: false },
  },
  quota_reset_date: '2026-08-01',
};

const BILLING_RESPONSE = {
  usageItems: [
    { model: 'claude-sonnet-4-5', sku: 'premium', grossQuantity: 100, grossAmount: 4.0, netAmount: 3.5 },
    { grossAmount: 1.0, netAmount: 1.0 },
  ],
};

function stubFetch(routes: Record<string, unknown | number>) {
  const requests: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    const u = String(url);
    requests.push(u);
    for (const [needle, response] of Object.entries(routes)) {
      if (u.includes(needle)) {
        if (typeof response === 'number') return { ok: false, status: response } as Response;
        const body = JSON.stringify(response);
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-length': String(body.length) }),
          text: async () => body,
        } as Response;
      }
    }
    return { ok: false, status: 404 } as Response;
  }) as typeof fetch;
  return requests;
}

describe('GitHubUsageService', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('fetches quota + user billing and parses both', async () => {
    const requests = stubFetch({
      copilot_internal: QUOTA_RESPONSE,
      '/users/octocat/': BILLING_RESPONSE,
    });
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isOk());
    const data = result._unsafeUnwrap();

    // percent_remaining is 0-100: 300 × (1 − 75/100) = 75 used
    assert.equal(data.quota!.used, 75);
    assert.equal(data.quota!.entitlement, 300);
    assert.equal(data.quota!.plan, 'copilot_pro');
    assert.equal(data.quota!.unlimited, false);

    assert.equal(data.items.length, 2);
    assert.equal(data.items[0]!.model, 'claude-sonnet-4-5');
    assert.equal(data.items[1]!.model, 'unknown'); // defaults applied
    assert.ok(Math.abs(data.totalNetAmount - 4.5) < 1e-9);
    assert.ok(requests.some((u) => u.includes('/users/octocat/settings/billing/ai_credit/usage')));
    svc.dispose();
  });

  it('uses the org billing endpoint when the session resolves an org', async () => {
    const requests = stubFetch({ copilot_internal: QUOTA_RESPONSE, '/orgs/acme/': BILLING_RESPONSE });
    const svc = new GitHubUsageService(makeSession({ getOrg: () => 'acme' }));
    const result = await svc.fetch();
    assert.ok(result.isOk());
    assert.ok(requests.some((u) => u.includes('/orgs/acme/settings/billing/ai_credit/usage')));
    assert.ok(!requests.some((u) => u.includes('/users/')));
    svc.dispose();
  });

  it('errs with "Not signed in" when no token is available', async () => {
    stubFetch({});
    const svc = new GitHubUsageService(makeSession({ getToken: async () => undefined }));
    const result = await svc.fetch();
    assert.ok(result.isErr());
    assert.match(result._unsafeUnwrapErr().message, /Not signed in/);
    assert.equal(billingErrorKind(result._unsafeUnwrapErr()), 'not-signed-in');
    svc.dispose();
  });

  it('degrades gracefully when both endpoints fail (null quota, empty items)', async () => {
    // Immediate 404s → fetchJson throws → .catch(() => null) — no retry delay for 4xx?
    // p-retry retries all failures; use routes that resolve OK with junk instead
    // to keep the test fast while still exercising the parse guards.
    stubFetch({ copilot_internal: { nonsense: true }, '/users/octocat/': 'not-an-object' });
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isOk());
    const data = result._unsafeUnwrap();
    assert.equal(data.quota, null);
    assert.deepEqual(data.items, []);
    assert.equal(data.totalNetAmount, 0);
    svc.dispose();
  });

  it('caches per scope for the TTL — a second fetch makes no new requests', async () => {
    const requests = stubFetch({
      copilot_internal: QUOTA_RESPONSE,
      '/users/octocat/': BILLING_RESPONSE,
    });
    const svc = new GitHubUsageService(makeSession());
    await svc.fetch();
    const after = requests.length;
    await svc.fetch();
    assert.equal(requests.length, after, 'cached fetch must not hit the network');
    svc.dispose();
  });

  it('clears the cache and refires when the session changes', async () => {
    const requests = stubFetch({
      copilot_internal: QUOTA_RESPONSE,
      '/users/octocat/': BILLING_RESPONSE,
    });
    const session = makeSession();
    const svc = new GitHubUsageService(session);
    let changed = 0;
    svc.onDidChange(() => changed++);

    await svc.fetch();
    const before = requests.length;
    session.fireChange();
    assert.equal(changed, 1);
    await svc.fetch();
    assert.ok(requests.length > before, 'session change must invalidate the cache');
    svc.dispose();
  });

  it('signIn asks the session for an interactive token', async () => {
    let interactive: boolean | undefined;
    const svc = new GitHubUsageService(
      makeSession({
        getToken: async (createIfNone?: boolean) => {
          interactive = createIfNone;
          return { token: 't' };
        },
      }),
    );
    await svc.signIn();
    assert.equal(interactive, true);
    svc.dispose();
  });

  it('needsPat delegates to the session', async () => {
    const svc = new GitHubUsageService(makeSession({ needsPat: async () => true }));
    assert.equal(await svc.needsPat(), true);
    svc.dispose();
  });

  it('skips the billing endpoint when neither org nor username is available', async () => {
    const requests = stubFetch({ copilot_internal: QUOTA_RESPONSE });
    const svc = new GitHubUsageService(
      makeSession({ getToken: async () => ({ token: 't' }), getOrg: () => undefined }),
    );
    const result = await svc.fetch();
    assert.ok(result.isOk());
    const data = result._unsafeUnwrap();
    assert.ok(data.items.length === 0, 'no billing items when no org/username');
    assert.equal(
      requests.some((u) => u.includes('settings/billing')),
      false,
      'no billing request made',
    );
    svc.dispose();
  });
});

describe('GitHubUsageService — response size cap', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('cancels the body and errs when Content-Length exceeds the cap', async () => {
    let cancelled = 0;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': String(100 * 1024 * 1024) }),
      body: { cancel: async () => void cancelled++ },
      text: async () => { throw new Error('must not read an oversized body'); },
    })) as never;
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    // Every endpoint failed: an error, not an empty "success" cached for 5 minutes.
    assert.ok(result.isErr());
    assert.equal(billingErrorKind(result._unsafeUnwrapErr()), 'too-large');
    assert.ok(cancelled > 0, 'the unread body stream is cancelled');
  });

  it('errs on a body that exceeds the cap when no Content-Length is declared', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => 'x'.repeat(6 * 1024 * 1024),
    })) as never;
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isErr());
    assert.equal(billingErrorKind(result._unsafeUnwrapErr()), 'too-large');
  });

  it('enforces the cap while streaming: stops reading and cancels as soon as it is exceeded', async () => {
    const chunk = new Uint8Array(3 * 1024 * 1024);
    let reads = 0;
    let cancelled = 0;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: async () => { reads++; return reads <= 10 ? { done: false, value: chunk } : { done: true, value: undefined }; },
          cancel: async () => void cancelled++,
        }),
      },
      text: async () => { throw new Error('must not buffer the whole body'); },
    })) as never;
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isErr());
    assert.equal(billingErrorKind(result._unsafeUnwrapErr()), 'too-large');
    assert.ok(cancelled > 0, 'reader cancelled');
    assert.ok(reads <= 4, `stopped after the cap was crossed, not after ${reads} reads`);
  });
});

describe('GitHubUsageService — scope + sparse responses', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns empty items for a billing response without usageItems', async () => {
    stubFetch({ copilot_internal: QUOTA_RESPONSE, '/users/octocat/': {} });
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isOk());
    assert.deepEqual(result._unsafeUnwrap().items, []);
    svc.dispose();
  });

  it('caches per workspace-folder scope independently of the user scope', async () => {
    const requests = stubFetch({
      copilot_internal: QUOTA_RESPONSE,
      '/users/octocat/': BILLING_RESPONSE,
    });
    const svc = new GitHubUsageService(makeSession());
    const scope = { uri: { toString: () => 'file:///workspace-a' } } as never;
    await svc.fetch(scope);
    const afterScoped = requests.length;
    await svc.fetch(scope);
    assert.equal(requests.length, afterScoped, 'scoped fetch cached');
    await svc.fetch(); // user scope is a separate cache entry
    assert.ok(requests.length > afterScoped, 'user scope fetches independently');
    svc.dispose();
  });
});

describe('GitHubUsageService — failures are errors, never cached', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('returns an auth Err on 401/403 and does not retry 4xx', async () => {
    const requests = stubFetch({ copilot_internal: 401, '/users/octocat/': 403 });
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isErr());
    const e = result._unsafeUnwrapErr();
    assert.equal(billingErrorKind(e), 'auth');
    assert.match(e.message, /GitHub API 40[13]/);
    assert.equal(requests.length, 2, 'one attempt per endpoint — 4xx is not retried');
    svc.dispose();
  });

  it('classifies other HTTP failures as "http"', async () => {
    stubFetch({ copilot_internal: 404, '/users/octocat/': 404 });
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.equal(billingErrorKind(result._unsafeUnwrapErr()), 'http');
    svc.dispose();
  });

  it('does not cache a failure: the next fetch hits the network again and can succeed', async () => {
    stubFetch({ copilot_internal: 401, '/users/octocat/': 401 });
    const svc = new GitHubUsageService(makeSession());
    assert.ok((await svc.fetch()).isErr());
    const requests = stubFetch({ copilot_internal: QUOTA_RESPONSE, '/users/octocat/': BILLING_RESPONSE });
    const retry = await svc.fetch();
    assert.ok(retry.isOk(), 'a failure must not poison the cache');
    assert.ok(requests.length > 0);
    svc.dispose();
  });

  it('retries a network failure and then succeeds', async () => {
    let quotaCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('copilot_internal') && quotaCalls++ === 0) throw new TypeError('fetch failed');
      const body = JSON.stringify(u.includes('copilot_internal') ? QUOTA_RESPONSE : BILLING_RESPONSE);
      return { ok: true, status: 200, headers: new Headers(), text: async () => body } as Response;
    }) as typeof fetch;
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isOk());
    assert.equal(quotaCalls, 2);
    assert.equal(result._unsafeUnwrap().quota!.entitlement, 300);
    svc.dispose();
  });

  it('returns partial data when one endpoint fails, but does not cache it', async () => {
    const requests = stubFetch({ copilot_internal: 404, '/users/octocat/': BILLING_RESPONSE });
    const svc = new GitHubUsageService(makeSession());
    const first = await svc.fetch();
    assert.ok(first.isOk());
    assert.equal(first._unsafeUnwrap().quota, null);
    assert.equal(first._unsafeUnwrap().items.length, 2);
    const after = requests.length;
    await svc.fetch();
    assert.ok(requests.length > after, 'a partial result must be retried, not served from cache');
    svc.dispose();
  });

  it('keeps the valid items when one item is malformed', async () => {
    stubFetch({
      copilot_internal: QUOTA_RESPONSE,
      '/users/octocat/': {
        usageItems: [
          { model: 'a', grossAmount: 1, netAmount: 1 },
          { model: 'bad', grossAmount: 'NaN', netAmount: null },
          { model: 'c', grossAmount: 2, netAmount: 2 },
        ],
      },
    });
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isOk());
    assert.deepEqual(result._unsafeUnwrap().items.map((i) => i.model), ['a', 'c']);
    svc.dispose();
  });

  it('does not cache a malformed billing payload', async () => {
    const requests = stubFetch({ copilot_internal: QUOTA_RESPONSE, '/users/octocat/': 'not-an-object' });
    const svc = new GitHubUsageService(makeSession());
    await svc.fetch();
    const after = requests.length;
    await svc.fetch();
    assert.ok(requests.length > after, 'an invalid payload is retried on the next refresh');
    svc.dispose();
  });
});

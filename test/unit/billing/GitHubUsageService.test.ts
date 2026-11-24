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

  it('classifies a non-JSON body as "invalid-response" and does not retry it', async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      requests.push(String(url));
      const body = '<html>502 from a captive portal</html>';
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-length': String(body.length) }),
        text: async () => body,
      } as Response;
    }) as typeof fetch;
    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isErr());
    const e = result._unsafeUnwrapErr();
    assert.equal(billingErrorKind(e), 'invalid-response');
    assert.match(e.message, /invalid JSON/);
    assert.equal(requests.length, 2, 'one attempt per endpoint: a garbage body is deterministic, so not retried');
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

/** A real Response whose body arrives as separate chunks (how fetch delivers a large payload). */
function streamed(chunks: Uint8Array[], init: ResponseInit = {}): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
  });
  return new Response(body, { status: 200, ...init });
}

describe('GitHubUsageService — streamed bodies', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('reassembles a body delivered in chunks, including a multi-byte character split across two of them', async () => {
    const quota = Buffer.from(JSON.stringify({ ...QUOTA_RESPONSE, copilot_plan: 'pro€' }), 'utf8');
    const euro = quota.indexOf(Buffer.from('€', 'utf8'));
    const split = euro + 1; // between the first and second byte of the 3-byte euro sign
    const billing = Buffer.from(JSON.stringify(BILLING_RESPONSE), 'utf8');
    globalThis.fetch = (async (url: unknown) =>
      String(url).includes('copilot_internal')
        ? streamed([quota.subarray(0, split), quota.subarray(split)])
        : streamed([billing.subarray(0, 10), billing.subarray(10, 40), billing.subarray(40)])) as typeof fetch;

    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isOk());
    const data = result._unsafeUnwrap();
    assert.equal(data.quota?.plan, 'pro€', 'the split character is decoded once, from the joined bytes');
    assert.equal(data.items.length, 2);
    svc.dispose();
  });

  it('retries a 5xx (draining its body) and succeeds on the next attempt', async () => {
    let quotaCalls = 0;
    let drained = 0;
    globalThis.fetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('copilot_internal')) {
        if (quotaCalls++ === 0) {
          const failing = new Response('upstream sad', { status: 503 });
          const cancel = failing.body!.cancel.bind(failing.body);
          failing.body!.cancel = (reason?: unknown) => { drained++; return cancel(reason); };
          return failing;
        }
        return new Response(JSON.stringify(QUOTA_RESPONSE), { status: 200 });
      }
      return new Response(JSON.stringify(BILLING_RESPONSE), { status: 200 });
    }) as typeof fetch;

    const svc = new GitHubUsageService(makeSession());
    const result = await svc.fetch();
    assert.ok(result.isOk(), 'the second attempt succeeds');
    assert.equal(quotaCalls, 2);
    assert.equal(drained, 1, 'the failed response body is cancelled so the socket is released');
    svc.dispose();
  });

  it('does not retry a body that cannot be read, and reports the cause whatever was thrown', async () => {
    for (const thrown of [new TypeError('terminated'), 'socket hung up']) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => { throw thrown; },
        } as unknown as Response;
      }) as typeof fetch;
      const svc = new GitHubUsageService(makeSession());
      const result = await svc.fetch();
      assert.ok(result.isErr());
      assert.equal(billingErrorKind(result._unsafeUnwrapErr()), 'network');
      assert.match(result._unsafeUnwrapErr().message, thrown instanceof Error ? /terminated/ : /socket hung up/);
      assert.equal(calls, 2, 'one attempt per endpoint');
      svc.dispose();
    }
  });

  it('describes a non-Error rejection of fetch() itself in the network error', async () => {
    globalThis.fetch = (async () => { throw 'dns exploded'; }) as typeof fetch;
    const svc = new GitHubUsageService(makeSession({ getToken: async () => ({ token: 't' }) }));
    const result = await svc.fetch();
    assert.ok(result.isErr());
    assert.equal(billingErrorKind(result._unsafeUnwrapErr()), 'network');
    assert.match(result._unsafeUnwrapErr().message, /dns exploded/);
    svc.dispose();
  });
});

describe('GitHubUsageService — sparse quota payloads', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const quotaFor = async (quotaBody: unknown) => {
    stubFetch({ copilot_internal: quotaBody, '/users/octocat/': BILLING_RESPONSE });
    const svc = new GitHubUsageService(makeSession());
    try {
      return (await svc.fetch())._unsafeUnwrap().quota;
    } finally {
      svc.dispose();
    }
  };

  it('fills in plan, reset date and unlimited when the API leaves them out', async () => {
    const quota = await quotaFor({ quota_snapshots: { premium_interactions: { entitlement: 300, percent_remaining: 50 } } });
    assert.deepEqual(quota, { plan: 'unknown', entitlement: 300, used: 150, resetDate: null, unlimited: false });
  });

  it('treats an unparseable reset date as unknown rather than NaN', async () => {
    const quota = await quotaFor({
      copilot_plan: 'copilot_pro',
      quota_reset_date: 'next tuesday-ish',
      quota_snapshots: { premium_interactions: { entitlement: 100, percent_remaining: 100, unlimited: true } },
    });
    assert.equal(quota?.resetDate, null);
    assert.equal(quota?.unlimited, true);
    assert.equal(quota?.used, 0);
  });

  it('has no quota when the premium bucket is missing or the payload is the wrong shape', async () => {
    assert.equal(await quotaFor({ copilot_plan: 'free', quota_snapshots: {} }), null);
    assert.equal(await quotaFor({ copilot_plan: 42 }), null);
  });
});

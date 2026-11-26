import { strict as assert } from 'assert';
import { promises as fs, writeFileSync } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PricingService } from '../../src/extension-backend/pricing/PricingService';
import type { PricingManifest } from '../../src/extension-backend/domain/pricing';

/* eslint-disable @typescript-eslint/no-require-imports */
const https = require('https') as typeof import('https');

const BUNDLED: PricingManifest = {
  version: 1,
  pricePerCredit: 0.04,
  updatedAt: '2026-01-01T00:00:00Z',
  models: { 'gpt-4o': 1, 'claude-sonnet-4-5': 6 },
};

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-pricing-'));
}

/** Stub https.get to respond with canned JSON for URLs matching a route key. */
function stubHttpsGet(routes: Record<string, unknown>): () => void {
  const origGet = https.get;
  https.get = ((url: unknown, _opts: unknown, cb: (res: { statusCode: number; on(ev: string, d?: Buffer): void }) => void) => {
    const u = String(url);
    const matched = Object.entries(routes).find(([k]) => u.includes(k));
    const fakeReq = { on() { return fakeReq; }, destroy() { return fakeReq; } } as unknown as ReturnType<typeof https.get>;
    setImmediate(() => {
      if (!matched) {
        const listeners: Record<string, () => void> = {};
        // A real IncomingMessage has headers and resume(); the fetcher drains non-200 responses.
        const res = { statusCode: 404, headers: {}, resume(): void {}, on(ev: string, fn: () => void) { listeners[ev] = fn; } } as unknown as { statusCode: number; on(ev: string, d?: Buffer): void };
        cb(res);
        setImmediate(() => listeners['end']?.());
        return;
      }
      const payload = Buffer.from(JSON.stringify(matched[1]));
      const listeners: Record<string, (d?: Buffer) => void> = {};
      const res = {
        statusCode: 200,
        on(ev: string, fn: (d?: Buffer) => void) { listeners[ev] = fn; },
      } as unknown as { statusCode: number; on(ev: string, d?: Buffer): void };
      cb(res);
      setImmediate(() => {
        listeners['data']?.(payload);
        listeners['end']?.();
      });
    });
    return fakeReq;
  }) as typeof https.get;
  return () => { https.get = origGet; };
}

describe('PricingService — getters and allPrices', () => {
  it('exposes pricePerCredit and currentManifest from the bundled manifest', async () => {
    const dir = await tmpDir();
    try {
      const svc = new PricingService(dir, BUNDLED);
      assert.equal(svc.pricePerCredit, 0.04);
      assert.equal(svc.currentManifest, BUNDLED);
      assert.equal(svc.tokenPrices, undefined); // nothing loaded yet
      svc.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('allPrices maps manifest models to {modelId, multiplier}, defaulting missing to 1', async () => {
    const dir = await tmpDir();
    try {
      const svc = new PricingService(dir, {
        ...BUNDLED,
        models: { 'gpt-4o': 2, 'weird': 'oops' as unknown as number },
      });
      const out = svc.allPrices();
      assert.deepEqual(out, [
        { modelId: 'gpt-4o', multiplier: 2 },
        { modelId: 'weird', multiplier: 1 },
      ]);
      svc.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PricingService — load() with cache', () => {
  it('uses the bundled manifest when no cache exists', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsGet({ 'openrouter.ai': { data: [] }, 'raw.githubusercontent': BUNDLED });
    try {
      const svc = new PricingService(dir, BUNDLED);
      await svc.load();
      assert.equal(svc.pricePerCredit, 0.04); // bundled (cache empty; remote is non-blocking)
      assert.equal(svc.tokenPrices, undefined);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loads a fresh cached manifest and cached token prices', async () => {
    const dir = await tmpDir();
    const cachedManifest: PricingManifest = {
      ...BUNDLED,
      pricePerCredit: 0.05,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(path.join(dir, 'pricing-manifest.json'), JSON.stringify(cachedManifest));
    writeFileSync(
      path.join(dir, 'token-prices.json'),
      JSON.stringify({ fetchedAt: new Date().toISOString(), prices: { 'gpt-4o': { input: 1e-6, output: 2e-6 } } }),
    );
    try {
      const svc = new PricingService(dir, BUNDLED);
      await svc.load();
      assert.equal(svc.pricePerCredit, 0.05); // cached overrides bundled
      assert.ok(svc.tokenPrices, 'cached token prices loaded');
      svc.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores a stale cached manifest (older than 24h)', async () => {
    const dir = await tmpDir();
    const stale: PricingManifest = {
      ...BUNDLED,
      pricePerCredit: 0.99,
      updatedAt: '2020-01-01T00:00:00Z',
    };
    writeFileSync(path.join(dir, 'pricing-manifest.json'), JSON.stringify(stale));
    const restore = stubHttpsGet({}); // keep load() off the real network
    try {
      const svc = new PricingService(dir, BUNDLED);
      await svc.load();
      assert.equal(svc.pricePerCredit, 0.04); // bundled, not stale
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PricingService — remote refresh (https.get mocked)', () => {
  it('tryRemoteRefresh replaces the manifest with the fetched one', async () => {
    const dir = await tmpDir();
    const fresh: PricingManifest = {
      version: 1,
      pricePerCredit: 0.07,
      updatedAt: new Date().toISOString(),
      models: { 'gpt-4o': 3 },
    };
    const restore = stubHttpsGet({ 'raw.githubusercontent': fresh });
    try {
      const svc = new PricingService(dir, BUNDLED);
      // load() kicks off a non-blocking refresh; await it explicitly via the
      // tokenPrices getter after a microtask flush.
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(svc.pricePerCredit, 0.07); // refreshed
      // Cache file written
      const cached = JSON.parse(await fs.readFile(path.join(dir, 'pricing-manifest.json'), 'utf8'));
      assert.equal(cached.pricePerCredit, 0.07);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the bundled manifest when the remote body is not valid JSON', async () => {
    const dir = await tmpDir();
    const origGet = https.get;
    https.get = ((_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
      const fakeReq = { on() { return fakeReq; }, destroy() { return fakeReq; } } as unknown as ReturnType<typeof https.get>;
      setImmediate(() => {
        const listeners: Record<string, (d?: Buffer) => void> = {};
        const res = { statusCode: 200, on(ev: string, fn: (d?: Buffer) => void) { listeners[ev] = fn; } };
        cb(res);
        setImmediate(() => { listeners['data']?.(Buffer.from('not json{')); listeners['end']?.(); });
      });
      return fakeReq;
    }) as typeof https.get;
    try {
      const svc = new PricingService(dir, BUNDLED);
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(svc.pricePerCredit, 0.04); // parse failed → bundled retained
      svc.dispose();
    } finally {
      https.get = origGet;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tryTokenPricesRefresh prefers OpenRouter and caches the parsed prices', async () => {
    const dir = await tmpDir();
    const openRouter = {
      data: [{ id: 'anthropic/claude-sonnet-4-5', pricing: { prompt: '1e-6', completion: '2e-6' } }],
    };
    const restore = stubHttpsGet({ 'openrouter.ai': openRouter });
    try {
      const svc = new PricingService(dir, BUNDLED, ''); // empty remote URL → skip manifest refresh
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(svc.tokenPrices, 'token prices populated from OpenRouter');
      assert.deepEqual(svc.tokenPrices!['claude-sonnet-4-5'], { input: 1e-6, output: 2e-6 });
      const cached = JSON.parse(await fs.readFile(path.join(dir, 'token-prices.json'), 'utf8'));
      assert.ok(cached.prices['claude-sonnet-4-5']);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tryTokenPricesRefresh falls back to LiteLLM when OpenRouter 404s', async () => {
    const dir = await tmpDir();
    const liteLlm = {
      'claude-sonnet-4-5': { input_cost_per_token: 3e-6, output_cost_per_token: 4e-6 },
    };
    const restore = stubHttpsGet({ 'raw.githubusercontent': liteLlm, 'openrouter.ai': null });
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(svc.tokenPrices);
      assert.deepEqual(svc.tokenPrices!['claude-sonnet-4-5'], { input: 3e-6, output: 4e-6 });
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps current prices when all sources fail', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsGet({});
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(svc.tokenPrices, undefined); // no refresh succeeded
      assert.equal(svc.pricePerCredit, 0.04); // unchanged
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tryRemoteRefresh is a no-op when remoteUrl is empty', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsGet({ 'raw.githubusercontent': { ...BUNDLED, pricePerCredit: 0.99 } });
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(svc.pricePerCredit, 0.04); // unchanged — empty URL skipped
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PricingService — lifecycle and clearCache', () => {
  it('startDailyRefresh + dispose clears the timer without throwing', async () => {
    const dir = await tmpDir();
    try {
      const svc = new PricingService(dir, BUNDLED);
      assert.doesNotThrow(() => svc.startDailyRefresh());
      assert.doesNotThrow(() => svc.dispose());
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('clearCache removes both cache files (idempotent when absent)', async () => {
    const dir = await tmpDir();
    try {
      writeFileSync(path.join(dir, 'pricing-manifest.json'), '{}');
      writeFileSync(path.join(dir, 'token-prices.json'), '{}');
      const svc = new PricingService(dir, BUNDLED);
      await svc.clearCache();
      assert.rejects(fs.readFile(path.join(dir, 'pricing-manifest.json')), /ENOENT/);
      assert.rejects(fs.readFile(path.join(dir, 'token-prices.json')), /ENOENT/);
      // Second call is a no-op (no throw) when files already gone.
      await svc.clearCache();
      svc.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('tryRemoteRefresh catch swallows network failures silently', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsGet({}); // 404 for all URLs → fetchManifest rejects
    try {
      const svc = new PricingService(dir, BUNDLED, 'https://example.com/manifest.json');
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(svc.pricePerCredit, 0.04); // unchanged — catch swallowed the error
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('cacheTokenPrices catch swallows write failures silently', async () => {
    const dir = await tmpDir();
    const openRouter = { data: [{ id: 'gpt-4o', pricing: { prompt: '1e-6', completion: '2e-6' } }] };
    const restore = stubHttpsGet({ 'openrouter.ai': openRouter });
    try {
      // Make the dir read-only AFTER the PricingService is constructed so
      // the constructor's mkdir succeeds but cacheTokenPrices' mkdir/write fails.
      const svc = new PricingService(dir, BUNDLED, '');
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      // Token prices are set in memory even if the cache write fails.
      assert.ok(svc.tokenPrices, 'in-memory prices set despite cache write failure');
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a manifest cache write that fails is swallowed: the fetched manifest still applies in memory', async () => {
    const dir = await tmpDir();
    // A directory where the cache file belongs makes writeFile() fail (EISDIR), whoever runs the tests.
    await fs.mkdir(path.join(dir, 'pricing-manifest.json'));
    const fresh: PricingManifest = {
      version: 1,
      pricePerCredit: 0.09,
      updatedAt: new Date().toISOString(),
      models: { 'gpt-4o': 3 },
    };
    const restore = stubHttpsGet({ 'raw.githubusercontent': fresh });
    try {
      const svc = new PricingService(dir, BUNDLED);
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(svc.pricePerCredit, 0.09, 'the refreshed manifest is in force even though it could not be cached');
      assert.ok((await fs.stat(path.join(dir, 'pricing-manifest.json'))).isDirectory(), 'nothing replaced the blocker');
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('loadCached returns null for an invalid manifest shape', async () => {
    const dir = await tmpDir();
    writeFileSync(path.join(dir, 'pricing-manifest.json'), JSON.stringify({ version: 'not-a-number' }));
    const restore = stubHttpsGet({}); // keep load() off the real network
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      await svc.load();
      assert.equal(svc.pricePerCredit, 0.04); // bundled, cache rejected
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PricingService — setRemoteUrl (mallard.pricingManifestUrl applies live)', () => {
  const fresh = (pricePerCredit: number): PricingManifest => ({
    version: 1,
    pricePerCredit,
    updatedAt: new Date().toISOString(),
    models: { 'gpt-4o': 3 },
  });

  it('starts using a newly configured URL straight away, and stops fetching once it is cleared', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsGet({ 'custom.example': fresh(0.07), 'other.example': fresh(0.2) });
    try {
      const svc = new PricingService(dir, BUNDLED, ''); // blank at startup: no remote refresh
      await svc.load();
      assert.equal(svc.pricePerCredit, 0.04);

      svc.setRemoteUrl('https://custom.example/manifest.json');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(svc.pricePerCredit, 0.07, 'the new URL was fetched without a reload');

      svc.setRemoteUrl('');
      svc.setRemoteUrl('https://other.example/manifest.json');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(svc.pricePerCredit, 0.2, 'a later change replaces the earlier URL');

      svc.setRemoteUrl('');
      assert.equal(svc.pricePerCredit, 0.2, 'blank turns the remote refresh off and keeps the current manifest');
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PricingService — response size cap', () => {
  /** Stub https.get with a body larger than the cap; destroy(err) propagates
   *  to the request 'error' listener like a real aborted request, and a
   *  destroyed response never reaches 'end'. */
  function stubHttpsGetOversized(bytes: number): { restore(): void; destroyed(): boolean } {
    const origGet = https.get;
    let destroyed = false;
    https.get = ((_url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
      const reqListeners: Record<string, (e?: Error) => void> = {};
      const fakeReq = {
        on(ev: string, fn: (e?: Error) => void) { reqListeners[ev] = fn; return fakeReq; },
        destroy(err?: Error) { destroyed = true; setImmediate(() => reqListeners['error']?.(err)); return fakeReq; },
      } as unknown as ReturnType<typeof https.get>;
      setImmediate(() => {
        const listeners: Record<string, (d?: Buffer) => void> = {};
        const res = { statusCode: 200, on(ev: string, fn: (d?: Buffer) => void) { listeners[ev] = fn; } };
        cb(res);
        setImmediate(() => {
          listeners['data']?.(Buffer.alloc(bytes, 0x61));
          if (!destroyed) listeners['end']?.();
        });
      });
      return fakeReq;
    }) as typeof https.get;
    return { restore: () => { https.get = origGet; }, destroyed: () => destroyed };
  }

  it('destroys the request and keeps the bundled manifest when the body exceeds the cap', async () => {
    const dir = await tmpDir();
    const stub = stubHttpsGetOversized(6 * 1024 * 1024);
    try {
      const svc = new PricingService(dir, BUNDLED);
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      assert.ok(stub.destroyed(), 'oversized response must destroy the request');
      assert.equal(svc.pricePerCredit, 0.04, 'bundled manifest retained');
      svc.dispose();
    } finally {
      stub.restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

/** Stub https.get to answer every URL with `body` (raw text) and status 200. */
function stubHttpsRaw(route: (url: string) => string | null): () => void {
  const origGet = https.get;
  https.get = ((url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
    const fakeReq = { on() { return fakeReq; }, destroy() { return fakeReq; } } as unknown as ReturnType<typeof https.get>;
    setImmediate(() => {
      const body = route(String(url));
      const listeners: Record<string, (d?: Buffer) => void> = {};
      const res = {
        statusCode: body === null ? 404 : 200,
        headers: {},
        resume(): void {},
        on(ev: string, fn: (d?: Buffer) => void) { listeners[ev] = fn; return res; },
      };
      cb(res);
      setImmediate(() => {
        if (body !== null) listeners['data']?.(Buffer.from(body));
        listeners['end']?.();
      });
    });
    return fakeReq;
  }) as typeof https.get;
  return () => { https.get = origGet; };
}

const OPENROUTER_SONNET = {
  data: [{ id: 'anthropic/claude-sonnet-4-5', pricing: { prompt: '3e-6', completion: '15e-6' } }],
};

describe('PricingService — remote manifest hardening', () => {
  async function remoteLoad(manifestBody: string): Promise<{ svc: PricingService; cleanup(): Promise<void> }> {
    const dir = await tmpDir();
    const restore = stubHttpsRaw((u) => (u.includes('example.com') ? manifestBody : null));
    const svc = new PricingService(dir, BUNDLED, 'https://example.com/manifest.json', 10);
    await svc.load();
    await new Promise((r) => setTimeout(r, 100));
    return { svc, cleanup: async () => { svc.dispose(); restore(); await fs.rm(dir, { recursive: true, force: true }); } };
  }
  const base = { version: 1, pricePerCredit: 0.07, updatedAt: '2026-06-01T00:00:00Z', models: { 'gpt-4o': 3 } };

  it('accepts a well-formed newer manifest', async () => {
    const { svc, cleanup } = await remoteLoad(JSON.stringify(base));
    try { assert.equal(svc.pricePerCredit, 0.07); } finally { await cleanup(); }
  });

  for (const [name, patch] of Object.entries({
    'a negative multiplier': { models: { 'gpt-4o': -1 } },
    'a non-numeric multiplier': { models: { 'gpt-4o': '3' } },
    'a null multiplier': { models: { 'gpt-4o': null } },
    'an array of models': { models: [1, 2] },
    'a zero price per credit': { pricePerCredit: 0 },
    'an absurd price per credit': { pricePerCredit: 1000 },
    'a non-finite version': { version: 'x' },
  })) {
    it(`rejects ${name} and keeps the bundled manifest`, async () => {
      const { svc, cleanup } = await remoteLoad(JSON.stringify({ ...base, ...patch }));
      try { assert.equal(svc.pricePerCredit, 0.04); } finally { await cleanup(); }
    });
  }

  it('rejects a non-finite multiplier (JSON 1e999 parses to Infinity)', async () => {
    const { svc, cleanup } = await remoteLoad(
      '{"version":1,"pricePerCredit":0.07,"updatedAt":"2026-06-01T00:00:00Z","models":{"gpt-4o":1e999}}',
    );
    try { assert.equal(svc.pricePerCredit, 0.04); } finally { await cleanup(); }
  });

  it('does not let an older remote manifest downgrade the bundled one', async () => {
    const { svc, cleanup } = await remoteLoad(JSON.stringify({ ...base, updatedAt: '2025-01-01T00:00:00Z' }));
    try { assert.equal(svc.pricePerCredit, 0.04); } finally { await cleanup(); }
    const { svc: older, cleanup: c2 } = await remoteLoad(JSON.stringify({ ...base, version: 0 }));
    try { assert.equal(older.pricePerCredit, 0.04); } finally { await c2(); }
  });

  it('keeps the manifest content date in the cache and records the fetch time separately', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsRaw((u) => (u.includes('example.com') ? JSON.stringify(base) : null));
    try {
      const svc = new PricingService(dir, BUNDLED, 'https://example.com/manifest.json', 10);
      await svc.load();
      await new Promise((r) => setTimeout(r, 100));
      const cached = JSON.parse(await fs.readFile(path.join(dir, 'pricing-manifest.json'), 'utf8'));
      assert.equal(cached.updatedAt, '2026-06-01T00:00:00Z');
      assert.ok(Date.now() - Date.parse(cached.fetchedAt) < 10_000);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('prefers the bundled manifest over a fresh cache that is older than it', async () => {
    const dir = await tmpDir();
    // Fetched moments ago, but the content predates what this build ships.
    writeFileSync(
      path.join(dir, 'pricing-manifest.json'),
      JSON.stringify({ ...base, pricePerCredit: 0.99, updatedAt: '2025-06-01T00:00:00Z', fetchedAt: new Date().toISOString() }),
    );
    const restore = stubHttpsRaw(() => null);
    try {
      const svc = new PricingService(dir, BUNDLED, '', 10);
      await svc.load();
      assert.equal(svc.pricePerCredit, 0.04);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('uses a cached manifest that is newer than the bundled one', async () => {
    const dir = await tmpDir();
    writeFileSync(
      path.join(dir, 'pricing-manifest.json'),
      JSON.stringify({ ...base, pricePerCredit: 0.06, version: 2, fetchedAt: new Date().toISOString() }),
    );
    const restore = stubHttpsRaw(() => null);
    try {
      const svc = new PricingService(dir, BUNDLED, '', 10);
      await svc.load();
      assert.equal(svc.pricePerCredit, 0.06);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PricingService — token prices at cold start', () => {
  it('load() waits for the first token-price fetch, so the first ingest is priced', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsRaw((u) => (u.includes('openrouter.ai') ? JSON.stringify(OPENROUTER_SONNET) : null));
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      await svc.load(); // no extra wait: prices must already be there
      assert.ok(svc.tokenPrices, 'token prices available right after load()');
      assert.deepEqual(svc.tokenPrices!['claude-sonnet-4-5'], { input: 3e-6, output: 15e-6 });
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not wait past the timeout for a feed that never answers', async () => {
    const dir = await tmpDir();
    const origGet = https.get;
    https.get = (() => ({ on() { return this; }, destroy() { return this; } })) as unknown as typeof https.get;
    try {
      const svc = new PricingService(dir, BUNDLED, '', 40);
      const t0 = Date.now();
      await svc.load();
      assert.ok(Date.now() - t0 < 2_000, 'load() is bounded by the first-fetch wait');
      assert.equal(svc.tokenPrices, undefined);
      svc.dispose();
    } finally {
      https.get = origGet;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps a stale (<= 30 day) cache when the refresh fails offline', async () => {
    const dir = await tmpDir();
    writeFileSync(
      path.join(dir, 'token-prices.json'),
      JSON.stringify({
        fetchedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
        prices: { 'claude-sonnet-4-5': { input: 3e-6, output: 15e-6 } },
      }),
    );
    const restore = stubHttpsRaw(() => null);
    try {
      const svc = new PricingService(dir, BUNDLED, '', 1000);
      await svc.load();
      assert.deepEqual(svc.tokenPrices?.['claude-sonnet-4-5'], { input: 3e-6, output: 15e-6 });
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('replaces a stale cache with fresh prices when the network is up', async () => {
    const dir = await tmpDir();
    writeFileSync(
      path.join(dir, 'token-prices.json'),
      JSON.stringify({
        fetchedAt: new Date(Date.now() - 3 * 24 * 3600_000).toISOString(),
        prices: { 'claude-sonnet-4-5': { input: 9e-6, output: 9e-6 } },
      }),
    );
    const restore = stubHttpsRaw((u) => (u.includes('openrouter.ai') ? JSON.stringify(OPENROUTER_SONNET) : null));
    try {
      const svc = new PricingService(dir, BUNDLED, '', 1000);
      await svc.load();
      assert.equal(svc.tokenPrices?.['claude-sonnet-4-5']?.input, 3e-6);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('discards a cache older than 30 days and malformed cached entries', async () => {
    const dir = await tmpDir();
    writeFileSync(
      path.join(dir, 'token-prices.json'),
      JSON.stringify({ fetchedAt: new Date(Date.now() - 40 * 24 * 3600_000).toISOString(), prices: { a: { input: 1, output: 1 } } }),
    );
    const restore = stubHttpsRaw(() => null);
    try {
      const svc = new PricingService(dir, BUNDLED, '', 1000);
      await svc.load();
      assert.equal(svc.tokenPrices, undefined);
      svc.dispose();
      writeFileSync(
        path.join(dir, 'token-prices.json'),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          prices: { good: { input: 1e-6, output: 2e-6 }, bad: { input: -1, output: 1 }, worse: 'x', nan: { input: null, output: 1 } },
        }),
      );
      const svc2 = new PricingService(dir, BUNDLED, '', 1000);
      await svc2.load();
      assert.deepEqual(Object.keys(svc2.tokenPrices ?? {}), ['good']);
      svc2.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

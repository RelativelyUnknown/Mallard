import { strict as assert } from 'assert';
import { promises as fs, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
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

const SHA1_HEX = /^[0-9a-f]{40}$/;

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-pricing-version-'));
}

/** Answer https.get by URL substring with canned JSON (200) or a 404 when nothing matches. */
function stubHttpsGet(routes: Record<string, unknown>): () => void {
  const origGet = https.get;
  https.get = ((url: unknown, _opts: unknown, cb: (res: unknown) => void) => {
    const matched = Object.entries(routes).find(([k]) => String(url).includes(k));
    const fakeReq = { on() { return fakeReq; }, destroy() { return fakeReq; } } as unknown as ReturnType<typeof https.get>;
    setImmediate(() => {
      const listeners: Record<string, (d?: Buffer) => void> = {};
      const res = {
        statusCode: matched ? 200 : 404,
        headers: {},
        resume(): void {},
        on(ev: string, fn: (d?: Buffer) => void) { listeners[ev] = fn; },
      };
      cb(res);
      setImmediate(() => {
        if (matched) listeners['data']?.(Buffer.from(JSON.stringify(matched[1])));
        listeners['end']?.();
      });
    });
    return fakeReq;
  }) as typeof https.get;
  return () => { https.get = origGet; };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 100));

function writeCache(dir: string, manifest?: PricingManifest, prices?: Record<string, unknown>): void {
  if (manifest) {
    writeFileSync(path.join(dir, 'pricing-manifest.json'), JSON.stringify({ ...manifest, fetchedAt: new Date().toISOString() }));
  }
  if (prices) {
    writeFileSync(path.join(dir, 'token-prices.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), prices }));
  }
}

const FEED_PRICES = { 'claude-sonnet-4-5': { input: 3e-6, output: 15e-6 } };
const OPENROUTER = { data: [{ id: 'anthropic/claude-sonnet-4-5', pricing: { prompt: '3e-6', completion: '15e-6' } }] };

describe('PricingService.version — content hash', () => {
  it('is a sha1 hex string that two services with the same content share', () => {
    const a = new PricingService('/nonexistent', BUNDLED);
    const b = new PricingService('/nonexistent', { ...BUNDLED, models: { ...BUNDLED.models } });
    assert.match(a.version, SHA1_HEX);
    assert.equal(a.version, b.version);
    a.dispose();
    b.dispose();
  });

  it('ignores key order at every level', () => {
    const a = new PricingService('/nonexistent', { ...BUNDLED, models: { 'gpt-4o': 1, 'claude-sonnet-4-5': 6 } });
    const b = new PricingService('/nonexistent', { models: { 'claude-sonnet-4-5': 6, 'gpt-4o': 1 }, updatedAt: BUNDLED.updatedAt, pricePerCredit: 0.04, version: 1 });
    assert.equal(a.version, b.version);
    a.dispose();
    b.dispose();
  });

  it('ignores manifest metadata (version, updatedAt): it prices nothing', () => {
    const a = new PricingService('/nonexistent', BUNDLED);
    const b = new PricingService('/nonexistent', { ...BUNDLED, version: 99, updatedAt: '2030-01-01T00:00:00Z' });
    assert.equal(a.version, b.version);
    a.dispose();
    b.dispose();
  });

  it('changes when a multiplier, a model, or pricePerCredit changes', () => {
    const base = new PricingService('/nonexistent', BUNDLED).version;
    const versions = [
      { ...BUNDLED, models: { ...BUNDLED.models, 'gpt-4o': 2 } },
      { ...BUNDLED, models: { ...BUNDLED.models, 'o3-mini': 0.33 } },
      { ...BUNDLED, pricePerCredit: 0.05 },
    ].map((m) => new PricingService('/nonexistent', m).version);
    assert.equal(new Set([base, ...versions]).size, 4);
  });

  it('does not distinguish a member that is undefined from one that is absent', () => {
    const withUndefined = { ...BUNDLED, models: { ...BUNDLED.models, ghost: undefined as unknown as number } };
    assert.equal(new PricingService('/nonexistent', withUndefined).version, new PricingService('/nonexistent', BUNDLED).version);
  });

  it('changes when the per-token feed arrives, and when one of its prices changes', async () => {
    const dir = await tmpDir();
    try {
      const empty = new PricingService(dir, BUNDLED, '').version;

      writeCache(dir, undefined, FEED_PRICES);
      const loaded = new PricingService(dir, BUNDLED, '');
      await loaded.load();
      assert.notEqual(loaded.version, empty);

      writeCache(dir, undefined, { 'claude-sonnet-4-5': { input: 3e-6, output: 16e-6 } });
      const edited = new PricingService(dir, BUNDLED, '');
      await edited.load();
      assert.notEqual(edited.version, loaded.version);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PricingService.snapshot()', () => {
  it('returns the bundled inputs before any feed has loaded', () => {
    const svc = new PricingService('/nonexistent', BUNDLED);
    assert.deepEqual(svc.snapshot(), {
      manifest: BUNDLED,
      tokenPrices: undefined,
      pricePerCredit: 0.04,
      version: svc.version,
    });
    svc.dispose();
  });

  it('follows the loaded cache: manifest, token prices, price per credit and the new version', async () => {
    const dir = await tmpDir();
    const cached: PricingManifest = { ...BUNDLED, version: 2, pricePerCredit: 0.05, models: { 'gpt-4o': 3 } };
    writeCache(dir, cached, FEED_PRICES);
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      const before = svc.snapshot();
      await svc.load();
      const after = svc.snapshot();
      assert.equal(after.pricePerCredit, 0.05);
      assert.deepEqual(after.manifest.models, { 'gpt-4o': 3 });
      assert.deepEqual(after.tokenPrices, FEED_PRICES);
      assert.notEqual(after.version, before.version);
      assert.equal(after.version, svc.version);
      svc.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('PricingService.onDidChange', () => {
  it('fires once after load() when the cache changed the prices, with the new version', async () => {
    const dir = await tmpDir();
    writeCache(dir, { ...BUNDLED, pricePerCredit: 0.05 }, FEED_PRICES);
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      const seen: string[] = [];
      svc.onDidChange((v) => seen.push(v));
      await svc.load();
      assert.deepEqual(seen, [svc.version]);
      svc.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not fire when load() leaves the prices as constructed', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsGet({});
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      let fired = 0;
      svc.onDidChange(() => fired++);
      await svc.load();
      assert.equal(fired, 0);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('does not fire when a cached manifest only differs in metadata', async () => {
    const dir = await tmpDir();
    writeCache(dir, { ...BUNDLED, updatedAt: '2026-06-01T00:00:00Z' });
    const restore = stubHttpsGet({});
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      let fired = 0;
      svc.onDidChange(() => fired++);
      await svc.load();
      assert.equal(fired, 0);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fires when a remote manifest changes a multiplier, but not when it returns the same content', async () => {
    const dir = await tmpDir();
    const changed: PricingManifest = { ...BUNDLED, version: 2, updatedAt: '2026-07-01T00:00:00Z', models: { ...BUNDLED.models, 'gpt-4o': 2 } };
    const restore = stubHttpsGet({ 'example.test': changed });
    try {
      const svc = new PricingService(dir, BUNDLED, 'https://example.test/manifest.json');
      const seen: string[] = [];
      svc.onDidChange((v) => seen.push(v));
      await svc.load();
      await settle();
      assert.equal(seen.length, 1);
      assert.equal(seen[0], svc.version);

      // The same manifest again: a refresh with unchanged content stays silent.
      const refresh = (svc as unknown as { tryRemoteRefresh(): Promise<void> }).tryRemoteRefresh.bind(svc);
      await refresh();
      assert.equal(seen.length, 1);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fires when the token feed first arrives, then stays silent for an identical re-fetch', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsGet({ 'openrouter.ai': OPENROUTER });
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      const seen: string[] = [];
      svc.onDidChange((v) => seen.push(v));
      await svc.load();
      assert.equal(seen.length, 1, 'the first fetch is waited for by load() and announced once');
      assert.equal(seen[0], svc.version);

      const refresh = (svc as unknown as { tryTokenPricesRefresh(): Promise<void> }).tryTokenPricesRefresh.bind(svc);
      await refresh();
      assert.equal(seen.length, 1);
      svc.dispose();
    } finally {
      restore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('fires again when a later feed refresh changes a price', async () => {
    const dir = await tmpDir();
    const restore = stubHttpsGet({ 'openrouter.ai': OPENROUTER });
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      const seen: string[] = [];
      svc.onDidChange((v) => seen.push(v));
      await svc.load();
      restore();
      const restore2 = stubHttpsGet({
        'openrouter.ai': { data: [{ id: 'anthropic/claude-sonnet-4-5', pricing: { prompt: '3e-6', completion: '20e-6' } }] },
      });
      try {
        await (svc as unknown as { tryTokenPricesRefresh(): Promise<void> }).tryTokenPricesRefresh();
      } finally {
        restore2();
      }
      assert.equal(seen.length, 2);
      assert.notEqual(seen[0], seen[1]);
      svc.dispose();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('stops notifying after dispose()', async () => {
    const dir = await tmpDir();
    writeCache(dir, { ...BUNDLED, pricePerCredit: 0.05 });
    try {
      const svc = new PricingService(dir, BUNDLED, '');
      let fired = 0;
      svc.onDidChange(() => fired++);
      svc.dispose();
      await svc.load();
      assert.equal(fired, 0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

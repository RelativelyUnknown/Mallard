import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  COMPACT_INTERVAL_MS,
  loadBundledManifest,
  scheduleCompaction,
  wireStore,
} from '../../../src/extension-backend/wiring/wireStore';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const ws = vscode.workspace as Mutable<typeof vscode.workspace>;

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

describe('loadBundledManifest', () => {
  const orig = ws.fs;
  afterEach(() => {
    ws.fs = orig;
  });
  const context = { extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext;

  it('reads media/pricing-manifest.json from the extension', async () => {
    const read: string[] = [];
    ws.fs = {
      readFile: async (uri: vscode.Uri) => {
        read.push(uri.fsPath);
        return Buffer.from(JSON.stringify({ version: 3, pricePerCredit: 0.05, updatedAt: 'x', models: { a: 2 } }));
      },
    } as unknown as typeof ws.fs;

    const manifest = await loadBundledManifest(context);

    assert.deepEqual(read, ['/ext/media/pricing-manifest.json']);
    assert.deepEqual(manifest, { version: 3, pricePerCredit: 0.05, updatedAt: 'x', models: { a: 2 } });
  });

  it('falls back to an empty manifest when the file is missing or malformed', async () => {
    const expected = { version: 1, pricePerCredit: 0.04, updatedAt: '', models: {} };
    ws.fs = {
      readFile: async () => {
        throw new Error('ENOENT');
      },
    } as unknown as typeof ws.fs;
    assert.deepEqual(await loadBundledManifest(context), expected);

    ws.fs = { readFile: async () => Buffer.from('{ not json') } as unknown as typeof ws.fs;
    assert.deepEqual(await loadBundledManifest(context), expected);
  });
});

describe('scheduleCompaction', () => {
  it('compacts the store on every interval until disposed', async () => {
    let compactions = 0;
    const timer = scheduleCompaction({ compact: async () => void compactions++ }, 5);
    await tick(40);
    timer.dispose();
    const seen = compactions;
    assert.ok(seen >= 2, `compacted repeatedly (${seen})`);

    await tick(30);
    assert.equal(compactions, seen, 'no compaction after dispose');
  });

  it('defaults to hourly', () => {
    assert.equal(COMPACT_INTERVAL_MS, 60 * 60 * 1000);
  });
});

describe('wireStore', () => {
  it('registers only the enabled connectors, schedules compaction, and records its cleanups', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-wire-store-'));
    const started: Array<() => void> = [];
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    try {
      const wired = await wireStore(
        { context, storageDir: dir, started },
        {
          cfg: { pricingManifestUrl: '', dataRetentionDays: 90 },
          bundledManifest: { version: 1, pricePerCredit: 0.04, updatedAt: '', models: {} },
          enabledConnectors: new Set(['claude-code']),
        },
      );

      assert.deepEqual(wired.allConnectors.map((c) => c.id), ['copilot', 'claude-code']);
      assert.deepEqual(wired.activeConnectors.map((c) => c.id), ['claude-code']);
      assert.deepEqual(
        (wired.ingest as unknown as { connectors: Array<{ id: string }> }).connectors.map((c) => c.id),
        ['claude-code'],
      );
      assert.equal(context.subscriptions.length, 1, 'the compaction timer');
      assert.equal(started.length, 3, 'pricing, currency and the store each register a cleanup');
    } finally {
      for (const d of context.subscriptions) d.dispose();
      for (const cleanup of [...started].reverse()) cleanup();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('registers nothing with ingest when every connector is disabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-wire-store-'));
    const started: Array<() => void> = [];
    const context = { subscriptions: [] as Array<{ dispose(): void }> } as unknown as vscode.ExtensionContext;
    try {
      const wired = await wireStore(
        { context, storageDir: dir, started },
        {
          cfg: { pricingManifestUrl: '', dataRetentionDays: 90 },
          bundledManifest: { version: 1, pricePerCredit: 0.04, updatedAt: '', models: {} },
          enabledConnectors: new Set(),
        },
      );
      assert.deepEqual(wired.activeConnectors, []);
      assert.equal(wired.allConnectors.length, 2);
    } finally {
      for (const d of context.subscriptions) d.dispose();
      for (const cleanup of [...started].reverse()) cleanup();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

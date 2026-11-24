import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildContainer } from '../../../src/extension-backend/container';
import { AuthProvider } from '../../../src/extension-backend/export/AuthProvider';
import { SECRET_KEYS, isExportSecretKey } from '../../../src/extension-backend/app/credentials';
import { PricingService } from '../../../src/extension-backend/pricing/PricingService';
import { CurrencyService } from '../../../src/extension-backend/pricing/CurrencyService';
import { EventStore } from '../../../src/extension-backend/store/EventStore';

type SecretCb = (e: { key: string }) => void;

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-container-life-'));
}

/**
 * Delete a container's temp dir. Background work (DuckDB checkpoint, config
 * watcher) can still create a file between rm's readdir and rmdir right after
 * dispose, which surfaced as a flaky ENOTEMPTY; rm retries that case itself.
 */
function removeDir(dir: string): Promise<void> {
  return fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function makeContext(dir: string, secretCbs: SecretCb[] = []): vscode.ExtensionContext {
  return {
    subscriptions: [] as { dispose(): void }[],
    globalStorageUri: { fsPath: dir },
    extensionUri: { fsPath: dir, toString: () => `file://${dir}` },
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      onDidChange: (cb: SecretCb) => {
        secretCbs.push(cb);
        return { dispose() {} };
      },
    },
    globalState: { get: () => undefined, update: async () => {} },
  } as unknown as vscode.ExtensionContext;
}

function disposeAll(context: vscode.ExtensionContext): void {
  for (const d of [...context.subscriptions].reverse()) {
    try {
      d.dispose();
    } catch {
      /* best effort */
    }
  }
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('isExportSecretKey', () => {
  it('matches the export secrets and their per-target variants, but not the GitHub PAT', () => {
    assert.equal(isExportSecretKey(SECRET_KEYS.webhookApiKey), true);
    assert.equal(isExportSecretKey(SECRET_KEYS.webhookBearerToken), true);
    assert.equal(isExportSecretKey(SECRET_KEYS.webhookSigningSecret), true);
    assert.equal(isExportSecretKey(SECRET_KEYS.mqttPassword), true);
    assert.equal(isExportSecretKey(`${SECRET_KEYS.webhookApiKey}:team`), true);
    assert.equal(isExportSecretKey(`${SECRET_KEYS.mqttPassword}:broker2`), true);
    assert.equal(isExportSecretKey(SECRET_KEYS.githubPat), false);
    assert.equal(isExportSecretKey('someone.else.secret'), false);
  });
});

describe('buildContainer — exporter lifecycle', () => {
  const orig = { createExporter: AuthProvider.prototype.createExporter };
  afterEach(() => {
    AuthProvider.prototype.createExporter = orig.createExporter;
  });

  it('rebuilds the exporter when an export secret changes (and only then)', async () => {
    const dir = await tmpDir();
    let built = 0;
    const disposed: number[] = [];
    AuthProvider.prototype.createExporter = async function () {
      const id = ++built;
      return { export: async () => {}, dispose: () => void disposed.push(id) } as never;
    };
    const secretCbs: SecretCb[] = [];
    const context = makeContext(dir, secretCbs);
    try {
      await buildContainer(context);
      assert.equal(built, 1);
      assert.equal(secretCbs.length, 1, 'container subscribes to SecretStorage changes');

      secretCbs[0]!({ key: SECRET_KEYS.webhookApiKey });
      await tick();
      assert.equal(built, 2, 'a rotated API key rebuilds the exporter so the new key is used');
      assert.deepEqual(disposed, [1]);

      secretCbs[0]!({ key: `${SECRET_KEYS.webhookBearerToken}:team` });
      await tick();
      assert.equal(built, 3, 'per-target secrets count too');

      secretCbs[0]!({ key: SECRET_KEYS.githubPat });
      secretCbs[0]!({ key: 'unrelated.extension.key' });
      await tick();
      assert.equal(built, 3, 'unrelated secrets leave the exporter alone');
    } finally {
      disposeAll(context);
      await removeDir(dir);
    }
  });

  it('serialises overlapping rebuilds and does not leak an exporter built after shutdown', async () => {
    const dir = await tmpDir();
    let built = 0;
    const live = new Set<number>();
    AuthProvider.prototype.createExporter = async function () {
      const id = ++built;
      live.add(id);
      await tick(10);
      return { export: async () => {}, dispose: () => void live.delete(id) } as never;
    };
    const secretCbs: SecretCb[] = [];
    const context = makeContext(dir, secretCbs);
    try {
      await buildContainer(context);
      secretCbs[0]!({ key: SECRET_KEYS.mqttPassword });
      secretCbs[0]!({ key: SECRET_KEYS.webhookSigningSecret });
      disposeAll(context); // shut down while rebuilds are still building
      await tick(80);
      assert.deepEqual([...live], [], 'every exporter ever built has been disposed');
    } finally {
      await removeDir(dir);
    }
  });
});

describe('buildContainer — restriction only reconciles unfiltered snapshots', () => {
  it('a filtered compute does not engage a restriction; clearing the filter does', async () => {
    const dir = await tmpDir();
    const context = makeContext(dir);
    try {
      const c = await buildContainer(context);
      await c.usage.setFilter({ models: ['gpt-4o'] });
      await c.userConfig.set({
        rules: [{ id: 'always', severity: 'critical', message: 'stop', when: true, restrict: {} }],
      });
      await tick(100);
      assert.equal(c.restriction.getState().active, false, 'filtered snapshot must not feed restriction');

      await c.usage.setFilter({});
      await tick(100);
      assert.equal(c.restriction.getState().active, true, 'the unfiltered snapshot does');
    } finally {
      disposeAll(context);
      await removeDir(dir);
    }
  });
});

describe('buildContainer — failed startup cleans up after itself', () => {
  const orig = {
    createExporter: AuthProvider.prototype.createExporter,
    pricingDispose: PricingService.prototype.dispose,
    currencyDispose: CurrencyService.prototype.dispose,
    storeDispose: EventStore.prototype.dispose,
  };
  afterEach(() => {
    AuthProvider.prototype.createExporter = orig.createExporter;
    PricingService.prototype.dispose = orig.pricingDispose;
    CurrencyService.prototype.dispose = orig.currencyDispose;
    EventStore.prototype.dispose = orig.storeDispose;
  });

  it('disposes the refresh timers, the store and registered subscriptions when a later step throws', async () => {
    const dir = await tmpDir();
    const disposed: string[] = [];
    PricingService.prototype.dispose = function () {
      disposed.push('pricing');
      orig.pricingDispose.call(this);
    };
    CurrencyService.prototype.dispose = function () {
      disposed.push('currency');
      orig.currencyDispose.call(this);
    };
    EventStore.prototype.dispose = function () {
      disposed.push('store');
      orig.storeDispose.call(this);
    };
    AuthProvider.prototype.createExporter = async function () {
      throw new Error('exporter exploded');
    };
    const context = makeContext(dir);
    try {
      await assert.rejects(buildContainer(context), /exporter exploded/);
      assert.deepEqual([...disposed].sort(), ['currency', 'pricing', 'store']);
      assert.equal(context.subscriptions.length, 0, 'nothing left registered (e.g. the compaction interval)');
    } finally {
      await removeDir(dir);
    }
  });
});

import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { buildContainer } from '../../../src/extension-backend/container';
import { AuthProvider } from '../../../src/extension-backend/export/AuthProvider';

type ConfigChangeCb = (e: { affectsConfiguration(key: string): boolean }) => void;

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-container-'));
}

/**
 * Delete a container's temp dir. Background work (DuckDB checkpoint, config
 * watcher) can still create a file between rm's readdir and rmdir right after
 * dispose, which surfaced as a flaky ENOTEMPTY; rm retries that case itself.
 */
function removeDir(dir: string): Promise<void> {
  return fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function makeContext(dir: string): vscode.ExtensionContext {
  return {
    subscriptions: [] as { dispose(): void }[],
    globalStorageUri: { fsPath: dir },
    extensionUri: { fsPath: dir, toString: () => `file://${dir}` },
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose() {} }),
    },
    globalState: { get: () => undefined, update: async () => {} },
  } as unknown as vscode.ExtensionContext;
}

function disposeAll(context: vscode.ExtensionContext): void {
  for (const d of [...context.subscriptions].reverse()) {
    try {
      d.dispose();
    } catch {
      // dispose-order best effort in tests
    }
  }
}

describe('buildContainer', () => {
  const ws = vscode.workspace as unknown as {
    getConfiguration: unknown;
    onDidChangeConfiguration: unknown;
  };
  const orig = {
    getConfiguration: ws.getConfiguration,
    onDidChangeConfiguration: ws.onDidChangeConfiguration,
    createExporter: AuthProvider.prototype.createExporter,
  };
  afterEach(() => {
    ws.getConfiguration = orig.getConfiguration;
    ws.onDidChangeConfiguration = orig.onDidChangeConfiguration;
    AuthProvider.prototype.createExporter = orig.createExporter;
  });

  function stubSettings(values: Record<string, unknown>): void {
    ws.getConfiguration = () => ({
      get: (key: string, fallback?: unknown) => values[key] ?? fallback,
      update: () => Promise.resolve(),
    });
  }

  /** VS Code's affectsConfiguration: true for the key itself and for any section that contains it. */
  const changed = (key: string) => ({ affectsConfiguration: (k: string) => key === k || key.startsWith(`${k}.`) });

  it('registers only the connectors listed in mallard.enabledConnectors', async () => {
    const dir = await tmpDir();
    stubSettings({ enabledConnectors: ['claude-code'] });
    const context = makeContext(dir);
    try {
      const container = await buildContainer(context);
      const ids = (container.ingest as unknown as { connectors: { id: string }[] }).connectors.map(
        (c) => c.id,
      );
      assert.deepEqual(ids, ['claude-code']);
    } finally {
      disposeAll(context);
      await removeDir(dir);
    }
  });

  it('rebuilds the exporter when an export setting changes, disposing the old one', async () => {
    const dir = await tmpDir();
    const values: Record<string, unknown> = {};
    stubSettings(values);
    const changeCbs: ConfigChangeCb[] = [];
    ws.onDidChangeConfiguration = (fn: ConfigChangeCb) => {
      changeCbs.push(fn);
      return { dispose() {} };
    };

    let built = 0;
    const disposed: number[] = [];
    AuthProvider.prototype.createExporter = async function () {
      const id = ++built;
      return {
        export: async () => {},
        dispose: () => disposed.push(id),
      } as never;
    };

    const context = makeContext(dir);
    try {
      const container = await buildContainer(context);
      assert.equal(built, 1, 'activation builds the exporter once');

      values['export.transport'] = 'webhook';
      for (const cb of changeCbs) cb(changed('mallard.export.transport'));
      await new Promise((r) => setImmediate(r));
      assert.equal(built, 2, 'export config change rebuilds the exporter');
      assert.deepEqual(disposed, [1], 'the replaced exporter is disposed');

      // A fan-out target added in settings.json rebuilds it too.
      values['export.webhookTargets'] = [{ id: 'team', name: 'Team', url: 'https://t.example' }];
      for (const cb of changeCbs) cb(changed('mallard.export.webhookTargets'));
      await new Promise((r) => setImmediate(r));
      assert.equal(built, 3);

      // Unrelated settings leave the exporter alone.
      values['palette'] = 'theme';
      for (const cb of changeCbs) cb(changed('mallard.palette'));
      await new Promise((r) => setImmediate(r));
      assert.equal(built, 3);
      // Every settings event also recomputes the snapshot (a database read):
      // let those finish before the container is torn down.
      await container.usage.setFilter({});
    } finally {
      disposeAll(context);
      await removeDir(dir);
    }
  });

  it('applies a changed mallard.pricingManifestUrl to the running pricing service without a reload', async () => {
    const dir = await tmpDir();
    const values: Record<string, unknown> = {};
    stubSettings(values);
    const changeCbs: ConfigChangeCb[] = [];
    ws.onDidChangeConfiguration = (fn: ConfigChangeCb) => {
      changeCbs.push(fn);
      return { dispose() {} };
    };
    const context = makeContext(dir);
    try {
      const container = await buildContainer(context);
      const urls: string[] = [];
      container.pricing.setRemoteUrl = (url: string) => void urls.push(url);
      values['pricingManifestUrl'] = 'https://custom.example/manifest.json';
      for (const cb of changeCbs) cb(changed('mallard.pricingManifestUrl'));
      for (const cb of changeCbs) cb(changed('mallard.palette'));
      assert.deepEqual(urls, ['https://custom.example/manifest.json'], 'only the real change is applied');
      await container.usage.setFilter({}); // settle the recomputes the events triggered
    } finally {
      disposeAll(context);
      await removeDir(dir);
    }
  });
});

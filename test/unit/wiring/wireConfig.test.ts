import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigService } from '../../../src/extension-backend/app/ConfigService';
import type { ImportResult } from '../../../src/extension-backend/app/ConfigImporter';
import { LAYOUT_V1_KEY, LAYOUT_V2_KEY } from '../../../src/extension-backend/app/LayoutStore';
import { migrateV1 } from '../../../src/extension-backend/domain/layout';
import { GitHubSession } from '../../../src/extension-backend/billing/GitHubSession';
import { wireConfig } from '../../../src/extension-backend/wiring/wireConfig';
import type { GitHubBillingConfig } from '../../../src/extension-backend/domain/types';
import { makeMemento } from '../helpers';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const ws = vscode.workspace as Mutable<typeof vscode.workspace>;

describe('wireConfig', () => {
  const orig = {
    configure: GitHubSession.prototype.configure,
    getConfiguration: ws.getConfiguration,
    onDidChangeConfiguration: ws.onDidChangeConfiguration,
  };
  afterEach(() => {
    GitHubSession.prototype.configure = orig.configure;
    ws.getConfiguration = orig.getConfiguration;
    ws.onDidChangeConfiguration = orig.onDidChangeConfiguration;
  });

  type ChangeCb = (e: { affectsConfiguration(key: string): boolean }) => void;

  function setup() {
    /** What getConfiguration('mallard').get() answers, by short key. */
    const values: Record<string, unknown> = {};
    const changeCbs: ChangeCb[] = [];
    ws.getConfiguration = (() => ({ get: (k: string) => values[k], update: () => Promise.resolve() })) as unknown as typeof ws.getConfiguration;
    ws.onDidChangeConfiguration = ((fn: ChangeCb) => {
      changeCbs.push(fn);
      return { dispose() {} };
    }) as unknown as typeof ws.onDidChangeConfiguration;
    const change = (key: string) => changeCbs.forEach((cb) => cb({ affectsConfiguration: (k) => key === k || key.startsWith(`${k}.`) }));
    const v1 = [{ id: 'models', span: 3, hidden: true }];
    const globalState = makeMemento({ [LAYOUT_V1_KEY]: v1 });
    const context = {
      subscriptions: [] as Array<{ dispose(): void }>,
      secrets: { get: async () => undefined, onDidChange: () => ({ dispose() {} }) },
      globalState,
    } as unknown as vscode.ExtensionContext;
    const started: Array<() => void> = [];
    const pricingUrls: string[] = [];
    const none: ImportResult = { status: 'none', written: [], skipped: [], layoutSeeded: false, legacyRules: [], legacyGroups: [] };
    return { values, change, globalState, context, started, pricingUrls, none, v1, pricing: { setRemoteUrl: (u: string) => void pricingUrls.push(u) } };
  }

  async function tmpDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-wire-config-'));
  }

  it('delivers githubBilling to the session at startup and again only when it changes', async () => {
    const dir = await tmpDir();
    const t = setup();
    t.values['githubBilling.mode'] = 'pat';
    t.values['githubBilling.org'] = 'acme';
    const configured: Array<GitHubBillingConfig | undefined> = [];
    GitHubSession.prototype.configure = function (cfg) {
      configured.push(cfg);
      orig.configure.call(this, cfg);
    };
    try {
      const { userConfig, layout, githubSession, github, imported } = await wireConfig(
        { context: t.context, storageDir: dir, started: t.started },
        { pricing: t.pricing, importConfig: async () => t.none },
      );

      assert.ok(userConfig instanceof ConfigService, 'settings-backed, not a file store');
      assert.deepEqual(configured, [{ mode: 'pat', org: 'acme' }], 'delivered once at startup');
      assert.ok(githubSession && github);
      assert.equal(imported, t.none);
      assert.equal(t.context.subscriptions.length, 2, 'the billing and pricing-URL watchers');
      assert.equal(t.started.length, 3, 'session, config service and layout store each register a cleanup');
      assert.deepEqual(t.globalState.get(LAYOUT_V2_KEY), migrateV1(t.v1), 'the layout store is backed by the extension globalState and migrates its v1 layout');
      assert.equal(layout.get().panels.length, migrateV1(t.v1).panels.length);

      t.values['githubBilling.org'] = 'other-org';
      t.change('mallard.githubBilling.org');
      assert.deepEqual(configured.at(-1), { mode: 'pat', org: 'other-org' }, 'kept live: the org setting is read, not dead');

      const before = configured.length;
      t.values['palette'] = 'theme';
      t.change('mallard.palette');
      assert.equal(configured.length, before, 'an unrelated setting does not invalidate the billing cache');
    } finally {
      for (const d of t.context.subscriptions) d.dispose();
      for (const cleanup of [...t.started].reverse()) cleanup();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it('applies a changed pricingManifestUrl live, and only when it really changed', async () => {
    const t = setup();
    try {
      await wireConfig({ context: t.context, storageDir: '/unused', started: t.started }, { pricing: t.pricing, importConfig: async () => t.none });
      t.values['pricingManifestUrl'] = ' https://prices.example/m.json ';
      t.change('mallard.pricingManifestUrl');
      t.change('mallard.pricingManifestUrl');
      t.values['pricingManifestUrl'] = '';
      t.change('mallard.pricingManifestUrl');
      assert.deepEqual(t.pricingUrls, ['https://prices.example/m.json', '']);
    } finally {
      for (const d of t.context.subscriptions) d.dispose();
      for (const cleanup of [...t.started].reverse()) cleanup();
    }
  });

  it('runs the config.json import before the layout store reads, with the real services and storage', async () => {
    const dir = await tmpDir();
    const t = setup();
    await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ monthlyBudget: 7, dashboard: { panels: [{ id: 'models', hidden: true }] } }));
    const written: Array<[string, unknown]> = [];
    // The real importer, writing through VS Code's (stubbed) configuration.
    ws.getConfiguration = (() => ({
      get: (k: string) => t.values[k],
      update: (k: string, v: unknown) => (written.push([k, v]), Promise.resolve()),
    })) as unknown as typeof ws.getConfiguration;
    try {
      const { imported, layout } = await wireConfig({ context: t.context, storageDir: dir, started: t.started }, { pricing: t.pricing });
      assert.equal(imported.status, 'imported');
      assert.deepEqual(written, [['monthlyBudget', 7]]);
      assert.equal(layout.get().panels.find((p) => p.id === 'models')?.hidden, true, 'the seeded layout is what the store serves');
      assert.ok(await fs.stat(path.join(dir, 'config.json.migrated')));
    } finally {
      for (const d of t.context.subscriptions) d.dispose();
      for (const cleanup of [...t.started].reverse()) cleanup();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

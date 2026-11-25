import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { LAYOUT_V1_KEY, LAYOUT_V2_KEY } from '../../../src/extension-backend/app/LayoutStore';
import { migrateV1 } from '../../../src/extension-backend/domain/layout';
import { GitHubSession } from '../../../src/extension-backend/billing/GitHubSession';
import { wireConfig } from '../../../src/extension-backend/wiring/wireConfig';
import type { GitHubBillingConfig } from '../../../src/extension-backend/domain/types';
import { makeMemento } from '../helpers';

describe('wireConfig', () => {
  const origConfigure = GitHubSession.prototype.configure;
  afterEach(() => {
    GitHubSession.prototype.configure = origConfigure;
  });

  it('delivers githubBilling to the session at startup and on every config change', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-wire-config-'));
    await fs.writeFile(
      path.join(dir, 'config.json'),
      JSON.stringify({ githubBilling: { mode: 'pat', org: 'acme' } }),
      'utf8',
    );
    const configured: Array<GitHubBillingConfig | undefined> = [];
    GitHubSession.prototype.configure = function (cfg) {
      configured.push(cfg);
      origConfigure.call(this, cfg);
    };
    const v1 = [{ id: 'models', span: 3, hidden: true }];
    const globalState = makeMemento({ [LAYOUT_V1_KEY]: v1 });
    const context = {
      subscriptions: [] as Array<{ dispose(): void }>,
      secrets: { get: async () => undefined, onDidChange: () => ({ dispose() {} }) },
      globalState,
    } as unknown as vscode.ExtensionContext;
    const started: Array<() => void> = [];
    try {
      const { userConfig, layout, githubSession, github } = wireConfig({ context, storageDir: dir, started });

      assert.deepEqual(configured, [{ mode: 'pat', org: 'acme' }], 'delivered once at startup');
      assert.ok(githubSession && github);
      assert.equal(context.subscriptions.length, 1);
      assert.equal(started.length, 3, 'session, config store and layout store each register a cleanup');
      assert.deepEqual(globalState.get(LAYOUT_V2_KEY), migrateV1(v1), 'the layout store is backed by the extension globalState and migrates its v1 layout');
      assert.equal(layout.get().panels.length, migrateV1(v1).panels.length);

      await userConfig.set({ githubBilling: { mode: 'vscode-session' } });
      assert.deepEqual(configured.at(-1), { mode: 'vscode-session' }, 'kept live on config changes');
    } finally {
      for (const d of context.subscriptions) d.dispose();
      for (const cleanup of [...started].reverse()) cleanup();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

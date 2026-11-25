import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as vscode from 'vscode';
import { LAYOUT_STATE_KEY } from '../../../src/extension-backend/app/LayoutStore';
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
    const globalState = makeMemento();
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
      assert.ok(globalState.data.has(LAYOUT_STATE_KEY), 'the layout store is backed by the extension globalState');
      assert.ok(layout.get().length > 0);

      await userConfig.set({ githubBilling: { mode: 'vscode-session' } });
      assert.deepEqual(configured.at(-1), { mode: 'vscode-session' }, 'kept live on config changes');
    } finally {
      for (const d of context.subscriptions) d.dispose();
      for (const cleanup of [...started].reverse()) cleanup();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});

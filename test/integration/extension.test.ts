import * as assert from 'assert';
import * as vscode from 'vscode';
import { SETTING_ENTRIES } from '../../src/extension-backend/config/settings';
import { manifestProperties, manifestProperty } from '../unit/config/manifestProperty';

const EXT_ID = 'RelativelyUnknown.mallard';

/** What activate() returns (see MallardExports in extension.ts). */
interface MallardExports {
  status: 'ready' | 'failed';
  error?: string;
}

/**
 * Activates the extension and fails the calling test if startup itself failed.
 * A failed startup still registers recovery handlers for every command, so
 * "activate() resolved" and "the commands exist" both hold even when Mallard
 * is not actually running — the reported status is the only honest signal.
 */
async function activateOrFail(): Promise<vscode.Extension<MallardExports>> {
  const ext = vscode.extensions.getExtension<MallardExports>(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} should be installed`);
  const exports = await ext.activate();
  assert.strictEqual(ext.isActive, true);
  assert.strictEqual(exports?.status, 'ready', `Mallard failed to start: ${exports?.error ?? 'unknown error'}`);
  return ext;
}

const EXPECTED_COMMANDS = [
  'mallard.openDashboard',
  'mallard.refresh',
  'mallard.clearData',
  'mallard.showLogPath',
  'mallard.signIn',
  'mallard.exportReport',
  'mallard.exportData',
  'mallard.prepareUninstall',
  'mallard.manageCredentials',
  'mallard.configureExportTargets',
  'mallard.setMqttPassword',
  'mallard.setWebhookApiKey',
  'mallard.setWebhookBearerToken',
  'mallard.setWebhookSigningSecret',
  'mallard.setGitHubPat',
  'mallard.simulateRestriction',
  'mallard.disableExtension',
  'mallard.enableCopilotTelemetry',
  'mallard.showOnboarding',
];

describe('Mallard extension (integration)', () => {
  it('is present and activates successfully (not just without throwing)', async () => {
    await activateOrFail();
  });

  it('registers exactly the contributed mallard.* commands', async () => {
    await activateOrFail();
    const all = await vscode.commands.getCommands(true);
    for (const cmd of EXPECTED_COMMANDS) {
      assert.ok(all.includes(cmd), `command ${cmd} should be registered`);
    }
    // VS Code auto-registers per-view commands for the contributed `mallard.sidebar`
    // tree view (focus/open/removeView/resetViewLocation/toggleVisibility); those
    // are framework-generated, not part of the extension's command contract.
    const contributed = all
      .filter((c) => c.startsWith('mallard.') && !c.startsWith('mallard.sidebar.'))
      .sort();
    assert.deepStrictEqual(
      contributed,
      [...EXPECTED_COMMANDS].sort(),
      `unexpected mallard commands: ${contributed.join(', ')}`,
    );
  });

  it('opens the dashboard panel', async () => {
    await activateOrFail();
    await vscode.commands.executeCommand('mallard.openDashboard');
    const dashboardTabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter((t) => t.input instanceof vscode.TabInputWebview && t.label === 'Mallard');
    assert.strictEqual(dashboardTabs.length, 1, 'exactly one Mallard dashboard tab should be open');
  });

  it('runs refresh and leaves the extension running', async () => {
    const ext = await activateOrFail();
    await vscode.commands.executeCommand('mallard.refresh');
    assert.strictEqual(ext.isActive, true);
    assert.strictEqual(ext.exports.status, 'ready');
  });

  it('contributes exactly the settings in the table, as the table says (read back from the installed manifest)', () => {
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    // contributes.configuration is one object or an array of them.
    const props = manifestProperties(ext.packageJSON.contributes.configuration);
    assert.deepStrictEqual(Object.keys(props).sort(), SETTING_ENTRIES.map(([k]) => k).sort());
    for (const [key, def] of SETTING_ENTRIES) {
      assert.deepStrictEqual(props[key], manifestProperty(def), `${key} differs from the settings table`);
    }
  });

  it('serves each setting\'s contributed default through the real configuration API', () => {
    for (const [key, def] of SETTING_ENTRIES) {
      const inspected = vscode.workspace.getConfiguration('mallard').inspect(key.slice('mallard.'.length));
      assert.deepStrictEqual(inspected?.defaultValue, def.default, `${key} default`);
    }
  });
});

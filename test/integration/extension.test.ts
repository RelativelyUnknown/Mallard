import * as assert from 'assert';
import * as vscode from 'vscode';

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

  it('exposes only the documented settings', () => {
    const ext = vscode.extensions.getExtension(EXT_ID)!;
    const props = ext.packageJSON.contributes.configuration.properties as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(props).sort(), [
      'mallard.copilotLogPath',
      'mallard.copilotOtelPath',
      'mallard.dataRetentionDays',
      'mallard.enabledConnectors',
      'mallard.export.transport',
      'mallard.githubBilling.org',
      'mallard.mqtt.auth',
      'mallard.mqtt.url',
      'mallard.mqtt.username',
      'mallard.palette',
      'mallard.pricingManifestUrl',
      'mallard.refreshIntervalMinutes',
      'mallard.server.url',
      'mallard.shared.certificate.caFile',
      'mallard.shared.certificate.file',
      'mallard.shared.certificate.keyFile',
      'mallard.webhook.auth',
    ]);
  });
});

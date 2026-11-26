import * as vscode from 'vscode';
import { watchReloadRequiredSettings } from './util/reloadPrompt';
import { buildContainer, Container } from './container';
import {
  CREDENTIAL_SLOTS,
  SECRET_KEYS,
  exportTargetSlots,
  manageCredentials,
  promptAndStoreSecret,
} from './app/credentials';
import { defaultReportPath, generateReport } from './app/ReportGenerator';
import { configureExportTargets } from './app/exportTargets';
import { decideRestrictionPrompt, restrictionStatus } from './app/restrictionUi';
import { registerStartupFailure } from './app/startupFailure';
import { wipeAllData } from './app/uninstall';
import { DashboardPanel } from './ui/DashboardPanel';
import { SidebarView } from './ui/SidebarView';
import { formatCredits } from './domain/format';
import { severityFor } from './domain/budget';
import { runOnboardingIfNeeded, showOnboarding } from './onboarding';
import { FLAG_REMOTE_COPILOT_WARNED, getFlag, setFlag } from './app/EphemeralFlags';
import { defaultLogger } from './util/logger';
import { buildReconcileInput } from './wiring/wireRestriction';

/**
 * What the extension exposes to other extensions and to the integration
 * tests: whether it actually started. A failed start still registers recovery
 * handlers (see startupFailure.ts), so command registration alone cannot tell.
 */
export interface MallardExports {
  readonly status: 'ready' | 'failed';
  readonly error?: string;
}

export async function activate(context: vscode.ExtensionContext): Promise<MallardExports> {
  // A real Output channel, so the failure toast's "Output panel" pointer is
  // true; the shared logger mirrors info/warn/error into it.
  const output = vscode.window.createOutputChannel('Mallard');
  context.subscriptions.push(output, { dispose: defaultLogger.attachSink(output) });

  let container: import('./container').Container;
  try {
    container = await buildContainer(context);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    defaultLogger.error('activate', 'Mallard failed to start', err);
    registerStartupFailure(context, msg, output);
    return { status: 'failed', error: msg };
  }
  const { usage, restriction, ingest, userConfig } = container;

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'mallard.openDashboard';
  context.subscriptions.push(statusBar);
  const updateStatusBar = () => {
    const s = usage.current;
    const auth = s?.authStatus ?? 'signed-out';
    const r = restriction.getState();
    const now = Date.now();
    const restrictionState = restrictionStatus(r, now);
    // A snooze is checked first: the restriction stays `active` underneath it,
    // so testing `r.active` first made the override state unreachable.
    if (restrictionState === 'snoozed') {
      const m = Math.max(1, Math.round(((r.userOverrideUntil ?? now) - now) / 60_000));
      statusBar.text = `$(debug-pause) Mallard · override ${m}m`;
      statusBar.backgroundColor = undefined;
      statusBar.tooltip = r.reasonMessage
        ? `Restriction snoozed: ${r.reasonMessage}`
        : 'Restriction rule is being overridden.';
      statusBar.show();
    } else if (restrictionState === 'limit') {
      statusBar.text = `$(shield) Usage limit reached`;
      statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      statusBar.tooltip = r.reasonMessage;
      statusBar.show();
    } else if (s) {
      const cr = formatCredits(s.today.credits);
      const severity = severityFor(s.budget);
      statusBar.backgroundColor =
        severity === 'error'   ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : severity === 'warning' ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
      // eslint-disable-next-line security/detect-possible-timing-attacks -- auth is an AuthStatus enum, not a secret
      if (auth === 'signed-in') {
        const plan = s.githubBilling?.quota?.plan ?? 'GitHub';
        statusBar.text = `$(verified-filled) ${plan} · ${cr} cr`;
      } else {
        statusBar.text = `$(graph) ${cr} cr today`;
      }
      const mtdCr = formatCredits(s.budget.usedCredits);
      statusBar.tooltip = new vscode.MarkdownString(`**Today:** ${cr} cr\n\n**MTD:** ${mtdCr} cr`);
      statusBar.show();
    } else {
      // No snapshot yet — show sign-in prompt (auth is 'signed-out' when s is undefined)
      statusBar.text = '$(account) Sign in to GitHub';
      statusBar.backgroundColor = undefined;
      statusBar.tooltip = 'Click to sign in to GitHub for billing verification';
      statusBar.show();
    }
  };
  updateStatusBar();
  context.subscriptions.push(usage.onDidChangeSnapshot(updateStatusBar));
  context.subscriptions.push(restriction.onDidChange(updateStatusBar));

  // The popup opens once per restriction (on the transition to active, or when
  // its reason changes), never while snoozed, and again once a snooze ends.
  // Snoozing itself fires a change event with the restriction still active, so
  // keying only on `state.active` re-opened the popup the instant it was snoozed.
  let promptedFor: string | undefined;
  context.subscriptions.push(
    restriction.onDidChange(async (state) => {
      const decision = decideRestrictionPrompt(state, promptedFor, Date.now());
      promptedFor = decision.shownKey;
      if (!decision.show) return;
      const cfg = userConfig.get();
      const rule = cfg.flatRules?.find((r) => r.id === state.ruleId);
      if (!rule?.restrict) return;
      const msg = state.reasonMessage || 'Copilot usage limit reached.';
      try {
        const choice = await vscode.window.showWarningMessage(
          `Mallard · ${msg}`, 'Dismiss', 'Snooze 15m', 'Snooze 1h', 'Disable Mallard…',
        );
        if (choice === 'Snooze 15m') await restriction.snooze(15);
        if (choice === 'Snooze 1h') await restriction.snooze(60);
        if (choice === 'Disable Mallard…') {
          await vscode.commands.executeCommand('mallard.disableExtension');
        }
      } catch (err) {
        defaultLogger.error('restriction', 'restriction popup failed', err);
      }
    }),
  );

  registerCommands(context, container);
  const sidebar = new SidebarView(context, usage);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarView.viewType, sidebar),
    { dispose: () => sidebar.dispose() },
  );

  // Settings only read at activation (connector registry, store retention) get
  // a "Reload Window" prompt — changing them was a silent no-op before. Every
  // other `mallard.*` change reaches the services through `userConfig.onDidChange`.
  context.subscriptions.push(watchReloadRequiredSettings(userConfig.onDidChange));

  await usage.start();
  // Runs before setupGate.start() so onboarding gets first crack at asking
  // about Copilot OTel setup — it suppresses the gate's own automatic nudge
  // for the same requirement so the two mechanisms don't both prompt.
  await runOnboardingIfNeeded(context, container.setupGate);
  container.setupGate.start();

  if (vscode.env.remoteName && !getFlag(context.globalState, FLAG_REMOTE_COPILOT_WARNED)) {
    const d = usage.onDidChangeSnapshot(() => {
      d.dispose();
      if (ingest.getConnectorLogPaths('copilot').length === 0) {
        void vscode.window.showWarningMessage(
          'Mallard: Running in a remote session. GitHub Copilot usage logs are on your local ' +
          'machine and cannot be read here. Claude Code usage is tracked normally. ' +
          'See the Mallard docs for details.',
          'Learn more',
          "Don't show again",
        ).then(async (choice) => {
          if (choice === 'Learn more') {
            await vscode.env.openExternal(
              vscode.Uri.parse('https://relativelyunknown.github.io/Mallard/guide/troubleshooting#remote-ssh'),
            );
          }
          if (choice === "Don't show again") {
            await setFlag(context.globalState, FLAG_REMOTE_COPILOT_WARNED);
          }
        });
      }
    });
    context.subscriptions.push(d);
  }
  return { status: 'ready' };
}

export function deactivate(): void {
  // Nothing to do: context.subscriptions (disposed by VS Code before this
  // runs) already close the DuckDB connection and stop all timers/watchers.
  // The database and globalState deliberately survive shutdown so usage
  // history outlives the source logs; the "Prepare for Uninstall" command is
  // the one and only full-wipe path.
}

function registerCommands(context: vscode.ExtensionContext, c: Container): void {
  const { usage, store, userConfig, alerts, layout, pricing, restriction, setupGate } = c;
  const reg = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  reg('mallard.enableCopilotTelemetry', async () => {
    await setupGate.run('copilot-otel');
  });

  reg('mallard.showOnboarding', async () => {
    await showOnboarding(context, setupGate);
  });

  reg('mallard.openDashboard', () => {
    try {
      DashboardPanel.show(context, usage, userConfig, layout, restriction);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void vscode.window.showErrorMessage(`Mallard: Could not open dashboard — ${msg}`);
    }
  });

  reg('mallard.refresh', async () => {
    await usage.refresh();
  });

  // Renamed from "Clear All Data": that framing was misleading since it
  // immediately re-ingested afterward, and it duplicated the full wipe
  // mallard.prepareUninstall already does (which correctly does NOT
  // re-ingest, since it's meant to leave nothing behind before uninstall).
  // This command now only rebuilds the ingested-data tables, leaving user
  // settings/layout/pricing cache/restrictions untouched.
  reg('mallard.clearData', async () => {
    const ok = await vscode.window.showWarningMessage(
      'Rebuild ingested data? This wipes recorded usage and re-parses every ' +
        'connector log from scratch. Your budget/alert settings, dashboard ' +
        'layout, and pricing cache are left untouched. Use this if the ' +
        'ingested data looks wrong and you want a clean re-read of the logs.',
      { modal: true },
      'Rebuild',
    );
    if (ok === 'Rebuild') {
      await store.clear();
      await usage.refresh();
    }
  });

  reg('mallard.signIn', async () => {
    await usage.signInGitHub();
  });

  reg('mallard.exportReport', async () => {
    const snapshot = usage.current;
    if (!snapshot) {
      void vscode.window.showWarningMessage('Mallard: No data available to export.');
      return;
    }
    const defaultUri = vscode.Uri.file(defaultReportPath());
    const saveUri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'HTML Report': ['html'] },
      title: 'Save Mallard Usage Report',
    });
    if (!saveUri) return;
    const html = generateReport(snapshot);
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html, 'utf8'));
    const open = await vscode.window.showInformationMessage(
      `Report saved to ${saveUri.fsPath}`,
      'Open in Browser',
    );
    if (open === 'Open in Browser') {
      await vscode.env.openExternal(saveUri);
    }
  });

  reg('mallard.showLogPath', async () => {
    const paths = usage.getLogPaths();
    if (paths.length > 0) {
      void vscode.window.showInformationMessage(
        `Mallard: Watching ${paths.length} log file(s): ${paths.join(', ')}`,
      );
      return;
    }
    const searched = usage.getSearchedDirs();
    const known = usage.getKnownDirs();
    const tried = searched.length > 0 ? searched : known;
    const detail =
      tried.length > 0 ? `\n\nSearched:\n${tried.map((p) => '  ' + p).join('\n')}` : '';
    const pick = await vscode.window.showInformationMessage(
      'Mallard: No Copilot or Claude Code log files detected. Make sure one of them is installed ' +
        'and has been used. Copilot usage is read from its OpenTelemetry export: enable it with ' +
        '"Mallard: Enable Copilot Usage Tracking", or point the mallard.copilotOtelPath setting at ' +
        'the export file.' +
        detail,
      'Enable Copilot tracking',
    );
    if (pick) await vscode.commands.executeCommand('mallard.enableCopilotTelemetry');
  });

  // One channel for every simulation run (created lazily): creating a fresh
  // channel per invocation leaked an entry in the Output dropdown each time.
  let simulationChannel: vscode.OutputChannel | undefined;
  context.subscriptions.push({ dispose: () => simulationChannel?.dispose() });

  reg('mallard.simulateRestriction', async () => {
    // The same input the live reconcile gets: the latest UNFILTERED snapshot (a
    // dashboard filter would simulate a slice of the data) and the alert history.
    const report = await restriction.simulate(
      buildReconcileInput(usage.currentUnfiltered ?? null, userConfig.get(), alerts.getHistory()),
    );
    simulationChannel ??= vscode.window.createOutputChannel('Mallard Restriction');
    simulationChannel.clear();
    simulationChannel.appendLine(JSON.stringify(report, null, 2));
    simulationChannel.show(true);
  });

  reg('mallard.exportData', async () => {
    const saveUri = await vscode.window.showSaveDialog({
      filters: { CSV: ['csv'], JSON: ['json'] },
      title: 'Export Mallard Usage Data',
    });
    if (!saveUri) return;
    const ext = saveUri.fsPath.split('.').pop()?.toLowerCase();
    const format = ext === 'json' ? 'json' : 'csv';
    await store.reader.exportTo(saveUri.fsPath, format as 'csv' | 'json');
    void vscode.window.showInformationMessage(`Mallard: Data exported to ${saveUri.fsPath}`);
  });

  reg('mallard.prepareUninstall', async () => {
    const ok = await vscode.window.showWarningMessage(
      'This will delete all Mallard data (events, settings, cached pricing). This cannot be undone.',
      { modal: true },
      'Delete everything',
    );
    if (ok !== 'Delete everything') return;
    await wipeAllData({
      storageDir: context.globalStorageUri.fsPath,
      secrets: context.secrets,
      globalState: context.globalState,
      store,
      userConfig,
      layout,
      pricing,
      restriction,
    });
    void vscode.window.showInformationMessage(
      'All Mallard data cleared. You can now uninstall via the Extensions view.',
    );
  });

  reg('mallard.disableExtension', async () => {
    const ok = await vscode.window.showWarningMessage(
      'Disable Mallard? It stops running until you re-enable it from the Extensions view. ' +
        'Your local data is kept.',
      { modal: true },
      'Continue',
    );
    if (ok !== 'Continue') return;
    await vscode.commands.executeCommand('workbench.extensions.search', '@id:RelativelyUnknown.mallard');
    void vscode.window.showInformationMessage('Mallard: Click "Disable" next to Mallard above.');
  });

  const slotByKey = (key: string) => CREDENTIAL_SLOTS.find((s) => s.key === key)!;
  reg('mallard.manageCredentials', () =>
    manageCredentials(context.secrets, exportTargetSlots(userConfig.get().export)));
  reg('mallard.configureExportTargets', () =>
    configureExportTargets(context.secrets, userConfig));
  reg('mallard.setMqttPassword', () =>
    promptAndStoreSecret(context.secrets, slotByKey(SECRET_KEYS.mqttPassword)));
  reg('mallard.setWebhookApiKey', () =>
    promptAndStoreSecret(context.secrets, slotByKey(SECRET_KEYS.webhookApiKey)));
  reg('mallard.setWebhookBearerToken', () =>
    promptAndStoreSecret(context.secrets, slotByKey(SECRET_KEYS.webhookBearerToken)));
  reg('mallard.setWebhookSigningSecret', () =>
    promptAndStoreSecret(context.secrets, slotByKey(SECRET_KEYS.webhookSigningSecret)));
  reg('mallard.setGitHubPat', () =>
    promptAndStoreSecret(context.secrets, slotByKey(SECRET_KEYS.githubPat)));
}

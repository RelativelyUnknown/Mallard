/**
 * Shared wiring between a webview and the dashboard data + message protocol.
 * Used by both the activity-bar view and the pop-out panel so they behave
 * identically. Returns the disposables the host should clean up.
 */
import * as vscode from 'vscode';
import { UsageService } from '../app/UsageService';
import { IConfigService, watchValue } from '../app/ConfigService';
import { LayoutStore } from '../app/LayoutStore';
import { RestrictionEngine } from '../app/RestrictionEngine';
import { readConfig } from '../config';
import { defaultLogger } from '../util/logger';
import { isHostBoundMsg, parseFilter, ThemeKind, WebviewBoundMsg } from './messaging';

export interface DashboardDeps {
  usage: UsageService;
  userConfig: IConfigService;
  layout: LayoutStore;
  restriction: RestrictionEngine;
}

function themeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'high-contrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast-light';
    default:
      return 'dark';
  }
}

/** The theme message carries the active theme kind and the palette setting —
 *  the two inputs the webview needs to derive an accessible accent. */
function themeMsg(): WebviewBoundMsg {
  return { type: 'theme', kind: themeKind(), palette: readConfig().palette };
}

export function bindDashboard(webview: vscode.Webview, deps: DashboardDeps): vscode.Disposable[] {
  const { usage, userConfig, layout, restriction } = deps;
  const post = (m: WebviewBoundMsg) => void webview.postMessage(m);

  const onMessage = async (raw: unknown): Promise<void> => {
    if (!isHostBoundMsg(raw)) return;
    switch (raw.type) {
      case 'ready': {
        const s = usage.current;
        if (s) post({ type: 'snapshot', payload: s });
        post({ type: 'config', value: userConfig.get() });
        post({ type: 'layout', value: layout.get() });
        post({ type: 'restriction', value: restriction.getState() });
        post(themeMsg());
        break;
      }
      case 'refresh':
        await usage.refresh();
        break;
      case 'setFilter': {
        // Rebuilt from the validated shape instead of trusting a cast.
        const filter = parseFilter(raw.value);
        if (filter) await usage.setFilter(filter);
        break;
      }
      case 'setLayout':
        await layout.set(raw.value);
        break;
      case 'openConfig':
        // Mallard's settings are ordinary VS Code settings: open the Settings UI on the alert ones (the rules are `mallard.alerts.rules`).
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:RelativelyUnknown.mallard alerts');
        break;
      case 'command':
        if (raw.id === 'openDashboard') void vscode.commands.executeCommand('mallard.openDashboard');
        else if (raw.id === 'signIn') void usage.signInGitHub();
        else if (raw.id === 'disableExtension') {
          void vscode.commands.executeCommand('mallard.disableExtension');
        } else if (raw.id === 'enableCopilotTelemetry') {
          void vscode.commands.executeCommand('mallard.enableCopilotTelemetry');
        } else if (raw.id === 'setGitHubPat') {
          void vscode.commands.executeCommand('mallard.setGitHubPat');
        }
        break;
      case 'restrictSnooze':
        await restriction.snooze(raw.minutes);
        break;
      case 'setCurrency':
        // Writes `mallard.currency` (validated and upper-cased there); the
        // resulting settings change recomputes the snapshot through the one
        // config event.
        await userConfig.update({ currency: raw.value });
        break;
    }
  };

  return [
    // A handler that throws (a failing store write, a refresh error…) must be
    // logged, not left as an unhandled rejection that vanishes silently.
    webview.onDidReceiveMessage((m) => {
      onMessage(m).catch((err: unknown) => defaultLogger.error('dashboard', 'message handler failed', err));
    }),
    // The event carries host-side SnapshotData; the wire payload is the
    // composed (and cached) full snapshot with chart data.
    usage.onDidChangeSnapshot(() => {
      const s = usage.current;
      if (s) post({ type: 'snapshot', payload: s });
    }),
    userConfig.onDidChange(() => post({ type: 'config', value: userConfig.get() })),
    layout.onDidChange((value) => post({ type: 'layout', value })),
    restriction.onDidChange((value) => post({ type: 'restriction', value })),
    vscode.window.onDidChangeActiveColorTheme(() => post(themeMsg())),
    watchValue(userConfig.onDidChange, () => readConfig().palette, () => post(themeMsg())),
  ];
}

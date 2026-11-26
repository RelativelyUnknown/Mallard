/**
 * What the extension offers when buildContainer() throws. A silent return
 * leaves every contributed command "not found" and the sidebar blank, with no
 * way out. Instead each contributed command reports the startup error with a
 * way to see the log or reset the local database (the usual culprit is a
 * corrupt or locked events.duckdb), and the sidebar explains itself.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SidebarView } from '../ui/SidebarView';
import { defaultLogger } from '../util/logger';

/** The DuckDB database file and its write-ahead log. */
const DATABASE_FILES = ['events.duckdb', 'events.duckdb.wal'];

const SHOW_OUTPUT = 'Show Output';
const RESET_DATA = 'Reset Mallard Data…';
const CONFIRM_RESET = 'Delete and reload';

/** Delete the local usage database so the next start rebuilds it from the logs. Returns the files removed. */
export async function deleteDatabaseFiles(storageDir: string): Promise<string[]> {
  const removed: string[] = [];
  for (const name of DATABASE_FILES) {
    try {
      await fs.unlink(path.join(storageDir, name));
      removed.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        defaultLogger.warn('startup', `could not delete ${name}`, err);
      }
    }
  }
  return removed;
}

/** Every command id the extension contributes, read from its own package.json. */
export function contributedCommandIds(context: vscode.ExtensionContext): string[] {
  const contributes = (context.extension?.packageJSON as { contributes?: { commands?: Array<{ command: string }> } } | undefined)
    ?.contributes;
  return (contributes?.commands ?? []).map((c) => c.command);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function failedSidebarHtml(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"/>
  <style>body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 12px; }</style>
</head>
<body>
  <h3>Mallard failed to start</h3>
  <p>${escapeHtml(message)}</p>
  <p>See the &ldquo;Mallard&rdquo; Output panel for details. If the local database is corrupt, run
  &ldquo;Mallard: Rebuild Ingested Data&rdquo; from the Command Palette to reset it.</p>
</body>
</html>`;
}

class FailedSidebarView implements vscode.WebviewViewProvider {
  constructor(private readonly message: string) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: false };
    view.webview.html = failedSidebarHtml(this.message);
  }
}

/**
 * Register a handler for every contributed command, a placeholder sidebar, and
 * show the startup error once. Everything registered lands on
 * `context.subscriptions`.
 */
export function registerStartupFailure(
  context: vscode.ExtensionContext,
  message: string,
  output: { show(): void },
): void {
  const storageDir = context.globalStorageUri.fsPath;

  const reset = async (): Promise<void> => {
    const ok = await vscode.window.showWarningMessage(
      'Delete Mallard\'s local usage database (events.duckdb)? Your settings and config.json are kept; ' +
        'usage is re-read from the connector logs after the window reloads.',
      { modal: true },
      CONFIRM_RESET,
    );
    if (ok !== CONFIRM_RESET) return;
    const removed = await deleteDatabaseFiles(storageDir);
    defaultLogger.info('startup', `deleted ${removed.join(', ') || 'nothing'} from ${storageDir}`);
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };

  const report = async (): Promise<void> => {
    const choice = await vscode.window.showErrorMessage(
      `Mallard failed to start: ${message}. See the Mallard Output panel for details.`,
      SHOW_OUTPUT,
      RESET_DATA,
    );
    if (choice === SHOW_OUTPUT) output.show();
    else if (choice === RESET_DATA) await reset();
  };

  for (const id of contributedCommandIds(context)) {
    // clearData IS the recovery action; every other command explains the failure.
    const handler = id === 'mallard.clearData' ? reset : report;
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarView.viewType, new FailedSidebarView(message)),
  );
  void report();
}

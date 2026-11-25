/**
 * Some settings are only read at activation (the connector registry and the
 * event store are built once in the container). Changing them used to be a
 * silent no-op until the next manual reload — surface that instead of leaving
 * the user wondering why nothing happened.
 */
import * as vscode from 'vscode';
import { watchValue } from '../app/ConfigService';
import { readSettingValues } from '../config';
import { RELOAD_REQUIRED_KEYS } from '../config/settings';

/** Offer a window reload; applies immediately if the user accepts. */
export async function promptReloadWindow(reason: string): Promise<void> {
  const reload = 'Reload Window';
  const choice = await vscode.window.showInformationMessage(
    `${reason} Reload the window to apply.`,
    reload,
  );
  if (choice === reload) {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * Prompt for a reload whenever the value of an activation-time setting (the
 * table's `reload` entries) changes. Driven by the one configuration event.
 */
export function watchReloadRequiredSettings(
  onDidChange: vscode.Event<void>,
  read: () => unknown = () => {
    const values = readSettingValues();
    return RELOAD_REQUIRED_KEYS.map((key) => values[key]);
  },
): vscode.Disposable {
  return watchValue(onDidChange, read, () =>
    void promptReloadWindow('A Mallard setting that applies at startup changed.'),
  );
}

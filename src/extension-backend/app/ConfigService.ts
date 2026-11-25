/**
 * Contract for the settings-backed configuration service. TYPE ONLY: the real
 * class is built by stream B (config on VS Code settings), which replaces
 * `UserConfigStore`. `get()` keeps returning the existing `UserConfig` shape so
 * `UsageService`, `chartData` and the alert code stay unchanged.
 */
import type * as vscode from 'vscode';
import type { UserConfig } from '../domain/types';

export interface IConfigService {
  /** The current, validated configuration. */
  get(): UserConfig;
  /** Fires after any change to the configuration, wherever it was made (settings UI, settings.json, sync). */
  onDidChange: vscode.Event<void>;
  /** Persist a partial update through the settings API. */
  update(patch: Partial<UserConfig>): Promise<void>;
}

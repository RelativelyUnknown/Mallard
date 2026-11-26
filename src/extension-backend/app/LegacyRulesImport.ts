/**
 * One-time conversion of the alert rules of a pre-settings `config.json` (the
 * old JSON rules language) into flat rules in `mallard.alerts.rules`.
 *
 * `importLegacyConfig` hands the old `rules`/`groups` back untouched in its
 * `ImportResult` (and renames the file to `config.json.migrated`); this runs
 * right after it at activation:
 *
 *   - `convertLegacyRules` turns what a single comparison can say into flat
 *     rules and reports, with a reason, every rule it cannot convert; each one
 *     is logged;
 *   - the converted rules are checked against the flat-rule schema, then
 *     APPENDED to the rules already in the setting (a rule whose id is already
 *     there is left alone, so a repeat never duplicates anything);
 *   - ONE information message says how many were converted and how many were
 *     not. Nothing is shown when nothing was left to convert.
 *
 * Idempotent: once the import renamed `config.json`, later activations get an
 * empty `ImportResult`, so this has nothing to do.
 */
import * as path from 'path';
import * as vscode from 'vscode';
import type { FlatAlertRule } from '../domain/contracts';
import { convertLegacyRules } from '../domain/flatAlertImport';
import { parseFlatRules } from '../domain/flatAlerts';
import type { Logger } from '../util/logger';
import type { ImportResult } from './ConfigImporter';
import type { IConfigService } from './ConfigService';

export interface LegacyRulesUi {
  /** The one summary message. */
  info(message: string): void;
}

export const vscodeLegacyRulesUi: LegacyRulesUi = {
  info: (message) => {
    void Promise.resolve(vscode.window.showInformationMessage(message, 'Open Settings')).then((choice) => {
      if (choice) return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:RelativelyUnknown.mallard alerts');
      return undefined;
    });
  },
};

export interface LegacyRulesImportDeps {
  imported: Pick<ImportResult, 'legacyRules' | 'legacyGroups' | 'backup'> | undefined;
  config: Pick<IConfigService, 'get' | 'update'>;
  ui: LegacyRulesUi;
  logger: Logger;
  /** The clock (default `Date.now`): a `snoozeUntil` that has passed no longer blocks a conversion. */
  now?: () => number;
}

export interface LegacyRulesImportResult {
  /** Flat rules appended to the setting. */
  added: FlatAlertRule[];
  /** Legacy rules (or converted levels) that could not be converted, with the reason. */
  skipped: Array<{ id: string; reason: string }>;
}

const rules = (n: number): string => `${n} alert rule${n === 1 ? '' : 's'}`;

export async function importLegacyAlertRules(deps: LegacyRulesImportDeps): Promise<LegacyRulesImportResult> {
  const { imported, config, ui, logger } = deps;
  const result: LegacyRulesImportResult = { added: [], skipped: [] };
  if (!imported || imported.legacyRules.length === 0) return result;

  const { converted, skipped } = convertLegacyRules(imported.legacyRules, imported.legacyGroups, { now: (deps.now ?? Date.now)() });
  result.skipped.push(...skipped);
  // The converter does not check what the setting will: metric, cooldown, severity, flags.
  const checked = parseFlatRules(converted);
  for (const error of checked.errors) result.skipped.push({ id: error.id ?? '(no id)', reason: error.message });
  for (const { id, reason } of result.skipped) logger.warn('alerts', `legacy alert rule "${id}" was not converted: ${reason}`);

  const existing = config.get().flatRules ?? [];
  const known = new Set(existing.map((rule) => rule.id));
  result.added = checked.rules.filter((rule) => !known.has(rule.id));

  const backup = imported.backup ? path.basename(imported.backup) : 'config.json.migrated';
  if (result.added.length > 0) {
    try {
      await config.update({ flatRules: [...existing, ...result.added] });
    } catch (err) {
      logger.error('alerts', 'could not save the converted alert rules to settings', err);
      ui.info(`Could not save the converted alert rules to settings (see the Mallard output). The original is kept in ${backup}.`);
      return { added: [], skipped: result.skipped };
    }
  }
  if (result.added.length > 0 || result.skipped.length > 0) {
    const skippedNote =
      result.skipped.length > 0
        ? `; ${result.skipped.length} could not be converted (reasons are in the output channel; the original is kept in ${backup})`
        : ` (the original is kept in ${backup})`;
    ui.info(`Converted ${rules(result.added.length)} to the new format${skippedNote}.`);
  }
  return result;
}

/**
 * Wires alert firing: the {@link AlertService} that `UsageService` hands every
 * unfiltered snapshot to. It is created before the usage service so it can be
 * injected; `UsageService.dispose()` disposes it again (a repeat is harmless).
 *
 * Its cooldowns live in globalState, and the alert rules of a pre-settings
 * `config.json` (the old rules language) are converted into flat rules here,
 * before the first snapshot is evaluated (see `importLegacyAlertRules`).
 */
import { AlertService } from '../app/AlertService';
import type { IConfigService } from '../app/ConfigService';
import type { ImportResult } from '../app/ConfigImporter';
import { importLegacyAlertRules, vscodeLegacyRulesUi } from '../app/LegacyRulesImport';
import type { LegacyRulesUi } from '../app/LegacyRulesImport';
import { defaultLogger, Logger } from '../util/logger';
import { defaultVscodeHost, VscodeHost } from '../util/vscodeHost';
import type { WiringScope } from './scope';

export interface AlertWiring {
  alerts: AlertService;
}

export interface AlertWiringDeps {
  userConfig: Pick<IConfigService, 'get' | 'update'>;
  /** What the one-time `config.json` import found (default: nothing, so no conversion runs). */
  imported?: Pick<ImportResult, 'legacyRules' | 'legacyGroups' | 'backup'>;
  /** Where alert toasts are shown (default: the real VS Code window). */
  host?: Pick<VscodeHost, 'showWarningMessage'>;
  /** Where the conversion summary is shown (default: an information message). */
  ui?: LegacyRulesUi;
  logger?: Logger;
}

export async function wireAlerts(scope: WiringScope, deps: AlertWiringDeps): Promise<AlertWiring> {
  const { userConfig, imported, host = defaultVscodeHost, ui = vscodeLegacyRulesUi, logger = defaultLogger } = deps;

  await importLegacyAlertRules({ imported, config: userConfig, ui, logger });

  const alerts = new AlertService({ host, config: () => userConfig.get(), state: scope.context.globalState, logger });
  scope.started.push(() => alerts.dispose());
  return { alerts };
}

/**
 * Wires alert firing: the {@link AlertService} that `UsageService` hands every
 * unfiltered snapshot to. It is created before the usage service so it can be
 * injected; `UsageService.dispose()` disposes it again (a repeat is harmless).
 */
import { AlertService } from '../app/AlertService';
import type { UserConfigStore } from '../app/UserConfigStore';
import { defaultVscodeHost, VscodeHost } from '../util/vscodeHost';
import type { WiringScope } from './scope';

export interface AlertWiring {
  alerts: AlertService;
}

export interface AlertWiringDeps {
  userConfig: Pick<UserConfigStore, 'get'>;
  /** Where alert toasts are shown (default: the real VS Code window). */
  host?: Pick<VscodeHost, 'showWarningMessage'>;
}

export function wireAlerts(scope: WiringScope, deps: AlertWiringDeps): AlertWiring {
  const { userConfig, host = defaultVscodeHost } = deps;
  const alerts = new AlertService({ host, config: () => userConfig.get() });
  scope.started.push(() => alerts.dispose());
  return { alerts };
}

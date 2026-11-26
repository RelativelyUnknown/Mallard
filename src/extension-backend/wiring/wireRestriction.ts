/**
 * Wires the restriction engine and feeds it: every UNFILTERED snapshot is
 * reconciled against the user's flat rules (those with `restrict`). A dashboard
 * filter shows a slice of the data, and reconciling restriction rules against it
 * would fire or lift a restriction on the wrong numbers, so filtered snapshots
 * never reach here (`onDidComputeUnfiltered` only emits unfiltered ones).
 *
 * The alert history rides along: it is what `velocity.creditsPerHour` is
 * computed from, so a velocity restriction sees the same rate the velocity
 * alert does. `UsageService` hands the snapshot to the alerts first, so the
 * history already holds this snapshot's sample when it is read here.
 */
import { RestrictionEngine } from '../app/RestrictionEngine';
import type { RestrictionInput } from '../app/RestrictionEngine';
import type { AlertService } from '../app/AlertService';
import type { UsageService } from '../app/UsageService';
import type { IConfigService } from '../app/ConfigService';
import type { HistorySample } from '../domain/alertMetrics';
import type { SnapshotData, UserConfig } from '../domain/types';
import { defaultLogger, Logger } from '../util/logger';
import type { WiringScope } from './scope';

export interface RestrictionWiring {
  restriction: RestrictionEngine;
}

export interface RestrictionWiringDeps {
  usage: Pick<UsageService, 'onDidComputeUnfiltered'>;
  userConfig: Pick<IConfigService, 'get'>;
  /** Source of the velocity history (the same samples the alerts evaluate). */
  alerts: Pick<AlertService, 'getHistory'>;
  logger?: Logger;
}

/** What `RestrictionEngine.reconcile` (or `simulate`) needs for one snapshot under the current config. */
export function buildReconcileInput(snapshot: SnapshotData | null, userCfg: UserConfig, history: HistorySample[]): RestrictionInput {
  return { snapshot, rules: userCfg.flatRules ?? [], history };
}

export function wireRestriction(scope: WiringScope, deps: RestrictionWiringDeps): RestrictionWiring {
  const { context, storageDir, started } = scope;
  const { usage, userConfig, alerts, logger = defaultLogger } = deps;

  const restriction = new RestrictionEngine(storageDir);
  started.push(() => restriction.dispose());

  context.subscriptions.push(
    usage.onDidComputeUnfiltered((snapshot) => {
      void restriction
        .reconcile(buildReconcileInput(snapshot, userConfig.get(), alerts.getHistory()))
        .catch((err: unknown) => logger.error('restriction', 'restriction reconcile failed', err));
    }),
  );

  return { restriction };
}

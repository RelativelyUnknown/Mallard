/**
 * Wires the restriction engine and feeds it: every UNFILTERED snapshot is
 * reconciled against the user's rules. A dashboard filter shows a slice of the
 * data, and reconciling restriction rules against it would fire or lift a
 * restriction on the wrong numbers, so filtered snapshots never reach here
 * (`onDidComputeUnfiltered` only emits unfiltered ones).
 */
import { RestrictionEngine } from '../app/RestrictionEngine';
import type { UsageService } from '../app/UsageService';
import type { UserConfigStore } from '../app/UserConfigStore';
import type { SnapshotData, UserConfig } from '../domain/types';
import { opt } from '../util/lang';
import { defaultLogger, Logger } from '../util/logger';
import type { WiringScope } from './scope';

export interface RestrictionWiring {
  restriction: RestrictionEngine;
}

export interface RestrictionWiringDeps {
  usage: Pick<UsageService, 'onDidComputeUnfiltered'>;
  userConfig: Pick<UserConfigStore, 'get'>;
  logger?: Logger;
}

/** What `RestrictionEngine.reconcile` needs for one snapshot under the current config. */
export function buildReconcileInput(snapshot: SnapshotData, userCfg: UserConfig) {
  return {
    snapshot,
    rules: userCfg.rules ?? [],
    ...opt('vars',           userCfg.vars),
    ...opt('groups',         userCfg.groups),
    signedIn: snapshot.authStatus === 'signed-in',
    ...opt('branchBudgets', userCfg.branchBudgets),
  };
}

export function wireRestriction(scope: WiringScope, deps: RestrictionWiringDeps): RestrictionWiring {
  const { context, storageDir, started } = scope;
  const { usage, userConfig, logger = defaultLogger } = deps;

  const restriction = new RestrictionEngine(storageDir);
  started.push(() => restriction.dispose());

  context.subscriptions.push(
    usage.onDidComputeUnfiltered((snapshot) => {
      void restriction.reconcile(buildReconcileInput(snapshot, userConfig.get())).catch((err: unknown) =>
        logger.error('restriction', 'restriction reconcile failed', err),
      );
    }),
  );

  return { restriction };
}

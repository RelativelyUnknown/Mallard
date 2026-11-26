/**
 * Fires the built-in alerts (budget, daily, velocity, branch cap) and the
 * user's flat alert rules for each UNFILTERED snapshot `UsageService` computes
 * (a filtered snapshot describes a slice of the data, so evaluating budgets
 * against it would alert on the wrong numbers).
 *
 * ONE evaluation path: `builtinFlatRules(config, branch)` followed by the
 * user's `mallard.alerts.rules`, evaluated by `evaluateFlatRules` against the
 * snapshot's metrics and the rolling velocity history (kept here, one sample per
 * snapshot, the last hour only; `getHistory()` shares it with the restriction
 * engine so a velocity restriction reads the same rate).
 *
 * Cooldowns are `FlatCooldownState` (`Record<string, number>`: key to the epoch
 * ms the rule last fired) kept in the injected `Memento` (globalState) under
 * {@link ALERT_COOLDOWNS_KEY}, so a window reload does not re-fire every active
 * alert. Every `process` first forgets the entries that can no longer block
 * anything, each judged by its own rule's cooldown (`pruneCooldowns`), and
 * persists the state again when it changed. Without a `Memento` the state lives
 * in memory only.
 *
 * Every toast is a warning message with the fixed text of `flatAlertMessage`;
 * rules with `notify: false` and restriction rules (which get the restriction
 * popup instead) stay silent but still keep their cooldown.
 */
import * as vscode from 'vscode';
import { buildFlatContext } from '../domain/alertMetrics';
import type { HistorySample } from '../domain/alertMetrics';
import type { FlatAlertRule } from '../domain/contracts';
import {
  builtinFlatRules,
  evaluateFlatRules,
  parseCooldownState,
  parseFlatRules,
  pruneCooldowns,
} from '../domain/flatAlerts';
import type { FlatCooldownState } from '../domain/flatAlerts';
import type { SnapshotData, UserConfig } from '../domain/types';
import { defaultLogger, Logger } from '../util/logger';
import type { VscodeHost } from '../util/vscodeHost';

/** Keep ~1h of recent samples for velocity alerting. */
const HISTORY_WINDOW_MS = 60 * 60 * 1000;

/** The globalState key of the persisted cooldowns (`FlatCooldownState`). */
export const ALERT_COOLDOWNS_KEY = 'mallard.alerts.cooldowns';

export interface AlertServiceDeps {
  /** Where alert toasts are shown. */
  host: Pick<VscodeHost, 'showWarningMessage'>;
  /** The current user config; used when a caller does not pass one. */
  config: () => UserConfig;
  /** Wall clock in ms; used when a caller does not pass `now`. */
  clock?: () => number;
  /** Where the cooldowns survive a reload (globalState); in memory only when absent. */
  state?: Pick<vscode.Memento, 'get' | 'update'>;
  logger?: Logger;
}

export interface AlertRunOptions {
  /** The instant this evaluation is for (default: the injected clock). */
  now?: number;
  /** The config to evaluate against (default: the injected accessor). */
  config?: UserConfig;
}

export class AlertService implements vscode.Disposable {
  private readonly _onAlertFired = new vscode.EventEmitter<{ message: string }>();
  /** Fires once per alert/rule notification actually shown — lets UI surfaces
   *  (the sidebar gauge) react to the moment an alert fires, not just
   *  passively reflect the latest snapshot percentage. */
  readonly onAlertFired = this._onAlertFired.event;

  private cooldowns: FlatCooldownState;
  private readonly history: HistorySample[] = [];
  /** Rule-list problems already logged, so an unchanged bad setting is reported once, not on every snapshot. */
  private reported = new Set<string>();
  private readonly logger: Logger;

  constructor(private readonly deps: AlertServiceDeps) {
    this.logger = deps.logger ?? defaultLogger;
    this.cooldowns = parseCooldownState(deps.state?.get<unknown>(ALERT_COOLDOWNS_KEY));
  }

  /** The recent velocity samples, oldest first (a copy). */
  getHistory(): HistorySample[] {
    return [...this.history];
  }

  /**
   * Evaluate one unfiltered snapshot: record the velocity sample, forget stale
   * cooldowns, then fire the built-in alerts and the rules.
   */
  process(snapshot: SnapshotData, opts: AlertRunOptions = {}): void {
    const now = opts.now ?? (this.deps.clock ?? Date.now)();
    const config = opts.config ?? this.deps.config();
    this.recordSample(now, snapshot);
    const rules = [...builtinFlatRules(config, snapshot.currentBranch), ...this.userRules(config)];

    const kept = pruneCooldowns(this.cooldowns, rules, now);
    const pruned = Object.keys(kept).length < Object.keys(this.cooldowns).length;
    const evaluation = evaluateFlatRules(rules, buildFlatContext({ snapshot, history: this.history, now }), kept, now);
    this.cooldowns = evaluation.state;
    if (pruned || evaluation.matches.length > 0) this.persist();

    for (const match of evaluation.matches) {
      if (!match.notify) continue;
      void this.deps.host.showWarningMessage(match.message);
      this._onAlertFired.fire({ message: match.message });
    }
  }

  /** The user's rules, validated: a bad entry is dropped and reported once, its siblings are kept. */
  private userRules(config: UserConfig): FlatAlertRule[] {
    const { rules, errors } = parseFlatRules(config.flatRules);
    const problems = new Set(errors.map((e) => `mallard.alerts.rules${e.index >= 0 ? `[${e.index}]` : ''}${e.id ? ` "${e.id}"` : ''}: ${e.message}`));
    for (const problem of problems) if (!this.reported.has(problem)) this.logger.warn('alerts', `${problem}; ignoring it`);
    this.reported = problems;
    return rules;
  }

  private recordSample(now: number, s: SnapshotData): void {
    this.history.push({ ts: now, todayCredits: s.today.credits });
    const cutoff = now - HISTORY_WINDOW_MS;
    while (this.history.length > 0 && this.history[0]!.ts < cutoff) this.history.shift();
  }

  private persist(): void {
    const state = this.deps.state;
    if (!state) return;
    Promise.resolve(state.update(ALERT_COOLDOWNS_KEY, this.cooldowns)).catch((err: unknown) =>
      this.logger.warn('alerts', 'could not save the alert cooldowns', err),
    );
  }

  dispose(): void {
    this._onAlertFired.dispose();
  }
}

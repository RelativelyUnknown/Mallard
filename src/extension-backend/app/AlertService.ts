/**
 * Fires budget/velocity/branch alerts and user alert rules for each UNFILTERED
 * snapshot `UsageService` computes (a filtered snapshot describes a slice of
 * the data, so evaluating budgets against it would alert on the wrong
 * numbers). Owns the rolling sample history used for velocity, the cooldown map
 * (`alertFired`: key → last fired at) and the `onAlertFired` event; the host
 * (notification toasts), clock and config accessor are injected.
 *
 * Extracted verbatim from `UsageService` — behaviour is unchanged: cooldown
 * keys, the 24 h pruning, and the order (built-in alerts first, then rules).
 */
import * as vscode from 'vscode';
import { evaluateAlerts, SnapshotSample } from '../domain/alerts';
import { evaluateAlertRules, shouldNotify } from '../domain/alertRules';
import type { SnapshotData, UserConfig } from '../domain/types';
import { opt } from '../util/lang';
import type { VscodeHost } from '../util/vscodeHost';

/** Keep ~1h of recent samples for velocity alerting. */
const HISTORY_WINDOW_MS = 60 * 60 * 1000;

/** Cooldown entries older than this are forgotten (so the map cannot grow forever). */
const FIRED_RETENTION_MS = 86_400_000;

export interface AlertServiceDeps {
  /** Where alert toasts are shown. */
  host: Pick<VscodeHost, 'showWarningMessage'>;
  /** The current user config; used when a caller does not pass one. */
  config: () => UserConfig;
  /** Wall clock in ms; used when a caller does not pass `now`. */
  clock?: () => number;
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

  private readonly fired = new Map<string, number>();
  private readonly history: SnapshotSample[] = [];

  constructor(private readonly deps: AlertServiceDeps) {}

  /**
   * Evaluate one unfiltered snapshot: forget stale cooldowns, record the
   * velocity sample, then fire built-in alerts and rules.
   */
  process(snapshot: SnapshotData, opts: AlertRunOptions = {}): void {
    const now = opts.now ?? (this.deps.clock ?? Date.now)();
    const config = opts.config ?? this.deps.config();
    this.prune(now);
    this.recordSample(now, snapshot);
    this.fireAlerts(snapshot, config, now);
  }

  private prune(now: number): void {
    for (const [key, ts] of this.fired)
      if (now - ts > FIRED_RETENTION_MS) this.fired.delete(key);
  }

  private recordSample(now: number, s: SnapshotData): void {
    this.history.push({ ts: now, todayCredits: s.today.credits });
    const cutoff = now - HISTORY_WINDOW_MS;
    while (this.history.length > 0 && this.history[0]!.ts < cutoff) this.history.shift();
  }

  private fireAlerts(s: SnapshotData, uc: UserConfig, now: number): void {
    const alerts = evaluateAlerts(s, this.history, uc, this.fired, now);
    for (const a of alerts) {
      void this.deps.host.showWarningMessage(a.message);
      this.fired.set(a.key, now);
      this._onAlertFired.fire({ message: a.message });
    }

    const ruleResults = evaluateAlertRules({
      snapshot: s,
      history: this.history,
      rules: uc.rules ?? [],
      ...opt('groups', uc.groups),
      ...opt('vars', uc.vars),
      ...opt('branchBudgets', uc.branchBudgets),
      signedIn: s.authStatus === 'signed-in',
      fired: this.fired,
      now,
    });
    for (const r of ruleResults) {
      if (shouldNotify(r.rule)) {
        void this.deps.host.showWarningMessage(r.message);
        this._onAlertFired.fire({ message: r.message });
      }
    }
  }

  dispose(): void {
    this._onAlertFired.dispose();
  }
}

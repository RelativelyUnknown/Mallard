/**
 * Restriction engine — owns the on-disk popup state and exposes a small
 * surface for the host and UI. Never disables any extension; it only tracks
 * whether the restriction popup (Dismiss/Snooze/Disable Mallard) should show.
 *
 * Which flat rule restricts (and when it lifts) is decided by the pure
 * `evaluateFlatRestriction`; what stays here is the persisted
 * `RestrictionState`, the user's snooze (`userOverrideUntil`) and the change
 * events. `reconcile` gets the alert history, so velocity rules restrict too.
 */
import * as vscode from 'vscode';
import { buildFlatContext } from '../domain/alertMetrics';
import type { HistorySample, MetricSnapshot } from '../domain/alertMetrics';
import type { FlatAlertRule } from '../domain/contracts';
import { flatRuleText } from '../domain/flatAlerts';
import { evaluateFlatRestriction } from '../domain/flatRestriction';
import type { FlatRestrictionResult } from '../domain/flatRestriction';
import { DEFAULT_RESTRICTION_STATE, RestrictionState } from '../domain/types';
import { JsonFileStore } from '../util/JsonFileStore';

const STATE_FILE = 'restriction.json';

/** What one evaluation needs: the unfiltered snapshot, the rules (only those with `restrict` count) and the alert history. */
export interface RestrictionInput {
  snapshot: MetricSnapshot | null;
  rules: readonly FlatAlertRule[];
  /** The recent `todayCredits` samples (oldest first); without them `velocity.*` rules never match. */
  history?: readonly HistorySample[];
  now?: number;
}

export interface RestrictionSimulateReport {
  state: RestrictionState;
  desired: FlatRestrictionResult;
  rules: readonly FlatAlertRule[];
}

export class RestrictionEngine {
  private readonly _onDidChange = new vscode.EventEmitter<RestrictionState>();
  readonly onDidChange: vscode.Event<RestrictionState> = this._onDidChange.event;

  private state: RestrictionState = { ...DEFAULT_RESTRICTION_STATE };
  private readonly store: JsonFileStore<RestrictionState>;
  private overrideTimer?: NodeJS.Timeout;

  constructor(storageDir: string) {
    this.store = new JsonFileStore<RestrictionState>(storageDir, STATE_FILE);
    this.state = this.readFromDisk();
    this.armOverrideExpiry();
  }

  getState(): RestrictionState {
    return { ...this.state };
  }

  isRestricted(now = Date.now()): boolean {
    if (this.state.userOverrideUntil && this.state.userOverrideUntil > now) return false;
    return this.state.active;
  }

  /** Wipe the restriction state. */
  async clearAll(): Promise<void> {
    this.state = { ...DEFAULT_RESTRICTION_STATE };
    this.armOverrideExpiry();
    this.writeToDisk();
    this._onDidChange.fire(this.getState());
  }

  /** Snooze the active restriction for `minutes` from now. */
  async snooze(minutes: number): Promise<void> {
    this.state.userOverrideUntil = Date.now() + minutes * 60_000;
    this.armOverrideExpiry();
    this.writeToDisk();
    this._onDidChange.fire(this.getState());
  }

  /**
   * An expired snooze is cleared with a change event, so listeners (the
   * restriction popup) can re-prompt: nothing else would announce the moment
   * a snooze ends while the restriction itself is unchanged.
   */
  private expireOverride(now: number): void {
    const until = this.state.userOverrideUntil;
    if (!until || until > now) return;
    this.state = { ...this.state, userOverrideUntil: null };
    this.writeToDisk();
    this._onDidChange.fire(this.getState());
  }

  private armOverrideExpiry(): void {
    clearTimeout(this.overrideTimer);
    delete this.overrideTimer;
    const until = this.state.userOverrideUntil;
    if (!until) return;
    // setTimeout caps at ~24.8 days; snoozes are bounded far below that.
    const ms = Math.min(Math.max(until - Date.now(), 0), 2 ** 31 - 1);
    this.overrideTimer = setTimeout(() => this.expireOverride(Date.now()), ms);
    this.overrideTimer.unref();
  }

  /** The flat rules' decision for this input, given the restriction the state currently holds. */
  private evaluate(input: RestrictionInput, now: number): FlatRestrictionResult {
    const ctx = buildFlatContext({ snapshot: input.snapshot, ...(input.history ? { history: input.history } : {}), now });
    return evaluateFlatRestriction(input.rules, ctx, this.state.active ? this.state.ruleId : undefined);
  }

  /** Recompute against the current context and apply changes. Idempotent. */
  async reconcile(input: RestrictionInput): Promise<RestrictionState> {
    const now = input.now ?? Date.now();
    this.expireOverride(now);
    const state = this.state;
    // A snoozed restriction is left as it is: the user said no (and the
    // banner says "override"), so nothing is started, switched or cleared
    // until the snooze ends. Without an active restriction the snooze just
    // waits: `isRestricted()` honours it until it expires.
    if (state.active && state.userOverrideUntil && state.userOverrideUntil > now) return state;

    const { active: wanted } = this.evaluate(input, now);
    if (!wanted) {
      // No rule wants to restrict — make sure the state is clean.
      if (state.active) {
        this.state = { ...DEFAULT_RESTRICTION_STATE };
        this.writeToDisk();
        this._onDidChange.fire(this.getState());
      }
      return this.state;
    }

    // The reason is the rule's condition, not its current value: a value that
    // changes with every snapshot would re-open the popup and re-announce the
    // banner each time. It is refreshed when the user edits the rule.
    const reasonMessage = flatRuleText(wanted);
    if (!state.active || state.ruleId !== wanted.id) {
      this.state = { version: 1, active: true, ruleId: wanted.id, reasonMessage, firedAt: now, userOverrideUntil: null };
      this.writeToDisk();
      this._onDidChange.fire(this.getState());
    } else if (state.reasonMessage !== reasonMessage) {
      this.state.reasonMessage = reasonMessage;
      this.writeToDisk();
      this._onDidChange.fire(this.getState());
    }

    return this.state;
  }

  /** Run the evaluator against the supplied context and return the dry-run report (nothing is applied). */
  async simulate(input: RestrictionInput): Promise<RestrictionSimulateReport> {
    return {
      state: this.getState(),
      desired: this.evaluate(input, input.now ?? Date.now()),
      rules: input.rules,
    };
  }

  dispose(): void {
    clearTimeout(this.overrideTimer);
    this._onDidChange.dispose();
  }

  private readFromDisk(): RestrictionState {
    const parsed = this.store.read();
    return parsed && typeof parsed === 'object'
      ? { ...DEFAULT_RESTRICTION_STATE, ...(parsed as Partial<RestrictionState>) }
      : { ...DEFAULT_RESTRICTION_STATE };
  }

  private writeToDisk(): void {
    this.store.write(this.state);
  }
}

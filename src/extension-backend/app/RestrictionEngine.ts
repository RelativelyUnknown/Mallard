/**
 * Restriction engine — owns the on-disk popup state and exposes a small
 * surface for the host and UI. Never disables any extension; it only tracks
 * whether the restriction popup (Dismiss/Snooze/Disable Mallard) should show.
 */
import * as vscode from 'vscode';
import { AlertRule, DEFAULT_RESTRICTION_STATE, RestrictionState } from '../domain/types';
import { buildRuleContext, EvalBuildInput } from '../domain/expr/context';
import { evalCondition } from '../domain/expr/jsonCondition';
import { evaluateRestrictionState } from '../domain/restriction/evaluator';
import { JsonFileStore } from '../util/JsonFileStore';

const STATE_FILE = 'restriction.json';

interface RestrictionSimulateReport {
  state: RestrictionState;
  desired: ReturnType<typeof evaluateRestrictionState>;
  rules: AlertRule[];
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

  /** Recompute against the current context and apply changes. Idempotent. */
  async reconcile(
    input: EvalBuildInput & { rules: AlertRule[]; now?: number },
  ): Promise<RestrictionState> {
    const now = input.now ?? Date.now();
    const ctx = buildRuleContext(input);
    this.expireOverride(now);
    const state = this.state;
    // Passing the held rule lets the evaluator say whether IT can be lifted
    // (canClearActive) even after its own trigger has stopped matching.
    const desired = evaluateRestrictionState(
      input.rules,
      ctx,
      now,
      state.active ? state.ruleId : undefined,
    );

    // Honour active user override
    if (state.userOverrideUntil && state.userOverrideUntil > now) {
      if (state.active) {
        // We're restricted but the user said no — keep the extensions enabled
        // (already done at snooze time) and the banner will say "override".
        return state;
      }
      // Override still active but not currently restricted — fall through;
      // the override is honoured by isRestricted() until it expires.
    }

    // A rule whose `reEnableWhen` holds is lifted: it neither starts nor
    // keeps restricting (so it cannot flap while `when` is still true).
    const lifted = (rule: AlertRule): boolean => {
      const reEnable = rule.restrict?.reEnableWhen;
      return reEnable !== undefined && evalCondition(reEnable, ctx);
    };
    let wanted = desired.matching.find((r) => !lifted(r));
    if (!wanted && state.active) {
      // Hysteresis: the held rule keeps restricting after its `when` stops
      // matching until the evaluator says it can be cleared — i.e. its
      // `reEnableWhen` holds, or (with none configured) its trigger is gone.
      // A rule that was removed, or no longer restricts, clears immediately.
      const held = input.rules.find((r) => r.id === state.ruleId && r.restrict !== undefined);
      if (held && !desired.canClearActive) wanted = held;
    }

    if (!wanted) {
      // No rule wants to restrict — make sure the state is clean.
      if (state.active) {
        this.state = { ...DEFAULT_RESTRICTION_STATE };
        this.writeToDisk();
        this._onDidChange.fire(this.getState());
      }
      return this.state;
    }

    if (!state.active || state.ruleId !== wanted.id) {
      this.state = {
        version: 1,
        active: true,
        ruleId: wanted.id,
        reasonMessage: wanted.message,
        firedAt: now,
        userOverrideUntil: null,
      };
      this.writeToDisk();
      this._onDidChange.fire(this.getState());
    } else if (this.state.reasonMessage !== wanted.message) {
      // still restricted by the same rule; refresh the message in case it changed
      this.state.reasonMessage = wanted.message;
      this.writeToDisk();
      this._onDidChange.fire(this.getState());
    }

    return this.state;
  }

  /** Run the evaluator against the supplied context and return the dry-run report. */
  async simulate(
    input: EvalBuildInput & { rules: AlertRule[] },
  ): Promise<RestrictionSimulateReport> {
    const ctx = buildRuleContext(input);
    const desired = evaluateRestrictionState(
      input.rules,
      ctx,
      Date.now(),
      this.state.active ? this.state.ruleId : undefined,
    );
    return {
      state: this.getState(),
      desired,
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

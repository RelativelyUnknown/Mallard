/* c8 ignore next */
/**
 * Pure restriction evaluation: given the rule set and a context object,
 * decides whether any rule's `restrict` block wants to show the restriction
 * popup, and whether a rule's `reEnableWhen` lets the restriction clear.
 *
 * Restrictions are notification-level only. Mallard records a restriction
 * state and shows a popup (Dismiss / Snooze / Disable Mallard...); it never
 * disables Copilot or any other extension, and nothing here enforces anything.
 *
 * Whether a rule "matches" is decided by the same `ruleMatches` the alert
 * path uses, so `requiresAuth`, `active`, `snoozeUntil` and every trigger form
 * (`thresholds` > `when` > `conditions`) behave identically in both. The first
 * matching rule (declaration order in config.json) wins. The user's snooze
 * override (`userOverrideUntil`) is applied by RestrictionEngine, not here.
 */
import { AlertRule } from '../types';
import { evalCondition } from '../expr/jsonCondition';
import { ruleMatches } from '../alertRules';

export interface RestrictionDesired {
  /** The rule that should restrict right now (first match), or null. */
  active: AlertRule | null;
  /** Every restrict rule that currently matches, in declaration order. */
  matching: AlertRule[];
  /**
   * Rules whose restriction may be lifted now. A rule qualifies when it is
   * matching or is the currently-active rule (`activeRuleId`), AND either its
   * `reEnableWhen` evaluates true, or it has no `reEnableWhen` and its trigger
   * has stopped matching. A matching rule with no `reEnableWhen` never qualifies.
   */
  canClear: AlertRule[];
  /** True when `activeRuleId` was given and that rule is in `canClear`. */
  canClearActive: boolean;
}

/**
 * @param activeRuleId the rule id the restriction state currently holds
 *   (RestrictionState.ruleId), so a restriction whose `when` has since gone
 *   false can still report that it is clearable.
 */
export function evaluateRestrictionState(
  rules: AlertRule[],
  ctx: Record<string, unknown>,
  now: number,
  activeRuleId?: string,
): RestrictionDesired {
  const matching: AlertRule[] = [];
  const canClear: AlertRule[] = [];

  for (const r of rules) {
    if (!r.restrict) continue;
    const matches = ruleMatches(r, ctx, now);
    if (matches) matching.push(r);
    if (!matches && r.id !== activeRuleId) continue;
    // Clearable only when the re-enable condition currently holds — merely
    // having one configured is not enough. Without one, only a rule whose
    // trigger has already stopped matching (i.e. the active rule) is clearable.
    const reEnable = r.restrict.reEnableWhen;
    if (reEnable ? evalCondition(reEnable, ctx) : !matches) canClear.push(r);
  }

  return {
    active: matching[0] ?? null,
    matching,
    canClear,
    canClearActive: activeRuleId !== undefined && canClear.some((r) => r.id === activeRuleId),
  };
}

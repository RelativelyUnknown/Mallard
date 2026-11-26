/**
 * Pure restriction decision for flat rules: which `restrict` rule (if any)
 * wants the restriction popup right now, given the metrics and the rule that
 * was restricting before. `RestrictionEngine.reconcile` applies the answer.
 *
 * Restrictions are notification-level only (Mallard never disables anything);
 * "restricted" just means the popup / banner / status bar say so. What stays in
 * `RestrictionEngine`: the persisted `RestrictionState`, the user's snooze
 * override (`userOverrideUntil`, including its early return while a snooze is
 * running), and the change events.
 *
 * Semantics, per `restrict` rule in declaration order:
 *   - The first rule that matches and is not lifted restricts. A rule is
 *     "lifted" while its metric is below `clearBelow`; a lifted rule neither
 *     starts nor keeps a restriction, so it cannot flap while still matching.
 *   - Hysteresis: a restriction already held by a rule stays on after that rule
 *     stopped matching, until its metric drops below `clearBelow`. A rule with
 *     no `clearBelow` clears as soon as it stops matching. A held rule that was
 *     removed from the list, or no longer restricts, clears immediately. While
 *     the metric is unavailable it is not below anything, so a held restriction
 *     with a `clearBelow` stays.
 *
 * Velocity rules need the alert history: build the context with
 * `buildFlatContext({ snapshot, history, now })` (the old reconcile passed no
 * history, so `velocity.*` restrictions never matched: B6).
 */
import { metricValue } from './alertMetrics';
import type { FlatContext } from './alertMetrics';
import { compare } from './compare';
import type { FlatAlertRule } from './contracts';
import { flatAlertMessage, flatRuleMatches } from './flatAlerts';

export interface FlatRestrictionResult {
  /** The rule that restricts now, or null. */
  active: FlatAlertRule | null;
  /** Fixed-format reason for `active` (its message with the current value), or null. */
  reason: string | null;
  /** True when the rule in `previousRuleId` was restricting and nothing restricts any more. */
  cleared: boolean;
  /** True when `active` is only held by hysteresis: it no longer matches but its metric is not below `clearBelow` yet. */
  held: boolean;
  /** Every `restrict` rule that matches now, in declaration order, lifted or not (for dry runs). */
  matching: FlatAlertRule[];
}

/**
 * @param previousRuleId the rule id the restriction state currently holds
 *   (`RestrictionState.ruleId` while `active`), so a restriction whose rule has
 *   since stopped matching can be held or cleared.
 */
export function evaluateFlatRestriction(
  rules: readonly FlatAlertRule[],
  ctx: FlatContext,
  previousRuleId?: string,
): FlatRestrictionResult {
  const restrictRules = rules.filter((rule) => rule.restrict === true);
  const matching = restrictRules.filter((rule) => flatRuleMatches(rule, ctx));
  const lifted = (rule: FlatAlertRule): boolean =>
    rule.clearBelow !== undefined && compare(metricValue(rule.metric, ctx), rule.clearBelow, '<');

  let active = matching.find((rule) => !lifted(rule)) ?? null;
  let held = false;
  if (active === null && previousRuleId !== undefined) {
    // Reaching here, the previous rule is not matching or is lifted; it keeps
    // restricting only while it has a `clearBelow` that does not yet hold.
    const previous = restrictRules.find((rule) => rule.id === previousRuleId);
    if (previous?.clearBelow !== undefined && !lifted(previous)) {
      active = previous;
      held = true;
    }
  }
  return {
    active,
    reason: active ? flatAlertMessage(active, metricValue(active.metric, ctx)) : null,
    cleared: previousRuleId !== undefined && active === null,
    held,
    matching,
  };
}

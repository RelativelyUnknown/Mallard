/**
 * Legacy importer: converts the old JSON rules (`config.json` `rules`) into
 * flat rules, and reports, with a precise reason, every rule it cannot convert.
 * Pure; a one-time migration step, not a runtime path.
 *
 * Converted:
 *   - `conditions` with ONE entry (`match` "all" or "any"; "none" negates it);
 *   - `thresholds`: each level becomes its own rule `<id>:<n>` (n counts from
 *     1) with that level's severity and cooldown (falling back to the rule's
 *     cooldown, then 1 h). The `<id>:<n>` ids form an escalation ladder (see
 *     flatAlerts.ts), so only the highest matching level toasts, as before;
 *   - `when` that is ONE comparison (`> >= < <= == !=`) of a `{var}` against a
 *     literal, on either side.
 *   Precedence is the legacy one: `thresholds` (non-empty) > `when` >
 *   `conditions`; the lower forms are ignored, exactly as the old evaluator did.
 *   `severity`, `cooldown`, `notify` and `restrict` carry over (`restrict: {}`
 *   becomes `restrict: true`). The custom `message` is NOT carried: flat rules
 *   have a fixed message, so a rule with a template message converts like any
 *   other.
 *   `restrict.reEnableWhen` becomes `clearBelow` when it is `<` or `<=` of the
 *   same metric against a literal (strictly below, so a `<=` differs only at
 *   exactly that value). Any other `reEnableWhen` skips the rule: converting it
 *   without would silently change when the restriction clears.
 *
 * Skipped, with a reason: `and`/`or`/`not`, a bare `var` or boolean `when`,
 * `in` and `matches`, several conditions, `match: "none"`, comparisons of two
 * variables or two literals, a non-numeric literal, `vars`, `groups` and the
 * `active` gate, `requiresAuth`, a `snoozeUntil` still in the future, any
 * variable without a flat metric (see {@link mapLegacyVar}), and a repeated id.
 *
 * Variable mapping (`model["gpt-4.1"].credits` becomes `model:gpt-4.1.credits`):
 * `today.credits|cost`, `month.credits|cost` (also `budget.usedCredits|usedCost`,
 * which are the same numbers), `budget.percentOfBudget|percentOfIncluded`,
 * `forecast.projectedCredits|projectedCost`, `velocity.creditsPerHour`,
 * `window7d.credits`, `currentBranchCredits`, and `model.<key>.credits|cost`,
 * `repo.<key>.credits|cost`.
 */
import type { FlatAlertMetric, FlatAlertRule } from './contracts';
import { toNumeric } from './compare';
import { DEFAULT_FLAT_COOLDOWN, parseDurationMs } from './flatAlerts';

// ── The legacy document shapes ───────────────────────────────────────────────
//
// What `config.json` carried (the rules language is gone, but its documents are
// still read once). Deliberately loose: the importer takes the rules from a
// JSON file it did not write, checks what it relies on and reports the rest.

/** A JSONLogic-style condition: a boolean, or an object with one operator key (`{ ">": [a, b] }`, `{ "and": [...] }`, `{ "var": "x" }`). */
export type LegacyCondition = boolean | { [operator: string]: unknown };

/** One structured condition (`conditions`) or threshold level (`thresholds`): `field op value`. */
export interface LegacyComparison {
  field: string;
  op: string;
  value: unknown;
}

export interface LegacyThresholdLevel extends LegacyComparison {
  severity: 'info' | 'warning' | 'critical';
  /** Per-level cooldown (overrides the rule's own). */
  cooldown?: string;
}

/** A rule of the old `config.json` `rules` array. */
export interface LegacyRule {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  cooldown?: string;
  message?: string;
  when?: LegacyCondition;
  conditions?: LegacyComparison[];
  match?: 'all' | 'any' | 'none';
  active?: LegacyCondition;
  requiresAuth?: boolean;
  notify?: boolean;
  restrict?: { reEnableWhen?: LegacyCondition };
  thresholds?: LegacyThresholdLevel[];
  /** ISO 8601 timestamp the rule was snoozed until. */
  snoozeUntil?: string;
}

/** A rule group of the old `config.json` `groups` array: a named gate (`group.<id>`) that rules referenced in `active`. */
export interface LegacyGroup {
  id: string;
  label?: string;
  active: LegacyCondition;
}

export interface LegacyImportResult {
  converted: FlatAlertRule[];
  skipped: Array<{ id: string; reason: string }>;
}

export interface LegacyImportOptions {
  /**
   * The current time. With it, a `snoozeUntil` that has passed (or is not a
   * date) no longer blocks the conversion; without it any `snoozeUntil` that
   * parses as a date does.
   */
  now?: number;
}

type FlatOp = FlatAlertRule['op'];
type Comparison = { metric: FlatAlertMetric; op: FlatOp; value: number };
type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

// ── Variable paths ───────────────────────────────────────────────────────────

/**
 * Read one bracket segment starting at `path[start] === '['`. The content is
 * either a quoted string (`"…"` or `'…'`, backslash escapes the quote and the
 * backslash) or bare text up to the closing `]`. Returns null when malformed.
 */
function readBracket(path: string, start: number): { key: string; end: number } | null {
  const quote = path[start + 1];
  if (quote === '"' || quote === "'") {
    let key = '';
    let i = start + 2;
    while (i < path.length) {
      const ch = path[i]!;
      if (ch === '\\' && i + 1 < path.length) {
        key += path[i + 1]!;
        i += 2;
      } else if (ch === quote) {
        return path[i + 1] === ']' ? { key, end: i + 2 } : null;
      } else {
        key += ch;
        i += 1;
      }
    }
    return null;
  }
  const close = path.indexOf(']', start + 1);
  return close === -1 ? null : { key: path.slice(start + 1, close).trim(), end: close + 1 };
}

/**
 * Split a legacy variable path into its segments. Dots separate segments;
 * `["…"]` / `['…']` takes its content literally (dots included) so keys like
 * `gpt-4.1` or `foo.js` are reachable: `model["gpt-4.1"].credits`. Empty plain
 * segments are kept. Returns null for a malformed path (unterminated
 * bracket/quote, junk after `]`).
 */
export function parseVarPath(path: string): string[] | null {
  const segments: string[] = [];
  let i = 0;
  for (;;) {
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    // An empty plain segment directly before a bracket (`["a"]`, `a.["b"]`) is
    // just the bracket's own position, not a real empty key.
    if (!(j === i && path[j] === '[')) segments.push(path.slice(i, j));
    i = j;
    while (path[i] === '[') {
      const bracket = readBracket(path, i);
      if (!bracket) return null;
      segments.push(bracket.key);
      i = bracket.end;
    }
    if (i >= path.length) return segments;
    if (path[i] !== '.') return null;
    i += 1;
  }
}

// ── Variable mapping ─────────────────────────────────────────────────────────

const DIRECT_METRICS = new Set<string>([
  'today.credits',
  'today.cost',
  'month.credits',
  'month.cost',
  'budget.percentOfBudget',
  'budget.percentOfIncluded',
  'forecast.projectedCredits',
  'forecast.projectedCost',
  'velocity.creditsPerHour',
  'window7d.credits',
]);

/** Legacy paths that are the same number as a flat metric. */
const ALIASES = new Map<string, FlatAlertMetric>([
  ['budget.usedCredits', 'month.credits'],
  ['budget.usedCost', 'month.cost'],
]);

/** Why a path with no flat metric is unsupported, by what it starts or ends with. */
const UNSUPPORTED: Array<[RegExp, string]> = [
  [/^vars(\.|\[|$)/, 'user variables (vars) are not supported'],
  [/^group(\.|\[|$)/, 'rule groups are not supported'],
  [/^(billing|signedIn)(\.|\[|$)/, 'GitHub billing values are not flat metrics'],
  [/^now(\.|\[|$)/, 'time-of-day values (now.*) are not flat metrics'],
  [/^(topModel|topSurface|topRepo|surface)(\.|\[|$)/, 'top-model, top-repo and per-surface values are not flat metrics'],
  [/^branchBudgets(\.|\[|$)/, 'per-branch caps are the branchBudgets setting, not a metric'],
  [/(^|\.)tokens$/, 'token counts are not flat metrics'],
];

/** The flat metric for a legacy var path, or why there is none. */
export function mapLegacyVar(path: string): Parsed<FlatAlertMetric> {
  const segments = parseVarPath(path);
  if (!segments) return fail(`"${path}" is not a valid variable path`);
  const [first, second, third, ...rest] = segments;
  const pair = `${first}.${second}`;
  if (segments.length === 1 && first === 'currentBranchCredits') return { ok: true, value: 'currentBranchCredits' };
  if (segments.length === 2 && DIRECT_METRICS.has(pair)) return { ok: true, value: pair as FlatAlertMetric };
  const alias = segments.length === 2 ? ALIASES.get(pair) : undefined;
  if (alias) return { ok: true, value: alias };
  if ((first === 'model' || first === 'repo') && second && (third === 'credits' || third === 'cost') && rest.length === 0) {
    return { ok: true, value: `${first}:${second}.${third}` };
  }
  const reason = UNSUPPORTED.find(([pattern]) => pattern.test(path))?.[1];
  return fail(reason ? `"${path}": ${reason}` : `"${path}" has no flat-alert metric`);
}

// ── Single comparisons ───────────────────────────────────────────────────────

/** The same comparison with its operands swapped. */
const SWAPPED: Record<FlatOp, FlatOp> = { '>': '<', '>=': '<=', '<': '>', '<=': '>=', '==': '==', '!=': '!=' };
const FLAT_OPS = new Set<string>(Object.keys(SWAPPED));

function isVar(operand: unknown): operand is { var: string } {
  return typeof operand === 'object' && operand !== null && typeof (operand as { var?: unknown }).var === 'string';
}

function literalNumber(operand: unknown): Parsed<number> {
  const n = toNumeric(operand);
  return n === null ? fail(`the value ${JSON.stringify(operand)} is not a number`) : { ok: true, value: n };
}

/** `var op literal` (or `literal op var`, which is flipped) as a flat comparison. */
function comparisonOf(op: string, left: unknown, right: unknown): Parsed<Comparison> {
  if (!FLAT_OPS.has(op)) return fail(`the operator "${op}" is not supported (use > >= < <= == !=)`);
  const flatOp = op as FlatOp;
  let variable: string;
  let literal: unknown;
  let direction: FlatOp;
  if (isVar(left) && isVar(right)) {
    return fail(`it compares two variables (${left.var} and ${right.var}), and flat rules compare a metric with a number`);
  }
  if (isVar(left)) [variable, literal, direction] = [left.var, right, flatOp];
  else if (isVar(right)) [variable, literal, direction] = [right.var, left, SWAPPED[flatOp]];
  else return fail('it compares two literal values, so it does not depend on any metric');
  const metric = mapLegacyVar(variable);
  if (!metric.ok) return metric;
  const value = literalNumber(literal);
  if (!value.ok) return value;
  return { ok: true, value: { metric: metric.value, op: direction, value: value.value } };
}

/** A `when` / `reEnableWhen` condition as one flat comparison. */
function conditionComparison(cond: LegacyCondition): Parsed<Comparison> {
  if (typeof cond === 'boolean') return fail(`it is the constant condition ${String(cond)}`);
  const key = Object.keys(cond)[0] ?? '';
  if (key === 'and' || key === 'or' || key === 'not') {
    return fail(`it uses "${key}", and flat rules are a single comparison of one metric`);
  }
  if (key === 'var') return fail('it is a truthy check on a variable, which has no flat equivalent');
  const operands: unknown = (cond as unknown as Record<string, unknown>)[key];
  if (!Array.isArray(operands) || operands.length !== 2) return fail('it is not a comparison of two operands');
  return comparisonOf(key, operands[0], operands[1]);
}

function levelComparison(level: LegacyComparison): Parsed<Comparison> {
  if (level.op === 'in' || level.op === 'matches') return fail(`the operator "${level.op}" is not supported`);
  return comparisonOf(level.op, { var: level.field }, level.value);
}

// ── Rules ────────────────────────────────────────────────────────────────────

interface Shared {
  notify: boolean | undefined;
  restrict: LegacyRule['restrict'];
}

/** `restrict.reEnableWhen` as the `clearBelow` of a rule on `metric`. */
function clearBelowOf(restrict: NonNullable<LegacyRule['restrict']>, metric: FlatAlertMetric): Parsed<number | undefined> {
  if (restrict.reEnableWhen === undefined) return { ok: true, value: undefined };
  const parsed = conditionComparison(restrict.reEnableWhen);
  if (!parsed.ok) return fail(`restrict.reEnableWhen cannot be converted (${parsed.reason})`);
  const { metric: reEnableMetric, op, value } = parsed.value;
  if (reEnableMetric !== metric || (op !== '<' && op !== '<=')) {
    return fail(`restrict.reEnableWhen must be "${metric} <" (or "<=") a number to become clearBelow`);
  }
  return { ok: true, value };
}

function validCooldown(...candidates: Array<string | undefined>): string {
  const found = candidates.find((c): c is string => c !== undefined && parseDurationMs(c) !== null);
  return found ?? DEFAULT_FLAT_COOLDOWN;
}

function flatRule(
  id: string,
  comparison: Comparison,
  severity: FlatAlertRule['severity'],
  cooldown: string,
  shared: Shared,
): Parsed<FlatAlertRule> {
  const clear = shared.restrict ? clearBelowOf(shared.restrict, comparison.metric) : { ok: true as const, value: undefined };
  if (!clear.ok) return clear;
  return {
    ok: true,
    value: {
      id,
      metric: comparison.metric,
      op: comparison.op,
      value: comparison.value,
      cooldown,
      severity,
      ...(shared.notify !== undefined ? { notify: shared.notify } : {}),
      ...(shared.restrict ? { restrict: true } : {}),
      ...(clear.value !== undefined ? { clearBelow: clear.value } : {}),
    },
  };
}

/** Why the gates (`requiresAuth`, `active`, `snoozeUntil`) rule out a conversion, if they do. */
function gateReason(rule: LegacyRule, groups: readonly LegacyGroup[], now: number | undefined): string | undefined {
  if (rule.requiresAuth) return 'requiresAuth: flat rules cannot depend on being signed in to GitHub';
  if (rule.active !== undefined) {
    const path = isVar(rule.active) ? parseVarPath(rule.active.var) : null;
    const ref = path?.length === 2 && path[0] === 'group' ? path[1] : undefined;
    if (ref === undefined) return 'it has an "active" gate, and flat rules have no extra conditions';
    const group = groups.find((g) => g.id === ref);
    const state = typeof group?.active === 'boolean' ? ` (currently ${group.active ? 'on' : 'off'})` : '';
    return `it belongs to the rule group "${ref}"${state}, and groups are not supported`;
  }
  if (rule.snoozeUntil) {
    const until = new Date(rule.snoozeUntil).getTime();
    if (!isNaN(until) && (now === undefined || until > now)) return `it is snoozed until ${rule.snoozeUntil}`;
  }
  return undefined;
}

function triggerComparisons(rule: LegacyRule): Parsed<Array<{ comparison: Comparison; level?: LegacyThresholdLevel }>> {
  if (rule.thresholds?.length) {
    const out: Array<{ comparison: Comparison; level: LegacyThresholdLevel }> = [];
    for (const [i, level] of rule.thresholds.entries()) {
      const parsed = levelComparison(level);
      if (!parsed.ok) return fail(`threshold level ${i + 1}: ${parsed.reason}`);
      out.push({ comparison: parsed.value, level });
    }
    return { ok: true, value: out };
  }
  if (rule.when !== undefined) {
    const parsed = conditionComparison(rule.when);
    return parsed.ok ? { ok: true, value: [{ comparison: parsed.value }] } : fail(`"when": ${parsed.reason}`);
  }
  const conditions = rule.conditions ?? [];
  if (conditions.length === 0) return fail('it has no thresholds, "when" or conditions');
  if (conditions.length > 1) return fail(`it has ${conditions.length} conditions, and flat rules are a single comparison`);
  if (rule.match === 'none') return fail('match "none" negates the condition, which flat rules cannot express');
  const parsed = levelComparison(conditions[0]!);
  return parsed.ok ? { ok: true, value: [{ comparison: parsed.value }] } : fail(`condition: ${parsed.reason}`);
}

/** One rule as flat rules (several for `thresholds`), or why it cannot be converted. */
function convertRule(rule: LegacyRule, groups: readonly LegacyGroup[], now: number | undefined): Parsed<FlatAlertRule[]> {
  if (typeof rule.id !== 'string' || rule.id === '') return fail('it has no id');
  const gate = gateReason(rule, groups, now);
  const trigger = triggerComparisons(rule);
  if (gate || !trigger.ok) return fail([gate, trigger.ok ? undefined : trigger.reason].filter(Boolean).join('; '));
  const shared: Shared = { notify: rule.notify, restrict: rule.restrict };
  const made: FlatAlertRule[] = [];
  for (const [i, { comparison, level }] of trigger.value.entries()) {
    const id = level ? `${rule.id}:${i + 1}` : rule.id;
    const built = flatRule(id, comparison, level ? level.severity : rule.severity, validCooldown(level?.cooldown, rule.cooldown), shared);
    if (!built.ok) return fail(level ? `threshold level ${i + 1}: ${built.reason}` : built.reason);
    made.push(built.value);
  }
  return { ok: true, value: made };
}

/**
 * Convert the legacy rules. `groups` (the document's rule groups) only sharpens
 * the reason given for a rule gated on one. Rules are independent: one that
 * cannot be converted (or is malformed beyond reading) never affects its
 * siblings.
 */
export function convertLegacyRules(
  rules: readonly LegacyRule[],
  groups: readonly LegacyGroup[] = [],
  options: LegacyImportOptions = {},
): LegacyImportResult {
  const converted: FlatAlertRule[] = [];
  const skipped: LegacyImportResult['skipped'] = [];
  const taken = new Set<string>();

  for (const rule of rules) {
    const label = typeof rule.id === 'string' ? rule.id : '(no id)';
    let result: Parsed<FlatAlertRule[]>;
    try {
      result = convertRule(rule, groups, options.now);
    } catch (err) {
      result = fail(`it is malformed (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!result.ok) {
      skipped.push({ id: label, reason: result.reason });
      continue;
    }
    const clash = result.value.find((m) => taken.has(m.id));
    if (clash) {
      skipped.push({ id: label, reason: `its id "${clash.id}" is already used by another converted rule` });
      continue;
    }
    for (const m of result.value) taken.add(m.id);
    converted.push(...result.value);
  }
  return { converted, skipped };
}

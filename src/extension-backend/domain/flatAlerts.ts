/**
 * Flat alert rules (stream C, pure part): the fixed metric list, per-rule
 * evaluation with cooldowns, the built-in alerts expressed as default rules,
 * and the zod schema that validates a user-authored rule list.
 *
 * A flat rule is `metric op value`, nothing else (see `FlatAlertRule` in
 * contracts.ts). There is no rules language, no templates and no `and`/`or`:
 * everything the old JSON rules could say that mattered is a threshold on one
 * of a fixed list of metrics.
 *
 * Pure and webview-safe: no vscode, no Node, no clock (callers pass `now`). The
 * old rules language (`alertRules.ts`, `expr/`) is untouched; this module reuses
 * only its context builder, `compare()` and `parseDurationMs` and is wired in
 * later. Restriction lives in `flatRestriction.ts`, the legacy importer in
 * `flatAlertImport.ts`.
 *
 * Metrics (the context is `buildRuleContext`, so every number is exactly what a
 * legacy rule read):
 *
 *   today.credits  today.cost  month.credits  month.cost
 *   budget.percentOfBudget  budget.percentOfIncluded
 *   forecast.projectedCredits  forecast.projectedCost
 *   velocity.creditsPerHour  window7d.credits  currentBranchCredits
 *   model:<id>.credits  model:<id>.cost  repo:<name>.credits  repo:<name>.cost
 *
 * Comparison semantics are the legacy `compare()`: an unavailable metric (no
 * snapshot, no day-level data for `window7d`, a model or repo that is not in the
 * snapshot) is nil, and a nil operand makes every operator false EXCEPT `!=`.
 *
 * Message format (fixed): `<metric> <op> <value> (now <current>)`, for example
 * `today.credits > 80 (now 95)`. `current` is an integer as is, otherwise two
 * decimals, or `n/a` when the metric is unavailable.
 *
 * Cooldowns. State is a plain `Record<string, number>` (key to last-fired
 * epoch ms) so the caller can keep it in `globalState`. The key is the rule id,
 * plus the period for metrics that reset with one: `@YYYY-MM-DD` (local day) for
 * `today.*`, `@YYYY-MM` for `month.*`, `budget.*` and `forecast.*`. A new
 * period is therefore a new key, which is what re-fires the 80 % alert on the
 * first snapshot of a new month. A rule may fire again only once MORE than its
 * cooldown has elapsed (the rule `cooldown`, default 1 h): that is the
 * boundary the built-in alerts always had (`now - last > cooldown`); the old
 * rules language allowed firing at exactly the cooldown.
 *
 * Escalation ladders ("one toast per band"). Rules whose ids are `<base>:<n>`
 * (`builtin:budget:80`, `builtin:budget:100`, or the `<id>:<n>` levels the
 * legacy importer produces from `thresholds`) share a ladder per `<base>`. When
 * several toasting rules of one ladder hold at once, only the highest severity
 * one (the first on a tie) is considered, and it is then subject to its own
 * cooldown. That is what keeps today's behaviour for the 80 % / 100 % budget
 * pair (a 100 % reading raises the "exceeded" toast, never also the 80 % one,
 * and an exceeded budget on cooldown stays quiet instead of falling back to the
 * 80 % toast) and for `thresholds` rules (the highest matching level wins).
 * Silent (`notify: false`) and `restrict` rules never join a ladder: they do
 * not toast, so they must not hide one that does.
 */
import { z } from 'zod';
import { opt } from '../util/lang';
import { bucketKey } from '../util/time';
import { parseDurationMs } from './alertRules';
import type { FlatAlertMetric, FlatAlertRule } from './contracts';
import { buildRuleContext } from './expr/context';
import type { HistorySample, RuleSnapshot } from './expr/context';
import { compare } from './expr/jsonCondition';
import type { UserConfig } from './types';

// ── Metrics ──────────────────────────────────────────────────────────────────

/** Which calendar period a metric's value resets with; its cooldown key carries that period. */
type Period = 'day' | 'month';

const FIXED_METRIC_PERIOD = {
  'today.credits': 'day',
  'today.cost': 'day',
  'month.credits': 'month',
  'month.cost': 'month',
  'budget.percentOfBudget': 'month',
  'budget.percentOfIncluded': 'month',
  'forecast.projectedCredits': 'month',
  'forecast.projectedCost': 'month',
  'velocity.creditsPerHour': undefined,
  'window7d.credits': undefined,
  currentBranchCredits: undefined,
} as const satisfies Record<string, Period | undefined>;

type FixedMetric = keyof typeof FIXED_METRIC_PERIOD;

/** The fixed (non keyed) metrics, in documentation order. */
export const FIXED_FLAT_METRICS = Object.keys(FIXED_METRIC_PERIOD) as FixedMetric[];

/** The keyed forms are `model:<id>.credits|cost` and `repo:<name>.credits|cost`; ids may contain dots. */
const KEYED_METRIC = /^(model|repo):([\s\S]+)\.(credits|cost)$/;

function isFixedMetric(metric: string): metric is FixedMetric {
  return Object.prototype.hasOwnProperty.call(FIXED_METRIC_PERIOD, metric);
}

/** True for every metric name a flat rule may use (the fixed list plus the keyed forms). */
export function isFlatAlertMetric(metric: string): metric is FlatAlertMetric {
  return isFixedMetric(metric) || KEYED_METRIC.test(metric);
}

function metricPeriod(metric: FlatAlertMetric): Period | undefined {
  return isFixedMetric(metric) ? FIXED_METRIC_PERIOD[metric] : undefined;
}

/**
 * The values flat rules read: the legacy rule context plus whether a snapshot
 * existed at all (`buildRuleContext` reports zeros for "no snapshot", which
 * must not satisfy a `<` rule).
 */
export interface FlatContext {
  readonly values: Readonly<Record<string, unknown>>;
  readonly available: boolean;
}

export interface FlatContextInput {
  /** The unfiltered snapshot, or null when there is none yet. */
  snapshot: RuleSnapshot | null;
  /**
   * Recent `todayCredits` samples (oldest first). Without them
   * `velocity.creditsPerHour` is 0, so pass them wherever the context feeds
   * alerts OR restrictions.
   */
  history?: HistorySample[];
  now: number;
}

export function buildFlatContext(input: FlatContextInput): FlatContext {
  return {
    values: buildRuleContext({ snapshot: input.snapshot, ...opt('history', input.history), now: input.now }),
    available: input.snapshot !== null,
  };
}

/** Walk own properties only, so `constructor` and `__proto__` never resolve. */
function walkOwn(root: unknown, segments: readonly string[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The metric's current value, or undefined when it is unavailable. */
export function metricValue(metric: FlatAlertMetric, ctx: FlatContext): number | undefined {
  if (!ctx.available) return undefined;
  const keyed = KEYED_METRIC.exec(metric);
  const segments = keyed ? [keyed[1]!, keyed[2]!, keyed[3]!] : metric.split('.');
  const value = walkOwn(ctx.values, segments);
  return typeof value === 'number' ? value : undefined;
}

/** Whether the rule's comparison holds right now (cooldowns are not considered). */
export function flatRuleMatches(rule: FlatAlertRule, ctx: FlatContext): boolean {
  return compare(metricValue(rule.metric, ctx), rule.value, rule.op);
}

function formatNumber(value: number | undefined): string {
  if (value === undefined) return 'n/a';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** The fixed-format message for a rule and the metric's current value. */
export function flatAlertMessage(rule: FlatAlertRule, current: number | undefined): string {
  return `${rule.metric} ${rule.op} ${rule.value} (now ${formatNumber(current)})`;
}

// ── Cooldowns ────────────────────────────────────────────────────────────────

export const DEFAULT_FLAT_COOLDOWN = '1h';
const DEFAULT_COOLDOWN_MS = 60 * 60_000;
/** Keys that belong to no current rule (a removed rule, or the branch cap of another branch) are kept this long. */
export const ORPHAN_COOLDOWN_RETENTION_MS = 86_400_000;

/** Cooldown bookkeeping: key to the epoch ms the rule last fired. Plain data, safe to persist. */
export type FlatCooldownState = Record<string, number>;

/** A rule's cooldown in ms: its own `cooldown`, else the 1 h default (as the legacy rules did). */
export function flatCooldownMs(rule: Pick<FlatAlertRule, 'cooldown'>): number {
  return parseDurationMs(rule.cooldown) ?? DEFAULT_COOLDOWN_MS;
}

/** The cooldown key for a firing at `at`: the rule id, plus the local day or month the metric resets with. */
export function flatCooldownKey(rule: FlatAlertRule, at: number): string {
  const period = metricPeriod(rule.metric);
  return period === undefined ? rule.id : `${rule.id}@${bucketKey(at, period)}`;
}

/** Own-property write that is safe for any key (a rule id of `__proto__` included). */
function setOwn(target: FlatCooldownState, key: string, value: number): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** A firing in the future (a clock that jumped back) never blocks. */
function blocking(last: number, now: number, cooldownMs: number): boolean {
  return last <= now && now - last <= cooldownMs;
}

function lastFired(state: FlatCooldownState, key: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : undefined;
}

/**
 * Sanitise persisted cooldown state: anything that is not an object of finite
 * numbers is dropped, entry by entry.
 */
export function parseCooldownState(raw: unknown): FlatCooldownState {
  const out: FlatCooldownState = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'number' && Number.isFinite(value)) setOwn(out, key, value);
  }
  return out;
}

/**
 * Forget cooldown entries that can no longer block anything: each entry is
 * judged by the cooldown of the rule that owns it (the rule whose key at the
 * entry's own timestamp is that key), not by a flat retention. Entries no rule
 * owns are kept for {@link ORPHAN_COOLDOWN_RETENTION_MS}.
 */
export function pruneCooldowns(
  state: FlatCooldownState,
  rules: readonly FlatAlertRule[],
  now: number,
): FlatCooldownState {
  const out: FlatCooldownState = {};
  for (const [key, last] of Object.entries(state)) {
    const owner = rules.find((rule) => flatCooldownKey(rule, last) === key);
    const retention = owner ? flatCooldownMs(owner) : ORPHAN_COOLDOWN_RETENTION_MS;
    if (blocking(last, now, retention)) setOwn(out, key, last);
  }
  return out;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

export interface FlatAlertMatch {
  rule: FlatAlertRule;
  /** The cooldown key this firing was recorded under. */
  key: string;
  severity: FlatAlertRule['severity'];
  /** Fixed-format message, see the file header. */
  message: string;
  /** The metric's value when the rule matched. */
  value: number | undefined;
  /** Show a toast: `notify` is not false and the rule is not a restriction (those get their own popup). */
  notify: boolean;
  /** The rule also engages the restriction. */
  restrict: boolean;
}

export interface FlatEvaluation {
  /** Rules that fire now, in rule order. */
  matches: FlatAlertMatch[];
  /** The input state plus the keys fired now. The input object is never modified. */
  state: FlatCooldownState;
}

const SEVERITY_RANK: Record<FlatAlertRule['severity'], number> = { info: 0, warning: 1, critical: 2 };
const LADDER_ID = /^(.+):\d+$/;

function toasts(rule: FlatAlertRule): boolean {
  return rule.notify !== false && rule.restrict !== true;
}

function ladderOf(rule: FlatAlertRule): string | undefined {
  return toasts(rule) ? LADDER_ID.exec(rule.id)?.[1] : undefined;
}

/** Keep only the highest severity rule (first on a tie) of each escalation ladder. */
function applyLadders(rules: readonly FlatAlertRule[]): FlatAlertRule[] {
  const winner = new Map<string, FlatAlertRule>();
  for (const rule of rules) {
    const ladder = ladderOf(rule);
    if (ladder === undefined) continue;
    const incumbent = winner.get(ladder);
    if (!incumbent || SEVERITY_RANK[rule.severity] > SEVERITY_RANK[incumbent.severity]) winner.set(ladder, rule);
  }
  return rules.filter((rule) => {
    const ladder = ladderOf(rule);
    return ladder === undefined || winner.get(ladder) === rule;
  });
}

/**
 * Evaluate the rules against the context: which fire now, given when each last
 * fired. Pure: the returned `state` is a new object.
 */
export function evaluateFlatRules(
  rules: readonly FlatAlertRule[],
  ctx: FlatContext,
  state: FlatCooldownState,
  now: number,
): FlatEvaluation {
  const next: FlatCooldownState = { ...state };
  const matches: FlatAlertMatch[] = [];
  for (const rule of applyLadders(rules.filter((r) => flatRuleMatches(r, ctx)))) {
    const key = flatCooldownKey(rule, now);
    const last = lastFired(next, key);
    if (last !== undefined && blocking(last, now, flatCooldownMs(rule))) continue;
    setOwn(next, key, now);
    const value = metricValue(rule.metric, ctx);
    matches.push({
      rule,
      key,
      severity: rule.severity,
      message: flatAlertMessage(rule, value),
      value,
      notify: toasts(rule),
      restrict: rule.restrict === true,
    });
  }
  return { matches, state: next };
}

// ── Built-in alerts as default rules ─────────────────────────────────────────

/** The scalar settings that drive the built-in alerts. */
export type BuiltinAlertConfig = Pick<UserConfig, 'monthlyBudget' | 'dailyCreditAlert' | 'alerts' | 'branchBudgets'>;

/** Ids of the built-in rules (the branch cap's id continues with `:<branch>`). */
export const BUILTIN_RULE_IDS = {
  budget80: 'builtin:budget:80',
  budget100: 'builtin:budget:100',
  daily: 'builtin:daily',
  velocity: 'builtin:velocity',
  branchPrefix: 'builtin:branch:',
} as const;

const BUDGET_COOLDOWN = '4h';

/**
 * Today's four built-in alerts as flat rules, in the order they were
 * evaluated (budget, daily, velocity, branch):
 *
 * - budget: `budget.percentOfBudget >= 0.8` (warning) and `>= 1` (critical),
 *   4 h each, only with `monthlyBudget > 0`. The two ids form the
 *   `builtin:budget` ladder (see the file header), which is what makes a
 *   reading in the 80-100 % band toast "80 %" and a reading at or over 100 %
 *   toast "exceeded" only.
 * - daily: `today.credits >= dailyCreditAlert`, 24 h, only when it is > 0.
 * - velocity: `velocity.creditsPerHour >= alerts.velocityCreditsPerHour`, 1 h,
 *   when enabled and > 0. This reads the least-squares rate (D7), the same
 *   number user rules and restrictions see.
 * - branch cap: `currentBranchCredits >= branchBudgets[currentBranch]`, 4 h,
 *   keyed by branch name; only for the current branch.
 *
 * `includedCredits` drives no alert (it only colours the gauge).
 */
export function builtinFlatRules(config: BuiltinAlertConfig, currentBranch?: string | null): FlatAlertRule[] {
  const rules: FlatAlertRule[] = [];
  if (config.monthlyBudget > 0) {
    rules.push(
      { id: BUILTIN_RULE_IDS.budget80, metric: 'budget.percentOfBudget', op: '>=', value: 0.8, cooldown: BUDGET_COOLDOWN, severity: 'warning' },
      { id: BUILTIN_RULE_IDS.budget100, metric: 'budget.percentOfBudget', op: '>=', value: 1, cooldown: BUDGET_COOLDOWN, severity: 'critical' },
    );
  }
  if (config.dailyCreditAlert > 0) {
    rules.push({ id: BUILTIN_RULE_IDS.daily, metric: 'today.credits', op: '>=', value: config.dailyCreditAlert, cooldown: '24h', severity: 'warning' });
  }
  if (config.alerts.velocityEnabled && config.alerts.velocityCreditsPerHour > 0) {
    rules.push({
      id: BUILTIN_RULE_IDS.velocity,
      metric: 'velocity.creditsPerHour',
      op: '>=',
      value: config.alerts.velocityCreditsPerHour,
      cooldown: '1h',
      severity: 'warning',
    });
  }
  const caps = config.branchBudgets;
  if (currentBranch && caps && Object.prototype.hasOwnProperty.call(caps, currentBranch)) {
    const cap = caps[currentBranch];
    if (typeof cap === 'number') {
      rules.push({
        id: `${BUILTIN_RULE_IDS.branchPrefix}${currentBranch}`,
        metric: 'currentBranchCredits',
        op: '>=',
        value: cap,
        cooldown: BUDGET_COOLDOWN,
        severity: 'warning',
      });
    }
  }
  return rules;
}

// ── Validation ───────────────────────────────────────────────────────────────

const COOLDOWN_MESSAGE =
  'cooldown must be a positive number followed by m, h, d or w (for example "30m", "1.5h", "2d", "1w")';

/**
 * One flat rule as a user writes it. `cooldown` defaults to 1 h and `severity`
 * to "warning"; unknown keys are ignored. Use {@link parseFlatRules} for a
 * list: it keeps the valid rules when one entry is bad.
 */
export const FlatAlertRuleSchema = z.object({
  id: z.string().min(1),
  metric: z.string().refine(isFlatAlertMetric, {
    message: `unknown metric (use ${FIXED_FLAT_METRICS.join(', ')}, model:<id>.credits|cost or repo:<name>.credits|cost)`,
  }),
  op: z.enum(['>', '>=', '<', '<=', '==', '!=']),
  value: z.number(),
  cooldown: z
    .string()
    .refine((v) => parseDurationMs(v) !== null, { message: COOLDOWN_MESSAGE })
    .default(DEFAULT_FLAT_COOLDOWN),
  severity: z.enum(['info', 'warning', 'critical']).default('warning'),
  notify: z.boolean().optional(),
  restrict: z.boolean().optional(),
  clearBelow: z.number().optional(),
});

export interface FlatRuleParseError {
  /** Position in the input list, or -1 when the list itself is not an array. */
  index: number;
  id: string | undefined;
  message: string;
}

export interface FlatRuleParseResult {
  rules: FlatAlertRule[];
  errors: FlatRuleParseError[];
}

/**
 * Validate a user-authored rule list entry by entry: an invalid rule (or a
 * second rule with an id already taken) is dropped and reported, its siblings
 * are kept. `undefined` (the setting is absent) is an empty list.
 */
export function parseFlatRules(raw: unknown): FlatRuleParseResult {
  if (raw === undefined) return { rules: [], errors: [] };
  if (!Array.isArray(raw)) {
    return { rules: [], errors: [{ index: -1, id: undefined, message: 'alert rules must be an array' }] };
  }
  const rules: FlatAlertRule[] = [];
  const errors: FlatRuleParseError[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const itemId = (item as { id?: unknown } | null)?.id;
    const id = typeof itemId === 'string' ? itemId : undefined;
    const parsed = FlatAlertRuleSchema.safeParse(item);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const where = issue.path.join('.');
      errors.push({ index, id, message: where ? `${where}: ${issue.message}` : issue.message });
      return;
    }
    const r = parsed.data;
    if (seen.has(r.id)) {
      errors.push({ index, id: r.id, message: `duplicate rule id "${r.id}"` });
      return;
    }
    seen.add(r.id);
    rules.push({
      id: r.id,
      metric: r.metric as FlatAlertMetric,
      op: r.op,
      value: r.value,
      cooldown: r.cooldown,
      severity: r.severity,
      ...opt('notify', r.notify),
      ...opt('restrict', r.restrict),
      ...opt('clearBelow', r.clearBelow),
    });
  });
  return { rules, errors };
}

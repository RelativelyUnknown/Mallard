/* c8 ignore next */
/**
 * Alert-rule evaluation: turns the user-authored JSON rules document into the
 * AlertFireResult[] the host surfaces as toast messages. Pure.
 */
import { z } from 'zod';
import { AlertRule, AlertGroup, JsonCondition, ThresholdLevel } from './types';
import {
  evalCondition,
  evalRule,
  evalSimpleCondition,
  JsonConditionSchema,
  MAX_MATCH_PATTERN,
  parseVarPath,
  resolveVar,
} from './expr/jsonCondition';
import { buildRuleContext, EvalBuildInput } from './expr/context';

const RestrictSchema = z.object({
  reEnableWhen: JsonConditionSchema.optional(),
});

const SimpleConditionBase = z.object({
  field: z.string().min(1),
  op: z.enum(['>', '>=', '<', '<=', '==', '!=', 'in', 'matches']),
  value: z.union([
    z.number(),
    z.string(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
  ]),
});

/** `matches` takes a wildcard pattern string, never a regex (see wildcardMatches). */
function hasValidMatchPattern(c: { op: string; value: unknown }): boolean {
  return c.op !== 'matches' || (typeof c.value === 'string' && c.value.length <= MAX_MATCH_PATTERN);
}
const MATCH_PATTERN_MESSAGE = `"matches" needs a string pattern of at most ${MAX_MATCH_PATTERN} characters ('*' = any run, '?' = one character; not a regex)`;

const SimpleConditionSchema = SimpleConditionBase.refine(hasValidMatchPattern, {
  message: MATCH_PATTERN_MESSAGE,
  path: ['value'],
});

/** Cooldown text: a positive number (optionally decimal) + m/h/d/w, case-insensitive, e.g. "30m", "1.5h", "2D". */
const COOLDOWN_MESSAGE = 'cooldown must be a positive number followed by m, h, d or w (for example "30m", "1.5h", "2d", "1w")';
const CooldownSchema = z.string().refine((v) => parseDurationMs(v) !== null, { message: COOLDOWN_MESSAGE });

const ThresholdLevelSchema = SimpleConditionBase.extend({
  severity: z.enum(['info', 'warning', 'critical']),
  cooldown: CooldownSchema.optional(),
}).refine(hasValidMatchPattern, { message: MATCH_PATTERN_MESSAGE, path: ['value'] });

/** Exported so UserConfigStore's ConfigSchema validates rules with the SAME
 *  shape — a divergent inline copy silently rejected documented rule fields
 *  (conditions/match/thresholds/snoozeUntil) and dropped the whole config.
 *
 *  A rule needs at least one trigger form. If several are present the
 *  precedence is thresholds > when > conditions (see matchRule); the extra
 *  forms are ignored rather than rejected so existing configs keep loading. */
export const RuleSchema = z
  .object({
    id: z.string().min(1),
    severity: z.enum(['info', 'warning', 'critical']).default('warning'),
    cooldown: CooldownSchema.optional(),
    message: z.string(),
    when: JsonConditionSchema.optional(),
    conditions: z.array(SimpleConditionSchema).optional(),
    match: z.enum(['all', 'any', 'none']).optional(),
    active: JsonConditionSchema.optional(),
    requiresAuth: z.boolean().optional(),
    notify: z.boolean().optional(),
    restrict: RestrictSchema.optional(),
    thresholds: z.array(ThresholdLevelSchema).optional(),
    snoozeUntil: z.string().optional(),
  })
  .refine(
    (r) =>
      r.when !== undefined ||
      (r.conditions !== undefined && r.conditions.length > 0) ||
      (r.thresholds !== undefined && r.thresholds.length > 0),
    { message: 'A rule must have "when", "conditions", or "thresholds"' },
  );

export const GroupSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  active: JsonConditionSchema,
});

export const VarsSchema = z.record(
  z.string(),
  z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
);

const DocSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]).optional(),
    vars: VarsSchema.optional(),
    groups: z.array(GroupSchema).optional(),
    rules: z.array(RuleSchema).optional(),
    budget: z
      .object({
        monthlyUsd: z.number(),
        includedCredits: z.number(),
      })
      .optional(),
  })
  .partial();

type ParseRuleError = { ruleId: string; field: string; message: string };
type ParsedDoc = { version: 1 | 2; vars: Record<string, unknown>; groups: AlertGroup[]; rules: AlertRule[] };

export type ParseAlertRulesResult =
  | { ok: true; doc: ParsedDoc; errors: ParseRuleError[] }
  | { ok: false; doc: ParsedDoc; errors: ParseRuleError[] };

export function parseAlertRules(input: unknown): ParseAlertRulesResult {
  const parsed = DocSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      doc: { version: 1, vars: {}, groups: [], rules: [] },
      errors: parsed.error.issues.map((i) => ({
        ruleId: '<document>',
        field: i.path.join('.'),
        message: i.message,
      })),
    };
  }
  const parsedDoc = parsed.data;
  const rules: AlertRule[] = (parsedDoc.rules ?? []).map((r) => ({
    id: r.id,
    severity: r.severity,
    ...(r.cooldown !== undefined ? { cooldown: r.cooldown } : {}),
    message: r.message,
    ...(r.when !== undefined ? { when: r.when } : {}),
    ...(r.conditions !== undefined ? { conditions: r.conditions } : {}),
    ...(r.match !== undefined ? { match: r.match } : {}),
    ...(r.active !== undefined ? { active: r.active } : {}),
    ...(r.requiresAuth !== undefined ? { requiresAuth: r.requiresAuth } : {}),
    ...(r.notify !== undefined ? { notify: r.notify } : {}),
    ...(r.restrict !== undefined
      ? {
          restrict: {
            ...(r.restrict.reEnableWhen !== undefined
              ? { reEnableWhen: r.restrict.reEnableWhen }
              : {}),
          },
        }
      : {}),
    ...(r.thresholds !== undefined
      ? {
          thresholds: r.thresholds.map((t) => ({
            field: t.field,
            op: t.op,
            value: t.value,
            severity: t.severity,
            ...(t.cooldown !== undefined ? { cooldown: t.cooldown } : {}),
          })),
        }
      : {}),
    ...(r.snoozeUntil !== undefined ? { snoozeUntil: r.snoozeUntil } : {}),
  }));
  const groups: AlertGroup[] = (parsedDoc.groups ?? []).map((g) => ({
    id: g.id,
    active: g.active,
    ...(g.label !== undefined ? { label: g.label } : {}),
  }));
  return {
    ok: true,
    doc: {
      version: (parsedDoc.version ?? 1) as 1 | 2,
      vars: (parsedDoc.vars as Record<string, unknown> | undefined) ?? {},
      groups,
      rules,
    },
    errors: [],
  };
}

export interface AlertFireResult {
  key: string;
  ruleId: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  rule: AlertRule;
}

const DEFAULT_COOLDOWN_MS = 60 * 60_000;
const DURATION_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const DURATION_PATTERN = /^(\d*\.?\d*)\s*([mhdw])$/i;

/**
 * Parse a cooldown/duration such as "30m", "1.5h", "2D", "1w" (positive number,
 * optional decimals, unit m/h/d/w in either case) into milliseconds. Returns
 * null for anything unparseable, zero, or too large to represent.
 */
export function parseDurationMs(duration: string): number | null {
  const match = DURATION_PATTERN.exec(duration.trim());
  if (!match || !/\d/.test(match[1]!)) return null;
  const ms = Number(match[1]) * DURATION_UNIT_MS[match[2]!.toLowerCase()]!;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** Runtime cooldown: an unset or invalid duration falls back (invalid ones are reported by parseAlertRules). */
function durationToMs(duration: string | undefined, fallback: number): number {
  if (!duration) return fallback;
  return parseDurationMs(duration) ?? fallback;
}

/**
 * `{{ path }}` placeholders. The path is a dotted path of word characters,
 * optionally with bracket segments for keys that contain dots:
 * `{{ model["gpt-4.1"].credits }}`. Anything else in braces is left as written.
 */
const TEMPLATE_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

function renderTemplate(msg: string, ctx: Record<string, unknown>): string {
  return msg.replace(TEMPLATE_PLACEHOLDER, (full: string, raw: string) => {
    const varPath = raw.trim();
    if (!/^\w/.test(varPath) || parseVarPath(varPath, { wordSegments: true }) === null) return full;
    const value = resolveVar(varPath, ctx);
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') {
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
    }
    return String(value);
  });
}

export interface EvaluateInput extends EvalBuildInput {
  rules: AlertRule[];
  groups?: AlertGroup[];
  fired: Map<string, number>;
  now?: number;
}

type Severity = AlertRule['severity'];
const SEVERITY_RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

/**
 * THE rule-matching decision, shared by alerts (evaluateAlertRules) and
 * restrictions (evaluateRestrictionState) so the two can never disagree about
 * whether a rule currently holds. Returns the severity the rule matched at,
 * or null when it does not hold.
 *
 * Gates, in order — any failing gate means "no match":
 *   1. `requiresAuth` and not signed in
 *   2. `active` condition false
 *   3. `snoozeUntil` still in the future (unparseable dates never snooze)
 * Then the trigger. When several forms are present the precedence is
 * `thresholds` (non-empty) > `when` > `conditions` — the lower forms are
 * ignored, not combined. `thresholds` fire the highest-severity level whose
 * condition holds; the other forms fire at the rule's own `severity`.
 * Cooldowns are an alert-only concern and are NOT applied here.
 */
export function matchRule(rule: AlertRule, ctx: Record<string, unknown>, now: number): Severity | null {
  return matchLevel(rule, ctx, now)?.severity ?? null;
}

/** Boolean form of {@link matchRule}. */
export function ruleMatches(rule: AlertRule, ctx: Record<string, unknown>, now: number): boolean {
  return matchLevel(rule, ctx, now) !== null;
}

/** {@link matchRule} plus the matched threshold level's own cooldown, which alerts need. */
function matchLevel(
  rule: AlertRule,
  ctx: Record<string, unknown>,
  now: number,
): { severity: Severity; cooldown: string | undefined } | null {
  if (rule.requiresAuth && !ctx['signedIn']) return null;
  if (rule.active !== undefined && !evalCondition(rule.active, ctx)) return null;

  if (rule.snoozeUntil) {
    const snoozeUntilMs = new Date(rule.snoozeUntil).getTime();
    if (!isNaN(snoozeUntilMs) && now < snoozeUntilMs) return null;
  }

  if (rule.thresholds?.length) {
    let best: ThresholdLevel | null = null;
    for (const level of rule.thresholds) {
      if (!evalSimpleCondition(level, ctx)) continue;
      if (best === null || SEVERITY_RANK[level.severity] > SEVERITY_RANK[best.severity]) best = level;
    }
    return best && { severity: best.severity, cooldown: best.cooldown };
  }

  return evalRule(rule, ctx) ? { severity: rule.severity, cooldown: undefined } : null;
}

/** Evaluate one rule against `lastFired` (cooldown bookkeeping, read only). */
function evaluateRule(
  rule: AlertRule,
  ctx: Record<string, unknown>,
  lastFired: ReadonlyMap<string, number>,
  now: number,
): AlertFireResult | null {
  const matched = matchLevel(rule, ctx, now);
  if (matched === null) return null;
  const { severity } = matched;
  const key = `${rule.id}#${severity}`;
  const last = lastFired.get(key);
  const cooldownMs = durationToMs(matched.cooldown ?? rule.cooldown, DEFAULT_COOLDOWN_MS);
  if (last !== undefined && now - last < cooldownMs) return null;
  return { key, ruleId: rule.id, severity, message: renderTemplate(rule.message, ctx), rule };
}

export interface AlertEvaluation {
  /** Alerts to surface now, in rule order. */
  results: AlertFireResult[];
  /** Cooldown entries this evaluation consumed (key → fired-at). Apply them to the caller's map. */
  firedKeys: Map<string, number>;
}

/**
 * Pure alert evaluation: reads `input.fired` but never writes it. Callers that
 * keep a cooldown map apply `firedKeys` themselves (or use evaluateAlertRules).
 * Rules sharing an id+severity within one pass still debounce each other.
 */
export function computeAlertEvaluation(input: EvaluateInput): AlertEvaluation {
  const now = input.now ?? Date.now();

  // buildRuleContext also evaluates `groups` into ctx.group.<id>.
  const ctx = buildRuleContext({ ...input, now });

  const working = new Map(input.fired);
  const firedKeys = new Map<string, number>();
  const results: AlertFireResult[] = [];
  for (const rule of input.rules) {
    const result = evaluateRule(rule, ctx, working, now);
    if (!result) continue;
    working.set(result.key, now);
    firedKeys.set(result.key, now);
    results.push(result);
  }
  return { results, firedKeys };
}

/**
 * Evaluate the rules and record what fired into `input.fired` (the cooldown
 * map the caller owns). Thin stateful wrapper over {@link computeAlertEvaluation}.
 */
export function evaluateAlertRules(input: EvaluateInput): AlertFireResult[] {
  const { results, firedKeys } = computeAlertEvaluation(input);
  for (const [key, at] of firedKeys) input.fired.set(key, at);
  return results;
}

/**
 * Whether a fired rule should surface a plain notification toast. Rules with a
 * `restrict` block get their own popup (Dismiss/Snooze/Disable) from the
 * restriction engine instead, so they're excluded here to avoid a duplicate.
 */
export function shouldNotify(rule: AlertRule): boolean {
  return rule.notify !== false && !rule.restrict;
}

export type { JsonCondition };

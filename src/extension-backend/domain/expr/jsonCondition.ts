/* c8 ignore next */
/**
 * Minimal JSONLogic-inspired condition evaluator.
 *
 * Conditions are plain JSON objects — no custom DSL, no parser.
 * VS Code's JSON language server validates them against the bundled schema.
 *
 * Supported operators: >, >=, <, <=, ==, !=, and, or, not, var (truthy check)
 * Also: in, matches (structured `conditions` / `thresholds` via evalSimpleCondition)
 * Operands: number | string | boolean | { "var": "dot.path" }
 *
 * Var paths: dots separate segments (`today.credits`). A segment that itself
 * contains dots or other punctuation is written in brackets with quotes —
 * `model["gpt-4.1"].credits`, `repo['foo.js'].cost` — see {@link parseVarPath}.
 * Only an object's OWN properties are readable, so `constructor`/`__proto__`
 * never resolve to anything inherited.
 *
 * Comparison semantics (ONE definition, shared by evalCondition,
 * evalSimpleCondition and therefore every rule form):
 *   - A null/undefined operand (e.g. a var that does not resolve) makes every
 *     operator false, except `!=` which is true: "unknown" never satisfies a
 *     condition but is never equal to anything either.
 *   - Ordering operators (`<` `<=` `>` `>=`) need two numbers. Strings count
 *     only when they are canonical numerics ("12", "-3.5", "1e3"); booleans,
 *     other strings, NaN and infinities do not, and the result is false.
 *   - `==` / `!=` compare numerically when both operands are numbers or
 *     canonical numeric strings (so `50 == "50"`), otherwise strictly (`===`).
 *   - `in` uses the same equality as `==` against each listed value.
 *   - `matches` is a case-insensitive, anchored wildcard match — see
 *     {@link wildcardMatches}. It is never evaluated as a regular expression.
 */
import { z } from 'zod';
import type { JsonCondition, JsonOperand, SimpleCondition } from '../types';

// ── Zod schemas (used in alertRules.ts and UserConfigStore.ts) ───────────────

export const JsonOperandSchema: z.ZodType<JsonOperand> = z.union([
  z.number(),
  z.string(),
  z.boolean(),
  z.object({ var: z.string() }),
]);

export const JsonConditionSchema: z.ZodType<JsonCondition> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.object({ '>':  z.tuple([JsonOperandSchema, JsonOperandSchema]) }),
    z.object({ '>=': z.tuple([JsonOperandSchema, JsonOperandSchema]) }),
    z.object({ '<':  z.tuple([JsonOperandSchema, JsonOperandSchema]) }),
    z.object({ '<=': z.tuple([JsonOperandSchema, JsonOperandSchema]) }),
    z.object({ '==': z.tuple([JsonOperandSchema, JsonOperandSchema]) }),
    z.object({ '!=': z.tuple([JsonOperandSchema, JsonOperandSchema]) }),
    z.object({ 'and': z.array(JsonConditionSchema) }),
    z.object({ 'or':  z.array(JsonConditionSchema) }),
    z.object({ 'not': JsonConditionSchema }),
    z.object({ 'var': z.string() }),
  ]),
);

// ── Var paths ────────────────────────────────────────────────────────────────

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
 * Split a var path into its segments. Dots separate segments; `["…"]` / `['…']`
 * takes its content literally (dots included) so keys like `gpt-4.1` or
 * `foo.js` are reachable: `model["gpt-4.1"].credits`. Plain dotted paths split
 * exactly as before (empty segments are kept and simply never resolve).
 * Returns null for a malformed path (unterminated bracket/quote, junk after `]`).
 * With `wordSegments`, unbracketed segments may only contain word characters
 * (used for `{{ }}` templates so ordinary prose in braces is left alone).
 */
export function parseVarPath(path: string, options: { wordSegments?: boolean } = {}): string[] | null {
  const segments: string[] = [];
  let i = 0;
  for (;;) {
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    // An empty plain segment directly before a bracket (`["a"]`, `a.["b"]`) is
    // just the bracket's own position, not a real empty key.
    if (!(j === i && path[j] === '[')) {
      const plain = path.slice(i, j);
      if (options.wordSegments && !/^\w*$/.test(plain)) return null;
      segments.push(plain);
    }
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

// ── Evaluator ────────────────────────────────────────────────────────────────

/**
 * Walk a var path (see {@link parseVarPath}) into a plain context object.
 * Reads own properties only: inherited names such as `constructor` or
 * `__proto__` resolve to undefined.
 */
export function resolveVar(varPath: string, ctx: Record<string, unknown>): unknown {
  const parts = parseVarPath(varPath);
  if (!parts) return undefined;
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function resolveOperand(op: JsonOperand, ctx: Record<string, unknown>): unknown {
  if (op !== null && typeof op === 'object' && 'var' in op) return resolveVar(op.var, ctx);
  return op;
}

function isNil(v: unknown): v is null | undefined {
  return v === null || v === undefined;
}

/**
 * Canonical numeric text: optional sign, digits with optional fraction and
 * exponent ("12", "-3.5", ".5", "1e3"). Number() alone is too lenient — it also
 * accepts "", " 7", "0x10", "0b1" — so those are screened out first.
 */
function isNumericText(v: string): boolean {
  return v.length <= 64 && /^[+-]?[\d.]/.test(v) && !/[\sxXbBoO]/.test(v);
}

/** A finite number, or null when the value is not (canonically) numeric. */
function toNumeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && isNumericText(v)) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `==` semantics: numeric when both sides are numeric, otherwise strict. */
function looseEquals(a: unknown, b: unknown): boolean {
  const na = toNumeric(a);
  const nb = toNumeric(b);
  if (na !== null && nb !== null) return na === nb;
  return a === b;
}

/** The shared comparison — see the semantics block in the file header. */
function compare(left: unknown, right: unknown, op: string): boolean {
  if (isNil(left) || isNil(right)) return op === '!=';
  if (op === '==') return looseEquals(left, right);
  if (op === '!=') return !looseEquals(left, right);
  const l = toNumeric(left);
  const r = toNumeric(right);
  if (l === null || r === null) return false;
  if (op === '>') return l > r;
  if (op === '>=') return l >= r;
  if (op === '<') return l < r;
  if (op === '<=') return l <= r;
  /* c8 ignore next */
  return false;
}

export function evalCondition(cond: JsonCondition, ctx: Record<string, unknown>): boolean {
  if (typeof cond === 'boolean') return cond;
  if ('var' in cond) return Boolean(resolveVar(cond.var, ctx));
  if ('not' in cond) return !evalCondition(cond.not, ctx);
  if ('and' in cond) return cond.and.every((c) => evalCondition(c, ctx));
  if ('or'  in cond) return cond.or.some((c) => evalCondition(c, ctx));

  const ops = ['>', '>=', '<', '<=', '==', '!='] as const;
  for (const op of ops) {
    if (op in cond) {
      const [lhs, rhs] = (cond as Record<string, [JsonOperand, JsonOperand]>)[op]!;
      return compare(resolveOperand(lhs!, ctx), resolveOperand(rhs!, ctx), op);
    }
  }
  /* c8 ignore next */
  return false;
}

// ── Wildcard matching (`matches`) ────────────────────────────────────────────

/** Longest field value `matches` will look at; longer values never match. */
export const MAX_MATCH_INPUT = 512;
/** Longest `matches` pattern; longer patterns never match (and are rejected by the rule schema). */
export const MAX_MATCH_PATTERN = 256;

/**
 * Iterative wildcard match with single-star backtracking: O(text × pattern)
 * worst case with both bounded by the caps above, and no exponential paths.
 * Operates on code points so `?` consumes one whole character.
 */
function globMatch(pattern: readonly string[], text: readonly string[]): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      p += 1;
      mark = t;
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p += 1;
      t += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * Safe replacement for the old user-supplied-regex `matches` operator (which
 * was a ReDoS vector on the host thread). Only `*` (any run of characters,
 * including none) and `?` (exactly one character) are special; everything
 * else — `.`, `(`, `[`, `|` … — is literal. Matching is case-insensitive and
 * anchored to the whole value. For compatibility with the former regex-style
 * examples, a leading `^` and/or trailing `$` are accepted as explicit
 * anchors: `^gpt-` matches values that START with "gpt-", `-mini$` values that
 * END with "-mini", `^gpt-4o$` exactly "gpt-4o". Over-long patterns or values
 * (see MAX_MATCH_PATTERN / MAX_MATCH_INPUT) never match.
 */
export function wildcardMatches(pattern: string, text: string): boolean {
  if (pattern.length > MAX_MATCH_PATTERN || text.length > MAX_MATCH_INPUT) return false;
  let body = pattern;
  const anchoredStart = body.startsWith('^');
  if (anchoredStart) body = body.slice(1);
  const anchoredEnd = body.endsWith('$');
  if (anchoredEnd) body = body.slice(0, -1);
  // Only one explicit anchor → the other side is open (regex-style prefix/suffix).
  if (anchoredStart && !anchoredEnd) body = `${body}*`;
  else if (anchoredEnd && !anchoredStart) body = `*${body}`;
  return globMatch(Array.from(body.toLowerCase()), Array.from(text.toLowerCase()));
}

/** Operand adapter for `matches`: only a string pattern against a primitive value can match. */
function evalMatches(fieldValue: unknown, pattern: SimpleCondition['value']): boolean {
  if (typeof pattern !== 'string' || isNil(fieldValue) || typeof fieldValue === 'object') return false;
  return wildcardMatches(pattern, String(fieldValue));
}

// ── SimpleCondition evaluator ────────────────────────────────────────────────

/**
 * Evaluate a single structured condition against the rule context.
 * Supports all JSONLogic operators plus `in` and `matches`, with the
 * semantics defined in the file header.
 */
export function evalSimpleCondition(c: SimpleCondition, ctx: Record<string, unknown>): boolean {
  const fieldValue = resolveVar(c.field, ctx);

  if (c.op === 'in') {
    if (isNil(fieldValue)) return false;
    const allowed = Array.isArray(c.value) ? c.value : [c.value];
    return allowed.some((candidate) => looseEquals(fieldValue, candidate));
  }

  if (c.op === 'matches') return evalMatches(fieldValue, c.value);

  return compare(fieldValue, c.value, c.op);
}

/**
 * Evaluate a rule's condition, supporting both `when` (JSONLogic) and
 * `conditions` (SimpleCondition array) fields. `when` takes precedence when
 * both are present. Returns false when neither is set.
 */
export function evalRule(
  rule: { when?: JsonCondition; conditions?: SimpleCondition[]; match?: 'all' | 'any' | 'none' },
  ctx: Record<string, unknown>,
): boolean {
  if (rule.when !== undefined) return evalCondition(rule.when, ctx);
  if (rule.conditions?.length) {
    return evalRuleConditions(rule.conditions, rule.match ?? 'all', ctx);
  }
  return false;
}

/* c8 ignore next */
function evalRuleConditions(
  conditions: SimpleCondition[],
  match: 'all' | 'any' | 'none',
  ctx: Record<string, unknown>,
): boolean {
  const results = conditions.map((c) => evalSimpleCondition(c, ctx));
  if (match === 'any')  return results.some(Boolean);
  if (match === 'none') return results.every((r) => !r);
  return results.every(Boolean); // 'all'
}

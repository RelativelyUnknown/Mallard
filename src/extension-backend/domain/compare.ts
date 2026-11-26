/**
 * The one comparison flat alert rules use (and the legacy importer's number
 * parsing). Pure and webview-safe.
 *
 * Semantics:
 *   - A null/undefined operand (a metric that is unavailable: no snapshot, no
 *     day-level data, a model or repo that is not in the snapshot) makes every
 *     operator false, except `!=` which is true: "unknown" never satisfies a
 *     condition but is never equal to anything either.
 *   - Ordering operators (`<` `<=` `>` `>=`) need two numbers. Strings count
 *     only when they are canonical numerics ("12", "-3.5", "1e3"); booleans,
 *     other strings, NaN and infinities do not, and the result is false.
 *   - `==` / `!=` compare numerically when both operands are numbers or
 *     canonical numeric strings (so `50 == "50"`), otherwise strictly (`===`).
 */
import type { FlatAlertRule } from './contracts';

export type CompareOp = FlatAlertRule['op'];

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
export function toNumeric(v: unknown): number | null {
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

export function compare(left: unknown, right: unknown, op: CompareOp): boolean {
  if (isNil(left) || isNil(right)) return op === '!=';
  if (op === '==') return looseEquals(left, right);
  if (op === '!=') return !looseEquals(left, right);
  const l = toNumeric(left);
  const r = toNumeric(right);
  if (l === null || r === null) return false;
  switch (op) {
    case '>':
      return l > r;
    case '>=':
      return l >= r;
    case '<':
      return l < r;
    default:
      return l <= r;
  }
}

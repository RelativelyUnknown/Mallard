/**
 * Canonical form + reviewable text format for golden files.
 *
 *  - object keys sorted, `undefined` dropped (so absent and undefined agree);
 *  - non-integer numbers rounded to 10 significant digits (the recorder and the
 *    assertions both canonicalise, so float summation order never matters);
 *  - bigint -> number, `-0` -> 0, non-finite numbers -> strings;
 *  - printed with one leaf row per line, so a diff of a 100-event file reads
 *    like a table rather than a wall of single-field lines.
 */
import { promises as fs } from 'fs';
import * as path from 'path';

export const SIG_DIGITS = 10;

export function canon(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'number': {
      if (Number.isNaN(value)) return 'NaN';
      if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
      if (Number.isInteger(value)) return value === 0 ? 0 : value;
      return Number(value.toPrecision(SIG_DIGITS));
    }
    case 'bigint':
      return Number(value);
    case 'string':
    case 'boolean':
      return value;
    case 'undefined':
      return null;
    case 'object': {
      if (Array.isArray(value)) return value.map((v) => canon(v));
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as object).sort()) {
        const v = (value as Record<string, unknown>)[key];
        if (v === undefined) continue;
        out[key] = canon(v);
      }
      return out;
    }
    default:
      return String(value);
  }
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== 'object';
}

/** True for a value that is a primitive, an array of primitives, or an object of such (two levels at most). */
function isLeaf(v: unknown, depth = 0): boolean {
  if (isPrimitive(v)) return true;
  if (Array.isArray(v)) return v.every(isPrimitive);
  if (depth >= 2) return false;
  return Object.values(v as object).every((x) => isLeaf(x, depth + 1));
}

function render(v: unknown, indent: string): string {
  const flat = JSON.stringify(v);
  if (isPrimitive(v)) return flat;
  const limit = isLeaf(v) ? 700 : 100;
  if (flat.length + indent.length <= limit) return flat;
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    return `[\n${v.map((x) => `${inner}${render(x, inner)}`).join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(v as Record<string, unknown>);
  return `{\n${entries.map(([k, x]) => `${inner}${JSON.stringify(k)}: ${render(x, inner)}`).join(',\n')}\n${indent}}`;
}

/** The exact text stored in an expected file (canonical, trailing newline). */
export function goldenText(value: unknown): string {
  return `${render(canon(value), '')}\n`;
}

// ── Expected-file locations ───────────────────────────────────────────────────

export const EXPECTED_DIR = path.join(__dirname, '..', 'expected');

export function tzSlug(tz: string): string {
  return tz.replace(/\//g, '_');
}

export function expectedPath(name: string, tz?: string): string {
  return path.join(EXPECTED_DIR, tz ? `${name}.${tzSlug(tz)}.json` : `${name}.json`);
}

/**
 * Load a recorded golden: `<name>.<tz>.json` when the recorder found the output
 * to depend on the zone, else the single zone-independent `<name>.json`.
 */
export async function loadExpected(name: string, tz: string): Promise<unknown> {
  for (const file of [expectedPath(name, tz), expectedPath(name)]) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  throw new Error(`no recorded golden for ${name} (${tz}); run: npx tsx test/golden/record.ts`);
}

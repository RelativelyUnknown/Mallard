/* c8 ignore next */
import type { CostCategory, Surface } from '../domain/types';

export type AnyRecord = Record<string, unknown>;

export interface TokenBreakdown {
  prompt?: number;
  completion?: number;
  cacheCreation?: number;
  cacheRead?: number;
  thinking?: number;
}

/** A finite number from a number or a non-blank numeric string, else undefined. */
function finite(v: unknown): number | undefined {
  // Number('') and Number('  ') are 0, which would turn a blank field into a real zero.
  const n = typeof v === 'string' ? (v.trim() === '' ? NaN : Number(v)) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function num(v: unknown): number | undefined {
  const n = finite(v);
  return n !== undefined && n >= 0 ? n : undefined;
}

export function pick(attrs: AnyRecord, keys: string[]): unknown {
  for (const k of keys) {
    if (attrs[k] != null) return attrs[k];
  }
  return undefined;
}

export function toSurface(v: unknown): Surface {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('inline') || s.includes('completion')) return 'inline';
  if (s.includes('agent')) return 'agent';
  if (s.includes('edit')) return 'edit';
  if (s.includes('chat')) return 'chat';
  return 'unknown';
}

/** djb2 hash — stable short key for a file path, used to namespace event ids. */
export function fileKeyOf(filePath: string): string {
  let hash = 5381;
  for (let i = 0; i < filePath.length; i++) hash = ((hash << 5) + hash + filePath.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

// date, time (hh:mm then optional seconds/fraction, validated by Date.parse), rest = zone.
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}[\d:.]*)(.*)$/;
const ZONE_RE = /^[+-]\d{2}:?\d{0,2}$/;

/**
 * Epoch ms for a timestamp string, or NaN. A date-time with no zone designator
 * is read as UTC, never host-local: DuckDB renders its inferred TIMESTAMP
 * columns as naive "YYYY-MM-DD HH:MM:SS.fff" holding the UTC instant, and
 * Date.parse would shift every such event by the machine's UTC offset.
 */
export function parseTimestampString(s: string): number {
  const t = s.trim();
  // Epoch milliseconds carried as text (a numeric column read as VARCHAR).
  if (/^\d+\.?\d*$/.test(t)) return Number(t);
  const m = DATE_TIME_RE.exec(t);
  if (!m) return Date.parse(t);
  const zone = (m[3] ?? '').trim().toUpperCase();
  if (zone === '' || zone === 'Z') return Date.parse(`${m[1]}T${m[2]}Z`);
  if (!ZONE_RE.test(zone)) return Date.parse(t);
  // "+02:00", "+0200" and DuckDB's short "-08" all normalise to "+hh:mm".
  const digits = zone.slice(1).replace(':', '');
  return Date.parse(`${m[1]}T${m[2]}${zone[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || '00'}`);
}

/**
 * Parse an event timestamp from a raw row, or undefined when the row has no
 * parseable timestamp. Callers should skip such rows: falling back to "now"
 * would mis-bucket the event into the current period and, because the id is
 * derived from ts, re-insert the same row with a fresh id on every ingest run.
 */
export function parseTimestamp(row: AnyRecord): number | undefined {
  const raw = row['timestamp'] ?? row['time'];
  const ts =
    typeof raw === 'string' ? parseTimestampString(raw) :
    typeof raw === 'number' ? raw :
    NaN;
  if (Number.isFinite(ts)) return ts;
  // OTel spans carry a nanosecond epoch instead of an ISO/ms timestamp.
  const n = finite(row['startTimeUnixNano'] ?? row['timeUnixNano']);
  return n === undefined ? undefined : Math.floor(n / 1e6);
}

/** Unwrap an OTLP attribute value ({ stringValue | intValue | … }) to a scalar. */
function unwrapOtelValue(v: unknown): unknown {
  if (v && typeof v === 'object') {
    const o = v as AnyRecord;
    return o['stringValue'] ?? o['intValue'] ?? o['doubleValue'] ?? o['boolValue'] ?? v;
  }
  return v;
}

/**
 * Normalise an OTel span's `attributes` into a flat `{ key: value }` map.
 * Handles both the OTLP array form (`[{ key, value: { stringValue } }]`) and a
 * plain object map; anything else yields an empty map.
 */
export function flattenOtelAttributes(attrs: unknown): AnyRecord {
  if (Array.isArray(attrs)) {
    const out: AnyRecord = {};
    for (const item of attrs) {
      const kv = item as { key?: unknown; value?: unknown };
      if (typeof kv.key === 'string') out[kv.key] = unwrapOtelValue(kv.value);
    }
    return out;
  }
  return attrs && typeof attrs === 'object' ? (attrs as AnyRecord) : {};
}

/**
 * Split a 2-category cost proportionally between input and output tokens.
 * Used by CopilotConnector where only prompt + completion are available.
 */
export function splitCostSimple(
  cost: number,
  promptTokens: number,
  totalTokens: number,
): Partial<Record<CostCategory, number>> {
  if (totalTokens === 0) return {};
  const out: Partial<Record<CostCategory, number>> = {};
  const inputCost = (cost * promptTokens) / totalTokens;
  if (inputCost > 0) out.input = inputCost;
  const outputCost = cost - inputCost;
  if (outputCost > 0) out.output = outputCost;
  return out;
}

/**
 * Split a cost across all available token categories proportionally.
 * Used by ClaudeCodeConnector where cache and thinking tokens are available.
 */
/* c8 ignore next */
export function splitCostByBreakdown(
  cost: number,
  tokens: TokenBreakdown,
): Partial<Record<CostCategory, number>> {
  const total =
    (tokens.prompt ?? 0) +
    (tokens.completion ?? 0) +
    (tokens.cacheCreation ?? 0) +
    (tokens.cacheRead ?? 0) +
    (tokens.thinking ?? 0);
  if (total === 0) return {};
  const out: Partial<Record<CostCategory, number>> = {};
  if (tokens.prompt)        out.input          = (cost * tokens.prompt)        / total;
  if (tokens.completion)    out.output         = (cost * tokens.completion)    / total;
  if (tokens.cacheCreation) out.cache_creation = (cost * tokens.cacheCreation) / total;
  if (tokens.cacheRead)     out.cache_read     = (cost * tokens.cacheRead)     / total;
  if (tokens.thinking)      out.thinking       = (cost * tokens.thinking)      / total;
  return out;
}

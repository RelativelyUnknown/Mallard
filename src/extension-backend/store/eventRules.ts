/**
 * Rules every event store applies to incoming rows, shared by the SQLite store
 * and the in-memory fallback so they cannot drift apart.
 */
import type { RawEvent } from '../domain/contracts';
import { isSafeSqlInt } from './sqlite/Db';

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNullableText = (v: unknown): boolean => v === null || typeof v === 'string';
const isCount = (v: unknown): boolean => isSafeSqlInt(v) && v >= 0;
const isNullableCount = (v: unknown): boolean => v === null || isCount(v);

/**
 * Why a row cannot be stored, or null when it can. Without this `NaN` would be
 * bound as NULL, a fractional or huge count would round or throw when read back,
 * and a negative `ts` would break the bucket arithmetic.
 */
export function invalidReason(e: RawEvent): string | null {
  if (!isText(e.id)) return 'id';
  if (!isCount(e.ts)) return 'ts';
  if (!isText(e.modelId) || !isText(e.surface) || !isText(e.source)) return 'modelId/surface/source';
  if (!isNullableText(e.repo) || !isNullableText(e.branch) || !isNullableText(e.attribution) || !isNullableText(e.language)) return 'repo/branch/attribution/language';
  if (!isCount(e.requests)) return 'requests';
  if (!isNullableCount(e.promptTokens) || !isNullableCount(e.completionTokens)) return 'prompt/completion tokens';
  if (!isCount(e.cacheReadTokens) || !isCount(e.cacheCreationTokens) || !isCount(e.thinkingTokens)) return 'cache/thinking tokens';
  return null;
}

/**
 * A stored token count raised to `incoming` when that is larger (NULL counts as
 * 0 but stays NULL when `incoming` is not larger): the guarded SQL update.
 */
function raised(stored: number | null, incoming: number | null): number | null {
  return incoming !== null && incoming > (stored ?? 0) ? incoming : stored;
}

/** A Claude row seen again: each token column takes the larger value; everything else stays as first seen. */
export function mergeClaudeDuplicate(a: RawEvent, b: RawEvent): RawEvent {
  return {
    ...a,
    promptTokens: raised(a.promptTokens, b.promptTokens),
    completionTokens: raised(a.completionTokens, b.completionTokens),
    cacheReadTokens: Math.max(a.cacheReadTokens, b.cacheReadTokens),
    cacheCreationTokens: Math.max(a.cacheCreationTokens, b.cacheCreationTokens),
    thinkingTokens: Math.max(a.thinkingTokens, b.thinkingTokens),
  };
}

/** Validates and collapses duplicates: the first occurrence wins, except Claude rows, which keep the larger token counts. */
export function prepareRows(events: readonly RawEvent[]): { rows: RawEvent[]; rejected: number; firstRejected: string } {
  const byId = new Map<string, RawEvent>();
  let rejected = 0;
  let firstRejected = '';
  for (const e of events) {
    const bad = invalidReason(e);
    if (bad !== null) {
      if (rejected++ === 0) firstRejected = `${String(e.id)} (${bad})`;
      continue;
    }
    const seen = byId.get(e.id);
    if (seen === undefined) byId.set(e.id, e);
    else if (e.source === 'claude-code' && seen.source === 'claude-code') byId.set(e.id, mergeClaudeDuplicate(seen, e));
  }
  return { rows: [...byId.values()], rejected, firstRejected };
}


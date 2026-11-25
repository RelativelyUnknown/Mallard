/**
 * Deterministic time for the golden harness: pin the process time zone, freeze
 * the clock, and turn "local wall clock in zone X" into an epoch instant.
 *
 * Nothing in here knows about Mallard; it only manipulates `process.env.TZ`
 * and `Date`, so the later (non-DuckDB) harness implementations can reuse it.
 */

/** The six zones every golden is recorded in: no DST, US DST, half-hour offset, 30-minute DST, +13 DST, +13:45 DST. */
export const GOLDEN_TZS = [
  'UTC',
  'America/Los_Angeles',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'Pacific/Chatham',
] as const;
export type GoldenTz = (typeof GOLDEN_TZS)[number];

/**
 * Run `fn` with `process.env.TZ` set to `tz` (Node re-reads it on assignment).
 * Same technique as test/unit/store/ndjsonIngest.test.ts. The previous value
 * is restored afterwards, even when `fn` throws.
 */
export async function withTz<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env['TZ'];
  process.env['TZ'] = tz;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env['TZ'];
    else process.env['TZ'] = prev;
  }
}

/** Synchronous twin of {@link withTz}. */
export function withTzSync<T>(tz: string, fn: () => T): T {
  const prev = process.env['TZ'];
  process.env['TZ'] = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env['TZ'];
    else process.env['TZ'] = prev;
  }
}

/**
 * Freeze `Date.now()` at `now` for the duration of `fn` (sync or async). Only
 * the static `Date.now` is replaced, which is what the production code reads
 * ("injected clock" paths read `Date.now()`); `new Date()` with no argument is
 * NOT frozen here — see {@link withFrozenDateSync} for the one place that needs it.
 */
export async function withClock<T>(now: number, fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  Date.now = () => now;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/**
 * Replace the global `Date` with a subclass whose no-argument constructor and
 * `now()` return `now`, for a SYNCHRONOUS call only (class replacement would
 * confuse `instanceof` checks if it were held across awaits). Needed for
 * `buildStreamBatch`, whose `tz_offset_minutes` is computed from `new Date()`.
 */
export function withFrozenDateSync<T>(now: number, fn: () => T): T {
  const RealDate = Date;
  class FrozenDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(now);
      else super(...(args as [number]));
    }
    static override now(): number {
      return now;
    }
  }
  globalThis.Date = FrozenDate as unknown as DateConstructor;
  try {
    return fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/**
 * Epoch ms of local wall-clock `YYYY-MM-DDTHH:mm[:ss]` in the CURRENT process
 * zone (call inside {@link withTz}). Ambiguous wall times (DST fall-back) take
 * the first occurrence, non-existent ones (spring-forward gap) shift forward,
 * exactly like `new Date(y, m, d, h, mi)`.
 */
export function localInstant(wall: string): number {
  const [date = '', time = '00:00'] = wall.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h = 0, mi = 0, sec = 0] = time.split(':').map(Number);
  if (![y, mo, d, h, mi, sec].every((n) => Number.isInteger(n))) throw new Error(`bad local wall time: ${wall}`);
  return new Date(y!, mo! - 1, d!, h, mi, sec).getTime();
}

/** `YYYY-MM-DDTHH:mm:ss.sssZ` for an epoch ms (annotation only). */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

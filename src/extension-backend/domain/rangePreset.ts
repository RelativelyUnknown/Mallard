/**
 * Resolves a dashboard date preset to a concrete [start, end) range.
 *
 * Pure and framework-free so the webview (on every snapshot) and the host
 * (on every compute) share one definition. The range is *re-resolved* each
 * time rather than frozen at click time: a frozen "7 days" filter would stop
 * matching new events as soon as its end timestamp passed.
 *
 * Every range is aligned to local calendar-day (or month) boundaries, so it
 * is stable for the whole day — new events always fall inside it — and it is
 * DST-safe: the window is built from calendar components (not a fixed
 * 24h × N millisecond offset, which lands an hour off across a DST change).
 */
import { DatePreset } from './types';
import { nextBucketStart, startOf } from '../util/time';

export interface PresetRange {
  start: number;
  end: number;
}

/** Number of calendar days (including today) each rolling preset covers. */
const ROLLING_DAYS: Partial<Record<DatePreset, number>> = { '7d': 7, '30d': 30 };

/** True for presets whose range moves over time and so needs re-resolving. */
export function isRelativePreset(preset: DatePreset | undefined): preset is Exclude<DatePreset, 'all'> {
  return preset !== undefined && preset !== 'all';
}

/** Start of the local day `days` calendar days before the day containing `ts`. */
function startOfDaysAgo(ts: number, days: number): number {
  const d = new Date(startOf(ts, 'day'));
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - days).getTime();
}

/**
 * The range `preset` covers at time `now`, or `undefined` for 'all' (no
 * range restriction). `end` is exclusive: the start of the next day/month.
 */
export function resolveRangePreset(preset: DatePreset, now: number): PresetRange | undefined {
  switch (preset) {
    case 'today':
      return { start: startOf(now, 'day'), end: nextBucketStart(now, 'day') };
    case '7d':
    case '30d':
      return {
        start: startOfDaysAgo(now, (ROLLING_DAYS[preset] ?? 1) - 1),
        end: nextBucketStart(now, 'day'),
      };
    case 'month':
      return { start: startOf(now, 'month'), end: nextBucketStart(now, 'month') };
    case 'all':
      return undefined;
    /* c8 ignore next 4 */
    default: {
      const _exhaustive: never = preset;
      throw new Error(`Unknown preset: ${String(_exhaustive)}`);
    }
  }
}

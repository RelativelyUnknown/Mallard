/**
 * Keeps the webview's filter in step with the host's authoritative one.
 *
 * Three jobs:
 *  - `postFilter` is the single outbound path, so a just-sent filter is
 *    remembered and a late snapshot computed from an *older* filter can't
 *    clobber the user's newer choice when it arrives.
 *  - `filterPatchFromSnapshot` hydrates the whole local filter (and the date
 *    preset button) from the snapshot — a reopened panel or a change made in
 *    the sidebar shows up — without echoing a `setFilter` back.
 *  - `reresolveRelativeRange` re-resolves a relative preset ('today', '7d',
 *    '30d', 'month') against the clock, so the stored range doesn't go stale
 *    and silently stop matching new events.
 */
import { post } from './api';
import { setState, state, AppState } from './store';
import { Filter } from '../extension-backend/domain/types';
import { isRelativePreset, resolveRangePreset } from '../extension-backend/domain/rangePreset';

/** Ranges closer than this are the same range (clock skew, rounding). */
const RANGE_TOLERANCE_MS = 60_000;
/** How long a posted filter shields local state from older snapshots. */
const PENDING_TTL_MS = 5_000;
/** Minimum gap before re-posting the same re-resolved range (loop guard). */
const REPOST_COOLDOWN_MS = 60_000;

let pending: { key: string; at: number } | null = null;
let lastRepost: { key: string; at: number } | null = null;

const sorted = (list: readonly string[] | undefined): string[] | null =>
  list && list.length > 0 ? [...list].sort() : null;

/** Order-insensitive identity of a filter; empty lists equal absent ones. */
export function filterKey(f: Filter): string {
  return JSON.stringify([
    f.range?.start ?? null,
    f.range?.end ?? null,
    f.rangePreset ?? null,
    sorted(f.models),
    sorted(f.surfaces),
    sorted(f.repos),
    sorted(f.branches),
    sorted(f.sources),
  ]);
}

/** Copy of `f` without empty lists (the host treats them as unset anyway). */
function normalized(f: Filter): Filter {
  const out: Filter = {};
  if (f.range) out.range = { ...f.range };
  if (f.rangePreset) out.rangePreset = f.rangePreset;
  if (f.models?.length) out.models = [...f.models];
  if (f.surfaces?.length) out.surfaces = [...f.surfaces];
  if (f.repos?.length) out.repos = [...f.repos];
  if (f.branches?.length) out.branches = [...f.branches];
  if (f.sources?.length) out.sources = [...f.sources];
  return out;
}

/** Send a filter to the host, remembering it until the host echoes it back. */
export function postFilter(filter: Filter, now = Date.now()): void {
  pending = { key: filterKey(filter), at: now };
  post({ type: 'setFilter', value: filter });
}

/**
 * State patch that adopts the host's filter, or `null` when local state is
 * already current (or an older snapshot is still in flight behind a filter
 * this webview just sent).
 */
export function filterPatchFromSnapshot(
  incoming: Filter,
  now = Date.now(),
): Pick<AppState, 'filter' | 'datePreset'> | null {
  const incomingKey = filterKey(incoming);
  if (pending) {
    const echoed = pending.key === incomingKey;
    const fresh = now - pending.at < PENDING_TTL_MS;
    if (echoed || !fresh) pending = null;
    else return null;
  }
  const local = state();
  if (incomingKey === filterKey(local.filter)) return null;
  return {
    filter: normalized(incoming),
    // A filter with no range at all is "All time"; one with a range but no
    // preset (set by something other than the filter bar) keeps the button.
    datePreset: incoming.rangePreset ?? (incoming.range ? local.datePreset : 'all'),
  };
}

const near = (a: number, b: number): boolean => Math.abs(a - b) <= RANGE_TOLERANCE_MS;

/**
 * If the active filter's preset is relative and its stored range no longer
 * matches what the preset resolves to now, store the fresh range and re-post
 * once. Safe to call on every snapshot: it is a no-op once the range is current.
 */
export function reresolveRelativeRange(now = Date.now()): void {
  const filter = state().filter;
  const preset = filter.rangePreset;
  if (!isRelativePreset(preset)) return;
  const resolved = resolveRangePreset(preset, now);
  if (!resolved) return;
  if (filter.range && near(filter.range.start, resolved.start) && near(filter.range.end, resolved.end)) {
    return;
  }
  const key = `${preset}:${resolved.start}:${resolved.end}`;
  if (lastRepost && lastRepost.key === key && now - lastRepost.at < REPOST_COOLDOWN_MS) return;
  lastRepost = { key, at: now };
  const next: Filter = { ...filter, range: resolved };
  setState({ filter: next });
  postFilter(next, now);
}

/** Test seam: forget remembered filters. */
export function resetFilterSync(): void {
  pending = null;
  lastRepost = null;
}

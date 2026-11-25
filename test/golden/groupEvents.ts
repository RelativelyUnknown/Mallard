/**
 * Test-side twin of the store's SQL pre-aggregation, so tests can turn mapped
 * events into the `AggregateGroup[]` that `store.aggregate` will return and
 * feed them to `buildSnapshotSource`:
 *
 *   SELECT (ts / 900000) * 900000 AS bucketStartMs, modelId, surface, source,
 *          repo, branch, language, attribution,
 *          (promptTokens IS NOT NULL OR completionTokens IS NOT NULL) AS tokensKnown,
 *          SUM(requests), SUM(COALESCE(promptTokens, 0)), SUM(COALESCE(completionTokens, 0)),
 *          SUM(cacheReadTokens), SUM(cacheCreationTokens), SUM(thinkingTokens)
 *   FROM events WHERE <filter> GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9
 *
 * Plus the filter's WHERE clause (`FilterClauseBuilder` semantics) and the
 * conversion from the golden recordings' event shape.
 */
import type { AggregateGroup, RawEvent } from '../../src/extension-backend/domain/contracts';
import type { SnapshotGroups } from '../../src/extension-backend/domain/snapshotSource';
import { UNATTRIBUTED_REPO } from '../../src/extension-backend/domain/aggregate';
import type { RepoAttribution, SourceKind, Surface } from '../../src/extension-backend/domain/types';
import type { RecordFilter } from '../../src/extension-backend/store/EventRepository';
import type { NormalizedEvent } from './pipeline';

/** Width of the UTC time bucket a group covers. */
export const BUCKET_MS = 15 * 60_000;

/** Start of the 15-minute UTC bucket containing `ts` (also right for negative timestamps). */
export function bucketStart(ts: number): number {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

/** True when the event passes the filter, with the same semantics as the store's WHERE clause. */
export function matchesRecordFilter(e: RawEvent, f: RecordFilter): boolean {
  if (f.range && !(e.ts >= f.range.start && e.ts < f.range.end)) return false;
  if (f.models?.length && !f.models.includes(e.modelId)) return false;
  if (f.surfaces?.length && !f.surfaces.includes(e.surface)) return false;
  if (f.sources?.length && !f.sources.includes(e.source)) return false;
  if (f.branches?.length && !(e.branch !== null && f.branches.includes(e.branch))) return false;
  if (f.repos?.length) {
    const named = f.repos.filter((r) => r !== UNATTRIBUTED_REPO);
    const namedHit = e.repo !== null && named.includes(e.repo);
    const unattributedHit = e.repo === null && f.repos.includes(UNATTRIBUTED_REPO);
    if (!namedHit && !unattributedHit) return false;
  }
  return true;
}

export function filterEvents(events: readonly RawEvent[], filter: RecordFilter): RawEvent[] {
  return events.filter((e) => matchesRecordFilter(e, filter));
}

/** GROUP BY bucket, model, surface, source, repo, branch, language, attribution, tokensKnown. */
export function groupEvents(events: readonly RawEvent[]): AggregateGroup[] {
  const groups = new Map<string, AggregateGroup>();
  for (const e of events) {
    const bucketStartMs = bucketStart(e.ts);
    const tokensKnown = e.promptTokens !== null || e.completionTokens !== null;
    const key = JSON.stringify([bucketStartMs, e.modelId, e.surface, e.source, e.repo, e.branch, e.language, e.attribution, tokensKnown]);
    let g = groups.get(key);
    if (g === undefined) {
      g = {
        bucketStartMs, modelId: e.modelId, surface: e.surface, source: e.source,
        repo: e.repo, branch: e.branch, language: e.language, attribution: e.attribution, tokensKnown,
        requests: 0, promptTokens: 0, completionTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
      };
      groups.set(key, g);
    }
    g.requests += e.requests;
    g.promptTokens += e.promptTokens ?? 0;
    g.completionTokens += e.completionTokens ?? 0;
    g.cacheReadTokens += e.cacheReadTokens;
    g.cacheCreationTokens += e.cacheCreationTokens;
    g.thinkingTokens += e.thinkingTokens;
  }
  // SQL leaves the order unspecified; sort so a test failure reads the same every run.
  return [...groups.entries()]
    .sort(([ka, a], [kb, b]) => a.bucketStartMs - b.bucketStartMs || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([, g]) => g);
}

/**
 * What the dashboard read of `filter` asks the store for: the groups matching
 * the whole filter, and the groups matching its range only (for `dims`).
 */
export function groupsFor(events: readonly RawEvent[], filter: RecordFilter): SnapshotGroups {
  return {
    groups: groupEvents(filterEvents(events, filter)),
    dimGroups: groupEvents(filterEvents(events, filter.range ? { range: filter.range } : {})),
  };
}

/** A golden recording's mapped event as a stored row: no price, one request, absent cache/thinking tokens as 0. */
export function toRawEvent(e: NormalizedEvent): RawEvent {
  return {
    id: e.id,
    ts: e.ts,
    modelId: e.model,
    surface: e.surface as Surface,
    source: e.source as SourceKind,
    repo: e.repo,
    branch: e.branch,
    attribution: e.attribution as RepoAttribution | null,
    language: e.language,
    requests: 1,
    promptTokens: e.promptTokens,
    completionTokens: e.completionTokens,
    cacheReadTokens: e.cacheReadTokens ?? 0,
    cacheCreationTokens: e.cacheCreationTokens ?? 0,
    thinkingTokens: e.thinkingTokens ?? 0,
  };
}

/**
 * Test-side entry point to the store's TypeScript reference
 * (`src/extension-backend/domain/groupEvents.ts`: the SQL `GROUP BY` twin, the
 * filter WHERE twin and the rollup spec), plus what only the goldens need:
 * the read of a dashboard filter (`groupsFor`) and the conversion from the
 * golden recordings' event shape (`toRawEvent`).
 */
import type { RawEvent } from '../../src/extension-backend/domain/contracts';
import type { SnapshotGroups } from '../../src/extension-backend/domain/snapshotSource';
import { filterEvents, groupEvents } from '../../src/extension-backend/domain/groupEvents';
import type { RepoAttribution, SourceKind, Surface } from '../../src/extension-backend/domain/types';
import type { RecordFilter } from '../../src/extension-backend/store/EventRepository';
import type { NormalizedEvent } from './pipeline';

export {
  BUCKET_MS,
  bucketStart,
  filterEvents,
  groupEvents,
  localDate,
  matchesRecordFilter,
  rollUpEvents,
} from '../../src/extension-backend/domain/groupEvents';
export type { RolledUp } from '../../src/extension-backend/domain/groupEvents';

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

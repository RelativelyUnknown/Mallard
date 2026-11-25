/**
 * Computes every named golden for one zone. `record.ts` writes the results to
 * test/golden/expected/, and test/unit/golden/*.test.ts recomputes them and
 * asserts they still match — one definition of "what is recorded".
 *
 * Names:
 *   events          mapped events + persisted rows + per-pass ingest report
 *   snapshots       SnapshotSourceData: filter matrix at `main`, reduced matrix at the edge nows
 *   usage           UsageService's composed wire snapshot for a few configurations
 *   export          CSV and JSON exports of the store
 *   stream-events   the events inside the wire batches (buildStreamBatch)
 *   stream-envelope the rest of each wire batch (schema version, instance id, sent_at, tz offset)
 *   compaction      rolled-up rows and snapshots after a rollup
 *   branches     credits per branch (the branch-cap alert's input)
 *   alerts       built-in alerts, alert rules and restriction states over a scripted series
 * Zone-independent: `layout`, `pricing` (see computeStaticGoldens).
 */
import {
  alertSequence,
  compact,
  creditsByBranch,
  exportCsv,
  exportJson,
  layoutVectors,
  openWorld,
  pricingVectors,
  resolveNow,
  snapshotRecord,
  streamBatch,
  usageSnapshot,
} from './pipeline';
import type { World } from './pipeline';
import {
  COMPACTION_RETENTION_DAYS,
  EDGE_FILTER_SPECS,
  FILTER_SPECS,
  INGEST_NOW_2,
  NOW_SPECS,
} from './scenarios';
import type { FilterSpec } from './scenarios';
import type { GoldenTz } from './support/time';

export type GoldenSet = Record<string, unknown>;

export const TZ_GOLDEN_NAMES = ['events', 'snapshots', 'usage', 'export', 'stream-events', 'stream-envelope', 'compaction', 'branches', 'alerts'] as const;
export const STATIC_GOLDEN_NAMES = ['layout', 'pricing'] as const;

const MAIN = NOW_SPECS[0]!;

export async function computeStaticGoldens(): Promise<GoldenSet> {
  return { layout: layoutVectors(), pricing: await pricingVectors() };
}

async function snapshotMatrix(world: World): Promise<unknown[]> {
  const tz = world.tz as GoldenTz;
  const out: unknown[] = [];
  for (const now of NOW_SPECS) {
    const specs: FilterSpec[] = now.label === MAIN.label ? FILTER_SPECS : EDGE_FILTER_SPECS;
    for (const spec of specs) {
      const rec = await snapshotRecord(world, spec, now);
      // The unfiltered snapshot barely changes with `now` (only today / month-to-date): at the
      // edge nows keep those totals and the daily extent rather than 46 identical daily rows.
      if (now.label !== MAIN.label && spec.label === 'none') {
        const { data } = rec;
        out.push({
          ...rec,
          data: {
            reduced: 'unfiltered read at an edge now: totals and daily extent only',
            totals: data.totals,
            estimatedEventCount: data.estimatedEventCount,
            daily: { days: data.daily.length, first: data.daily[0]?.dayStart ?? null, last: data.daily[data.daily.length - 1]?.dayStart ?? null },
          },
        });
      } else {
        out.push(rec);
      }
    }
  }
  void tz;
  return out;
}

async function usageCases(world: World): Promise<Record<string, unknown>> {
  const sonnet = FILTER_SPECS.find((f) => f.label === 'model-one')!;
  return {
    'main/none': await usageSnapshot(world, FILTER_SPECS[0]!, MAIN),
    'main/preset-7d': await usageSnapshot(world, FILTER_SPECS.find((f) => f.label === 'preset-7d')!, MAIN),
    'main/model-one/EUR': await usageSnapshot(world, sonnet, MAIN, { currency: 'EUR', rates: { EUR: 0.9 } }),
    'dst-day/preset-today': await usageSnapshot(world, EDGE_FILTER_SPECS.find((f) => f.label === 'preset-today')!, NOW_SPECS.find((n) => n.label === 'dst-day')!),
  };
}

/** All zone-dependent goldens for `tz`. `sqliteAvailable` is false when the span DB could not be read (offline). */
export async function computeTzGoldens(tz: GoldenTz): Promise<{ goldens: GoldenSet; sqliteAvailable: boolean }> {
  const world = await openWorld({ tz });
  try {
    const goldens: GoldenSet = {};
    goldens['events'] = { events: world.events(), stored: await world.stored(), passes: world.passes };
    goldens['snapshots'] = await snapshotMatrix(world);
    goldens['usage'] = await usageCases(world);
    goldens['export'] = { csv: await exportCsv(world), json: await exportJson(world) };
    const batches = streamBatch(world, { now: resolveNow(tz, MAIN) });
    goldens['stream-events'] = batches.map((b) => b.events);
    goldens['stream-envelope'] = batches.map(({ events, ...envelope }) => ({ ...envelope, eventCount: events.length }));
    const branches = [...new Set(world.events().map((e) => e.branch).filter((b): b is string => b !== null))].sort();
    goldens['branches'] = await creditsByBranch(world, [...branches, 'no-such-branch']);
    goldens['alerts'] = await alertSequence({ tz });

    // Compaction mutates the store, so it gets one of its own.
    const compacting = await openWorld({ tz, retentionDays: COMPACTION_RETENTION_DAYS });
    try {
      const at = resolveNow(tz, MAIN);
      const rows = await compact(compacting, at);
      const snaps: unknown[] = [];
      for (const spec of [FILTER_SPECS[0]!, FILTER_SPECS.find((f) => f.label === 'preset-30d')!, FILTER_SPECS.find((f) => f.label === 'model-one')!]) {
        snaps.push(await snapshotRecord(compacting, spec, MAIN));
      }
      const rolled = rows.filter((r) => r.id.startsWith('roll:'));
      goldens['compaction'] = {
        at: new Date(at).toISOString(),
        retentionDays: COMPACTION_RETENTION_DAYS,
        rowCount: rows.length,
        rawRowCount: rows.length - rolled.length,
        rolled,
        snapshots: snaps,
      };
    } finally {
      await compacting.close();
    }
    return { goldens, sqliteAvailable: world.sqliteAvailable };
  } finally {
    await world.close();
  }
}

export { INGEST_NOW_2 };

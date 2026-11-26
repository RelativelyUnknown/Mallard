import { strict as assert } from 'assert';
import { ingestFixtures, resolveNow, snapshot, sqliteExtensionAvailable } from '../../golden/pipeline';
import { NOW_SPECS } from '../../golden/scenarios';
import { loadExpected } from '../../golden/support/canon';
import { diffGolden } from '../../golden/support/diff';

/**
 * The one-call forms of the harness (`ingestFixtures({tz, now})`,
 * `snapshot(filter, {tz, now})`) are the signatures later stacks re-implement;
 * they open their own store, so check they agree with the recordings too.
 */
describe('golden harness: one-call API', function () {
  this.timeout(60_000);

  before(async function () {
    // The span-DB fixture is read through DuckDB's sqlite extension (downloaded on first use).
    if (!(await sqliteExtensionAvailable())) this.skip();
  });

  it('ingestFixtures returns the recorded events, persisted rows and pass reports', async () => {
    const result = await ingestFixtures({ tz: 'Pacific/Auckland' });
    const recorded = (await loadExpected('events', 'Pacific/Auckland')) as Record<string, unknown>;
    assert.equal(diffGolden(result.events, recorded['events']), null);
    assert.equal(diffGolden(result.stored, recorded['stored']), null);
    assert.equal(diffGolden(result.passes, recorded['passes']), null);
  });

  it('snapshot returns the unfiltered SnapshotSourceData recorded for the main now', async () => {
    const main = NOW_SPECS[0]!;
    const data = await snapshot({}, { tz: 'Asia/Kolkata', now: resolveNow('Asia/Kolkata', main) });
    const recorded = (await loadExpected('snapshots', 'Asia/Kolkata')) as Array<{ label: string; nowLabel: string; data: unknown }>;
    const entry = recorded.find((r) => r.label === 'none' && r.nowLabel === main.label)!;
    assert.equal(diffGolden(data, entry.data), null);
  });
});

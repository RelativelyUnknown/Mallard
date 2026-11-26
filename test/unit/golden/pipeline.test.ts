import { strict as assert } from 'assert';
import { computeStaticGoldens, computeTzGoldens, STATIC_GOLDEN_NAMES, TZ_GOLDEN_NAMES } from '../../golden/goldens';
import type { GoldenSet } from '../../golden/goldens';
import { loadExpected } from '../../golden/support/canon';
import { diffGolden } from '../../golden/support/diff';
import { GOLDEN_TZS } from '../../golden/support/time';

/**
 * Characterisation tests: today's implementation (DuckDB store, connectors,
 * UsageService, RestrictionEngine, wire format, layout migration) must keep
 * reproducing the outputs recorded in test/golden/expected/ — in every one of
 * the six golden zones. To re-record after an INTENDED behaviour change:
 *
 *     npx tsx test/golden/record.ts
 *
 * and list the change in test/golden/INTENDED_DIFFERENCES.md.
 */

async function expectGolden(name: string, tz: string, actual: unknown): Promise<void> {
  const diff = diffGolden(actual, await loadExpected(name, tz));
  assert.equal(diff, null, `${name} (${tz}) no longer matches the recording:\n${diff ?? ''}`);
}

for (const tz of GOLDEN_TZS) {
  describe(`golden pipeline — ${tz}`, function () {
    this.timeout(120_000);
    let computed: GoldenSet;

    before(async function () {
      const result = await computeTzGoldens(tz);
      if (!result.sqliteAvailable) {
        // The Copilot span DB is read through DuckDB's sqlite extension, which is downloaded on first use.
        console.warn("      (skipped: DuckDB's sqlite extension is unavailable, so the span-DB fixture cannot be ingested)");
        this.skip();
      }
      computed = result.goldens;
    });

    for (const name of TZ_GOLDEN_NAMES) {
      it(`reproduces the recorded ${name}`, async () => {
        await expectGolden(name, tz, computed[name]);
      });
    }
  });
}

describe('golden static vectors', () => {
  let statics: GoldenSet;
  before(async () => {
    statics = await computeStaticGoldens();
  });

  for (const name of STATIC_GOLDEN_NAMES) {
    it(`reproduces the recorded ${name}`, async () => {
      await expectGolden(name, 'UTC', statics[name]);
    });
  }
});

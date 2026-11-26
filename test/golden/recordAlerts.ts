/**
 * Re-records ONLY the `alerts` golden (test/golden/expected/alerts*.json).
 *
 *     npx tsx test/golden/recordAlerts.ts
 *
 * `record.ts` rewrites every golden and needs DuckDB's sqlite extension; the
 * alert sequence needs neither (it drives AlertService, UsageService over a
 * stub reader and RestrictionEngine), so this uses the same helpers (`canon`,
 * `goldenText`, the per-zone file naming) and touches nothing else.
 */
import './support/env';
import { promises as fs } from 'fs';
import { alertSequence } from './pipeline';
import { canon, expectedPath, goldenText } from './support/canon';
import { GOLDEN_TZS } from './support/time';

async function main(): Promise<void> {
  const perTz = new Map<string, unknown>();
  for (const tz of GOLDEN_TZS) perTz.set(tz, await alertSequence({ tz }));
  for (const tz of GOLDEN_TZS) await fs.rm(expectedPath('alerts', tz), { force: true });
  await fs.rm(expectedPath('alerts', undefined), { force: true });

  const texts = GOLDEN_TZS.map((tz) => JSON.stringify(canon(perTz.get(tz))));
  if (texts.every((t) => t === texts[0])) {
    await fs.writeFile(expectedPath('alerts', undefined), goldenText(perTz.get('UTC')));
    console.log('recorded alerts.json (identical in every zone)');
  } else {
    for (const tz of GOLDEN_TZS) await fs.writeFile(expectedPath('alerts', tz), goldenText(perTz.get(tz)));
    console.log(`recorded alerts.<zone>.json for ${GOLDEN_TZS.length} zones`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

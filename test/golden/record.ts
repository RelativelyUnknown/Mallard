/**
 * Records the golden outputs of TODAY's implementation into test/golden/expected/.
 *
 *     npx tsx test/golden/record.ts
 *     (or: bun run golden:record)
 *
 * It computes every golden (see goldens.ts) in each of the six zones, then
 * writes one file per name:
 *   - `<name>.json`          when the output is identical in all six zones
 *                            (events, exports, layout, pricing, ...);
 *   - `<name>.<zone>.json`   when it depends on the zone (snapshots, usage,
 *                            alerts, stream envelope, compaction).
 * Run it only when a recorded behaviour is meant to change, and review the
 * diff. Needs the DuckDB `sqlite` extension (downloaded on first use), because
 * the Copilot span DB is read through it. Recordings contain no wall-clock
 * timestamps and no absolute paths, so re-running on an unchanged tree is a
 * no-op diff.
 *
 * Other implementations (the node:sqlite stack) are checked against these
 * files by test/unit/golden/*.test.ts, minus the differences listed in
 * test/golden/INTENDED_DIFFERENCES.md.
 */
import './support/env';
import { promises as fs } from 'fs';
import { computeStaticGoldens, computeTzGoldens, TZ_GOLDEN_NAMES } from './goldens';
import type { GoldenSet } from './goldens';
import { canon, EXPECTED_DIR, expectedPath, goldenText } from './support/canon';
import { GOLDEN_TZS } from './support/time';

async function main(): Promise<void> {
  await fs.mkdir(EXPECTED_DIR, { recursive: true });
  for (const f of await fs.readdir(EXPECTED_DIR)) if (f.endsWith('.json')) await fs.rm(`${EXPECTED_DIR}/${f}`);

  const perTz = new Map<string, GoldenSet>();
  for (const tz of GOLDEN_TZS) {
    const t0 = Date.now();
    const { goldens, sqliteAvailable } = await computeTzGoldens(tz);
    if (!sqliteAvailable) {
      throw new Error("DuckDB's sqlite extension is unavailable (offline?); the Copilot span DB cannot be recorded.");
    }
    perTz.set(tz, goldens);
    console.log(`computed ${tz} in ${Date.now() - t0} ms`);
  }

  let files = 0;
  let entries = 0;
  const write = async (name: string, tz: string | undefined, value: unknown): Promise<void> => {
    const text = goldenText(value);
    await fs.writeFile(expectedPath(name, tz), text);
    files += 1;
    entries += Array.isArray(value) ? value.length : value && typeof value === 'object' ? Object.keys(value).length : 1;
    console.log(`  ${(tz ? `${name}.${tz}` : name).padEnd(40)} ${String(text.split('\n').length - 1).padStart(6)} lines ${String(text.length).padStart(8)} bytes`);
  };

  for (const name of TZ_GOLDEN_NAMES) {
    const texts = GOLDEN_TZS.map((tz) => JSON.stringify(canon(perTz.get(tz)![name])));
    if (texts.every((t) => t === texts[0])) {
      await write(name, undefined, perTz.get('UTC')![name]);
    } else {
      for (const tz of GOLDEN_TZS) await write(name, tz, perTz.get(tz)![name]);
    }
  }
  const statics = await computeStaticGoldens();
  for (const [name, value] of Object.entries(statics)) await write(name, undefined, value);
  console.log(`recorded ${files} files (${entries} top-level entries) in ${EXPECTED_DIR}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

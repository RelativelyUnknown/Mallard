import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DuckDBFileReader } from '../../../src/extension-backend/store/DuckDBFileReader';
import { EventStore } from '../../../src/extension-backend/store/EventStore';
import { parseTimestamp } from '../../../src/extension-backend/ingest/connectorUtils';
import type { ParseContext } from '../../../src/extension-backend/ingest/otelParse';
import { makeEvent } from '../helpers';

const ctx: ParseContext = { pricePerCredit: 0.04, now: Date.now() };

describe('DuckDBFileReader.ingestGlob — watermark', () => {
  it('re-reads rows sharing the watermark millisecond (a strict > skipped them forever)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-watermark-'));
    const store = await EventStore.open(dir);
    try {
      const watermarkIso = '2026-06-10T12:00:00.123Z';
      const watermark = Date.parse(watermarkIso);
      const lines = [
        { id: 'older', timestamp: '2026-06-10T12:00:00.122Z' },
        { id: 'first-at-watermark', timestamp: watermarkIso },
        { id: 'second-at-watermark', timestamp: watermarkIso },  // landed after the first poll
        { id: 'newer', timestamp: '2026-06-10T12:00:00.124Z' },
      ];
      const file = path.join(dir, 'log.ndjson');
      await fs.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

      const result = await store.fileReader.ingestGlob(
        file,
        (row) => makeEvent({ id: String(row['id']), ts: parseTimestamp(row)! }),
        ctx,
        watermark,
      );

      assert.deepEqual(
        (await store.reader.find()).map((e) => e.id).sort(),
        ['first-at-watermark', 'newer', 'second-at-watermark'],
        'rows at the watermark ms are re-read; strictly older ones are still skipped',
      );
      assert.equal(result.maxEventTs, Date.parse('2026-06-10T12:00:00.124Z'));

      // Re-reading the same rows is idempotent (ids dedupe).
      const again = await store.fileReader.ingestGlob(
        file,
        (row) => makeEvent({ id: String(row['id']), ts: parseTimestamp(row)! }),
        ctx,
        watermark,
      );
      assert.equal(again.inserted, 0);
      assert.equal(await store.count(), 3);
    } finally { store.dispose(); }
  });
});

describe('DuckDBFileReader.ingestGlob — files without a timestamp column', () => {
  it('cannot filter by the watermark in SQL, so it reads the files whole instead of failing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-notimestamp-'));
    const store = await EventStore.open(dir);
    try {
      // OTel-style rows: a nanosecond epoch under another name, no `timestamp` column at all.
      const nanos = (iso: string): string => `${Date.parse(iso)}000000`;
      const rows = [
        { id: 'old', startTimeUnixNano: nanos('2026-06-10T11:00:00.000Z') },
        { id: 'new', startTimeUnixNano: nanos('2026-06-10T13:00:00.000Z') },
      ];
      const file = path.join(dir, 'spans.ndjson');
      await fs.writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      const result = await store.fileReader.ingestGlob(
        file,
        (row) => makeEvent({ id: String(row['id']), ts: Number(BigInt(String(row['startTimeUnixNano'])) / 1_000_000n) }),
        ctx,
        Date.parse('2026-06-10T12:00:00.000Z'), // a watermark between the two rows
      );

      assert.equal(result.inserted, 2, 'both rows are read (an unfiltered retry, not a failed ingest): without a timestamp the watermark cannot exclude the old one');
      assert.equal(result.maxEventTs, Date.parse('2026-06-10T13:00:00.000Z'));
      assert.deepEqual((await store.reader.find()).map((e) => e.id).sort(), ['new', 'old']);
    } finally {
      store.dispose();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('still surfaces a genuine SQL failure under a watermark: warns and ingests nothing', async () => {
    const warns: string[] = [];
    const logger = { warn: (_t: string, m: string) => { warns.push(m); }, debug: () => undefined, info: () => undefined, error: () => undefined };
    let attempts = 0;
    const conn = {
      stream: async () => {
        attempts++;
        throw new Error('IO Error: disk exploded');
      },
    };
    const reader = new DuckDBFileReader(conn as never, { insert: async () => 0 } as never, logger);
    const result = await reader.ingestGlob('/x/*.ndjson', () => null, ctx, 1_000);
    assert.deepEqual(result, { inserted: 0, maxEventTs: null });
    assert.equal(attempts, 1, 'only a missing-column error triggers the unfiltered retry');
    assert.equal(warns.length, 1);
    assert.match(warns[0]!, /disk exploded/);
  });
});

describe('DuckDBFileReader.ingestSqlite — extension failures', () => {
  it('does not retry a failed INSTALL on every tick', async () => {
    const calls: string[] = [];
    const conn = {
      run: async (sql: string) => {
        calls.push(sql);
        if (sql.startsWith('INSTALL')) throw new Error('offline: cannot download extension');
        return undefined;
      },
    };
    const warns: string[] = [];
    const logger = { warn: (_t: string, m: string) => { warns.push(m); }, debug: () => undefined, info: () => undefined, error: () => undefined };
    const reader = new DuckDBFileReader(conn as never, { insert: async () => 0 } as never, logger);

    for (let tick = 0; tick < 3; tick++) {
      const result = await reader.ingestSqlite('/db/spans.sqlite', 'SELECT 1', () => null, ctx);
      assert.deepEqual(result, { inserted: 0, maxEventTs: null });
    }
    assert.equal(calls.filter((c) => c === 'INSTALL sqlite').length, 1, 'INSTALL is attempted once per session');
    assert.ok(!calls.some((c) => c.startsWith('ATTACH')), 'nothing is attached without the extension');
    assert.ok(warns.length >= 1, 'the failure is still reported');
  });
});

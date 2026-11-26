import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventStore } from '../../../src/extension-backend/store/EventStore';
import { EventReader, SnapshotCacheToken, SnapshotSourceData } from '../../../src/extension-backend/store/EventReader';
import { EventWriter } from '../../../src/extension-backend/store/EventWriter';
import type { RecordFilter } from '../../../src/extension-backend/store/EventRepository';
import { makeEvent } from '../helpers';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-snapcache-'));
}

describe('EventReader.readSnapshotCache — clock-dependent totals', () => {
  it('recomputes today/MTD when the local day changes without any write', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      const day1 = new Date(2026, 5, 10, 12).getTime();
      const day2 = new Date(2026, 5, 11, 12).getTime();
      await store.writer.insert([
        makeEvent({ id: 'a', ts: day1, credits: 3 }),
        makeEvent({ id: 'b', ts: day2, credits: 5 }),
      ]);
      let now = day1;
      const reader = new EventReader(store.conn, { version: 0 }, () => now);

      const before = await reader.readSnapshotCache();
      assert.equal(before.totals.today.credits, 3);
      assert.equal(before.totals.mtd.credits, 8);

      now = day2; // midnight passed; nothing was written
      const after = await reader.readSnapshotCache();
      assert.equal(after.totals.today.credits, 5, 'yesterday’s memo must not serve the new day');
    } finally { store.dispose(); }
  });

  it('recomputes month-to-date when the month changes', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      const june30 = new Date(2026, 5, 30, 12).getTime();
      const july1 = new Date(2026, 6, 1, 12).getTime();
      await store.writer.insert([
        makeEvent({ id: 'j', ts: june30, credits: 2 }),
        makeEvent({ id: 'k', ts: july1, credits: 7 }),
      ]);
      let now = june30;
      const reader = new EventReader(store.conn, { version: 0 }, () => now);

      assert.equal((await reader.readSnapshotCache()).totals.mtd.credits, 2);
      now = july1;
      assert.equal((await reader.readSnapshotCache()).totals.mtd.credits, 7);
    } finally { store.dispose(); }
  });

  it('still serves the memo within the same day and version', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      await store.writer.insert([makeEvent({ id: 'a', ts: new Date(2026, 5, 10, 9).getTime() })]);
      let now = new Date(2026, 5, 10, 10).getTime();
      const reader = new EventReader(store.conn, { version: 0 }, () => now);
      const first = await reader.readSnapshotCache();
      now = new Date(2026, 5, 10, 23, 59).getTime();
      assert.strictEqual(await reader.readSnapshotCache(), first);
    } finally { store.dispose(); }
  });

  it('does not cache a result under a version bumped while the read was in flight', async () => {
    const store = await EventStore.open(await tmpDir());
    try {
      const token: SnapshotCacheToken = { version: 0 };
      const writer = new EventWriter(store.conn, 90, token);
      const ts = new Date(2026, 5, 10, 12).getTime();
      await writer.insert([makeEvent({ id: 'a', ts })]);

      let raced = false;
      // A write commits after the snapshot query ran but before the read returns.
      class RacyReader extends EventReader {
        override async readFilteredSnapshot(filter: RecordFilter, now?: number): Promise<SnapshotSourceData> {
          const data = await super.readFilteredSnapshot(filter, now);
          if (!raced) {
            raced = true;
            await writer.insert([makeEvent({ id: 'late', ts: ts + 1 })]);
          }
          return data;
        }
      }
      const reader = new RacyReader(store.conn, token, () => ts);

      const first = await reader.readSnapshotCache();
      assert.equal(first.totals.all.eventCount, 1, 'the in-flight read predates the write');
      const second = await reader.readSnapshotCache();
      assert.equal(second.totals.all.eventCount, 2, 'the stale result must not be cached as current');
    } finally { store.dispose(); }
  });
});

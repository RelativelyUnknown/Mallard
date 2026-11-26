import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryEventStore } from '../../../../src/extension-backend/store/MemoryEventStore';
import { SqliteEventStore } from '../../../../src/extension-backend/store/sqlite/SqliteEventStore';
import type { SqliteStoreOptions } from '../../../../src/extension-backend/store/sqlite/SqliteEventStore';
import { storeContract } from './storeContract';
import type { StoreOpts } from './storeContract';

const sqliteOpts = (o: StoreOpts = {}): SqliteStoreOptions => ({
  ...(o.now ? { now: o.now } : {}),
  ...(o.retentionDays !== undefined ? { retentionDays: o.retentionDays } : {}),
  ...(o.maxRawEvents !== undefined ? { maxRawEvents: o.maxRawEvents } : {}),
  // Small chunks so the multi-transaction compaction path runs on small data.
  compactChunkRows: 7,
});

storeContract('SqliteEventStore (:memory:)', async (o) => {
  const store = await SqliteEventStore.open(':memory:', sqliteOpts(o));
  return { store, cleanup: () => store.close() };
});

storeContract('SqliteEventStore (file)', async (o) => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mallard-store-'));
  const store = await SqliteEventStore.open(dir, sqliteOpts(o));
  return {
    store,
    cleanup: async () => {
      await store.close();
      await fs.promises.rm(dir, { recursive: true, force: true });
    },
  };
});

storeContract('MemoryEventStore', (o = {}) => {
  const store = new MemoryEventStore({
    ...(o.now ? { now: o.now } : {}),
    ...(o.retentionDays !== undefined ? { retentionDays: o.retentionDays } : {}),
    ...(o.maxRawEvents !== undefined ? { maxRawEvents: o.maxRawEvents } : {}),
  });
  return Promise.resolve({ store, cleanup: () => store.close() });
});

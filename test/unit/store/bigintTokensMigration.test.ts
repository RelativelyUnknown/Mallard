import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DuckDBInstance } from '@duckdb/node-api';
import { EventStore } from '../../../src/extension-backend/store/EventStore';
import { readRows } from '../../../src/extension-backend/store/dbUtils';
import { DB_META_SCHEMA_VERSION_KEY } from '../../../src/extension-backend/store/schema/constants';
import { makeEvent } from '../helpers';

/** A database as shipped before migration 0006: INTEGER token columns, schema_version 5. */
async function createLegacyDb(dir: string): Promise<void> {
  const instance = await DuckDBInstance.create(path.join(dir, 'events.duckdb'));
  const conn = await instance.connect();
  await conn.run(`
    CREATE TABLE events (
      id VARCHAR PRIMARY KEY, ts BIGINT NOT NULL, modelId VARCHAR NOT NULL,
      surface VARCHAR NOT NULL, source VARCHAR NOT NULL,
      credits DOUBLE NOT NULL, cost DOUBLE NOT NULL,
      promptTokens INTEGER, completionTokens INTEGER,
      estimated BOOLEAN NOT NULL DEFAULT TRUE,
      repo VARCHAR, costByCategory VARCHAR, branch VARCHAR, attribution VARCHAR, language VARCHAR
    );
    CREATE INDEX idx_ts ON events(ts);
    CREATE INDEX idx_model ON events(modelId);
    CREATE INDEX idx_repo ON events(repo);
    CREATE INDEX idx_branch ON events(branch);
    CREATE TABLE meta (key VARCHAR PRIMARY KEY, value VARCHAR);
    INSERT INTO meta VALUES ('${DB_META_SCHEMA_VERSION_KEY}', '5');
    INSERT INTO events (id, ts, modelId, surface, source, credits, cost, promptTokens, completionTokens, estimated)
      VALUES ('old', ${new Date(2026, 0, 10, 12).getTime()}, 'gpt-4o', 'chat', 'local', 1, 0.04, 2000000000, 7, false);
  `);
  conn.closeSync();
  instance.closeSync();
}

describe('migration 0006 — BIGINT token columns', () => {
  it('widens a legacy database in place, keeping its rows and indexes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-mig6-'));
    await createLegacyDb(dir);

    const store = await EventStore.open(dir);
    try {
      const types = await readRows(
        store.conn,
        `SELECT column_name, data_type FROM duckdb_columns()
         WHERE table_name = 'events' AND column_name IN ('promptTokens', 'completionTokens')`,
        (r) => `${String(r['column_name'])}:${String(r['data_type'])}`,
      );
      assert.deepEqual(types.sort(), ['completionTokens:BIGINT', 'promptTokens:BIGINT']);
      assert.equal(await store.getMeta(DB_META_SCHEMA_VERSION_KEY), '6');

      const indexes = await readRows(store.conn, `SELECT index_name FROM duckdb_indexes() WHERE table_name = 'events'`,
        (r) => String(r['index_name']));
      for (const name of ['idx_ts', 'idx_model', 'idx_repo', 'idx_branch', 'idx_ts_model_surface_source']) {
        assert.ok(indexes.includes(name), `${name} survives (or is recreated by) the migration`);
      }

      // The widened column now holds a rolled-up day that exceeds INTEGER.
      await store.writer.insert([
        makeEvent({ id: 'more', ts: new Date(2026, 0, 10, 13).getTime(), promptTokens: 2_000_000_000 }),
      ]);
      await store.compact(new Date(2026, 5, 15).getTime());
      const [rolled] = (await store.reader.find()).filter((e) => e.id.startsWith('roll:'));
      assert.equal(rolled!.promptTokens, 4_000_000_000);
    } finally { store.dispose(); }

    const reopened = await EventStore.open(dir); // already migrated: runs clean again
    try {
      assert.equal((await reopened.reader.find()).length, 1);
    } finally { reopened.dispose(); }
  });
});

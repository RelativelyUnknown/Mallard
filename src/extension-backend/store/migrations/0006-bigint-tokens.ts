import type { DuckDBConnection } from '@duckdb/node-api';
import { readRows } from '../dbUtils';
import { CREATE_EVENT_INDEXES_SQL, DROP_EVENT_INDEXES_SQL } from '../schema/ddl';
import type { Migration } from './types';

const TOKEN_COLUMNS = ['promptTokens', 'completionTokens'] as const;

/**
 * A rolled-up day sums every request of one model/repo/surface, which can pass
 * INTEGER's 2.1B range on a heavy agent day — the rollup then failed on every
 * compaction. Fresh databases already create these columns as BIGINT (ddl.ts);
 * this widens the ones created before.
 */
export const bigintTokens: Migration = {
  version: 6,
  description: 'Widen events.promptTokens / completionTokens to BIGINT.',
  up: widenTokenColumns,
};

async function widenTokenColumns(conn: DuckDBConnection): Promise<void> {
  const narrow = await readRows(
    conn,
    `SELECT column_name FROM duckdb_columns()
     WHERE table_name = 'events' AND data_type <> 'BIGINT'
       AND column_name IN (${TOKEN_COLUMNS.map((c) => `'${c}'`).join(', ')})`,
    (r) => String(r['column_name']),
  );
  if (narrow.length === 0) return;

  await conn.run('BEGIN TRANSACTION');
  try {
    // DuckDB cannot ALTER a column type while indexes depend on the table.
    await conn.run(DROP_EVENT_INDEXES_SQL);
    for (const column of narrow) {
      await conn.run(`ALTER TABLE events ALTER ${column} TYPE BIGINT`);
    }
    await conn.run(CREATE_EVENT_INDEXES_SQL);
    await conn.run('COMMIT');
  } catch (err) {
    await conn.run('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

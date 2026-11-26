/**
 * The WHERE clause of a store read: `FilterClauseBuilder` (plain `?`-parameter
 * SQL, valid in SQLite as is: `col >= ? AND col < ?`, `col IN (?,?)`,
 * `(repo IN (?) OR repo IS NULL)`) applied to the events columns, with the
 * read window as the time range. "unattributed" in `repos` means `repo IS NULL`;
 * a branch filter never matches a NULL branch. `limit`/`offset` are
 * pagination controls of the old reader and are ignored.
 */
import type { RecordFilter } from '../EventRepository';
import { FilterClauseBuilder } from '../FilterClauseBuilder';
import type { SqlParam } from './Db';

export function whereFor(filter: RecordFilter, fromMs: number, toMs: number): { sql: string; params: SqlParam[] } {
  const fb = new FilterClauseBuilder()
    .addRange({ start: fromMs, end: toMs }, 'ts')
    .addIn(filter.models, 'modelId')
    .addIn(filter.surfaces, 'surface')
    .addIn(filter.sources, 'source')
    .addIn(filter.branches, 'branch')
    .addRepos(filter.repos, 'repo', 'repo IS NULL');
  return { sql: fb.build(), params: fb.params as SqlParam[] };
}

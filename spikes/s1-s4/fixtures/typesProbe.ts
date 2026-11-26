// Type-level probe: which node:sqlite members does a given @types/node version expose?
// tsc reports one error per member that does not exist in that @types/node version.
// Runtime reality (see results/api/matrix.txt): everything marked "22.15+" / "22.16+" below is ABSENT at 22.13/22.14.
import { DatabaseSync, StatementSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');
const st: StatementSync = db.prepare('select 1');

// available at 22.13 runtime
db.exec('select 1');
st.run();
st.get();
st.all();
for (const _r of st.iterate()) void _r;
st.setReadBigInts(true);
db.close();

// ---- NOT available at 22.13.0 runtime; flagged here if @types/node does not know them ----
export const probe22_15_isOpen = (d: DatabaseSync): boolean => d.isOpen; // 22.15
export const probe22_15_uri = (): DatabaseSync => new DatabaseSync('file:x.db?immutable=1', { readOnly: true }); // runtime 22.15
export const probe22_16_timeout = (): DatabaseSync => new DatabaseSync('x.db', { timeout: 1000 }); // 22.16 runtime
export const probe22_16_location = (d: DatabaseSync): string | null => d.location(); // 22.16
export const probe22_16_isTransaction = (d: DatabaseSync): boolean => d.isTransaction; // 22.16
export const probe22_16_aggregate = (d: DatabaseSync): void => d.aggregate('x', { start: 0, step: (a: number, v: number) => a + v }); // 22.16
export const probe22_16_columns = (s: StatementSync) => s.columns(); // 22.16
export const probe22_16_returnArrays = (s: StatementSync) => s.setReturnArrays(true); // 22.16
export const probe24_9_tagStore = (d: DatabaseSync) => d.createTagStore(); // 24.9 only (not in any 22.x)

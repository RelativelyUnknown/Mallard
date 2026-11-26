import { loadSqlite, loadSqliteViaImport } from './lazySqlite';

async function main(): Promise<void> {
  const real = loadSqlite();
  const viaImport = await loadSqliteViaImport();
  // injectable loader: simulate the module being absent (what Node < 22.13 does without a flag)
  const simulated = loadSqlite(() => {
    const e = new Error('No such built-in module: node:sqlite') as NodeJS.ErrnoException;
    e.code = 'ERR_UNKNOWN_BUILTIN_MODULE';
    throw e;
  });
  const out = {
    node: process.versions.node,
    realRequire: real.ok ? 'loaded' : { code: real.code, message: real.message },
    dynamicImport: viaImport.ok ? 'loaded' : { code: viaImport.code, message: viaImport.message },
    simulatedMissing: simulated.ok ? 'loaded' : { code: simulated.code, message: simulated.message },
    roundTrip: undefined as unknown,
  };
  if (real.ok) {
    const db = new real.mod.DatabaseSync(':memory:');
    db.exec('CREATE TABLE t(a INTEGER); INSERT INTO t VALUES (42)');
    out.roundTrip = db.prepare('SELECT a FROM t').get();
    db.close();
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
void main();

'use strict';
// Runs lib/sqliteChecks.cjs under whichever Node runs this file; prints JSON on stdout.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSqliteChecks } = require('../lib/sqliteChecks.cjs');

const warnings = [];
process.on('warning', (w) => warnings.push(`${w.name}: ${w.message}`));
const out = { node: process.versions.node, results: [], warnings };
try {
  const sqlite = require('node:sqlite');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-feat-'));
  out.results = runSqliteChecks({ sqlite, dir });
} catch (e) {
  out.loadError = String(e.message);
}
setImmediate(() => process.stdout.write(JSON.stringify(out, null, 2) + '\n'));

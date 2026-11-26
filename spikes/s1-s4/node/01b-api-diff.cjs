'use strict';
// Summarise results/api/node-*.json into a version matrix of API members and option checks.
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'results', 'api');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
const docs = files
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
  .sort((a, b) => a.node.localeCompare(b.node, undefined, { numeric: true }));
const vers = docs.map((d) => d.node);
const pad = (s, n) => String(s).padEnd(n);

console.log(pad('node', 44) + vers.map((v) => pad(v, 9)).join(''));
console.log(pad('require("node:sqlite") loads (no flags)', 44) + docs.map((d) => pad(d.loads ? 'yes' : 'NO', 9)).join(''));
const all = (key) => [...new Set(docs.flatMap((d) => d[key]))].sort();
for (const [label, key] of [['DatabaseSync.', 'databaseSyncProto'], ['StatementSync.', 'statementSyncProto'], ['module export ', 'moduleExports']]) {
  for (const m of all(key)) {
    console.log(pad(label + m, 44) + docs.map((d) => pad(d[key].includes(m) ? 'yes' : '-', 9)).join(''));
  }
}
const checkNames = [...new Set(docs.flatMap((d) => Object.keys(d.checks)))];
for (const n of checkNames) {
  console.log(pad('check: ' + n, 44) + docs.map((d) => pad(d.checks[n] ? (d.checks[n].ok ? 'ok' : 'FAIL') : '-', 9)).join(''));
}
console.log('\nFailure details (first version where each check fails):');
for (const n of checkNames) {
  const d = docs.find((x) => x.checks[n] && !x.checks[n].ok);
  if (d) console.log(`  ${n} @${d.node}: ${d.checks[n].error}`);
}
console.log('\nValues at 22.13.0 for ok checks:');
const d13 = docs.find((d) => d.node === '22.13.0');
if (d13) for (const [k, v] of Object.entries(d13.checks)) if (v.ok) console.log(' ', k, JSON.stringify(v.value));

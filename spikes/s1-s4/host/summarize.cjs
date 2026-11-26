'use strict';
// Print a side-by-side summary of results/host/*/ (S1 + S4) so runs on different VS Code versions can be compared.
const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '..', 'results', 'host');
const labels = fs.readdirSync(base).filter((d) => fs.existsSync(path.join(base, d, 'meta.json'))).sort();
const J = (l, f) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(base, l, f), 'utf8'));
  } catch (_) {
    return null;
  }
};
console.log('== runtime in the real extension host ==');
for (const l of labels) {
  const a = J(l, 'activation.json');
  const m = J(l, 'meta.json');
  const st = J(l, 'suite-start.json');
  if (!a) {
    console.log(l.padEnd(28), 'NO ACTIVATION (exit ' + (m && m.exitCode) + ')');
    continue;
  }
  const v = a.info.versions;
  console.log(
    l.padEnd(28),
    `vscode=${a.info.vscodeVersion} node=${v.node} electron=${v.electron} sqlite=${v.sqlite} proc=${a.info.processType} onStartupFinished=${st && st.activatedByStartup} loads=${a.sqliteLoads}` +
      (a.sqliteLoadError ? ` err=${a.sqliteLoadError.code}` : ''),
  );
  console.log(' '.repeat(28), 'execArgv=' + JSON.stringify(a.info.execArgv), 'warningInLogs=' + (m.logWarningHits || []).length, 'warningOnStdout=' + (m.stdoutWarningHits || []).length);
}
const s1 = Object.fromEntries(labels.map((l) => [l, J(l, 's1.json')]));
const ids = new Set();
for (const l of labels) {
  const s = s1[l];
  if (s) for (const g of Object.values(s.results)) if (Array.isArray(g)) g.forEach((x) => ids.add(x.id));
}
console.log('\n== S1 checks (PASS/FAIL per VS Code build) ==');
const stat = (l, id) => {
  const s = s1[l];
  if (!s) return 'n/a';
  for (const g of Object.values(s.results)) if (Array.isArray(g)) {
    const x = g.find((r) => r.id === id);
    if (x) return x.status || (x.pass ? 'PASS' : 'FAIL');
  }
  return '-';
};
const s1labels = labels.filter((l) => s1[l]);
console.log('id'.padEnd(7) + s1labels.map((l) => l.slice(0, 18).padEnd(20)).join(''));
for (const id of [...ids].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) console.log(id.padEnd(7) + s1labels.map((l) => stat(l, id).padEnd(20)).join(''));
console.log('\n== S4 checks ==');
const s4 = Object.fromEntries(labels.map((l) => [l, J(l, 's4.json')]));
const s4labels = labels.filter((l) => s4[l]);
const ids4 = [...new Set(s4labels.flatMap((l) => s4[l].results.map((r) => r.id)))];
console.log('id'.padEnd(10) + s4labels.map((l) => l.slice(0, 22).padEnd(24)).join(''));
for (const id of ids4) console.log(id.padEnd(10) + s4labels.map((l) => ((s4[l].results.find((r) => r.id === id) || {}).status || '-').padEnd(24)).join(''));

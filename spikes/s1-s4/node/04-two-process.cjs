'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTwoProcessChecks } = require('../lib/twoProcess.cjs');

(async () => {
  const out = { node: process.versions.node, results: [] };
  try {
    const sqlite = require('node:sqlite');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-two-'));
    out.results = await runTwoProcessChecks({ sqlite, dir });
  } catch (e) {
    out.loadError = String(e.stack || e.message);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
})();

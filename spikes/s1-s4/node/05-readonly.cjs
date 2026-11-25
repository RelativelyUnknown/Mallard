'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runReadonlyChecks } = require('../lib/readonlyChecks.cjs');

(async () => {
  const out = { node: process.versions.node, results: [] };
  try {
    const sqlite = require('node:sqlite');
    // URI support (file:...) arrived in 22.15; probe rather than assume.
    let uriSupported = true;
    try {
      const p = path.join(os.tmpdir(), `uri-probe-${process.pid}.db`);
      new sqlite.DatabaseSync(p).close();
      new sqlite.DatabaseSync(`file:${p}?mode=ro`, { readOnly: true }).close();
      fs.rmSync(p, { force: true });
    } catch (_) {
      uriSupported = false;
    }
    const dir = fs.mkdtempSync(path.join(process.env.SPIKE_TMP || os.tmpdir(), 's1-ro-'));
    out.uriSupported = uriSupported;
    out.results = await runReadonlyChecks({ sqlite, dir, uriSupported });
  } catch (e) {
    out.loadError = String(e.stack || e.message);
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
})();

/**
 * Confines every `os.tmpdir()` the unit suite uses to one directory that is
 * deleted when the run ends. Many tests open a real DuckDB store in a
 * `mkdtemp` dir; without this each run leaked a hundred or more of them into
 * the shared temp dir (tens of GB across repeated runs).
 * Loaded first so module-level `os.tmpdir()` calls see it too.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mallard-test-run-'));
process.env['TMPDIR'] = root;

process.on('exit', () => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

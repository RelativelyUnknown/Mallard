'use strict';
// Runs INSIDE the VS Code extension host (extensionTestsPath). Not mocha: a plain async run() that writes
// JSON evidence to $SPIKE_OUT. Throwing/rejecting makes VS Code exit non-zero.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT_ID = 'spike.mallard-spike';
const root = path.join(__dirname, '..', '..');

function out(name, data) {
  const dir = process.env.SPIKE_OUT;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2));
}

async function run() {
  const suites = (process.env.SPIKE_SUITES || 's1,s4').split(',');
  const ext = vscode.extensions.getExtension(EXT_ID);
  if (!ext) {
    out('suite-start.json', { extensionFound: false, trusted: vscode.workspace.isTrusted, note: 'extension not present in this extension host (disabled?)', allSpike: vscode.extensions.all.filter((e) => /spike/.test(e.id)).map((e) => e.id) });
    throw new Error('spike extension not found');
  }

  // Did onStartupFinished activate it without us asking?
  const t0 = Date.now();
  while (!ext.isActive && Date.now() - t0 < 30000) await sleep(100);
  const activatedByStartup = ext.isActive;
  const waitedMs = Date.now() - t0;
  const api = ext.isActive ? ext.exports : await ext.activate();
  const info = api.info();
  out('suite-start.json', { activatedByStartup, waitedMs, info, trusted: vscode.workspace.isTrusted });

  if (suites.includes('s1')) {
    const { runSqliteChecks } = require('../../lib/sqliteChecks.cjs');
    const { runTwoProcessChecks } = require('../../lib/twoProcess.cjs');
    const { runReadonlyChecks } = require('../../lib/readonlyChecks.cjs');
    const sqlite = api.sqlite();
    const s1 = { info, activatedByStartup, sqliteLoads: !!sqlite, activation: api.activation, results: {}, warnings: [] };
    if (sqlite) {
      const base = path.join(api.globalStoragePath(), 's1-' + Date.now());
      try {
        s1.results.single = runSqliteChecks({ sqlite, dir: path.join(base, 'single') });
      } catch (e) {
        s1.results.single = { error: String(e.stack) };
      }
      out('s1.json', s1);
      try {
        // Electron binary as a plain Node for the second process
        s1.results.twoProcess = await runTwoProcessChecks({ sqlite, dir: path.join(base, 'two'), execPath: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } });
      } catch (e) {
        s1.results.twoProcess = { error: String(e.stack) };
      }
      out('s1.json', s1);
      try {
        let uriSupported = true;
        try {
          const p = path.join(base, 'uri-probe.db');
          fs.mkdirSync(base, { recursive: true });
          new sqlite.DatabaseSync(p).close();
          new sqlite.DatabaseSync(`file:${p}?mode=ro`, { readOnly: true }).close();
        } catch (_) {
          uriSupported = false;
        }
        s1.uriSupported = uriSupported;
        s1.results.readonly = await runReadonlyChecks({ sqlite, dir: path.join(base, 'ro'), execPath: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, uriSupported });
      } catch (e) {
        s1.results.readonly = { error: String(e.stack) };
      }
    }
    s1.warnings = api.warnings();
    out('s1.json', s1);
  }

  if (suites.includes('s4')) {
    const { runSettingsChecks } = require('../../lib/settingsChecks.cjs');
    const s4 = { info, trusted: vscode.workspace.isTrusted, results: [] };
    try {
      s4.results = await runSettingsChecks({
        vscode,
        extensionId: EXT_ID,
        userDataDir: process.env.SPIKE_USER_DATA,
        workspaceDir: process.env.SPIKE_WORKSPACE,
        pkgJsonPath: path.join(root, 'package.json'),
        trustLabel: process.env.SPIKE_TRUST,
      });
    } catch (e) {
      s4.error = String(e.stack);
    }
    out('s4.json', s4);
  }
  out('done.json', { done: true, at: new Date().toISOString() });
}

module.exports = { run };

'use strict';
// Throwaway extension for spikes S1 and S4. Activates on startup (onStartupFinished), records what the
// REAL extension host looks like, and exposes the probes so the test suite (host/suite) can drive them.
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

// Installed BEFORE node:sqlite is required so the ExperimentalWarning is captured.
const warnings = [];
process.on('warning', (w) => warnings.push({ name: w.name, message: w.message, at: Date.now() }));

/** Injectable loader (same shape as the plan's store/sqlite/Db.ts). */
function loadSqlite(loader = () => require('node:sqlite')) {
  try {
    return { ok: true, mod: loader() };
  } catch (e) {
    return { ok: false, code: e && e.code, message: e && e.message };
  }
}

function runtimeInfo(context) {
  const p = process;
  return {
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    uiKind: vscode.env.uiKind,
    remoteName: vscode.env.remoteName || null,
    platform: p.platform,
    arch: p.arch,
    pid: p.pid,
    execPath: p.execPath,
    processType: p.type || null,
    versions: {
      node: p.versions.node,
      electron: p.versions.electron || null,
      chrome: p.versions.chrome || null,
      v8: p.versions.v8,
      sqlite: p.versions.sqlite || null,
    },
    execArgv: p.execArgv,
    NODE_OPTIONS: process.env.NODE_OPTIONS || null,
    ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || null,
    globalStorage: context.globalStorageUri.fsPath,
    extensionKind: context.extension.extensionKind,
  };
}

function writeOut(name, data) {
  const out = process.env.SPIKE_OUT;
  if (!out) return;
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, name), JSON.stringify(data, null, 2));
  } catch (_) {
    /* best effort */
  }
}

let ctx;
async function activate(context) {
  ctx = context;
  const t0 = Date.now();
  const info = runtimeInfo(context);
  const warningsBefore = warnings.length;
  const loaded = loadSqlite();
  const activation = {
    activatedAt: new Date().toISOString(),
    info,
    sqliteLoads: loaded.ok,
    sqliteLoadError: loaded.ok ? null : { code: loaded.code, message: loaded.message },
    sqliteExports: loaded.ok ? Object.keys(loaded.mod).sort() : null,
    warningsEmittedByRequire: warnings.slice(warningsBefore),
    activationMs: Date.now() - t0,
  };
  writeOut('activation.json', activation);

  // S4 item 3 helper: open the real Settings UI filtered to this extension so a CDP-driven probe can read it.
  if (process.env.SPIKE_OPEN_SETTINGS) {
    setTimeout(() => {
      void vscode.commands.executeCommand('workbench.action.openSettings', process.env.SPIKE_OPEN_SETTINGS);
    }, 4000);
  }

  return {
    activation,
    warnings: () => warnings.slice(),
    sqlite: () => (loaded.ok ? loaded.mod : null),
    loadSqlite,
    info: () => runtimeInfo(ctx),
    globalStoragePath: () => ctx.globalStorageUri.fsPath,
  };
}
function deactivate() {}

module.exports = { activate, deactivate };

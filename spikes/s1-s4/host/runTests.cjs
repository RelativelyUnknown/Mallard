'use strict';
// Launch a REAL VS Code (downloaded by @vscode/test-electron) with the spike extension + test suite.
// We spawn the binary ourselves instead of calling runTests() because runTests() always adds
// --disable-workspace-trust, which would make the "untrusted workspace" S4 checks impossible.
//
//   xvfb-run -a node host/runTests.cjs <version|stable> [--untrusted] [--suites=s1,s4] [--tag=name]
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--')) || 'stable';
const untrusted = args.includes('--untrusted');
const suites = (args.find((a) => a.startsWith('--suites=')) || '--suites=s1,s4').split('=')[1];
const tag = (args.find((a) => a.startsWith('--tag=')) || '').split('=')[1] || '';
const label = `${version}-${untrusted ? 'untrusted' : 'trusted'}${tag ? '-' + tag : ''}`;

(async () => {
  const exe = await downloadAndUnzipVSCode({ version, cachePath: path.join(root, '.vscode-test') });
  // keep this path SHORT: newer VS Code puts a unix socket in user-data-dir (limit ~107 chars)
  const scratch = path.join(process.env.SPIKE_TMP || os.tmpdir(), `v${Date.now().toString(36)}`);
  const userData = path.join(scratch, 'user-data');
  const extDir = path.join(scratch, 'extensions');
  const workspace = path.join(scratch, 'workspace');
  const outDir = path.join(root, 'results', 'host', label);
  for (const d of [userData, extDir, workspace, outDir, path.join(userData, 'User'), path.join(workspace, '.vscode')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(userData, 'User', 'settings.json'), '{}');
  if (!untrusted) {
    // nothing: the flag below disables workspace trust entirely
  }
  const launch = [
    workspace,
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extDir}`,
    `--extensionDevelopmentPath=${process.env.SPIKE_EXT_DIR || root}`,
    `--extensionTestsPath=${path.join(root, 'host', 'suite', 'index.cjs')}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-gpu-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes',
    '--no-cached-data',
    '--disable-telemetry',
    '--log=trace',
    ...(untrusted ? [] : ['--disable-workspace-trust']),
  ];
  console.log(`[spike] ${label}: ${exe}`);
  const logFile = fs.openSync(path.join(outDir, 'vscode-stdout.log'), 'w');
  const child = spawn(exe, launch, {
    stdio: ['ignore', logFile, logFile],
    env: {
      ...process.env,
      SPIKE_OUT: outDir,
      SPIKE_USER_DATA: userData,
      SPIKE_WORKSPACE: workspace,
      SPIKE_TRUST: untrusted ? 'untrusted' : 'trusted',
      SPIKE_SUITES: suites,
      SPIKE_TMP: process.env.SPIKE_TMP || '',
    },
  });
  const killer = setTimeout(() => {
    console.log('[spike] timeout, killing');
    child.kill('SIGKILL');
  }, 240000);
  const code = await new Promise((r) => child.on('exit', r));
  clearTimeout(killer);
  console.log(`[spike] ${label}: exit ${code}`);

  // grep every log VS Code wrote for the ExperimentalWarning
  const hits = [];
  (function walk(d) {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(log|txt)$/.test(f.name)) {
        const t = fs.readFileSync(p, 'utf8');
        t.split('\n').forEach((line, i) => {
          if (/ExperimentalWarning|SQLite is an experimental/.test(line)) hits.push({ file: path.relative(userData, p), line: i + 1, text: line.slice(0, 300) });
        });
      }
    }
  })(path.join(userData, 'logs'));
  const stdoutText = fs.readFileSync(path.join(outDir, 'vscode-stdout.log'), 'utf8');
  const stdoutHits = stdoutText.split('\n').filter((l) => /ExperimentalWarning|SQLite is an experimental/.test(l)).map((l) => l.slice(0, 300));
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ label, version, exe, exitCode: code, untrusted, logWarningHits: hits.slice(0, 20), stdoutWarningHits: stdoutHits.slice(0, 20), userData, workspace }, null, 2));
  process.exit(code === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});

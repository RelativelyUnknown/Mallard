'use strict';
// S4 item 3: drive the REAL Settings editor of a downloaded VS Code over CDP (Playwright connectOverCDP)
// and record how array-of-object / object / scalar settings are rendered ("Edit in settings.json" link?).
//
//   xvfb-run -a node host/settingsUi.cjs <version|stable> [--query=@ext:spike.mallard-spike]
// Needs the globally installed `playwright` (resolved via NODE_PATH or `npm root -g`).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');
const { downloadAndUnzipVSCode } = require('@vscode/test-electron');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith('--')) || 'stable';
const query = (args.find((a) => a.startsWith('--query=')) || '--query=@ext:spike.mallard-spike').split('=').slice(1).join('=');
const port = 9333 + Math.floor(Math.random() * 500);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
  }
}

(async () => {
  const { chromium } = loadPlaywright();
  const exe = await downloadAndUnzipVSCode({ version, cachePath: path.join(root, '.vscode-test') });
  const scratch = path.join(process.env.SPIKE_TMP || os.tmpdir(), `u${Date.now().toString(36)}`);
  const userData = path.join(scratch, 'ud');
  const workspace = path.join(scratch, 'ws');
  const outDir = path.join(root, 'results', 'settings-ui');
  for (const d of [path.join(userData, 'User'), workspace, outDir]) fs.mkdirSync(d, { recursive: true });
  // Pre-populate user settings so the UI shows "modified" state for the array/object settings too.
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify(
      {
        'spike.rulesApp': [{ id: 'r1', metric: 'today.credits', op: '>', value: 50 }],
        'spike.branchBudgets': { main: 500 },
        'spike.targets': [{ name: 'prom', url: 'https://example.invalid' }],
        'workbench.startupEditor': 'none',
      },
      null,
      2,
    ),
  );
  const child = spawn(
    exe,
    [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${path.join(scratch, 'ext')}`, `--extensionDevelopmentPath=${root}`, `--remote-debugging-port=${port}`, '--no-sandbox', '--disable-gpu', '--disable-updates', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-telemetry'],
    { stdio: 'ignore', env: { ...process.env, SPIKE_OPEN_SETTINGS: query } },
  );
  const result = { version, query, port, items: [], notes: [] };
  try {
    let browser;
    for (let i = 0; i < 60 && !browser; i++) {
      await sleep(1000);
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      } catch (_) {
        /* not up yet */
      }
    }
    if (!browser) throw new Error('could not attach over CDP');
    let page = null;
    for (let i = 0; i < 90 && !page; i++) {
      for (const ctx of browser.contexts()) for (const p of ctx.pages()) if ((await p.title().catch(() => '')).length || (await p.locator('.monaco-workbench').count().catch(() => 0))) if (await p.locator('.monaco-workbench').count().catch(() => 0)) page = p;
      if (!page) await sleep(1000);
    }
    if (!page) throw new Error('workbench page not found');
    // wait for the settings editor + rows
    await page.waitForSelector('.settings-editor .setting-item', { timeout: 90000 });
    await sleep(2500);
    const items = await page.evaluate(() => {
      return [...document.querySelectorAll('.settings-editor .setting-item')].map((el) => {
        const text = (s) => (el.querySelector(s) ? el.querySelector(s).textContent.trim() : null);
        const links = [...el.querySelectorAll('a')].map((a) => a.textContent.trim());
        const controlKinds = [];
        for (const [k, sel] of Object.entries({
          input: 'input',
          select: 'select, .monaco-select-box',
          checkbox: '.setting-value-checkbox, input[type=checkbox]',
          listWidget: '.setting-list-widget',
          objectWidget: '.setting-list-object-widget, .setting-list-object-list',
          textarea: 'textarea',
        })) {
          if (el.querySelector(sel)) controlKinds.push(k);
        }
        return {
          label: [text('.setting-item-category'), text('.setting-item-label')].filter(Boolean).join(': '),
          description: text('.setting-item-description'),
          links,
          editInSettingsJsonLink: links.some((l) => /edit in settings\.json/i.test(l)),
          controlKinds,
          isModified: el.classList.contains('is-configured') || !!el.querySelector('.setting-indicator.setting-item-modified-indicator:not([style*="display: none"])'),
          html: el.innerHTML.length,
        };
      });
    });
    result.items = items;
    await page.screenshot({ path: path.join(outDir, `settings-${version}.png`) });
    result.title = await page.title();
  } catch (e) {
    result.error = String(e.stack || e.message);
  } finally {
    child.kill('SIGKILL');
  }
  fs.writeFileSync(path.join(outDir, `settings-${version}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2).slice(0, 6000));
  process.exit(0);
})();

/**
 * Playwright smoke test of the REAL built webview: the production esbuild bundle, the page shell and
 * CSP from `renderHtml` (the extension's exact policy, with `'self'` standing in for the webview's
 * `cspSource`), fixture data over the real message protocol, driven in Chromium.
 *
 *     bun run test:webview
 *
 * Covers what jsdom cannot: gridstack's pointer drag and resize, real layout (panel boxes, chart
 * canvases sized to their bodies), the 700 px breakpoint, hide/show keeping the chart node, the
 * keyboard lift mode end to end, and zero CSP violations. NOT part of `npx c8 mocha`.
 *
 * Playwright is not a repo dependency: set PLAYWRIGHT_MODULE to its install directory, or have it
 * resolvable as `playwright` (the Chromium that ships with it is used; nothing is downloaded here).
 * Screenshots go to $WEBVIEW_SMOKE_OUT (default: the OS temp dir).
 */
import { strict as assert } from 'assert';
import { spawnSync } from 'child_process';
import { createReadStream, existsSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { defaultLayout, isLayoutV2 } from '../../src/extension-backend/domain/layout';
import type { LayoutV2 } from '../../src/extension-backend/domain/contracts';
import { DEFAULT_RESTRICTION_STATE, DEFAULT_USER_CONFIG } from '../../src/extension-backend/domain/types';
import { renderHtml } from '../../src/extension-backend/ui/webviewHtml';
import { makeEvent } from '../unit/helpers';
import { buildSnapshot } from '../unit/snapshotFixture';

// Playwright's API surface this script touches (the package is not installed in the repo, so no types).
interface Locator {
  click(opts?: Record<string, unknown>): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  count(): Promise<number>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  isDisabled(): Promise<boolean>;
  focus(): Promise<void>;
  first(): Locator;
  textContent(): Promise<string | null>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  addInitScript(script: string | (() => void)): Promise<void>;
  evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T>;
  locator(selector: string): Locator;
  waitForFunction(fn: () => unknown, arg?: undefined, opts?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(opts: { path: string }): Promise<unknown>;
  on(event: 'console' | 'pageerror', cb: (arg: unknown) => void): void;
  keyboard: { press(key: string): Promise<void> };
  mouse: {
    move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
}
interface Browser {
  newPage(opts: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}

const ROOT = path.resolve(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist', 'webview');
const OUT = process.env['WEBVIEW_SMOKE_OUT'] ?? path.join(os.tmpdir(), 'mallard-webview-smoke');
const WIDE = { width: 1200, height: 1900 };

// ── build + serve ───────────────────────────────────────────────────────────────────────────────

function build(): void {
  const r = spawnSync(process.execPath, ['esbuild.mjs', '--production'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) throw new Error('esbuild failed');
}

function serve(html: string): Promise<{ url: string; close(): void }> {
  const files: Record<string, string> = { '/mallard-icon-128.png': path.join(ROOT, 'media', 'mallard-icon-128.png') };
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '/').split('?')[0]!;
    if (url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    }
    const file = files[url] ?? path.join(DIST, path.basename(url));
    if (!existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const type: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.png': 'image/png' };
    res.setHeader('Content-Type', type[path.extname(file)] ?? 'application/octet-stream');
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    }),
  );
}

/** The extension's own page shell, with `'self'` as the webview's cspSource. */
function shell(): string {
  const webview = {
    cspSource: "'self'",
    asWebviewUri: (uri: { fsPath: string }) => ({ toString: () => `/${path.basename(uri.fsPath)}` }),
  } as unknown as vscode.Webview;
  return renderHtml(webview, vscode.Uri.file(ROOT));
}

function fixtureSnapshot() {
  const now = Date.now();
  const models = ['gpt-4o', 'claude-sonnet-4', 'o3-mini'];
  const surfaces = ['chat', 'agent', 'edit'] as const;
  const events = Array.from({ length: 150 }, (_, i) =>
    makeEvent({
      ts: now - (i % 28) * 86_400_000 - (i % 17) * 3_600_000 - 60_000,
      modelId: models[i % 3]!,
      surface: surfaces[i % 3]!,
      credits: 1 + (i % 7),
      repo: i % 2 ? 'mallard' : 'other',
    }),
  );
  return buildSnapshot(events, {
    now, currency: 'USD', pricePerCredit: 0.04, monthlyBudget: 50, includedCredits: 300,
    filter: {}, source: 'local', status: { kind: 'ok' }, authStatus: 'signed-out',
  });
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────

let step = 0;
const ok = (msg: string): void => console.log(`  ok ${String(++step).padStart(2)}  ${msg}`);

/** x/y are relative to the grid; cx/cy are the viewport coordinates of the box's top-left corner (for the mouse). */
interface Box { id: string; x: number; y: number; w: number; h: number; cx: number; cy: number }
const boxes = (page: Page): Promise<Box[]> =>
  page.evaluate(() => {
    // Relative to the grid's own top-left: the content above it (the edit hint) comes and goes.
    const top = document.getElementById('charts-grid')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('#charts-grid > .grid-stack-item:not([hidden])')].map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute('gs-id')!, x: Math.round(r.x - top.x), y: Math.round(r.y - top.y), w: Math.round(r.width), h: Math.round(r.height), cx: Math.round(r.x), cy: Math.round(r.y) };
    });
  });

const posted = (page: Page): Promise<unknown[]> => page.evaluate(() => (window as unknown as { __posted: unknown[] }).__posted);
const layouts = async (page: Page): Promise<LayoutV2[]> =>
  (await posted(page)).filter((m): m is { type: 'setLayout'; value: LayoutV2 } => (m as { type?: string }).type === 'setLayout').map((m) => m.value);
/** The live region's text once the announcement has landed (it is set on the next animation frame). */
const live = async (page: Page): Promise<string> => {
  await page.waitForTimeout(120);
  return page.evaluate(() => document.getElementById('wv-layout-live')!.textContent ?? '');
};
const panelOf = (l: LayoutV2, id: string) => l.panels.find((p) => p.id === id)!;
const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

async function dragFrom(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 8, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500); // 250 ms persist debounce + gridstack settle
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  build();
  const server = await serve(shell());
  const pw = createRequire(__filename)(process.env['PLAYWRIGHT_MODULE'] ?? 'playwright') as { chromium: { launch(): Promise<Browser> } };
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: WIDE });
    const problems: string[] = [];
    page.on('console', (m) => {
      const msg = m as { type(): string; text(): string };
      if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${String(e)}`));
    // tsx compiles with keepNames, which wraps functions in `__name(...)` helpers that do not exist in the page.
    await page.addInitScript('window.__name = (f) => f;');
    await page.addInitScript(() => {
      const w = window as unknown as { __posted: unknown[]; __csp: string[]; acquireVsCodeApi: () => unknown };
      w.__posted = [];
      w.__csp = [];
      w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => void w.__posted.push(m) });
      document.addEventListener('securitypolicyviolation', (e) => w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
    });
    await page.goto(server.url);

    // The host's replies to `ready`, in the order dashboardBridge sends them.
    const messages = [
      { type: 'theme', kind: 'dark', palette: 'swiss' },
      { type: 'config', value: DEFAULT_USER_CONFIG },
      { type: 'layout', value: defaultLayout() },
      { type: 'restriction', value: DEFAULT_RESTRICTION_STATE },
      { type: 'snapshot', payload: fixtureSnapshot() },
    ];
    await page.evaluate((msgs: unknown[]) => {
      for (const data of msgs) window.dispatchEvent(new MessageEvent('message', { data, origin: 'vscode-webview://smoke' }));
    }, messages);
    try {
      await page.waitForFunction(() => document.querySelectorAll('#charts-grid > .grid-stack-item:not([hidden]) canvas').length >= 4, undefined, { timeout: 15_000 });
    } catch (err) {
      const state = await page.evaluate(() => ({
        items: document.querySelectorAll('#charts-grid > .grid-stack-item').length,
        visible: document.querySelectorAll('#charts-grid > .grid-stack-item:not([hidden])').length,
        canvases: document.querySelectorAll('canvas').length,
        contentHidden: document.getElementById('content')?.hidden,
        csp: (window as unknown as { __csp: string[] }).__csp,
      }));
      console.error('boot failed', JSON.stringify(state), problems);
      throw err;
    }
    await page.waitForTimeout(400);
    ok('the production bundle boots under the extension CSP and renders the fixture');

    // ── view mode ─────────────────────────────────────────────────────────────────────────────
    const view = await boxes(page);
    assert.ok(view.length >= 4, `visible panels: ${view.length}`);
    for (const [i, a] of view.entries()) for (const b of view.slice(i + 1)) assert.ok(!overlap(a, b), `${a.id} overlaps ${b.id}`);
    const normal = view.find((b) => b.h === 13 * 24 && b.w < 400)!;
    assert.ok(normal, 'a 1-column, 13-row panel is 312 px tall');
    const body = await page.evaluate((id: string) => {
      const el = document.querySelector<HTMLElement>(`[data-panel="${id}"] .wv-chart-body`)!;
      const canvas = el.querySelector('canvas');
      return { h: el.getBoundingClientRect().height, w: el.getBoundingClientRect().width, canvasW: canvas?.getBoundingClientRect().width ?? 0, canvasH: canvas?.getBoundingClientRect().height ?? 0 };
    }, normal.id);
    assert.ok(Math.abs(body.h - 259) <= 3, `normal tier body is ~259 px, got ${body.h}`);
    assert.ok(body.canvasW > body.w - 24 && body.canvasW <= body.w, `canvas follows its body width (${body.canvasW} in ${body.w})`);
    assert.ok(body.canvasH > body.h - 24 && body.canvasH <= body.h, `canvas follows its body height (${body.canvasH} in ${body.h})`);
    assert.equal(await page.locator('[data-act="move"]').first().isVisible(), false, 'no edit controls (and so no tab stops) in view mode');
    assert.equal(await page.locator('#layout-reset').isVisible(), false, 'Reset layout shows only while editing');
    assert.equal(await page.locator('#add-chart-menu').isVisible(), false, 'the closed Add chart menu leaves no empty box behind');
    await page.screenshot({ path: path.join(OUT, '1-view.png') });
    ok('view mode: no overlaps, 13-row body is 259 px, charts fill their bodies, no edit tab stops');

    // ── edit mode + pointer drag + pointer resize ─────────────────────────────────────────────
    await page.locator('#layout-edit').click();
    assert.equal(await page.locator('#layout-edit').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-panel="daily"] [data-act="move"]').isVisible(), true);
    const before = await boxes(page);
    const src = before.find((b) => b.id === 'hourly')!;
    const dst = before.find((b) => b.id === 'daily')!;
    await dragFrom(page, { x: src.cx + 60, y: src.cy + 20 }, { x: dst.cx + 60, y: dst.cy + 20 });
    const afterDrag = await boxes(page);
    for (const [i, a] of afterDrag.entries()) for (const b of afterDrag.slice(i + 1)) assert.ok(!overlap(a, b), `after drag: ${a.id} overlaps ${b.id}`);
    const saved = (await layouts(page)).at(-1)!;
    assert.ok(saved && isLayoutV2(saved), 'a valid setLayout was posted after the drag');
    const hourly = panelOf(saved, 'hourly');
    assert.ok(hourly.y < 26, `hourly moved up from its row (y=${hourly.y})`);
    await page.screenshot({ path: path.join(OUT, '2-after-drag.png') });
    ok('pointer drag by the header moves a panel, nothing overlaps, one valid layout is persisted');

    const countBeforeResize = (await layouts(page)).length;
    const handle = await page.locator('[gs-id="models"] .ui-resizable-se').boundingBox();
    assert.ok(handle, 'the south-east resize handle is there in edit mode');
    const modelsBefore = panelOf((await layouts(page)).at(-1)!, 'models');
    await dragFrom(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x + 260, y: handle.y + 190 });
    const resized = (await layouts(page)).at(-1)!;
    assert.ok((await layouts(page)).length > countBeforeResize, 'the resize was persisted');
    const modelsAfter = panelOf(resized, 'models');
    assert.ok(modelsAfter.w > modelsBefore.w || modelsAfter.h > modelsBefore.h, `models grew: ${JSON.stringify(modelsBefore)} -> ${JSON.stringify(modelsAfter)}`);
    ok('pointer resize from the corner handle grows a panel and persists it');

    // ── keyboard lift mode ────────────────────────────────────────────────────────────────────
    const grip = page.locator('[data-panel="weekday"] [data-act="move"]');
    await grip.focus();
    const countBeforeKeys = (await layouts(page)).length;
    await page.keyboard.press('Space');
    assert.match(await live(page), /^Usage by weekday lifted\. Column \d+, row band \d+\. Use arrow keys to move, R to resize, Space to drop, Escape to cancel\.$/);
    assert.equal(await grip.getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(100);
    assert.match(await live(page), /^Usage by weekday moved to column \d+, row band \d+\./);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Move Usage by weekday', 'focus stays on the grip through gridstack\'s re-sort');
    assert.equal((await layouts(page)).length, countBeforeKeys, 'nothing is persisted while lifted');
    await page.keyboard.press('Space');
    await page.waitForTimeout(500);
    assert.match(await live(page), /^Usage by weekday dropped at column \d+, row band \d+\.$/);
    assert.equal((await layouts(page)).length, countBeforeKeys + 1, 'the drop persists once');
    ok('keyboard: lift, move (announced, focus kept), drop persists');

    await page.keyboard.press('Space');
    await page.keyboard.press('r');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    assert.match(await live(page), /^Usage by weekday resized to (normal|tall) height\./);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    assert.match(await live(page), /^Cancelled\. Usage by weekday returned to column \d+, row band \d+\.$/);
    assert.equal((await layouts(page)).length, countBeforeKeys + 1, 'a cancel persists nothing');
    ok('keyboard: resize mode, Escape restores everything and persists nothing');

    // ── hide / show keeps the chart ───────────────────────────────────────────────────────────
    await page.evaluate(() => {
      (window as unknown as { __canvas: Element | null }).__canvas = document.querySelector('[data-panel="sankey"] canvas');
    });
    const hadCanvas = await page.evaluate(() => !!(window as unknown as { __canvas: unknown }).__canvas);
    await page.locator('[data-panel="sankey"] [data-act="hide"]').click();
    assert.equal(await page.locator('[gs-id="sankey"]').isVisible(), false);
    assert.ok(!(await boxes(page)).some((b) => b.id === 'sankey'), 'a hidden panel leaves the grid');
    await page.locator('#layout-add').click();
    await page.locator('[role="menuitem"]:has-text("Flow breakdown")').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[gs-id="sankey"]').isVisible(), true);
    if (hadCanvas) {
      assert.equal(await page.evaluate(() => (window as unknown as { __canvas: Element }).__canvas === document.querySelector('[data-panel="sankey"] canvas')), true, 'the same canvas node (and chart instance) came back');
    }
    ok('hide removes the panel from the grid; Add chart brings it back with its chart node intact');

    // ── the 700 px breakpoint ─────────────────────────────────────────────────────────────────
    const wideBoxes = await boxes(page);
    const persistedBeforeNarrow = (await layouts(page)).length;
    await page.setViewportSize({ width: 650, height: WIDE.height });
    await page.waitForTimeout(600);
    const narrow = await boxes(page);
    assert.equal(new Set(narrow.map((b) => b.x)).size, 1, 'one column: every panel has the same left edge');
    assert.equal(await page.locator('#layout-edit').isDisabled(), true);
    assert.equal(await page.locator('#layout-edit').getAttribute('aria-pressed'), 'false', 'editing is forced off');
    assert.equal((await layouts(page)).length, persistedBeforeNarrow, 'switching to one column persists nothing');
    await page.screenshot({ path: path.join(OUT, '3-narrow.png') });
    await page.setViewportSize(WIDE);
    await page.waitForTimeout(600);
    const back = await boxes(page);
    for (const w of wideBoxes) {
      const b = back.find((x) => x.id === w.id)!;
      assert.ok(Math.abs(b.x - w.x) <= 2 && Math.abs(b.y - w.y) <= 2 && Math.abs(b.w - w.w) <= 2, `${w.id} returns to its wide rectangle: ${JSON.stringify(w)} -> ${JSON.stringify(b)}`);
    }
    assert.equal(await page.locator('#layout-edit').isDisabled(), false);
    ok('below 700 px: one column, editing off, nothing persisted; back above it every panel returns exactly');

    // ── CSP + errors ──────────────────────────────────────────────────────────────────────────
    const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    assert.deepEqual(csp, [], 'no CSP violation anywhere in the run');
    assert.deepEqual(problems, [], 'no console error or page error');
    ok(`no CSP violations, no console errors (screenshots in ${OUT})`);
  } finally {
    await browser.close();
    server.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);

// S3 spike runner. Usage:  node build.mjs && node run-spike.mjs [--only=1,2,...]
// Drives the built demo in Chromium via Playwright and prints PASS / FAIL / INFO per check, then writes
// results.json. Sections: 1 keyboard, 2 CSP, 3 charts, 4 layout semantics, 5 size, 7 motion+contrast, 8 misc.
// (Section 6, jsdom, is `node jsdom-probe.mjs`.)
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { startServer } from './serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean);
const want = (n) => only.length === 0 || only.includes(String(n));

const results = [];
function rec(section, name, pass, evidence) {
  results.push({ section, name, pass, evidence });
  const tag = pass === null ? 'INFO' : pass ? 'PASS' : 'FAIL';
  const ev = evidence === undefined ? '' : ' :: ' + (typeof evidence === 'string' ? evidence : JSON.stringify(evidence));
  console.log(`${tag} [${section}] ${name}${ev.length > 700 ? ev.slice(0, 700) + '...' : ev}`);
}
const PASS = (s, n, e) => rec(s, n, true, e);
const CHECK = (s, n, ok, e) => rec(s, n, !!ok, e);
const INFO = (s, n, e) => rec(s, n, null, e);

const { server, port } = await startServer();
const base = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
mkdirSync('evidence', { recursive: true });

// ── helpers ───────────────────────────────────────────────────────────────────
async function open(query = '', { width = 1100, height = 900, ctx = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...ctx });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: (e.sample || '').slice(0, 90) });
    }, true);
  });
  const page = await context.newPage();
  const consoleMsgs = [];
  page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => consoleMsgs.push({ type: 'pageerror', text: e.message }));
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await page.waitForTimeout(350);
  return { context, page, consoleMsgs };
}
const settle = (page, ms = 450) => page.waitForTimeout(ms);
const rects = (page) => page.evaluate(() => Object.fromEntries(window.__s3.engine.save().map((r) => [r.id, r])));
const fmt = (r) => `${r.x},${r.y},${r.w}x${r.h}`;
const center = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
async function mouseDrag(page, from, to, steps = 14) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
  await page.mouse.up();
}
const titlePoint = async (page, id) => center(await page.locator(`[data-panel="${id}"] .wv-chart-title`).boundingBox());
const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
function layoutProblems(list) {
  const probs = [];
  for (const r of list) {
    const above = list.filter((o) => o !== r && o.x < r.x + r.w && r.x < o.x + o.w && o.y < r.y).map((o) => o.y + o.h);
    const want = above.length ? Math.max(...above) : 0;
    if (r.y !== want) probs.push(`gap:${r.id}@y${r.y}(want ${want})`);
    for (const o of list) if (o.id < r.id && overlaps(r, o)) probs.push(`overlap:${r.id}/${o.id}`);
  }
  return probs;
}

// ═════════════════════════ 1. Keyboard ═══════════════════════════════════════
if (want(1)) {
  const S = '1 keyboard';
  // 1a. stock gridstack, nothing of ours
  {
    const { page } = await open('?stock=1');
    const info = await page.evaluate(() => {
      const item = document.querySelector('.grid-stack-item');
      const handles = [...item.querySelectorAll('.ui-resizable-handle')];
      return {
        itemHtml: item.outerHTML.replace(/\s+/g, ' ').slice(0, 420),
        itemAttrs: [...item.attributes].map((a) => a.name),
        handleCount: handles.length,
        handleHasTabindexOrRole: handles.some((h) => h.hasAttribute('tabindex') || h.hasAttribute('role')),
        tabbable: [...document.querySelectorAll('*')].filter((e) => e.tabIndex >= 0 && e !== document.body).length,
      };
    });
    INFO(S, 'stock DOM (item attrs / handles)', info);
    CHECK(S, 'stock: no element is tabbable, handles have no tabindex/role', info.tabbable === 0 && !info.handleHasTabindexOrRole, { tabbable: info.tabbable });
    const active = [];
    for (let i = 0; i < 5; i++) { await page.keyboard.press('Tab'); active.push(await page.evaluate(() => document.activeElement?.tagName)); }
    // Best case: make the item focusable ourselves and send every plausible key.
    const before = JSON.stringify(await page.evaluate(() => window.__s3.grid.save(false)));
    await page.evaluate(() => { const i = document.querySelector('.grid-stack-item'); i.tabIndex = 0; i.focus(); });
    for (const k of ['ArrowRight', 'Alt+ArrowRight', 'Shift+ArrowRight', 'Control+ArrowRight', 'ArrowDown', 'Alt+ArrowDown', 'Enter', 'Space', 'm', 'r']) await page.keyboard.press(k);
    await settle(page);
    const after = JSON.stringify(await page.evaluate(() => window.__s3.grid.save(false)));
    CHECK(S, 'stock: Tab reaches nothing; no key moves/resizes a widget (positions unchanged)', active.every((t) => t === 'BODY') && before === after, { tabSequence: active, unchanged: before === after });
    const dist = 'node_modules/gridstack/dist';
    const hits = {};
    for (const f of readdirSync(dist).filter((f) => f.endsWith('.js') && !f.endsWith('-all.js'))) {
      const t = readFileSync(`${dist}/${f}`, 'utf8');
      const m = t.match(/aria-|role=|tabindex|tabIndex|\.focus\(|keyboard/g);
      if (m) hits[f] = m.length;
    }
    INFO(S, 'source scan of gridstack dist/*.js for aria-/role=/tabindex/.focus(/keyboard', Object.keys(hits).length ? hits : 'no hits (zero a11y code)');
    const docs = readFileSync('node_modules/gridstack/README.md', 'utf8') + readFileSync('node_modules/gridstack/doc/API.md', 'utf8');
    INFO(S, 'README + API.md mentions of accessibility/aria/screen reader/keyboard', (docs.match(/accessib|aria|screen.?reader|keyboard/gi) ?? []).length);
    await page.context().close();
  }

  // 1b. our keyboard layer on top of grid.update
  for (const nomove of [0, 1]) {
    const tag = nomove ? 'no moveBefore' : 'native moveBefore';
    const { page } = await open(`?nomove=${nomove}`);
    const s = (n) => `[${tag}] ${n}`;
    // view mode: tools hidden and out of the tab order; keys inert
    const tabbableView = await page.evaluate(() => [...document.querySelectorAll('button,[tabindex]')].filter((e) => e.offsetParent !== null && e.tabIndex >= 0).length);
    CHECK(S, s('view mode: only the Edit button is tabbable (no tab-order pollution)'), tabbableView === 1, { tabbableView });
    await page.locator('#edit-toggle').focus();
    await page.keyboard.press('Enter');
    await settle(page, 200);
    CHECK(S, s('Enter on Edit button -> grid non-static, aria-pressed=true'), await page.evaluate(() => !window.__s3.engine.isStatic() && document.getElementById('edit-toggle').getAttribute('aria-pressed') === 'true'));
    const live = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(document.getElementById('live').textContent)))));
    const lastAnn = () => page.evaluate(() => window.__s3.announcements.at(-1));
    const activeIs = (sel) => page.evaluate((sel) => document.activeElement === document.querySelector(sel), sel);
    const mark = (sel) => page.evaluate((sel) => { document.querySelector(sel).__mark = 'M'; }, sel);
    const marked = (sel) => page.evaluate((sel) => document.activeElement === document.querySelector(sel) && document.activeElement.__mark === 'M', sel);

    // move horizontally
    const GRIP = (id) => `[data-panel="${id}"] [data-act="move"]`;
    await page.locator(GRIP('models')).focus();
    await mark(GRIP('models'));
    const r0 = await rects(page);
    await page.keyboard.press('Alt+ArrowLeft');
    await settle(page);
    const r1 = await rects(page);
    let ann = await lastAnn();
    CHECK(S, s('Alt+ArrowLeft moves models x-1'), r1.models.x === r0.models.x - 1, { before: fmt(r0.models), after: fmt(r1.models) });
    CHECK(S, s('announcement states the RESULTING column'), new RegExp(`moved to column ${r1.models.x + 1}, row \\d+\\.$`).test(ann), ann);
    CHECK(S, s('aria-live region content equals the announcement'), (await live()) === ann, await live());
    CHECK(S, s('focus retained on the SAME grip element after re-render'), await marked(GRIP('models')));
    INFO(S, s('layout after move (gravity pushes the overlapped panel down, no swap)'), Object.values(r1).map((r) => `${r.id}:${fmt(r)}`).join(' | '));

    // move vertically (jump over neighbour)
    await page.locator(GRIP('timeline')).focus();
    await mark(GRIP('timeline'));
    const v0 = await rects(page);
    await page.keyboard.press('Alt+ArrowDown');
    await settle(page);
    const v1 = await rects(page);
    ann = await lastAnn();
    CHECK(S, s('Alt+ArrowDown moves timeline below its lower neighbour'), v1.timeline.y > v0.timeline.y, { before: fmt(v0.timeline), after: fmt(v1.timeline) });
    CHECK(S, s('focus retained after vertical move'), await marked(GRIP('timeline')), ann);
    await page.keyboard.press('Alt+ArrowUp');
    await settle(page);
    const v2 = await rects(page);
    CHECK(S, s('Alt+ArrowUp moves it back up (reversible)'), v2.timeline.y === v0.timeline.y, { restoredTo: fmt(v2.timeline) });

    // DOM order follows visual order after moves (gridstack _sortDom) => Tab order stays logical
    const order = await page.evaluate(() => { const g = document.getElementById('grid'); const dom = [...g.children].filter((e) => e.gridstackNode).map((e) => e.getAttribute('gs-id')); const vis = window.__s3.engine.save().sort((a, b) => a.y - b.y || a.x - b.x).map((r) => r.id); return { dom, vis }; });
    CHECK(S, s('after moves, DOM (= Tab) order equals visual row-major order'), JSON.stringify(order.dom) === JSON.stringify(order.vis), order);
    const tabSeq = [];
    await page.locator('#edit-toggle').focus();
    for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); tabSeq.push(await page.evaluate(() => { const a = document.activeElement; return (a.closest('[data-panel]')?.dataset.panel ?? a.id) + ':' + (a.dataset.act ?? a.dataset.axis ?? ''); })); }
    INFO(S, s('Tab sequence from the Edit button: grip, width, height, hide per panel in visual order'), tabSeq);

    // boundary: nothing above / left of models at x=2,y=0 in the row-1 band
    await page.locator(GRIP('models')).focus();
    const b0 = (await rects(page)).models;
    await page.keyboard.press('Alt+ArrowUp');
    await settle(page, 200);
    const b1 = (await rects(page)).models;
    CHECK(S, s('Alt+Arrow at a boundary is a no-op and says so'), fmt(b0) === fmt(b1) && /cannot move further up/.test(await lastAnn()), await lastAnn());

    // resize via sliders
    const SL = (id, axis) => `[data-panel="${id}"] [data-axis="${axis}"]`;
    await page.locator(SL('weekday', 'w')).focus();
    await mark(SL('weekday', 'w'));
    const w0 = (await rects(page)).weekday;
    await page.keyboard.press('ArrowRight');
    await settle(page);
    const w1 = (await rects(page)).weekday;
    CHECK(S, s('ArrowRight on width slider: w+1'), w1.w === w0.w + 1, { before: fmt(w0), after: fmt(w1) });
    CHECK(S, s('slider aria-valuenow/valuetext follow, focus retained'), await page.evaluate((sel) => { const e = document.querySelector(sel); return e.getAttribute('aria-valuenow') === String(window.__s3.engine.rect('weekday').w) && /columns$/.test(e.getAttribute('aria-valuetext')); }, SL('weekday', 'w')) && (await marked(SL('weekday', 'w'))), await lastAnn());
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await settle(page);
    CHECK(S, s('ArrowLeft x2 clamps at 1 column; second press announces minimum'), (await rects(page)).weekday.w === 1, await lastAnn());
    await page.locator(SL('weekday', 'h')).focus();
    await mark(SL('weekday', 'h'));
    await page.keyboard.press('ArrowUp');
    await settle(page);
    const h1 = (await rects(page)).weekday;
    CHECK(S, s('ArrowUp on height slider steps compact -> normal tier (7 -> 13 rows)'), h1.h === 13 && (await marked(SL('weekday', 'h'))), { rect: fmt(h1), ann: await lastAnn() });
    await page.keyboard.press('ArrowDown');
    await settle(page);
    CHECK(S, s('ArrowDown steps back to compact'), (await rects(page)).weekday.h === 7);
    // arrows on slider must not also move
    CHECK(S, s('plain Arrow on a slider never changes x (only w/h)'), (await rects(page)).weekday.x === w0.x, { x: (await rects(page)).weekday.x });

    // hide / show with the keyboard
    await page.locator('[data-panel="heatmap"] [data-act="hide"]').focus();
    await page.keyboard.press('Enter');
    await settle(page, 250);
    const hidden = await page.evaluate(() => ({ nodes: window.__s3.raw.engine.nodes.length, items: window.__s3.raw.getGridItems().length, announce: window.__s3.announcements.at(-1) }));
    CHECK(S, s('Enter on Hide removes the panel from the grid (nodes 6->5) and announces'), hidden.nodes === 5, hidden);
    await page.locator('[data-show="heatmap"]').focus();
    await page.keyboard.press('Enter');
    await settle(page, 300);
    CHECK(S, s('Enter on "Show Heatmap" restores it'), (await page.evaluate(() => window.__s3.raw.engine.nodes.length)) === 6);
    if (!nomove) {
      await page.screenshot({ path: 'evidence/edit-mode.png' });
    } else {
      // The reason restoreFocus exists: a BARE grid.update loses focus without moveBefore.
      const bare = await page.evaluate(() => {
        const g = document.querySelector('[data-panel="timeline"] [data-act="move"]'); g.focus();
        window.__s3.engine.update('timeline', { y: 40 });
        const lost = document.activeElement !== g;
        return { lostFocusAfterBareUpdate: lost, activeTag: document.activeElement?.tagName };
      });
      INFO(S, 'WITHOUT moveBefore a bare grid.update() blurs the focused handle (our restoreFocus() repairs it, checks above)', bare);
    }
    await page.context().close();
  }
}

// ═════════════════════════ 2. CSP ═════════════════════════════════════════════
async function exercise(page) {
  let moved = null;
  await page.waitForTimeout(300);
  const hasCharts = await page.evaluate(() => !!window.__s3 && !!window.__s3.charts && window.__s3.charts.size > 0);
  const stock = await page.evaluate(() => !!document.getElementById('stock'));
  if (!stock) {
    await page.locator('#edit-toggle').click();
    await page.waitForTimeout(200);
  }
  // drag by header
  const pid = stock ? null : 'weekday';
  if (stock) {
    const item = await page.locator('.grid-stack-item').first().boundingBox();
    await mouseDrag(page, { x: item.x + 30, y: item.y + 20 }, { x: item.x + 330, y: item.y + 120 });
  } else {
    const a = await titlePoint(page, pid);
    const r0 = fmt((await rects(page)).weekday);
    await mouseDrag(page, a, { x: a.x + 340, y: a.y + 170 }, 20);
    await page.waitForTimeout(500);
    moved = r0 !== fmt((await rects(page)).weekday);
    // resize by SE handle
    const se = await page.locator('[data-panel="hourly"]').locator('xpath=..').locator('.ui-resizable-se').boundingBox();
    if (se) await mouseDrag(page, center(se), { x: center(se).x - 60, y: center(se).y + 80 });
    await page.waitForTimeout(500);
    // keyboard move + hide/show
    await page.locator('[data-panel="models"] [data-act="move"]').focus();
    await page.keyboard.press('Alt+ArrowLeft');
    await page.locator('[data-panel="heatmap"] [data-act="hide"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-show="heatmap"]').click();
    await page.waitForTimeout(300);
    // chart tooltip hover (ECharts DOM tooltip carries style="" attributes)
    if (hasCharts) {
      const box = await page.locator('#body-timeline canvas').boundingBox();
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
      await page.waitForTimeout(300);
    }
  }
  // breakpoint switch there and back
  await page.setViewportSize({ width: 600, height: 900 });
  await page.waitForTimeout(500);
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.waitForTimeout(500);
  return { dragMovedPanel: moved };
}
if (want(2)) {
  const S = '2 CSP';
  const matrix = [
    ['exact repo CSP (style-src \'unsafe-inline\'), gridstack + ECharts', '?edit=0', true],
    ['STRICT (style-src \'self\' only), gridstack only (charts=0)', '?charts=0&csp=strict', false],
    ['STRICT, stock gridstack markup', '?stock=1&csp=strict', false],
    ['STRICT, gridstack + ECharts', '?csp=strict', false],
  ];
  const out = [];
  for (const [label, q, _isRepo] of matrix) {
    const { page, consoleMsgs } = await open(q);
    const ex = await exercise(page);
    const v = await page.evaluate(() => window.__csp);
    const consoleCsp = consoleMsgs.filter((m) => /content security policy|refused to/i.test(m.text));
    const errors = consoleMsgs.filter((m) => m.type === 'error' || m.type === 'pageerror').filter((m) => !/content security policy|refused to/i.test(m.text));
    const uniq = [...new Set(v.map((x) => `${x.directive} | ${x.sample || x.blocked}`))];
    out.push({ label, ...ex, violations: v.length, consoleCspMessages: consoleCsp.length, otherConsoleErrors: errors.map((e) => e.text).slice(0, 3), unique: uniq.slice(0, 6) });
    await page.context().close();
  }
  for (const o of out) INFO(S, o.label, o);
  CHECK(S, 'exact repo CSP: zero violations during init, drag, resize, keyboard, hide/show, tooltip, breakpoint switch', out[0].violations === 0 && out[0].consoleCspMessages === 0, { violations: out[0].violations });
  CHECK(S, 'gridstack alone needs NO \'unsafe-inline\' (strict CSP, zero violations, and drag/resize still function)', out[1].violations === 0 && out[2].violations === 0 && out[1].dragMovedPanel === true && out[0].dragMovedPanel === true, { demoNoCharts: out[1].violations, stock: out[2].violations });
  INFO(S, 'with ECharts under strict CSP (what \'unsafe-inline\' is really for)', { violations: out[3].violations, unique: out[3].unique });
  {
    // attribute the ECharts violations: init vs tooltip hover
    const { page } = await open('?csp=strict');
    const afterInit = await page.evaluate(() => window.__csp.length);
    const box = await page.locator('#body-timeline canvas').boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
    await page.waitForTimeout(300);
    const afterHover = await page.evaluate(() => window.__csp.length);
    CHECK(S, 'under strict CSP the ONLY violations come from the ECharts DOM tooltip on hover (style="" attributes), none at chart init', afterInit === 0 && afterHover > 0, { afterInit, afterHover });
    await page.context().close();
  }
  const src = readFileSync('node_modules/gridstack/dist/gridstack.js', 'utf8') + readFileSync('node_modules/gridstack/dist/utils.js', 'utf8') + readFileSync('node_modules/gridstack/dist/dd-draggable.js', 'utf8');
  INFO(S, 'source scan: eval / new Function / createElement(\'style\') / insertRule / setAttribute(\'style\')', {
    eval: /\beval\(/.test(src), newFunction: /new Function\(/.test(src), styleElement: /createElement\(['"]style/.test(src), insertRule: /insertRule/.test(src), setAttributeStyle: /setAttribute\(['"]style/.test(src),
    note: 'v14 sizes via CSS custom properties set through the CSSOM (el.style.setProperty); the old injected <style> sheet and its `nonce` option are gone/unused',
  });
}

// ═════════════════════════ 3. Charts ═════════════════════════════════════════
if (want(3)) {
  const S = '3 charts';
  const { page } = await open('?edit=1');
  await page.evaluate(() => { document.querySelectorAll('canvas').forEach((c) => { c.__mark = c.closest('[data-panel]').dataset.panel; }); });
  const sizeOf = (id) => page.evaluate((id) => {
    const body = document.getElementById('body-' + id);
    const canvas = body.querySelector('canvas');
    const cs = getComputedStyle(body);
    const innerW = body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const innerH = body.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const r = canvas.getBoundingClientRect();
    const chart = window.__s3.charts.get(id);
    return { innerW: Math.round(innerW), innerH: Math.round(innerH), canvasW: Math.round(r.width), canvasH: Math.round(r.height), chartW: chart.getWidth(), chartH: chart.getHeight(), sameCanvas: canvas.__mark === id, disposed: chart.isDisposed(), bodyH: body.getBoundingClientRect().height };
  }, id);
  const ok = (z) => Math.abs(z.innerW - z.canvasW) <= 1 && Math.abs(z.innerH - z.canvasH) <= 1 && Math.abs(z.chartW - z.canvasW) <= 1 && Math.abs(z.chartH - z.canvasH) <= 1 && z.sameCanvas && !z.disposed;

  CHECK(S, 'initial: every chart canvas fills its widget body', await (async () => { const all = []; for (const id of ['timeline', 'models', 'weekday', 'hourly', 'categories', 'heatmap']) all.push(ok(await sizeOf(id))); return all.every(Boolean); })());
  // API resize
  const resizesBefore = await page.evaluate(() => window.__s3.chartResizes.weekday);
  await page.evaluate(() => window.__s3.engine.update('weekday', { w: 3, h: 21 }));
  await settle(page, 700);
  let z = await sizeOf('weekday');
  CHECK(S, 'grid.update(w:3,h:21) -> RO-driven chart.resize() matches new body box', ok(z), z);
  const resizesAfter = await page.evaluate(() => window.__s3.chartResizes.weekday);
  INFO(S, 'chart.resize() calls for that one update (rAF-coalesced; animation ticks add a few)', resizesAfter - resizesBefore);
  await page.evaluate(() => window.__s3.engine.update('weekday', { w: 2, h: 7 }));
  await settle(page, 700);
  z = await sizeOf('weekday');
  CHECK(S, 'shrink back: canvas shrinks (no stale larger canvas / no overflow)', ok(z), z);
  // mouse resize with SE handle
  const before = await page.evaluate(() => window.__s3.chartResizes.hourly);
  const se = center(await page.locator('[data-panel="hourly"]').locator('xpath=..').locator('.ui-resizable-se').boundingBox());
  await mouseDrag(page, se, { x: se.x - 150, y: se.y + 120 }, 20);
  await settle(page, 700);
  z = await sizeOf('hourly');
  const rr = await rects(page);
  CHECK(S, 'MOUSE resize via SE handle: chart follows to correct size, same canvas, not disposed', ok(z), { rect: fmt(rr.hourly), ...z, resizeCalls: (await page.evaluate(() => window.__s3.chartResizes.hourly)) - before });
  // drag by header then chart pointer events
  const a = await titlePoint(page, 'weekday');
  const wBefore = await sizeOf('weekday');
  await mouseDrag(page, a, { x: a.x + 260, y: a.y + 90 }, 20);
  await settle(page, 600);
  z = await sizeOf('weekday');
  CHECK(S, 'after header-drag: same canvas node, not disposed, size matches body', ok(z), { before: `${wBefore.canvasW}x${wBefore.canvasH}`, after: `${z.canvasW}x${z.canvasH}`, newRect: fmt((await rects(page)).weekday) });
  const ev0 = await page.evaluate(() => ({ ...window.__s3.chartEvents.weekday }));
  const px = await page.evaluate(() => { const c = window.__s3.charts.get('weekday'); const [x, y] = c.convertToPixel({ seriesIndex: 0 }, [3, 40]); const r = c.getDom().querySelector('canvas').getBoundingClientRect(); return { x: r.left + x, y: r.top + y }; });
  await page.mouse.move(px.x - 40, px.y - 20);
  await page.mouse.move(px.x, px.y, { steps: 6 });
  await settle(page, 250);
  const tipVisible = await page.evaluate(() => { const dom = document.getElementById('body-weekday'); return [...dom.querySelectorAll('div')].some((d) => d.style.display !== 'none' && /D\d+/.test(d.textContent || '') && d.style.position === 'absolute'); });
  await page.mouse.down(); await page.mouse.up();
  await settle(page, 150);
  const ev1 = await page.evaluate(() => ({ ...window.__s3.chartEvents.weekday }));
  CHECK(S, 'after dragging: chart hover (mouseover/showTip/tooltip DOM) and click still work', ev1.mouseover > ev0.mouseover && ev1.click > ev0.click && ev1.showTip > ev0.showTip, { before: ev0, after: ev1, tooltipDomVisible: tipVisible });
  // pointer events on chart in edit mode must not start a drag
  const rBefore = fmt((await rects(page)).models);
  const mb = await page.locator('#body-models canvas').boundingBox();
  await mouseDrag(page, { x: mb.x + 40, y: mb.y + 60 }, { x: mb.x + 40, y: mb.y + 220 }, 10);
  await settle(page, 300);
  CHECK(S, 'edit mode: dragging INSIDE a chart body does not move the panel (handle is the header only)', fmt((await rects(page)).models) === rBefore, rBefore);
  // mid-drag sampling
  const t = await titlePoint(page, 'categories');
  await page.mouse.move(t.x, t.y); await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(t.x + i * 15, t.y + i * 10);
  const mid = await page.evaluate(() => { const el = document.querySelector('.ui-draggable-dragging'); const c = window.__s3.charts.get('categories'); return { helperIsItem: !!el && el.getAttribute('gs-id') === 'categories', position: el && getComputedStyle(el).position, pointerEvents: el && getComputedStyle(el).pointerEvents, chartAlive: !c.isDisposed(), canvasW: Math.round(c.getDom().querySelector('canvas').getBoundingClientRect().width) }; });
  await page.screenshot({ path: 'evidence/mid-drag.png' });
  await page.mouse.up();
  INFO(S, 'mid-drag state (the dragged item itself becomes position:fixed, pointer-events:none; chart keeps its canvas)', mid);
  await page.context().close();
  {
    const { page: p2 } = await open('?edit=1&animate=0');
    const b0 = await p2.evaluate(() => window.__s3.chartResizes.weekday);
    await p2.evaluate(() => window.__s3.engine.update('weekday', { w: 3, h: 21 }));
    await settle(p2, 600);
    const calls = (await p2.evaluate(() => window.__s3.chartResizes.weekday)) - b0;
    INFO(S, 'same update with animate:false -> chart.resize() calls (animate:true costs ~19: one per frame of the 0.3s width/height transition)', calls);
    await p2.context().close();
  }
}

// ═════════════════════════ 4. Layout semantics ═══════════════════════════════
if (want(4)) {
  const S = '4 layout';
  // 4a gravity
  {
    const { page } = await open('?edit=1');
    await page.evaluate(() => window.__s3.engine.update('models', { y: 40 }));
    await settle(page, 300);
    const r = await rects(page);
    CHECK(S, "mode:'top' (v14's replacement for float:false): update(y:40) is pulled back up (gravity) - no gaps, no overlaps", r.models.y < 40 && layoutProblems(Object.values(r)).length === 0, { models: fmt(r.models), problems: layoutProblems(Object.values(r)) });
    const opts = await page.evaluate(() => ({ mode: window.__s3.raw.getMode(), column: window.__s3.raw.getColumn(), cssCols: getComputedStyle(document.getElementById('grid')).getPropertyValue('--gs-columns'), gridMoveFn: typeof window.__s3.raw.move, gridResizeFn: typeof window.__s3.raw.resize, updateFn: typeof window.__s3.raw.update }));
    INFO(S, 'grid.getMode()/getColumn(); grid.move / grid.resize exist in 14.1.1?', opts);
    CHECK(S, 'grid.move and grid.resize are NOT in the 14.1.1 public API (update() is the only mover)', opts.gridMoveFn === 'undefined' && opts.gridResizeFn === 'undefined' && opts.updateFn === 'function', opts);
    await page.context().close();
  }
  // 4a' 12 columns
  {
    const { page } = await open('?cols=12&edit=1');
    await page.evaluate(() => { const e = window.__s3.engine; e.update('timeline', { x: 0, w: 12 }); e.update('models', { x: 11, w: 1 }); });
    await settle(page, 500);
    const m = await page.evaluate(() => { const g = document.getElementById('grid').getBoundingClientRect(); const rr = (id) => document.querySelector(`[gs-id="${id}"]`).getBoundingClientRect(); return { gridW: Math.round(g.width), timelineW: Math.round(rr('timeline').width), modelsLeft: Math.round(rr('models').left - g.left), cols: getComputedStyle(document.getElementById('grid')).getPropertyValue('--gs-columns') }; });
    CHECK(S, '12-column grid works with the stock CSS (CSS custom properties; no gridstack-extra.css)', m.cols.trim() === '12' && Math.abs(m.timelineW - m.gridW) <= 1 && Math.abs(m.modelsLeft - (m.gridW * 11) / 12) <= 1, m);
    await page.context().close();
  }
  // 4b breakpoints / persistence gating
  {
    const { page } = await open('?edit=1');
    await page.evaluate(() => { window.__s3.engine.update('models', { x: 3, y: 0 }); window.__s3.engine.update('weekday', { w: 1 }); });
    await settle(page, 600);
    const persistedBefore = await page.evaluate(() => window.__s3.persisted.length);
    const wide = JSON.stringify(await page.evaluate(() => window.__s3.engine.save()));
    const seq = [];
    for (const w of [701, 700, 400, 701]) {
      await page.setViewportSize({ width: w, height: 900 });
      await settle(page, 450);
      seq.push({ width: w, columns: await page.evaluate(() => window.__s3.engine.columns()), saveEqualsWide: JSON.stringify(await page.evaluate(() => window.__s3.engine.save())) === wide });
    }
    INFO(S, 'breakpoint {w:700,c:1,breakpointForWindow:true}: columns + grid.save() while resizing 701 -> 700 -> 400 -> 701', seq);
    CHECK(S, 'switches to 1 column at <=700px and back to 4 at 701px (same boundary as @media (max-width:700px))', seq[0].columns === 4 && seq[1].columns === 1 && seq[2].columns === 1 && seq[3].columns === 4, seq.map((s) => s.columns));
    CHECK(S, 'grid.save() while in 1-column state returns the WIDE (cached 4-col) coordinates', seq[1].saveEqualsWide && seq[2].saveEqualsWide, 'engine.save() uses _layouts[highest]');
    CHECK(S, "4 -> 1 -> 4 round trip restores the layout EXACTLY with columnOpts.layout:'moveScale' ('list' did not)", seq[3].saveEqualsWide, seq[3]);
    CHECK(S, 'a breakpoint switch fires no persistence (no change-event-driven writes)', (await page.evaluate(() => window.__s3.persisted.length)) === persistedBefore, { persistedBefore });
    // narrow => edit mode is forced off and the button disabled (demo wiring of the recommended pattern)
    await page.setViewportSize({ width: 600, height: 900 });
    await settle(page, 450);
    CHECK(S, 'narrow view: Edit button disabled and grid forced static by the onColumnChange handler', await page.evaluate(() => document.getElementById('edit-toggle').disabled && window.__s3.engine.isStatic()), await page.evaluate(() => ({ disabled: document.getElementById('edit-toggle').disabled, static: window.__s3.engine.isStatic() })));
    await page.setViewportSize({ width: 1100, height: 900 });
    await settle(page, 450);
    CHECK(S, 'back to wide: Edit button re-enabled', await page.evaluate(() => !document.getElementById('edit-toggle').disabled));
    // hazard: editing while narrow
    await page.setViewportSize({ width: 600, height: 900 });
    await settle(page, 450);
    const evBefore = await page.evaluate(() => window.__s3.persisted.length);
    const suppBefore = await page.evaluate(() => window.__s3.suppressedCount());
    await page.evaluate(() => window.__s3.engine.update('models', { y: 0 }));
    await settle(page, 500);
    const afterNarrowEdit = await rects(page);
    const probs = layoutProblems(Object.values(afterNarrowEdit));
    CHECK(S, 'HAZARD: editing while 1-column corrupts the cached wide layout (overlaps/gaps) -> must set static in narrow mode', probs.length > 0, { problems: probs.slice(0, 4), wideSaveNow: Object.values(afterNarrowEdit).map((r) => `${r.id}:${fmt(r)}`).join(' | ') });
    CHECK(S, 'our gate (engine.columns() !== wide) suppressed the persist for that narrow edit', (await page.evaluate(() => window.__s3.persisted.length)) === evBefore && (await page.evaluate(() => window.__s3.suppressedCount())) > suppBefore);
    // onColumnChange event availability
    const cc = await page.evaluate(async () => {
      const calls = []; const off = window.__s3.engine.onColumnChange((c) => calls.push(c));
      return { arm: () => off, calls };
    }).catch(() => null);
    await page.evaluate(() => { window.__cc = []; window.__s3.engine.onColumnChange((c) => window.__cc.push(c)); });
    await page.setViewportSize({ width: 1100, height: 900 }); await settle(page, 450);
    await page.setViewportSize({ width: 500, height: 900 }); await settle(page, 450);
    INFO(S, 'engine.onColumnChange (built on the `resizecontent` event) observed', await page.evaluate(() => window.__cc));
    void cc;
    await page.context().close();
  }
  // 4b' start NARROW (webview opens in a narrow editor group): restore + reading order
  {
    const out = {};
    for (const initial of ['each', 'all']) {
      const { page } = await open(`?edit=0&initial=${initial}`, { width: 600 });
      const narrow = await page.evaluate(() => ({ col: window.__s3.engine.columns(), order: [...document.getElementById('grid').children].filter((e) => e.gridstackNode).sort((a, b) => a.gridstackNode.y - b.gridstackNode.y).map((e) => e.getAttribute('gs-id')) }));
      await page.setViewportSize({ width: 1100, height: 900 });
      await settle(page, 500);
      const wide = await page.evaluate(() => ({ save: JSON.stringify(window.__s3.engine.save().sort((a, b) => a.id.localeCompare(b.id))), want: JSON.stringify(window.__s3.PANELS.map((p) => p.rect).sort((a, b) => a.id.localeCompare(b.id))) }));
      out[initial] = { narrowColumns: narrow.col, narrowStackOrder: narrow.order.join('>'), wideRestoredExactly: wide.save === wide.want };
      await page.context().close();
    }
    const reading = 'timeline>models>weekday>hourly>categories>heatmap';
    INFO(S, 'startup while ALREADY 1-column: per-item register() vs registerAll() (via load())', out);
    CHECK(S, 'registerAll(): restoring wide rects into an already-narrow grid keeps reading order (row-major) AND restores the wide layout exactly when widened', out.all.narrowColumns === 1 && out.all.narrowStackOrder === reading && out.all.wideRestoredExactly, out.all);
    CHECK(S, 'PITFALL: per-item register() in a narrow grid scrambles the 1-column order (wide layout is still restored)', out.each.narrowStackOrder !== reading && out.each.wideRestoredExactly, out.each);
  }
  // 4c tiers -> rows (measure)
  {
    const { page } = await open('?edit=1');
    const rows = [];
    for (const [tier, h, targetBody] of [['compact', 7, 120], ['normal', 13, 260], ['tall', 21, 455], ['compact-8', 8, 120], ['tall-22', 22, 455]]) {
      await page.evaluate((h) => window.__s3.engine.update('weekday', { h }), h);
      await settle(page, 500);
      const m = await page.evaluate(() => { const b = document.getElementById('body-weekday'); const hd = document.querySelector('[data-panel="weekday"] .wv-panel-header'); const sec = document.querySelector('[data-panel="weekday"]'); return { body: Math.round(b.getBoundingClientRect().height), header: Math.round(hd.getBoundingClientRect().height), section: Math.round(sec.getBoundingClientRect().height), canvas: Math.round(b.querySelector('canvas').getBoundingClientRect().height) }; });
      rows.push({ tier, rows: h, targetBody, measuredBody: m.body, delta: m.body - targetBody, header: m.header, section: m.section, canvas: m.canvas });
    }
    INFO(S, `tier -> rows (cellHeight 24, margin 6 => panel box = h*24-12 px; body = box - ${rows[0].header}px header incl. border; today's bodies are 120/260/455)`, rows);
    CHECK(S, 'proposed {compact:7, normal:13, tall:21} land within 6 px (<=4.5%) of today\'s body heights (120/260/455)', [rows[0], rows[1], rows[2]].every((r) => Math.abs(r.delta) <= 6), rows.slice(0, 3).map((r) => `${r.tier}:${r.delta}`));
    await page.context().close();
  }
  // 4d setStatic toggling + handles
  {
    const { page } = await open('');
    const handles = () => page.evaluate(() => ({ static: window.__s3.engine.isStatic(), cls: document.getElementById('grid').classList.contains('grid-stack-static'), handleNodes: document.querySelectorAll('.ui-resizable-handle').length, seHandle: document.querySelector('.ui-resizable-se') ? 'present' : 'absent' }));
    const v = await handles();
    CHECK(S, 'staticGrid:true -> no drag/resize handles in the DOM, .grid-stack-static set', v.static && v.cls && v.handleNodes === 0, v);
    const a0 = await titlePoint(page, 'weekday');
    const r0 = fmt((await rects(page)).weekday);
    await mouseDrag(page, a0, { x: a0.x + 340, y: a0.y + 170 }, 20);
    await settle(page, 300);
    CHECK(S, 'static: header mouse-drag does nothing', fmt((await rects(page)).weekday) === r0);
    await page.evaluate(() => window.__s3.engine.update('weekday', { w: 3 }));
    await settle(page, 300);
    CHECK(S, 'static: programmatic grid.update() still works (so load()/restore work in view mode)', (await rects(page)).weekday.w === 3);
    await page.evaluate(() => window.__s3.engine.update('weekday', { w: 2 }));
    await page.evaluate(() => window.__s3.setEditing(true));
    await settle(page, 300);
    const e1 = await handles();
    // keep a handle node to see whether it is re-created on the next toggle
    await page.evaluate(() => { document.querySelector('.ui-resizable-se').__id = 'first'; });
    await page.evaluate(() => { window.__s3.setEditing(false); window.__s3.setEditing(true); });
    await settle(page, 300);
    const e2 = await page.evaluate(() => ({ recreated: document.querySelector('.ui-resizable-se').__id !== 'first', count: document.querySelectorAll('.ui-resizable-se').length }));
    CHECK(S, 'setStatic(false): 3 handles per panel (e,se,s) appear; drag works', e1.handleNodes === 18 && !e1.static, e1);
    INFO(S, 'gridstack\'s own resize handles are DESTROYED + RE-CREATED on every setStatic toggle (so ARIA/tabindex on them would not stick; we use our own sliders)', e2);
    const a1 = await titlePoint(page, 'weekday');
    const r1 = fmt((await rects(page)).weekday);
    await mouseDrag(page, a1, { x: a1.x + 340, y: a1.y + 170 }, 20);
    await settle(page, 400);
    CHECK(S, 'non-static: header drag moves the panel', fmt((await rects(page)).weekday) !== r1, { before: r1, after: fmt((await rects(page)).weekday) });
    await page.context().close();
  }
  // 4e removeWidget(el,false) / re-add
  {
    const { page } = await open('?edit=1');
    await page.evaluate(() => { const c = document.querySelector('#body-weekday canvas'); c.__mark = 'weekday-canvas'; window.__chartRef = window.__s3.charts.get('weekday'); });
    await page.evaluate(() => window.__s3.hidePanel('weekday'));
    await settle(page, 450);
    const h = await page.evaluate(() => { const el = window.__s3.els.get('weekday'); const g = window.__s3.raw; return { connected: el.isConnected, hiddenAttr: el.hidden, rectW: el.getBoundingClientRect().width, hasNode: !!el.gridstackNode, nodes: g.engine.nodes.length, getGridItems: g.getGridItems().length, chartDisposed: window.__s3.charts.get('weekday').isDisposed(), sameCanvas: document.querySelector('#body-weekday canvas').__mark === 'weekday-canvas', sameChart: window.__chartRef === window.__s3.charts.get('weekday') }; });
    CHECK(S, 'removeWidget(el,false): DOM node + chart instance + canvas survive; node is no longer tracked', h.connected && !h.hasNode && h.nodes === 5 && !h.chartDisposed && h.sameCanvas && h.sameChart, h);
    INFO(S, 'PITFALL: the node stays a child of .grid-stack with .grid-stack-item, so grid.getGridItems() still returns it (6 vs 5 nodes) and it stays absolutely positioned at its old slot until we hide it', { getGridItems: h.getGridItems, nodes: h.nodes, hiddenByUs: h.hiddenAttr, widthWhenHidden: h.rectW });
    const rr = Object.values(await rects(page));
    CHECK(S, 'remaining panels re-compact: no gaps, no overlaps after a panel is removed', layoutProblems(rr).length === 0, { layout: rr.map((r) => `${r.id}:${fmt(r)}`).join(' | '), problems: layoutProblems(rr) });
    await page.evaluate(() => window.__s3.showPanel('weekday'));
    await settle(page, 700);
    const rr2 = Object.values(await rects(page));
    const wk = rr2.find((r) => r.id === 'weekday');
    CHECK(S, 're-adding with its remembered rect restores the slot and leaves no gaps/overlaps', layoutProblems(rr2).length === 0, { weekday: fmt(wk), problems: layoutProblems(rr2) });
    const sz = await page.evaluate(() => { const b = document.getElementById('body-weekday'); const c = b.querySelector('canvas'); return { sameCanvas: c.__mark === 'weekday-canvas', bodyW: b.clientWidth - 16, canvasW: Math.round(c.getBoundingClientRect().width), disposed: window.__s3.charts.get('weekday').isDisposed() }; });
    CHECK(S, 'chart is correctly sized again after re-add (ResizeObserver fires on un-hide)', sz.sameCanvas && Math.abs(sz.bodyW - sz.canvasW) <= 1 && !sz.disposed, sz);
    // autoPosition variant
    await page.evaluate(() => { const e = window.__s3.engine; e.unregister('heatmap'); });
    await settle(page, 400);
    const ap = await page.evaluate(() => { const e = window.__s3.engine; e.reregister('heatmap', { x: 0, y: 0, w: 4, h: 7 }); return window.__s3.engine.save().map((r) => `${r.id}:${r.x},${r.y},${r.w}x${r.h}`); });
    await settle(page, 400);
    INFO(S, 're-adding into an OCCUPIED rect pushes the occupants down (no overlap, but reflows others)', { afterReadd: layoutProblems(Object.values(await rects(page))).length === 0 ? 'no gaps/overlaps' : 'problems' , ap });
    await page.context().close();
  }
  // 4f load()
  {
    const { page } = await open('?edit=1');
    const saved = [
      { id: 'models', x: 0, y: 0, w: 1, h: 13 }, { id: 'timeline', x: 1, y: 0, w: 3, h: 13 },
      { id: 'ghost-panel', x: 0, y: 40, w: 2, h: 7 }, // unknown id (panel removed from code)
      { id: 'weekday', x: 3, y: 99, w: 9, h: 7 }, // out-of-range values
    ];
    const persistedBeforeLoad = await page.evaluate(() => window.__s3.persisted.length);
    await page.evaluate((saved) => window.__s3.engine.load(saved), saved);
    await settle(page, 500);
    const r = await rects(page);
    const info = await page.evaluate(() => ({ items: window.__s3.raw.getGridItems().length, nodes: window.__s3.raw.engine.nodes.length, ghost: !!document.querySelector('[gs-id="ghost-panel"]') }));
    CHECK(S, 'load() does not echo back into persistence (change fired with ignorable=true is gated; no write loop)', (await page.evaluate(() => window.__s3.persisted.length)) === persistedBeforeLoad, { persistedBeforeLoad });
    CHECK(S, 'adapter load(): unknown ids ignored (no ghost widget), panels missing from the list are kept', !info.ghost && info.nodes === 6, { ...info, models: fmt(r.models), timeline: fmt(r.timeline), hourly: fmt(r.hourly) });
    CHECK(S, 'adapter load(): out-of-range x/w/y clamped by sanitizeRects (w:9@x:3,y:99 -> fits 4 columns, gravity applies)', r.weekday.x + r.weekday.w <= 4 && r.weekday.y < 99, fmt(r.weekday));
    CHECK(S, 'adapter load(): applied positions are the saved ones for known ids (models x0, timeline x1)', r.models.x === 0 && r.timeline.x === 1, { models: fmt(r.models), timeline: fmt(r.timeline) });
    CHECK(S, 'load result has no gaps/overlaps', layoutProblems(Object.values(r)).length === 0, layoutProblems(Object.values(r)));
    // hazard: raw grid.load(list) default addRemove=true
    const raw = await page.evaluate((saved) => { const g = window.__s3.raw; g.load(JSON.parse(JSON.stringify(saved))); return { items: g.getGridItems().length, nodes: g.engine.nodes.length, ghost: !!document.querySelector('.grid-stack-item:not([gs-id])') || [...document.querySelectorAll('.grid-stack-item')].some((e) => e.gridstackNode?.id === 'ghost-panel') }; }, saved);
    const fresh = await open('?edit=1');
    const rawClamp = await fresh.page.evaluate(() => {
      const g = window.__s3.raw; g.load([{ id: 'weekday', x: 3, y: 99, w: 9, h: 7 }], false);
      const n = g.engine.nodes.find((n) => n.id === 'weekday'); const sv = g.save(false, false).find((x) => x.id === 'weekday');
      return { liveNode: `${n.x},${n.y},${n.w}x${n.h}`, gridSave: `${sv.x},${sv.y},${sv.w ?? 'default'}x${sv.h ?? 'default'}` };
    });
    CHECK(S, 'HAZARD: raw grid.load() of an oversize rect clamps the LIVE node but grid.save() keeps returning the unclamped cached layout (it was cached as "saved for a wider grid") -> persisting would write the bad rect back; sanitize BEFORE load', rawClamp.liveNode !== rawClamp.gridSave && /^3,99,9x/.test(rawClamp.gridSave), rawClamp);
    await fresh.context.close();
    INFO(S, 'HAZARD (raw grid.load(list) with default addRemove=true): unknown ids CREATE empty widgets; panels not in the list are REMOVED. The adapter filters + passes addRemove=false', raw);
    await page.context().close();
  }
  // 4g events + debounce
  {
    const { page } = await open('?edit=1');
    await page.evaluate(() => { window.__s3.log.length = 0; });
    const a = await titlePoint(page, 'weekday');
    await mouseDrag(page, a, { x: a.x + 300, y: a.y + 150 }, 24);
    await settle(page, 700);
    const drag = await page.evaluate(() => ({ events: window.__s3.log.map((l) => l.ev).reduce((m, e) => ((m[e] = (m[e] || 0) + 1), m), {}), persisted: window.__s3.persisted.length, last: window.__s3.persisted.at(-1)?.column }));
    CHECK(S, 'one mouse drag => dragstart, dragstop, ONE `change`, ONE debounced persist', drag.events['gs:dragstart'] === 1 && drag.events['gs:dragstop'] === 1 && drag.events['gs:change'] === 1 && drag.persisted === 1, drag);
    await page.evaluate(() => { window.__s3.log.length = 0; });
    const se = center(await page.locator('[data-panel="hourly"]').locator('xpath=..').locator('.ui-resizable-se').boundingBox());
    await mouseDrag(page, se, { x: se.x + 40, y: se.y + 100 }, 20);
    await settle(page, 700);
    const rz = await page.evaluate(() => ({ events: window.__s3.log.map((l) => l.ev).reduce((m, e) => ((m[e] = (m[e] || 0) + 1), m), {}), persisted: window.__s3.persisted.length }));
    CHECK(S, 'one mouse resize => resizestart, resizestop, ONE `change`, one more persist', rz.events['gs:resizestart'] === 1 && rz.events['gs:resizestop'] === 1 && rz.events['gs:change'] === 1 && rz.persisted === 2, rz);
    // burst of programmatic updates coalesce into one persist
    await page.evaluate(() => { for (let i = 0; i < 5; i++) window.__s3.engine.update('models', { x: i % 2 ? 3 : 2 }); });
    await settle(page, 700);
    CHECK(S, '5 rapid programmatic updates coalesce into one debounced persist (250ms)', (await page.evaluate(() => window.__s3.persisted.length)) === 3, await page.evaluate(() => window.__s3.persisted.length));
    const snap = await page.evaluate(() => window.__s3.persisted.at(-1));
    CHECK(S, 'persisted snapshot has every panel {id,x,y,w,h,hidden} incl. hidden ones', snap.panels.length === 6 && snap.panels.every((p) => ['id', 'x', 'y', 'w', 'h', 'hidden'].every((k) => k in p)), snap.panels.slice(0, 2));
    await page.context().close();
  }
}

// ═════════════════════════ 5. Size ═══════════════════════════════════════════
if (want(5)) {
  const rows = JSON.parse(readFileSync('size/result.json', 'utf8'));
  const g = rows.find((r) => r.entry === 'gridstack');
  const e = rows.find((r) => r.entry === 'empty');
  INFO('5 size', 'esbuild --minify iife es2022 (repo webview config)', { gridstackJsBytes: g.js - e.js, gridstackJsGzip: g.jsGzip, gridstackCssBytes: g.css, gridstackCssGzip: g.cssGzip, echartsOnlyForScale: rows.find((r) => r.entry === 'echarts').js, vs700KB: `${(((g.js - e.js) / 700000) * 100).toFixed(1)}% JS growth` });
}

// ═════════════════════════ 7. Motion + contrast ══════════════════════════════
if (want(7)) {
  const S = '7 motion/contrast';
  const probe = (page) => page.evaluate(() => {
    const grid = document.getElementById('grid');
    const item = document.querySelector('.grid-stack-item');
    const cs = getComputedStyle(item);
    return { animateClass: grid.classList.contains('grid-stack-animate'), itemTransition: cs.transitionProperty + ' / ' + cs.transitionDuration };
  });
  {
    const { page } = await open('');
    const d = await probe(page);
    CHECK(S, 'gridstack animates by default (animate:true -> .grid-stack-animate, 0.3s left/top/width/height)', d.animateClass && /0\.3s/.test(d.itemTransition), d);
    await page.context().close();
  }
  {
    const { page } = await open('?animate=0');
    const d = await probe(page);
    CHECK(S, 'animate:false removes the class; item transitions are none/0s', !d.animateClass && /^all|0s$/.test(d.itemTransition.split(' / ')[1] ?? ''), d);
    await page.context().close();
  }
  {
    const { page } = await open('', { ctx: { reducedMotion: 'reduce' } });
    const d = await probe(page);
    CHECK(S, 'prefers-reduced-motion: reduce -> our @media override zeroes the transitions (class stays, CSS neutralises it)', /0s/.test(d.itemTransition.split(' / ')[1]), d);
    const src = ['gridstack.js', 'dd-draggable.js', 'dd-resizable.js', 'utils.js'].map((f) => readFileSync(`node_modules/gridstack/dist/${f}`, 'utf8')).join('\n');
    const css = readFileSync('node_modules/gridstack/dist/gridstack.css', 'utf8');
    CHECK(S, 'gridstack itself never consults prefers-reduced-motion (JS or CSS) -> the override is ours to ship', !/reduced-motion/.test(src + css) && !/matchMedia/.test(src), { jsMatchMedia: /matchMedia/.test(src), cssReducedMotion: /reduced-motion/.test(css) });
    INFO(S, 'also ours to neutralise: touch long-press "armed" wiggle/pulse keyframes (gs-armed-wiggle/pulse)', { keyframes: (css.match(/@keyframes [\w-]+/g) ?? []) });
    await page.context().close();
  }
  {
    // colours that clash: stock stylesheet
    const { page } = await open('?stock=1');
    const stockColors = await page.evaluate(() => {
      const mk = (cls, parent = document.body) => { const e = document.createElement('div'); e.className = cls; parent.appendChild(e); return e; };
      const item = document.querySelector('.grid-stack-item');
      const ph = mk('grid-stack-placeholder grid-stack-item'); const pc = mk('placeholder-content', ph);
      const handle = document.createElement('div'); handle.className = 'ui-resizable-handle ui-resizable-se'; item.appendChild(handle);
      const drag = document.createElement('div'); drag.className = 'ui-draggable-dragging'; const dc = mk('grid-stack-item-content', drag); document.body.appendChild(drag);
      return { placeholderBg: getComputedStyle(pc).backgroundColor, handleBgImageIsHardcodedSvg: getComputedStyle(handle).backgroundImage.includes('%23666'), draggingShadow: getComputedStyle(dc).boxShadow };
    });
    const css = readFileSync('node_modules/gridstack/dist/gridstack.css', 'utf8');
    const hardcoded = [...new Set(css.match(/(rgba?\([^)]*\)|#[0-9a-fA-F]{3,8}|%23[0-9a-fA-F]{3,6})/g) ?? [])];
    INFO(S, 'hard-coded colours in gridstack.css (none use var(--vscode-*)); computed on the stock page', { hardcoded, ...stockColors });
    CHECK(S, 'stock placeholder is rgba(0,0,0,0.1): effectively invisible on dark themes -> must be overridden with theme tokens', stockColors.placeholderBg === 'rgba(0, 0, 0, 0.1)', stockColors.placeholderBg);
    await page.context().close();
  }
  {
    // forced-colors / high contrast with our overrides
    const light = await open('?edit=1', { ctx: { forcedColors: 'active', colorScheme: 'dark' } });
    await light.page.screenshot({ path: 'evidence/forced-colors.png' });
    const fc = await light.page.evaluate(() => { const ph = document.createElement('div'); ph.className = 'grid-stack-placeholder grid-stack-item'; const c = document.createElement('div'); c.className = 'placeholder-content'; ph.appendChild(c); document.getElementById('grid').appendChild(ph); const out = { forcedColors: matchMedia('(forced-colors: active)').matches, placeholderBorder: getComputedStyle(c).borderTopColor, placeholderBg: getComputedStyle(c).backgroundColor, sectionBorder: getComputedStyle(document.querySelector('.wv-chart-section')).borderTopColor }; ph.remove(); return out; });
    INFO(S, 'forced-colors: active (Windows High Contrast / VS Code HC maps to system colours) with our overrides', fc);
    CHECK(S, 'forced-colors: placeholder uses a system colour border (Highlight), not the stock rgba(0,0,0,.1)', fc.forcedColors && fc.placeholderBg !== 'rgba(0, 0, 0, 0.1)', fc);
    await light.page.context().close();
  }
}

// ═════════════════════════ 8. Misc: leaks, contain, touch, license ═══════════
if (want(8)) {
  const S = '8 misc';
  const pkg = JSON.parse(readFileSync('node_modules/gridstack/package.json', 'utf8'));
  INFO(S, 'package', { name: pkg.name, version: pkg.version, license: pkg.license, dependencies: pkg.dependencies ?? {}, peer: pkg.peerDependencies ?? {} });
  CHECK(S, 'license MIT and zero runtime dependencies', pkg.license === 'MIT' && Object.keys(pkg.dependencies ?? {}).length === 0);
  const dd = readFileSync('node_modules/gridstack/dist/dd-draggable.js', 'utf8');
  INFO(S, 'DnD implementation', { html5DnD: /dragstart['"]\s*,\s*this/.test(dd) && /draggable\s*=\s*true/.test(dd), mouseEvents: /mousedown/.test(dd), touchEvents: /touchstart/.test(dd), pointerEvents: /pointerdown/.test(dd), note: 'custom mouse (+touch->mouse emulation) engine, NOT HTML5 DnD and NOT pointer events' });
  {
    // leak probe: instances (GC + queryObjects), ResizeObserver lifecycle, document/window listeners
    const { page, context } = await open('?stock=1');
    const cdp = await context.newCDPSession(page);
    const result = await page.evaluate(async () => {
      const GS = window.__s3.GridStack;
      const stats = { roCreated: 0, roDisconnected: 0, docWinAdds: 0, docWinRemoves: 0, anyAdds: 0, anyRemoves: 0 };
      const RO = window.ResizeObserver;
      window.ResizeObserver = class extends RO { constructor(cb) { super(cb); stats.roCreated++; } disconnect() { stats.roDisconnected++; super.disconnect(); } };
      const ea = EventTarget.prototype.addEventListener, er = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (...a) { stats.anyAdds++; if (this === document || this === window) stats.docWinAdds++; return ea.apply(this, a); };
      EventTarget.prototype.removeEventListener = function (...a) { stats.anyRemoves++; if (this === document || this === window) stats.docWinRemoves++; return er.apply(this, a); };
      for (let i = 0; i < 60; i++) {
        const host = document.createElement('div'); document.body.appendChild(host);
        const g = GS.init({ column: 4, cellHeight: 30, columnOpts: { breakpoints: [{ w: 700, c: 1 }], breakpointForWindow: true } }, host);
        g.load([{ id: 'a', x: 0, y: 0, w: 2, h: 2 }, { id: 'b', x: 2, y: 0, w: 2, h: 2 }, { id: 'c', x: 0, y: 2, w: 4, h: 2 }]);
        g.setStatic(false);
        g.destroy(true);
      }
      await new Promise((r) => setTimeout(r, 200));
      EventTarget.prototype.addEventListener = ea; EventTarget.prototype.removeEventListener = er; window.ResizeObserver = RO;
      return stats;
    });
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const proto = await cdp.send('Runtime.evaluate', { expression: 'window.__s3.GridStack.prototype' });
    const q = await cdp.send('Runtime.queryObjects', { prototypeObjectId: proto.result.objectId });
    const props = await cdp.send('Runtime.getProperties', { objectId: q.objects.objectId, ownProperties: true });
    const live = props.result.find((p) => p.name === 'length')?.value?.value;
    const domCount = await page.evaluate(() => document.querySelectorAll('.grid-stack').length);
    CHECK(S, 'destroy(): 60 init/load/setStatic/destroy cycles -> after GC only the 1 page-level GridStack instance is alive, no leftover DOM', live <= 1 && domCount === 1, { liveGridStackInstances: live, gridsInDom: domCount });
    CHECK(S, 'destroy(): every ResizeObserver created is disconnected; no document/window listener is left behind', result.roCreated === result.roDisconnected && result.docWinAdds <= result.docWinRemoves, result);
    await context.close();
  }
  // contain probes: drag helper tracking + clipping by an ancestor's contain:paint
  {
    const rows = [];
    for (const [label, q] of [['baseline (contain only on .wv-chart-section, as today)', '?edit=1'], ['contain:layout paint on .grid-stack-item', '?edit=1&containItem=1'], ['contain:layout paint on .grid-stack (ancestor of the fixed drag helper)', '?edit=1&containGrid=1']]) {
      const { page } = await open(q, { height: 700 });
      const band = { x: 0, y: 0, width: 1100, height: 46 };
      const a = await titlePoint(page, 'weekday');
      const startBox = await page.locator('[gs-id="weekday"]').boundingBox();
      const grabDx = a.x - startBox.x, grabDy = a.y - startBox.y;
      const bandBefore = await page.screenshot({ clip: band });
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      const target = { x: a.x + 200, y: 22 };
      for (let i = 1; i <= 12; i++) await page.mouse.move(a.x + ((target.x - a.x) * i) / 12, a.y + ((target.y - a.y) * i) / 12);
      const helper = await page.evaluate(() => { const el = document.querySelector('.ui-draggable-dragging'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; });
      const bandDuring = await page.screenshot({ clip: band });
      await page.mouse.up();
      rows.push({ label, helper, expectedIfNoOffset: { x: Math.round(target.x - grabDx), y: Math.round(target.y - grabDy) }, helperVisibleOverToolbarBand: !bandBefore.equals(bandDuring) });
      await page.context().close();
    }
    INFO(S, 'drag helper position + visibility over the toolbar band (outside the grid box), per `contain` placement', rows);
    const sameTrack = rows.every((r) => r.helper && Math.abs(r.helper.x - rows[0].helper.x) <= 2 && Math.abs(r.helper.y - rows[0].helper.y) <= 2);
    CHECK(S, 'contain on the item or the grid does not break cursor tracking (gridstack probes the fixed containing block)', sameTrack, rows.map((r) => r.helper));
    CHECK(S, 'baseline + contain on the item: helper stays visible outside the grid box', rows[0].helperVisibleOverToolbarBand && rows[1].helperVisibleOverToolbarBand, rows.map((r) => r.helperVisibleOverToolbarBand));
    CHECK(S, 'RISK CONFIRMED: contain:paint on an ANCESTOR of the items clips the dragged helper at that ancestor\'s box (keep contain on .wv-chart-section only)', rows[2].helperVisibleOverToolbarBand === false, rows[2].helperVisibleOverToolbarBand);
  }
  // touch (long-press 300 ms, then drag)
  {
    const { page, context } = await open('?edit=1', { ctx: { hasTouch: true } });
    const cdp = await context.newCDPSession(page);
    const a = await titlePoint(page, 'weekday');
    const before = fmt((await rects(page)).weekday);
    const tp = (x, y) => [{ x, y, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(a.x, a.y) });
    await page.waitForTimeout(450);
    for (let i = 1; i <= 16; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(a.x + i * 22, a.y + i * 11) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(page, 600);
    const after = fmt((await rects(page)).weekday);
    CHECK(S, 'touch: long-press (300 ms) on the header then drag moves the panel (touch->mouse emulation)', before !== after, { before, after });
    await context.close();
  }
}

writeFileSync('results.json', JSON.stringify(results, null, 2));
const fails = results.filter((r) => r.pass === false);
console.log(`\n${results.filter((r) => r.pass === true).length} PASS, ${fails.length} FAIL, ${results.filter((r) => r.pass === null).length} INFO`);
for (const f of fails) console.log('  FAIL:', f.section, f.name);
await browser.close();
server.close();
process.exit(fails.length ? 1 : 0);

/**
 * S3 spike demo page. Query flags (all optional):
 *   stock=1       plain gridstack markup, no custom ARIA/keyboard (for the "out of the box" probe)
 *   kb=0          do not attach the keyboard layer
 *   charts=0      no ECharts (isolates gridstack for the CSP probe)
 *   cols=12       12 columns instead of 4
 *   animate=0     disable gridstack animation
 *   nomove=1      delete Element.prototype.moveBefore (simulate pre-Chromium-133)
 *   edit=1        start in edit mode
 *   containGrid=1 / containItem=1   put `contain: layout paint` on the grid / on grid items (risk probe)
 */
import { GridStack } from 'gridstack';
import 'gridstack/dist/gridstack.css';
import './demo.css';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import { GridstackEngine } from './gridstackEngine';
import type { PanelRect, ChangeInfo } from './gridEngine';
import { attachKeyboardLayer, syncSlider } from './keyboard';
import { CELL_HEIGHT, COLUMNS, MARGIN, MIN_ROWS, NARROW_BELOW_PX, TIER_NAMES, TIER_ROWS } from './constants';

echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);

const q = new URLSearchParams(location.search);
const flag = (k: string, d: boolean): boolean => (q.has(k) ? q.get(k) !== '0' : d);
const columns = Number(q.get('cols') ?? COLUMNS);
// Tier row counts scale with nothing: rows are independent of the column count.

const log: Array<{ t: number; ev: string; detail?: unknown }> = [];
const t0 = performance.now();
const note = (ev: string, detail?: unknown): void => { log.push({ t: Math.round(performance.now() - t0), ev, detail }); };

// CSP evidence: collected from inside the page too (Playwright also listens to console).
const violations: Array<Record<string, string>> = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ directive: e.violatedDirective, blocked: e.blockedURI, sample: e.sample, source: e.sourceFile ?? '' });
});

if (flag('nomove', false)) (Element.prototype as any).moveBefore = undefined;

interface PanelDef { id: string; title: string; kind: 'line' | 'bar' | 'pie'; rect: PanelRect }
const T = TIER_ROWS;
const PANELS: PanelDef[] = [
  { id: 'timeline',   title: 'Cost over time', kind: 'line', rect: { id: 'timeline',   x: 0, y: 0,        w: 3, h: T[1] } },
  { id: 'models',     title: 'Models',         kind: 'bar',  rect: { id: 'models',     x: 3, y: 0,        w: 1, h: T[1] } },
  { id: 'weekday',    title: 'Weekday',        kind: 'bar',  rect: { id: 'weekday',    x: 0, y: T[1],     w: 2, h: T[0] } },
  { id: 'hourly',     title: 'Hourly',         kind: 'line', rect: { id: 'hourly',     x: 2, y: T[1],     w: 2, h: T[0] } },
  { id: 'categories', title: 'Categories',     kind: 'pie',  rect: { id: 'categories', x: 0, y: T[1] + T[0], w: 2, h: T[2] } },
  { id: 'heatmap',    title: 'Heatmap',        kind: 'bar',  rect: { id: 'heatmap',    x: 2, y: T[1] + T[0], w: 2, h: T[0] } },
];
const titleOf = (id: string): string => PANELS.find((p) => p.id === id)?.title ?? id;

function seriesFor(kind: PanelDef['kind'], seed: number) {
  const xs = Array.from({ length: 12 }, (_, i) => `D${i + 1}`);
  const ys = xs.map((_, i) => Math.round(50 + 40 * Math.sin((i + seed) / 2) + seed * 3));
  if (kind === 'pie') {
    return { tooltip: { trigger: 'item' }, legend: { bottom: 0 }, series: [{ type: 'pie', radius: ['30%', '65%'], data: xs.slice(0, 5).map((n, i) => ({ name: n, value: ys[i] })) }] };
  }
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 36, right: 12, top: 12, bottom: 24 },
    xAxis: { type: 'category', data: xs },
    yAxis: { type: 'value' },
    series: [{ type: kind, data: ys, ...(kind === 'line' ? { smooth: true } : {}) }],
  };
}

function panelEl(p: PanelDef): HTMLElement {
  const item = document.createElement('div');
  item.className = 'grid-stack-item';
  item.setAttribute('gs-id', p.id);
  item.innerHTML = `
    <section class="wv-chart-section grid-stack-item-content" data-panel="${p.id}" aria-labelledby="t-${p.id}">
      <div class="wv-panel-header">
        <span class="wv-chart-title" id="t-${p.id}">${p.title}</span>
        <span class="wv-panel-tools">
          <span class="wv-move-handle" role="button" tabindex="0" data-act="move"
                aria-label="Move ${p.title}" aria-roledescription="movable panel"
                aria-describedby="kb-help" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight">::</span>
          <span class="wv-resize-slider" role="slider" tabindex="0" data-axis="w" aria-orientation="horizontal"
                aria-label="${p.title} width"></span>
          <span class="wv-resize-slider" role="slider" tabindex="0" data-axis="h" aria-orientation="vertical"
                aria-label="${p.title} height"></span>
          <button class="wv-panel-btn" type="button" data-act="hide" aria-label="Hide ${p.title}">x</button>
        </span>
      </div>
      <div class="wv-chart-body" id="body-${p.id}" role="img" aria-label="${p.title} chart"></div>
    </section>`;
  return item;
}

// ── stock probe: plain gridstack, nothing of ours ───────────────────────────────
function mountStock(root: HTMLElement): void {
  root.innerHTML = `<div class="grid-stack" id="stock"></div>`;
  const grid = GridStack.init({ column: columns, cellHeight: 60, margin: 6 }, '#stock')!;
  grid.load([
    { id: 'a', x: 0, y: 0, w: 2, h: 2, content: 'Widget A' },
    { id: 'b', x: 2, y: 0, w: 2, h: 2, content: 'Widget B' },
    { id: 'c', x: 0, y: 2, w: 4, h: 2, content: 'Widget C' },
  ]);
  (window as any).__s3 = { grid, log, violations, GridStack };
}

function mount(root: HTMLElement): void {
  root.innerHTML = `
    <div class="wv-dashboard">
      <div class="wv-toolbar">
        <button class="wv-btn" id="edit-toggle" aria-pressed="false">Edit layout</button>
        <span id="hidden-list"></span>
      </div>
      <p id="kb-help" class="wv-sr-only">Alt plus arrow keys move this panel. Use the width and height sliders with the arrow keys to resize it.</p>
      <div id="live" class="wv-sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
      <div class="grid-stack" id="grid"></div>
    </div>`;
  const grid = document.getElementById('grid')!;
  if (flag('containGrid', false)) grid.style.contain = 'layout paint';
  const live = document.getElementById('live')!;
  const announcements: string[] = [];
  const announce = (msg: string): void => {
    announcements.push(msg);
    live.textContent = '';
    requestAnimationFrame(() => { live.textContent = msg; });
  };

  const engine = new GridstackEngine();
  // DOM first (gridstack adopts existing children on init when auto=true, but we want to register
  // explicitly so persisted rects win): append, then mount, then register.
  const els = new Map<string, HTMLElement>();
  for (const p of PANELS) {
    const el = panelEl(p);
    if (flag('containItem', false)) el.style.contain = 'layout paint';
    grid.appendChild(el);
    els.set(p.id, el);
  }
  engine.mount(grid, {
    columns, narrowBelowPx: NARROW_BELOW_PX, cellHeight: CELL_HEIGHT, margin: MARGIN,
    animate: flag('animate', true), handle: '.wv-panel-header', dragCancel: '.wv-panel-tools', minH: MIN_ROWS,
  });
  const raw = engine.raw();
  for (const ev of ['dragstart', 'dragstop', 'resizestart', 'resizestop', 'added', 'removed', 'change', 'enable', 'disable', 'dropped'] as const) {
    raw.on(ev as any, (_e: Event, detail: unknown) => note(`gs:${ev}`, Array.isArray(detail) ? (detail as any[]).map((n) => n?.id ?? n?.el?.getAttribute?.('gs-id')) : undefined));
  }

  // Charts: ResizeObserver-driven chart.resize(), one rAF-coalesced call per frame.
  const charts = new Map<string, echarts.ECharts>();
  const chartResizes: Record<string, number> = {};
  const chartEvents: Record<string, { click: number; mouseover: number; showTip: number }> = {};
  if (flag('charts', true)) {
    PANELS.forEach((p, i) => {
      const body = document.getElementById(`body-${p.id}`)!;
      const chart = echarts.init(body, undefined, { renderer: 'canvas' });
      chart.setOption(seriesFor(p.kind, i));
      charts.set(p.id, chart);
      chartResizes[p.id] = 0;
      const ev = (chartEvents[p.id] = { click: 0, mouseover: 0, showTip: 0 });
      chart.on('click', () => { ev.click++; });
      chart.on('mouseover', () => { ev.mouseover++; });
      chart.on('showTip', () => { ev.showTip++; });
      let raf = 0;
      new ResizeObserver(() => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => { chart.resize(); chartResizes[p.id]!++; });
      }).observe(body);
    });
  }

  // Adopt panels. The saved/default rects are passed together (see GridEngine.registerAll).
  if (q.get('initial') === 'each') for (const p of PANELS) engine.register(p.id, els.get(p.id)!, p.rect);
  else engine.registerAll(PANELS.map((p) => ({ id: p.id, el: els.get(p.id)!, rect: p.rect })));

  // ── hide / show via unregister/reregister ─────────────────────────────────────
  const hidden = new Set<string>();
  const hiddenList = document.getElementById('hidden-list')!;
  const lastRects = new Map<string, PanelRect>();
  function renderHiddenList(): void {
    hiddenList.innerHTML = '';
    for (const id of hidden) {
      const b = document.createElement('button');
      b.className = 'wv-btn'; b.type = 'button'; b.dataset.show = id; b.textContent = `Show ${titleOf(id)}`;
      b.addEventListener('click', () => showPanel(id));
      hiddenList.appendChild(b);
    }
  }
  function hidePanel(id: string): void {
    const r = engine.unregister(id);
    if (r) lastRects.set(id, r);
    hidden.add(id);
    renderHiddenList();
    announce(`${titleOf(id)} hidden.`);
    schedulePersist();
  }
  function showPanel(id: string): void {
    hidden.delete(id);
    engine.reregister(id, lastRects.get(id));
    // The chart's container was display:none (hidden attr) while parked: ResizeObserver fires on re-show,
    // but a second explicit resize is cheap insurance.
    requestAnimationFrame(() => charts.get(id)?.resize());
    renderHiddenList();
    announce(`${titleOf(id)} shown.`);
    schedulePersist();
  }
  grid.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act="hide"]');
    if (b) hidePanel(b.closest<HTMLElement>('[data-panel]')!.dataset.panel!);
  });

  // ── persistence gating + debounce ──────────────────────────────────────────────
  const persisted: Array<{ at: number; column: number; panels: Array<PanelRect & { hidden: boolean }> }> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressed = 0;
  function snapshot(): Array<PanelRect & { hidden: boolean }> {
    const live = engine.save();
    const parked = [...hidden].map((id) => ({ ...lastRects.get(id)!, hidden: true }));
    return [...live.map((r) => ({ ...r, hidden: false })), ...parked];
  }
  function schedulePersist(info?: ChangeInfo): void {
    // GATE: never persist while narrow (1 column) or while gridstack is mid-column-switch/load.
    if (engine.columns() !== columns || info?.ignorable) { suppressed++; return; }
    clearTimeout(timer);
    timer = setTimeout(() => persisted.push({ at: Math.round(performance.now() - t0), column: engine.columns(), panels: snapshot() }), 250);
  }
  engine.onChange((info) => schedulePersist(info));

  // ── slider ARIA sync + edit mode ───────────────────────────────────────────────
  const sliders = () => Array.from(grid.querySelectorAll<HTMLElement>('[role="slider"][data-axis]'));
  const syncAll = (): void => {
    for (const s of sliders()) {
      const r = engine.rect(s.closest<HTMLElement>('[data-panel]')!.dataset.panel!);
      if (r) syncSlider(s, r, engine.columns(), { tierRows: TIER_ROWS, tierNames: TIER_NAMES });
    }
  };
  engine.onChange(syncAll);
  syncAll();

  const editBtn = document.getElementById('edit-toggle')!;
  function setEditing(on: boolean): void {
    engine.setStatic(!on);
    editBtn.setAttribute('aria-pressed', String(on));
    editBtn.textContent = on ? 'Done editing' : 'Edit layout';
    announce(on ? 'Layout editing on.' : 'Layout editing off.');
    syncAll();
  }
  editBtn.addEventListener('click', () => setEditing(editBtn.getAttribute('aria-pressed') !== 'true'));

  // Narrow (1-column) view: editing a collapsed layout would corrupt the cached wide layout (see README),
  // so force static + disable the Edit button until the grid is wide again.
  engine.onColumnChange((c) => {
    const wide = c === columns;
    if (!wide) setEditing(false);
    (editBtn as HTMLButtonElement).disabled = !wide;
    editBtn.title = wide ? '' : 'Layout editing is only available in the wide layout';
  });

  if (flag('kb', true)) {
    attachKeyboardLayer(grid, engine, { tierRows: TIER_ROWS, tierNames: TIER_NAMES, titleOf, announce });
  }
  if (flag('edit', false)) setEditing(true);

  (window as any).__s3 = {
    engine, raw, charts, chartResizes, chartEvents, log, violations, announcements, persisted, els, hidden,
    hidePanel, showPanel, setEditing, snapshot, suppressedCount: () => suppressed, PANELS, GridStack,
  };
}

const root = document.getElementById('app')!;
if (flag('stock', false)) mountStock(root);
else mount(root);
document.documentElement.dataset.ready = '1';

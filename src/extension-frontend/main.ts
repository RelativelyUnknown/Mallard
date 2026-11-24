import './styles/fonts.css';
import './styles/reset.css';
import './styles/theme.css';
import './styles/dashboard.css';
// Bundle the codicon font+CSS into the webview build so it ships inside the
// VSIX. Linking it live from node_modules 404s once packaged (node_modules is
// stripped), which blanks every icon; esbuild inlines this and copies the .ttf.
import '@vscode/codicons/dist/codicon.css';

import { onMessage, post } from './api';
import { state, setState, subscribe } from './store';
import { lazyChart } from './lazyMount';
import { mountLayout } from './layout';
import {
  DashboardLayout,
  DEFAULT_DASHBOARD_LAYOUT,
} from '../extension-backend/domain/types';
import { applyTheme } from './charts/echarts';
import { applyPalette, setForcedScheme } from './theme';
import { filterPatchFromSnapshot, postFilter, reresolveRelativeRange } from './filterSync';
import { mountAddChartMenu } from './addChartMenu';
import { describeCharts } from './srDescriptions';
import { escapeHtml } from './escapeHtml';
import { CHART_REGISTRY, ChartHooks, RegisteredChart } from './charts/registry';
import { mountKpiCards } from './components/KpiCards';
import { mountFilterBar } from './components/FilterBar';
import { mountGitHubBillingStrip } from './components/GitHubBillingStrip';
import { mountStatusBanner } from './components/StatusBanner';
import { mountEmptyState } from './components/EmptyState';
import { mountAlertConfigPanel } from './components/AlertConfigPanel';
import { mountRestrictionBanner } from './components/RestrictionBanner';
import { mountCurrencySelector } from './components/CurrencySelector';

const LOGO_SRC = document.body.dataset.logo ?? '';

function setSrDesc(bodyId: string, text: string): void {
  const el = document.getElementById(`desc-${bodyId}`);
  if (el) el.textContent = text;
}

/** Rerender closures for every mounted chart, registered once by mountDashboard. */
let rerenderAllChartsForTheme: (() => void) | null = null;

applyTheme();
mountDashboard(document.getElementById('app')!);

// ── Message routing ─────────────────────────────────────────────────────────

onMessage((msg) => {
  if (msg.type === 'snapshot') {
    // The host's filter is authoritative: a reopened panel, the sidebar's
    // model list, or another dashboard can all have changed it. Adopt it
    // (without echoing a setFilter back) and then make sure a relative date
    // preset still resolves to today's range.
    setState({ snapshot: msg.payload, ...filterPatchFromSnapshot(msg.payload.filter) });
    reresolveRelativeRange();
  } else if (msg.type === 'config') {
    setState({ config: msg.value });
  } else if (msg.type === 'layout') {
    setState({ layout: msg.value });
  } else if (msg.type === 'restriction') {
    setState({ restriction: msg.value });
  } else if (msg.type === 'theme') {
    applyPalette(msg.palette, msg.kind);
    // Only the very first theme message seeds the forced-scheme toggle (so
    // it starts in sync with VS Code); afterwards the toggle is a manual
    // override the user controls independently of the editor theme.
    if (state().forcedScheme === null) {
      const initial = msg.kind === 'light' || msg.kind === 'high-contrast-light' ? 'light' : 'dark';
      setState({ forcedScheme: initial });
      setForcedScheme(initial);
      updateThemeToggleUI(initial);
    }
    applyTheme();
    rerenderAllChartsForTheme?.();
  }
});

post({ type: 'ready' });

function updateThemeToggleUI(scheme: 'light' | 'dark'): void {
  const btn = document.getElementById('theme-toggle');
  if (!btn) return;
  btn.setAttribute('aria-pressed', String(scheme === 'dark'));
  const label = scheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  const icon = btn.querySelector('i');
  if (icon) icon.className = `codicon ${scheme === 'dark' ? 'codicon-color-mode' : 'codicon-lightbulb'}`;
}

// ── Full dashboard ──────────────────────────────────────────────────────────

function panelHtml(
  id: string,
  icon: string,
  title: string,
  bodyId: string,
  ariaLabel: string,
  bodyClass = '',
): string {
  const descId = `desc-${bodyId}`;
  return `
    <section class="wv-chart-section" data-panel="${id}" aria-label="${title}">
      <div class="wv-chart-header">
        <span class="wv-chart-title"><i class="codicon ${icon}"></i> ${title}</span>
      </div>
      <p id="${descId}" class="wv-sr-only"></p>
      <div class="wv-chart-body ${bodyClass}" id="${bodyId}" role="img" aria-label="${ariaLabel}" aria-describedby="${descId}"></div>
    </section>`;
}

function mountDashboard(root: HTMLElement): void {
  root.innerHTML = `
    <div class="wv-dashboard">
      <header class="wv-header">
        <div class="wv-brand">
          <img class="wv-brand-logo" src="${escapeHtml(LOGO_SRC)}" alt="" aria-hidden="true" />
          <div>
            <div class="wv-brand-name">Mallard</div>
            <div class="wv-brand-meta">Copilot spend · instrument</div>
          </div>
        </div>
        <div class="wv-header-right">
          <button class="wv-gh-header-btn" id="gh-header-signin" hidden>
            <i class="codicon codicon-github" aria-hidden="true"></i>
            <span id="gh-header-label">Sign in</span>
          </button>
          <div id="currency-selector" class="wv-currency-wrap"></div>
          <button class="wv-icon-btn" id="theme-toggle" aria-label="Toggle light/dark mode" title="Toggle light/dark mode">
            <i class="codicon codicon-color-mode"></i>
          </button>
          <div id="status-banner"></div>
        </div>
      </header>
      <div id="empty-state"></div>
      <div id="content" hidden>
        <div id="kpi-cards"></div>
        <div id="gh-billing-strip"></div>
        <!-- The live spend gauge lives in the sidebar now (see SidebarView) —
             keeping one copy avoids two out-of-sync budget readouts. -->
        <div id="restriction-banner"></div>
        <div id="filter-bar"></div>
        <div id="alert-config"></div>
        <div class="wv-analysis-bar">
          <span class="wv-analysis-title">Analysis</span>
          <span class="wv-analysis-actions">
            <span class="wv-add-chart" id="add-chart-wrap">
              <button class="wv-btn wv-btn--sm" id="layout-add" aria-haspopup="true" aria-expanded="false">
                <i class="codicon codicon-add"></i> Add chart
              </button>
              <div class="wv-add-chart-menu" id="add-chart-menu" role="menu" hidden></div>
            </span>
            <button class="wv-btn wv-btn--sm" id="layout-reset" hidden>
              <i class="codicon codicon-discard"></i> Reset layout
            </button>
            <button class="wv-btn wv-btn--sm" id="layout-resize" aria-pressed="false">
              <i class="codicon codicon-arrow-both"></i> Resize
            </button>
            <button class="wv-btn wv-btn--sm" id="layout-move" aria-pressed="false">
              <i class="codicon codicon-move"></i> Move
            </button>
          </span>
        </div>
        <div class="wv-section-label">More views</div>
        <div class="wv-charts-grid" id="charts-grid">
          ${CHART_REGISTRY.map((d) =>
            panelHtml(d.id, d.icon, d.title, d.bodyId, d.ariaLabel, d.bodyClass ?? ''),
          ).join('')}
        </div>
      </div>
    </div>`;

  const banner = mountStatusBanner(document.getElementById('status-banner')!);
  const restrictBanner = mountRestrictionBanner(document.getElementById('restriction-banner')!);
  const filterBar = mountFilterBar(document.getElementById('filter-bar')!);
  const emptyState = mountEmptyState(document.getElementById('empty-state')!);
  const kpis = mountKpiCards(document.getElementById('kpi-cards')!);
  const ghStrip = mountGitHubBillingStrip(document.getElementById('gh-billing-strip')!);
  const ghHeaderBtn = document.getElementById('gh-header-signin')!;
  const ghHeaderLabel = document.getElementById('gh-header-label')!;
  ghHeaderBtn.addEventListener('click', () => post({ type: 'command', id: 'signIn' }));
  function updateGhHeaderButton(snapshot: import('../extension-backend/domain/types').UsageSnapshot): void {
    ghHeaderBtn.hidden = false;
    ghHeaderBtn.classList.remove('wv-gh-header-btn--ok', 'wv-gh-header-btn--err');
    if (snapshot.authStatus === 'signed-in') {
      ghHeaderLabel.textContent = 'Connected';
      ghHeaderBtn.classList.add('wv-gh-header-btn--ok');
      ghHeaderBtn.title = 'Signed in to GitHub — spend verified';
    } else if (snapshot.authStatus === 'error') {
      ghHeaderLabel.textContent = 'GitHub error';
      ghHeaderBtn.classList.add('wv-gh-header-btn--err');
      ghHeaderBtn.title = snapshot.authError ?? 'GitHub sign-in failed — click to retry';
    } else {
      ghHeaderLabel.textContent = 'Sign in';
      ghHeaderBtn.title = 'Sign in to GitHub to verify actual Copilot spend';
    }
  }
  const currencySelector = mountCurrencySelector(
    document.getElementById('currency-selector')!,
    (code) => post({ type: 'setCurrency', value: code }),
  );

  // Theme toggle: strict binary flip between light and dark (no "follow
  // VS Code" middle state — that state is only used to seed the initial
  // value from the 'theme' message, see updateThemeToggleUI above).
  const themeToggleBtn = document.getElementById('theme-toggle')!;
  themeToggleBtn.addEventListener('click', () => {
    const current = state().forcedScheme ?? 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    setState({ forcedScheme: next });
    setForcedScheme(next);
    updateThemeToggleUI(next);
    applyTheme();
    rerenderAllChartsForTheme?.();
  });
  const chartsGrid = document.getElementById('charts-grid')!;

  // The model filter dropdown (FilterBar) is the single source of truth for
  // "focus" — a bar click toggles the same filter.models list the dropdown
  // reads and writes, so both stay in sync automatically.
  const hooks: ChartHooks = {
    toggleModelFilter(label) {
      const current = new Set(state().filter.models ?? []);
      if (current.has(label)) current.delete(label);
      else current.add(label);
      const newFilter = { ...state().filter };
      if (current.size > 0) newFilter.models = [...current];
      else delete newFilter.models;
      setState({ filter: newFilter });
      postFilter(newFilter);
    },
  };

  // One lazy handle per registered chart; every fan-out below iterates this.
  const charts = new Map(
    CHART_REGISTRY.map((def) => {
      const el = document.getElementById(def.bodyId)!;
      return [def.id, lazyChart<RegisteredChart>(el, () => def.mount(el, hooks))] as const;
    }),
  );

  const alertConfig = mountAlertConfigPanel(document.getElementById('alert-config')!);
  const content = document.getElementById('content')!;

  // Section elements (the dockable/resizable panels) keyed by panel id.
  const section = (id: string) =>
    document.querySelector<HTMLElement>(`.wv-chart-section[data-panel="${id}"]`)!;
  const sections: Record<string, HTMLElement> = Object.fromEntries(
    CHART_REGISTRY.map((d) => [d.id, section(d.id)]),
  );

  const resizeAll = () => {
    for (const c of charts.values()) c.resize();
  };

  rerenderAllChartsForTheme = () => {
    for (const c of charts.values()) c.rerenderForTheme();
  };

  // Dynamic scaling + docking: the layout manager reorders, resizes (span), and
  // shows/hides panels; every change is persisted via setLayout.
  const layoutMgr = mountLayout(document.getElementById('charts-grid')!, sections, (next) => {
    post({ type: 'setLayout', value: next });
    requestAnimationFrame(resizeAll);
  });
  layoutMgr.apply(state().layout);

  // Resize and move are independent, mutually exclusive modes — entering
  // one exits the other (only one interaction is active on the grid at a
  // time, so resize handles and drag-to-reorder never compete).
  let mode: 'none' | 'resize' | 'move' = 'none';
  const resizeBtn = document.getElementById('layout-resize')!;
  const moveBtn = document.getElementById('layout-move')!;
  const resetBtn = document.getElementById('layout-reset')!;

  function setMode(next: 'none' | 'resize' | 'move'): void {
    mode = mode === next ? 'none' : next;
    layoutMgr.setMode(mode);
    resizeBtn.setAttribute('aria-pressed', String(mode === 'resize'));
    moveBtn.setAttribute('aria-pressed', String(mode === 'move'));
    const editing = mode !== 'none';
    resetBtn.hidden = !editing;
    requestAnimationFrame(resizeAll);
  }

  // "Add chart" picker: lists panels currently hidden in the layout (the
  // extra charts start life hidden); choosing one unhides it in place.
  const titleById = new Map(CHART_REGISTRY.map((d) => [d.id, d.title]));
  mountAddChartMenu({
    wrap: document.getElementById('add-chart-wrap')!,
    button: document.getElementById('layout-add')!,
    menu: document.getElementById('add-chart-menu')!,
    hiddenPanels: () =>
      state().layout
        .filter((pnl) => pnl.hidden && titleById.has(pnl.id))
        .map((pnl) => ({ id: pnl.id, title: titleById.get(pnl.id)! })),
    onPick: (id) => {
      const next = state().layout.map((q) => (q.id === id ? { ...q, hidden: false } : q));
      post({ type: 'setLayout', value: next });
    },
  });

  resizeBtn.addEventListener('click', () => setMode('resize'));
  moveBtn.addEventListener('click', () => setMode('move'));

  // Layout persists straight into config.json via setLayout, so resetting is
  // just writing the default layout back.
  resetBtn.addEventListener('click', () => {
    post({ type: 'setLayout', value: DEFAULT_DASHBOARD_LAYOUT });
  });

  alertConfig.update(state().config);

  let resizeFrame: number | undefined;
  const resizeObserver = new ResizeObserver(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(resizeAll);
  });
  for (const el of Object.values(sections)) resizeObserver.observe(el);

  emptyState.update(false);

  let appliedLayout: DashboardLayout | null = null;

  // Per-chart payload trackers for diff-based render skipping.
  // Charts only re-render when their specific input data changes.
  const prevSlices = new Map<string, unknown>();
  let prevFocusedModelsKey: string | undefined;
  let prevMetric: string | undefined;

  subscribe((s) => {
    alertConfig.update(s.config);
    if (s.layout !== appliedLayout) {
      appliedLayout = s.layout;
      layoutMgr.apply(s.layout);
      requestAnimationFrame(resizeAll);
    }

    // Apply configurable column count to the CSS grid.
    const cols = Math.min(4, Math.max(1, s.config.dashboard?.columns ?? 2));
    chartsGrid.style.setProperty('--wv-cols', String(cols));

    // Model spotlight state — derived from the filter bar's model dropdown
    // (the single source of truth for "focus"), not separate state.
    const focusedModelsList = s.filter.models ?? [];
    chartsGrid.dataset.focused = focusedModelsList.length > 0 ? 'true' : '';

    if (!s.snapshot) return;
    const isEmpty = s.snapshot.status.kind === 'empty';
    emptyState.update(isEmpty, s.snapshot.status.reason);
    content.hidden = isEmpty;

    banner.update(s.snapshot);
    filterBar.update(s.snapshot, s.metric);
    restrictBanner.update(s.restriction);

    if (!isEmpty) {
      const snapshot = s.snapshot;
      const metric = s.metric;
      kpis.update(snapshot, metric);
      ghStrip.update(snapshot);
      updateGhHeaderButton(snapshot);
      currencySelector.update(snapshot.fxRates, snapshot.currency);

      const focusedModelsKey = focusedModelsList.join(',');
      const ctx = { metric, focusedModels: focusedModelsList };
      for (const def of CHART_REGISTRY) {
        if (def.noData) sections[def.id]!.classList.toggle('wv-no-data', def.noData(snapshot));
        const slice = def.select(snapshot);
        const dirty =
          def.isDirty(prevSlices.get(def.id), slice) ||
          (def.usesMetric === true && metric !== prevMetric) ||
          (def.usesFocus === true && focusedModelsKey !== prevFocusedModelsKey);
        if (dirty) {
          charts.get(def.id)!.render((c) => c.update(snapshot, ctx));
          prevSlices.set(def.id, slice);
        }
      }
      prevFocusedModelsKey = focusedModelsKey;

      prevMetric = metric;
      updateSrDescriptions(snapshot);
    }
  });
}

function updateSrDescriptions(snapshot: import('../extension-backend/domain/types').UsageSnapshot): void {
  for (const [bodyId, text] of Object.entries(describeCharts(snapshot))) setSrDesc(bodyId, text);
}

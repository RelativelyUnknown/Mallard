/**
 * Filter bar with:
 *   1. Date-range preset buttons (Today | 7d | 30d | This month | All time)
 *   2. Metric toggle (Cost | Credits | Tokens)
 *   3. Model multi-select dropdown (populated from snapshot data)
 *   4. Surface chips (only when >1 surface present)
 */
import { setState, state } from '../store';
import { postFilter } from '../filterSync';
import { DatePreset, Filter, Metric, SourceKind, Surface, UsageSnapshot } from '../../extension-backend/domain/types';
import { resolveRangePreset } from '../../extension-backend/domain/rangePreset';

export interface FilterBarHandle {
  update(snapshot: UsageSnapshot, metric: Metric): void;
}

const DATE_PRESETS: Array<{ id: DatePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'month', label: 'This month' },
  { id: 'all', label: 'All time' },
];

const METRICS: Array<{ id: Metric; label: string }> = [
  { id: 'cost', label: 'Cost' },
  { id: 'credits', label: 'Credits' },
  { id: 'tokens', label: 'Tokens' },
];

/** Copilot-type sources (LM calls, local OTel logs, GitHub billing). */
const COPILOT_SOURCES: SourceKind[] = ['lm', 'local', 'github'];

function buildFilter(
  preset: DatePreset,
  models: string[],
  surface: Surface | null,
  repos: string[],
  branches: string[],
  sources: SourceKind[],
): Filter {
  const range = resolveRangePreset(preset, Date.now());
  return {
    ...(range !== undefined ? { range } : {}),
    // Sent alongside the range so the host can re-resolve a relative preset
    // as time passes, and a reopened dashboard can restore the button.
    rangePreset: preset,
    ...(models.length ? { models } : {}),
    ...(surface ? { surfaces: [surface] } : {}),
    ...(repos.length ? { repos } : {}),
    ...(branches.length ? { branches } : {}),
    ...(sources.length ? { sources } : {}),
  };
}

export function mountFilterBar(el: HTMLElement): FilterBarHandle {
  el.innerHTML = `
    <div class="wv-filter-bar">
      <div class="wv-date-presets" role="group" aria-label="Date range">
        ${DATE_PRESETS.map((p) => `
          <button class="wv-preset-btn" data-preset="${p.id}" aria-pressed="false">${p.label}</button>
        `).join('')}
      </div>
      <div class="wv-filter-spacer"></div>
      <select class="wv-repo-select" id="repo-select" aria-label="Repository" hidden></select>
      <div class="wv-model-filter" id="model-filter" hidden>
        <button class="wv-filter-btn" id="model-filter-btn" aria-haspopup="listbox" aria-expanded="false">
          <i class="codicon codicon-symbol-method"></i>
          <span id="model-filter-label">All models</span>
          <i class="codicon codicon-chevron-down"></i>
        </button>
        <div class="wv-model-dropdown" id="model-dropdown" role="listbox" aria-multiselectable="true" hidden></div>
      </div>
      <div class="wv-metric-toggle" role="group" aria-label="Metric">
        ${METRICS.map((m) => `
          <button class="wv-metric-btn" data-metric="${m.id}" aria-pressed="false">${m.label}</button>
        `).join('')}
      </div>
    </div>
    <div class="wv-surface-chips" id="surface-chips" hidden role="group" aria-label="Surface"></div>
    <div class="wv-chip-group" id="source-chip-group" hidden>
      <span class="wv-chip-group-label">Source</span>
      <div class="wv-source-chips" id="source-chips" role="group" aria-label="Source"></div>
    </div>`;

  let activePreset: DatePreset = state().datePreset;
  let activeModels: string[] = [];
  let activeSurface: Surface | null = null;
  let activeRepos: string[] = [];
  let activeBranches: string[] = [];
  let activeSources: SourceKind[] = [];
  // What each rebuilt region was last rendered from. Live snapshots arrive
  // constantly; rebuilding a region whose inputs didn't change would drop
  // keyboard focus and close open pickers, so each rebuilds only on change.
  let repoKey: string | null = null;
  let modelsKey: string | null = null;
  let surfaceKey: string | null = null;
  let sourceKey: string | null = null;

  function updatePresetUI() {
    el.querySelectorAll<HTMLElement>('[data-preset]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.preset === activePreset));
    });
  }

  function updateMetricUI(metric: Metric) {
    el.querySelectorAll<HTMLElement>('[data-metric]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.metric === metric));
    });
  }

  function dispatchFilter() {
    const filter = buildFilter(
      activePreset, activeModels, activeSurface, activeRepos, activeBranches, activeSources,
    );
    setState({ filter, datePreset: activePreset });
    postFilter(filter);
  }

  const repoSelect = el.querySelector<HTMLSelectElement>('#repo-select')!;
  repoSelect.addEventListener('change', () => {
    activeRepos = repoSelect.value === '__all__' ? [] : [repoSelect.value];
    dispatchFilter();
  });

  function rebuildRepoSelect(allRepos: string[], heuristicRepos: ReadonlySet<string>) {
    const selected = activeRepos[0] ?? '__all__';
    repoSelect.innerHTML = '';
    for (const r of ['__all__', ...allRepos]) {
      const opt = document.createElement('option');
      opt.value = r;
      // "\u2248" marks repos whose spend is (partly) attributed by the
      // active-editor heuristic rather than recorded in the source log.
      opt.textContent = r === '__all__' ? 'All repos' : heuristicRepos.has(r) ? `\u2248 ${r}` : r;
      opt.selected = r === selected;
      repoSelect.appendChild(opt);
    }
  }

  el.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.preset;
      if (!DATE_PRESETS.some((p) => p.id === preset)) return;
      activePreset = preset as DatePreset;
      updatePresetUI();
      dispatchFilter();
    });
  });

  el.querySelectorAll<HTMLButtonElement>('[data-metric]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const metric = btn.dataset.metric;
      if (!METRICS.some((m) => m.id === metric)) return;
      setState({ metric: metric as Metric });
    });
  });

  const modelFilterEl = el.querySelector<HTMLElement>('#model-filter')!;
  const modelFilterBtn = el.querySelector<HTMLButtonElement>('#model-filter-btn')!;
  const modelDropdown = el.querySelector<HTMLElement>('#model-dropdown')!;
  const modelLabel = el.querySelector<HTMLElement>('#model-filter-label')!;

  function openDropdown(): void {
    modelDropdown.hidden = false;
    modelFilterBtn.setAttribute('aria-expanded', 'true');
    const first = modelDropdown.querySelector<HTMLElement>('[role="option"]');
    first?.focus();
  }

  function closeDropdown(returnFocus = true): void {
    modelDropdown.hidden = true;
    modelFilterBtn.setAttribute('aria-expanded', 'false');
    if (returnFocus) modelFilterBtn.focus();
  }

  modelFilterBtn.addEventListener('click', () => {
    if (modelDropdown.hidden) { openDropdown(); } else { closeDropdown(false); }
  });

  modelFilterBtn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDropdown(); }
  });

  modelDropdown.addEventListener('keydown', (e) => {
    const options = [...modelDropdown.querySelectorAll<HTMLElement>('[role="option"]')];
    const focused = document.activeElement as HTMLElement;
    const idx = options.indexOf(focused);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      options[Math.min(idx + 1, options.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx <= 0) closeDropdown();
      else options[idx - 1]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      focused.click();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      closeDropdown(e.key === 'Escape');
    }
  });

  document.addEventListener('click', (e) => {
    if (!modelFilterEl.contains(e.target as Node)) closeDropdown(false);
  });

  function updateModelLabel() {
    if (activeModels.length === 0) {
      modelLabel.textContent = 'All models';
      modelLabel.removeAttribute('title');
    } else if (activeModels.length === 1) {
      const full = activeModels[0]!;
      modelLabel.textContent = full.length > 24 ? `${full.slice(0, 23)}…` : full;
      modelLabel.title = full; // full name on hover, since the label truncates
    } else {
      modelLabel.textContent = `${activeModels.length} models`;
      modelLabel.title = activeModels.join(', ');
    }
  }

  function rebuildModelDropdown(allModels: string[], focusModel?: string) {
    modelsKey = JSON.stringify([allModels, activeModels]);
    modelDropdown.innerHTML = '';

    const allOpt = document.createElement('div');
    allOpt.className = 'wv-model-option';
    allOpt.setAttribute('role', 'option');
    allOpt.setAttribute('tabindex', '-1');
    allOpt.id = 'model-opt-all';
    allOpt.setAttribute('aria-selected', String(activeModels.length === 0));
    allOpt.dataset.model = '__all__';
    const allIcon = document.createElement('i');
    allIcon.className = `codicon codicon-${activeModels.length === 0 ? 'check' : 'blank'}`;
    allIcon.setAttribute('aria-hidden', 'true');
    allOpt.appendChild(allIcon);
    allOpt.append(' All models');
    allOpt.addEventListener('click', () => {
      activeModels = [];
      updateModelLabel();
      rebuildModelDropdown(allModels, '__all__');
      dispatchFilter();
    });
    modelDropdown.appendChild(allOpt);

    allModels.forEach((m, i) => {
      const opt = document.createElement('div');
      opt.className = 'wv-model-option';
      opt.setAttribute('role', 'option');
      opt.setAttribute('tabindex', '-1');
      opt.id = `model-opt-${i}`;
      opt.setAttribute('aria-selected', String(activeModels.includes(m)));
      opt.dataset.model = m;
      const icon = document.createElement('i');
      icon.className = `codicon codicon-${activeModels.includes(m) ? 'check' : 'blank'}`;
      icon.setAttribute('aria-hidden', 'true');
      opt.appendChild(icon);
      const display = m.replace(/^(models\/|gpt-|claude-|gemini-)/, '');
      opt.append(` ${display.length > 30 ? `${display.slice(0, 29)}…` : display}`);
      opt.title = m; // full model id on hover — the visible label truncates
      opt.addEventListener('click', () => {
        if (activeModels.includes(m)) {
          activeModels = activeModels.filter((x) => x !== m);
        } else {
          activeModels = [...activeModels, m];
        }
        updateModelLabel();
        rebuildModelDropdown(allModels, m);
        dispatchFilter();
      });
      modelDropdown.appendChild(opt);
    });

    // Rebuilding wipes innerHTML, which drops keyboard focus to <body> and
    // breaks arrow-key navigation. Restore focus to the option for the same
    // model so the user can keep toggling with the keyboard.
    if (focusModel !== undefined) {
      for (const o of modelDropdown.querySelectorAll<HTMLElement>('[role="option"]')) {
        if (o.dataset.model === focusModel) { o.focus(); break; }
      }
    }
  }

  const surfaceChips = el.querySelector<HTMLElement>('#surface-chips')!;
  const sourceChipGroup = el.querySelector<HTMLElement>('#source-chip-group')!;
  const sourceChips = el.querySelector<HTMLElement>('#source-chips')!;

  const SOURCE_LABELS: Record<string, string> = { copilot: 'Copilot', 'claude-code': 'Claude Code' };

  function updateSurfaceUI() {
    surfaceChips.querySelectorAll<HTMLElement>('[data-surface]').forEach((c) => {
      const sv = c.dataset.surface;
      c.setAttribute(
        'aria-pressed',
        String(sv === '__all__' ? activeSurface === null : activeSurface === sv),
      );
    });
  }

  function updateSourceUI() {
    sourceChips.querySelectorAll<HTMLElement>('[data-source-group]').forEach((c) => {
      const grp = c.dataset.sourceGroup;
      let pressed: boolean;
      if (grp === '__all__') {
        pressed = activeSources.length === 0;
      } else if (grp === 'copilot') {
        pressed = activeSources.length > 0 && !activeSources.includes('claude-code');
      } else {
        pressed = activeSources.includes('claude-code') && activeSources.length === 1;
      }
      c.setAttribute('aria-pressed', String(pressed));
    });
  }

  updatePresetUI();

  return {
    update(s: UsageSnapshot, metric: Metric) {
      // Sync with externally-set filter state (a chart click, the sidebar's
      // model list, or the filter restored from the host on panel reopen).
      const f = state().filter;
      activeModels = f.models ?? [];
      activeSurface = f.surfaces?.[0] ?? null;
      activeRepos = f.repos ?? [];
      activeBranches = f.branches ?? [];
      activeSources = f.sources ?? [];
      activePreset = state().datePreset;
      updatePresetUI();
      updateMetricUI(metric);

      if (s.allRepos.length > 1) {
        repoSelect.hidden = false;
        const heuristic = s.byRepo
          .filter((r) => (r.heuristicShare ?? 0) > 0)
          .map((r) => r.key)
          .sort();
        const key = JSON.stringify([s.allRepos, heuristic]);
        if (key !== repoKey) {
          repoKey = key;
          const hadFocus = document.activeElement === repoSelect;
          rebuildRepoSelect(s.allRepos, new Set(heuristic));
          if (hadFocus) repoSelect.focus();
        } else {
          // Options unchanged — just reflect the active repo, keeping focus.
          repoSelect.value = activeRepos[0] ?? '__all__';
        }
      } else {
        repoSelect.hidden = true;
        activeRepos = [];
        repoKey = null;
      }

      if (s.allModels.length > 1) {
        modelFilterEl.hidden = false;
        if (JSON.stringify([s.allModels, activeModels]) !== modelsKey) {
          const focused = document.activeElement as HTMLElement | null;
          const focusModel = focused && modelDropdown.contains(focused) ? focused.dataset.model : undefined;
          rebuildModelDropdown(s.allModels, focusModel);
        }
      } else {
        modelFilterEl.hidden = true;
        activeModels = [];
        modelsKey = null;
      }
      updateModelLabel();

      if (s.allSurfaces.length > 1) {
        surfaceChips.hidden = false;
        const key = JSON.stringify(s.allSurfaces);
        if (key !== surfaceKey) {
          surfaceKey = key;
          surfaceChips.innerHTML = '';

          const allChip = document.createElement('button');
          allChip.className = 'wv-surface-chip';
          allChip.dataset.surface = '__all__';
          allChip.textContent = 'All';
          allChip.addEventListener('click', () => {
            activeSurface = null;
            updateSurfaceUI();
            dispatchFilter();
          });
          surfaceChips.appendChild(allChip);

          for (const surf of s.allSurfaces) {
            const chip = document.createElement('button');
            chip.className = 'wv-surface-chip';
            chip.dataset.surface = surf;
            chip.textContent = surf;
            chip.addEventListener('click', () => {
              activeSurface = activeSurface === surf ? null : surf;
              updateSurfaceUI();
              dispatchFilter();
            });
            surfaceChips.appendChild(chip);
          }
        }
        updateSurfaceUI();
      } else {
        surfaceChips.hidden = true;
        activeSurface = null;
        surfaceKey = null;
      }

      // The source group is always visible once at least one connector has
      // produced data, so it's always clear which connector Mallard is
      // ingesting from — not just when there happen to be several to
      // choose between.
      const hasCopilot = s.allSources.some((src) => COPILOT_SOURCES.includes(src));
      const hasClaudeCode = s.allSources.includes('claude-code');
      const nextSourceKey = hasCopilot && hasClaudeCode ? 'both' : hasCopilot ? 'copilot' : hasClaudeCode ? 'claude-code' : 'none';

      if (hasCopilot && hasClaudeCode) {
        sourceChipGroup.hidden = false;
        if (sourceKey !== nextSourceKey) {
          sourceChips.innerHTML = '';
          const sourceOptions: Array<{ group: string; label: string; sources: SourceKind[] }> = [
            { group: '__all__', label: 'All', sources: [] },
            { group: 'copilot', label: SOURCE_LABELS.copilot!, sources: COPILOT_SOURCES },
            { group: 'claude-code', label: SOURCE_LABELS['claude-code']!, sources: ['claude-code'] },
          ];
          for (const opt of sourceOptions) {
            const chip = document.createElement('button');
            chip.className = 'wv-source-chip';
            chip.dataset.sourceGroup = opt.group;
            chip.setAttribute('aria-pressed', 'false');
            chip.textContent = opt.label;
            chip.addEventListener('click', () => {
              activeSources = opt.sources;
              updateSourceUI();
              dispatchFilter();
            });
            sourceChips.appendChild(chip);
          }
        }
        updateSourceUI();
      } else if (hasCopilot || hasClaudeCode) {
        // Only one connector is producing data — show a single
        // informational chip naming it instead of hiding the row, so the
        // active connector is never a mystery.
        sourceChipGroup.hidden = false;
        activeSources = [];
        if (sourceKey !== nextSourceKey) {
          sourceChips.innerHTML = '';
          const chip = document.createElement('span');
          chip.className = 'wv-source-chip wv-source-chip--info';
          chip.textContent = hasCopilot ? SOURCE_LABELS.copilot! : SOURCE_LABELS['claude-code']!;
          sourceChips.appendChild(chip);
        }
      } else {
        sourceChipGroup.hidden = true;
        activeSources = [];
        if (sourceKey !== nextSourceKey) sourceChips.innerHTML = '';
      }
      sourceKey = nextSourceKey;
    },
  };
}

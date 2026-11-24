/**
 * Manages the dashboard's analysis grid: applies a persisted layout (panel
 * order, width span, size, visibility) and exposes two independent editing
 * modes:
 *   - "resize": drag handles on each panel's right/bottom/corner edge let
 *     the user resize width (span 1/2) and height (compact/normal/tall),
 *     snapping to the nearest existing preset as they drag.
 *   - "move": native HTML5 drag-and-drop lets the user reorder panels.
 * Only one mode is active at a time. Every change is sent back to the host
 * via onChange so it is stored permanently.
 */
import { DashboardLayout, MAX_PANEL_SPAN, PanelSize } from '../extension-backend/domain/types';

export type LayoutMode = 'none' | 'resize' | 'move';

export interface LayoutManager {
  apply(layout: DashboardLayout): void;
  setMode(mode: LayoutMode): void;
}

const SIZE_CYCLE: PanelSize[] = ['compact', 'normal', 'tall'];

/** Pointer travel (px) beyond which a press counts as a drag, not a tap. */
const CLICK_SLOP_PX = 4;

/** FLIP animation for a set of elements after DOM reorder. */
function flip(elements: HTMLElement[]): void {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const before = elements.map((el) => el.getBoundingClientRect());
  requestAnimationFrame(() => {
    elements.forEach((el, i) => {
      const after = el.getBoundingClientRect();
      const dx = (before[i]?.left ?? 0) - after.left;
      const dy = (before[i]?.top ?? 0) - after.top;
      if (dx === 0 && dy === 0) return;
      el.style.transform = `translate(${dx}px,${dy}px)`;
      el.style.transition = 'none';
      requestAnimationFrame(() => {
        el.style.transition = reduceMotion ? 'none' : 'transform 0.22s cubic-bezier(0.4,0,0.2,1)';
        el.style.transform = '';
      });
    });
  });
}

function cssPx(name: string, fallback: number, el: HTMLElement = document.documentElement): number {
  const raw = getComputedStyle(el).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Current dashboard column count (from --wv-cols), clamped to [1, MAX_PANEL_SPAN].
 * main.ts sets the property on the grid element itself, so read it there — the
 * document root never sees it and would always report the 2-column default.
 */
function columnCount(grid: HTMLElement): number {
  return Math.min(MAX_PANEL_SPAN, Math.max(1, Math.round(cssPx('--wv-cols', 2, grid))));
}

function clampSpan(span: number, cols: number): number {
  return Math.min(cols, Math.max(1, span));
}

export function mountLayout(
  grid: HTMLElement,
  panels: Record<string, HTMLElement>,
  onChange: (layout: DashboardLayout) => void,
): LayoutManager {
  let current: DashboardLayout = [];
  let mode: LayoutMode = 'none';
  let dragId: string | null = null;
  /** Per-panel controls whose ARIA state tracks the panel's span/size/hidden. */
  const controls: Record<string, { right: HTMLElement; bottom: HTMLElement; corner: HTMLElement; hide: HTMLElement }> = {};
  const headers: HTMLElement[] = [];

  const byId = (id: string) => current.find((p) => p.id === id);
  const emit = () => onChange(current.map((p) => ({ ...p })));

  function flash(el: HTMLElement): void {
    el.classList.add('wv-resizing');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('wv-resizing')));
  }

  function applyOne(id: string): void {
    const p = byId(id);
    const el = panels[id];
    if (!p || !el) return;
    el.dataset.span = String(p.span);
    el.dataset.size = p.size ?? 'normal';
    el.classList.toggle('wv-hidden-panel', p.hidden);
    syncAria(id);
  }

  /** Mirror the panel's span/size/hidden state onto its slider handles and hide button. */
  function syncAria(id: string): void {
    const p = byId(id);
    const c = controls[id];
    if (!p || !c) return;
    const cols = columnCount(grid);
    const sizeIdx = Math.max(0, SIZE_CYCLE.indexOf(p.size ?? 'normal'));
    const sizeName = SIZE_CYCLE[sizeIdx]!;
    const widthText = `${p.span} of ${cols} column${cols === 1 ? '' : 's'}`;

    const setRange = (h: HTMLElement, min: number, max: number, now: number, text: string) => {
      h.setAttribute('aria-valuemin', String(min));
      h.setAttribute('aria-valuemax', String(max));
      h.setAttribute('aria-valuenow', String(now));
      h.setAttribute('aria-valuetext', text);
    };
    setRange(c.right, 1, cols, p.span, widthText);
    setRange(c.bottom, 0, SIZE_CYCLE.length - 1, sizeIdx, `${sizeName} height`);
    // The corner drives both dimensions; a slider carries a single value, so
    // it reports the width and spells out both in the text.
    setRange(c.corner, 1, cols, p.span, `${widthText}, ${sizeName} height`);

    const name = panels[id]?.getAttribute('aria-label') ?? 'chart';
    const label = `${p.hidden ? 'Show' : 'Hide'} ${name}`;
    c.hide.setAttribute('aria-label', label);
    c.hide.title = label;
  }

  function setWidth(id: string, span: number): void {
    const p = byId(id);
    const el = panels[id];
    if (!p || !el) return;
    const clamped = clampSpan(span, columnCount(grid));
    if (p.span === clamped) return;
    p.span = clamped;
    applyOne(id);
    flash(el);
    emit();
  }

  function setSize(id: string, size: PanelSize): void {
    const p = byId(id);
    const el = panels[id];
    if (!p || !el || (p.size ?? 'normal') === size) return;
    p.size = size;
    applyOne(id);
    flash(el);
    emit();
  }

  function cycleWidth(id: string): void {
    const p = byId(id);
    if (!p) return;
    // Cycle 1 → 2 → … → columns → 1.
    setWidth(id, p.span >= columnCount(grid) ? 1 : p.span + 1);
  }

  function cycleSize(id: string, dir: 1 | -1): void {
    const p = byId(id);
    if (!p) return;
    const idx = SIZE_CYCLE.indexOf(p.size ?? 'normal');
    const next = SIZE_CYCLE[Math.min(SIZE_CYCLE.length - 1, Math.max(0, idx + dir))]!;
    setSize(id, next);
  }

  function toggleHidden(id: string): void {
    const p = byId(id);
    if (!p) return;
    p.hidden = !p.hidden;
    applyOne(id);
    emit();
  }

  function reorder(from: string, to: string): void {
    const fromIdx = current.findIndex((p) => p.id === from);
    const toIdx = current.findIndex((p) => p.id === to);
    if (fromIdx < 0 || toIdx < 0) return;
    const allEls = Object.values(panels);
    flip(allEls);
    const [moved] = current.splice(fromIdx, 1);
    current.splice(toIdx, 0, moved!);
    apply(current);
    emit();
  }

  /** Move a panel one slot up/down, hopping over hidden ones (keyboard reorder). */
  function moveBy(id: string, dir: -1 | 1): void {
    let j = current.findIndex((p) => p.id === id) + dir;
    while (j >= 0 && j < current.length && (current[j]!.hidden || !panels[current[j]!.id])) j += dir;
    const target = current[j];
    if (target) reorder(id, target.id);
  }

  /**
   * Wires a drag handle so pointer-dragging it resizes the panel, snapping
   * to the nearest existing preset as the pointer moves. `axis` selects
   * which dimension(s) the handle controls.
   */
  function attachResizeHandle(
    handle: HTMLElement,
    id: string,
    axis: 'x' | 'y' | 'both',
    onTap?: () => void,
  ): void {
    // The click the browser fires after a drag's pointerup must not also
    // count as a tap, or every drag would end by cycling the size/width again.
    let suppressClick = false;

    handle.addEventListener('pointerdown', (e: PointerEvent) => {
      if (mode !== 'resize') return;
      e.preventDefault();
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const el = panels[id]!;
      const startRect = el.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const startSpan = byId(id)?.span ?? 1;
      const oneColWidth = startRect.width / startSpan;
      const compactPx = cssPx('--wv-h-compact', 120);
      const normalPx = cssPx('--w-chart-main', 260);
      const tallPx = cssPx('--wv-h-tall', 455);
      let dragged = false;

      const onMove = (ev: PointerEvent) => {
        if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) > CLICK_SLOP_PX) dragged = true;
        if (axis === 'x' || axis === 'both') {
          const desiredWidth = startRect.width + (ev.clientX - startX);
          // Snap to the nearest whole column count, clamped to the grid width.
          setWidth(id, Math.round(desiredWidth / oneColWidth));
        }
        if (axis === 'y' || axis === 'both') {
          const desiredHeight = startRect.height + (ev.clientY - startY);
          const dists: Array<[PanelSize, number]> = [
            ['compact', Math.abs(desiredHeight - compactPx)],
            ['normal', Math.abs(desiredHeight - normalPx)],
            ['tall', Math.abs(desiredHeight - tallPx)],
          ];
          dists.sort((a, b) => a[1] - b[1]);
          setSize(id, dists[0]![0]);
        }
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        if (dragged) {
          suppressClick = true;
          // A drag that ends off the handle gets no click; don't let the flag
          // linger and swallow the next genuine tap.
          setTimeout(() => { suppressClick = false; }, 100);
        }
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });

    // Click-to-cycle doubles as a quick alternative to dragging (a tap
    // without meaningful pointer movement just cycles).
    handle.addEventListener('click', () => {
      if (mode !== 'resize') return;
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      onTap?.();
    });

    // Keyboard equivalent, since dragging alone isn't accessible.
    handle.addEventListener('keydown', (e: KeyboardEvent) => {
      if (mode !== 'resize') return;
      if ((axis === 'x' || axis === 'both') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        // Step width by one column, within [1, columns].
        const p = byId(id);
        if (p) setWidth(id, p.span + (e.key === 'ArrowRight' ? 1 : -1));
      } else if ((axis === 'y' || axis === 'both') && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        cycleSize(id, e.key === 'ArrowDown' ? 1 : -1);
      }
    });
  }

  for (const [id, el] of Object.entries(panels)) {
    el.dataset.panel = id;

    const tools = document.createElement('div');
    tools.className = 'wv-panel-tools';
    tools.innerHTML = `
      <span class="wv-panel-handle" title="Drag to reorder" aria-hidden="true"><i class="codicon codicon-gripper"></i></span>
      <button class="wv-panel-btn" data-act="hide" title="Hide or show" aria-label="Hide or show chart"><i class="codicon codicon-eye" aria-hidden="true"></i></button>`;
    el.prepend(tools);
    const hideBtn = tools.querySelector<HTMLElement>('[data-act="hide"]')!;
    hideBtn.addEventListener('click', () => toggleHidden(id));

    const handleRight = document.createElement('div');
    handleRight.className = 'wv-resize-handle wv-resize-handle--right';
    handleRight.tabIndex = 0;
    handleRight.setAttribute('role', 'slider');
    handleRight.setAttribute('aria-label', 'Resize panel width');
    handleRight.title = 'Drag to resize width (or use ← →)';
    attachResizeHandle(handleRight, id, 'x', () => cycleWidth(id));

    const handleBottom = document.createElement('div');
    handleBottom.className = 'wv-resize-handle wv-resize-handle--bottom';
    handleBottom.tabIndex = 0;
    handleBottom.setAttribute('role', 'slider');
    handleBottom.setAttribute('aria-label', 'Resize panel height');
    handleBottom.title = 'Drag to resize height (or use ↑ ↓)';
    attachResizeHandle(handleBottom, id, 'y', () => cycleSize(id, 1));

    const handleCorner = document.createElement('div');
    handleCorner.className = 'wv-resize-handle wv-resize-handle--corner';
    handleCorner.tabIndex = 0;
    handleCorner.setAttribute('role', 'slider');
    handleCorner.setAttribute('aria-label', 'Resize panel width and height');
    handleCorner.title = 'Drag to resize (or use arrow keys)';
    attachResizeHandle(handleCorner, id, 'both');

    el.append(handleRight, handleBottom, handleCorner);
    controls[id] = { right: handleRight, bottom: handleBottom, corner: handleCorner, hide: hideBtn };

    // Keyboard reorder: with the header focused (Move mode), Alt+ArrowUp/Down
    // moves the panel one visible slot — the keyboard equivalent of dragging.
    const header = el.querySelector<HTMLElement>('.wv-chart-header');
    if (header) {
      headers.push(header);
      header.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
      header.addEventListener('keydown', (e: KeyboardEvent) => {
        if (mode !== 'move' || !e.altKey) return;
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        moveBy(id, e.key === 'ArrowUp' ? -1 : 1);
        // Reordering re-appends the panel, which drops focus; put it back.
        header.focus();
      });
    }

    el.addEventListener('dragstart', (e) => {
      if (mode !== 'move') return;
      dragId = id;
      e.dataTransfer?.setData('text/plain', id);
      el.classList.add('wv-dragging');
    });
    el.addEventListener('dragend', () => {
      dragId = null;
      el.classList.remove('wv-dragging');
      for (const p of Object.values(panels)) p.classList.remove('wv-drop-target');
    });
    el.addEventListener('dragenter', () => {
      if (mode === 'move' && dragId && dragId !== id) el.classList.add('wv-drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget as Node | null)) el.classList.remove('wv-drop-target');
    });
    el.addEventListener('dragover', (e) => {
      if (mode === 'move' && dragId && dragId !== id) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('wv-drop-target');
      if (mode !== 'move' || !dragId || dragId === id) return;
      e.preventDefault();
      reorder(dragId, id);
    });
  }

  function apply(layout: DashboardLayout): void {
    current = layout.map((p) => ({ ...p }));
    const ordered = current.flatMap((p) => (panels[p.id] ? [panels[p.id]!] : []));
    // Every host layout echo lands here. Re-appending panels that are already
    // in order still detaches and reinserts them, which blurs whichever
    // control the user is focused on (e.g. a resize handle mid-keyboard-resize)
    // — so only touch the DOM when the order actually differs.
    const inGrid = [...grid.children].filter((c) => ordered.includes(c as HTMLElement));
    const inOrder = inGrid.length === ordered.length && inGrid.every((c, i) => c === ordered[i]);
    if (!inOrder) for (const el of ordered) grid.appendChild(el);
    for (const p of current) applyOne(p.id);
  }

  function setMode(next: LayoutMode): void {
    mode = next;
    grid.classList.toggle('wv-editing', mode !== 'none');
    grid.dataset.layoutMode = mode;
    for (const el of Object.values(panels)) el.draggable = mode === 'move';
    // Headers take focus only while moving, so they add no tab stops otherwise.
    for (const h of headers) {
      if (mode === 'move') h.tabIndex = 0;
      else h.removeAttribute('tabindex');
    }
  }

  return { apply, setMode };
}

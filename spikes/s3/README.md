# Spike S3: gridstack viability (Phase 0)

Throwaway spike for the Mallard overhaul plan (Stream D). Evaluated **gridstack 14.1.1** (latest 14.x on npm, MIT,
zero dependencies) with **echarts 6.1.0** (the repo's lockfile version), esbuild 0.28.1, jsdom 29.1.1, typescript 6.0.3,
tsx 4.22.4, c8 12.0.0 (all matching the repo), Chromium 158 via Playwright 1.63.

Nothing here touches `src/`, `test/`, or the repo's `package.json`. It has its own `package.json` (npm).

## Run it

```sh
cd spikes/s3
npm install
npm run spike        # builds the demo + size bundles, drives Chromium: 96 PASS / 0 FAIL / 33 INFO -> results.json
npm run test:unit    # keyboard layer + REAL gridstack adapter under the repo's jsdom setup (16 tests)
npm run coverage     # c8 over those tests (adapter = 100% lines/funcs)
npm run jsdom        # section 6 probe: what works / throws in jsdom
npm run typecheck    # tsc --strict
npm run serve        # http://127.0.0.1:4173/?edit=1  (the demo, with the repo's exact CSP + a per-request nonce)
```

Demo query flags: `edit=1`, `stock=1` (plain gridstack), `kb=0`, `charts=0`, `cols=12`, `animate=0`, `nomove=1`
(delete `Element.prototype.moveBefore`), `csp=strict` (drop `'unsafe-inline'`), `containItem=1`, `containGrid=1`,
`initial=each`. `node run-spike.mjs --only=1,2,...` runs single sections.

## Files

| File | Purpose |
|---|---|
| `src/gridEngine.ts` | `GridEngine` interface + pure `sanitizeRects` (no gridstack import; jsdom-testable) |
| `src/gridstackEngine.ts` | the only file that imports gridstack (the adapter) |
| `src/fakeEngine.ts` | in-memory `GridEngine` for unit tests |
| `src/keyboard.ts` | keyboard layer over `GridEngine.update()` (Alt+Arrow move, Arrow on sliders resize, aria-live, focus restore) |
| `src/constants.ts` | proposed `COLUMNS/CELL_HEIGHT/MARGIN/TIER_ROWS` + derivation |
| `src/demo.ts`, `src/demo.css`, `demo/index.html` | the demo page: 6 ECharts canvas panels in a 4-col grid |
| `serve.mjs` | static server injecting the extension's exact CSP (`'self'` standing in for `cspSource`) with a fresh nonce |
| `run-spike.mjs` | the Playwright runner (sections 1-5, 7, 8) |
| `jsdom-probe.ts`, `test/*.test.ts` | section 6 |
| `build.mjs`, `size/` | section 5 size measurement (same esbuild settings as the repo's webview build) |
| `evidence/*.png`, `results.json` | screenshots + every check's PASS/FAIL/INFO with evidence |

## Findings (details and evidence are in `results.json`)

### 1. Keyboard: gridstack has none, the layer over `grid.update()` works. FAIL out of the box, PASS with our layer
- Stock DOM: `.grid-stack-item[gs-x gs-y gs-w gs-h gs-id]` > `.grid-stack-item-content` + `.ui-resizable-handle.ui-resizable-se`
  divs. No `tabindex`, no `role`, no `aria-*` anywhere in gridstack's source; Tab reaches nothing; no key moves/resizes
  (the only key it handles is Esc/R *during* a mouse drag). Docs have no accessibility section.
- DnD is a custom **mouse** engine (+ touch emulated as mouse after a 300 ms long press), not HTML5 DnD, not pointer events.
- `grid.move()` / `grid.resize()` **do not exist in 14.1.1**; `grid.update(el, {x,y,w,h})` is the only mover.
- Our layer (`src/keyboard.ts`) is event-delegated on the grid: Alt+Arrow on anything in a panel header moves; plain Arrow on
  `role=slider[data-axis=w|h]` resizes (w: +-1 column, h: next/previous tier); `aria-live="polite"` announces the **resulting**
  rect ("Models moved to column 3, row 1."); `aria-valuenow/valuetext` follow. Verified with real Playwright key events.
- Vertical moves need our own logic: with `mode:'top'`, `update(el,{y:y+1})` is a no-op (gravity undoes it) because gridstack only
  swaps on >50% pointer coverage. `nextMove()` jumps to just past the nearest panel above/below.
- **Focus**: gridstack's `_sortDom()` re-orders DOM children after every change so DOM (= Tab) order always equals visual
  row-major order (good for a11y; verified). It uses `moveBefore` when present (Chromium >= 133 = VS Code >= 1.101's Electron 35),
  which preserves focus. Without `moveBefore` (VS Code ^1.95) a bare `grid.update()` **drops focus to `<body>`** (measured);
  `restoreFocus()` fixes it and is tested both ways.
- Own sliders, not gridstack's handles: gridstack destroys and re-creates its `.ui-resizable-handle` nodes on every `setStatic`
  toggle, so ARIA/tabindex on them would not stick. Pointer users use gridstack's SE/E/S handles; keyboard users use ours.
- Announce an ordinal row band, not raw rows (rows are 24 px units, "row 27" is meaningless). `rowBand()` does this.
- Horizontal moves into an occupied slot **push the occupant down** (no swap). Consider announcing displaced panels or doing an
  explicit two-panel swap in the layer.
- Alt+Arrow caveat (not verifiable here): VS Code binds Alt+Left/Right to navigate back/forward on Windows/Linux and webviews
  forward keydowns to the workbench. Pre-existing with today's layer; a "lift mode" (Space/Enter on the grip, plain arrows move,
  Space drops, Esc cancels) avoids it and is the common sortable-list pattern.

### 2. CSP: PASS, nothing beyond what is already allowed
Exact repo CSP (`style-src 'self' 'unsafe-inline'`, nonce'd script): **0 violations** across init, drag, SE-handle resize,
keyboard moves, hide/show, ECharts tooltip hover, breakpoint switch. Under a **strict** `style-src 'self'` (no `unsafe-inline`)
gridstack alone still has **0 violations** and drag/resize still work: v14 sizes everything via CSS custom properties set through
the CSSOM (`el.style.setProperty('--gs-x', ...)`), injects no `<style>`, uses no eval/`new Function`/`setAttribute('style')`
(the old injected sheet and its `nonce` option are gone). The only strict-mode violations (`style-src-attr`, 26) come from
**ECharts' DOM tooltip** `style=""` attributes on hover, none at chart init: that is what `'unsafe-inline'` is already for.

### 3. ECharts in widgets: PASS
Canvas fills the body (`canvas == body - padding`, +-1 px) at init, after `grid.update(w,h)`, after a mouse resize, after shrink,
after hide/re-show. `ResizeObserver -> rAF -> chart.resize()` is enough. Dragging by the header keeps the same canvas node and
chart instance, and hover/tooltip/click still work afterwards; dragging inside a chart body does not move the panel (handle is
the header, `cancel: '.wv-panel-tools'` protects the header buttons). **Cost**: with `animate:true` one width/height change
triggers ~19 `chart.resize()` calls (one per frame of the 0.3 s transition) vs 1 with `animate:false`.

### 4. Layout semantics
- `float:false` is gone in 14: it is **`mode:'top'`** (default; `'float'`, `'list'`, `'compact'` also exist). Gravity verified.
- 4 columns and 12 columns both work with the stock CSS (CSS custom properties; no `gridstack-extra.css`).
- Breakpoint: `columnOpts:{breakpoints:[{w:700,c:1}], breakpointForWindow:true, columnMax:4, layout:'moveScale'}` switches to 1 column at
  `innerWidth <= 700` and back at 701 (same boundary as the media query). Column switches fire **no `change`** event; observe the
  `resizecontent` event and compare `getColumn()`.
- **`grid.save()` in the 1-column state returns the cached WIDE coordinates** (it deliberately returns the highest cached layout).
  But **editing while 1-column corrupts that cache** (overlaps/gaps measured) and `columnOpts.layout:'list'` rewrote the layout on a
  4 -> 1 -> 4 round trip; **`'moveScale'` restores it exactly**. Recommended pattern, all implemented in the demo: set static +
  disable Edit when `getColumn() !== wide`; persist only when `getColumn() === wide && !isIgnoreChangeCB()`; debounce `change` 250 ms.
- `change` fires once per drag/resize (after `dragstop`/`resizestop`), also for programmatic `update()`; `load()` does not echo.
- **Pitfalls found** (all handled in the adapter): (1) `grid.save()` omits `w`/`h` when equal to 1 or `minW`/`minH`, so a naive
  `n.h ?? 1` turns a 7-row panel into 1 row; (2) raw `grid.load()` with default `addRemove=true` creates empty widgets for unknown ids
  and removes panels missing from the list; (3) raw `load()` of an oversize rect clamps the live node but `save()` keeps returning
  the unclamped cached layout, so `sanitizeRects()` runs first; (4) per-item `register()` into an already-narrow grid scrambles the
  1-column reading order, `registerAll()` (through `load()` + `addRemoveCB` handing back the existing nodes) does not;
  (5) `removeWidget(el,false)` leaves the node in the DOM (`getGridItems()` still lists it, still absolutely positioned) so hide it.
- `removeWidget(el,false)` + `makeWidget(el)`: DOM node, canvas and ECharts instance survive; remaining panels re-compact with no
  gaps/overlaps; re-adding into an occupied rect pushes occupants down; the chart is correctly sized again after re-show.
- `setStatic(true|false)` toggles drag/resize (handles removed/re-created); programmatic `update()` still works while static.
- **Tier -> rows**: `CELL_HEIGHT=24`, `MARGIN=6` (12 px gap = today's grid gap), `TIER_ROWS = {compact: 7, normal: 13, tall: 21}`,
  `minH = 7`. Measured chart bodies 115 / 259 / 451 px vs today's 120 / 260 / 455. Formula in `src/constants.ts`.

### 5. Size
Minified, iife, es2022 (repo webview settings): **gridstack JS +98,011 B (27.7 KB gzip), CSS +6,068 B (1.4 KB gzip)**; ~14% on the
~700 KB bundle (the ECharts-only entry in this spike is 575 KB). DD is always included in 14.x (no static-only build).

### 6. jsdom: `GridStack.init` runs; one 3-line stub needed; no exclusion needed for the adapter
Under the repo's `test/unit/setup/jsdom.cjs` (jsdom 29.1.1) gridstack imports (via `tsx/cjs`) and runs `init`, `makeWidget`, `update`,
`save`, `load`, `removeWidget`, `setStatic`, events, even breakpoint switching (set `window.innerWidth`, call `grid.onResize(w, h)`).
**Breaks**: `ResizeObserver is not defined` as soon as `columnOpts`/auto cell height is used (stub: `class { observe(){} unobserve(){} disconnect(){} }`);
layout measurement is all zeros so pointer drag/resize is inert (not testable, and it is third-party code in node_modules anyway).
The setup also lacks `MouseEvent`/`KeyboardEvent` globals (use `window.KeyboardEvent`). **Test plan**: unit tests use `FakeEngine`
(keyboard layer, persistence gating, migrator, `sanitizeRects`); the real adapter is covered under jsdom with the stub:
`gridstackEngine.ts` reaches **100% lines/statements/functions, 85% branches** (`npm run coverage`), so **no `.c8rc.json` exclusion
is required**. Keep one Playwright smoke test for the pointer path (this spike's `run-spike.mjs` is the seed).

### 7. Motion and contrast: needs our overrides
`animate` defaults to true (`.grid-stack-animate`, 0.3 s `left/right/top/height/width`); `animate:false` removes it. gridstack never
consults `prefers-reduced-motion` (JS or CSS), so ship `@media (prefers-reduced-motion: reduce){ .grid-stack-animate, .grid-stack-animate .grid-stack-item {transition:none !important} .grid-stack-item.ui-draggable-armed, ... {animation:none !important} }`
(the touch "armed" wiggle/pulse keyframes also ignore it). Hard-coded colours in `gridstack.css`: placeholder `rgba(0,0,0,.1)` (invisible on dark
themes), resize-handle SVG stroke `#666`, drag shadow `rgba(0,0,0,.2)`; none use `--vscode-*`. `demo.css` overrides them with
tokens and a `forced-colors` block (screenshot: `evidence/forced-colors.png`).

### 8. Other
MIT, zero dependencies. No leak on destroy: 60 init/load/setStatic/destroy cycles leave 0 retained instances after GC, every
`ResizeObserver` disconnected, no document/window listener left. Touch works after a 300 ms long press. `contain: layout paint` on
`.wv-chart-section` (child of the item) is fine; on the item it is fine; **on an ancestor of the items (e.g. `.grid-stack`) the dragged
helper is clipped at that ancestor's box**. gridstack probes the fixed containing block so cursor tracking is unaffected.

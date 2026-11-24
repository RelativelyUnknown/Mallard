import { deriveAccent, ensureContrast, parseColor, readableForeground, toHex } from './color';
import type { PaletteMode } from '../extension-backend/domain/types';
import type { ThemeKind } from '../extension-backend/ui/messaging';

function cssVar(name: string, fallback = ''): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Read a dashboard token (`--w-*`) rather than the raw `--vscode-*` variable
 * behind it. theme.css maps the former onto the latter, and the forced
 * light/dark scheme overrides the former only — so reading `--vscode-*` here
 * would recolour the page but leave chart axes and tooltips on the editor theme.
 * The `--vscode-*` name is only a fallback for when the stylesheet isn't loaded.
 */
function themeVar(token: string, vscodeVar: string, fallback: string): string {
  return cssVar(token) || cssVar(vscodeVar, fallback);
}

type ForcedScheme = 'light' | 'dark';

function forcedScheme(): ForcedScheme | null {
  const forced = document.documentElement.getAttribute('data-force-scheme');
  return forced === 'light' || forced === 'dark' ? forced : null;
}

let lastPalette: PaletteMode = 'swiss';
let lastKind: ThemeKind = 'dark';

/**
 * Resolve the dashboard accent for the active palette mode and theme, set it on
 * the document root, and run it through the accessibility checks — for BOTH
 * modes, not just the theme-derived one:
 * - `swiss`: the fixed Swiss red, nudged for contrast if an unusual editor
 *   theme would make it illegible against the surface.
 * - `theme`: derived from the VS Code accent (button / link), with contrast +
 *   colour-blindness validation (see webview/color.ts).
 * Everything keyed off --w-accent (series, severity, brand) follows.
 */
export function applyPalette(palette: PaletteMode, kind: ThemeKind): void {
  const root = document.documentElement;
  lastPalette = palette;
  lastKind = kind;
  // A forced scheme overrides the surface colours, so contrast must be judged
  // against the background actually on screen (--w-bg), and the base red must
  // follow the forced scheme rather than the editor's theme kind.
  const effectiveKind: ThemeKind = forcedScheme() ?? kind;
  const bgStr = themeVar('--w-bg', '--vscode-editor-background', '#1e1e1e');
  const bg = parseColor(bgStr) ?? { r: 30, g: 30, b: 30 };
  const light = effectiveKind === 'light' || effectiveKind === 'high-contrast-light';
  const baseRed = light ? '#e5231b' : '#ff453a';

  let accent: string;
  if (palette === 'theme') {
    const seed =
      cssVar('--vscode-button-background') || cssVar('--vscode-textLink-foreground') || baseRed;
    accent = deriveAccent(seed, bgStr, baseRed);
  } else {
    accent = toHex(ensureContrast(parseColor(baseRed)!, bg, 3));
  }
  root.style.setProperty('--w-accent', accent);

  // Derive the accent foreground from the accent's own luminance so text/icons
  // on primary buttons and pressed chips stay legible even when the editor
  // theme yields a light/pastel accent — --w-accent-fg was hardcoded white,
  // which vanished on a light accent. --w-action-fg / --w-brand-fg follow it.
  const accentRgb = parseColor(accent);
  if (accentRgb) root.style.setProperty('--w-accent-fg', readableForeground(accentRgb));
}

/**
 * Force the dashboard light or dark (null releases it back to the editor
 * theme). The accent is written inline by applyPalette, and an inline custom
 * property beats the scheme's own stylesheet rule — so toggling the scheme
 * must re-derive the accent for the new background instead of leaving the
 * previous scheme's value in place.
 */
export function setForcedScheme(scheme: ForcedScheme | null): void {
  const root = document.documentElement;
  root.removeAttribute('data-force-scheme');
  if (scheme) root.setAttribute('data-force-scheme', scheme);
  applyPalette(lastPalette, lastKind);
}

export interface MallardTheme {
  bg: string;
  card: string;
  fg: string;
  muted: string;
  border: string;
  series: string[];
  accent: string;
  sevOk: string;
  sevWarn: string;
  sevOver: string;
  tooltipBg: string;
  tooltipFg: string;
  labelFont: string;
  highContrast: boolean;
}

/** Read the analogous series ramp, resolving the --w-series-* var chain to
 *  concrete colours. getComputedStyle resolves color-mix()/var() for us. */
function seriesColors(): string[] {
  const fallback = ['#ff453a', '#fb8460', '#f8b181', '#f7d2a1', '#f8e9bf', '#faf7db'];
  return fallback.map((fb, i) => cssVar(`--w-series-${i + 1}`, fb));
}

export function readTheme(): MallardTheme {
  const body = document.body.classList;
  return {
    bg: themeVar('--w-bg', '--vscode-editor-background', '#1e1e1e'),
    card: themeVar('--w-bg-card', '--vscode-sideBar-background', '#252526'),
    fg: themeVar('--w-fg', '--vscode-editor-foreground', '#cccccc'),
    muted: themeVar('--w-fg-muted', '--vscode-descriptionForeground', '#858585'),
    border: themeVar('--w-border', '--vscode-panel-border', '#3c3c3c'),
    tooltipBg: themeVar('--w-tooltip-bg', '--vscode-editorHoverWidget-background', '#2d2d2d'),
    tooltipFg: themeVar('--w-tooltip-fg', '--vscode-editorHoverWidget-foreground', '#cccccc'),
    // IBM Plex Mono technical labels (bundled); falls back to the editor mono.
    labelFont: cssVar('--w-label-font', "'IBM Plex Mono', monospace"),
    // Analogous ramp: red accent first, then red-toward-amber steps that
    // vary lightness/chroma rather than hue family (colour-blind safe —
    // never relies on red-vs-green discrimination).
    series: seriesColors(),
    accent: cssVar('--w-accent', '#ff453a'),
    sevOk: cssVar('--w-sev-ok', '#9e9e9e'),
    sevWarn: cssVar('--w-sev-warn', '#ff8a80'),
    sevOver: cssVar('--w-sev-over', '#ff453a'),
    highContrast:
      body.contains('vscode-high-contrast') || body.contains('vscode-high-contrast-light'),
  };
}

export function buildEChartsTheme(t: MallardTheme): Record<string, any> {
  const axisLabel = { color: t.muted, fontFamily: t.labelFont, fontSize: 11 };
  return {
    backgroundColor: 'transparent',
    textStyle: { color: t.fg, fontFamily: t.labelFont, fontSize: 12 },
    title: { textStyle: { color: t.fg }, subtextStyle: { color: t.muted } },
    legend: { textStyle: { color: t.fg, fontFamily: t.labelFont } },
    tooltip: {
      backgroundColor: t.tooltipBg,
      borderColor: t.border,
      textStyle: { color: t.tooltipFg, fontSize: 12 },
    },
    color: t.series,
    categoryAxis: {
      axisLine: { lineStyle: { color: t.border } },
      axisTick: { lineStyle: { color: t.border } },
      axisLabel,
      splitLine: { show: false },
    },
    valueAxis: {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel,
      splitLine: { lineStyle: { color: t.border, type: 'dashed' } },
    },
  };
}

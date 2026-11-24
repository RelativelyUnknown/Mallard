import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { applyPalette, buildEChartsTheme, readTheme, setForcedScheme } from '../../../src/extension-frontend/theme';
import { contrastRatio, parseColor } from '../../../src/extension-frontend/color';

const root = document.documentElement;

const TOKENS = [
  '--w-bg', '--w-bg-card', '--w-fg', '--w-fg-muted', '--w-border', '--w-tooltip-bg', '--w-tooltip-fg',
  '--vscode-editor-background', '--vscode-sideBar-background', '--vscode-editor-foreground',
  '--vscode-descriptionForeground', '--vscode-panel-border', '--vscode-editorHoverWidget-background',
  '--vscode-editorHoverWidget-foreground', '--vscode-button-background', '--w-accent', '--w-accent-fg',
];

function clean(): void {
  for (const t of TOKENS) root.style.removeProperty(t);
  root.removeAttribute('data-force-scheme');
}

function set(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
}

const accent = (): string => root.style.getPropertyValue('--w-accent');

describe('readTheme reads the dashboard tokens, not the raw VS Code variables', () => {
  beforeEach(clean);
  afterEach(clean);

  it('prefers --w-* over --vscode-* for every colour (so a forced scheme reaches chart axes and tooltips)', () => {
    set({
      '--vscode-editor-background': '#000001', '--vscode-sideBar-background': '#000002',
      '--vscode-editor-foreground': '#000003', '--vscode-descriptionForeground': '#000004',
      '--vscode-panel-border': '#000005', '--vscode-editorHoverWidget-background': '#000006',
      '--vscode-editorHoverWidget-foreground': '#000007',
      '--w-bg': '#ffffff', '--w-bg-card': '#f5f5f5', '--w-fg': '#1a1a1a', '--w-fg-muted': '#555555',
      '--w-border': '#e0e0e0', '--w-tooltip-bg': '#1a1a1a', '--w-tooltip-fg': '#fafafa',
    });
    const t = readTheme();
    assert.equal(t.bg, '#ffffff');
    assert.equal(t.card, '#f5f5f5');
    assert.equal(t.fg, '#1a1a1a');
    assert.equal(t.muted, '#555555');
    assert.equal(t.border, '#e0e0e0');
    assert.equal(t.tooltipBg, '#1a1a1a');
    assert.equal(t.tooltipFg, '#fafafa');
  });

  it('falls back to the --vscode-* variables when the dashboard tokens are not defined', () => {
    set({ '--vscode-editor-background': '#101010', '--vscode-panel-border': '#202020' });
    const t = readTheme();
    assert.equal(t.bg, '#101010');
    assert.equal(t.border, '#202020');
  });

  it('the ECharts theme paints tooltip text with the tooltip foreground (readable on the inverted forced-scheme tooltip)', () => {
    set({ '--w-fg': '#1a1a1a', '--w-tooltip-bg': '#1a1a1a', '--w-tooltip-fg': '#ffffff' });
    const theme = buildEChartsTheme(readTheme());
    assert.equal(theme.tooltip.backgroundColor, '#1a1a1a');
    assert.equal(theme.tooltip.textStyle.color, '#ffffff', 'not --w-fg, which equals the tooltip background here');
  });
});

describe('palette derivation follows the effective (forced) scheme', () => {
  beforeEach(clean);
  afterEach(clean);

  it('judges accent contrast against the background actually on screen (--w-bg), not the editor theme', () => {
    // The editor is dark, but the forced scheme paints a pale-red surface:
    // the stock dark red would be illegible on it and must be nudged.
    set({ '--vscode-editor-background': '#000000', '--w-bg': '#ffd0cc' });
    applyPalette('swiss', 'dark');
    const bg = parseColor('#ffd0cc')!;
    assert.notEqual(accent().toLowerCase(), '#ff453a');
    assert.ok(contrastRatio(parseColor(accent())!, bg) >= 3, `accent ${accent()} must contrast with the surface`);
  });

  it('toggling the forced scheme re-derives the accent instead of leaving the previous scheme\'s inline value', () => {
    set({ '--w-bg': '#1e1e1e' });
    applyPalette('swiss', 'dark');
    assert.equal(accent().toLowerCase(), '#ff453a', 'dark base red on a dark surface');

    // The forced light scheme's own stylesheet rule would set --w-bg to white;
    // there is no stylesheet under test, so mirror it inline.
    set({ '--w-bg': '#ffffff' });
    setForcedScheme('light');

    assert.equal(root.getAttribute('data-force-scheme'), 'light');
    assert.equal(accent().toLowerCase(), '#e5231b', 'light base red now (the inline accent did not stick)');
    assert.ok(contrastRatio(parseColor(accent())!, parseColor('#ffffff')!) >= 3);

    set({ '--w-bg': '#1e1e1e' });
    setForcedScheme('dark');
    assert.equal(root.getAttribute('data-force-scheme'), 'dark');
    assert.equal(accent().toLowerCase(), '#ff453a');
  });

  it('the forced scheme beats the editor theme kind when picking the base red', () => {
    set({ '--w-bg': '#ffffff' });
    root.setAttribute('data-force-scheme', 'light');
    applyPalette('swiss', 'dark'); // editor says dark, user forced light
    assert.equal(accent().toLowerCase(), '#e5231b');
  });

  it('re-derivation reuses the last palette mode: a theme-derived accent is recomputed, not reset to the Swiss red', () => {
    set({ '--vscode-button-background': '#0078d4', '--w-bg': '#1e1e1e' });
    applyPalette('theme', 'dark');
    const darkAccent = accent();
    assert.notEqual(darkAccent.toLowerCase(), '#ff453a', 'blue-derived');

    set({ '--w-bg': '#ffffff' });
    setForcedScheme('light');
    const lightAccent = accent();
    assert.notEqual(lightAccent.toLowerCase(), '#e5231b', 'still the theme palette');
    assert.ok(contrastRatio(parseColor(lightAccent)!, parseColor('#ffffff')!) >= 3);
  });

  it('releasing the forced scheme (null) removes the attribute', () => {
    setForcedScheme('dark');
    setForcedScheme(null);
    assert.equal(root.hasAttribute('data-force-scheme'), false);
  });
});

describe('theme.css', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '../../../src/extension-frontend/styles/theme.css'),
    'utf8',
  );

  it('no custom property is defined in terms of itself (a self-reference is invalid at computed-value time)', () => {
    const selfReferential: string[] = [];
    for (const m of css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const [, name, value] = m;
      const compact = value!.replace(/\s+/g, '');
      if (compact.includes(`var(${name})`) || compact.includes(`var(${name},`)) selfReferential.push(name!);
    }
    assert.deepEqual(selfReferential, []);
  });

  it('defines the tooltip surface tokens readTheme reads', () => {
    assert.match(css, /:root\s*\{[^}]*--w-tooltip-bg:/s);
    assert.match(css, /:root\s*\{[^}]*--w-tooltip-fg:/s);
  });

  it('the high-contrast border falls back to the panel border rather than to itself', () => {
    const hc = css.match(/body\.vscode-high-contrast,\s*body\.vscode-high-contrast-light\s*\{([^}]*)\}/)![1]!;
    assert.match(hc, /--w-border:\s*var\(--vscode-contrastBorder,\s*var\(--vscode-panel-border/);
  });
});

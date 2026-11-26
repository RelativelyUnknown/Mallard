// S3 spike build: demo bundle (readable) + size-measurement bundles (minified, like esbuild.mjs's webview config).
import esbuild from 'esbuild';
import { mkdirSync, copyFileSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync } from 'node:zlib';

mkdirSync('dist', { recursive: true });
mkdirSync('dist-size', { recursive: true });

// Same shape as webviewConfig in the repo's esbuild.mjs.
const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
  loader: { '.css': 'css', '.ttf': 'file', '.woff': 'file', '.woff2': 'file' },
};

await esbuild.build({ ...common, entryPoints: ['src/demo.ts'], outfile: 'dist/demo.js', sourcemap: false, minify: false });
copyFileSync('demo/index.html', 'dist/index.html');

// ── size measurement ──────────────────────────────────────────────────────────
mkdirSync('size', { recursive: true });
writeFileSync('size/entry-gridstack.ts', "import { GridStack } from 'gridstack';\nimport 'gridstack/dist/gridstack.css';\n(window as any).GridStack = GridStack;\n");
writeFileSync('size/entry-empty.ts', "(window as any).x = 1;\n");
writeFileSync('size/entry-echarts.ts', [
  "import * as echarts from 'echarts/core';",
  "import { BarChart, LineChart, PieChart } from 'echarts/charts';",
  "import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components';",
  "import { CanvasRenderer } from 'echarts/renderers';",
  "echarts.use([BarChart, LineChart, PieChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]);",
  "(window as any).echarts = echarts;",
].join('\n') + '\n');

const rows = [];
for (const name of ['empty', 'gridstack', 'echarts']) {
  await esbuild.build({ ...common, entryPoints: [`size/entry-${name}.ts`], outfile: `dist-size/${name}.js`, minify: true, sourcemap: false });
  const js = readFileSync(`dist-size/${name}.js`);
  let css = null;
  try { css = readFileSync(`dist-size/${name}.css`); } catch { /* no css for this entry */ }
  rows.push({
    entry: name,
    js: js.length, jsGzip: gzipSync(js).length, jsBrotli: brotliCompressSync(js).length,
    css: css?.length ?? 0, cssGzip: css ? gzipSync(css).length : 0,
  });
}
writeFileSync('size/result.json', JSON.stringify(rows, null, 2));
console.table(rows);

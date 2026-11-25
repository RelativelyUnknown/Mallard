'use strict';
// S1 item 6: does esbuild (platform node) leave node:sqlite external WITHOUT it being listed in `external`,
// and does the bundled try/catch loader degrade gracefully on runtimes that lack the module?
// Usage: node 06-esbuild.cjs [dir-with-node-binaries]  (runs the produced bundle under every vX.Y.Z/bin/node found)
const esbuild = require('esbuild');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const nodesDir = process.argv[2];
const outDir = fs.mkdtempSync(path.join(process.env.SPIKE_TMP || os.tmpdir(), 's1-esb-'));

const variants = [
  { name: 'cjs-node22-dev', opts: { format: 'cjs', target: 'node22', minify: false } },
  { name: 'cjs-node22-min', opts: { format: 'cjs', target: 'node22', minify: true } },
  { name: 'cjs-node20-min', opts: { format: 'cjs', target: 'node20', minify: true } },
  { name: 'cjs-node22.13', opts: { format: 'cjs', target: 'node22.13', minify: false } },
  { name: 'esm-node22', opts: { format: 'esm', target: 'node22', minify: false, outExt: '.mjs' } },
];

(async () => {
  const report = { esbuild: esbuild.version, variants: [], run: [] };
  for (const v of variants) {
    const outfile = path.join(outDir, v.name + (v.opts.outExt || '.js'));
    const { outExt, ...opts } = v.opts;
    const res = await esbuild.build({
      entryPoints: [path.join(root, 'fixtures', 'entry.ts')],
      bundle: true,
      platform: 'node',
      // NOTE: deliberately NO `external: [...]` - the point is that node: built-ins are external automatically
      outfile,
      metafile: true,
      logLevel: 'silent',
      ...opts,
    });
    const code = fs.readFileSync(outfile, 'utf8');
    const imports = Object.values(res.metafile.outputs).flatMap((o) => o.imports);
    report.variants.push({
      name: v.name,
      bytes: code.length,
      metafileExternalImports: imports.filter((i) => i.external).map((i) => `${i.kind}:${i.path}`),
      keepsRequireCall: /require\(["']node:sqlite["']\)/.test(code),
      keepsImportCall: /import\(["']node:sqlite["']\)/.test(code),
      inlinedDriverCode: /DatabaseSync\s*=\s*class|StatementSync\s*\{/.test(code),
      outfile,
    });
  }
  // run the CJS bundles under each available runtime
  if (nodesDir) {
    const nodes = fs
      .readdirSync(nodesDir)
      .filter((d) => /^v\d/.test(d))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const n of nodes) {
      const bin = path.join(nodesDir, n, 'bin', 'node');
      for (const v of report.variants.filter((x) => x.name === 'cjs-node22-min')) {
        let stdout;
        let stderr = '';
        try {
          stdout = execFileSync(bin, [v.outfile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
          stdout = e.stdout;
          stderr = String(e.stderr || e.message);
        }
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch (_) {
          parsed = { raw: stdout, stderr: stderr.slice(0, 400) };
        }
        report.run.push({ runtime: n, bundle: v.name, ...parsed });
      }
    }
    // also: the ESM bundle under one runtime that has the module, one that lacks it
    for (const n of ['v22.12.0', 'v22.13.0']) {
      const bin = path.join(nodesDir, n, 'bin', 'node');
      if (!fs.existsSync(bin)) continue;
      const v = report.variants.find((x) => x.name === 'esm-node22');
      let stdout = '';
      let stderr = '';
      try {
        stdout = execFileSync(bin, [v.outfile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        stdout = e.stdout || '';
        stderr = String(e.stderr || e.message);
      }
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (_) {
        parsed = { raw: stdout, stderr: stderr.slice(0, 600) };
      }
      report.run.push({ runtime: n, bundle: v.name, ...parsed });
    }
  }
  for (const v of report.variants) delete v.outfile;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})();

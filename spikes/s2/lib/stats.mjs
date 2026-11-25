// Small stats + reporting helpers shared by all S2 benches.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

/** Nearest-rank percentile summary of a numeric array. */
export function summarize(xs) {
  const a = Float64Array.from(xs).sort();
  const n = a.length;
  if (n === 0) return { n: 0, min: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN };
  const pct = (p) => a[Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1))];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i];
  return { n, min: a[0], p50: pct(50), p95: pct(95), p99: pct(99), max: a[n - 1], mean: sum / n };
}

export function median(xs) {
  return summarize(xs).p50;
}

/** Summarise a perf_hooks histogram (ns) into ms, subtracting the timer resolution. */
export function histMs(h, resolutionMs = 0) {
  const f = (ns) => Math.max(0, ns / 1e6 - resolutionMs);
  return {
    p50: f(h.percentile(50)),
    p95: f(h.percentile(95)),
    p99: f(h.percentile(99)),
    max: f(h.max),
    count: h.count,
  };
}

export const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : 'n/a');

/** Render a markdown table. rows = array of arrays of strings/numbers. */
export function mdTable(header, rows) {
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}

export function machineInfo() {
  const cpus = os.cpus();
  return {
    node: process.version,
    v8: process.versions.v8,
    sqlite: process.versions.sqlite,
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0]?.model,
    cpuCount: cpus.length,
    cpuMHz: cpus[0]?.speed,
    totalMemGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    tz: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** Where scratch DBs / files go. Override with S2_TMP. */
export function scratchDir(name) {
  const base = process.env.S2_TMP ?? path.join(os.tmpdir(), 'mallard-s2');
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

export function saveResult(name, obj) {
  // S2_RESULTS overrides the output directory (smoke runs must not overwrite the committed results)
  const dir = process.env.S2_RESULTS ? new URL(`file://${path.resolve(process.env.S2_RESULTS)}/`) : new URL('../results/', import.meta.url);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    new URL(`${name}.json`, dir),
    JSON.stringify({ machine: machineInfo(), at: new Date().toISOString(), ...obj }, null, 2),
  );
}

export const tick = () => new Promise((r) => setImmediate(r));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const nowMs = () => performance.now();

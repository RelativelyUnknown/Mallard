// Read-time pricing + snapshot aggregator used by bench-read.mjs and the worker prototype.
import { MODELS } from './data.mjs';

export const BUCKET_MS = 15 * 60_000;

export const PRICES = new Map(
  MODELS.map((m, i) => {
    const k = 1 + (i % 4);
    return [m, { in: 3e-6 * k, out: 15e-6 * k, cr: 0.3e-6 * k, cw: 3.75e-6 * k, th: 15e-6 * k, mult: 0.33 * (1 + (i % 6)) }];
  }),
);

export function localParts(ts) {
  // repo-faithful: startOf(ts,'day') / hourly bucket via local Date components
  const d = new Date(ts);
  const y = d.getFullYear(), m = d.getMonth(), dd = d.getDate(), h = d.getHours();
  return { day: new Date(y, m, dd).getTime(), hour: new Date(y, m, dd, h).getTime(), wd: (d.getDay() + 6) % 7 };
}

export class Aggregator {
  constructor(cached) {
    this.cached = cached;
    this.parts = new Map(); // 15-min UTC bucket -> local parts (cached mode)
    this.days = new Map(); this.hours = new Map(); this.weekday = new Float64Array(7);
    this.models = new Map(); this.repos = new Map(); this.branches = new Map();
    this.cat = { in: 0, out: 0, cr: 0, cw: 0, th: 0 };
    this.credits = 0; this.cost = 0; this.tokens = 0; this.requests = 0; this.heur = 0; this.rows = 0;
  }
  add(ts, model, surface, source, repo, branch, attribution, language, requests, prompt, completion, cacheRead, cacheWrite, thinking) {
    this.rows++;
    const p = PRICES.get(model);
    const credits = p ? p.mult * requests : 0;
    const cIn = (prompt ?? 0) * (p?.in ?? 0), cOut = (completion ?? 0) * (p?.out ?? 0);
    const cCr = cacheRead * (p?.cr ?? 0), cCw = cacheWrite * (p?.cw ?? 0), cTh = thinking * (p?.th ?? 0);
    const cost = cIn + cOut + cCr + cCw + cTh;
    let lp;
    if (this.cached) {
      const k = Math.floor(ts / BUCKET_MS);
      lp = this.parts.get(k);
      if (lp === undefined) { lp = localParts(k * BUCKET_MS); this.parts.set(k, lp); }
    } else lp = localParts(ts);
    const dv = this.days.get(lp.day);
    if (dv) { dv[0] += credits; dv[1] += cost; dv[2] += (prompt ?? 0) + (completion ?? 0); } else this.days.set(lp.day, [credits, cost, (prompt ?? 0) + (completion ?? 0)]);
    this.hours.set(lp.hour, (this.hours.get(lp.hour) ?? 0) + credits);
    this.weekday[lp.wd] += credits;
    this.models.set(model, (this.models.get(model) ?? 0) + cost);
    const rk = repo ?? 'unattributed';
    this.repos.set(rk, (this.repos.get(rk) ?? 0) + cost);
    if (branch) { const bk = `${rk}\u0000${branch}\u0000${model}`; this.branches.set(bk, (this.branches.get(bk) ?? 0) + requests); }
    this.cat.in += cIn; this.cat.out += cOut; this.cat.cr += cCr; this.cat.cw += cCw; this.cat.th += cTh;
    this.credits += credits; this.cost += cost; this.tokens += (prompt ?? 0) + (completion ?? 0); this.requests += requests;
    if (attribution === 'heuristic') this.heur += cost;
  }
  /** Plain-object summary of everything the aggregator computed (maps sorted) for equivalence checks. */
  digest() {
    const sortedMap = (m) => [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return {
      credits: this.credits, cost: this.cost, tokens: this.tokens, requests: this.requests, heur: this.heur,
      cat: { ...this.cat }, weekday: [...this.weekday],
      days: sortedMap(this.days), hours: sortedMap(this.hours),
      models: sortedMap(this.models), repos: sortedMap(this.repos), branches: sortedMap(this.branches),
    };
  }
}

/** Deep compare; floats within relative 1e-9 (SQL sums before multiplying, JS after: different rounding). */
export function firstDiff(a, b, path = '$') {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) ? null : `${path}: ${a} vs ${b}`;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDiff(a[i], b[i], `${path}[${i}]`); if (d) return d; }
    return null;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff(a[k], b[k], `${path}.${k}`); if (d) return d; }
    return null;
  }
  return a === b ? null : `${path}: ${a} vs ${b}`;
}


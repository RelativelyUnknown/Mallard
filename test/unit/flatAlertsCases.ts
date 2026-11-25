/**
 * Deterministic case generators for the legacy-parity guarantee of the flat
 * alerts (see flatAlertsFrozen.test.ts).
 *
 * The old JSON rules language is gone, but what it did is frozen: every case
 * below comes from a seeded PRNG, and `fixtures/legacyAlertOracle.json` holds
 * what the old evaluators (`ruleMatches`, `evaluateAlertRules` and
 * `RestrictionEngine.reconcile`, last at git b156a14) answered for each one.
 * The generators therefore use ONLY today's code (the legacy importer's
 * variable mapping and the flat metric lookup); changing anything here changes
 * the cases, and the frozen answers stop lining up.
 *
 * Five families, each a loop over seeds:
 *   - match:       one legacy rule, does it match?
 *   - single:      a list of 1-4 legacy rules against one snapshot, which fire at what severity?
 *   - series:      1-3 rules over 8 steps with cooldowns, which fire at each step?
 *   - restriction: 1-3 restrict rules over 10 steps, which rule holds the restriction after each?
 *   - builtin:     a random scalar config (budget, daily, branch cap) over 8 steps, which built-in alerts fire at each?
 *                  (velocity is off: the old first-to-last rate was replaced on purpose, D7)
 */
import type { HistorySample, RuleSnapshot } from '../../src/extension-backend/domain/expr/context';
import { buildFlatContext, metricValue } from '../../src/extension-backend/domain/flatAlerts';
import { mapLegacyVar } from '../../src/extension-backend/domain/flatAlertImport';
import type { LegacyRule } from '../../src/extension-backend/domain/flatAlertImport';
import { seeded } from './flatAlertsFixture';
import type { UserConfig } from '../../src/extension-backend/domain/types';

const POOL_MODELS = ['gpt-4.1', 'claude-sonnet-4-5', 'o3-mini', 'weird.model-1'];
const POOL_REPOS = ['alpha', 'foo.js', 'beta'];
/** Early morning: a whole series stays inside one local day and month. */
export const T0 = new Date(2026, 0, 15, 6, 0, 0).getTime();

type Rand = () => number;
const pick = <T>(r: Rand, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
const amount = (r: Rand, max: number): number => Math.round(r() * max * 100) / 100;

export function randomSnapshot(r: Rand, now: number): RuleSnapshot {
  const usedCredits = amount(r, 400);
  const models = POOL_MODELS.filter(() => r() < 0.6);
  const repos = POOL_REPOS.filter(() => r() < 0.6);
  const day = (d: number) => ({ start: new Date(now - d * 86_400_000).setHours(0, 0, 0, 0), credits: amount(r, 50), cost: amount(r, 5), tokens: 1 });
  const hasDays = r() < 0.7;
  return {
    generatedAt: now,
    today: { credits: amount(r, 200), cost: amount(r, 20), tokens: 1 },
    budget: {
      monthly: 100,
      includedCredits: 300,
      usedCredits,
      usedCost: amount(r, 150),
      percentOfBudget: amount(r, 1.5),
      percentOfIncluded: amount(r, 1.5),
      projectedOverage: null,
      pace: 'on-track',
    },
    forecast: { granularity: 'month', projectedCredits: amount(r, 600), projectedCost: amount(r, 200), low: 0, high: 0, basis: 'linear', asOf: now },
    topModels: models.map((key) => ({ key, credits: amount(r, 100), cost: amount(r, 30), tokens: 1 })),
    allModels: [...models, ...POOL_MODELS.filter(() => r() < 0.3)],
    allSurfaces: [],
    allRepos: [...repos],
    byRepo: repos.map((key) => ({ key, credits: amount(r, 100), cost: amount(r, 30), tokens: 1 })),
    sankeyLinks: [],
    currentBranchCredits: amount(r, 80),
    authStatus: 'signed-out',
    ...(hasDays ? { chartInputs: { dayAggregates: [day(0), day(1), day(2), day(9)] } } : {}),
  } as unknown as RuleSnapshot;
}

export function randomHistory(r: Rand, now: number): HistorySample[] | undefined {
  if (r() < 0.2) return undefined;
  const history: HistorySample[] = [];
  let credits = amount(r, 100);
  const samples = Math.floor(r() * 7);
  for (let i = 0; i < samples; i++) {
    history.push({ ts: now - (samples - i) * Math.round(60_000 + r() * 600_000), todayCredits: credits });
    credits = r() < 0.1 ? amount(r, 30) : credits + amount(r, 60); // now and then the counter drops (midnight, recompute)
  }
  return history;
}

export const VAR_PATHS = [
  'today.credits',
  'today.cost',
  'month.credits',
  'month.cost',
  'budget.usedCredits',
  'budget.usedCost',
  'budget.percentOfBudget',
  'budget.percentOfIncluded',
  'forecast.projectedCredits',
  'forecast.projectedCost',
  'velocity.creditsPerHour',
  'window7d.credits',
  'currentBranchCredits',
  'model["gpt-4.1"].credits',
  'model.o3-mini.cost',
  'model["weird.model-1"].credits',
  'model["not-in-the-snapshot"].cost',
  'repo["foo.js"].cost',
  'repo.alpha.credits',
  'repo["nobody"].credits',
];
const OPS = ['>', '>=', '<', '<=', '==', '!='] as const;
const SEVERITIES = ['info', 'warning', 'critical'] as const;
const COOLDOWNS = ['10m', '30m', '1h', '90m', undefined];

/** The value a legacy variable path has in this snapshot (what `resolveVar` answered on the old context). */
export function legacyValue(varPath: string, snapshot: RuleSnapshot, history: HistorySample[] | undefined, now: number): number | undefined {
  const mapped = mapLegacyVar(varPath);
  if (!mapped.ok) throw new Error(`generator path ${varPath} must map: ${mapped.reason}`);
  return metricValue(mapped.value, buildFlatContext({ snapshot, ...(history ? { history } : {}), now }));
}

/** A literal that is often exactly the value the variable has now (so boundaries are hit), or one off by 1. */
function literalFor(r: Rand, current: (varPath: string) => number | undefined, varPath: string): number | string {
  const resolved = current(varPath);
  const base = typeof resolved === 'number' ? resolved : amount(r, 300);
  const roll = r();
  const n = roll < 0.35 ? base : roll < 0.5 ? base + 1 : roll < 0.65 ? base - 1 : amount(r, 400);
  return r() < 0.12 ? String(n) : n;
}

function randomLegacyRule(r: Rand, id: string, current: (varPath: string) => number | undefined): LegacyRule {
  const common = { id, severity: pick(r, SEVERITIES), message: 'm', ...(r() < 0.7 ? { cooldown: pick(r, COOLDOWNS) as string } : {}) } as Pick<LegacyRule, 'id' | 'severity' | 'message'>;
  const path = pick(r, VAR_PATHS);
  const op = pick(r, OPS);
  const value = literalFor(r, current, path);
  switch (Math.floor(r() * 4)) {
    case 0:
      return { ...common, conditions: [{ field: path, op, value }], ...(r() < 0.5 ? { match: pick(r, ['all', 'any'] as const) } : {}) };
    case 1:
      return { ...common, when: { [op]: [{ var: path }, value] } };
    case 2:
      return { ...common, when: { [op]: [value, { var: path }] } };
    default: {
      const levels = SEVERITIES.filter(() => r() < 0.75);
      if (levels.length === 0) levels.push('warning');
      return {
        ...common,
        thresholds: levels.map((severity) => {
          const levelPath = r() < 0.5 ? path : pick(r, VAR_PATHS);
          return {
            field: levelPath,
            op: pick(r, ['>', '>=', '<', '<=', '==', '!='] as const),
            value: literalFor(r, current, levelPath),
            severity,
            ...(r() < 0.5 ? { cooldown: pick(r, COOLDOWNS.filter((c): c is string => c !== undefined)) } : {}),
          };
        }),
      };
    }
  }
}

/** A restrict rule: `reEnableWhen` (strictly below, on the rule's own metric) 60 % of the time. */
function randomRestrictRule(r: Rand, id: string, current: (varPath: string) => number | undefined): LegacyRule {
  const path = pick(r, VAR_PATHS.filter((p) => !p.includes('nobody') && !p.includes('not-in')));
  const resolved = current(path);
  const base = typeof resolved === 'number' ? resolved : 50;
  const op = pick(r, ['>', '>=', '<', '<='] as const);
  const value = r() < 0.4 ? base : amount(r, 300);
  const withReEnable = r() < 0.6;
  const reEnableWhen = { '<': [{ var: path }, r() < 0.4 ? base : amount(r, 300)] };
  const restrict = withReEnable ? { reEnableWhen } : {};
  const common = { id, severity: 'warning' as const, message: 'm', restrict };
  return r() < 0.7
    ? { ...common, conditions: [{ field: path, op, value }] }
    : { ...common, thresholds: [{ field: path, op, value, severity: 'info' as const }, { field: path, op, value: value + amount(r, 20), severity: 'critical' as const }] };
}

// ── The four families ────────────────────────────────────────────────────────

export interface MatchCase { seed: number; rule: LegacyRule; snapshot: RuleSnapshot; history: HistorySample[] | undefined; now: number }
export const MATCH_SEEDS = 1500;

export function matchCase(seed: number): MatchCase {
  const r = seeded(seed);
  const now = T0 + Math.floor(r() * 3_600_000);
  const snapshot = randomSnapshot(r, now);
  const history = randomHistory(r, now);
  const rule = randomLegacyRule(r, 'r', (p) => legacyValue(p, snapshot, history, now));
  return { seed, rule, snapshot, history, now };
}

export interface SingleCase { seed: number; rules: LegacyRule[]; snapshot: RuleSnapshot; history: HistorySample[] | undefined; now: number }
export const SINGLE_SEEDS = 800;

export function singleCase(seed: number): SingleCase {
  const r = seeded(10_000 + seed);
  const now = T0 + Math.floor(r() * 3_600_000);
  const snapshot = randomSnapshot(r, now);
  const history = randomHistory(r, now);
  const rules = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => randomLegacyRule(r, `rule${i}`, (p) => legacyValue(p, snapshot, history, now)));
  return { seed, rules, snapshot, history, now };
}

export interface SeriesStep { snapshot: RuleSnapshot; history: HistorySample[] | undefined; now: number }
export interface SeriesCase { seed: number; rules: LegacyRule[]; steps: SeriesStep[] }
export const SERIES_SEEDS = 150;
export const SERIES_STEPS = 8;

export function seriesCase(seed: number): SeriesCase {
  const r = seeded(20_000 + seed);
  const first = randomSnapshot(r, T0);
  const rules = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) =>
    randomLegacyRule(r, `rule${i}`, (p) => legacyValue(p, first, undefined, T0)),
  );
  const steps: SeriesStep[] = [];
  let now = T0;
  for (let step = 0; step < SERIES_STEPS; step++) {
    // 137 ms off any round number: a gap never lands exactly on a cooldown (the one place the old and flat boundaries differ)
    now += Math.round(r() * 20 * 60_000) + 137;
    steps.push({ snapshot: randomSnapshot(r, now), history: randomHistory(r, now), now });
  }
  return { seed, rules, steps };
}

export interface RestrictionCase { seed: number; rules: LegacyRule[]; steps: SeriesStep[] }
export const RESTRICTION_SEEDS = 60;
export const RESTRICTION_STEPS = 10;

export function restrictionCase(seed: number): RestrictionCase {
  const r = seeded(30_000 + seed);
  const first = randomSnapshot(r, T0);
  const rules = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) =>
    randomRestrictRule(r, `rule${i}`, (p) => legacyValue(p, first, undefined, T0)),
  );
  const steps: SeriesStep[] = [];
  let now = T0;
  for (let step = 0; step < RESTRICTION_STEPS; step++) {
    now += Math.round(r() * 30 * 60_000) + 137;
    // Walk the metrics around the thresholds so rules start, hold in the hysteresis band and clear.
    steps.push({ snapshot: randomSnapshot(r, now), history: randomHistory(r, now), now });
  }
  return { seed, rules, steps };
}

export interface BuiltinCase { seed: number; config: UserConfig; branch: string | undefined; steps: SeriesStep[] }
export const BUILTIN_SEEDS = 200;
export const BUILTIN_STEPS = 8;
export const BUILTIN_BRANCH = 'feature/x';

export function builtinCase(seed: number): BuiltinCase {
  const r = seeded(40_000 + seed);
  const config: UserConfig = {
    monthlyBudget: pick(r, [0, 100]),
    includedCredits: 300,
    dailyCreditAlert: pick(r, [0, 50, 100]),
    alerts: { velocityEnabled: false, velocityCreditsPerHour: 0 },
    ...(r() < 0.8 ? { branchBudgets: { [BUILTIN_BRANCH]: pick(r, [20, 40, 60]) } } : {}),
  };
  const branch = r() < 0.8 ? BUILTIN_BRANCH : undefined;
  const steps: SeriesStep[] = [];
  let now = T0;
  for (let step = 0; step < BUILTIN_STEPS; step++) {
    // Up to 2 h apart, so the 1-4 h cooldowns expire inside a series; 137 ms off any round number.
    now += Math.round(r() * 2 * 3_600_000) + 137;
    steps.push({ snapshot: { ...randomSnapshot(r, now), ...(branch ? { currentBranch: branch } : {}) } as RuleSnapshot, history: undefined, now });
  }
  return { seed, config, branch, steps };
}

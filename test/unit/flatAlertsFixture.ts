/**
 * Shared builders for the flat-alert tests: a rule snapshot with sensible
 * values, flat rule/context shortcuts and a tiny seeded PRNG (no dependency)
 * for the property-style parity tests.
 */
import type { FlatAlertRule } from '../../src/extension-backend/domain/contracts';
import type { HistorySample, RuleSnapshot } from '../../src/extension-backend/domain/expr/context';
import { buildFlatContext } from '../../src/extension-backend/domain/flatAlerts';
import type { FlatContext } from '../../src/extension-backend/domain/flatAlerts';

export const MODEL_ID = 'claude-sonnet-4-5-20250929';

/** A snapshot with distinct, easy-to-recognise values in every field the metrics read. */
export function ruleSnapshot(overrides: Record<string, unknown> = {}): RuleSnapshot {
  return {
    generatedAt: 0,
    today: { credits: 12, cost: 0.48, tokens: 1200 },
    budget: {
      monthly: 100,
      includedCredits: 300,
      usedCredits: 150,
      usedCost: 60,
      percentOfBudget: 0.6,
      percentOfIncluded: 0.5,
      projectedOverage: null,
      pace: 'on-track',
    },
    forecast: { granularity: 'month', projectedCredits: 240, projectedCost: 96, low: 200, high: 280, basis: 'linear', asOf: 0 },
    topModels: [
      { key: MODEL_ID, credits: 90, cost: 36, tokens: 9000 },
      { key: 'gpt-4.1', credits: 60, cost: 24, tokens: 6000 },
    ],
    allModels: [MODEL_ID, 'gpt-4.1', 'idle-model'],
    allSurfaces: [],
    allRepos: ['alpha', 'foo.js', 'idle-repo'],
    byRepo: [
      { key: 'alpha', credits: 100, cost: 40, tokens: 1 },
      { key: 'foo.js', credits: 50, cost: 20, tokens: 1 },
    ],
    sankeyLinks: [],
    currentBranchCredits: 33,
    authStatus: 'signed-out',
    chartInputs: {
      dayAggregates: [{ start: 0, credits: 0, cost: 0, tokens: 0 }],
    },
    ...overrides,
  } as unknown as RuleSnapshot;
}

export function flatRule(overrides: Partial<FlatAlertRule> = {}): FlatAlertRule {
  return {
    id: 'r',
    metric: 'today.credits',
    op: '>',
    value: 10,
    cooldown: '1h',
    severity: 'warning',
    ...overrides,
  };
}

export function ctxOf(snapshot: RuleSnapshot | null, history?: HistorySample[], now = 1_700_000_000_000): FlatContext {
  return buildFlatContext({ snapshot, ...(history ? { history } : {}), now });
}

/** Mulberry32: a small deterministic PRNG, so a failing property case reproduces from its seed. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The four built-in alerts (budget band, daily credits, velocity, branch cap) as
 * flat rules: `builtinFlatRules` evaluated by `evaluateFlatRules`. The cases are
 * the behaviours the old hand-written evaluator was pinned to (thresholds,
 * boundaries, cooldowns, off switches); the only intended change is velocity,
 * which now reads the least-squares rate (D7).
 */
import { strict as assert } from 'assert';
import { buildFlatContext } from '../../src/extension-backend/domain/alertMetrics';
import type { HistorySample } from '../../src/extension-backend/domain/alertMetrics';
import { builtinFlatRules, evaluateFlatRules, pruneCooldowns } from '../../src/extension-backend/domain/flatAlerts';
import type { FlatCooldownState } from '../../src/extension-backend/domain/flatAlerts';
import { DEFAULT_USER_CONFIG } from '../../src/extension-backend/domain/types';
import type { UserConfig } from '../../src/extension-backend/domain/types';
import { alertSnapshot } from './flatAlertsFixture';

const NOW = 1_700_000_000_000; // fixed epoch for deterministic month/day keys
const H = 3_600_000;

function cfg(overrides: Partial<UserConfig> = {}): UserConfig {
  return { ...DEFAULT_USER_CONFIG, ...overrides };
}

interface Reading {
  percentOfBudget?: number;
  todayCredits?: number;
  branch?: string;
  branchCredits?: number;
}

/** Evaluate the built-in rules once; returns the fired rule ids and the new cooldown state. */
function fire(
  config: UserConfig,
  reading: Reading = {},
  opts: { history?: HistorySample[]; state?: FlatCooldownState; now?: number } = {},
): { ids: string[]; messages: string[]; state: FlatCooldownState } {
  const now = opts.now ?? NOW;
  const rules = builtinFlatRules(config, reading.branch);
  const ctx = buildFlatContext({ snapshot: alertSnapshot(reading), ...(opts.history ? { history: opts.history } : {}), now });
  const state = pruneCooldowns(opts.state ?? {}, rules, now);
  const evaluation = evaluateFlatRules(rules, ctx, state, now);
  return { ids: evaluation.matches.map((m) => m.rule.id), messages: evaluation.matches.map((m) => m.message), state: evaluation.state };
}

describe('built-in alerts — budget', () => {
  it('fires the exceeded alert at 100% when monthlyBudget is set', () => {
    const r = fire(cfg({ monthlyBudget: 20 }), { percentOfBudget: 1.0 });
    assert.deepEqual(r.ids, ['builtin:budget:100']);
    assert.deepEqual(r.messages, ['budget.percentOfBudget >= 1 (now 1)']);
  });

  it('fires the 80% alert (not yet 100%)', () => {
    assert.deepEqual(fire(cfg({ monthlyBudget: 20 }), { percentOfBudget: 0.85 }).ids, ['builtin:budget:80']);
  });

  it('does not fire below 80%, or when monthlyBudget is 0', () => {
    assert.deepEqual(fire(cfg({ monthlyBudget: 20 }), { percentOfBudget: 0.5 }).ids, []);
    assert.deepEqual(fire(cfg({ monthlyBudget: 0 }), { percentOfBudget: 1.5 }).ids, []);
  });

  it('the 80% alert fires at exactly 0.8 and not a hair below; just under 100% is the 80% alert, exactly 100% the exceeded one', () => {
    const config = cfg({ monthlyBudget: 20 });
    assert.deepEqual(fire(config, { percentOfBudget: 0.8 }).ids, ['builtin:budget:80']);
    assert.deepEqual(fire(config, { percentOfBudget: 0.7999 }).ids, []);
    assert.deepEqual(fire(config, { percentOfBudget: 0.9999 }).ids, ['builtin:budget:80']);
    assert.deepEqual(fire(config, { percentOfBudget: 1 }).ids, ['builtin:budget:100']);
  });

  it('respects a 4 h cooldown on each, and fires again after it', () => {
    const config = cfg({ monthlyBudget: 20 });
    for (const [pct, id] of [[1.2, 'builtin:budget:100'], [0.85, 'builtin:budget:80']] as const) {
      const first = fire(config, { percentOfBudget: pct });
      assert.deepEqual(first.ids, [id]);
      assert.deepEqual(fire(config, { percentOfBudget: pct }, { state: first.state, now: NOW + 3 * H }).ids, []);
      assert.deepEqual(fire(config, { percentOfBudget: pct }, { state: first.state, now: NOW + 4 * H }).ids, [], 'exactly 4 h still blocks');
      assert.deepEqual(fire(config, { percentOfBudget: pct }, { state: first.state, now: NOW + 4 * H + 1 }).ids, [id]);
    }
  });

  it('climbing from the 80% band to 100% raises the exceeded alert immediately (its own key)', () => {
    const config = cfg({ monthlyBudget: 20 });
    const first = fire(config, { percentOfBudget: 0.85 });
    assert.deepEqual(fire(config, { percentOfBudget: 1.1 }, { state: first.state, now: NOW + H }).ids, ['builtin:budget:100']);
  });

  it('a new month is a new key: the 80% alert fires again 1 h after the last day of the previous one', () => {
    const config = cfg({ monthlyBudget: 20 });
    const jan31 = new Date(2026, 0, 31, 23, 30).getTime();
    const first = fire(config, { percentOfBudget: 0.85 }, { now: jan31 });
    assert.deepEqual(fire(config, { percentOfBudget: 0.85 }, { state: first.state, now: jan31 + H }).ids, ['builtin:budget:80']);
    assert.deepEqual(Object.keys(first.state), ['builtin:budget:80@2026-01']);
  });
});

describe('built-in alerts — daily credit threshold', () => {
  const config = cfg({ dailyCreditAlert: 100 });

  it('fires when today.credits >= threshold (exactly at it too), not below', () => {
    assert.deepEqual(fire(config, { todayCredits: 150 }).messages, ['today.credits >= 100 (now 150)']);
    assert.deepEqual(fire(config, { todayCredits: 100 }).ids, ['builtin:daily']);
    assert.deepEqual(fire(config, { todayCredits: 99 }).ids, []);
  });

  it('does not fire when dailyCreditAlert is 0', () => {
    assert.deepEqual(fire(cfg({ dailyCreditAlert: 0 }), { todayCredits: 1000 }).ids, []);
  });

  it('fires once a day: blocked for the rest of the local day, and a new day fires again at once', () => {
    const morning = new Date(2026, 3, 10, 9, 0).getTime();
    const first = fire(config, { todayCredits: 150 }, { now: morning });
    assert.deepEqual(first.ids, ['builtin:daily']);
    assert.deepEqual(fire(config, { todayCredits: 150 }, { state: first.state, now: morning + 3 * H }).ids, []);
    assert.deepEqual(fire(config, { todayCredits: 150 }, { state: first.state, now: morning + 16 * H }).ids, ['builtin:daily'], '01:00 the next day: a new day key, only 16 h later');
  });
});

describe('built-in alerts — velocity (least-squares, D7)', () => {
  const on = (rate: number) => cfg({ alerts: { velocityEnabled: true, velocityCreditsPerHour: rate } });
  const hourly = (credits: number): HistorySample[] => [
    { ts: NOW - H, todayCredits: 0 },
    { ts: NOW, todayCredits: credits },
  ];

  it('fires when the rate is at or above the threshold, and not for a hair less', () => {
    assert.deepEqual(fire(on(50), {}, { history: hourly(60) }).messages, ['velocity.creditsPerHour >= 50 (now 60)']);
    assert.deepEqual(fire(on(50), {}, { history: hourly(50) }).ids, ['builtin:velocity'], 'exactly 50 credits/hour meets a threshold of 50');
    assert.deepEqual(fire(on(50), {}, { history: hourly(49.99) }).ids, []);
  });

  it('does not fire when velocityEnabled is false or the threshold is 0', () => {
    assert.deepEqual(fire(cfg({ alerts: { velocityEnabled: false, velocityCreditsPerHour: 50 } }), {}, { history: hourly(60) }).ids, []);
    assert.deepEqual(fire(on(0), {}, { history: hourly(60) }).ids, []);
  });

  it('does not fire when the history is too short', () => {
    assert.deepEqual(fire(on(50), {}, { history: [{ ts: NOW, todayCredits: 500 }] }).ids, []);
    assert.deepEqual(fire(on(50)).ids, []);
  });

  it('uses every sample in the window, not first-to-last', () => {
    // First to last is 100 credits/hour, but the rate through all five samples is 80.25: the old evaluator fired here, this one does not.
    const at = (min: number, credits: number): HistorySample => ({ ts: NOW + min * 60_000, todayCredits: credits });
    const history = [at(0, 0), at(30, 5), at(40, 10), at(45, 15), at(60, 100)];
    const r = fire(on(100), {}, { history, now: NOW + 60 * 60_000 });
    assert.deepEqual(r.ids, []);
    assert.deepEqual(fire(on(80), {}, { history, now: NOW + 60 * 60_000 }).messages, ['velocity.creditsPerHour >= 80 (now 80.25)']);
  });

  it('respects a 1 h cooldown', () => {
    const first = fire(on(50), {}, { history: hourly(60) });
    assert.deepEqual(first.ids, ['builtin:velocity']);
    assert.deepEqual(fire(on(50), {}, { history: hourly(60), state: first.state, now: NOW + 30 * 60_000 }).ids, []);
    assert.deepEqual(fire(on(50), {}, { history: hourly(60), state: first.state, now: NOW + H + 1 }).ids, ['builtin:velocity']);
  });
});

describe('built-in alerts — branch caps', () => {
  const config = cfg({ branchBudgets: { 'feature/x': 40 } });

  it('fires when currentBranchCredits >= cap for the current branch', () => {
    const r = fire(config, { branch: 'feature/x', branchCredits: 41 });
    assert.deepEqual(r.ids, ['builtin:branch:feature/x']);
    assert.deepEqual(r.messages, ['currentBranchCredits >= 40 (now 41)']);
    assert.deepEqual(fire(config, { branch: 'feature/x', branchCredits: 40 }).ids, ['builtin:branch:feature/x']);
  });

  it('does not fire below the cap', () => {
    assert.deepEqual(fire(config, { branch: 'feature/x', branchCredits: 39 }).ids, []);
  });

  it('does not fire without branchBudgets, without a current branch, or for a branch with no cap', () => {
    assert.deepEqual(fire(cfg(), { branch: 'feature/x', branchCredits: 99 }).ids, []);
    assert.deepEqual(fire(config, { branchCredits: 99 }).ids, []);
    assert.deepEqual(fire(config, { branch: 'main', branchCredits: 99 }).ids, []);
  });

  it('respects a 4 h cooldown, and fires again after it', () => {
    const first = fire(config, { branch: 'feature/x', branchCredits: 50 });
    assert.deepEqual(fire(config, { branch: 'feature/x', branchCredits: 50 }, { state: first.state, now: NOW + 3 * H }).ids, []);
    assert.deepEqual(fire(config, { branch: 'feature/x', branchCredits: 50 }, { state: first.state, now: NOW + 4 * H + 1 }).ids, ['builtin:branch:feature/x']);
  });
});

describe('built-in alerts — together', () => {
  it('fire in the order budget, daily, velocity, branch', () => {
    const config = cfg({
      monthlyBudget: 20,
      dailyCreditAlert: 10,
      alerts: { velocityEnabled: true, velocityCreditsPerHour: 5 },
      branchBudgets: { 'feature/x': 1 },
    });
    const r = fire(config, { percentOfBudget: 2, todayCredits: 20, branch: 'feature/x', branchCredits: 5 }, {
      history: [{ ts: NOW - H, todayCredits: 0 }, { ts: NOW, todayCredits: 20 }],
    });
    assert.deepEqual(r.ids, ['builtin:budget:100', 'builtin:daily', 'builtin:velocity', 'builtin:branch:feature/x']);
  });
});

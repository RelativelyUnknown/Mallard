/**
 * The acceptance gate for the flat alerts: they must behave like the code they
 * replace. (a) replays the recorded alert series (test/golden/expected/alerts.*)
 * through `builtinFlatRules` + `evaluateFlatRules`; (b) checks, over generated
 * contexts and rules, that the legacy evaluators and the converted flat rules
 * agree; the generator is a seeded PRNG, so a failure names its seed.
 */
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestrictionEngine } from '../../src/extension-backend/app/RestrictionEngine';
import { evaluateAlertRules, ruleMatches } from '../../src/extension-backend/domain/alertRules';
import type { HistorySample, RuleSnapshot } from '../../src/extension-backend/domain/expr/context';
import { buildRuleContext } from '../../src/extension-backend/domain/expr/context';
import { resolveVar } from '../../src/extension-backend/domain/expr/jsonCondition';
import { convertLegacyRules } from '../../src/extension-backend/domain/flatAlertImport';
import {
  buildFlatContext,
  evaluateFlatRules,
  flatRuleMatches,
  parseFlatRules,
} from '../../src/extension-backend/domain/flatAlerts';
import type { FlatCooldownState } from '../../src/extension-backend/domain/flatAlerts';
import { evaluateFlatRestriction } from '../../src/extension-backend/domain/flatRestriction';
import type { AlertRule } from '../../src/extension-backend/domain/types';
import { loadExpected } from '../golden/support/canon';
import { GOLDEN_TZS } from '../golden/support/time';
import { ALERT_SCRIPT, replayFlat } from './flatAlertsGolden';
import { seeded } from './flatAlertsFixture';

// ── (a) The recorded alert series ────────────────────────────────────────────

interface RecordedStep {
  local: string;
  warnings: string[];
  restriction: { active: boolean; ruleId: string; isRestricted: boolean };
}

/** The flat rule behind a recorded toast, from its text. */
function ruleOfToast(text: string): string {
  const month = /^Month at (\d+) credits$/.exec(text);
  if (month) return `month-escalation:${Number(month[1]) > 300 ? 3 : Number(month[1]) > 260 ? 2 : 1}`;
  const table: Array<[RegExp, string]> = [
    [/^Mallard: Monthly budget of \$100 exceeded\.$/, 'builtin:budget:100'],
    [/^Mallard: You've used 80% of your \$100 monthly budget\.$/, 'builtin:budget:80'],
    [/^Mallard: Daily credit usage \(\d+\) exceeded your threshold of 50\.$/, 'builtin:daily'],
    [/^Mallard: Spending is fast/, 'builtin:velocity'],
    [/^Mallard: Branch 'feature\/x' has used/, 'builtin:branch:feature/x'],
    [/^Busy day: \d+ credits so far$/, 'busy-day'],
    [/^Sonnet used [\d.]+ credits$/, 'sonnet-heavy'],
    [/^Rule velocity [\d.]+ cr\/h$/, 'velocity-rule'],
  ];
  const hit = table.find(([pattern]) => pattern.test(text));
  assert.ok(hit, `unrecognised recorded toast: ${text}`);
  return hit[1];
}

for (const tz of GOLDEN_TZS) {
  describe(`flat alerts replay the recorded alert series — ${tz}`, function () {
    this.timeout(60_000);
    let recorded: RecordedStep[];
    let replay: Awaited<ReturnType<typeof replayFlat>>;

    before(async () => {
      recorded = (await loadExpected('alerts', tz)) as RecordedStep[];
      replay = await replayFlat(tz);
    });

    it('replays the same script the recording was made from', () => {
      assert.deepEqual(recorded.map((s) => s.local), ALERT_SCRIPT.map((s) => s.local));
      assert.deepEqual(replay.steps.map((s) => s.local), ALERT_SCRIPT.map((s) => s.local));
    });

    it('converts the legacy rules of the recording and reports the two it cannot', () => {
      assert.deepEqual(replay.converted.map((r) => r.id), [
        'busy-day',
        'month-escalation:1',
        'month-escalation:2',
        'month-escalation:3',
        'sonnet-heavy',
        'velocity-rule',
        'restrict-over-budget',
        'restrict-heavy-day',
        'restrict-velocity',
      ]);
      assert.deepEqual(replay.skipped, [
        { id: 'needs-signin', reason: 'requiresAuth: flat rules cannot depend on being signed in to GitHub' },
        { id: 'restrict-snoozed', reason: `it is snoozed until ${replay.snoozeUntil}` },
      ]);
      assert.deepEqual(parseFlatRules(replay.rules).errors, [], 'every rule validates against the schema');
    });

    it('raises the same toasts at the same steps (built-in and converted rules), except the cooldown boundary', () => {
      const expected = recorded.map((s) => s.warnings.map(ruleOfToast));
      // One step differs: `sonnet-heavy` last fired at 22:30 with a 1 h cooldown and the recording raises it again at
      // exactly 23:30. The old rules language allowed firing at EXACTLY the cooldown; the built-in alerts (whose
      // 09:30 step, exactly 4 h after 05:30, stays quiet in the same recording) required strictly more. Flat rules
      // use the built-in boundary for everything, so only that exact-boundary firing goes.
      const boundary = ALERT_SCRIPT.findIndex((s) => s.local === '2026-01-31T23:30');
      assert.ok(expected[boundary]!.includes('sonnet-heavy'));
      expected[boundary] = expected[boundary]!.filter((id) => id !== 'sonnet-heavy');
      assert.deepEqual(
        replay.steps.map((s) => ({ at: s.local, toasts: s.toasts })),
        expected.map((toasts, i) => ({ at: ALERT_SCRIPT[i]!.local, toasts })),
      );
    });

    it('D7: the built-in velocity alert fires where the least-squares rate crosses its threshold, with that number', () => {
      const at = (local: string) => replay.steps[ALERT_SCRIPT.findIndex((s) => s.local === local)]!;
      const velocityMatches = replay.steps.flatMap((s) => s.matches.filter((m) => m.rule.id === 'builtin:velocity').map((m) => [s.local, m] as const));
      assert.deepEqual(velocityMatches.map(([local]) => local), ['2026-01-31T23:00']);
      const builtin = velocityMatches[0]![1];
      assert.equal(builtin.message, `velocity.creditsPerHour >= 100 (now 101.10)`);
      // The recorded rule-based alert carries the same least-squares number ("Rule velocity 101.10 cr/h")...
      const recordedRule = recorded.find((s) => s.local === '2026-01-31T23:00')!.warnings.find((w) => w.startsWith('Rule velocity'))!;
      assert.equal(recordedRule, `Rule velocity ${builtin.value!.toFixed(2)} cr/h`);
      // ... whereas the old built-in reported first-to-last: "about 100".
      assert.ok(recorded.find((s) => s.local === '2026-01-31T23:00')!.warnings.some((w) => w.includes('about 100 credits/hour')));
      // At 22:40 only the rule-based alert fires: the least-squares rate (91.15) is under the built-in threshold of 100.
      assert.deepEqual(at('2026-01-31T22:40').toasts, ['velocity-rule']);
    });

    it('D8: month keys are YYYY-MM, so the 80 % alert re-fires on the first snapshot of a new month', () => {
      // After the last step (09:35 on 1 Feb) each key has been pruned by its own rule's cooldown: the 24 h daily key of
      // 31 Jan is still blocking, while the 4 h 100 % key, the 45 min escalation key and the 1 h / 15 min keys are gone.
      assert.deepEqual(Object.keys(replay.cooldowns).sort(), [
        'builtin:branch:feature/x',
        'builtin:budget:80@2026-02',
        'builtin:daily@2026-01-31',
        'builtin:daily@2026-02-01',
        'busy-day@2026-02-01',
        'restrict-velocity',
      ]);
      const at = (local: string) => replay.steps[ALERT_SCRIPT.findIndex((s) => s.local === local)]!.toasts;
      assert.ok(at('2026-01-31T22:00').includes('builtin:budget:80'));
      assert.ok(at('2026-02-01T01:00').includes('builtin:budget:80'), 'only 3 h after the January firing, but a new month key');
    });

    it('restriction: every state matches the recording except the two documented differences', () => {
      // B6 is NOT in play here: this is the rule list without the velocity restriction.
      const diffs: Array<[string, string, string]> = [];
      replay.steps.forEach((s, i) => {
        const was = recorded[i]!.restriction;
        const now = s.restrictionWithoutVelocity;
        if (was.ruleId !== now.ruleId || was.isRestricted !== now.isRestricted) diffs.push([s.local, was.ruleId, now.ruleId]);
      });
      // `restrict-snoozed` (snoozeUntil) is reported by the importer instead of converted, so from its un-snooze
      // at 05:30 the recording has a restriction that the flat rules do not.
      assert.deepEqual(diffs, [
        ['2026-02-01T05:30', 'restrict-snoozed', ''],
        ['2026-02-01T09:30', 'restrict-snoozed', ''],
        ['2026-02-01T09:35', 'restrict-snoozed', ''],
      ]);
    });

    it('B6: with history the velocity restriction works; today the recording never restricts for it', () => {
      assert.equal(recorded.some((s) => s.restriction.ruleId === 'restrict-velocity'), false, 'never matched in the recording');
      assert.deepEqual(
        replay.steps.map((s) => [s.local.slice(5), s.restriction.ruleId, s.restriction.isRestricted] as const),
        [
          ['01-31T21:00', '', false], // one sample: no rate yet
          ['01-31T21:30', 'restrict-velocity', true],
          ['01-31T22:00', 'restrict-velocity', true],
          ['01-31T22:30', 'restrict-velocity', true],
          ['01-31T22:40', 'restrict-velocity', true],
          ['01-31T22:45', 'restrict-velocity', true],
          ['01-31T23:00', 'restrict-heavy-day', true], // declared before the velocity rule
          ['01-31T23:30', 'restrict-over-budget', false], // declared first, and snoozed for 30 minutes
          ['02-01T00:00', '', false], // the counter fell: the rate window restarts, and the snooze is over
          ['02-01T00:30', 'restrict-velocity', true],
          ['02-01T01:00', 'restrict-velocity', true],
          ['02-01T01:30', 'restrict-velocity', true],
          ['02-01T05:30', '', false], // the 01:30 sample is more than an hour old
          ['02-01T09:30', '', false],
          ['02-01T09:35', 'restrict-velocity', true],
        ],
      );
    });
  });
}

// ── (b) Old evaluators against converted flat rules ──────────────────────────

const POOL_MODELS = ['gpt-4.1', 'claude-sonnet-4-5', 'o3-mini', 'weird.model-1'];
const POOL_REPOS = ['alpha', 'foo.js', 'beta'];
const T0 = new Date(2026, 0, 15, 6, 0, 0).getTime(); // early morning: a whole series stays inside one local day and month

type Rand = () => number;
const pick = <T>(r: Rand, items: readonly T[]): T => items[Math.floor(r() * items.length)]!;
const amount = (r: Rand, max: number): number => Math.round(r() * max * 100) / 100;

function randomSnapshot(r: Rand, now: number): RuleSnapshot {
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

function randomHistory(r: Rand, now: number): HistorySample[] | undefined {
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

const VAR_PATHS = [
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

/** A literal that is often exactly the value the variable has now (so boundaries are hit), or one off by 1. */
function literalFor(r: Rand, ctx: Record<string, unknown>, varPath: string): number | string {
  const resolved = resolveVar(varPath, ctx);
  const base = typeof resolved === 'number' ? resolved : amount(r, 300);
  const roll = r();
  const n = roll < 0.35 ? base : roll < 0.5 ? base + 1 : roll < 0.65 ? base - 1 : amount(r, 400);
  return r() < 0.12 ? String(n) : n;
}

function randomLegacyRule(r: Rand, id: string, ctx: Record<string, unknown>): AlertRule {
  const common = { id, severity: pick(r, SEVERITIES), message: 'm', ...(r() < 0.7 ? { cooldown: pick(r, COOLDOWNS) as string } : {}) } as Pick<AlertRule, 'id' | 'severity' | 'message'>;
  const path = pick(r, VAR_PATHS);
  const op = pick(r, OPS);
  const value = literalFor(r, ctx, path);
  switch (Math.floor(r() * 4)) {
    case 0:
      return { ...common, conditions: [{ field: path, op, value }], ...(r() < 0.5 ? { match: pick(r, ['all', 'any'] as const) } : {}) };
    case 1:
      return { ...common, when: { [op]: [{ var: path }, value] } as never };
    case 2:
      return { ...common, when: { [op]: [value, { var: path }] } as never };
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
            value: literalFor(r, ctx, levelPath),
            severity,
            ...(r() < 0.5 ? { cooldown: pick(r, COOLDOWNS.filter((c): c is string => c !== undefined)) } : {}),
          };
        }),
      };
    }
  }
}

const baseId = (id: string): string => id.replace(/:\d+$/, '');

describe('flat rules agree with the legacy evaluator (generated)', function () {
  this.timeout(60_000);

  it('a converted rule matches exactly when the legacy rule does (1500 generated cases)', () => {
    let matched = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const r = seeded(seed);
      const now = T0 + Math.floor(r() * 3_600_000);
      const snapshot = randomSnapshot(r, now);
      const history = randomHistory(r, now);
      const legacyCtx = buildRuleContext({ snapshot, ...(history ? { history } : {}), now });
      const ctx = buildFlatContext({ snapshot, ...(history ? { history } : {}), now });
      const legacy = randomLegacyRule(r, 'r', legacyCtx);

      const { converted, skipped } = convertLegacyRules([legacy]);
      assert.deepEqual(skipped, [], `seed ${seed}: ${JSON.stringify(legacy)} should convert`);
      assert.deepEqual(parseFlatRules(converted).errors, [], `seed ${seed}: converted rules validate`);
      const want = ruleMatches(legacy, legacyCtx, now);
      const got = converted.some((flat) => flatRuleMatches(flat, ctx));
      assert.equal(got, want, `seed ${seed}: ${JSON.stringify(legacy)} -> ${JSON.stringify(converted)}`);
      if (want) matched++;
    }
    assert.ok(matched > 300 && matched < 1300, `the generator should produce both outcomes (${matched} of 1500 matched)`);
  });

  it('a single evaluation fires the same rules at the same severity (rule lists of 1-4, 800 generated cases)', () => {
    for (let seed = 1; seed <= 800; seed++) {
      const r = seeded(10_000 + seed);
      const now = T0 + Math.floor(r() * 3_600_000);
      const snapshot = randomSnapshot(r, now);
      const history = randomHistory(r, now);
      const legacyCtx = buildRuleContext({ snapshot, ...(history ? { history } : {}), now });
      const rules = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => randomLegacyRule(r, `rule${i}`, legacyCtx));

      const old = evaluateAlertRules({ snapshot, ...(history ? { history } : {}), rules, fired: new Map(), now });
      const { converted } = convertLegacyRules(rules);
      const flat = evaluateFlatRules(converted, buildFlatContext({ snapshot, ...(history ? { history } : {}), now }), {}, now);
      assert.deepEqual(
        flat.matches.map((m) => [baseId(m.rule.id), m.severity]),
        old.map((o) => [o.ruleId, o.severity]),
        `seed ${seed}: ${JSON.stringify(rules)}`,
      );
    }
  });

  it('over a series with cooldowns, each step fires the same rules (150 series of 8 steps)', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = seeded(20_000 + seed);
      const first = randomSnapshot(r, T0);
      const rules = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) =>
        // distinct severities per ladder, as in real threshold rules, keep old per-severity keys and flat per-level keys comparable
        randomLegacyRule(r, `rule${i}`, buildRuleContext({ snapshot: first, now: T0 })),
      );
      const { converted } = convertLegacyRules(rules);
      const fired = new Map<string, number>();
      let state: FlatCooldownState = {};
      let now = T0;
      for (let step = 0; step < 8; step++) {
        // 137 ms off any round number: a gap never lands exactly on a cooldown (the one place the two differ)
        now += Math.round(r() * 20 * 60_000) + 137;
        const snapshot = randomSnapshot(r, now);
        const history = randomHistory(r, now);
        const input = { snapshot, ...(history ? { history } : {}), now };
        const old = evaluateAlertRules({ ...input, rules, fired }).map((o) => o.ruleId);
        const flat = evaluateFlatRules(converted, buildFlatContext(input), state, now);
        state = flat.state;
        assert.deepEqual(flat.matches.map((m) => baseId(m.rule.id)), old, `seed ${seed} step ${step}: ${JSON.stringify(rules)}`);
      }
    }
  });
});

describe('flat restriction agrees with RestrictionEngine.reconcile (generated)', function () {
  this.timeout(120_000);
  let dir: string;
  let engine: RestrictionEngine;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-flat-restriction-'));
    engine = new RestrictionEngine(dir);
  });
  after(async () => {
    engine.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /** A restrict rule: `reEnableWhen` (strictly below, on the rule's own metric) half of the time. */
  function randomRestrictRule(r: Rand, id: string, ctx: Record<string, unknown>): AlertRule {
    const path = pick(r, VAR_PATHS.filter((p) => !p.includes('nobody') && !p.includes('not-in')));
    const resolved = resolveVar(path, ctx);
    const base = typeof resolved === 'number' ? resolved : 50;
    const op = pick(r, ['>', '>=', '<', '<='] as const);
    const value = r() < 0.4 ? base : amount(r, 300);
    const withReEnable = r() < 0.6;
    const reEnableWhen = { '<': [{ var: path }, r() < 0.4 ? base : amount(r, 300)] };
    const restrict = withReEnable ? { reEnableWhen: reEnableWhen as never } : {};
    const common = { id, severity: 'warning' as const, message: 'm', restrict };
    return r() < 0.7
      ? { ...common, conditions: [{ field: path, op, value }] }
      : { ...common, thresholds: [{ field: path, op, value, severity: 'info' as const }, { field: path, op, value: value + amount(r, 20), severity: 'critical' as const }] };
  }

  it('holds, switches and clears the same restriction at every step (60 series of 10 steps, history included)', async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = seeded(30_000 + seed);
      const first = buildRuleContext({ snapshot: randomSnapshot(r, T0), now: T0 });
      const rules = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, i) => randomRestrictRule(r, `rule${i}`, first));
      const { converted, skipped } = convertLegacyRules(rules);
      assert.deepEqual(skipped, [], `seed ${seed}`);

      await engine.clearAll();
      let held: string | undefined;
      let now = T0;
      for (let step = 0; step < 10; step++) {
        now += Math.round(r() * 30 * 60_000) + 137;
        // Walk the metrics around the thresholds so rules start, hold in the hysteresis band and clear.
        const snapshot = randomSnapshot(r, now);
        const history = randomHistory(r, now);
        const legacy = await engine.reconcile({ snapshot, ...(history ? { history } : {}), rules, now, signedIn: false });

        const flat = evaluateFlatRestriction(converted, buildFlatContext({ snapshot, ...(history ? { history } : {}), now }), held);
        held = flat.active?.id;
        assert.equal(
          held === undefined ? '' : baseId(held),
          legacy.active ? legacy.ruleId : '',
          `seed ${seed} step ${step}: ${JSON.stringify(rules)}`,
        );
      }
    }
  });
});

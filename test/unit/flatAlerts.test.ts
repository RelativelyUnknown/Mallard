import { strict as assert } from 'assert';
import {
  BUILTIN_RULE_IDS,
  DEFAULT_FLAT_COOLDOWN,
  FIXED_FLAT_METRICS,
  FlatAlertRuleSchema,
  ORPHAN_COOLDOWN_RETENTION_MS,
  builtinFlatRules,
  buildFlatContext,
  evaluateFlatRules,
  flatAlertMessage,
  flatCooldownKey,
  flatCooldownMs,
  flatRuleMatches,
  isFlatAlertMetric,
  metricValue,
  parseCooldownState,
  parseFlatRules,
  pruneCooldowns,
} from '../../src/extension-backend/domain/flatAlerts';
import type { FlatContext } from '../../src/extension-backend/domain/flatAlerts';
import type { FlatAlertMetric, FlatAlertRule } from '../../src/extension-backend/domain/contracts';
import { MODEL_ID, ctxOf, flatRule, ruleSnapshot } from './flatAlertsFixture';

const H = 3_600_000;
// Local wall times, so the day/month keys read the same in every time zone.
const JAN31_2200 = new Date(2026, 0, 31, 22, 0).getTime();
const FEB01_0100 = new Date(2026, 1, 1, 1, 0).getTime();

const mv = (metric: FlatAlertMetric, ctx: FlatContext): number | undefined => metricValue(metric, ctx);

describe('flat metrics — registry', () => {
  it('lists exactly the fixed metrics of the contract, in order', () => {
    assert.deepEqual(FIXED_FLAT_METRICS, [
      'today.credits',
      'today.cost',
      'month.credits',
      'month.cost',
      'budget.percentOfBudget',
      'budget.percentOfIncluded',
      'forecast.projectedCredits',
      'forecast.projectedCost',
      'velocity.creditsPerHour',
      'window7d.credits',
      'currentBranchCredits',
    ]);
  });

  it('accepts fixed and keyed metrics and nothing else', () => {
    for (const m of FIXED_FLAT_METRICS) assert.equal(isFlatAlertMetric(m), true, m);
    for (const m of ['model:gpt-4.1.credits', 'model:gpt-4.1.cost', 'repo:foo.js.cost', 'repo:a.credits', 'model:a.b.c.credits']) {
      assert.equal(isFlatAlertMetric(m), true, m);
    }
    for (const m of [
      '',
      'today.tokens',
      'today',
      'window7d.cost',
      'velocity.costPerHour',
      'model:.credits',
      'model:x.tokens',
      'model:x',
      'surface:chat.credits',
      'constructor',
      'toString',
      '__proto__',
    ]) {
      assert.equal(isFlatAlertMetric(m), false, m);
    }
  });
});

describe('flat metrics — metricValue', () => {
  const ctx = ctxOf(
    ruleSnapshot({
      topModels: [
        { key: MODEL_ID, credits: 90, cost: 36, tokens: 1 },
        { key: 'gpt-4.1', credits: 60, cost: 24, tokens: 1 },
      ],
    }),
    [
      { ts: 0, todayCredits: 0 },
      { ts: H, todayCredits: 60 },
    ],
  );

  it('reads every fixed metric from the rule context', () => {
    const expected: Record<string, number> = {
      'today.credits': 12,
      'today.cost': 0.48,
      'month.credits': 150,
      'month.cost': 60,
      'budget.percentOfBudget': 0.6,
      'budget.percentOfIncluded': 0.5,
      'forecast.projectedCredits': 240,
      'forecast.projectedCost': 96,
      'velocity.creditsPerHour': 60,
      'window7d.credits': 0,
      currentBranchCredits: 33,
    };
    for (const m of FIXED_FLAT_METRICS) assert.equal(mv(m, ctx), expected[m], m);
  });

  it('reads keyed metrics, ids with dots included, and 0 for a known but idle model or repo', () => {
    assert.equal(mv(`model:${MODEL_ID}.credits`, ctx), 90);
    assert.equal(mv('model:gpt-4.1.cost', ctx), 24);
    assert.equal(mv('repo:foo.js.credits', ctx), 50);
    assert.equal(mv('repo:alpha.cost', ctx), 40);
    assert.equal(mv('model:idle-model.credits', ctx), 0);
    assert.equal(mv('repo:idle-repo.cost', ctx), 0);
  });

  it('is undefined for an unknown model or repo, and never reads inherited names', () => {
    assert.equal(mv('model:nope.credits', ctx), undefined);
    assert.equal(mv('repo:nope.cost', ctx), undefined);
    assert.equal(mv('model:constructor.credits', ctx), undefined);
    assert.equal(mv('model:__proto__.credits', ctx), undefined);
    assert.equal(mv('repo:toString.cost', ctx), undefined);
  });

  it('is undefined for every metric without a snapshot (the zeros of an empty context must not match)', () => {
    const none = ctxOf(null);
    assert.equal(none.available, false);
    for (const m of FIXED_FLAT_METRICS) assert.equal(mv(m, none), undefined, m);
    assert.equal(mv('model:x.credits', none), undefined);
  });

  it('window7d is unavailable without day-level data, and follows chartInputs or chartData when present', () => {
    const noDays = ctxOf(ruleSnapshot({ chartInputs: undefined }));
    assert.equal(mv('window7d.credits', noDays), undefined);

    const now = new Date(2026, 0, 15, 12, 0).getTime();
    const day = (d: number, credits: number) => ({ start: new Date(2026, 0, d).getTime(), credits, cost: 0, tokens: 0 });
    const fromInputs = ctxOf(
      ruleSnapshot({ chartInputs: { dayAggregates: [day(8, 1), day(9, 2), day(15, 4), day(16, 99)] } }),
      undefined,
      now,
    );
    // 9th..15th inclusive: the 8th is outside the week, the 16th is in the future.
    assert.equal(mv('window7d.credits', fromInputs), 6);

    const points = Array.from({ length: 8 }, (_, i) => ({ credits: i + 1, cost: 0 }));
    const fromWire = ctxOf(ruleSnapshot({ chartInputs: undefined, chartData: { dailyBars: { points } } }));
    assert.equal(mv('window7d.credits', fromWire), 2 + 3 + 4 + 5 + 6 + 7 + 8);
  });

  it('velocity is the least-squares rate of the history and 0 without it', () => {
    assert.equal(mv('velocity.creditsPerHour', ctxOf(ruleSnapshot())), 0);
    assert.equal(mv('velocity.creditsPerHour', ctx), 60);
  });

  it('is undefined when the value at the path is not a number', () => {
    const odd: FlatContext = { values: { today: { credits: 'lots' } }, available: true };
    assert.equal(mv('today.credits', odd), undefined);
    assert.equal(mv('today.cost', odd), undefined);
    assert.equal(mv('currentBranchCredits', { values: { currentBranchCredits: null }, available: true }), undefined);
  });

  it('buildFlatContext without a snapshot is unavailable, with one it is available', () => {
    assert.equal(buildFlatContext({ snapshot: null, now: 1 }).available, false);
    assert.equal(buildFlatContext({ snapshot: ruleSnapshot(), now: 1 }).available, true);
  });
});

describe('flat rules — comparison semantics (the legacy compare())', () => {
  const ctx = ctxOf(ruleSnapshot()); // today.credits = 12

  it('applies each operator to the metric and the rule value', () => {
    const t = (op: FlatAlertRule['op'], value: number) => flatRuleMatches(flatRule({ op, value }), ctx);
    assert.deepEqual([t('>', 11), t('>', 12), t('>', 13)], [true, false, false]);
    assert.deepEqual([t('>=', 12), t('>=', 12.001), t('>=', 11)], [true, false, true]);
    assert.deepEqual([t('<', 13), t('<', 12), t('<', 11)], [true, false, false]);
    assert.deepEqual([t('<=', 12), t('<=', 11.999), t('<=', 13)], [true, false, true]);
    assert.deepEqual([t('==', 12), t('==', 12.5)], [true, false]);
    assert.deepEqual([t('!=', 12), t('!=', 13)], [false, true]);
  });

  it('an unavailable metric never matches, except for != (a nil operand is never equal to anything)', () => {
    const unknownModel = (op: FlatAlertRule['op']) =>
      flatRuleMatches(flatRule({ metric: 'model:nope.credits', op, value: 5 }), ctx);
    assert.deepEqual(
      (['>', '>=', '<', '<=', '=='] as const).map(unknownModel),
      [false, false, false, false, false],
    );
    assert.equal(unknownModel('!='), true);

    const noSnapshot = ctxOf(null);
    assert.equal(flatRuleMatches(flatRule({ op: '<', value: 100 }), noSnapshot), false, 'zeros of an empty context must not satisfy <');
    assert.equal(flatRuleMatches(flatRule({ op: '!=', value: 100 }), noSnapshot), true);
  });

  it('formats the fixed message: metric, operator, value and the current value', () => {
    const r = flatRule({ metric: 'today.credits', op: '>', value: 10 });
    assert.equal(flatAlertMessage(r, 95), 'today.credits > 10 (now 95)');
    assert.equal(flatAlertMessage(r, 141.6), 'today.credits > 10 (now 141.60)');
    assert.equal(flatAlertMessage(flatRule({ metric: 'budget.percentOfBudget', op: '>=', value: 0.8 }), 0.857), 'budget.percentOfBudget >= 0.8 (now 0.86)');
    assert.equal(flatAlertMessage(flatRule({ metric: 'model:gpt-4.1.cost', op: '!=', value: 0 }), undefined), 'model:gpt-4.1.cost != 0 (now n/a)');
  });
});

describe('flat rules — cooldown keys and durations', () => {
  it('a rule cooldown is parsed like the legacy ones, defaulting to one hour', () => {
    assert.equal(flatCooldownMs({ cooldown: '30m' }), 30 * 60_000);
    assert.equal(flatCooldownMs({ cooldown: '1.5H' }), 1.5 * H);
    assert.equal(flatCooldownMs({ cooldown: '2d' }), 48 * H);
    assert.equal(flatCooldownMs({ cooldown: '1w' }), 168 * H);
    assert.equal(flatCooldownMs({ cooldown: 'soon' }), H);
    assert.equal(flatCooldownMs({ cooldown: '0m' }), H);
    assert.equal(DEFAULT_FLAT_COOLDOWN, '1h');
  });

  it('keys carry the local day for today.*, the month for month/budget/forecast, and nothing else', () => {
    const key = (metric: FlatAlertMetric) => flatCooldownKey(flatRule({ id: 'x', metric }), JAN31_2200);
    assert.equal(key('today.credits'), 'x@2026-01-31');
    assert.equal(key('today.cost'), 'x@2026-01-31');
    for (const m of ['month.credits', 'month.cost', 'budget.percentOfBudget', 'budget.percentOfIncluded', 'forecast.projectedCredits', 'forecast.projectedCost'] as const) {
      assert.equal(key(m), 'x@2026-01', m);
    }
    for (const m of ['velocity.creditsPerHour', 'window7d.credits', 'currentBranchCredits', 'model:a.credits', 'repo:a.cost'] as const) {
      assert.equal(key(m), 'x', m);
    }
  });

  it('a new day or month is a new key (the month rolls over under a YYYY-MM key, year included)', () => {
    const r = flatRule({ id: 'b', metric: 'budget.percentOfBudget' });
    assert.equal(flatCooldownKey(r, JAN31_2200), 'b@2026-01');
    assert.equal(flatCooldownKey(r, FEB01_0100), 'b@2026-02');
    assert.equal(flatCooldownKey(r, new Date(2027, 0, 5).getTime()), 'b@2027-01');
  });
});

describe('evaluateFlatRules', () => {
  const ctx = ctxOf(ruleSnapshot()); // today 12, month 150, budget 0.6
  const NOW = JAN31_2200;

  it('fires matching rules in rule order with severity, fixed message, value and flags', () => {
    const rules = [
      flatRule({ id: 'a', metric: 'today.credits', op: '>', value: 10, severity: 'info' }),
      flatRule({ id: 'skip', metric: 'today.credits', op: '>', value: 50 }),
      flatRule({ id: 'b', metric: 'month.credits', op: '>=', value: 150, severity: 'critical', notify: false }),
      flatRule({ id: 'c', metric: 'budget.percentOfBudget', op: '<', value: 1, restrict: true }),
      flatRule({ id: 'd', metric: 'currentBranchCredits', op: '==', value: 33, notify: true }),
    ];
    const { matches } = evaluateFlatRules(rules, ctx, {}, NOW);
    assert.deepEqual(
      matches.map((m) => [m.rule.id, m.severity, m.message, m.value, m.notify, m.restrict]),
      [
        ['a', 'info', 'today.credits > 10 (now 12)', 12, true, false],
        ['b', 'critical', 'month.credits >= 150 (now 150)', 150, false, false],
        ['c', 'warning', 'budget.percentOfBudget < 1 (now 0.60)', 0.6, false, true],
        ['d', 'warning', 'currentBranchCredits == 33 (now 33)', 33, true, false],
      ],
      'restrict and notify:false rules fire but do not toast',
    );
    assert.deepEqual(matches.map((m) => m.key), ['a@2026-01-31', 'b@2026-01', 'c@2026-01', 'd']);
  });

  it('does not modify the state it was given, and returns the fired keys added to it', () => {
    const state = { other: 5 };
    const result = evaluateFlatRules([flatRule({ id: 'a' })], ctx, state, NOW);
    assert.deepEqual(state, { other: 5 });
    assert.deepEqual(result.state, { other: 5, 'a@2026-01-31': NOW });
    assert.notEqual(result.state, state);
    assert.deepEqual(evaluateFlatRules([], ctx, state, NOW).state, state);
  });

  it('respects the cooldown: blocked inside it AND at exactly the cooldown, fires again after it', () => {
    const rule = flatRule({ id: 'a', metric: 'currentBranchCredits', cooldown: '2h', value: 1 });
    const fired = { a: NOW };
    const at = (t: number) => evaluateFlatRules([rule], ctx, fired, t).matches.length;
    assert.equal(at(NOW + 1), 0);
    assert.equal(at(NOW + 2 * H - 1), 0);
    assert.equal(at(NOW + 2 * H), 0, 'exactly the cooldown is still blocked (the built-in alerts always worked this way)');
    assert.equal(at(NOW + 2 * H + 1), 1);
  });

  it('an invalid cooldown falls back to one hour', () => {
    const rule = flatRule({ id: 'a', metric: 'currentBranchCredits', cooldown: 'whenever', value: 1 });
    assert.equal(evaluateFlatRules([rule], ctx, { a: NOW }, NOW + H).matches.length, 0);
    assert.equal(evaluateFlatRules([rule], ctx, { a: NOW }, NOW + H + 1).matches.length, 1);
  });

  it('a recorded firing in the future (the clock moved back) does not block', () => {
    const rule = flatRule({ id: 'a', metric: 'currentBranchCredits', value: 1 });
    assert.equal(evaluateFlatRules([rule], ctx, { a: NOW + 5 * H }, NOW).matches.length, 1);
  });

  it('a new day or month re-fires immediately under the new key, an old key never blocks the new period', () => {
    const daily = flatRule({ id: 'd', metric: 'today.credits', value: 1, cooldown: '24h' });
    const monthly = flatRule({ id: 'm', metric: 'month.credits', value: 1, cooldown: '4h' });
    const first = evaluateFlatRules([daily, monthly], ctx, {}, JAN31_2200);
    assert.equal(first.matches.length, 2);
    const again = evaluateFlatRules([daily, monthly], ctx, first.state, JAN31_2200 + 30 * 60_000);
    assert.equal(again.matches.length, 0);
    const nextDay = evaluateFlatRules([daily, monthly], ctx, first.state, FEB01_0100);
    assert.deepEqual(nextDay.matches.map((m) => m.rule.id), ['d', 'm'], '3 h later but a new day and month');
  });

  it('two rules with the same id debounce each other within one pass', () => {
    const rules = [flatRule({ id: 'dup', metric: 'currentBranchCredits', value: 1 }), flatRule({ id: 'dup', metric: 'currentBranchCredits', value: 2 })];
    assert.equal(evaluateFlatRules(rules, ctx, {}, NOW).matches.length, 1);
  });

  it('a rule id of __proto__ still records and honours its cooldown', () => {
    const rule = flatRule({ id: '__proto__', metric: 'currentBranchCredits', value: 1 });
    const first = evaluateFlatRules([rule], ctx, {}, NOW);
    assert.equal(first.matches.length, 1);
    assert.equal(Object.keys(first.state).includes('__proto__'), true);
    assert.equal(evaluateFlatRules([rule], ctx, first.state, NOW + 1).matches.length, 0);
  });

  it('evaluates nothing when there are no rules', () => {
    assert.deepEqual(evaluateFlatRules([], ctx, {}, NOW), { matches: [], state: {} });
  });
});

describe('evaluateFlatRules — escalation ladders (one toast per band)', () => {
  const NOW = JAN31_2200;
  const level = (n: number, value: number, severity: FlatAlertRule['severity'], extra: Partial<FlatAlertRule> = {}) =>
    flatRule({ id: `esc:${n}`, metric: 'month.credits', op: '>', value, severity, cooldown: '45m', ...extra });
  const ladder = [level(1, 100, 'info'), level(2, 140, 'warning'), level(3, 300, 'critical')];
  const ids = (matches: Array<{ rule: FlatAlertRule }>) => matches.map((m) => m.rule.id);

  it('only the highest severity matching level of a ladder fires', () => {
    const ctx150 = ctxOf(ruleSnapshot()); // month.credits 150: levels 1 and 2 hold
    assert.deepEqual(ids(evaluateFlatRules(ladder, ctx150, {}, NOW).matches), ['esc:2']);
    const ctx120 = ctxOf(ruleSnapshot({ budget: { ...ruleSnapshot().budget, usedCredits: 120 } }));
    assert.deepEqual(ids(evaluateFlatRules(ladder, ctx120, {}, NOW).matches), ['esc:1']);
    const ctx320 = ctxOf(ruleSnapshot({ budget: { ...ruleSnapshot().budget, usedCredits: 320 } }));
    assert.deepEqual(ids(evaluateFlatRules(ladder, ctx320, {}, NOW).matches), ['esc:3']);
  });

  it('a winner on cooldown stays quiet instead of letting a lower level through', () => {
    const ctx150 = ctxOf(ruleSnapshot());
    const first = evaluateFlatRules(ladder, ctx150, {}, NOW);
    assert.deepEqual(ids(first.matches), ['esc:2']);
    const second = evaluateFlatRules(ladder, ctx150, first.state, NOW + 10 * 60_000);
    assert.deepEqual(ids(second.matches), [], 'esc:1 holds too but is shadowed by esc:2');
  });

  it('the first rule wins a severity tie, whatever its step number', () => {
    const tie = [level(7, 100, 'warning'), level(2, 120, 'warning')];
    assert.deepEqual(ids(evaluateFlatRules(tie, ctxOf(ruleSnapshot()), {}, NOW).matches), ['esc:7']);
  });

  it('ladders are per base id, and rules without a :<n> suffix never join one', () => {
    const rules = [
      level(1, 100, 'info'),
      level(2, 120, 'critical'),
      flatRule({ id: 'other:1', metric: 'month.credits', value: 100, severity: 'info' }),
      flatRule({ id: 'plain', metric: 'month.credits', value: 100, severity: 'info' }),
      flatRule({ id: 'with:colon:x', metric: 'month.credits', value: 100, severity: 'info' }),
    ];
    assert.deepEqual(ids(evaluateFlatRules(rules, ctxOf(ruleSnapshot()), {}, NOW).matches), ['esc:2', 'other:1', 'plain', 'with:colon:x']);
  });

  it('silent and restrict rules neither join a ladder nor hide a toasting level', () => {
    const rules = [
      level(1, 100, 'info'),
      level(2, 120, 'critical', { notify: false }),
      level(3, 130, 'critical', { restrict: true }),
    ];
    const matches = evaluateFlatRules(rules, ctxOf(ruleSnapshot()), {}, NOW).matches;
    assert.deepEqual(matches.map((m) => [m.rule.id, m.notify]), [['esc:1', true], ['esc:2', false], ['esc:3', false]]);
  });

  it('a ladder whose levels do not hold fires nothing, and a lone level behaves like a plain rule', () => {
    const ctx = ctxOf(ruleSnapshot({ budget: { ...ruleSnapshot().budget, usedCredits: 5 } }));
    assert.deepEqual(evaluateFlatRules(ladder, ctx, {}, NOW).matches, []);
    assert.deepEqual(ids(evaluateFlatRules([level(1, 100, 'info')], ctxOf(ruleSnapshot()), {}, NOW).matches), ['esc:1']);
  });
});

describe('pruneCooldowns', () => {
  const NOW = JAN31_2200;
  const rules = [
    flatRule({ id: 'short', metric: 'currentBranchCredits', cooldown: '30m' }),
    flatRule({ id: 'long', metric: 'currentBranchCredits', cooldown: '3d' }),
    flatRule({ id: 'daily', metric: 'today.credits', cooldown: '24h' }),
    flatRule({ id: 'month', metric: 'month.credits', cooldown: '4h' }),
  ];

  it('prunes each entry by its own rule cooldown, not a flat retention', () => {
    const state = {
      short: NOW - 31 * 60_000,
      long: NOW - 2 * 24 * H,
    };
    assert.deepEqual(pruneCooldowns(state, rules, NOW), { long: NOW - 2 * 24 * H });
    assert.deepEqual(pruneCooldowns({ short: NOW - 29 * 60_000, long: NOW - 4 * 24 * H }, rules, NOW), { short: NOW - 29 * 60_000 });
  });

  it('an entry exactly at its cooldown still blocks, so it is kept; one ms later it is forgotten', () => {
    assert.deepEqual(pruneCooldowns({ short: NOW - 30 * 60_000 }, rules, NOW), { short: NOW - 30 * 60_000 });
    assert.deepEqual(pruneCooldowns({ short: NOW - 30 * 60_000 - 1 }, rules, NOW), {});
  });

  it('finds the owner of a period key through the entry timestamp', () => {
    const state = { 'daily@2026-01-31': NOW - 2 * H, 'month@2026-01': NOW - 5 * H };
    assert.deepEqual(pruneCooldowns(state, rules, NOW), { 'daily@2026-01-31': NOW - 2 * H }, 'the 4 h month entry is stale, the 24 h daily one is not');
  });

  it('keeps entries no rule owns for the orphan retention (a removed rule, another branch)', () => {
    const state = { 'builtin:branch:other': NOW - 23 * H, 'gone@2026-01': NOW - 25 * H };
    assert.deepEqual(pruneCooldowns(state, rules, NOW), { 'builtin:branch:other': NOW - 23 * H });
    assert.equal(ORPHAN_COOLDOWN_RETENTION_MS, 24 * H);
    // A key whose period no longer matches its timestamp is nobody's, too.
    assert.deepEqual(pruneCooldowns({ 'daily@1999-01-01': NOW - H }, rules, NOW), { 'daily@1999-01-01': NOW - H });
  });

  it('drops entries from the future and returns a new object', () => {
    const state = { short: NOW + 1, long: NOW };
    const pruned = pruneCooldowns(state, rules, NOW);
    assert.deepEqual(pruned, { long: NOW });
    assert.deepEqual(state, { short: NOW + 1, long: NOW });
    assert.deepEqual(pruneCooldowns({}, rules, NOW), {});
  });

  it('prunes with no rules by the orphan retention, and keeps a __proto__ key as data', () => {
    assert.deepEqual(pruneCooldowns({ a: NOW - 25 * H, b: NOW - 1 }, [], NOW), { b: NOW - 1 });
    const state = parseCooldownState(JSON.parse('{"__proto__": 5}'));
    assert.deepEqual(Object.keys(pruneCooldowns(state, [], 6)), ['__proto__']);
  });
});

describe('parseCooldownState', () => {
  it('keeps finite numbers and drops everything else, entry by entry', () => {
    assert.deepEqual(parseCooldownState({ a: 1, b: 'x', c: null, d: NaN, e: Infinity, f: 2.5, g: {}, h: [1] }), { a: 1, f: 2.5 });
  });

  it('treats a non-object as empty', () => {
    for (const raw of [undefined, null, 'x', 5, true, [1, 2]]) assert.deepEqual(parseCooldownState(raw), {}, String(raw));
  });

  it('round-trips through JSON', () => {
    const state = { 'a@2026-01': 1_700_000_000_000, b: 5 };
    assert.deepEqual(parseCooldownState(JSON.parse(JSON.stringify(state))), state);
  });
});

describe('builtinFlatRules', () => {
  const base = {
    monthlyBudget: 0,
    dailyCreditAlert: 0,
    alerts: { velocityEnabled: false, velocityCreditsPerHour: 0 },
  };

  it('is empty with every knob off', () => {
    assert.deepEqual(builtinFlatRules(base), []);
    assert.deepEqual(builtinFlatRules(base, 'main'), []);
  });

  it('budget: the 80 % and 100 % pair, 4 h each, only with a monthly budget', () => {
    assert.deepEqual(builtinFlatRules({ ...base, monthlyBudget: 20 }), [
      { id: 'builtin:budget:80', metric: 'budget.percentOfBudget', op: '>=', value: 0.8, cooldown: '4h', severity: 'warning' },
      { id: 'builtin:budget:100', metric: 'budget.percentOfBudget', op: '>=', value: 1, cooldown: '4h', severity: 'critical' },
    ]);
    assert.deepEqual(builtinFlatRules({ ...base, monthlyBudget: -5 }), []);
  });

  it('daily: today.credits >= threshold, 24 h, only above zero', () => {
    assert.deepEqual(builtinFlatRules({ ...base, dailyCreditAlert: 50 }), [
      { id: 'builtin:daily', metric: 'today.credits', op: '>=', value: 50, cooldown: '24h', severity: 'warning' },
    ]);
    assert.deepEqual(builtinFlatRules({ ...base, dailyCreditAlert: -1 }), []);
  });

  it('velocity: needs both the switch and a positive rate, 1 h', () => {
    const velocity = (velocityEnabled: boolean, velocityCreditsPerHour: number) =>
      builtinFlatRules({ ...base, alerts: { velocityEnabled, velocityCreditsPerHour } });
    assert.deepEqual(velocity(true, 100), [
      { id: 'builtin:velocity', metric: 'velocity.creditsPerHour', op: '>=', value: 100, cooldown: '1h', severity: 'warning' },
    ]);
    assert.deepEqual(velocity(false, 100), []);
    assert.deepEqual(velocity(true, 0), []);
  });

  it('branch cap: only for the current branch, 4 h, id carries the branch', () => {
    const caps = { 'feature/x': 40, main: 0, other: 5 };
    assert.deepEqual(builtinFlatRules({ ...base, branchBudgets: caps }, 'feature/x'), [
      { id: 'builtin:branch:feature/x', metric: 'currentBranchCredits', op: '>=', value: 40, cooldown: '4h', severity: 'warning' },
    ]);
    assert.equal(builtinFlatRules({ ...base, branchBudgets: caps }, 'main')[0]?.value, 0, 'a cap of 0 is a cap (credits >= 0)');
    assert.deepEqual(builtinFlatRules({ ...base, branchBudgets: caps }, 'unlisted'), []);
    assert.deepEqual(builtinFlatRules({ ...base, branchBudgets: caps }, ''), []);
    assert.deepEqual(builtinFlatRules({ ...base, branchBudgets: caps }, null), []);
    assert.deepEqual(builtinFlatRules({ ...base, branchBudgets: caps }), []);
    assert.deepEqual(builtinFlatRules(base, 'feature/x'), []);
  });

  it('branch cap ignores inherited names and non-numeric caps', () => {
    assert.deepEqual(builtinFlatRules({ ...base, branchBudgets: {} }, 'constructor'), []);
    assert.deepEqual(builtinFlatRules({ ...base, branchBudgets: { x: 'lots' as unknown as number } }, 'x'), []);
  });

  it('lists the rules in the order the built-in alerts were evaluated', () => {
    const rules = builtinFlatRules(
      { monthlyBudget: 100, dailyCreditAlert: 50, alerts: { velocityEnabled: true, velocityCreditsPerHour: 100 }, branchBudgets: { b: 1 } },
      'b',
    );
    assert.deepEqual(rules.map((r) => r.id), [
      BUILTIN_RULE_IDS.budget80,
      BUILTIN_RULE_IDS.budget100,
      BUILTIN_RULE_IDS.daily,
      BUILTIN_RULE_IDS.velocity,
      `${BUILTIN_RULE_IDS.branchPrefix}b`,
    ]);
  });
});

describe('builtin budget pair — one toast per band', () => {
  const NOW = new Date(2026, 0, 15, 12, 0).getTime(); // mid-month, so +4 h stays under the same month key
  const rules = builtinFlatRules({ monthlyBudget: 100, dailyCreditAlert: 0, alerts: { velocityEnabled: false, velocityCreditsPerHour: 0 } });
  const atPct = (pct: number) => ctxOf(ruleSnapshot({ budget: { ...ruleSnapshot().budget, percentOfBudget: pct } }));
  const fired = (pct: number, state = {}, now = NOW) => evaluateFlatRules(rules, atPct(pct), state, now).matches.map((m) => m.rule.id);

  it('below 80 % nothing, in the 80-100 % band the 80 % toast, at or over 100 % only the exceeded toast', () => {
    assert.deepEqual(fired(0.79), []);
    assert.deepEqual(fired(0.8), ['builtin:budget:80']);
    assert.deepEqual(fired(0.9999999), ['builtin:budget:80']);
    assert.deepEqual(fired(1), ['builtin:budget:100']);
    assert.deepEqual(fired(3), ['builtin:budget:100']);
  });

  it('jumping straight over 100 % toasts once, and the exceeded toast on cooldown does not fall back to the 80 % one', () => {
    const first = evaluateFlatRules(rules, atPct(1.2), {}, NOW);
    assert.deepEqual(first.matches.map((m) => m.rule.id), ['builtin:budget:100']);
    assert.deepEqual(fired(1.2, first.state, NOW + H), []);
    assert.deepEqual(fired(1.2, first.state, NOW + 4 * H), [], 'exactly 4 h later is still the cooldown');
    assert.deepEqual(fired(1.2, first.state, NOW + 4 * H + 1), ['builtin:budget:100']);
  });

  it('80 % then 100 %: each band toasts once under its own key', () => {
    const at80 = evaluateFlatRules(rules, atPct(0.85), {}, NOW);
    assert.deepEqual(at80.matches.map((m) => m.rule.id), ['builtin:budget:80']);
    const at100 = evaluateFlatRules(rules, atPct(1.01), at80.state, NOW + H);
    assert.deepEqual(at100.matches.map((m) => m.rule.id), ['builtin:budget:100']);
  });
});

describe('FlatAlertRuleSchema and parseFlatRules', () => {
  const good = { id: 'a', metric: 'today.credits', op: '>', value: 5, cooldown: '2h', severity: 'critical', notify: false, restrict: true, clearBelow: 3 };

  it('accepts a full rule unchanged', () => {
    const r = parseFlatRules([good]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rules, [good]);
    assert.deepEqual(FlatAlertRuleSchema.parse(good), good);
  });

  it('defaults cooldown to 1h and severity to warning, and leaves the optional fields out', () => {
    const r = parseFlatRules([{ id: 'a', metric: 'model:gpt-4.1.cost', op: '<=', value: 0 }]);
    assert.deepEqual(r.rules, [{ id: 'a', metric: 'model:gpt-4.1.cost', op: '<=', value: 0, cooldown: '1h', severity: 'warning' }]);
    assert.equal('notify' in r.rules[0]!, false);
    assert.equal('clearBelow' in r.rules[0]!, false);
  });

  it('ignores unknown keys (a leftover legacy message)', () => {
    const r = parseFlatRules([{ ...good, message: 'x {{today.credits}}', extra: 1 }]);
    assert.deepEqual(r.rules, [good]);
  });

  it('drops one bad rule, reports why, and keeps its siblings', () => {
    const r = parseFlatRules([
      good,
      { ...good, id: 'bad-metric', metric: 'today.tokens' },
      { ...good, id: 'bad-op', op: '=>' },
      { ...good, id: 'bad-value', value: '5' },
      { ...good, id: 'nan', value: NaN },
      { ...good, id: 'inf', value: Infinity },
      { ...good, id: 'bad-cooldown', cooldown: '0m' },
      { ...good, id: 'bad-cooldown2', cooldown: 'soon' },
      { ...good, id: 'bad-severity', severity: 'fatal' },
      { ...good, id: 'bad-notify', notify: 'yes' },
      { ...good, id: 'bad-restrict', restrict: 1 },
      { ...good, id: 'bad-clear', clearBelow: 'x' },
      { ...good, id: '' },
      { ...good, id: 7 },
      { metric: 'today.credits' },
      null,
      'text',
      42,
      { ...good, id: 'z' },
    ]);
    assert.deepEqual(r.rules.map((x) => x.id), ['a', 'z']);
    assert.deepEqual(
      r.errors.map((e) => [e.index, e.id]),
      [
        [1, 'bad-metric'], [2, 'bad-op'], [3, 'bad-value'], [4, 'nan'], [5, 'inf'], [6, 'bad-cooldown'], [7, 'bad-cooldown2'],
        [8, 'bad-severity'], [9, 'bad-notify'], [10, 'bad-restrict'], [11, 'bad-clear'], [12, ''], [13, undefined],
        [14, undefined], [15, undefined], [16, undefined], [17, undefined],
      ],
    );
    assert.match(r.errors[0]!.message, /^metric: unknown metric \(use today\.credits, /);
    assert.match(r.errors[5]!.message, /^cooldown: cooldown must be a positive number followed by m, h, d or w/);
    assert.match(r.errors[13]!.message, /^id: /);
    assert.match(r.errors[14]!.message, /Invalid input|expected object/i, 'a non-object entry has no path');
  });

  it('drops a second rule with an id already taken, naming it', () => {
    const r = parseFlatRules([good, { ...good, value: 99 }, { ...good, id: 'b' }]);
    assert.deepEqual(r.rules.map((x) => x.id), ['a', 'b']);
    assert.deepEqual(r.errors, [{ index: 1, id: 'a', message: 'duplicate rule id "a"' }]);
  });

  it('treats an absent list as empty, and a non-array as one list-level error', () => {
    assert.deepEqual(parseFlatRules(undefined), { rules: [], errors: [] });
    assert.deepEqual(parseFlatRules([]), { rules: [], errors: [] });
    for (const raw of [null, {}, 'rules', 5]) {
      assert.deepEqual(parseFlatRules(raw), { rules: [], errors: [{ index: -1, id: undefined, message: 'alert rules must be an array' }] }, String(raw));
    }
  });

  it('accepts every keyed and fixed metric the registry lists', () => {
    const rules = [...FIXED_FLAT_METRICS, 'model:gpt-4.1.credits', 'repo:foo.js.cost'].map((metric, i) => ({ id: `r${i}`, metric, op: '>', value: 1 }));
    const r = parseFlatRules(rules);
    assert.deepEqual(r.errors, []);
    assert.equal(r.rules.length, rules.length);
  });
});

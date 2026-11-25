import { strict as assert } from 'assert';
import type { FlatAlertRule } from '../../src/extension-backend/domain/contracts';
import { convertLegacyRules, mapLegacyVar } from '../../src/extension-backend/domain/flatAlertImport';
import { builtinFlatRules } from '../../src/extension-backend/domain/flatAlerts';
import type { AlertGroup, AlertRule } from '../../src/extension-backend/domain/types';

const rule = (over: Partial<AlertRule> & { id: string }): AlertRule => ({ severity: 'warning', message: 'm', ...over }) as AlertRule;
const cond = (field: string, op: string, value: unknown) => ({ field, op, value }) as never;

const convert = (...rules: AlertRule[]) => convertLegacyRules(rules);
const onlySkip = (r: AlertRule, groups?: AlertGroup[], now?: number) => {
  const out = convertLegacyRules([r], groups, now === undefined ? {} : { now });
  assert.equal(out.converted.length, 0, `expected ${r.id} to be skipped, got ${JSON.stringify(out.converted)}`);
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0]!.id, r.id);
  return out.skipped[0]!.reason;
};
const only = (r: AlertRule, options = {}): FlatAlertRule[] => {
  const out = convertLegacyRules([r], [], options);
  assert.deepEqual(out.skipped, [], `expected ${r.id} to convert`);
  return out.converted;
};

describe('mapLegacyVar — variable paths to metrics', () => {
  it('maps every documented path that has a flat equivalent', () => {
    const mapped: Array<[string, string]> = [
      ['today.credits', 'today.credits'],
      ['today.cost', 'today.cost'],
      ['month.credits', 'month.credits'],
      ['month.cost', 'month.cost'],
      ['budget.usedCredits', 'month.credits'],
      ['budget.usedCost', 'month.cost'],
      ['budget.percentOfBudget', 'budget.percentOfBudget'],
      ['budget.percentOfIncluded', 'budget.percentOfIncluded'],
      ['forecast.projectedCredits', 'forecast.projectedCredits'],
      ['forecast.projectedCost', 'forecast.projectedCost'],
      ['velocity.creditsPerHour', 'velocity.creditsPerHour'],
      ['window7d.credits', 'window7d.credits'],
      ['currentBranchCredits', 'currentBranchCredits'],
      ['model.gpt-4o.credits', 'model:gpt-4o.credits'],
      ['model.gpt-4o.cost', 'model:gpt-4o.cost'],
      ['model["gpt-4.1"].credits', 'model:gpt-4.1.credits'],
      ["model['gpt-4.1'].cost", 'model:gpt-4.1.cost'],
      ['repo.my-app.credits', 'repo:my-app.credits'],
      ['repo["foo.js"].cost', 'repo:foo.js.cost'],
      ['today["credits"]', 'today.credits'],
    ];
    for (const [path, metric] of mapped) assert.deepEqual(mapLegacyVar(path), { ok: true, value: metric }, path);
  });

  it('refuses every other documented path, with the reason for its kind', () => {
    const refused: Array<[string, RegExp]> = [
      ['today.tokens', /token counts/],
      ['month.tokens', /token counts/],
      ['window7d.tokens', /token counts/],
      ['model.gpt-4o.tokens', /token counts/],
      ['repo.x.tokens', /token counts/],
      ['window7d.cost', /no flat-alert metric/],
      ['budget.monthly', /no flat-alert metric/],
      ['budget.projectedOverage', /no flat-alert metric/],
      ['budget.pace', /no flat-alert metric/],
      ['forecast.low', /no flat-alert metric/],
      ['forecast.high', /no flat-alert metric/],
      ['forecast.basis', /no flat-alert metric/],
      ['velocity.costPerHour', /no flat-alert metric/],
      ['velocity.windowMinutes', /no flat-alert metric/],
      ['topModel.id', /top-model/],
      ['topModel.credits', /top-model/],
      ['topSurface.credits', /top-model/],
      ['topRepo.credits', /top-model/],
      ['surface.chat.credits', /top-model/],
      ['billing.netAmount', /billing/],
      ['billing.quotaPercentRemaining', /billing/],
      ['signedIn', /billing/],
      ['now.weekday', /time-of-day/],
      ['now.hour', /time-of-day/],
      ['now["iso"]', /time-of-day/],
      ['currentBranch', /no flat-alert metric/],
      ['branchBudgets["release/1.2"]', /branchBudgets setting/],
      ['vars.alertThreshold', /user variables/],
      ['group.work-hours', /rule groups/],
      ['group["work-hours"]', /rule groups/],
      ['model.gpt-4o', /no flat-alert metric/],
      ['model.gpt-4o.credits.extra', /no flat-alert metric/],
      ['model..credits', /no flat-alert metric/],
      ['constructor', /no flat-alert metric/],
      ['__proto__.credits', /no flat-alert metric/],
      ['today.constructor', /no flat-alert metric/],
    ];
    for (const [path, reason] of refused) {
      const r = mapLegacyVar(path);
      assert.equal(r.ok, false, path);
      assert.match((r as { reason: string }).reason, reason, path);
      assert.match((r as { reason: string }).reason, new RegExp(`^"${path.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')}"`), 'the reason names the path');
    }
  });

  it('reports a malformed path', () => {
    assert.deepEqual(mapLegacyVar('model["unterminated'), { ok: false, reason: '"model["unterminated" is not a valid variable path' });
  });
});

describe('convertLegacyRules — convertible shapes', () => {
  it('a single structured condition becomes one flat rule; severity, cooldown, notify and restrict carry over', () => {
    const [flat] = only(
      rule({ id: 'busy', severity: 'critical', cooldown: '2h', conditions: [cond('today.credits', '>', 80)], notify: false, restrict: {} }),
    );
    assert.deepEqual(flat, {
      id: 'busy',
      metric: 'today.credits',
      op: '>',
      value: 80,
      cooldown: '2h',
      severity: 'critical',
      notify: false,
      restrict: true,
    });
  });

  it('defaults: warning severity and a 1h cooldown when the rule names none; notify and restrict stay unset', () => {
    const [flat] = only(rule({ id: 'a', conditions: [cond('month.cost', '>=', 5)] }));
    assert.deepEqual(flat, { id: 'a', metric: 'month.cost', op: '>=', value: 5, cooldown: '1h', severity: 'warning' });
    assert.equal(only(rule({ id: 'b', conditions: [cond('month.cost', '<', 5)], notify: true }))[0]!.notify, true);
  });

  it('every comparison operator converts, with match "all" and "any" meaning the same for one condition', () => {
    for (const op of ['>', '>=', '<', '<=', '==', '!='] as const) {
      for (const match of [undefined, 'all', 'any'] as const) {
        const [flat] = only(rule({ id: 'x', conditions: [cond('today.credits', op, 1)], ...(match ? { match } : {}) }));
        assert.equal(flat!.op, op);
      }
    }
  });

  it('a `when` that is one comparison of a var against a literal converts, var on either side', () => {
    const left = only(rule({ id: 'l', when: { '>': [{ var: 'velocity.creditsPerHour' }, 90] } }))[0]!;
    assert.deepEqual([left.metric, left.op, left.value], ['velocity.creditsPerHour', '>', 90]);
    const swapped: Array<[string, FlatAlertRule['op']]> = [['>', '<'], ['>=', '<='], ['<', '>'], ['<=', '>='], ['==', '=='], ['!=', '!=']];
    for (const [op, flatOp] of swapped) {
      const [flat] = only(rule({ id: 'r', when: { [op]: [50, { var: 'today.credits' }] } as never }));
      assert.deepEqual([flat!.op, flat!.value], [flatOp, 50], `50 ${op} today.credits`);
    }
  });

  it('numeric text counts as a number, exactly like the legacy comparison', () => {
    assert.equal(only(rule({ id: 'a', conditions: [cond('today.credits', '>', '12.5')] }))[0]!.value, 12.5);
    assert.equal(only(rule({ id: 'b', when: { '<': [{ var: 'today.credits' }, '1e3'] } }))[0]!.value, 1000);
  });

  it('keyed model and repo vars convert, bracket syntax included', () => {
    const [m, r] = convert(
      rule({ id: 'm', when: { '>': [{ var: 'model["claude-sonnet-4-5-20250929"].credits' }, 120] } }),
      rule({ id: 'r', conditions: [cond("repo['foo.js'].cost", '>=', 3)] }),
    ).converted;
    assert.equal(m!.metric, 'model:claude-sonnet-4-5-20250929.credits');
    assert.equal(r!.metric, 'repo:foo.js.cost');
  });

  it('thresholds: each level becomes its own rule <id>:<n> with its severity and cooldown', () => {
    const out = only(
      rule({
        id: 'esc',
        severity: 'info',
        cooldown: '3h',
        notify: false,
        thresholds: [
          { field: 'month.credits', op: '>', value: 200, severity: 'info', cooldown: '45m' },
          { field: 'month.credits', op: '>', value: 260, severity: 'warning' },
          { field: 'month.cost', op: '>=', value: 90, severity: 'critical', cooldown: 'bogus' },
        ],
      }),
    );
    assert.deepEqual(
      out.map((r) => [r.id, r.metric, r.op, r.value, r.severity, r.cooldown, r.notify]),
      [
        ['esc:1', 'month.credits', '>', 200, 'info', '45m', false],
        ['esc:2', 'month.credits', '>', 260, 'warning', '3h', false],
        ['esc:3', 'month.cost', '>=', 90, 'critical', '3h', false],
      ],
      'a level cooldown wins, then the rule cooldown, and an unusable one falls through',
    );
    const noCooldown = only(rule({ id: 'e', thresholds: [{ field: 'today.credits', op: '>', value: 1, severity: 'info' }] }));
    assert.deepEqual([noCooldown[0]!.id, noCooldown[0]!.cooldown], ['e:1', '1h']);
  });

  it('precedence is the legacy one: thresholds > when > conditions; the lower forms are ignored', () => {
    const all = rule({
      id: 'p',
      thresholds: [{ field: 'today.credits', op: '>', value: 1, severity: 'info' }],
      when: { '>': [{ var: 'today.cost' }, 2] },
      conditions: [cond('month.cost', '>', 3)],
    });
    assert.deepEqual(only(all).map((r) => [r.id, r.metric]), [['p:1', 'today.credits']]);
    const whenAndConditions = rule({ id: 'q', when: { '>': [{ var: 'today.cost' }, 2] }, conditions: [cond('a', 'matches', 'x'), cond('b', 'in', [1])] });
    assert.deepEqual(only(whenAndConditions).map((r) => r.metric), ['today.cost']);
    // an empty thresholds array does not count
    assert.deepEqual(only(rule({ id: 'e', thresholds: [], conditions: [cond('today.cost', '>', 3)] })).map((r) => r.metric), ['today.cost']);
  });

  it('restrict: {} becomes restrict: true; reEnableWhen < or <= the same metric becomes clearBelow', () => {
    const base = { id: 'ob', severity: 'critical' as const, when: { '>=': [{ var: 'budget.percentOfBudget' }, 1] } as never };
    const lt = only(rule({ ...base, restrict: { reEnableWhen: { '<': [{ var: 'budget.percentOfBudget' }, 0.9] } } }))[0]!;
    assert.deepEqual([lt.restrict, lt.clearBelow], [true, 0.9]);
    const le = only(rule({ ...base, restrict: { reEnableWhen: { '<=': [{ var: 'budget.percentOfBudget' }, 0.85] } } }))[0]!;
    assert.equal(le.clearBelow, 0.85);
    const swapped = only(rule({ ...base, restrict: { reEnableWhen: { '>': [0.8, { var: 'budget.percentOfBudget' }] } } }))[0]!;
    assert.equal(swapped.clearBelow, 0.8, '0.8 > pct is pct < 0.8');
    const plain = only(rule({ ...base, restrict: {} }))[0]!;
    assert.equal(plain.restrict, true);
    assert.equal('clearBelow' in plain, false);
    assert.equal('restrict' in only(rule({ ...base }))[0]!, false);
  });

  it('every threshold level of a restrict rule restricts, each with its own clearBelow', () => {
    const out = only(
      rule({
        id: 'lv',
        thresholds: [
          { field: 'today.credits', op: '>', value: 100, severity: 'warning' },
          { field: 'today.credits', op: '>', value: 200, severity: 'critical' },
        ],
        restrict: { reEnableWhen: { '<': [{ var: 'today.credits' }, 50] } },
      }),
    );
    assert.deepEqual(out.map((r) => [r.id, r.restrict, r.clearBelow]), [['lv:1', true, 50], ['lv:2', true, 50]]);
  });

  it('an expired or invalid snoozeUntil does not block the conversion when `now` is given', () => {
    const r = (snoozeUntil: string) => rule({ id: 's', snoozeUntil, conditions: [cond('today.credits', '>', 1)] });
    const now = Date.parse('2026-02-01T12:00:00Z');
    assert.equal(only(r('2026-02-01T11:00:00Z'), { now }).length, 1);
    assert.equal(only(r('2026-02-01T12:00:00Z'), { now }).length, 1, 'snoozed until exactly now is over');
    assert.equal(only(r('not a date')).length, 1, 'an unparseable date never snoozes, with or without a clock');
    assert.equal(only(r('not a date'), { now }).length, 1);
  });

  it('keeps the order of the rules and converts each independently of its siblings', () => {
    const { converted, skipped } = convert(
      rule({ id: 'a', conditions: [cond('today.credits', '>', 1)] }),
      rule({ id: 'bad', requiresAuth: true, conditions: [cond('today.credits', '>', 1)] }),
      rule({ id: 'c', thresholds: [{ field: 'today.cost', op: '>', value: 1, severity: 'info' }] }),
    );
    assert.deepEqual(converted.map((r) => r.id), ['a', 'c:1']);
    assert.deepEqual(skipped.map((s) => s.id), ['bad']);
    assert.deepEqual(convertLegacyRules([]), { converted: [], skipped: [] });
  });
});

describe('convertLegacyRules — skipped, with a precise reason', () => {
  it('and / or / not', () => {
    for (const key of ['and', 'or'] as const) {
      const reason = onlySkip(rule({ id: key, when: { [key]: [{ '>': [{ var: 'today.credits' }, 1] }, true] } as never }));
      assert.equal(reason, `"when": it uses "${key}", and flat rules are a single comparison of one metric`);
    }
    assert.match(onlySkip(rule({ id: 'n', when: { not: { '>': [{ var: 'today.credits' }, 1] } } as never })), /it uses "not"/);
  });

  it('a bare var, a boolean and a malformed `when`', () => {
    assert.equal(onlySkip(rule({ id: 'v', when: { var: 'today.credits' } })), '"when": it is a truthy check on a variable, which has no flat equivalent');
    assert.equal(onlySkip(rule({ id: 't', when: true })), '"when": it is the constant condition true');
    assert.equal(onlySkip(rule({ id: 'f', when: false })), '"when": it is the constant condition false');
    assert.equal(onlySkip(rule({ id: 'm', when: { '>': 5 } as never })), '"when": it is not a comparison of two operands');
    assert.equal(onlySkip(rule({ id: 'm2', when: { '>': [1] } as never })), '"when": it is not a comparison of two operands');
    assert.equal(onlySkip(rule({ id: 'o', when: { '~': [{ var: 'today.credits' }, 1] } as never })), '"when": the operator "~" is not supported (use > >= < <= == !=)');
    assert.equal(onlySkip(rule({ id: 'e', when: {} as never })), '"when": it is not a comparison of two operands');
  });

  it('operands: two variables, two literals, a non-numeric literal, an unmappable var', () => {
    assert.equal(
      onlySkip(rule({ id: 'vv', when: { '>': [{ var: 'today.credits' }, { var: 'vars.alertThreshold' }] } })),
      '"when": it compares two variables (today.credits and vars.alertThreshold), and flat rules compare a metric with a number',
    );
    assert.equal(onlySkip(rule({ id: 'll', when: { '>': [1, 2] } })), '"when": it compares two literal values, so it does not depend on any metric');
    assert.equal(onlySkip(rule({ id: 'ls', when: { '==': [{ var: 'currentBranchCredits' }, 'high'] } })), '"when": the value "high" is not a number');
    assert.equal(onlySkip(rule({ id: 'lb', when: { '==': [{ var: 'currentBranchCredits' }, true] } })), '"when": the value true is not a number');
    assert.equal(onlySkip(rule({ id: 'lbl', when: { '==': [true, { var: 'currentBranchCredits' }] } })), '"when": the value true is not a number');
    assert.equal(onlySkip(rule({ id: 'uv', when: { '>': [{ var: 'today.tokens' }, 5] } })), '"when": "today.tokens": token counts are not flat metrics');
    assert.equal(onlySkip(rule({ id: 'nv', when: { '>': [{ var: 'now.hour' }, 5] } })), '"when": "now.hour": time-of-day values (now.*) are not flat metrics');
  });

  it('in, matches, several conditions and match "none"', () => {
    assert.equal(onlySkip(rule({ id: 'in', conditions: [cond('model.gpt-4o.credits', 'in', [1, 2])] })), 'condition: the operator "in" is not supported');
    assert.equal(onlySkip(rule({ id: 'mt', conditions: [cond('topModel.id', 'matches', '^claude-')] })), 'condition: the operator "matches" is not supported');
    assert.equal(
      onlySkip(rule({ id: 'two', conditions: [cond('today.credits', '>', 1), cond('month.credits', '>', 2)] })),
      'it has 2 conditions, and flat rules are a single comparison',
    );
    assert.equal(
      onlySkip(rule({ id: 'none', match: 'none', conditions: [cond('today.credits', '>', 1)] })),
      'match "none" negates the condition, which flat rules cannot express',
    );
    assert.equal(onlySkip(rule({ id: 'arr', conditions: [cond('today.credits', '>', [1, 2])] })), 'condition: the value [1,2] is not a number');
    assert.equal(onlySkip(rule({ id: 'empty' })), 'it has no thresholds, "when" or conditions');
    assert.equal(onlySkip(rule({ id: 'empty2', conditions: [] })), 'it has no thresholds, "when" or conditions');
  });

  it('one bad threshold level skips the whole rule and names the level', () => {
    assert.equal(
      onlySkip(
        rule({
          id: 'th',
          thresholds: [
            { field: 'today.credits', op: '>', value: 1, severity: 'info' },
            { field: 'billing.netAmount', op: '>', value: 5, severity: 'warning' },
          ],
        }),
      ),
      'threshold level 2: "billing.netAmount": GitHub billing values are not flat metrics',
    );
    assert.equal(
      onlySkip(rule({ id: 'th2', thresholds: [{ field: 'model.x.credits', op: 'matches', value: 'x', severity: 'info' }] })),
      'threshold level 1: the operator "matches" is not supported',
    );
  });

  it('the gates: requiresAuth, active (groups included) and a snoozeUntil still in the future', () => {
    const base = { conditions: [cond('today.credits', '>', 1)] };
    assert.equal(onlySkip(rule({ id: 'auth', requiresAuth: true, ...base })), 'requiresAuth: flat rules cannot depend on being signed in to GitHub');
    assert.equal(only(rule({ id: 'auth-off', requiresAuth: false, ...base })).length, 1);
    assert.equal(onlySkip(rule({ id: 'act', active: { '!=': [{ var: 'now.weekday' }, 0] }, ...base })), 'it has an "active" gate, and flat rules have no extra conditions');
    assert.equal(onlySkip(rule({ id: 'act2', active: true, ...base })), 'it has an "active" gate, and flat rules have no extra conditions');
    assert.equal(onlySkip(rule({ id: 'act3', active: { var: 'vars.on' }, ...base })), 'it has an "active" gate, and flat rules have no extra conditions');
    assert.equal(onlySkip(rule({ id: 'act4', active: { var: 'model["x"].credits' }, ...base })), 'it has an "active" gate, and flat rules have no extra conditions');
    assert.equal(onlySkip(rule({ id: 'snz', snoozeUntil: '2999-01-01T00:00:00Z', ...base })), 'it is snoozed until 2999-01-01T00:00:00Z');
    assert.equal(onlySkip(rule({ id: 'snz2', snoozeUntil: '2026-02-01T05:00:00Z', ...base })), 'it is snoozed until 2026-02-01T05:00:00Z', 'without `now` any dated snooze skips');
    assert.equal(onlySkip(rule({ id: 'snz3', snoozeUntil: '2999-01-01T00:00:00Z', ...base }), [], Date.now()), 'it is snoozed until 2999-01-01T00:00:00Z');
  });

  it('a group-gated rule names its group and whether the group is on, off or conditional', () => {
    const base = { conditions: [cond('today.credits', '>', 1)] };
    const groups: AlertGroup[] = [
      { id: 'work-hours', label: 'Work', active: true },
      { id: 'off-hours', active: false },
      { id: 'cond', active: { '>': [{ var: 'now.hour' }, 8] } },
    ];
    const gated = (id: string) => rule({ id: `r-${id}`, active: { var: `group.${id}` }, ...base });
    assert.equal(onlySkip(gated('work-hours'), groups), 'it belongs to the rule group "work-hours" (currently on), and groups are not supported');
    assert.equal(onlySkip(gated('off-hours'), groups), 'it belongs to the rule group "off-hours" (currently off), and groups are not supported');
    assert.equal(onlySkip(gated('cond'), groups), 'it belongs to the rule group "cond", and groups are not supported');
    assert.equal(onlySkip(gated('missing'), groups), 'it belongs to the rule group "missing", and groups are not supported');
    assert.equal(onlySkip(gated('work-hours')), 'it belongs to the rule group "work-hours", and groups are not supported', 'groups are optional');
    assert.equal(onlySkip(rule({ id: 'br', active: { var: 'group["work-hours"]' }, ...base }), groups), 'it belongs to the rule group "work-hours" (currently on), and groups are not supported');
  });

  it('every reason is reported when a rule fails the gates and the trigger', () => {
    const reason = onlySkip(
      rule({ id: 'both', requiresAuth: true, active: true, when: { and: [true] } as never }),
    );
    assert.equal(
      reason,
      'requiresAuth: flat rules cannot depend on being signed in to GitHub; "when": it uses "and", and flat rules are a single comparison of one metric',
    );
  });

  it('a restrict.reEnableWhen that is not "<" / "<=" the same metric skips the rule', () => {
    const base = { id: 'ob', when: { '>=': [{ var: 'budget.percentOfBudget' }, 1] } as never };
    const skipWith = (reEnableWhen: unknown) => onlySkip(rule({ ...base, restrict: { reEnableWhen: reEnableWhen as never } }));
    assert.equal(
      skipWith({ '>': [{ var: 'budget.percentOfBudget' }, 0.5] }),
      'restrict.reEnableWhen must be "budget.percentOfBudget <" (or "<=") a number to become clearBelow',
    );
    assert.equal(
      skipWith({ '<': [{ var: 'today.credits' }, 5] }),
      'restrict.reEnableWhen must be "budget.percentOfBudget <" (or "<=") a number to become clearBelow',
    );
    assert.equal(skipWith({ '==': [{ var: 'budget.percentOfBudget' }, 0] }), 'restrict.reEnableWhen must be "budget.percentOfBudget <" (or "<=") a number to become clearBelow');
    assert.equal(
      skipWith({ and: [{ '<': [{ var: 'budget.percentOfBudget' }, 0.9] }, true] }),
      'restrict.reEnableWhen cannot be converted (it uses "and", and flat rules are a single comparison of one metric)',
    );
    assert.equal(skipWith(true), 'restrict.reEnableWhen cannot be converted (it is the constant condition true)');
    assert.match(skipWith({ '<': [{ var: 'vars.limit' }, 5] }), /^restrict\.reEnableWhen cannot be converted \("vars\.limit": user variables/);
  });

  it('a restrict.reEnableWhen failure on one threshold level names the level', () => {
    const reason = onlySkip(
      rule({
        id: 'lv',
        thresholds: [
          { field: 'today.credits', op: '>', value: 100, severity: 'warning' },
          { field: 'month.credits', op: '>', value: 200, severity: 'critical' },
        ],
        restrict: { reEnableWhen: { '<': [{ var: 'today.credits' }, 50] } },
      }),
    );
    assert.equal(reason, 'threshold level 2: restrict.reEnableWhen must be "month.credits <" (or "<=") a number to become clearBelow');
  });

  it('a repeated id is skipped (flat rule ids key the cooldowns), even across a thresholds level', () => {
    const out = convert(
      rule({ id: 'a', conditions: [cond('today.credits', '>', 1)] }),
      rule({ id: 'a', conditions: [cond('today.credits', '>', 2)] }),
      rule({ id: 'b', thresholds: [{ field: 'today.credits', op: '>', value: 1, severity: 'info' }] }),
      rule({ id: 'b:1', conditions: [cond('today.credits', '>', 3)] }),
    );
    assert.deepEqual(out.converted.map((r) => r.id), ['a', 'b:1']);
    assert.deepEqual(out.skipped, [
      { id: 'a', reason: 'its id "a" is already used by another converted rule' },
      { id: 'b:1', reason: 'its id "b:1" is already used by another converted rule' },
    ]);
  });

  it('an unconverted rule never leaves a half-converted set behind', () => {
    const out = convert(
      rule({
        id: 'half',
        thresholds: [
          { field: 'today.credits', op: '>', value: 1, severity: 'info' },
          { field: 'today.tokens', op: '>', value: 1, severity: 'info' },
        ],
      }),
    );
    assert.deepEqual(out.converted, []);
    assert.equal(out.skipped.length, 1);
  });
});

// ── The example rules in docs/reference/alert-rules.md and docs/guide/{configuration,features}.md ──
//
// Inlined, not read from the docs: the docs are rewritten for flat rules and this
// table documents how each OLD example is migrated.

describe('convertLegacyRules — the documented example rules', () => {
  const WORK_HOURS: AlertGroup[] = [{ id: 'work-hours', label: 'Work-hour rules', active: true }];

  const docs: Array<{ where: string; rule: AlertRule; groups?: AlertGroup[]; result: 'converted' | 'skipped'; detail: unknown }> = [
    {
      where: 'alert-rules.md, operators: `{ ">": [{ "var": "today.credits" }, 100] }`',
      rule: rule({ id: 'op-gt', when: { '>': [{ var: 'today.credits' }, 100] } }),
      result: 'converted',
      detail: [{ id: 'op-gt', metric: 'today.credits', op: '>', value: 100, cooldown: '1h', severity: 'warning' }],
    },
    {
      where: 'alert-rules.md, operators: `and` of two comparisons',
      rule: rule({ id: 'op-and', when: { and: [{ '>': [{ var: 'today.credits' }, 1] }, { '<': [{ var: 'today.cost' }, 2] }] } }),
      result: 'skipped',
      detail: '"when": it uses "and", and flat rules are a single comparison of one metric',
    },
    {
      where: 'alert-rules.md, operators: `not`',
      rule: rule({ id: 'op-not', when: { not: { '>': [{ var: 'today.credits' }, 1] } } }),
      result: 'skipped',
      detail: '"when": it uses "not", and flat rules are a single comparison of one metric',
    },
    {
      where: 'alert-rules.md, operators: truthy `var`',
      rule: rule({ id: 'op-var', when: { var: 'today.credits' } }),
      result: 'skipped',
      detail: '"when": it is a truthy check on a variable, which has no flat equivalent',
    },
    {
      where: 'alert-rules.md, operators: literal `true`',
      rule: rule({ id: 'op-true', when: true }),
      result: 'skipped',
      detail: '"when": it is the constant condition true',
    },
    {
      where: 'alert-rules.md, structured conditions: `{ "field": "today.credits", "op": ">", "value": 100 }`',
      rule: rule({ id: 'sc', conditions: [cond('today.credits', '>', 100)] }),
      result: 'converted',
      detail: [{ id: 'sc', metric: 'today.credits', op: '>', value: 100, cooldown: '1h', severity: 'warning' }],
    },
    {
      where: 'alert-rules.md, structured conditions: `in`',
      rule: rule({ id: 'sc-in', conditions: [cond('model.gpt-4o.credits', 'in', [1, 2])] }),
      result: 'skipped',
      detail: 'condition: the operator "in" is not supported',
    },
    {
      where: 'alert-rules.md, structured conditions: `matches` "^claude-"',
      rule: rule({ id: 'sc-matches', conditions: [cond('topModel.id', 'matches', '^claude-')] }),
      result: 'skipped',
      detail: 'condition: the operator "matches" is not supported',
    },
    {
      where: 'alert-rules.md, match "any" over several conditions',
      rule: rule({ id: 'sc-any', match: 'any', conditions: [cond('today.credits', '>', 1), cond('month.credits', '>', 2)] }),
      result: 'skipped',
      detail: 'it has 2 conditions, and flat rules are a single comparison',
    },
    {
      where: 'alert-rules.md, variable paths: `model["gpt-4.1"].credits`',
      rule: rule({ id: 'vp-model', when: { '>': [{ var: 'model["gpt-4.1"].credits' }, 10] } }),
      result: 'converted',
      detail: [{ id: 'vp-model', metric: 'model:gpt-4.1.credits', op: '>', value: 10, cooldown: '1h', severity: 'warning' }],
    },
    {
      where: "alert-rules.md, variable paths: `repo['foo.js'].cost`",
      rule: rule({ id: 'vp-repo', when: { '>': [{ var: "repo['foo.js'].cost" }, 5] } }),
      result: 'converted',
      detail: [{ id: 'vp-repo', metric: 'repo:foo.js.cost', op: '>', value: 5, cooldown: '1h', severity: 'warning' }],
    },
    {
      where: 'alert-rules.md, context: `branchBudgets["release/1.2"]` compared with `currentBranchCredits`',
      rule: rule({ id: 'ctx-branch', when: { '>': [{ var: 'currentBranchCredits' }, { var: 'branchBudgets["release/1.2"]' }] } }),
      result: 'skipped',
      detail: '"when": it compares two variables (currentBranchCredits and branchBudgets["release/1.2"]), and flat rules compare a metric with a number',
    },
    {
      where: 'alert-rules.md, `thresholds` escalation',
      rule: rule({
        id: 'th',
        severity: 'info',
        thresholds: [
          { field: 'month.credits', op: '>', value: 200, severity: 'info', cooldown: '45m' },
          { field: 'month.credits', op: '>', value: 300, severity: 'critical', cooldown: '45m' },
        ],
      }),
      result: 'converted',
      detail: [
        { id: 'th:1', metric: 'month.credits', op: '>', value: 200, cooldown: '45m', severity: 'info' },
        { id: 'th:2', metric: 'month.credits', op: '>', value: 300, cooldown: '45m', severity: 'critical' },
      ],
    },
    {
      where: 'alert-rules.md, `requiresAuth`',
      rule: rule({ id: 'auth', requiresAuth: true, conditions: [cond('today.credits', '>', 0)] }),
      result: 'skipped',
      detail: 'requiresAuth: flat rules cannot depend on being signed in to GitHub',
    },
    {
      where: 'alert-rules.md, `snoozeUntil`',
      rule: rule({ id: 'snz', snoozeUntil: '2999-01-01T00:00:00Z', conditions: [cond('today.credits', '>', 0)] }),
      result: 'skipped',
      detail: 'it is snoozed until 2999-01-01T00:00:00Z',
    },
    {
      where: 'alert-rules.md, `notify: false` silent rule with a restrict block',
      rule: rule({ id: 'silent', notify: false, when: { '>': [{ var: 'today.credits' }, 5] }, restrict: {} }),
      result: 'converted',
      detail: [{ id: 'silent', metric: 'today.credits', op: '>', value: 5, cooldown: '1h', severity: 'warning', notify: false, restrict: true }],
    },
    {
      where: 'alert-rules.md, restriction: `reEnableWhen` back under budget',
      rule: rule({
        id: 'reenable',
        severity: 'critical',
        when: { '>=': [{ var: 'budget.percentOfBudget' }, 1] },
        restrict: { reEnableWhen: { '<': [{ var: 'budget.percentOfBudget' }, 0.9] } },
      }),
      result: 'converted',
      detail: [{ id: 'reenable', metric: 'budget.percentOfBudget', op: '>=', value: 1, cooldown: '1h', severity: 'critical', restrict: true, clearBelow: 0.9 }],
    },
    {
      where: 'configuration.md, `velocity-warning`: `and` plus a weekday `active` gate',
      rule: rule({
        id: 'velocity-warning',
        message: 'High velocity ({{velocity.creditsPerHour}} cr/h), not on weekends.',
        when: { and: [{ '>': [{ var: 'velocity.creditsPerHour' }, 40] }, { '<': [{ var: 'budget.percentOfBudget' }, 1] }] },
        active: { and: [{ '!=': [{ var: 'now.weekday' }, 0] }, { '!=': [{ var: 'now.weekday' }, 6] }] },
        cooldown: '2h',
      }),
      result: 'skipped',
      detail:
        'it has an "active" gate, and flat rules have no extra conditions; "when": it uses "and", and flat rules are a single comparison of one metric',
    },
    {
      where: 'configuration.md, user-defined variables: `today.credits > vars.alertThreshold`',
      rule: rule({
        id: 'threshold',
        message: 'Over {{vars.alertThreshold}} credits today.',
        when: { '>': [{ var: 'today.credits' }, { var: 'vars.alertThreshold' }] },
      }),
      result: 'skipped',
      detail: '"when": it compares two variables (today.credits and vars.alertThreshold), and flat rules compare a metric with a number',
    },
    {
      where: 'configuration.md and features.md, rule groups: `velocity` gated on `group.work-hours`',
      rule: rule({
        id: 'velocity',
        message: 'High velocity during work hours.',
        when: { '>': [{ var: 'velocity.creditsPerHour' }, 40] },
        active: { var: 'group.work-hours' },
      }),
      groups: WORK_HOURS,
      result: 'skipped',
      detail: 'it belongs to the rule group "work-hours" (currently on), and groups are not supported',
    },
    {
      where: 'configuration.md, restriction popups: `budget-exhausted`',
      rule: rule({ id: 'budget-exhausted', severity: 'critical', message: 'Budget exhausted.', when: { '>=': [{ var: 'budget.percentOfBudget' }, 1] }, restrict: {} }),
      result: 'converted',
      detail: [{ id: 'budget-exhausted', metric: 'budget.percentOfBudget', op: '>=', value: 1, cooldown: '1h', severity: 'critical', restrict: true }],
    },
    {
      where: 'features.md, custom alert rules: `daily-high` with a template message',
      rule: rule({
        id: 'daily-high',
        message: '{{today.credits}} credits used today, slow down.',
        when: { '>': [{ var: 'today.credits' }, 100] },
        cooldown: '2h',
      }),
      result: 'converted',
      detail: [{ id: 'daily-high', metric: 'today.credits', op: '>', value: 100, cooldown: '2h', severity: 'warning' }],
    },
    {
      where: 'features.md, restriction popups: `budget-exhausted` ("Monthly budget exhausted.")',
      rule: rule({ id: 'budget-exhausted', severity: 'critical', message: 'Monthly budget exhausted.', when: { '>=': [{ var: 'budget.percentOfBudget' }, 1] }, restrict: {} }),
      result: 'converted',
      detail: [{ id: 'budget-exhausted', metric: 'budget.percentOfBudget', op: '>=', value: 1, cooldown: '1h', severity: 'critical', restrict: true }],
    },
  ];

  for (const example of docs) {
    it(`${example.result}: ${example.where}`, () => {
      const out = convertLegacyRules([example.rule], example.groups ?? []);
      if (example.result === 'converted') {
        assert.deepEqual(out.skipped, []);
        assert.deepEqual(out.converted, example.detail);
      } else {
        assert.deepEqual(out.converted, []);
        assert.deepEqual(out.skipped, [{ id: example.rule.id, reason: example.detail }]);
      }
    });
  }

  it('every documented scalar example becomes built-in rules instead (configuration.md and features.md)', () => {
    const config = { monthlyBudget: 20, dailyCreditAlert: 50, alerts: { velocityEnabled: true, velocityCreditsPerHour: 40 } };
    assert.deepEqual(builtinFlatRules(config).map((r) => [r.id, r.metric, r.value]), [
      ['builtin:budget:80', 'budget.percentOfBudget', 0.8],
      ['builtin:budget:100', 'budget.percentOfBudget', 1],
      ['builtin:daily', 'today.credits', 50],
      ['builtin:velocity', 'velocity.creditsPerHour', 40],
    ]);
    // features.md: `{ "branchBudgets": { "feature/big-refactor": 500, "main": 200 } }`
    const branches = { ...config, branchBudgets: { 'feature/big-refactor': 500, main: 200 } };
    assert.deepEqual(
      builtinFlatRules(branches, 'feature/big-refactor').filter((r) => r.id.startsWith('builtin:branch')).map((r) => [r.id, r.value, r.cooldown]),
      [['builtin:branch:feature/big-refactor', 500, '4h']],
    );
  });

  it('classifies the documented examples: converted and skipped counts', () => {
    const outcomes = docs.map((d) => d.result);
    assert.equal(outcomes.filter((o) => o === 'converted').length, 10);
    assert.equal(outcomes.filter((o) => o === 'skipped').length, 13);
  });
});

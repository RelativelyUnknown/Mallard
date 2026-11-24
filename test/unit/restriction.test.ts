import * as assert from 'assert';
import { evaluateRestrictionState } from '../../src/extension-backend/domain/restriction/evaluator';
import { ruleMatches } from '../../src/extension-backend/domain/alertRules';
import { AlertRule } from '../../src/extension-backend/domain/types';

describe('evaluateRestrictionState', () => {
  it('returns null when no rule has a restrict block', () => {
    const rules: AlertRule[] = [
      { id: 'r', severity: 'warning', message: '', when: { '>': [{ var: 'today.credits' }, 0] } },
    ];
    const out = evaluateRestrictionState(rules, { today: { credits: 100 } }, Date.now());
    assert.equal(out.active, null);
    assert.equal(out.matching.length, 0);
  });

  it('selects the matching restrict rule', () => {
    const rules: AlertRule[] = [
      {
        id: 'over-budget',
        severity: 'warning',
        message: 'too high',
        when: { '>': [{ var: 'today.credits' }, 50] },
        restrict: {},
      },
    ];
    const out = evaluateRestrictionState(rules, { today: { credits: 100 } }, Date.now());
    assert.ok(out.active);
    assert.equal(out.active!.id, 'over-budget');
  });

  it('first matching rule wins when several fire at once', () => {
    const rules: AlertRule[] = [
      {
        id: 'first',
        severity: 'warning',
        message: '',
        when: { '>': [{ var: 'today.credits' }, 0] },
        restrict: {},
      },
      {
        id: 'second',
        severity: 'warning',
        message: '',
        when: { '>': [{ var: 'today.credits' }, 0] },
        restrict: {},
      },
    ];
    const out = evaluateRestrictionState(rules, { today: { credits: 100 } }, Date.now());
    assert.equal(out.active!.id, 'first');
  });

  it('skips rules with active=false', () => {
    const rules: AlertRule[] = [
      {
        id: 'r',
        severity: 'warning',
        message: '',
        when: { '>': [{ var: 'today.credits' }, 0] },
        active: false,
        restrict: {},
      },
    ];
    const out = evaluateRestrictionState(rules, { today: { credits: 100 } }, Date.now());
    assert.equal(out.active, null);
  });

  it('skips rules with requiresAuth when not signed in', () => {
    const rules: AlertRule[] = [
      {
        id: 'r',
        severity: 'warning',
        message: '',
        when: { '>': [{ var: 'today.credits' }, 0] },
        requiresAuth: true,
        restrict: {},
      },
    ];
    const out = evaluateRestrictionState(
      rules,
      { today: { credits: 100 }, signedIn: false },
      Date.now(),
    );
    assert.equal(out.active, null);
  });

  it('processes rules where active is a JsonCondition that evaluates to true', () => {
    const rules: AlertRule[] = [
      {
        id: 'r',
        severity: 'warning',
        message: '',
        when: { '>': [{ var: 'today.credits' }, 0] },
        // active condition evaluates to true with credits=100
        active: { '>': [{ var: 'today.credits' }, 0] },
        restrict: {},
      },
    ];
    const out = evaluateRestrictionState(rules, { today: { credits: 100 } }, Date.now());
    assert.notEqual(out.active, null);
  });

  it('skips rules where active is a JsonCondition that evaluates to false', () => {
    const rules: AlertRule[] = [
      {
        id: 'r',
        severity: 'warning',
        message: '',
        when: { '>': [{ var: 'today.credits' }, 0] },
        // active condition: credits > 999 — evaluates to false with credits=1
        active: { '>': [{ var: 'today.credits' }, 999] },
        restrict: {},
      },
    ];
    const out = evaluateRestrictionState(rules, { today: { credits: 1 } }, Date.now());
    assert.equal(out.active, null);
    assert.equal(out.matching.length, 0);
  });

  it('lists a matching rule in canClear only when its reEnableWhen holds', () => {
    // reEnableWhen references a different dimension than `when` so a rule can be
    // matching (wants to restrict) while its clear condition is independently met.
    const rules: AlertRule[] = [
      {
        id: 'r',
        severity: 'warning',
        message: '',
        when: { '>': [{ var: 'today.credits' }, 50] },
        restrict: {
          reEnableWhen: { '<': [{ var: 'mtd.credits' }, 10] },
        },
      },
    ];

    // reEnableWhen true → clearable
    const cleared = evaluateRestrictionState(
      rules,
      { today: { credits: 100 }, mtd: { credits: 5 } },
      Date.now(),
    );
    assert.equal(cleared.matching.length, 1);
    assert.equal(cleared.canClear.length, 1);

    // reEnableWhen false → matching but NOT clearable (was the bug: presence-only check)
    const notCleared = evaluateRestrictionState(
      rules,
      { today: { credits: 100 }, mtd: { credits: 100 } },
      Date.now(),
    );
    assert.equal(notCleared.matching.length, 1);
    assert.equal(notCleared.canClear.length, 0);
  });

  it('skips restrict rules whose when condition evaluates to false', () => {
    const rules: AlertRule[] = [
      {
        id: 'r',
        severity: 'warning',
        message: '',
        when: { '>': [{ var: 'today.credits' }, 999] }, // false with credits=1
        restrict: {},
      },
    ];
    const out = evaluateRestrictionState(rules, { today: { credits: 1 } }, Date.now());
    assert.equal(out.active, null);
    assert.equal(out.matching.length, 0);
  });
});

describe('evaluateRestrictionState — same matching as alerts', () => {
  const now = Date.now();

  it('REGRESSION: honours `thresholds` (restrict rules with only thresholds used to never match)', () => {
    const rules: AlertRule[] = [
      {
        id: 't',
        severity: 'info',
        message: '',
        thresholds: [
          { field: 'today.credits', op: '>', value: 50, severity: 'warning' },
          { field: 'today.credits', op: '>', value: 90, severity: 'critical' },
        ],
        restrict: {},
      },
    ];
    assert.equal(evaluateRestrictionState(rules, { today: { credits: 10 } }, now).active, null);
    assert.equal(evaluateRestrictionState(rules, { today: { credits: 60 } }, now).active!.id, 't');
  });

  it('REGRESSION: honours `snoozeUntil` exactly like the alert path', () => {
    const base: AlertRule = {
      id: 's',
      severity: 'warning',
      message: '',
      when: { '>': [{ var: 'today.credits' }, 0] },
      restrict: {},
    };
    const ctx = { today: { credits: 100 } };
    const snoozed = { ...base, snoozeUntil: new Date(now + 60_000).toISOString() };
    const expired = { ...base, snoozeUntil: new Date(now - 60_000).toISOString() };
    assert.equal(evaluateRestrictionState([snoozed], ctx, now).active, null);
    assert.equal(evaluateRestrictionState([expired], ctx, now).active!.id, 's');
  });

  it('honours the `conditions` shorthand and "thresholds > when > conditions" precedence', () => {
    const conditions: AlertRule = {
      id: 'c',
      severity: 'warning',
      message: '',
      conditions: [{ field: 'today.credits', op: '>', value: 50 }],
      restrict: {},
    };
    assert.equal(evaluateRestrictionState([conditions], { today: { credits: 60 } }, now).active!.id, 'c');
    assert.equal(evaluateRestrictionState([conditions], { today: { credits: 10 } }, now).active, null);

    const both: AlertRule = { ...conditions, id: 'both', when: false };
    assert.equal(evaluateRestrictionState([both], { today: { credits: 60 } }, now).active, null, 'when wins');
  });

  it('a restriction and an alert agree on every rule in a mixed set', () => {
    const rules: AlertRule[] = [
      { id: 'a', severity: 'warning', message: '', when: true, restrict: {} },
      { id: 'b', severity: 'warning', message: '', when: true, restrict: {}, snoozeUntil: new Date(now + 5_000).toISOString() },
      { id: 'c', severity: 'warning', message: '', conditions: [{ field: 'x', op: '==', value: 1 }], restrict: {} },
      { id: 'd', severity: 'warning', message: '', when: true, restrict: {}, requiresAuth: true },
    ];
    const ctx = { x: 1, signedIn: false };
    const matched = evaluateRestrictionState(rules, ctx, now).matching.map((r) => r.id);
    assert.deepEqual(matched, rules.filter((r) => ruleMatches(r, ctx, now)).map((r) => r.id));
    assert.deepEqual(matched, ['a', 'c']);
  });
});

describe('evaluateRestrictionState — clearing the active restriction', () => {
  const now = Date.now();
  const rule = (restrict: AlertRule['restrict']): AlertRule => ({
    id: 'r',
    severity: 'warning',
    message: '',
    when: { '>': [{ var: 'today.credits' }, 50] },
    restrict: restrict ?? {},
  });

  it('REGRESSION: the active rule is clearable once its `when` has gone false and reEnableWhen holds', () => {
    const rules = [rule({ reEnableWhen: { '<': [{ var: 'today.credits' }, 10] } })];
    // Trigger no longer holds (credits 5 <= 50) and the re-enable condition is true.
    const out = evaluateRestrictionState(rules, { today: { credits: 5 } }, now, 'r');
    assert.equal(out.active, null);
    assert.equal(out.matching.length, 0);
    assert.deepEqual(out.canClear.map((r) => r.id), ['r']);
    assert.equal(out.canClearActive, true);
    // Without telling it which rule is active, nothing can be reported.
    assert.equal(evaluateRestrictionState(rules, { today: { credits: 5 } }, now).canClear.length, 0);
  });

  it('the active rule is NOT clearable while its reEnableWhen is still false', () => {
    const rules = [rule({ reEnableWhen: { '<': [{ var: 'today.credits' }, 10] } })];
    const out = evaluateRestrictionState(rules, { today: { credits: 30 } }, now, 'r');
    assert.equal(out.canClearActive, false);
    assert.equal(out.canClear.length, 0);
  });

  it('without a reEnableWhen the active rule clears only when its trigger has stopped matching', () => {
    const rules = [rule({})];
    assert.equal(evaluateRestrictionState(rules, { today: { credits: 5 } }, now, 'r').canClearActive, true);
    const stillMatching = evaluateRestrictionState(rules, { today: { credits: 90 } }, now, 'r');
    assert.equal(stillMatching.canClearActive, false);
    assert.equal(stillMatching.active!.id, 'r');
  });

  it('an unknown activeRuleId reports nothing clearable', () => {
    const out = evaluateRestrictionState([rule({})], { today: { credits: 5 } }, now, 'gone');
    assert.equal(out.canClearActive, false);
    assert.equal(out.canClear.length, 0);
  });
});

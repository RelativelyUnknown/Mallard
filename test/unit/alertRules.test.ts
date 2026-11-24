import * as assert from 'assert';
import {
  computeAlertEvaluation,
  evaluateAlertRules,
  matchRule,
  parseAlertRules,
  parseDurationMs,
  ruleMatches,
  shouldNotify,
} from '../../src/extension-backend/domain/alertRules';
import { AlertRule, UsageSnapshot } from '../../src/extension-backend/domain/types';

function snap(todayCredits = 0): UsageSnapshot {
  return {
    budget: { percentOfBudget: 0, usedCost: 0, usedCredits: 0 } as UsageSnapshot['budget'],
    today: { credits: todayCredits, cost: 0, tokens: 0 },
    forecast: { projectedCredits: 0, projectedCost: 0, low: 0, high: 0, basis: 'insufficient-data', granularity: 'month', asOf: 0 },
  } as UsageSnapshot;
}

describe('parseAlertRules', () => {
  it('returns ok: true for a valid document with JSON condition', () => {
    const result = parseAlertRules({
      version: 1,
      rules: [{ id: 'r1', severity: 'warning', message: 'hi', when: { '>': [{ var: 'today.credits' }, 10] } }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.doc.rules[0]?.id, 'r1');
  });

  it('returns ok: false for a completely invalid document', () => {
    const result = parseAlertRules('not an object');
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it('returns ok: false when rules array is malformed', () => {
    const result = parseAlertRules({ version: 1, rules: 'bad' });
    assert.equal(result.ok, false);
  });

  it('preserves vars and groups from the document', () => {
    const result = parseAlertRules({
      version: 2,
      vars: { threshold: 50 },
      groups: [{ id: 'g1', active: true, label: 'Group 1' }],
      rules: [],
    });
    assert.equal(result.ok, true);
    assert.equal((result.doc.vars as Record<string, number>).threshold, 50);
    assert.equal(result.doc.groups[0]?.id, 'g1');
  });

  it('parses an empty restrict block', () => {
    const result = parseAlertRules({
      version: 1,
      rules: [{
        id: 'r1',
        severity: 'warning',
        message: '',
        when: true,
        restrict: {},
      }],
    });
    assert.equal(result.ok, true);
    assert.ok(result.doc.rules[0]?.restrict);
    assert.equal(result.doc.rules[0]?.restrict?.reEnableWhen, undefined);
  });

  it('does not throw on deeply malformed input', () => {
    const inputs = [null, undefined, 123, [], { rules: [{ id: null }] }];
    for (const input of inputs) {
      assert.doesNotThrow(() => parseAlertRules(input));
    }
  });

  it('accepts a conditions-only rule (no when field)', () => {
    const result = parseAlertRules({
      version: 1,
      rules: [{
        id: 'r1', severity: 'warning', message: 'hi',
        conditions: [{ field: 'today.credits', op: '>', value: 50 }],
      }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.doc.rules[0]?.conditions?.[0]?.field, 'today.credits');
  });

  it('parses restrict with reEnableWhen', () => {
    const result = parseAlertRules({
      version: 1,
      rules: [{
        id: 'r1', severity: 'warning', message: '',
        when: true,
        restrict: { reEnableWhen: { '<': [{ var: 'today.credits' }, 10] } },
      }],
    });
    assert.equal(result.ok, true);
    assert.ok(result.doc.rules[0]?.restrict?.reEnableWhen !== undefined);
  });

  it('parses threshold with cooldown', () => {
    const result = parseAlertRules({
      version: 1,
      rules: [{
        id: 'r1', severity: 'info', message: '',
        thresholds: [{ field: 'today.credits', op: '>', value: 50, severity: 'warning', cooldown: '60m' }],
      }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.doc.rules[0]?.thresholds?.[0]?.cooldown, '60m');
  });

  it('covers all optional rule fields and group label', () => {
    const result = parseAlertRules({
      rules: [{
        id: 'r1',
        severity: 'warning',
        message: 'test',
        cooldown: '60m',
        conditions: [{ field: 'today.credits', op: '>', value: 50 }],
        match: 'any',
        active: true,
        requiresAuth: false,
        notify: true,
        thresholds: [{ field: 'today.credits', op: '>', value: 80, severity: 'critical', cooldown: '30m' }],
        snoozeUntil: '2099-01-01T00:00:00Z',
      }],
      groups: [{ id: 'g1', active: true, label: 'My Group' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.doc.rules[0]?.cooldown, '60m');
    assert.equal(result.doc.rules[0]?.match, 'any');
    assert.equal(result.doc.rules[0]?.active, true);
    assert.equal(result.doc.rules[0]?.requiresAuth, false);
    assert.equal(result.doc.rules[0]?.notify, true);
    assert.equal(result.doc.rules[0]?.thresholds?.[0]?.cooldown, '30m');
    assert.equal(result.doc.rules[0]?.snoozeUntil, '2099-01-01T00:00:00Z');
    assert.equal(result.doc.groups[0]?.label, 'My Group');
    assert.equal(result.doc.version, 1);
  });

  it('uses default version 1 and empty rules when not specified', () => {
    const result = parseAlertRules({ vars: { x: 1 } });
    assert.equal(result.ok, true);
    assert.equal(result.doc.version, 1);
    assert.equal(result.doc.rules.length, 0);
  });

  it('parses threshold without cooldown and group without label', () => {
    const result = parseAlertRules({
      rules: [{ id: 'r1', severity: 'warning', message: '', thresholds: [{ field: 'today.credits', op: '>', value: 50, severity: 'info' }] }],
      groups: [{ id: 'g1', active: true }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.doc.rules[0]?.thresholds?.[0]?.cooldown, undefined);
    assert.equal(result.doc.groups[0]?.label, undefined);
  });
});

describe('evaluateAlertRules — groups', () => {
  const now = Date.now();

  it('group active=false suppresses rules referencing that group', () => {
    const rules: AlertRule[] = [
      { id: 'r', severity: 'warning', message: '', when: { '>': [{ var: 'today.credits' }, 0] }, active: { var: 'group.g1' } },
    ];
    const groups = [{ id: 'g1', active: false as const }];
    const fired = new Map<string, number>();
    const out = evaluateAlertRules({ snapshot: snap(100), rules, groups, fired, now });
    assert.equal(out.length, 0, 'group inactive suppresses rule');
  });

  it('group active=true allows rule to fire', () => {
    const rules: AlertRule[] = [
      { id: 'r', severity: 'warning', message: '', when: { '>': [{ var: 'today.credits' }, 0] }, active: { var: 'group.g1' } },
    ];
    const groups = [{ id: 'g1', active: true as const }];
    const fired = new Map<string, number>();
    const out = evaluateAlertRules({ snapshot: snap(100), rules, groups, fired, now });
    assert.equal(out.length, 1);
  });

  it('compound condition fires when both sides true', () => {
    const rules: AlertRule[] = [
      {
        id: 'r',
        severity: 'info',
        message: '',
        when: { 'and': [
          { '>': [{ var: 'today.credits' }, 50] },
          { '<': [{ var: 'budget.percentOfBudget' }, 1] },
        ] },
      },
    ];
    const fired = new Map<string, number>();
    const out = evaluateAlertRules({ snapshot: snap(60), rules, fired, now });
    assert.equal(out.length, 1);
  });

  it('template renders {{field.path}} using the rule context', () => {
    const rules: AlertRule[] = [
      {
        id: 'r',
        severity: 'info',
        message: 'Credits: {{today.credits}}',
        when: { '>': [{ var: 'today.credits' }, 0] },
      },
    ];
    const fired = new Map<string, number>();
    const out = evaluateAlertRules({ snapshot: snap(42), rules, fired, now });
    assert.equal(out[0]?.message, 'Credits: 42');
  });
});

describe('alertRules — conditions shorthand', () => {
  const now = Date.now();
  it('fires when conditions array matches', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'warning', message: '',
      conditions: [{ field: 'today.credits', op: '>', value: 50 }],
    }];
    const out = evaluateAlertRules({ snapshot: snap(60), rules, fired: new Map(), now });
    assert.equal(out.length, 1);
  });

  it('does not fire when conditions do not match', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'warning', message: '',
      conditions: [{ field: 'today.credits', op: '>', value: 100 }],
    }];
    const out = evaluateAlertRules({ snapshot: snap(60), rules, fired: new Map(), now });
    assert.equal(out.length, 0);
  });

  it('match:any fires when at least one condition matches', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'info', message: '',
      conditions: [
        { field: 'today.credits', op: '>', value: 999 },
        { field: 'today.credits', op: '>', value: 10 },
      ],
      match: 'any',
    }];
    const out = evaluateAlertRules({ snapshot: snap(60), rules, fired: new Map(), now });
    assert.equal(out.length, 1);
  });
});

describe('alertRules — snooze', () => {
  const now = Date.now();
  it('suppresses a snoozed rule', () => {
    const futureIso = new Date(now + 60_000).toISOString();
    const rules: AlertRule[] = [{
      id: 'r', severity: 'warning', message: '',
      when: { '>': [{ var: 'today.credits' }, 0] },
      snoozeUntil: futureIso,
    }];
    const out = evaluateAlertRules({ snapshot: snap(60), rules, fired: new Map(), now });
    assert.equal(out.length, 0);
  });

  it('fires after snooze has expired', () => {
    const pastIso = new Date(now - 60_000).toISOString();
    const rules: AlertRule[] = [{
      id: 'r', severity: 'warning', message: '',
      when: { '>': [{ var: 'today.credits' }, 0] },
      snoozeUntil: pastIso,
    }];
    const out = evaluateAlertRules({ snapshot: snap(60), rules, fired: new Map(), now });
    assert.equal(out.length, 1);
  });
});

describe('alertRules — threshold escalation', () => {
  const now = Date.now();
  it('fires the highest matching severity', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'info', message: 'spend {{today.credits}}',
      thresholds: [
        { field: 'today.credits', op: '>', value: 50, severity: 'info' },
        { field: 'today.credits', op: '>', value: 80, severity: 'warning' },
        { field: 'today.credits', op: '>', value: 100, severity: 'critical' },
      ],
    }];
    const out = evaluateAlertRules({ snapshot: snap(90), rules, fired: new Map(), now });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.severity, 'warning');
  });

  it('does not fire when no threshold matches', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'info', message: '',
      thresholds: [{ field: 'today.credits', op: '>', value: 200, severity: 'info' }],
    }];
    const out = evaluateAlertRules({ snapshot: snap(60), rules, fired: new Map(), now });
    assert.equal(out.length, 0);
  });

  it('suppresses threshold rule within cooldown period', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'info', message: '',
      thresholds: [{ field: 'today.credits', op: '>', value: 50, severity: 'warning', cooldown: '1h' }],
    }];
    const fired = new Map<string, number>();
    fired.set('r#warning', now - 100); // fired 100ms ago, within 1h cooldown
    const out = evaluateAlertRules({ snapshot: snap(60), rules, fired, now });
    assert.equal(out.length, 0);
  });
});

describe('alertRules — durationToMs edge cases', () => {
  const now = Date.now();

  it('handles invalid cooldown format (falls back to default)', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'warning', message: 'hi',
      when: true,
      cooldown: 'NOT_VALID',
    }];
    const out = evaluateAlertRules({ snapshot: snap(0), rules, fired: new Map(), now });
    assert.equal(out.length, 1);
  });

  it('handles m, d and w cooldown units', () => {
    const rulesMin: AlertRule[] = [{ id: 'r-m', severity: 'warning', message: '', when: true, cooldown: '30m' }];
    const outMin = evaluateAlertRules({ snapshot: snap(0), rules: rulesMin, fired: new Map(), now });
    assert.equal(outMin.length, 1);

    const rulesDay: AlertRule[] = [{ id: 'r-d', severity: 'warning', message: '', when: true, cooldown: '1d' }];
    const outDay = evaluateAlertRules({ snapshot: snap(0), rules: rulesDay, fired: new Map(), now });
    assert.equal(outDay.length, 1);

    const rulesWeek: AlertRule[] = [{ id: 'r-w', severity: 'warning', message: '', when: true, cooldown: '1w' }];
    const outWeek = evaluateAlertRules({ snapshot: snap(0), rules: rulesWeek, fired: new Map(), now });
    assert.equal(outWeek.length, 1);
  });
});

describe('alertRules — renderTemplate edge cases', () => {
  const now = Date.now();

  it('returns empty string for undefined template variable', () => {
    const rules: AlertRule[] = [{ id: 'r', severity: 'warning', message: '{{nonexistent.field}}', when: true }];
    const out = evaluateAlertRules({ snapshot: snap(0), rules, fired: new Map(), now });
    assert.equal(out[0]?.message, '');
  });

  it('formats non-integer float with toFixed(2)', () => {
    const snapshot = { ...snap(0), today: { credits: 0, cost: 1.5, tokens: 0 } } as unknown as UsageSnapshot;
    const rules: AlertRule[] = [{ id: 'r', severity: 'warning', message: 'Cost: {{today.cost}}', when: true }];
    const out = evaluateAlertRules({ snapshot, rules, fired: new Map(), now });
    assert.equal(out[0]?.message, 'Cost: 1.50');
  });

  it('converts string values via String()', () => {
    const rules: AlertRule[] = [{ id: 'r', severity: 'warning', message: 'Basis: {{forecast.basis}}', when: true }];
    const out = evaluateAlertRules({ snapshot: snap(0), rules, fired: new Map(), now });
    assert.equal(out[0]?.message, 'Basis: insufficient-data');
  });
});

describe('alertRules — evaluateAlertRules without now', () => {
  it('uses Date.now() when now is not provided', () => {
    const rules: AlertRule[] = [{ id: 'r', severity: 'warning', message: '', when: true }];
    const out = evaluateAlertRules({ snapshot: snap(0), rules, fired: new Map() });
    assert.equal(out.length, 1);
  });
});

describe('alertRules — edge cases', () => {
  const now = Date.now();

  it('very large cooldown duration does not crash (effectively suppresses re-fire)', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'warning', message: 'hi',
      when: true,
      cooldown: '999999999d',
    }];
    const fired = new Map<string, number>();
    fired.set('r#warning', now - 1000); // fired 1s ago, inside the enormous cooldown
    const out = evaluateAlertRules({ snapshot: snap(0), rules, fired, now });
    assert.equal(out.length, 0);
  });

  it('snooze with malformed ISO date fires the rule (invalid date → NaN check → expired)', () => {
    const rules: AlertRule[] = [{
      id: 'r', severity: 'warning', message: '',
      when: true,
      snoozeUntil: 'not-a-valid-date',
    }];
    const out = evaluateAlertRules({ snapshot: snap(0), rules, fired: new Map(), now });
    assert.equal(out.length, 1);
  });

  it('duplicate rule IDs — first fires and sets cooldown, second is suppressed', () => {
    const rules: AlertRule[] = [
      { id: 'r', severity: 'warning', message: 'first', when: true },
      { id: 'r', severity: 'warning', message: 'second', when: true },
    ];
    const out = evaluateAlertRules({ snapshot: snap(0), rules, fired: new Map(), now });
    assert.equal(out.length, 1);
    assert.equal(out[0]!.message, 'first');
  });
});

describe('shouldNotify', () => {
  const now = Date.now();

  it('is true when notify is omitted', () => {
    const rule: AlertRule = { id: 'r', severity: 'warning', message: 'm', when: true };
    assert.equal(shouldNotify(rule), true);
  });

  it('is true when notify is explicitly true', () => {
    const rule: AlertRule = { id: 'r', severity: 'warning', message: 'm', when: true, notify: true };
    assert.equal(shouldNotify(rule), true);
  });

  it('is false when notify is explicitly false', () => {
    const rule: AlertRule = { id: 'r', severity: 'warning', message: 'm', when: true, notify: false };
    assert.equal(shouldNotify(rule), false);
  });

  it('is false for a rule with a restrict block, regardless of notify', () => {
    const rule: AlertRule = {
      id: 'r', severity: 'warning', message: 'm', when: true, notify: true,
      restrict: {},
    };
    assert.equal(shouldNotify(rule), false);
  });

  it('cooldown bookkeeping happens regardless of notify — a notify:false rule still occupies its cooldown key', () => {
    const fired = new Map<string, number>();
    const rules: AlertRule[] = [{ id: 'r', severity: 'warning', message: 'm', when: true, notify: false, cooldown: '1h' }];
    const first = evaluateAlertRules({ snapshot: snap(0), rules, fired, now });
    assert.equal(first.length, 1);
    assert.equal(shouldNotify(first[0]!.rule), false);
    const second = evaluateAlertRules({ snapshot: snap(0), rules, fired, now: now + 60_000 });
    assert.equal(second.length, 0, 'cooldown still applies even though the rule never notified');
  });
});

describe('parseDurationMs / cooldown validation', () => {
  it('accepts m/h/d/w case-insensitively with optional decimals', () => {
    assert.equal(parseDurationMs('30m'), 30 * 60_000);
    assert.equal(parseDurationMs('30M'), 30 * 60_000);
    assert.equal(parseDurationMs('1.5h'), 90 * 60_000);
    assert.equal(parseDurationMs('2D'), 2 * 86_400_000);
    assert.equal(parseDurationMs('.5w'), 302_400_000);
    assert.equal(parseDurationMs(' 4 h '), 4 * 3_600_000);
  });

  it('rejects zero, negative, unitless and unparseable values', () => {
    for (const bad of ['0m', '0.0h', '-5m', '', 'abc', '10', '1 hour', '1x', 'm', '1..5h', '1e3m']) {
      assert.equal(parseDurationMs(bad), null, JSON.stringify(bad));
    }
    assert.equal(parseDurationMs(`${'9'.repeat(400)}d`), null, 'overflow to Infinity is rejected');
  });

  it('REGRESSION: parseAlertRules reports a bad rule cooldown instead of silently using 1h', () => {
    for (const cooldown of ['1 hour', '0m', '-5m', 'soon']) {
      const result = parseAlertRules({ rules: [{ id: 'r', message: '', when: true, cooldown }] });
      assert.equal(result.ok, false, `cooldown ${JSON.stringify(cooldown)} must be rejected`);
      assert.ok(
        result.errors.some((e) => e.field === 'rules.0.cooldown' && /cooldown/.test(e.message)),
        JSON.stringify(result.errors),
      );
    }
  });

  it('REGRESSION: parseAlertRules reports a bad threshold-level cooldown', () => {
    const result = parseAlertRules({
      rules: [{
        id: 'r', message: '',
        thresholds: [{ field: 'today.credits', op: '>', value: 1, severity: 'info', cooldown: 'x' }],
      }],
    });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.field === 'rules.0.thresholds.0.cooldown'), JSON.stringify(result.errors));
  });

  it('parseAlertRules accepts decimal and upper-case cooldowns', () => {
    const result = parseAlertRules({
      rules: [{ id: 'r', message: '', when: true, cooldown: '1.5H' }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.doc.rules[0]?.cooldown, '1.5H');
  });

  it('parseAlertRules rejects a matches condition without a string pattern', () => {
    const bad = parseAlertRules({
      rules: [{ id: 'r', message: '', conditions: [{ field: 'topModel.id', op: 'matches', value: 5 }] }],
    });
    assert.equal(bad.ok, false);
    const tooLong = parseAlertRules({
      rules: [{ id: 'r', message: '', conditions: [{ field: 'topModel.id', op: 'matches', value: 'a'.repeat(257) }] }],
    });
    assert.equal(tooLong.ok, false);
    const good = parseAlertRules({
      rules: [{ id: 'r', message: '', conditions: [{ field: 'topModel.id', op: 'matches', value: 'claude-*' }] }],
    });
    assert.equal(good.ok, true);
  });
});

describe('alertRules — runtime cooldown parsing', () => {
  const now = Date.now();
  const rule = (cooldown: string): AlertRule[] => [{ id: 'r', severity: 'warning', message: '', when: true, cooldown }];

  it('REGRESSION: a zero cooldown is not honoured as "no cooldown"; it falls back to 1h', () => {
    const fired = new Map<string, number>([['r#warning', now - 60_000]]);
    const out = evaluateAlertRules({ snapshot: snap(0), rules: rule('0m'), fired, now });
    assert.equal(out.length, 0, 'fired 1 minute ago, still inside the 1h fallback');
  });

  it('REGRESSION: decimal cooldowns are honoured (0.5h = 30 minutes)', () => {
    const recent = new Map<string, number>([['r#warning', now - 20 * 60_000]]);
    assert.equal(evaluateAlertRules({ snapshot: snap(0), rules: rule('0.5h'), fired: recent, now }).length, 0);
    const old = new Map<string, number>([['r#warning', now - 40 * 60_000]]);
    assert.equal(evaluateAlertRules({ snapshot: snap(0), rules: rule('0.5h'), fired: old, now }).length, 1);
  });

  it('REGRESSION: unit letters are case-insensitive (30M = 30 minutes)', () => {
    const old = new Map<string, number>([['r#warning', now - 40 * 60_000]]);
    assert.equal(evaluateAlertRules({ snapshot: snap(0), rules: rule('30M'), fired: old, now }).length, 1);
  });
});

describe('alertRules — shared rule matching', () => {
  const now = Date.now();

  it('precedence: thresholds win over when, and when wins over conditions', () => {
    const thresholdsAndWhen: AlertRule = {
      id: 'a', severity: 'info', message: '',
      when: true,
      thresholds: [{ field: 'today.credits', op: '>', value: 500, severity: 'critical' }],
    };
    assert.equal(matchRule(thresholdsAndWhen, { today: { credits: 1 } }, now), null, 'when is ignored');
    assert.equal(matchRule(thresholdsAndWhen, { today: { credits: 900 } }, now), 'critical');

    const whenAndConditions: AlertRule = {
      id: 'b', severity: 'warning', message: '',
      when: false,
      conditions: [{ field: 'today.credits', op: '>', value: 0 }],
    };
    assert.equal(ruleMatches(whenAndConditions, { today: { credits: 10 } }, now), false, 'conditions are ignored');
  });

  it('gates: requiresAuth, active and snoozeUntil all apply', () => {
    const base: AlertRule = { id: 'g', severity: 'warning', message: '', when: true };
    assert.equal(ruleMatches({ ...base, requiresAuth: true }, { signedIn: false }, now), false);
    assert.equal(ruleMatches({ ...base, requiresAuth: true }, { signedIn: true }, now), true);
    assert.equal(ruleMatches({ ...base, active: false }, {}, now), false);
    assert.equal(ruleMatches({ ...base, snoozeUntil: new Date(now + 60_000).toISOString() }, {}, now), false);
    assert.equal(ruleMatches({ ...base, snoozeUntil: new Date(now - 60_000).toISOString() }, {}, now), true);
  });
});

describe('alertRules — pure evaluation', () => {
  const now = Date.now();
  const rules: AlertRule[] = [{ id: 'r', severity: 'warning', message: 'm', when: true, cooldown: '1h' }];

  it('REGRESSION: computeAlertEvaluation never mutates the fired map and returns the new entries', () => {
    const fired = new Map<string, number>([['other#info', 1]]);
    const { results, firedKeys } = computeAlertEvaluation({ snapshot: snap(0), rules, fired, now });
    assert.equal(results.length, 1);
    assert.deepEqual([...fired], [['other#info', 1]], 'input untouched');
    assert.deepEqual([...firedKeys], [['r#warning', now]]);
  });

  it('applying firedKeys reproduces what evaluateAlertRules records', () => {
    const viaWrapper = new Map<string, number>();
    evaluateAlertRules({ snapshot: snap(0), rules, fired: viaWrapper, now });
    const pure = computeAlertEvaluation({ snapshot: snap(0), rules, fired: new Map(), now });
    assert.deepEqual([...viaWrapper], [...pure.firedKeys]);
  });

  it('is repeatable: the same pure call twice yields the same alerts', () => {
    const fired = new Map<string, number>();
    const first = computeAlertEvaluation({ snapshot: snap(0), rules, fired, now });
    const second = computeAlertEvaluation({ snapshot: snap(0), rules, fired, now });
    assert.equal(first.results.length, 1);
    assert.equal(second.results.length, 1);
  });

  it('still debounces duplicate rule ids within a single pass', () => {
    const dup: AlertRule[] = [
      { id: 'r', severity: 'warning', message: 'first', when: true },
      { id: 'r', severity: 'warning', message: 'second', when: true },
    ];
    const { results } = computeAlertEvaluation({ snapshot: snap(0), rules: dup, fired: new Map(), now });
    assert.deepEqual(results.map((r) => r.message), ['first']);
  });
});

describe('alertRules — template paths', () => {
  const now = Date.now();
  const snapshot = {
    ...snap(0),
    topModels: [{ key: 'gpt-4.1', credits: 12, cost: 0.5, tokens: 100 }],
    allModels: ['gpt-4.1'],
  } as unknown as UsageSnapshot;
  const render = (message: string): string | undefined =>
    evaluateAlertRules({
      snapshot,
      rules: [{ id: 'r', severity: 'warning', message, when: true }],
      fired: new Map(),
      now,
    })[0]?.message;

  it('REGRESSION: bracket paths reach keys that contain dots', () => {
    assert.equal(render('gpt-4.1 used {{ model["gpt-4.1"].credits }} cr'), 'gpt-4.1 used 12 cr');
    assert.equal(render("{{model['gpt-4.1'].cost}}"), '0.50');
  });

  it('REGRESSION: inherited names never render (constructor, __proto__)', () => {
    assert.equal(render('[{{constructor}}][{{__proto__}}][{{today.constructor}}]'), '[][][]');
  });

  it('leaves text that is not a valid path untouched', () => {
    assert.equal(render('{{ not a path }} {{model["oops}}'), '{{ not a path }} {{model["oops}}');
  });
});

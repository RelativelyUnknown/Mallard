import { strict as assert } from 'assert';
import type { FlatAlertRule } from '../../src/extension-backend/domain/contracts';
import { evaluateFlatRestriction } from '../../src/extension-backend/domain/flatRestriction';
import { ctxOf, flatRule, ruleSnapshot } from './flatAlertsFixture';

const NOW = new Date(2026, 0, 15, 12, 0).getTime();
const H = 3_600_000;

/** A snapshot at `today` credits and `pct` of the budget. */
const at = (today: number, pct = 0.5) =>
  ctxOf(ruleSnapshot({ today: { credits: today, cost: 0, tokens: 0 }, budget: { ...ruleSnapshot().budget, percentOfBudget: pct } }));

const heavy = flatRule({ id: 'heavy', metric: 'today.credits', op: '>', value: 150, restrict: true, severity: 'critical' });
const budget = flatRule({
  id: 'budget',
  metric: 'budget.percentOfBudget',
  op: '>=',
  value: 1,
  restrict: true,
  clearBelow: 0.9,
});
const plainAlert = flatRule({ id: 'alert', metric: 'today.credits', op: '>', value: 1 });

describe('evaluateFlatRestriction — picking the rule', () => {
  it('is inactive with no rules, no restrict rules, or nothing matching', () => {
    const none = { active: null, reason: null, cleared: false, held: false, matching: [] };
    assert.deepEqual(evaluateFlatRestriction([], at(500)), none);
    assert.deepEqual(evaluateFlatRestriction([plainAlert], at(500)), none, 'a plain alert rule never restricts');
    assert.deepEqual(evaluateFlatRestriction([heavy, budget], at(100, 0.5)), none);
  });

  it('the first matching restrict rule in declaration order wins; the rest are still reported as matching', () => {
    const r = evaluateFlatRestriction([budget, heavy], at(200, 1.2));
    assert.equal(r.active?.id, 'budget');
    assert.deepEqual(r.matching.map((m) => m.id), ['budget', 'heavy']);
    assert.equal(evaluateFlatRestriction([heavy, budget], at(200, 1.2)).active?.id, 'heavy', 'declaration order, not severity');
    assert.equal(evaluateFlatRestriction([heavy, budget], at(100, 1.2)).active?.id, 'budget');
  });

  it('reports a fixed-format reason with the current value', () => {
    const r = evaluateFlatRestriction([heavy], at(160));
    assert.equal(r.reason, 'today.credits > 150 (now 160)');
    assert.equal(r.cleared, false);
    assert.equal(r.held, false);
  });

  it('a restrict:false rule and a silent restrict rule are handled by the restrict flag alone', () => {
    const off = flatRule({ id: 'off', metric: 'today.credits', value: 1, restrict: false });
    assert.equal(evaluateFlatRestriction([off], at(500)).active, null);
    const silent = flatRule({ id: 'silent', metric: 'today.credits', value: 1, restrict: true, notify: false });
    assert.equal(evaluateFlatRestriction([silent], at(500)).active?.id, 'silent');
  });
});

describe('evaluateFlatRestriction — clearing and hysteresis', () => {
  it('without clearBelow a restriction clears as soon as its rule stops matching', () => {
    const on = evaluateFlatRestriction([heavy], at(160));
    assert.equal(on.active?.id, 'heavy');
    const off = evaluateFlatRestriction([heavy], at(149), 'heavy');
    assert.deepEqual([off.active, off.reason, off.cleared, off.held], [null, null, true, false]);
  });

  it('with clearBelow the restriction holds after the rule stopped matching, until the metric is below it', () => {
    const start = evaluateFlatRestriction([budget], at(0, 1.05));
    assert.equal(start.active?.id, 'budget');
    // 0.95: no longer >= 1, but not below 0.9 either: held (hysteresis band).
    const band = evaluateFlatRestriction([budget], at(0, 0.95), 'budget');
    assert.equal(band.active?.id, 'budget');
    assert.equal(band.held, true);
    assert.equal(band.cleared, false);
    assert.equal(band.reason, 'budget.percentOfBudget >= 1 (now 0.95)');
    assert.deepEqual(band.matching, []);
    // exactly 0.9 is not below 0.9: still held; 0.8999 clears.
    assert.equal(evaluateFlatRestriction([budget], at(0, 0.9), 'budget').held, true);
    const clear = evaluateFlatRestriction([budget], at(0, 0.8999), 'budget');
    assert.deepEqual([clear.active, clear.cleared, clear.held], [null, true, false]);
  });

  it('a lifted rule (metric below clearBelow) neither starts nor keeps a restriction even while it matches', () => {
    // clearBelow above the trigger: the rule matches at 0.85 but is lifted there.
    const odd = flatRule({ id: 'odd', metric: 'budget.percentOfBudget', op: '>=', value: 0.8, restrict: true, clearBelow: 0.9 });
    const fresh = evaluateFlatRestriction([odd], at(0, 0.85));
    assert.equal(fresh.active, null);
    assert.deepEqual(fresh.matching.map((m) => m.id), ['odd']);
    const held = evaluateFlatRestriction([odd], at(0, 0.85), 'odd');
    assert.deepEqual([held.active, held.cleared], [null, true]);
    assert.equal(evaluateFlatRestriction([odd], at(0, 0.95)).active?.id, 'odd');
  });

  it('a lifted earlier rule does not shadow a later matching one', () => {
    const lifted = flatRule({ id: 'lifted', metric: 'budget.percentOfBudget', op: '>=', value: 0.5, restrict: true, clearBelow: 0.9 });
    assert.equal(evaluateFlatRestriction([lifted, heavy], at(200, 0.6)).active?.id, 'heavy');
  });

  it('a newly matching earlier rule takes over from a held later one', () => {
    const r = evaluateFlatRestriction([heavy, budget], at(200, 0.95), 'budget');
    assert.equal(r.active?.id, 'heavy');
    assert.equal(r.held, false);
    assert.equal(r.cleared, false);
  });

  it('a held rule that was removed, or no longer restricts, clears immediately', () => {
    assert.equal(evaluateFlatRestriction([heavy], at(0, 0.95), 'budget').cleared, true);
    const demoted = { ...budget, restrict: false };
    assert.equal(evaluateFlatRestriction([demoted], at(0, 0.95), 'budget').cleared, true);
    assert.equal(evaluateFlatRestriction([demoted], at(0, 0.95), 'budget').active, null);
  });

  it('with no previous restriction nothing is "cleared" and nothing is held', () => {
    const r = evaluateFlatRestriction([budget], at(0, 0.95));
    assert.deepEqual([r.active, r.cleared, r.held], [null, false, false]);
  });

  it('while the metric is unavailable a held restriction with clearBelow stays (it is not below anything)', () => {
    const held = evaluateFlatRestriction([budget], ctxOf(null), 'budget');
    assert.equal(held.active?.id, 'budget');
    assert.equal(held.held, true);
    assert.equal(held.reason, 'budget.percentOfBudget >= 1 (now n/a)');
    // ... but one without clearBelow clears.
    assert.equal(evaluateFlatRestriction([heavy], ctxOf(null), 'heavy').cleared, true);
  });
});

describe('evaluateFlatRestriction — velocity rules need the alert history (B6)', () => {
  const velocity = flatRule({ id: 'fast', metric: 'velocity.creditsPerHour', op: '>', value: 1, restrict: true });
  const history = [
    { ts: NOW - H, todayCredits: 10 },
    { ts: NOW - H / 2, todayCredits: 40 },
    { ts: NOW, todayCredits: 70 },
  ];

  it('matches when the context is built with history', () => {
    const r = evaluateFlatRestriction([velocity], ctxOf(ruleSnapshot(), history, NOW));
    assert.equal(r.active?.id, 'fast');
    assert.equal(r.reason, 'velocity.creditsPerHour > 1 (now 60)');
  });

  it('never matches without history, which is what the old reconcile (it passed none) did: B6', () => {
    assert.equal(evaluateFlatRestriction([velocity], ctxOf(ruleSnapshot(), undefined, NOW)).active, null);
  });

  it('the least-squares rate falls back to 0 after a midnight reset inside the window', () => {
    const afterReset = [
      { ts: NOW - H, todayCredits: 200 },
      { ts: NOW - 1000, todayCredits: 3 },
      { ts: NOW, todayCredits: 3 },
    ];
    assert.equal(evaluateFlatRestriction([velocity], ctxOf(ruleSnapshot(), afterReset, NOW)).active, null);
  });
});

describe('evaluateFlatRestriction — inputs', () => {
  it('takes the rules as a readonly list and never modifies them', () => {
    const rules: readonly FlatAlertRule[] = Object.freeze([Object.freeze({ ...heavy })]);
    assert.equal(evaluateFlatRestriction(rules, at(500)).active?.id, 'heavy');
  });
});

import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RestrictionEngine } from '../../src/extension-backend/app/RestrictionEngine';
import { buildSnapshot } from './snapshotFixture';
import { makeEvent } from './helpers';
import type { FlatAlertRule } from '../../src/extension-backend/domain/contracts';
import type { RestrictionState } from '../../src/extension-backend/domain/types';
import { flatRule } from './flatAlertsFixture';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-restriction-'));
}

function snapshot(credits = 100) {
  return buildSnapshot([makeEvent({ ts: Date.now() - 1000, credits })], {
    now: Date.now(),
    currency: 'USD',
    pricePerCredit: 0.04,
    monthlyBudget: null,
    includedCredits: 300,
    filter: {},
    source: 'local',
    status: { kind: 'ok' },
    authStatus: 'signed-out',
  });
}

const RESTRICT_RULE: FlatAlertRule = flatRule({ id: 'stop-at-50', metric: 'today.credits', op: '>', value: 50, severity: 'critical', restrict: true });

describe('RestrictionEngine', () => {
  it('starts inactive with the default state', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    const state = engine.getState();
    assert.equal(state.active, false);
    assert.equal(engine.isRestricted(), false);
    engine.dispose();
  });

  it('reconcile activates a matching restrict rule and persists across instances', async () => {
    const dir = await tmpDir();
    const engine = new RestrictionEngine(dir);
    const fired: RestrictionState[] = [];
    engine.onDidChange((s) => fired.push(s));

    const state = await engine.reconcile({
      snapshot: snapshot(100),
      rules: [RESTRICT_RULE],
    });

    assert.equal(state.active, true);
    assert.equal(state.ruleId, 'stop-at-50');
    assert.equal(engine.isRestricted(), true);
    assert.ok(fired.length >= 1);
    engine.dispose();

    // A fresh engine on the same storage dir reads the persisted state.
    const engine2 = new RestrictionEngine(dir);
    assert.equal(engine2.getState().active, true);
    engine2.dispose();
  });

  it('reconcile deactivates when the rule no longer matches', async () => {
    const dir = await tmpDir();
    const engine = new RestrictionEngine(dir);
    await engine.reconcile({ snapshot: snapshot(100), rules: [RESTRICT_RULE] });
    assert.equal(engine.isRestricted(), true);

    await engine.reconcile({ snapshot: snapshot(10), rules: [RESTRICT_RULE] });
    assert.equal(engine.isRestricted(), false);
    engine.dispose();
  });

  it('snooze suppresses isRestricted until the override expires', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    await engine.reconcile({ snapshot: snapshot(100), rules: [RESTRICT_RULE] });
    assert.equal(engine.isRestricted(), true);

    await engine.snooze(15);
    assert.equal(engine.isRestricted(), false, 'snoozed');
    assert.equal(engine.getState().active, true, 'still active underneath');
    assert.equal(engine.isRestricted(Date.now() + 16 * 60_000), true, 'expired override');
    engine.dispose();
  });

  it('clearAll wipes the state back to defaults', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    await engine.reconcile({ snapshot: snapshot(100), rules: [RESTRICT_RULE] });
    await engine.clearAll();
    const state = engine.getState();
    assert.equal(state.active, false);
    assert.equal(state.ruleId, '');
    engine.dispose();
  });

  it('simulate reports the desired state without mutating the engine', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    const report = await engine.simulate({
      snapshot: snapshot(100),
      rules: [RESTRICT_RULE],
    });
    assert.equal(report.state.active, false, 'simulate must not apply');
    assert.equal(report.desired.active?.id, 'stop-at-50');
    assert.deepEqual(report.desired.matching.map((r) => r.id), ['stop-at-50']);
    assert.equal(report.desired.reason, 'today.credits > 50 (now 100)');
    assert.deepEqual(report.rules, [RESTRICT_RULE]);
    assert.equal(engine.getState().active, false);
    engine.dispose();
  });

  it('a malformed state file degrades to the default state', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'restriction.json'), '{not json', 'utf8');
    const engine = new RestrictionEngine(dir);
    assert.equal(engine.getState().active, false);
    engine.dispose();
  });

  it('reconcile honours an active override while restricted (returns early)', async () => {
    const dir = await tmpDir();
    const engine = new RestrictionEngine(dir);
    await engine.reconcile({ snapshot: snapshot(100), rules: [RESTRICT_RULE] });
    assert.equal(engine.getState().active, true);
    await engine.snooze(15); // override active, state.active stays true underneath
    const state = await engine.reconcile({
      snapshot: snapshot(100),
      rules: [RESTRICT_RULE],
      now: Date.now() + 5 * 60_000, // override still active
    });
    // Early-return: state unchanged (still active, override still set, no new fire)
    assert.equal(state.active, true);
    assert.ok(state.userOverrideUntil);
    engine.dispose();
  });

  it('the reason is the rule condition, and it is refreshed (with a change event) when the user edits the rule', async () => {
    const dir = await tmpDir();
    const engine = new RestrictionEngine(dir);
    await engine.reconcile({ snapshot: snapshot(100), rules: [RESTRICT_RULE] });
    assert.equal(engine.getState().reasonMessage, 'today.credits > 50');
    const fired: RestrictionState[] = [];
    engine.onDidChange((s) => fired.push(s));
    await engine.reconcile({ snapshot: snapshot(100), rules: [{ ...RESTRICT_RULE, value: 40 }] });
    assert.equal(engine.getState().reasonMessage, 'today.credits > 40');
    assert.equal(fired.length, 1);
    engine.dispose();
  });

  it('a value that keeps changing does not churn the state: no event, no new reason, no re-prompt', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    await engine.reconcile({ snapshot: snapshot(100), rules: [RESTRICT_RULE] });
    const fired: RestrictionState[] = [];
    engine.onDidChange((s) => fired.push(s));
    const before = engine.getState();
    for (const credits of [101, 130, 99]) await engine.reconcile({ snapshot: snapshot(credits), rules: [RESTRICT_RULE] });
    assert.deepEqual(engine.getState(), before);
    assert.deepEqual(fired, []);
    engine.dispose();
  });

  it('a velocity rule restricts once the alert history is passed in (it never matched without one: B6)', async () => {
    const velocity = flatRule({ id: 'fast', metric: 'velocity.creditsPerHour', op: '>', value: 1, restrict: true });
    const now = Date.now();
    const history = [
      { ts: now - 3_600_000, todayCredits: 10 },
      { ts: now, todayCredits: 70 },
    ];
    const engine = new RestrictionEngine(await tmpDir());
    await engine.reconcile({ snapshot: snapshot(100), rules: [velocity], now });
    assert.equal(engine.getState().active, false, 'no history, no rate');
    await engine.reconcile({ snapshot: snapshot(100), rules: [velocity], history, now });
    assert.equal(engine.getState().ruleId, 'fast');
    engine.dispose();
  });

  it('with no snapshot yet nothing restricts', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    await engine.reconcile({ snapshot: null, rules: [RESTRICT_RULE] });
    assert.equal(engine.getState().active, false);
    engine.dispose();
  });
});

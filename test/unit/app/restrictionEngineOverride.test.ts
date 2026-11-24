import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mock } from 'node:test';
import { RestrictionEngine } from '../../../src/extension-backend/app/RestrictionEngine';
import {
  decideRestrictionPrompt,
  restrictionStatus,
} from '../../../src/extension-backend/app/restrictionUi';
import { buildSnapshot } from '../snapshotFixture';
import { makeEvent } from '../helpers';
import type { AlertRule, RestrictionState } from '../../../src/extension-backend/domain/types';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-restriction-ovr-'));
}

function snapshot(credits: number) {
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

/** Restricts above 50 credits today; only lifts once today's credits fall below 10. */
const HYSTERESIS_RULE: AlertRule = {
  id: 'budget-stop',
  severity: 'critical',
  message: 'Over 50 credits',
  when: { '>': [{ var: 'today.credits' }, 50] },
  restrict: { reEnableWhen: { '<': [{ var: 'today.credits' }, 10] } },
};

const reconcile = (engine: RestrictionEngine, credits: number, rules: AlertRule[] = [HYSTERESIS_RULE]) =>
  engine.reconcile({ snapshot: snapshot(credits), rules, signedIn: false });

describe('RestrictionEngine — reEnableWhen hysteresis', () => {
  it('stays restricted after `when` stops matching until reEnableWhen holds, then lifts', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    await reconcile(engine, 100);
    assert.equal(engine.getState().active, true, 'restricted over 50');

    await reconcile(engine, 30); // `when` is false, reEnableWhen (<10) is not yet true
    assert.equal(engine.getState().active, true, 'hysteresis holds the restriction');

    await reconcile(engine, 5); // reEnableWhen true
    assert.equal(engine.getState().active, false, 'lifted once the re-enable condition holds');

    await reconcile(engine, 30); // between thresholds again: must not re-trigger
    assert.equal(engine.getState().active, false);
    engine.dispose();
  });

  it('does not flap: a rule whose reEnableWhen holds does not restrict even while `when` matches', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    const overlapping: AlertRule = { ...HYSTERESIS_RULE, restrict: { reEnableWhen: true } };
    const fired: RestrictionState[] = [];
    engine.onDidChange((s) => fired.push(s));
    await reconcile(engine, 100, [overlapping]);
    await reconcile(engine, 100, [overlapping]);
    assert.equal(engine.getState().active, false);
    assert.equal(fired.length, 0, 'no activate/clear churn');
    engine.dispose();
  });

  it('clears when the held rule is removed from the config', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    await reconcile(engine, 100);
    await reconcile(engine, 30, []);
    assert.equal(engine.getState().active, false);
    engine.dispose();
  });

  it('a rule without reEnableWhen still clears as soon as it stops matching', async () => {
    const engine = new RestrictionEngine(await tmpDir());
    const plain: AlertRule = { ...HYSTERESIS_RULE, restrict: {} };
    await reconcile(engine, 100, [plain]);
    await reconcile(engine, 30, [plain]);
    assert.equal(engine.getState().active, false);
    engine.dispose();
  });
});

describe('RestrictionEngine — snooze expiry', () => {
  afterEach(() => mock.timers.reset());

  it('clears an expired override with a change event so the popup can re-prompt', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const engine = new RestrictionEngine(await tmpDir());
    await reconcile(engine, 100);
    const fired: RestrictionState[] = [];
    engine.onDidChange((s) => fired.push(s));

    await engine.snooze(15);
    assert.equal(fired.length, 1);
    assert.ok(fired[0]!.userOverrideUntil, 'snooze fired with the override set');

    mock.timers.tick(15 * 60_000 + 1);
    assert.equal(fired.length, 2, 'expiry announces itself');
    assert.equal(fired[1]!.active, true, 'still restricted');
    assert.equal(fired[1]!.userOverrideUntil, null, 'override cleared');
    engine.dispose();
  });

  it('reconcile after expiry (e.g. after a restart) also clears the stale override', async () => {
    const dir = await tmpDir();
    const engine = new RestrictionEngine(dir);
    await reconcile(engine, 100);
    await engine.snooze(15);
    const fired: RestrictionState[] = [];
    engine.onDidChange((s) => fired.push(s));

    await engine.reconcile({
      snapshot: snapshot(100),
      rules: [HYSTERESIS_RULE],
      signedIn: false,
      now: Date.now() + 16 * 60_000,
    });
    assert.equal(engine.getState().userOverrideUntil, null);
    assert.equal(fired.length, 1);
    engine.dispose();
  });

  it('dispose() cancels the pending expiry timer', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    const engine = new RestrictionEngine(await tmpDir());
    await reconcile(engine, 100);
    await engine.snooze(15);
    const fired: RestrictionState[] = [];
    engine.onDidChange((s) => fired.push(s));
    engine.dispose();
    mock.timers.tick(20 * 60_000);
    assert.deepEqual(fired, []);
  });
});

const active = (over: Partial<RestrictionState> = {}): RestrictionState => ({
  version: 1,
  active: true,
  ruleId: 'r',
  reasonMessage: 'Over budget',
  firedAt: 1,
  userOverrideUntil: null,
  ...over,
});

describe('decideRestrictionPrompt', () => {
  const now = 1_000_000;

  it('shows once on the transition to active, then not again for the same restriction', () => {
    const first = decideRestrictionPrompt(active(), undefined, now);
    assert.equal(first.show, true);
    const second = decideRestrictionPrompt(active(), first.shownKey, now);
    assert.equal(second.show, false);
  });

  it('shows again when the reason message changes', () => {
    const first = decideRestrictionPrompt(active(), undefined, now);
    assert.equal(decideRestrictionPrompt(active({ reasonMessage: 'Different' }), first.shownKey, now).show, true);
  });

  it('never shows while snoozed (the snooze event itself must not re-open the popup)', () => {
    const shown = decideRestrictionPrompt(active(), undefined, now);
    const snoozed = decideRestrictionPrompt(active({ userOverrideUntil: now + 60_000 }), shown.shownKey, now);
    assert.equal(snoozed.show, false);
  });

  it('re-prompts once the snooze has ended', () => {
    const shown = decideRestrictionPrompt(active(), undefined, now);
    const snoozed = decideRestrictionPrompt(active({ userOverrideUntil: now + 60_000 }), shown.shownKey, now);
    const afterExpiry = decideRestrictionPrompt(active({ userOverrideUntil: null }), snoozed.shownKey, now + 61_000);
    assert.equal(afterExpiry.show, true);
  });

  it('forgets the shown restriction when it goes inactive, so a new one prompts', () => {
    const shown = decideRestrictionPrompt(active(), undefined, now);
    const cleared = decideRestrictionPrompt(active({ active: false }), shown.shownKey, now);
    assert.equal(cleared.show, false);
    assert.equal(decideRestrictionPrompt(active(), cleared.shownKey, now).show, true);
  });
});

describe('restrictionStatus', () => {
  const now = 1_000_000;
  it('reports an active snooze as snoozed even though the restriction is still active underneath', () => {
    assert.equal(restrictionStatus(active({ userOverrideUntil: now + 1 }), now), 'snoozed');
  });
  it('reports an unsnoozed active restriction as the limit', () => {
    assert.equal(restrictionStatus(active(), now), 'limit');
    assert.equal(restrictionStatus(active({ userOverrideUntil: now - 1 }), now), 'limit');
  });
  it('reports nothing when inactive', () => {
    assert.equal(restrictionStatus(active({ active: false }), now), 'none');
  });
});

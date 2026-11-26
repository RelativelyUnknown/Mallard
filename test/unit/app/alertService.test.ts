import { strict as assert } from 'assert';
import { AlertService, ALERT_COOLDOWNS_KEY } from '../../../src/extension-backend/app/AlertService';
import type { FlatAlertRule } from '../../../src/extension-backend/domain/contracts';
import { DEFAULT_USER_CONFIG } from '../../../src/extension-backend/domain/types';
import type { UserConfig } from '../../../src/extension-backend/domain/types';
import { alertSnapshot, flatRule } from '../flatAlertsFixture';
import { makeMemento } from '../helpers';
import type { FakeMemento } from '../helpers';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function cfg(over: Partial<UserConfig> = {}): UserConfig {
  return { ...DEFAULT_USER_CONFIG, ...over };
}

function setup(config: UserConfig = cfg(), state?: FakeMemento) {
  const shown: string[] = [];
  const fired: string[] = [];
  const logs: string[] = [];
  const clock = { now: T0 };
  const service = new AlertService({
    host: {
      showWarningMessage: async (m: string) => {
        shown.push(m);
        return undefined;
      },
    },
    config: () => config,
    clock: () => clock.now,
    ...(state ? { state } : {}),
    logger: { debug() {}, info() {}, warn: (_t: string, m: string) => void logs.push(m), error: (_t: string, m: string) => void logs.push(m) },
  });
  service.onAlertFired(({ message }) => fired.push(message));
  return { service, shown, fired, logs, clock };
}

describe('AlertService', () => {
  describe('built-in alerts', () => {
    it('shows a warning with the fixed message and fires onAlertFired once, then respects the cooldown', () => {
      const config = cfg({ monthlyBudget: 100 });
      const { service, shown, fired } = setup(config);

      service.process(alertSnapshot({ percentOfBudget: 1.2 }), { now: T0, config });
      assert.deepEqual(shown, ['budget.percentOfBudget >= 1 (now 1.20)']);
      assert.deepEqual(fired, shown);

      service.process(alertSnapshot({ percentOfBudget: 1.2 }), { now: T0 + HOUR, config });
      assert.equal(shown.length, 1, 'still inside the 4 h cooldown');

      service.process(alertSnapshot({ percentOfBudget: 1.2 }), { now: T0 + 4 * HOUR + 1, config });
      assert.equal(shown.length, 2, 'fires again once the cooldown has passed');
    });

    it('alerts from the least-squares rate across the recorded samples, one sample per call', () => {
      const config = cfg({ alerts: { velocityEnabled: true, velocityCreditsPerHour: 50 } });
      const { service, shown } = setup(config);

      service.process(alertSnapshot({ todayCredits: 0 }), { now: T0, config });
      assert.deepEqual(shown, [], 'one sample is not enough to estimate a rate');

      service.process(alertSnapshot({ todayCredits: 60 }), { now: T0 + HOUR / 2, config });
      assert.deepEqual(shown, ['velocity.creditsPerHour >= 50 (now 120)']);
    });

    it('forgets samples older than an hour', () => {
      const config = cfg({ alerts: { velocityEnabled: true, velocityCreditsPerHour: 50 } });
      const { service, shown } = setup(config);

      service.process(alertSnapshot({ todayCredits: 0 }), { now: T0, config });
      // 2 h later the first sample has aged out, leaving a single sample: no rate.
      service.process(alertSnapshot({ todayCredits: 500 }), { now: T0 + 2 * HOUR, config });
      assert.deepEqual(shown, []);
      assert.deepEqual(service.getHistory().map((s) => s.todayCredits), [500]);
    });

    it('the branch cap follows the snapshot branch', () => {
      const config = cfg({ branchBudgets: { 'feature/x': 40 } });
      const { service, shown } = setup(config);
      service.process(alertSnapshot({ branch: 'main', branchCredits: 90 }), { now: T0, config });
      assert.deepEqual(shown, [], 'no cap for main');
      service.process(alertSnapshot({ branch: 'feature/x', branchCredits: 41 }), { now: T0 + 1, config });
      assert.deepEqual(shown, ['currentBranchCredits >= 40 (now 41)']);
    });
  });

  describe('alert rules', () => {
    const rule = (over: Partial<FlatAlertRule> = {}): FlatAlertRule => flatRule({ id: 'big-day', metric: 'today.credits', op: '>', value: 10, ...over });

    it('notifies for a plain rule, after the built-in alerts', () => {
      const config = cfg({ monthlyBudget: 100, flatRules: [rule()] });
      const { service, shown, fired } = setup(config);

      service.process(alertSnapshot({ percentOfBudget: 1.5, todayCredits: 20 }), { now: T0, config });

      assert.deepEqual(shown, ['budget.percentOfBudget >= 1 (now 1.50)', 'today.credits > 10 (now 20)']);
      assert.deepEqual(fired, shown);
    });

    it('stays quiet for notify:false and for restriction rules, but still applies the rule cooldown', () => {
      const config = cfg({
        flatRules: [rule({ id: 'silent', notify: false }), rule({ id: 'blocking', restrict: true }), rule({ id: 'loud' })],
      });
      const { service, shown } = setup(config);

      service.process(alertSnapshot({ todayCredits: 20 }), { now: T0, config });
      assert.equal(shown.length, 1, 'only the plain rule shows a toast');

      service.process(alertSnapshot({ todayCredits: 20 }), { now: T0 + 1000, config });
      assert.equal(shown.length, 1, 'the rule is on cooldown (1 h default)');
    });

    it('an invalid rule is dropped and reported ONCE, however many snapshots follow; its siblings still fire', () => {
      const config = cfg({ flatRules: [{ id: 'bad', metric: 'nope', op: '>', value: 1 } as never, rule()] });
      const { service, shown, logs } = setup(config);

      service.process(alertSnapshot({ todayCredits: 20 }), { now: T0, config });
      service.process(alertSnapshot({ todayCredits: 20 }), { now: T0 + 1, config });
      service.process(alertSnapshot({ todayCredits: 20 }), { now: T0 + 2, config });

      assert.equal(shown.length, 1);
      assert.equal(logs.length, 1);
      assert.match(logs[0]!, /^mallard\.alerts\.rules\[0\] "bad": metric: unknown metric/);

      // A different problem is a new report; the same one is not repeated, and a fixed list reports nothing.
      const next = cfg({ flatRules: 'oops' as never });
      service.process(alertSnapshot(), { now: T0 + 3, config: next });
      service.process(alertSnapshot(), { now: T0 + 4, config: next });
      assert.equal(logs.length, 2);
      assert.match(logs[1]!, /^mallard\.alerts\.rules: alert rules must be an array/);
    });

    it('a rule without an id in the report is named by position only', () => {
      const config = cfg({ flatRules: [{ metric: 'today.credits' } as never] });
      const { service, logs } = setup(config);
      service.process(alertSnapshot(), { now: T0, config });
      assert.match(logs[0]!, /^mallard\.alerts\.rules\[0\]: id: /);
    });
  });

  describe('cooldowns survive a reload', () => {
    const config = cfg({ monthlyBudget: 100, flatRules: [flatRule({ id: 'big-day', metric: 'currentBranchCredits', op: '>', value: 10, cooldown: '3d' })] });

    it('persists the state under the globalState key, and a fresh service over the same Memento does not repeat the toasts', () => {
      const state = makeMemento();
      const first = setup(config, state);
      first.service.process(alertSnapshot({ percentOfBudget: 1, branchCredits: 20 }), { now: T0, config });
      assert.equal(first.shown.length, 2);
      const saved = state.data.get(ALERT_COOLDOWNS_KEY) as Record<string, number>;
      assert.deepEqual(Object.keys(saved).sort(), ['big-day', 'builtin:budget:100@2023-11'], 'YYYY-MM month keys, the rule id for a rule without a period');
      assert.ok(Object.values(saved).every((at) => at === T0));

      // "Reload": a new service, same globalState.
      const second = setup(config, state);
      second.service.process(alertSnapshot({ percentOfBudget: 1, branchCredits: 20 }), { now: T0 + HOUR, config });
      assert.deepEqual(second.shown, [], 'both are still inside their cooldowns');

      // Without the persisted state the same service would have fired again.
      const amnesiac = setup(config);
      amnesiac.service.process(alertSnapshot({ percentOfBudget: 1, branchCredits: 20 }), { now: T0 + HOUR, config });
      assert.equal(amnesiac.shown.length, 2);
    });

    it('prunes each entry by its own rule cooldown (not a flat 24 h) and writes the pruned state back', () => {
      const state = makeMemento();
      const { service, shown } = setup(config, state);
      service.process(alertSnapshot({ percentOfBudget: 1, branchCredits: 20 }), { now: T0, config });

      // 25 h on: the 4 h budget key is forgotten, the 3 d rule key is kept and still blocks it.
      service.process(alertSnapshot({ percentOfBudget: 1, branchCredits: 20 }), { now: T0 + 25 * HOUR, config });
      assert.equal(shown.length, 3, 'the budget alert fired again, the 3 d rule did not');
      const saved = state.data.get(ALERT_COOLDOWNS_KEY) as Record<string, number>;
      assert.equal(saved['big-day'], T0);

      // 73 h after the rule fired its cooldown is over: it fires again, and the old key is replaced.
      service.process(alertSnapshot({ branchCredits: 20 }), { now: T0 + 73 * HOUR, config });
      assert.equal((state.data.get(ALERT_COOLDOWNS_KEY) as Record<string, number>)['big-day'], T0 + 73 * HOUR);
    });

    it('writes only when something changed', () => {
      const state = makeMemento();
      const { service } = setup(config, state);
      service.process(alertSnapshot({ branchCredits: 0 }), { now: T0, config });
      assert.equal(state.updates.length, 0, 'nothing fired, nothing to forget');
      service.process(alertSnapshot({ branchCredits: 20 }), { now: T0 + 1, config });
      assert.equal(state.updates.length, 1);
      service.process(alertSnapshot({ branchCredits: 20 }), { now: T0 + 2, config });
      assert.equal(state.updates.length, 1, 'still blocked: unchanged');
    });

    it('starts empty from a damaged saved value, keeping only the finite numbers', () => {
      const state = makeMemento({ [ALERT_COOLDOWNS_KEY]: { 'big-day': T0, junk: 'x', worse: null } });
      const { service, shown } = setup(config, state);
      service.process(alertSnapshot({ branchCredits: 20 }), { now: T0 + 1, config });
      assert.deepEqual(shown, [], 'the one valid entry still blocks');
      const other = setup(config, makeMemento({ [ALERT_COOLDOWNS_KEY]: 'nonsense' }));
      other.service.process(alertSnapshot({ branchCredits: 20 }), { now: T0 + 1, config });
      assert.equal(other.shown.length, 1);
    });

    it('logs a failed save instead of throwing', async () => {
      const state = makeMemento();
      state.update = async () => {
        throw new Error('disk full');
      };
      const { service, logs } = setup(config, state);
      service.process(alertSnapshot({ branchCredits: 20 }), { now: T0, config });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(logs, ['could not save the alert cooldowns']);
    });
  });

  describe('injected clock and config accessor', () => {
    it('uses the clock and the config accessor when the caller passes neither', () => {
      const config = cfg({ monthlyBudget: 100 });
      const { service, shown, clock } = setup(config);

      service.process(alertSnapshot({ percentOfBudget: 1 }));
      assert.equal(shown.length, 1);

      clock.now = T0 + 5 * HOUR; // the injected clock decides the cooldown has passed
      service.process(alertSnapshot({ percentOfBudget: 1 }));
      assert.equal(shown.length, 2);
    });

    it('falls back to the wall clock and the default logger when none is injected', () => {
      const shown: string[] = [];
      const service = new AlertService({
        host: { showWarningMessage: async (m: string) => void shown.push(m) },
        config: () => cfg({ monthlyBudget: 100 }),
      });
      service.process(alertSnapshot({ percentOfBudget: 1 }));
      assert.equal(shown.length, 1);
    });

    it('an explicit config wins over the accessor', () => {
      const { service, shown } = setup(cfg()); // accessor: no budget
      service.process(alertSnapshot({ percentOfBudget: 1 }), { config: cfg({ monthlyBudget: 100 }) });
      assert.equal(shown.length, 1);
    });
  });

  it('getHistory() is a copy', () => {
    const { service } = setup();
    service.process(alertSnapshot({ todayCredits: 3 }), { now: T0 });
    service.getHistory().length = 0;
    assert.equal(service.getHistory().length, 1);
  });

  it('dispose() stops delivering onAlertFired', () => {
    const config = cfg({ monthlyBudget: 100 });
    const { service, shown, fired } = setup(config);
    service.dispose();
    service.process(alertSnapshot({ percentOfBudget: 1 }), { now: T0, config });
    assert.equal(shown.length, 1, 'the toast is still shown by the host');
    assert.deepEqual(fired, [], 'but nobody is listening any more');
  });
});

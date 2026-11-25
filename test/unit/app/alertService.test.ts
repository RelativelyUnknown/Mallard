import { strict as assert } from 'assert';
import { AlertService } from '../../../src/extension-backend/app/AlertService';
import { DEFAULT_USER_CONFIG } from '../../../src/extension-backend/domain/types';
import type { AlertRule, SnapshotData, UserConfig } from '../../../src/extension-backend/domain/types';

const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;

function snap(over: { percentOfBudget?: number; todayCredits?: number; signedIn?: boolean } = {}): SnapshotData {
  return {
    budget: { percentOfBudget: over.percentOfBudget ?? 0, usedCost: 0, usedCredits: 0 },
    today: { credits: over.todayCredits ?? 0, cost: 0, tokens: 0 },
    currentBranchCredits: 0,
    authStatus: over.signedIn ? 'signed-in' : 'signed-out',
  } as unknown as SnapshotData;
}

function cfg(over: Partial<UserConfig> = {}): UserConfig {
  return { ...DEFAULT_USER_CONFIG, ...over };
}

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return { id: 'r1', severity: 'warning', message: 'rule fired', when: true, ...over };
}

function setup(config: UserConfig = cfg()) {
  const shown: string[] = [];
  const fired: string[] = [];
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
  });
  service.onAlertFired(({ message }) => fired.push(message));
  return { service, shown, fired, clock };
}

describe('AlertService', () => {
  describe('built-in alerts', () => {
    it('shows a warning and fires onAlertFired once, then respects the cooldown', () => {
      const config = cfg({ monthlyBudget: 100 });
      const { service, shown, fired } = setup(config);

      service.process(snap({ percentOfBudget: 1.2 }), { now: T0, config });
      assert.deepEqual(shown, ['Mallard: Monthly budget of $100 exceeded.']);
      assert.deepEqual(fired, shown);

      service.process(snap({ percentOfBudget: 1.2 }), { now: T0 + HOUR, config });
      assert.equal(shown.length, 1, 'still inside the 4 h cooldown');

      service.process(snap({ percentOfBudget: 1.2 }), { now: T0 + 4 * HOUR + 1, config });
      assert.equal(shown.length, 2, 'fires again once the cooldown has passed');
    });

    it('records one velocity sample per call and alerts from the rate across them', () => {
      const config = cfg({ alerts: { velocityEnabled: true, velocityCreditsPerHour: 50 } });
      const { service, shown } = setup(config);

      service.process(snap({ todayCredits: 0 }), { now: T0, config });
      assert.deepEqual(shown, [], 'one sample is not enough to estimate a rate');

      service.process(snap({ todayCredits: 60 }), { now: T0 + HOUR / 2, config });
      assert.equal(shown.length, 1);
      assert.match(shown[0]!, /about 120 credits\/hour \(threshold 50\)/);
    });

    it('forgets samples older than an hour', () => {
      const config = cfg({ alerts: { velocityEnabled: true, velocityCreditsPerHour: 50 } });
      const { service, shown } = setup(config);

      service.process(snap({ todayCredits: 0 }), { now: T0, config });
      // 2 h later the first sample has aged out, leaving a single sample: no rate.
      service.process(snap({ todayCredits: 500 }), { now: T0 + 2 * HOUR, config });
      assert.deepEqual(shown, []);
    });
  });

  describe('alert rules', () => {
    it('notifies for a plain rule, after the built-in alerts', () => {
      const config = cfg({ monthlyBudget: 100, rules: [rule()] });
      const { service, shown, fired } = setup(config);

      service.process(snap({ percentOfBudget: 1.5 }), { now: T0, config });

      assert.deepEqual(shown, ['Mallard: Monthly budget of $100 exceeded.', 'rule fired']);
      assert.deepEqual(fired, shown);
    });

    it('stays quiet for notify:false and for restriction rules, but still applies the rule cooldown', () => {
      const config = cfg({
        rules: [
          rule({ id: 'silent', notify: false }),
          rule({ id: 'blocking', restrict: {} }),
          rule({ id: 'loud' }),
        ],
      });
      const { service, shown } = setup(config);

      service.process(snap(), { now: T0, config });
      assert.deepEqual(shown, ['rule fired'], 'only the plain rule shows a toast');

      service.process(snap(), { now: T0 + 1000, config });
      assert.equal(shown.length, 1, 'the rule is on cooldown (1 h default)');
    });

    it('feeds sign-in state to the rules', () => {
      const config = cfg({ rules: [rule({ requiresAuth: true })] });
      const { service, shown } = setup(config);

      service.process(snap({ signedIn: false }), { now: T0, config });
      assert.deepEqual(shown, []);
      service.process(snap({ signedIn: true }), { now: T0 + 1, config });
      assert.deepEqual(shown, ['rule fired']);
    });

    it('forgets cooldowns after 24 h, even for a rule whose own cooldown is longer (characterised, pre-existing)', () => {
      const config = cfg({ rules: [rule({ cooldown: '3d' })] });
      const { service, shown } = setup(config);

      service.process(snap(), { now: T0, config });
      service.process(snap(), { now: T0 + 23 * HOUR, config });
      assert.equal(shown.length, 1, 'inside 24 h the 3 d cooldown holds');

      service.process(snap(), { now: T0 + 25 * HOUR, config });
      assert.equal(shown.length, 2, 'the 24 h pruning drops the entry first');
    });
  });

  describe('injected clock and config accessor', () => {
    it('uses the clock and the config accessor when the caller passes neither', () => {
      const config = cfg({ monthlyBudget: 100 });
      const { service, shown, clock } = setup(config);

      service.process(snap({ percentOfBudget: 1 }));
      assert.equal(shown.length, 1);

      clock.now = T0 + 5 * HOUR; // the injected clock decides the cooldown has passed
      service.process(snap({ percentOfBudget: 1 }));
      assert.equal(shown.length, 2);
    });

    it('falls back to the wall clock when no clock is injected', () => {
      const shown: string[] = [];
      const service = new AlertService({
        host: { showWarningMessage: async (m: string) => void shown.push(m) },
        config: () => cfg({ monthlyBudget: 100 }),
      });
      service.process(snap({ percentOfBudget: 1 }));
      assert.equal(shown.length, 1);
    });

    it('an explicit config wins over the accessor', () => {
      const { service, shown } = setup(cfg()); // accessor: no budget
      service.process(snap({ percentOfBudget: 1 }), { config: cfg({ monthlyBudget: 100 }) });
      assert.equal(shown.length, 1);
    });
  });

  it('dispose() stops delivering onAlertFired', () => {
    const config = cfg({ monthlyBudget: 100 });
    const { service, shown, fired } = setup(config);
    service.dispose();
    service.process(snap({ percentOfBudget: 1 }), { now: T0, config });
    assert.equal(shown.length, 1, 'the toast is still shown by the host');
    assert.deepEqual(fired, [], 'but nobody is listening any more');
  });
});

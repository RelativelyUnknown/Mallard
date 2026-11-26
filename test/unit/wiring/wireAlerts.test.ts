import { strict as assert } from 'assert';
import { AlertService, ALERT_COOLDOWNS_KEY } from '../../../src/extension-backend/app/AlertService';
import type { IConfigService } from '../../../src/extension-backend/app/ConfigService';
import type { FlatAlertRule } from '../../../src/extension-backend/domain/contracts';
import type { LegacyRule } from '../../../src/extension-backend/domain/flatAlertImport';
import { DEFAULT_USER_CONFIG } from '../../../src/extension-backend/domain/types';
import type { UserConfig } from '../../../src/extension-backend/domain/types';
import type { Logger } from '../../../src/extension-backend/util/logger';
import { wireAlerts } from '../../../src/extension-backend/wiring/wireAlerts';
import type { AlertWiringDeps } from '../../../src/extension-backend/wiring/wireAlerts';
import type { WiringScope } from '../../../src/extension-backend/wiring/scope';
import { alertSnapshot } from '../flatAlertsFixture';
import { makeMemento } from '../helpers';
import type { FakeMemento } from '../helpers';

function scope(globalState: FakeMemento = makeMemento()): WiringScope & { started: Array<() => void> } {
  return {
    context: { subscriptions: [], globalState } as unknown as WiringScope['context'],
    storageDir: '/unused',
    started: [],
  };
}

/** A config service over a mutable config, recording what `update` was asked to write. */
function configService(initial: Partial<UserConfig> = {}) {
  const box = { cfg: { ...DEFAULT_USER_CONFIG, monthlyBudget: 100, ...initial } as UserConfig };
  const updates: Array<Partial<UserConfig>> = [];
  const service = {
    get: () => box.cfg,
    update: async (patch: Partial<UserConfig>) => {
      updates.push(patch);
      box.cfg = { ...box.cfg, ...patch };
    },
  } as Pick<IConfigService, 'get' | 'update'>;
  return { box, updates, service };
}

function recorder() {
  const logs: string[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn: (_tag: string, msg: string) => void logs.push(msg),
    error: (_tag: string, msg: string) => void logs.push(`ERROR ${msg}`),
  };
  const infos: string[] = [];
  return { logs, logger, infos, ui: { info: (m: string) => void infos.push(m) } };
}

const legacy = (over: Partial<LegacyRule> = {}): LegacyRule => ({
  id: 'busy',
  severity: 'warning',
  message: 'x',
  conditions: [{ field: 'today.credits', op: '>', value: 80 }],
  ...over,
});

describe('wireAlerts', () => {
  it('builds an AlertService over the user config and the given host, and registers its cleanup', async () => {
    const shown: string[] = [];
    const s = scope();
    const { alerts } = await wireAlerts(s, {
      userConfig: configService().service,
      host: { showWarningMessage: async (m: string) => void shown.push(m) },
    });

    assert.ok(alerts instanceof AlertService);
    alerts.process(alertSnapshot({ percentOfBudget: 1 }));
    assert.deepEqual(shown, ['budget.percentOfBudget >= 1 (now 1)'], 'the config accessor reads the user config');
    assert.equal(s.started.length, 1);
    s.started[0]!();
  });

  it('defaults the host to the real VS Code window', async () => {
    const s = scope();
    const { alerts } = await wireAlerts(s, { userConfig: configService().service });
    assert.ok(alerts);
    s.started[0]!();
  });

  it('keeps the cooldowns in globalState, so a reload does not repeat a toast', async () => {
    const state = makeMemento();
    const shown: string[] = [];
    const deps: AlertWiringDeps = { userConfig: configService().service, host: { showWarningMessage: async (m: string) => void shown.push(m) } };

    const first = await wireAlerts(scope(state), deps);
    first.alerts.process(alertSnapshot({ percentOfBudget: 1 }), { now: 1_700_000_000_000 });
    assert.equal(shown.length, 1);
    assert.ok(state.data.has(ALERT_COOLDOWNS_KEY));

    // "Reload": a fresh service over the same globalState.
    const second = await wireAlerts(scope(state), deps);
    second.alerts.process(alertSnapshot({ percentOfBudget: 1 }), { now: 1_700_000_000_000 + 60_000 });
    assert.equal(shown.length, 1, 'still inside the 4 h cooldown');
  });

  describe('converting the alert rules of an old config.json', () => {
    const imported = (rules: LegacyRule[], backup = '/store/config.json.migrated') => ({ legacyRules: rules, legacyGroups: [], backup });

    it('appends the converted rules to mallard.alerts.rules and says so in ONE message, logging each skipped rule', async () => {
      const cfg = configService();
      const r = recorder();
      await wireAlerts(scope(), {
        userConfig: cfg.service,
        imported: imported([
          legacy(),
          legacy({ id: 'two', when: { and: [true, true] } }),
          legacy({ id: 'gated', requiresAuth: true }),
        ]),
        ui: r.ui,
        logger: r.logger,
      });

      assert.equal(cfg.updates.length, 1);
      const written = cfg.updates[0]!.flatRules!;
      assert.deepEqual(written.map((x) => [x.id, x.metric, x.op, x.value]), [['busy', 'today.credits', '>', 80]]);
      assert.deepEqual(r.infos, [
        'Converted 1 alert rule to the new format; 2 could not be converted (reasons are in the output channel; the original is kept in config.json.migrated).',
      ]);
      assert.equal(r.logs.length, 2);
      assert.match(r.logs[0]!, /legacy alert rule "two" was not converted: "when": it uses "and"/);
      assert.match(r.logs[1]!, /legacy alert rule "gated" was not converted: requiresAuth/);
    });

    it('keeps the rules already in the setting and never duplicates an id, so a repeat adds nothing and says nothing', async () => {
      const existing: FlatAlertRule = { id: 'mine', metric: 'today.cost', op: '>', value: 5, cooldown: '1h', severity: 'info' };
      const cfg = configService({ flatRules: [existing] });
      const r = recorder();
      const deps = { userConfig: cfg.service, imported: imported([legacy(), legacy({ id: 'mine' })]), ui: r.ui, logger: r.logger };

      await wireAlerts(scope(), deps);
      assert.deepEqual(cfg.box.cfg.flatRules!.map((x) => x.id), ['mine', 'busy'], 'appended; "mine" is not replaced or duplicated');
      assert.equal(r.infos.length, 1);

      await wireAlerts(scope(), deps);
      assert.deepEqual(cfg.box.cfg.flatRules!.map((x) => x.id), ['mine', 'busy']);
      assert.equal(cfg.updates.length, 1, 'the second run wrote nothing');
      assert.equal(r.infos.length, 1, 'and said nothing');
    });

    it('does nothing when the import found no rules (every later activation)', async () => {
      const cfg = configService();
      const r = recorder();
      await wireAlerts(scope(), { userConfig: cfg.service, imported: imported([]), ui: r.ui, logger: r.logger });
      await wireAlerts(scope(), { userConfig: cfg.service, ui: r.ui, logger: r.logger });
      assert.deepEqual([cfg.updates, r.infos, r.logs], [[], [], []]);
    });

    it('reports only the failures when no rule could be converted', async () => {
      const cfg = configService();
      const r = recorder();
      await wireAlerts(scope(), { userConfig: cfg.service, imported: imported([legacy({ requiresAuth: true })], '/store/config.json.migrated-2'), ui: r.ui, logger: r.logger });
      assert.equal(cfg.updates.length, 0);
      assert.deepEqual(r.infos, [
        'Converted 0 alert rules to the new format; 1 could not be converted (reasons are in the output channel; the original is kept in config.json.migrated-2).',
      ]);
    });

    it('a converted rule the flat-rule schema rejects is reported as not converted', async () => {
      const cfg = configService();
      const r = recorder();
      await wireAlerts(scope(), { userConfig: cfg.service, imported: imported([legacy({ notify: 'yes' as never })]), ui: r.ui, logger: r.logger });
      assert.equal(cfg.updates.length, 0);
      assert.match(r.logs[0]!, /legacy alert rule "busy" was not converted: notify/);
      assert.match(r.infos[0]!, /^Converted 0 alert rules to the new format; 1 could not be converted/);
    });

    it('without a backup path it names config.json.migrated, and a lone success has no "could not" clause', async () => {
      const r = recorder();
      await wireAlerts(scope(), {
        userConfig: configService().service,
        imported: { legacyRules: [legacy()], legacyGroups: [] },
        ui: r.ui,
        logger: r.logger,
      });
      assert.deepEqual(r.infos, ['Converted 1 alert rule to the new format (the original is kept in config.json.migrated).']);
    });

    it('tells the user when the converted rules could not be saved, and keeps going', async () => {
      const cfg = configService();
      cfg.service.update = async () => {
        throw new Error('settings.json is read-only');
      };
      const r = recorder();
      const { alerts } = await wireAlerts(scope(), { userConfig: cfg.service, imported: imported([legacy()]), ui: r.ui, logger: r.logger });
      assert.ok(alerts);
      assert.match(r.logs[0]!, /^ERROR could not save the converted alert rules/);
      assert.deepEqual(r.infos, ['Could not save the converted alert rules to settings (see the Mallard output). The original is kept in config.json.migrated.']);
    });

    it('a rule with several threshold levels becomes several flat rules, counted one by one', async () => {
      const cfg = configService();
      const r = recorder();
      await wireAlerts(scope(), {
        userConfig: cfg.service,
        imported: imported([
          {
            id: 'month',
            severity: 'info',
            thresholds: [
              { field: 'month.credits', op: '>', value: 200, severity: 'info' },
              { field: 'month.credits', op: '>', value: 300, severity: 'critical' },
            ],
          },
        ]),
        ui: r.ui,
        logger: r.logger,
      });
      assert.deepEqual(cfg.updates[0]!.flatRules!.map((x) => x.id), ['month:1', 'month:2']);
      assert.match(r.infos[0]!, /^Converted 2 alert rules to the new format \(/);
    });
  });
});

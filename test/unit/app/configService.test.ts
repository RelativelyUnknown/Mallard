import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import {
  ConfigIO,
  ConfigService,
  toUserConfig,
  userConfigPairs,
  vscodeConfigIO,
  watchValue,
} from '../../../src/extension-backend/app/ConfigService';
import { readSettings, SETTING_ENTRIES, SettingKey } from '../../../src/extension-backend/config/settings';
import type { UserConfig } from '../../../src/extension-backend/domain/types';
import type { Logger } from '../../../src/extension-backend/util/logger';

/** A settings store the tests can poke: `change()` is VS Code's onDidChangeConfiguration for `mallard`. */
function fakeIO(initial: Partial<Record<SettingKey, unknown>> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Set<() => void>();
  const writes: Array<[string, unknown]> = [];
  const io: ConfigIO = {
    read: (key) => values.get(key),
    write: async (key, value) => {
      await Promise.resolve();
      writes.push([key, value]);
      if (value === undefined) values.delete(key);
      else values.set(key, value);
    },
    watch: (cb) => {
      listeners.add(cb);
      return { dispose: () => void listeners.delete(cb) };
    },
  };
  return { io, values, writes, listeners, change: () => [...listeners].forEach((cb) => cb()) };
}

function logSpy(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  const noop = (): void => undefined;
  return { debug: noop, info: noop, error: noop, warn: (_tag, msg) => void warnings.push(msg), warnings };
}

const R1 = { id: 'r1', metric: 'today.credits', op: '>', value: 50, cooldown: '1h', severity: 'warning' } as const;

describe('ConfigService.get — the UserConfig view of the settings', () => {
  it('returns the documented defaults when nothing is configured', () => {
    const cfg = new ConfigService(fakeIO().io, logSpy()).get();
    assert.equal(cfg.monthlyBudget, 0);
    assert.equal(cfg.includedCredits, 300);
    assert.equal(cfg.dailyCreditAlert, 50);
    assert.deepEqual(cfg.alerts, { velocityEnabled: true, velocityCreditsPerHour: 100 });
    assert.deepEqual(cfg.flatRules, []);
    assert.deepEqual(cfg.branchBudgets, {});
    assert.equal(cfg.currency, 'USD');
    assert.deepEqual(cfg.display, { dailyBarsWindow: 30, heatmapWeeks: 52, topN: 8 });
    assert.deepEqual(cfg.githubBilling, { mode: 'vscode-session' });
    assert.deepEqual(cfg.export, { webhookTargets: [], mqttTargets: [] });
  });

  it('has no rules-language fields, no dashboard and no budget block', () => {
    const cfg = new ConfigService(fakeIO().io, logSpy()).get();
    for (const gone of ['rules', 'groups', 'vars', 'version']) assert.ok(!(gone in cfg), gone);
    assert.equal(cfg.dashboard, undefined);
    assert.ok(!('budget' in cfg));
  });

  it('reads configured values through the sanitisers (clamping, defaults for junk, per-entry validation)', () => {
    const { io } = fakeIO({
      'mallard.monthlyBudget': 25,
      'mallard.includedCredits': -3,
      'mallard.dailyCreditAlert': 'lots',
      'mallard.alerts.velocityEnabled': false,
      'mallard.alerts.velocityCreditsPerHour': 40,
      'mallard.alerts.rules': [R1, { id: 'broken' }],
      'mallard.branchBudgets': { main: 500 },
      'mallard.currency': 'eur',
      'mallard.display.dailyBarsWindow': 500,
      'mallard.display.heatmapWeeks': 12,
      'mallard.display.topN': 'many',
      'mallard.githubBilling.mode': 'pat',
      'mallard.githubBilling.org': ' acme ',
      'mallard.export.webhookTargets': [{ id: 'team', name: 'Team', url: 'https://t.example' }],
      'mallard.export.mqttTargets': [{ id: 'broker', name: 'Broker', url: 'wss://b.example/mqtt' }, 'junk'],
    });
    const cfg = new ConfigService(io, logSpy()).get();
    assert.equal(cfg.monthlyBudget, 25);
    assert.equal(cfg.includedCredits, 0, 'clamped to the minimum');
    assert.equal(cfg.dailyCreditAlert, 50, 'junk falls back to the default');
    assert.deepEqual(cfg.alerts, { velocityEnabled: false, velocityCreditsPerHour: 40 });
    assert.deepEqual(cfg.flatRules, [R1], 'the bad entry is dropped, its sibling kept');
    assert.deepEqual(cfg.branchBudgets, { main: 500 });
    assert.equal(cfg.currency, 'EUR');
    assert.deepEqual(cfg.display, { dailyBarsWindow: 90, heatmapWeeks: 12, topN: 8 });
    assert.deepEqual(cfg.githubBilling, { mode: 'pat', org: 'acme' });
    assert.deepEqual(cfg.export?.webhookTargets, [{ id: 'team', name: 'Team', url: 'https://t.example' }]);
    assert.deepEqual(cfg.export?.mqttTargets?.map((t) => t.id), ['broker']);
  });

  it('logs each problem once, again only after it went away and came back', () => {
    const f = fakeIO({ 'mallard.branchBudgets': { bad: -1 }, 'mallard.alerts.rules': [{ id: 'x' }] });
    const logger = logSpy();
    const svc = new ConfigService(f.io, logger);
    svc.get();
    svc.get();
    svc.get();
    assert.equal(logger.warnings.length, 2, 'one line per problem, not per read');
    assert.ok(logger.warnings.some((w) => w.startsWith('mallard.branchBudgets:')));
    assert.ok(logger.warnings.some((w) => w.startsWith('mallard.alerts.rules: entry 1 ignored')));

    f.values.set('mallard.branchBudgets', { ok: 1 });
    svc.get();
    assert.equal(logger.warnings.length, 2, 'fixing one logs nothing new');
    f.values.set('mallard.branchBudgets', { bad: -1 });
    svc.get();
    assert.equal(logger.warnings.length, 3, 'it is reported again once it is broken again');
  });

  it('exposes the sanitised settings through toUserConfig for any value set', () => {
    const values = readSettings(() => undefined, () => undefined);
    assert.deepEqual(toUserConfig(values), new ConfigService(fakeIO().io, logSpy()).get());
  });
});

describe('ConfigService.onDidChange', () => {
  it('is the one event: it fires on every mallard.* change and stops after dispose', () => {
    const f = fakeIO();
    const svc = new ConfigService(f.io, logSpy());
    let fired = 0;
    svc.onDidChange(() => fired++);
    f.change();
    f.change();
    assert.equal(fired, 2);
    svc.dispose();
    assert.equal(f.listeners.size, 0, 'the VS Code subscription is released');
    f.change();
    assert.equal(fired, 2);
  });
});

describe('ConfigService.update', () => {
  it('writes each defined field to its setting, as whole values, in order', async () => {
    const f = fakeIO();
    const svc = new ConfigService(f.io, logSpy());
    const patch: Partial<UserConfig> = {
      monthlyBudget: 20,
      includedCredits: 500,
      dailyCreditAlert: 0,
      alerts: { velocityEnabled: false, velocityCreditsPerHour: 25 },
      flatRules: [R1],
      branchBudgets: { main: 10, 'feature/x': 5 },
      currency: 'gbp',
      display: { dailyBarsWindow: 14, heatmapWeeks: 26, topN: 5 },
      githubBilling: { mode: 'pat', org: 'acme' },
      export: {
        webhookTargets: [{ id: 'w', name: 'W', url: 'https://w.example' }],
        mqttTargets: [{ id: 'm', name: 'M', url: 'wss://m.example' }],
      },
    };
    await svc.update(patch);
    assert.deepEqual(f.writes, [
      ['mallard.monthlyBudget', 20],
      ['mallard.includedCredits', 500],
      ['mallard.dailyCreditAlert', 0],
      ['mallard.alerts.velocityEnabled', false],
      ['mallard.alerts.velocityCreditsPerHour', 25],
      ['mallard.alerts.rules', [R1]],
      ['mallard.branchBudgets', { main: 10, 'feature/x': 5 }],
      ['mallard.currency', 'GBP'],
      ['mallard.display.dailyBarsWindow', 14],
      ['mallard.display.heatmapWeeks', 26],
      ['mallard.display.topN', 5],
      ['mallard.githubBilling.mode', 'pat'],
      ['mallard.githubBilling.org', 'acme'],
      ['mallard.export.webhookTargets', [{ id: 'w', name: 'W', url: 'https://w.example' }]],
      ['mallard.export.mqttTargets', [{ id: 'm', name: 'M', url: 'wss://m.example' }]],
    ]);
    assert.equal(svc.get().currency, 'GBP', 'what was written is what is read back');
  });

  it('writes only what the patch mentions, and ignores fields that have no setting', async () => {
    const f = fakeIO();
    const svc = new ConfigService(f.io, logSpy());
    await svc.update({ monthlyBudget: 5, dashboard: { columns: 3 } });
    assert.deepEqual(f.writes, [['mallard.monthlyBudget', 5]]);
    f.writes.length = 0;
    await svc.update({});
    await svc.update({ alerts: { velocityEnabled: true } as UserConfig['alerts'], export: { webhookTargets: [] } });
    assert.deepEqual(f.writes, [
      ['mallard.alerts.velocityEnabled', true],
      ['mallard.export.webhookTargets', []],
    ]);
  });

  it('validates before writing: a value is clamped or normalised, never written raw', async () => {
    const f = fakeIO();
    const logger = logSpy();
    const svc = new ConfigService(f.io, logger);
    await svc.update({
      monthlyBudget: -5,
      currency: ' eur ',
      display: { topN: 999 },
      branchBudgets: { ok: 1, bad: -4 },
      flatRules: [R1, { ...R1, id: 'r2', op: '~' } as never],
    });
    assert.deepEqual(f.writes, [
      ['mallard.monthlyBudget', 0],
      ['mallard.alerts.rules', [R1]],
      ['mallard.branchBudgets', { ok: 1 }],
      ['mallard.currency', 'EUR'],
      ['mallard.display.topN', 20],
    ]);
    assert.equal(logger.warnings.length, 2, 'the dropped rule and branch entry are reported');
  });

  it('writes the settings one after another', async () => {
    const order: string[] = [];
    const io: ConfigIO = {
      read: () => undefined,
      write: async (key) => {
        order.push(`start ${key}`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`end ${key}`);
      },
      watch: () => ({ dispose() {} }),
    };
    await new ConfigService(io, logSpy()).update({ monthlyBudget: 1, includedCredits: 2 });
    assert.deepEqual(order, [
      'start mallard.monthlyBudget', 'end mallard.monthlyBudget',
      'start mallard.includedCredits', 'end mallard.includedCredits',
    ]);
  });
});

describe('ConfigService.reset', () => {
  it('clears every setting update() can write, and only those', async () => {
    const f = fakeIO({ 'mallard.monthlyBudget': 9, 'mallard.palette': 'theme', 'mallard.server.url': 'https://x' });
    const svc = new ConfigService(f.io, logSpy());
    await svc.reset();
    const cleared = f.writes.map(([k]) => k).sort();
    assert.ok(f.writes.every(([, v]) => v === undefined));
    assert.deepEqual(cleared, userConfigPairs({}).map(([k]) => k).sort());
    assert.equal(f.values.get('mallard.monthlyBudget'), undefined);
    assert.equal(f.values.get('mallard.palette'), 'theme', 'unrelated settings are not touched');
    assert.equal(f.values.get('mallard.server.url'), 'https://x');
  });

  it('every key a UserConfig patch can write is a setting in the table', () => {
    const keys = new Set(SETTING_ENTRIES.map(([k]) => k));
    for (const [k] of userConfigPairs({})) assert.ok(keys.has(k), k);
  });
});

describe('watchValue', () => {
  it('calls back only when the watched slice changes (compared by content)', () => {
    const f = fakeIO();
    const svc = new ConfigService(f.io, logSpy());
    let org = 'a';
    let other = 1;
    const seen: Array<{ org: string }> = [];
    const sub = watchValue(svc.onDidChange, () => ({ org }), (v) => seen.push(v));
    f.change();
    assert.deepEqual(seen, [], 'nothing changed');
    other++;
    f.change();
    assert.deepEqual(seen, [], 'an unrelated change is ignored');
    org = 'b';
    f.change();
    assert.deepEqual(seen, [{ org: 'b' }]);
    f.change();
    assert.equal(seen.length, 1, 'the same value again is not a change');
    org = 'a';
    f.change();
    assert.equal(seen.length, 2);
    sub.dispose();
    org = 'c';
    f.change();
    assert.equal(seen.length, 2);
    assert.equal(other, 2);
  });
});

describe('vscodeConfigIO (the real VS Code adapter)', () => {
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  const ws = vscode.workspace as Mutable<typeof vscode.workspace>;
  const original = { get: ws.getConfiguration, on: ws.onDidChangeConfiguration };
  afterEach(() => {
    ws.getConfiguration = original.get;
    ws.onDidChangeConfiguration = original.on;
  });

  it('reads and writes the short key under the mallard section, at the Global target', async () => {
    const calls: unknown[][] = [];
    ws.getConfiguration = ((section: string) => ({
      get: (key: string) => (calls.push(['get', section, key]), 42),
      update: (key: string, value: unknown, target: unknown) => (calls.push(['update', section, key, value, target]), Promise.resolve()),
    })) as unknown as typeof ws.getConfiguration;
    assert.equal(vscodeConfigIO.read('mallard.display.topN'), 42);
    await vscodeConfigIO.write('mallard.alerts.rules', [R1]);
    assert.deepEqual(calls, [
      ['get', 'mallard', 'display.topN'],
      ['update', 'mallard', 'alerts.rules', [R1], vscode.ConfigurationTarget.Global],
    ]);
  });

  it('watches the mallard section only', () => {
    let listener: ((e: { affectsConfiguration(s: string): boolean }) => void) | undefined;
    ws.onDidChangeConfiguration = ((fn: typeof listener) => {
      listener = fn;
      return { dispose() {} };
    }) as unknown as typeof ws.onDidChangeConfiguration;
    let fired = 0;
    vscodeConfigIO.watch(() => fired++);
    listener!({ affectsConfiguration: (s) => s === 'mallard' });
    listener!({ affectsConfiguration: (s) => s === 'editor' });
    assert.equal(fired, 1);
  });

  it('is what a ConfigService uses by default', () => {
    ws.getConfiguration = (() => ({ get: () => undefined, update: () => Promise.resolve() })) as unknown as typeof ws.getConfiguration;
    const svc = new ConfigService();
    assert.equal(svc.get().includedCredits, 300);
    svc.dispose();
  });
});

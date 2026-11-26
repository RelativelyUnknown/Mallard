import { strict as assert } from 'assert';
import {
  FIXED_ALERT_METRICS,
  RELOAD_REQUIRED_KEYS,
  readSettings,
  SETTING_ENTRIES,
  SETTINGS,
  SettingKey,
  SettingDef,
  uniqueTargetId,
} from '../../../src/extension-backend/config/settings';

/** A sanitize context that records what was reported. */
function ctx(targetIds: Set<string> = new Set()): { reports: string[]; c: Parameters<SettingDef<unknown>['sanitize']>[1] } {
  const reports: string[] = [];
  return { reports, c: { report: (p) => reports.push(p), targetIds } };
}

const GARBAGE: unknown[] = ['text', NaN, Infinity, -Infinity, null, {}, [], true];

const entriesOfType = (type: SettingDef<unknown>['type']) => SETTING_ENTRIES.filter(([, d]) => d.type === type);

describe('settings table — structure', () => {
  it('declares an explicit, valid scope and a description on every setting', () => {
    for (const [key, def] of SETTING_ENTRIES) {
      assert.ok(['application', 'machine', 'machine-overridable'].includes(def.scope), `${key}: ${def.scope}`);
      assert.ok(def.description.length > 20, `${key} needs a description`);
      assert.ok(key.startsWith('mallard.'), key);
    }
  });

  it('keeps budgets, alerts, display, currency and the other user preferences at application scope', () => {
    const application = [
      'mallard.monthlyBudget', 'mallard.includedCredits', 'mallard.dailyCreditAlert',
      'mallard.alerts.velocityEnabled', 'mallard.alerts.velocityCreditsPerHour', 'mallard.alerts.rules',
      'mallard.branchBudgets', 'mallard.currency', 'mallard.palette',
      'mallard.display.dailyBarsWindow', 'mallard.display.heatmapWeeks', 'mallard.display.topN',
      'mallard.refreshIntervalMinutes', 'mallard.dataRetentionDays', 'mallard.enabledConnectors',
      'mallard.githubBilling.mode', 'mallard.githubBilling.org',
    ];
    for (const key of application) assert.equal(SETTINGS[key as SettingKey].scope, 'application', key);
  });

  it('keeps export, server, certificate and pricing-URL settings at machine scope, and only copilotOtelPath overridable', () => {
    const machine = [
      'mallard.server.url', 'mallard.export.transport', 'mallard.export.webhookTargets', 'mallard.export.mqttTargets',
      'mallard.webhook.auth', 'mallard.mqtt.url', 'mallard.mqtt.username',
      'mallard.shared.certificate.file', 'mallard.shared.certificate.keyFile', 'mallard.shared.certificate.caFile',
      'mallard.pricingManifestUrl',
    ];
    for (const key of machine) assert.equal(SETTINGS[key as SettingKey].scope, 'machine', key);
    const overridable = SETTING_ENTRIES.filter(([, d]) => d.scope === 'machine-overridable').map(([k]) => k);
    assert.deepEqual(overridable, ['mallard.copilotOtelPath']);
  });

  it('no longer carries the dead settings', () => {
    for (const dead of ['mallard.copilotLogPath', 'mallard.mqtt.auth', 'mallard.budget.monthlyUsd', 'mallard.budget.includedCredits']) {
      assert.ok(!(dead in SETTINGS), dead);
    }
  });

  it('flags exactly the activation-time settings as reload-required', () => {
    assert.deepEqual([...RELOAD_REQUIRED_KEYS].sort(), ['mallard.dataRetentionDays', 'mallard.enabledConnectors']);
  });

  it('has one definition of the display ranges: the editor-documented ones', () => {
    const range = (k: SettingKey) => [SETTINGS[k].minimum, SETTINGS[k].maximum, SETTINGS[k].default];
    assert.deepEqual(range('mallard.display.dailyBarsWindow'), [7, 90, 30]);
    assert.deepEqual(range('mallard.display.heatmapWeeks'), [4, 52, 52]);
    assert.deepEqual(range('mallard.display.topN'), [3, 20, 8]);
  });

  it('every setting sanitises "unset" to its own default', () => {
    for (const [key, def] of SETTING_ENTRIES) {
      const { c, reports } = ctx();
      assert.deepEqual(def.sanitize(undefined, c), def.default, key);
      assert.deepEqual(reports, [], `${key} must not report an unset value`);
    }
  });

  it('every default is itself valid (it sanitises to itself, with nothing reported)', () => {
    for (const [key, def] of SETTING_ENTRIES) {
      const { c, reports } = ctx();
      assert.deepEqual(def.sanitize(def.default, c), def.default, key);
      assert.deepEqual(reports, [], key);
    }
  });
});

describe('settings table — numbers', () => {
  it('replaces anything that is not a finite number with the default', () => {
    for (const [key, def] of entriesOfType('number').concat(entriesOfType('integer'))) {
      for (const bad of GARBAGE) assert.equal(def.sanitize(bad, ctx().c), def.default, `${key} <- ${String(bad)}`);
    }
  });

  it('clamps into the declared range (the table is the only source of ranges)', () => {
    for (const [key, def] of entriesOfType('number').concat(entriesOfType('integer'))) {
      assert.equal(def.sanitize(def.minimum! - 5, ctx().c), def.minimum, `${key} below`);
      assert.equal(def.sanitize(def.maximum! + 5, ctx().c), def.maximum, `${key} above`);
      assert.equal(def.sanitize(def.minimum, ctx().c), def.minimum, `${key} at min`);
      assert.equal(def.sanitize(def.maximum, ctx().c), def.maximum, `${key} at max`);
    }
  });

  it('truncates integer settings but keeps fractions on number settings', () => {
    assert.equal(SETTINGS['mallard.display.topN'].sanitize(8.9, ctx().c), 8);
    assert.equal(SETTINGS['mallard.display.topN'].sanitize(-1, ctx().c), 3);
    assert.equal(SETTINGS['mallard.monthlyBudget'].sanitize(12.5, ctx().c), 12.5);
    assert.equal(SETTINGS['mallard.refreshIntervalMinutes'].sanitize(0.5, ctx().c), 1);
    assert.equal(SETTINGS['mallard.refreshIntervalMinutes'].sanitize(500, ctx().c), 60);
    assert.equal(SETTINGS['mallard.dataRetentionDays'].sanitize(5, ctx().c), 30);
  });
});

describe('settings table — booleans, strings, enums, currency', () => {
  it('booleans accept only booleans', () => {
    const d = SETTINGS['mallard.alerts.velocityEnabled'];
    assert.equal(d.sanitize(false, ctx().c), false);
    assert.equal(d.sanitize(true, ctx().c), true);
    for (const bad of ['yes', 0, 1, null, {}]) assert.equal(d.sanitize(bad, ctx().c), true, String(bad));
  });

  it('free-text settings are trimmed and fall back to blank', () => {
    const d = SETTINGS['mallard.server.url'];
    assert.equal(d.sanitize('  https://x.example  ', ctx().c), 'https://x.example');
    for (const bad of [5, null, {}, []]) assert.equal(d.sanitize(bad, ctx().c), '', String(bad));
  });

  it('enums accept only their own values', () => {
    for (const [key, def] of SETTING_ENTRIES.filter(([, d]) => d.type === 'string' && d.enum)) {
      for (const v of def.enum!) assert.equal(def.sanitize(v, ctx().c), v, `${key}=${v}`);
      for (const bad of ['nope', 3, null, {}]) assert.equal(def.sanitize(bad, ctx().c), def.default, `${key} <- ${String(bad)}`);
    }
  });

  it('currency is a 3-letter code, upper-cased, else USD', () => {
    const d = SETTINGS['mallard.currency'];
    assert.equal(d.sanitize('eur', ctx().c), 'EUR');
    assert.equal(d.sanitize(' gbp ', ctx().c), 'GBP');
    for (const bad of ['EURO', 'E1R', '', 5, null]) assert.equal(d.sanitize(bad, ctx().c), 'USD', String(bad));
  });
});

describe('settings table — enabledConnectors', () => {
  const d = SETTINGS['mallard.enabledConnectors'];

  it('keeps known ids once each, in order, and reports unknown ones', () => {
    const { c, reports } = ctx();
    assert.deepEqual(d.sanitize(['claude-code', 'bogus', 'copilot', 'claude-code', 7], c), ['claude-code', 'copilot']);
    assert.equal(reports.length, 2);
    assert.match(reports[0]!, /"bogus"/);
  });

  it('allows an empty list (the user turned every connector off)', () => {
    assert.deepEqual(d.sanitize([], ctx().c), []);
  });

  it('uses (a copy of) the default for something that is not an array', () => {
    const { c, reports } = ctx();
    const out = d.sanitize('copilot', c);
    assert.deepEqual(out, ['copilot', 'claude-code']);
    assert.notEqual(out, d.default, 'a fresh array, so callers cannot mutate the table');
    assert.equal(reports.length, 1);
  });
});

describe('settings table — branchBudgets', () => {
  const d = SETTINGS['mallard.branchBudgets'];

  it('keeps valid caps (clamped to the maximum) and reports the others', () => {
    const { c, reports } = ctx();
    const out = d.sanitize({ main: 500, 'feature/x': 0, huge: 5e9, neg: -1, str: '5', nan: NaN, '': 3, nul: null }, c);
    assert.deepEqual(out, { main: 500, 'feature/x': 0, huge: 1_000_000 });
    assert.equal(reports.length, 5);
    assert.ok(reports.some((r) => r.includes('"neg"')));
  });

  it('ignores a value that is not an object', () => {
    for (const bad of ['main', [], 5, null]) {
      const { c, reports } = ctx();
      assert.deepEqual(d.sanitize(bad, c), {}, String(bad));
      assert.equal(reports.length, 1);
    }
  });
});

describe('settings table — alerts.rules (flat rules, validated per entry)', () => {
  const d = SETTINGS['mallard.alerts.rules'];
  const good = { id: 'big-day', metric: 'today.credits', op: '>', value: 200, cooldown: '6h', severity: 'warning' };

  it('accepts every fixed metric, the keyed model/repo metrics, every operator and severity', () => {
    const entries = [
      ...FIXED_ALERT_METRICS.map((metric, i) => ({ ...good, id: `m${i}`, metric })),
      { ...good, id: 'k1', metric: 'model:gpt-4.1.credits' },
      { ...good, id: 'k2', metric: 'repo:my.repo/x.cost' },
      ...['>', '>=', '<', '<=', '==', '!='].map((op, i) => ({ ...good, id: `o${i}`, op })),
      ...['info', 'warning', 'critical'].map((severity, i) => ({ ...good, id: `s${i}`, severity })),
    ];
    const { c, reports } = ctx();
    assert.equal(d.sanitize(entries, c).length, entries.length);
    assert.deepEqual(reports, []);
  });

  it('keeps optional fields when valid and trims the id', () => {
    const out = d.sanitize([{ ...good, id: '  r1 ', notify: true, restrict: false, clearBelow: 120.5, extra: 'dropped' }], ctx().c);
    assert.deepEqual(out, [{ ...good, id: 'r1', notify: true, restrict: false, clearBelow: 120.5 }]);
  });

  it('drops one bad entry (and says why, once per entry) while keeping its siblings', () => {
    const bad: Array<[unknown, RegExp]> = [
      [null, /not an object/],
      ['rule', /not an object/],
      [{ ...good, id: undefined }, /"id" is missing/],
      [{ ...good, id: '   ' }, /"id" is invalid/],
      [{ ...good, metric: 'bogus.metric' }, /"metric" is invalid/],
      [{ ...good, metric: 'model:.credits' }, /"metric" is invalid/],
      [{ ...good, metric: 'model:x.tokens' }, /"metric" is invalid/],
      [{ ...good, op: '~' }, /"op" is invalid/],
      [{ ...good, value: '5' }, /"value" is invalid/],
      [{ ...good, value: NaN }, /"value" is invalid/],
      [{ ...good, value: undefined }, /"value" is missing/],
      [{ ...good, cooldown: '30' }, /"cooldown" is invalid/],
      [{ ...good, cooldown: '0m' }, /"cooldown" is invalid/],
      [{ ...good, cooldown: '2y' }, /"cooldown" is invalid/],
      [{ ...good, severity: 'fatal' }, /"severity" is invalid/],
      [{ ...good, notify: 'yes' }, /"notify" is invalid/],
      [{ ...good, restrict: 1 }, /"restrict" is invalid/],
      [{ ...good, clearBelow: 'low' }, /"clearBelow" is invalid/],
    ];
    const { c, reports } = ctx();
    const out = d.sanitize([{ ...good, id: 'first' }, ...bad.map(([b]) => b), { ...good, id: 'last' }], c);
    assert.deepEqual(out.map((r) => r.id), ['first', 'last']);
    assert.equal(reports.length, bad.length);
    bad.forEach(([, why], i) => {
      assert.ok(reports[i]!.startsWith(`entry ${i + 2} ignored: `), reports[i]!);
      assert.match(reports[i]!, why);
    });
  });

  it('drops a repeated id', () => {
    const { c, reports } = ctx();
    const out = d.sanitize([{ ...good }, { ...good, value: 1 }], c);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.value, 200);
    assert.match(reports[0]!, /entry 2 ignored: duplicate id "big-day"/);
  });

  it('ignores a value that is not an array', () => {
    for (const bad of [{ id: 'x' }, 'rules', 5, null]) {
      const { c, reports } = ctx();
      assert.deepEqual(d.sanitize(bad, c), []);
      assert.equal(reports.length, 1);
    }
  });

  it('does not share ids with the export target lists', () => {
    const ids = new Set(['big-day']);
    assert.equal(d.sanitize([good], ctx(ids).c).length, 1);
  });
});

describe('settings table — export targets', () => {
  const webhooks = SETTINGS['mallard.export.webhookTargets'];
  const mqtts = SETTINGS['mallard.export.mqttTargets'];
  const good = { id: 'team', name: 'Team server', url: 'https://mallard.example.com' };

  it('keeps well-formed targets and trims name and url', () => {
    const { c, reports } = ctx();
    assert.deepEqual(webhooks.sanitize([{ id: 'a.b_c-1', name: ' A ', url: ' https://a.example ' }, { ...good, extra: 1 }], c), [
      { id: 'a.b_c-1', name: 'A', url: 'https://a.example' },
      good,
    ]);
    assert.deepEqual(reports, []);
  });

  it('drops an entry without a usable id, name or url, keeping the rest', () => {
    const bad: Array<[unknown, RegExp]> = [
      [42, /not an object/],
      [{ name: 'n', url: 'u' }, /"id" must be/],
      [{ ...good, id: 'has space' }, /"id" must be/],
      [{ ...good, id: 'x'.repeat(33) }, /"id" must be/],
      [{ ...good, id: 7 }, /"id" must be/],
      [{ ...good, name: '' }, /"name" is missing/],
      [{ ...good, name: 5 }, /"name" is missing/],
      [{ ...good, url: '  ' }, /"url" is missing/],
    ];
    const { c, reports } = ctx();
    const out = mqtts.sanitize([...bad.map(([b]) => b), good], c);
    assert.deepEqual(out, [good]);
    bad.forEach(([, why], i) => assert.match(reports[i]!, why));
  });

  it('shares one id space between the webhook and MQTT lists', () => {
    const values = readSettings(
      (key) =>
        ({
          'mallard.export.webhookTargets': [good, { ...good, id: 'two' }],
          'mallard.export.mqttTargets': [{ ...good, url: 'wss://x.example/mqtt' }, { ...good, id: 'three' }],
        })[key as string],
      () => undefined,
    );
    assert.deepEqual(values['mallard.export.webhookTargets'].map((t) => t.id), ['team', 'two']);
    assert.deepEqual(values['mallard.export.mqttTargets'].map((t) => t.id), ['three'], 'the MQTT "team" repeats a webhook id');
  });

  it('uniqueTargetId makes a valid, free id from any name', () => {
    assert.equal(uniqueTargetId('team', new Set()), 'team');
    assert.equal(uniqueTargetId('team', new Set(['team'])), 'team-2');
    assert.equal(uniqueTargetId('team', new Set(['team', 'team-2'])), 'team-3');
    assert.equal(uniqueTargetId('My Team!', new Set()), 'My-Team');
    assert.equal(uniqueTargetId('///', new Set()), 'target');
    const long = uniqueTargetId('x'.repeat(60), new Set(['x'.repeat(28)]));
    assert.match(long, /^[A-Za-z0-9._-]{1,32}$/);
    assert.equal(long, `${'x'.repeat(28)}-2`);
  });
});

describe('readSettings', () => {
  it('returns every key, reading each through its sanitiser', () => {
    const asked: string[] = [];
    const values = readSettings((key) => { asked.push(key); return undefined; }, () => undefined);
    assert.deepEqual(asked, SETTING_ENTRIES.map(([k]) => k));
    for (const [key, def] of SETTING_ENTRIES) assert.deepEqual(values[key], def.default, key);
  });

  it('prefixes every reported problem with its setting key', () => {
    const problems: string[] = [];
    readSettings((key) => (key === 'mallard.branchBudgets' ? { x: -1 } : undefined), (p) => problems.push(p));
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /^mallard\.branchBudgets: "x" ignored/);
  });
});

import { strict as assert } from 'assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigIO, ConfigService } from '../../../src/extension-backend/app/ConfigService';
import {
  deleteLegacyConfigFiles,
  ImportDeps,
  importLegacyConfig,
  ImportUi,
  vscodeImportUi,
} from '../../../src/extension-backend/app/ConfigImporter';
import { FLAG_CONFIG_IMPORT_WARNED } from '../../../src/extension-backend/app/EphemeralFlags';
import { LAYOUT_V1_KEY } from '../../../src/extension-backend/app/LayoutStore';
import { SECRET_KEYS, targetSecretKey } from '../../../src/extension-backend/app/credentials';
import { queueFileFor } from '../../../src/extension-backend/export/ExportQueue';
import type { UserConfig } from '../../../src/extension-backend/domain/types';
import type { Logger } from '../../../src/extension-backend/util/logger';
import { makeMemento } from '../helpers';

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function harness(opts: { updateFails?: boolean } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mallard-import-'));
  const patches: Array<Partial<UserConfig>> = [];
  const messages = { info: [] as string[], warn: [] as string[] };
  const ui: ImportUi = { info: (m) => void messages.info.push(m), warn: (m) => void messages.warn.push(m) };
  const secrets = new Map<string, string>();
  const state = makeMemento();
  let failNext = opts.updateFails ?? false;
  const deps: ImportDeps = {
    storageDir: dir,
    config: {
      update: async (patch) => {
        if (failNext) throw new Error('Unable to write into user settings');
        patches.push(patch);
      },
    },
    state,
    secrets: {
      get: async (k) => secrets.get(k),
      store: async (k, v) => void secrets.set(k, v),
      delete: async (k) => void secrets.delete(k),
    },
    ui,
    logger: silent,
  };
  const write = (content: unknown, name = 'config.json') =>
    writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return { dir, deps, patches, messages, secrets, state, write, recover: () => void (failNext = false) };
}

const FULL = {
  version: 2,
  monthlyBudget: 20,
  includedCredits: 500,
  dailyCreditAlert: 0,
  alerts: { velocityEnabled: false, velocityCreditsPerHour: 40 },
  branchBudgets: { main: 500 },
  display: { dailyBarsWindow: 14, topN: 5 },
  currency: 'eur',
  githubBilling: { mode: 'pat', org: 'acme' },
  export: {
    webhookTargets: [{ name: 'team', url: 'https://t.example' }],
    mqttTargets: [{ name: 'broker', url: 'wss://b.example/mqtt' }],
  },
  dashboard: { columns: 3, panels: [{ id: 'models', gridColumn: 'span 2', hidden: true }, { id: 'daily', size: 'tall' }] },
  vars: { limit: 10 },
  groups: [{ id: 'g', active: true }],
  rules: [{ id: 'r1', severity: 'warning', message: 'm', when: true }],
};

describe('importLegacyConfig — nothing to import', () => {
  it('does nothing when there is no config.json', async () => {
    const h = harness();
    const r = await importLegacyConfig(h.deps);
    assert.equal(r.status, 'none');
    assert.deepEqual(h.patches, []);
    assert.deepEqual(h.messages, { info: [], warn: [] });
  });

  it('renames an empty config quietly: nothing imported, nothing to say', async () => {
    const h = harness();
    h.write({});
    const r = await importLegacyConfig(h.deps);
    assert.equal(r.status, 'imported');
    assert.deepEqual(r.written, []);
    assert.deepEqual(h.messages.info, []);
    assert.ok(existsSync(path.join(h.dir, 'config.json.migrated')));
  });
});

describe('importLegacyConfig — a full config', () => {
  it('writes the equivalent settings, seeds the layout, keeps the rules in the backup and says so once', async () => {
    const h = harness();
    h.write(FULL);
    const r = await importLegacyConfig(h.deps);

    assert.equal(r.status, 'imported');
    assert.equal(h.patches.length, 1);
    const patch = h.patches[0]!;
    assert.equal(patch.monthlyBudget, 20);
    assert.equal(patch.includedCredits, 500);
    assert.equal(patch.dailyCreditAlert, 0, 'an explicit 0 is imported, it is not "unset"');
    assert.deepEqual(patch.alerts, { velocityEnabled: false, velocityCreditsPerHour: 40 });
    assert.deepEqual(patch.branchBudgets, { main: 500 });
    assert.deepEqual(patch.display, { dailyBarsWindow: 14, topN: 5 });
    assert.equal(patch.currency, 'eur');
    assert.deepEqual(patch.githubBilling, { mode: 'pat', org: 'acme' });
    assert.deepEqual(patch.export, {
      webhookTargets: [{ id: 'team', name: 'team', url: 'https://t.example' }],
      mqttTargets: [{ id: 'broker', name: 'broker', url: 'wss://b.example/mqtt' }],
    });
    assert.ok(!('rules' in patch) && !('groups' in patch) && !('vars' in patch) && !('dashboard' in patch));

    assert.deepEqual(r.legacyRules, FULL.rules);
    assert.deepEqual(r.legacyGroups, FULL.groups);
    assert.deepEqual(r.legacyVars, FULL.vars);
    assert.equal(r.legacyVersion, 2);
    assert.deepEqual(r.skipped, []);
    assert.deepEqual([...r.written].sort(), [
      'alerts.velocityCreditsPerHour', 'alerts.velocityEnabled', 'branchBudgets', 'currency', 'dailyCreditAlert',
      'display.dailyBarsWindow', 'display.topN', 'export.mqttTargets', 'export.webhookTargets',
      'githubBilling.mode', 'githubBilling.org', 'includedCredits', 'monthlyBudget',
    ]);

    assert.ok(!existsSync(path.join(h.dir, 'config.json')), 'the original is renamed away');
    assert.equal(r.backup, path.join(h.dir, 'config.json.migrated'));
    const kept = JSON.parse(readFileSync(r.backup, 'utf8')) as typeof FULL;
    assert.deepEqual(kept.rules, FULL.rules, 'the backup is the untouched original, rules included');

    assert.equal(r.layoutSeeded, true);
    const layout = h.state.get<Array<{ id: string; span: number; hidden: boolean; size: string }>>(LAYOUT_V1_KEY)!;
    assert.deepEqual(layout.slice(0, 2).map((p) => [p.id, p.span, p.hidden, p.size]), [['models', 2, true, 'normal'], ['daily', 2, false, 'tall']]);

    assert.equal(h.messages.info.length, 1, 'exactly one message');
    assert.match(h.messages.info[0]!, /Imported 13 settings, 2 export targets, the dashboard layout from config\.json \(kept as config\.json\.migrated\)/);
    assert.match(h.messages.info[0]!, /1 custom alert rule \(and any groups or variables\) cannot be converted automatically/);
    assert.deepEqual(h.messages.warn, []);
  });

  it('is idempotent: the second start finds nothing and writes nothing', async () => {
    const h = harness();
    h.write(FULL);
    await importLegacyConfig(h.deps);
    const again = await importLegacyConfig(h.deps);
    assert.equal(again.status, 'none');
    assert.equal(h.patches.length, 1);
    assert.equal(h.messages.info.length, 1);
  });

  it('works end to end through the real ConfigService', async () => {
    const values = new Map<string, unknown>();
    const io: ConfigIO = {
      read: (k) => values.get(k),
      write: async (k, v) => void (v === undefined ? values.delete(k) : values.set(k, v)),
      watch: () => ({ dispose() {} }),
    };
    const h = harness();
    h.write(FULL);
    await importLegacyConfig({ ...h.deps, config: new ConfigService(io, silent) });
    assert.equal(values.get('mallard.monthlyBudget'), 20);
    assert.equal(values.get('mallard.currency'), 'EUR');
    assert.deepEqual(values.get('mallard.branchBudgets'), { main: 500 });
    assert.equal(values.get('mallard.githubBilling.org'), 'acme');
    assert.deepEqual(values.get('mallard.export.webhookTargets'), [{ id: 'team', name: 'team', url: 'https://t.example' }]);
  });
});

describe('importLegacyConfig — the layout', () => {
  const withPanels = { dashboard: { panels: [{ id: 'models', hidden: true }] } };

  it('never overwrites a layout that is already stored', async () => {
    const h = harness();
    await h.state.update(LAYOUT_V1_KEY, [{ id: 'daily', span: 1, hidden: false }]);
    h.write(withPanels);
    const r = await importLegacyConfig(h.deps);
    assert.equal(r.layoutSeeded, false);
    assert.deepEqual(h.state.get(LAYOUT_V1_KEY), [{ id: 'daily', span: 1, hidden: false }]);
    assert.deepEqual(h.messages.info, [], 'a layout that was not touched is nothing to report');
  });

  it('leaves the layout alone when the file has no panels (or only columns)', async () => {
    for (const dashboard of [{ columns: 2 }, {}, 'junk']) {
      const h = harness();
      h.write({ monthlyBudget: 1, dashboard });
      const r = await importLegacyConfig(h.deps);
      assert.equal(r.layoutSeeded, false);
      assert.equal(h.state.get(LAYOUT_V1_KEY), undefined);
    }
  });

  it('ignores the retired dashboard.columns option (the grid is always four columns wide), and skips invalid panel entries', async () => {
    const h = harness();
    h.write({ dashboard: { columns: 2, panels: [{ id: 'models', gridColumn: 'span 4' }, { hidden: true }, 'junk'] } });
    const r = await importLegacyConfig(h.deps);
    assert.deepEqual(r.skipped, ['dashboard.panels[1]', 'dashboard.panels[2]']);
    const layout = h.state.get<Array<{ id: string; span: number }>>(LAYOUT_V1_KEY)!;
    assert.equal(layout.find((p) => p.id === 'models')!.span, 4, 'not clamped to the old columns value');
  });
});

describe('importLegacyConfig — export targets keep their credentials', () => {
  it('keeps a valid, free name as the id, so its secrets and retry queue need no move', async () => {
    const h = harness();
    h.secrets.set(targetSecretKey(SECRET_KEYS.webhookApiKey, 'team'), 'k');
    h.write({ export: { webhookTargets: [{ name: 'team', url: 'https://t.example' }] } });
    await importLegacyConfig(h.deps);
    assert.deepEqual([...h.secrets.entries()], [[`${SECRET_KEYS.webhookApiKey}:team`, 'k']]);
  });

  it('generates an id for a name that is not a valid id, and re-keys its secrets and queue file under it', async () => {
    const h = harness();
    const oldQueue = path.join(h.dir, queueFileFor('Team Server!'));
    writeFileSync(oldQueue, '[]');
    h.secrets.set(targetSecretKey(SECRET_KEYS.webhookApiKey, 'Team Server!'), 'api');
    h.secrets.set(targetSecretKey(SECRET_KEYS.webhookSigningSecret, 'Team Server!'), 'sign');
    h.secrets.set(targetSecretKey(SECRET_KEYS.webhookBearerToken, 'Team Server!'), 'bearer-old');
    h.secrets.set(targetSecretKey(SECRET_KEYS.webhookBearerToken, 'Team-Server'), 'bearer-already-there');
    h.write({ export: { webhookTargets: [{ name: 'Team Server!', url: 'https://t.example' }] } });

    await importLegacyConfig(h.deps);

    assert.deepEqual(h.patches[0]!.export!.webhookTargets, [{ id: 'Team-Server', name: 'Team Server!', url: 'https://t.example' }]);
    assert.deepEqual(Object.fromEntries(h.secrets), {
      [`${SECRET_KEYS.webhookApiKey}:Team-Server`]: 'api',
      [`${SECRET_KEYS.webhookSigningSecret}:Team-Server`]: 'sign',
      [`${SECRET_KEYS.webhookBearerToken}:Team-Server`]: 'bearer-already-there',
    });
    assert.ok(!existsSync(oldQueue));
    assert.ok(existsSync(path.join(h.dir, queueFileFor('Team-Server'))), 'the retry backlog follows the id');
  });

  it('does not clobber a retry queue that already exists under the new id', async () => {
    const h = harness();
    writeFileSync(path.join(h.dir, queueFileFor('a b')), 'old');
    writeFileSync(path.join(h.dir, queueFileFor('a-b')), 'new');
    h.write({ export: { webhookTargets: [{ name: 'a b', url: 'https://t.example' }] } });
    await importLegacyConfig(h.deps);
    assert.equal(readFileSync(path.join(h.dir, queueFileFor('a-b')), 'utf8'), 'new');
    assert.ok(existsSync(path.join(h.dir, queueFileFor('a b'))));
  });

  it('gives a name that repeats across the webhook and MQTT lists its own id, and re-keys its MQTT password', async () => {
    const h = harness();
    h.secrets.set(targetSecretKey(SECRET_KEYS.mqttPassword, 'team'), 'pw');
    h.write({
      export: {
        webhookTargets: [{ name: 'team', url: 'https://t.example' }, { name: 'team', url: 'https://t2.example' }],
        mqttTargets: [{ name: 'team', url: 'wss://t.example/mqtt' }],
      },
    });
    const r = await importLegacyConfig(h.deps);
    const exp = h.patches[0]!.export!;
    assert.deepEqual(exp.webhookTargets!.map((t) => t.id), ['team', 'team-2']);
    assert.deepEqual(exp.mqttTargets!.map((t) => t.id), ['team-3']);
    assert.deepEqual(Object.fromEntries(h.secrets), { [`${SECRET_KEYS.mqttPassword}:team-3`]: 'pw' });
    assert.match(h.messages.info[0]!, /3 export targets/);
    assert.equal(r.status, 'imported');
  });
});

describe('importLegacyConfig — lenient: one bad block never costs the others', () => {
  it('skips each invalid block, imports the rest and reports what was skipped', async () => {
    const h = harness();
    h.write({
      monthlyBudget: 'lots',
      includedCredits: 400,
      alerts: [],
      display: { topN: 'many' },
      currency: 'EURO',
      githubBilling: { mode: 'oauth' },
      branchBudgets: { main: 10, dev: 'x' },
      export: { webhookTargets: [{ name: 'ok', url: 'https://ok.example' }, { name: '', url: 'u' }, 7], mqttTargets: 'none' },
    });
    const r = await importLegacyConfig(h.deps);
    assert.equal(r.status, 'imported');
    assert.deepEqual(r.skipped, [
      'monthlyBudget', 'alerts', 'display', 'currency', 'githubBilling',
      'branchBudgets["dev"]', 'export.webhookTargets[1]', 'export.webhookTargets[2]', 'export.mqttTargets',
    ]);
    const patch = h.patches[0]!;
    assert.equal(patch.includedCredits, 400);
    assert.ok(!('monthlyBudget' in patch) && !('alerts' in patch) && !('display' in patch) && !('currency' in patch));
    assert.deepEqual(patch.branchBudgets, { main: 10 });
    assert.deepEqual(patch.export!.webhookTargets, [{ id: 'ok', name: 'ok', url: 'https://ok.example' }]);
    assert.match(h.messages.info[0]!, /could not import monthlyBudget, alerts, display/);
  });

  it('skips a branchBudgets, export or dashboard block of the wrong shape', async () => {
    const h = harness();
    h.write({ branchBudgets: [1], export: 5, includedCredits: 1 });
    const r = await importLegacyConfig(h.deps);
    assert.deepEqual(r.skipped, ['branchBudgets', 'export']);
  });

  it('tells the user about unconvertible rules even when nothing else moved', async () => {
    const h = harness();
    h.write({ rules: [{ id: 'a' }, { id: 'b' }, 'junk'], groups: 'no', vars: [], version: 'x' });
    const r = await importLegacyConfig(h.deps);
    assert.equal(r.legacyRules.length, 2, 'only objects are carried');
    assert.deepEqual([r.legacyGroups, r.legacyVars, r.legacyVersion], [[], {}, undefined]);
    assert.equal(h.messages.info.length, 1);
    assert.match(h.messages.info[0]!, /Imported nothing from config\.json/);
    assert.match(h.messages.info[0]!, /2 custom alert rules/);
  });

  it('uses singular wording for a single setting', async () => {
    const h = harness();
    h.write({ monthlyBudget: 5 });
    await importLegacyConfig(h.deps);
    assert.match(h.messages.info[0]!, /Imported 1 setting from/);
    assert.doesNotMatch(h.messages.info[0]!, /Needs your attention/);
  });
});

describe('importLegacyConfig — a file that cannot be imported is left alone', () => {
  it('leaves malformed JSON in place, warns once (not on every start) and writes nothing', async () => {
    const h = harness();
    h.write('{ "monthlyBudget": ');
    const first = await importLegacyConfig(h.deps);
    const second = await importLegacyConfig(h.deps);
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'failed');
    assert.ok(existsSync(path.join(h.dir, 'config.json')), 'still there for the user to fix');
    assert.deepEqual(h.patches, []);
    assert.equal(h.messages.warn.length, 1, 'one warning across restarts');
    assert.match(h.messages.warn[0]!, /could not import .*config\.json/);
    assert.equal(h.state.get(FLAG_CONFIG_IMPORT_WARNED), true);
  });

  it('treats a JSON value that is not an object, or a config.json that is not a file, the same way', async () => {
    const a = harness();
    a.write('[1, 2]');
    assert.equal((await importLegacyConfig(a.deps)).status, 'failed');
    assert.equal(a.messages.warn.length, 1);

    const b = harness();
    mkdirSync(path.join(b.dir, 'config.json'));
    assert.equal((await importLegacyConfig(b.deps)).status, 'failed');
    assert.equal(b.messages.warn.length, 1);
  });

  it('keeps the file when writing the settings fails, and imports it on a later start', async () => {
    const h = harness({ updateFails: true });
    h.write({ monthlyBudget: 5 });
    const failed = await importLegacyConfig(h.deps);
    assert.equal(failed.status, 'failed');
    assert.ok(existsSync(path.join(h.dir, 'config.json')));
    assert.equal(h.messages.warn.length, 1);

    h.recover();
    const retried = await importLegacyConfig(h.deps);
    assert.equal(retried.status, 'imported');
    assert.equal(h.patches[0]!.monthlyBudget, 5);
    assert.equal(h.messages.warn.length, 1, 'the earlier warning is not repeated');
  });

  it('never replaces an earlier backup', async () => {
    const h = harness();
    h.write('first backup', 'config.json.migrated');
    h.write({ monthlyBudget: 1 });
    const r = await importLegacyConfig(h.deps);
    assert.equal(r.backup, path.join(h.dir, 'config.json.migrated-2'));
    assert.equal(readFileSync(path.join(h.dir, 'config.json.migrated'), 'utf8'), 'first backup');
    h.write({ monthlyBudget: 2 });
    assert.equal((await importLegacyConfig(h.deps)).backup, path.join(h.dir, 'config.json.migrated-3'));
  });
});

describe('importLegacyConfig — default UI', () => {
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  const win = vscode.window as Mutable<typeof vscode.window>;
  const cmds = vscode.commands as Mutable<typeof vscode.commands>;
  const original = { info: win.showInformationMessage, warn: win.showWarningMessage, exec: cmds.executeCommand };
  afterEach(() => {
    win.showInformationMessage = original.info;
    win.showWarningMessage = original.warn;
    cmds.executeCommand = original.exec;
  });

  it('shows the summary with an Open Settings action that opens the extension\'s settings', async () => {
    const shown: unknown[][] = [];
    const executed: unknown[][] = [];
    win.showInformationMessage = ((...a: unknown[]) => (shown.push(a), Promise.resolve('Open Settings'))) as unknown as typeof win.showInformationMessage;
    cmds.executeCommand = ((...a: unknown[]) => (executed.push(a), Promise.resolve(undefined))) as unknown as typeof cmds.executeCommand;
    vscodeImportUi.info('moved');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(shown, [['moved', 'Open Settings']]);
    assert.deepEqual(executed, [['workbench.action.openSettings', '@ext:RelativelyUnknown.mallard']]);
  });

  it('does nothing more when the message is dismissed, and warns through the window', async () => {
    const executed: unknown[][] = [];
    win.showInformationMessage = (() => Promise.resolve(undefined)) as unknown as typeof win.showInformationMessage;
    cmds.executeCommand = ((...a: unknown[]) => (executed.push(a), Promise.resolve(undefined))) as unknown as typeof cmds.executeCommand;
    vscodeImportUi.info('moved');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(executed, []);
    const warned: unknown[] = [];
    win.showWarningMessage = ((m: unknown) => (warned.push(m), Promise.resolve(undefined))) as unknown as typeof win.showWarningMessage;
    vscodeImportUi.warn('careful');
    assert.deepEqual(warned, ['careful']);
  });

  it('is used when no ui is injected (and the default logger when none is given)', async () => {
    const h = harness();
    const shown: unknown[][] = [];
    win.showInformationMessage = ((...a: unknown[]) => (shown.push(a), Promise.resolve(undefined))) as unknown as typeof win.showInformationMessage;
    h.write({ monthlyBudget: 5 });
    const { ui: _ui, logger: _logger, ...bare } = h.deps;
    await importLegacyConfig(bare);
    assert.equal(shown.length, 1);
  });
});

describe('deleteLegacyConfigFiles', () => {
  it('removes config.json and every backup, and nothing else', () => {
    const h = harness();
    for (const name of ['config.json', 'config.json.migrated', 'config.json.migrated-2', 'export-queue.json', 'events.sqlite']) h.write('x', name);
    assert.deepEqual(deleteLegacyConfigFiles(h.dir).sort(), ['config.json', 'config.json.migrated', 'config.json.migrated-2']);
    assert.ok(existsSync(path.join(h.dir, 'events.sqlite')));
    assert.ok(existsSync(path.join(h.dir, 'export-queue.json')));
  });

  it('skips what it cannot delete and tolerates a missing directory', () => {
    const h = harness();
    mkdirSync(path.join(h.dir, 'config.json.migrated'));
    assert.deepEqual(deleteLegacyConfigFiles(h.dir), [], 'a directory cannot be unlinked: best effort');
    assert.deepEqual(deleteLegacyConfigFiles(path.join(h.dir, 'missing')), []);
  });
});

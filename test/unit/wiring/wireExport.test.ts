import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { DEFAULT_USER_CONFIG } from '../../../src/extension-backend/domain/types';
import type { UsageEvent, UserConfig } from '../../../src/extension-backend/domain/types';
import { readConfig } from '../../../src/extension-backend/config';
import type { MallardConfig } from '../../../src/extension-backend/config';
import { AuthProvider } from '../../../src/extension-backend/export/AuthProvider';
import type { Exporter } from '../../../src/extension-backend/export/MetricExporter';
import type { StreamBatch } from '../../../src/extension-backend/export/payload';
import { STREAM_BATCH_MAX_EVENTS } from '../../../src/extension-backend/export/payload';
import { SECRET_KEYS } from '../../../src/extension-backend/app/credentials';
import { streamInsertedEvents, wireExport } from '../../../src/extension-backend/wiring/wireExport';
import { makeEvent } from '../helpers';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const ws = vscode.workspace as Mutable<typeof vscode.workspace>;
type ConfigChangeCb = (e: { affectsConfiguration(key: string): boolean }) => void;
type SecretCb = (e: { key: string }) => void;

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));

describe('wireExport', () => {
  const orig = {
    onDidChangeConfiguration: ws.onDidChangeConfiguration,
    createExporter: AuthProvider.prototype.createExporter,
  };
  afterEach(() => {
    ws.onDidChangeConfiguration = orig.onDidChangeConfiguration;
    AuthProvider.prototype.createExporter = orig.createExporter;
  });

  /** A context, a fake user-config store and a createExporter stub that records what each build was given. */
  function setup(initialExport: UserConfig['export'] = {}) {
    const settingsCbs: ConfigChangeCb[] = [];
    ws.onDidChangeConfiguration = ((cb: ConfigChangeCb) => {
      settingsCbs.push(cb);
      return { dispose() {} };
    }) as unknown as typeof ws.onDidChangeConfiguration;

    const secretCbs: SecretCb[] = [];
    const context = {
      subscriptions: [] as Array<{ dispose(): void }>,
      secrets: {
        onDidChange: (cb: SecretCb) => {
          secretCbs.push(cb);
          return { dispose() {} };
        },
      },
    } as unknown as vscode.ExtensionContext;

    const userConfigCbs: Array<(c: UserConfig) => void> = [];
    let userConfig: UserConfig = { ...DEFAULT_USER_CONFIG, ...(initialExport ? { export: initialExport } : {}) };
    const userConfigStore = {
      get: () => userConfig,
      onDidChange: (cb: (c: UserConfig) => void) => {
        userConfigCbs.push(cb);
        return { dispose() {} };
      },
    };

    const builds: Array<{ cfg: MallardConfig; exportCfg: unknown; exporter: TestExporter }> = [];
    AuthProvider.prototype.createExporter = async function (this: unknown) {
      const self = this as { cfg: MallardConfig; exportCfg: unknown };
      const exporter = new TestExporter(`#${builds.length + 1}`);
      builds.push({ cfg: self.cfg, exportCfg: self.exportCfg, exporter });
      return exporter;
    };

    const started: Array<() => void> = [];
    const store: { writer: { onInserted?: (events: UsageEvent[]) => void } } = { writer: {} };
    const activationCfg = { ...readConfig(), server: { url: 'https://activation.example' } };
    const freshCfg = { ...readConfig(), server: { url: 'https://fresh.example' } };

    return {
      context,
      started,
      store,
      builds,
      settingsCbs,
      secretCbs,
      userConfigCbs,
      activationCfg,
      setUserConfig: (next: UserConfig) => {
        userConfig = next;
        for (const cb of userConfigCbs) cb(next);
      },
      wire: () =>
        wireExport(
          { context, storageDir: '/unused', started },
          { cfg: activationCfg, readConfig: () => freshCfg, userConfig: userConfigStore, store },
        ),
    };
  }

  class TestExporter implements Exporter {
    readonly batches: StreamBatch[] = [];
    disposed = false;
    constructor(readonly name: string) {}
    async export(batch: StreamBatch) {
      this.batches.push(batch);
    }
    dispose() {
      this.disposed = true;
    }
  }

  it('builds the first exporter from the activation settings and the config.json export block', async () => {
    const t = setup({ webhookTargets: [{ name: 'team', url: 'https://t.example' }] });
    const { exporter } = await t.wire();

    assert.equal(t.builds.length, 1);
    assert.equal(t.builds[0]!.cfg, t.activationCfg);
    assert.deepEqual(t.builds[0]!.exportCfg, { webhookTargets: [{ name: 'team', url: 'https://t.example' }] });
    assert.equal(exporter.current, t.builds[0]!.exporter);
  });

  it('rebuilds from the CURRENT settings when an export setting changes, and ignores unrelated ones', async () => {
    const t = setup();
    const { exporter } = await t.wire();

    for (const cb of t.settingsCbs) cb({ affectsConfiguration: (k) => k === 'mallard.palette' });
    await tick();
    assert.equal(t.builds.length, 1, 'an unrelated setting does nothing');

    for (const cb of t.settingsCbs) cb({ affectsConfiguration: (k) => k === 'mallard.export.transport' });
    await tick();
    assert.equal(t.builds.length, 2);
    assert.equal(t.builds[1]!.cfg.server.url, 'https://fresh.example', 'rebuilds read the settings as they are now');
    assert.equal(exporter.current, t.builds[1]!.exporter);
    assert.equal(t.builds[0]!.exporter.disposed, true);
  });

  it('rebuilds when an export secret changes, but not for other secrets', async () => {
    const t = setup();
    await t.wire();

    t.secretCbs[0]!({ key: SECRET_KEYS.webhookApiKey });
    await tick();
    assert.equal(t.builds.length, 2);

    t.secretCbs[0]!({ key: SECRET_KEYS.githubPat });
    await tick();
    assert.equal(t.builds.length, 2);
  });

  it('rebuilds when the config.json export block changes, and only then', async () => {
    const t = setup({ webhookTargets: [{ name: 'a', url: 'https://a.example' }] });
    await t.wire();

    t.setUserConfig({ ...DEFAULT_USER_CONFIG, monthlyBudget: 99, export: { webhookTargets: [{ name: 'a', url: 'https://a.example' }] } });
    await tick();
    assert.equal(t.builds.length, 1, 'same export block: no rebuild');

    t.setUserConfig({ ...DEFAULT_USER_CONFIG, export: { webhookTargets: [{ name: 'b', url: 'https://b.example' }] } });
    await tick();
    assert.equal(t.builds.length, 2);
    assert.deepEqual(t.builds[1]!.exportCfg, { webhookTargets: [{ name: 'b', url: 'https://b.example' }] });

    t.setUserConfig({ ...DEFAULT_USER_CONFIG, export: { webhookTargets: [{ name: 'b', url: 'https://b.example' }] } });
    await tick();
    assert.equal(t.builds.length, 2, 'the change is remembered, so repeating it is a no-op');

    t.setUserConfig({ ...DEFAULT_USER_CONFIG }); // block removed entirely
    await tick();
    assert.equal(t.builds.length, 3);
  });

  it('registers its subscriptions and a cleanup that closes the exporter', async () => {
    const t = setup();
    const { exporter } = await t.wire();
    assert.equal(t.context.subscriptions.length, 3, 'settings, secrets and config.json watchers');
    assert.equal(t.started.length, 1);

    t.started[0]!();
    assert.equal(t.builds[0]!.exporter.disposed, true);
    // After close a rebuild in flight is not installed (see ExporterRebuilder).
    exporter.scheduleRebuild();
    await tick();
    assert.equal(t.builds[1]!.exporter.disposed, true);
    assert.equal(exporter.current, t.builds[0]!.exporter);
  });

  it('installs the ingest callback that streams fresh events to whichever exporter is current', async () => {
    const t = setup();
    const { exporter } = await t.wire();
    assert.equal(typeof t.store.writer.onInserted, 'function');

    t.store.writer.onInserted!([makeEvent({ ts: 1_000 })]);
    await tick();
    assert.equal(t.builds[0]!.exporter.batches.length, 1);

    exporter.scheduleRebuild();
    await tick();
    t.store.writer.onInserted!([makeEvent({ ts: 2_000 })]);
    await tick();
    assert.equal(t.builds[0]!.exporter.batches.length, 1, 'the replaced exporter gets nothing more');
    assert.equal(t.builds[1]!.exporter.batches.length, 1, 'the replacement gets the next batch');
  });
});

describe('streamInsertedEvents', () => {
  function silentLogger() {
    const errors: Array<{ msg: string; err: unknown }> = [];
    return {
      errors,
      logger: {
        debug() {},
        info() {},
        warn() {},
        error: (_tag: string, msg: string, err?: unknown) => void errors.push({ msg, err }),
      },
    };
  }

  it('sends oldest-first chunks of at most one wire batch each', async () => {
    const sent: StreamBatch[] = [];
    const exporter: Exporter = { export: async (b) => void sent.push(b), dispose() {} };
    const events = Array.from({ length: STREAM_BATCH_MAX_EVENTS + 5 }, (_, i) =>
      makeEvent({ id: `ev-${i}`, ts: 10_000 - i }),
    );

    streamInsertedEvents(() => exporter)(events);
    await tick();

    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.events.length, STREAM_BATCH_MAX_EVENTS);
    assert.equal(sent[1]!.events.length, 5);
    const ts = sent.flatMap((b) => b.events.map((e) => e.ts));
    assert.deepEqual([...ts].sort((a, b) => a - b), ts, 'oldest first across the chunks');
  });

  it('reads the exporter again for every chunk', async () => {
    const order: string[] = [];
    const a: Exporter = { export: async () => void order.push('a'), dispose() {} };
    const b: Exporter = { export: async () => void order.push('b'), dispose() {} };
    let calls = 0;
    const events = Array.from({ length: STREAM_BATCH_MAX_EVENTS + 1 }, (_, i) => makeEvent({ ts: i }));

    streamInsertedEvents(() => (calls++ === 0 ? a : b))(events);
    await tick();

    assert.deepEqual(order, ['a', 'b']);
  });

  it('logs an export failure instead of throwing into ingest', async () => {
    const { logger, errors } = silentLogger();
    const failing: Exporter = {
      export: async () => {
        throw new Error('network down');
      },
      dispose() {},
    };

    assert.doesNotThrow(() => streamInsertedEvents(() => failing, logger)([makeEvent({ ts: 1 })]));
    await tick();

    assert.equal(errors.length, 1);
    assert.equal(errors[0]!.msg, 'event stream export failed');
    assert.match(String((errors[0]!.err as Error).message), /network down/);
  });
});

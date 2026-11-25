import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LAYOUT_STATE_KEY, LayoutStore } from '../../../src/extension-backend/app/LayoutStore';
import { wipeAllData } from '../../../src/extension-backend/app/uninstall';
import { DASHBOARD_PANELS } from '../../../src/extension-backend/domain/types';
import type { ConfigDashboard, ConfigPanelLayout, DashboardLayout } from '../../../src/extension-backend/domain/types';
import { makeFakeConfig, makeMemento } from '../helpers';

const LEGACY_PANELS: ConfigPanelLayout[] = [
  { id: 'models', gridColumn: 'span 3', hidden: true },
  { id: 'daily', size: 'tall' },
];

/** A config whose (legacy, no longer settable) `dashboard` block is `dashboard` — what LayoutStore's fallback reads. */
function configWith(dashboard?: ConfigDashboard) {
  return makeFakeConfig(dashboard === undefined ? {} : { dashboard });
}

const byId = (layout: DashboardLayout, id: string) => layout.find((p) => p.id === id);

describe('LayoutStore — globalState persistence and its legacy dashboard-block fallback (the config.json import now seeds the key itself)', () => {
  const opened: Array<{ dispose(): void }> = [];
  afterEach(() => {
    for (const d of opened.splice(0)) d.dispose();
  });
  function open(userConfig = configWith(), state = makeMemento(), logger = silentLogger()) {
    const layout = new LayoutStore(userConfig, state, logger);
    opened.push(layout, userConfig);
    return { userConfig, layout, state };
  }
  function silentLogger() {
    const warnings: string[] = [];
    return {
      warnings,
      debug() {},
      info() {},
      warn: (_tag: string, msg: string) => void warnings.push(msg),
      error() {},
    };
  }

  describe('seeding', () => {
    it('imports config.json dashboard.panels once and stores it under mallard.layout.v1', async () => {
      const { layout, state } = open(configWith({ panels: LEGACY_PANELS }));

      const seeded = layout.get();
      assert.equal(byId(seeded, 'models')?.span, 3);
      assert.equal(byId(seeded, 'models')?.hidden, true);
      assert.equal(byId(seeded, 'daily')?.size, 'tall');
      assert.deepEqual(seeded.slice(0, 2).map((p) => p.id), ['models', 'daily'], 'legacy order wins, the rest follow');
      assert.equal(LAYOUT_STATE_KEY, 'mallard.layout.v1');
      assert.deepEqual(state.get(LAYOUT_STATE_KEY), seeded, 'the seed is persisted');
      assert.equal(state.updates.length, 1, 'written exactly once');
    });

    it('seeds the default layout when config.json has no dashboard block', async () => {
      const { layout, state } = open();
      assert.deepEqual(layout.get().map((p) => p.id), [...DASHBOARD_PANELS]);
      assert.equal(state.updates.length, 1);
      assert.ok(state.get(LAYOUT_STATE_KEY));
    });

    it('never re-reads config.json panels once seeded, in this session or after a reload', async () => {
      const first = open(configWith({ panels: LEGACY_PANELS }));
      first.layout.get();

      await first.userConfig.set({ dashboard: { panels: [{ id: 'sankey', gridColumn: 'span 4' }] } });
      assert.equal(byId(first.layout.get(), 'sankey')?.span, 1, 'a later config.json edit is ignored');
      assert.equal(first.state.updates.length, 1);

      const reloaded = open(configWith({ panels: LEGACY_PANELS }), first.state); // same globalState, as after a window reload
      assert.deepEqual(reloaded.layout.get(), first.layout.get());
      assert.equal(first.state.updates.length, 1, 'the reload did not seed again');
    });

    it('does not touch an existing layout key', async () => {
      const stored: DashboardLayout = [{ id: 'weekday', span: 4, hidden: false, size: 'compact' }];
      const state = makeMemento({ [LAYOUT_STATE_KEY]: stored });
      const { layout } = open(configWith({ panels: LEGACY_PANELS }), state);

      const got = layout.get();
      assert.equal(got[0]?.id, 'weekday');
      assert.equal(got[0]?.size, 'compact');
      assert.equal(got.length, DASHBOARD_PANELS.length, 'missing panels are appended to the stored layout');
      assert.equal(state.updates.length, 0, 'nothing was written');
    });

    it('keeps serving the import from memory when persisting it fails, and logs once', async () => {
      const state = makeMemento();
      state.update = () => Promise.reject(new Error('disk full'));
      const logger = silentLogger();
      const { layout } = open(configWith({ panels: LEGACY_PANELS }), state, logger);
      await new Promise((r) => setImmediate(r));

      assert.equal(byId(layout.get(), 'models')?.span, 3, 'the imported layout is still in force');
      assert.equal(byId(layout.get(), 'models')?.hidden, true);
      assert.deepEqual(logger.warnings, ['could not persist the imported dashboard layout']);
    });
  });

  describe('set()', () => {
    it('stores the normalized layout, leaves config.json dashboard.panels alone, and emits', async () => {
      const { layout, state, userConfig } = open(configWith({ panels: LEGACY_PANELS }));
      const fired: DashboardLayout[] = [];
      layout.onDidChange((l) => fired.push(l));

      const next = layout.get().map((p) => (p.id === 'heatmap' ? { ...p, span: 1, hidden: true } : p));
      await layout.set(next);

      assert.deepEqual(state.get(LAYOUT_STATE_KEY), next);
      assert.equal(fired.length, 1);
      assert.equal(byId(fired[0]!, 'heatmap')?.hidden, true);
      assert.deepEqual(userConfig.get().dashboard?.panels, LEGACY_PANELS, 'the legacy block is never written');
    });

    it('does not emit when the layout is unchanged', async () => {
      const { layout } = open();
      const fired: DashboardLayout[] = [];
      layout.onDidChange((l) => fired.push(l));
      await layout.set(layout.get());
      assert.equal(fired.length, 0);
    });

    it('drops invalid entries and keeps unknown ids, like any stored layout', async () => {
      const { layout, state } = open();
      await layout.set([
        { id: 'daily', span: 99, hidden: false },
        { id: 'daily', span: 1, hidden: true }, // duplicate
        { id: 'from-the-future', span: 2, hidden: false, size: 'tall' },
      ]);
      const stored = state.get<DashboardLayout>(LAYOUT_STATE_KEY)!;
      assert.equal(byId(stored, 'daily')?.span, 4, 'span clamped to the maximum');
      assert.equal(stored.filter((p) => p.id === 'daily').length, 1);
      assert.ok(byId(stored, 'from-the-future'), 'unknown ids survive a save');
    });
  });

  describe('dashboard.columns (still read from config.json)', () => {
    it('clamps a stored layout to the configured columns and re-emits when they change', async () => {
      const { layout, userConfig } = open();
      await layout.set(layout.get().map((p) => (p.id === 'daily' ? { ...p, span: 4 } : p)));
      const fired: DashboardLayout[] = [];
      layout.onDidChange((l) => fired.push(l));

      await userConfig.set({ dashboard: { columns: 2 } });

      assert.equal(fired.length, 1);
      assert.equal(byId(fired[0]!, 'daily')?.span, 2);
      assert.equal(byId(layout.get(), 'daily')?.span, 2);
    });
  });

  describe('reset()', () => {
    it('clears the stored key and returns to the defaults without re-importing config.json', async () => {
      const { layout, state } = open(configWith({ panels: LEGACY_PANELS }));
      layout.get();
      await layout.set([...layout.get()].reverse());
      const fired: DashboardLayout[] = [];
      layout.onDidChange((l) => fired.push(l));

      await layout.reset();

      assert.equal(state.data.has(LAYOUT_STATE_KEY), false, 'the globalState key is gone');
      assert.deepEqual(state.updates.at(-1), { key: LAYOUT_STATE_KEY, value: undefined });
      assert.deepEqual(layout.get().map((p) => p.id), [...DASHBOARD_PANELS]);
      assert.equal(byId(layout.get(), 'models')?.span, 1, 'the legacy models span-3 entry was not resurrected');
      assert.equal(fired.length, 1);
      assert.equal(state.data.has(LAYOUT_STATE_KEY), false, 'reading after a reset does not write the key back');
    });

    it('is a quiet no-op when the layout is already the default', async () => {
      const { layout } = open();
      const fired: DashboardLayout[] = [];
      layout.onDidChange((l) => fired.push(l));
      await layout.reset();
      assert.equal(fired.length, 0);
    });

    it('"Prepare for Uninstall" leaves no layout key behind', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mallard-layout-store-'));
      const userConfig = configWith({ panels: LEGACY_PANELS });
      const { layout, state } = open(userConfig);
      await layout.set([...layout.get()].reverse());
      assert.ok(state.data.has(LAYOUT_STATE_KEY));

      await wipeAllData({
        storageDir: dir,
        secrets: { delete: async () => {} },
        globalState: state,
        store: { clear: async () => {} },
        userConfig,
        layout,
        pricing: { clearCache: async () => {} },
        restriction: { clearAll: async () => {} },
      });

      assert.deepEqual(state.keys(), [], 'every globalState key, the layout included, is cleared');
    });
  });
});

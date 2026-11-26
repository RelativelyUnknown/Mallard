import { strict as assert } from 'assert';
import { LAYOUT_V1_KEY, LAYOUT_V2_KEY, LayoutStore } from '../../../src/extension-backend/app/LayoutStore';
import { wipeAllData } from '../../../src/extension-backend/app/uninstall';
import { defaultLayout, migrateV1, PANEL_IDS } from '../../../src/extension-backend/domain/layout';
import type { LayoutV2 } from '../../../src/extension-backend/domain/contracts';
import { makeMemento } from '../helpers';

const V1: unknown[] = [
  { id: 'models', span: 3, hidden: true },
  { id: 'daily', span: 4, size: 'tall' },
];

const byId = (layout: LayoutV2, id: string) => layout.panels.find((p) => p.id === id);

function silentLogger() {
  const warnings: string[] = [];
  return { warnings, debug() {}, info() {}, warn: (_tag: string, msg: string) => void warnings.push(msg), error() {} };
}

describe('LayoutStore: globalState persistence of the v2 layout and the one-time v1 migration', () => {
  const opened: Array<{ dispose(): void }> = [];
  afterEach(() => {
    for (const d of opened.splice(0)) d.dispose();
  });
  function open(initial: Record<string, unknown> = {}, state = makeMemento(initial), logger = silentLogger()) {
    const layout = new LayoutStore(state, logger);
    opened.push(layout);
    return { layout, state, logger };
  }

  it('uses its own keys: v1 is the legacy one, v2 the current one', () => {
    assert.equal(LAYOUT_V1_KEY, 'mallard.layout.v1');
    assert.equal(LAYOUT_V2_KEY, 'mallard.layout.v2');
  });

  describe('get()', () => {
    it('returns the default layout and writes nothing when nothing is stored', () => {
      const { layout, state } = open();
      assert.deepEqual(layout.get(), defaultLayout());
      assert.deepEqual(state.updates, []);
    });

    it('returns the stored v2 layout (sanitised, completed with any missing panel) and never touches v1', () => {
      const stored = { version: 2, panels: [{ id: 'weekday', x: 0, y: 0, w: 9, h: 21, hidden: false }] };
      const { layout, state } = open({ [LAYOUT_V2_KEY]: stored, [LAYOUT_V1_KEY]: V1 });
      const got = layout.get();
      assert.deepEqual(byId(got, 'weekday'), { id: 'weekday', x: 0, y: 0, w: 4, h: 21, hidden: false }, 'clamped onto the grid');
      assert.equal(got.panels.length, PANEL_IDS.length, 'missing panels are appended');
      assert.deepEqual(state.updates, [], 'nothing was written');
      assert.deepEqual(state.get(LAYOUT_V1_KEY), V1);
    });

    it('treats an unreadable v2 value (a future version, garbage) as absent', () => {
      const { layout } = open({ [LAYOUT_V2_KEY]: { version: 3, panels: [] }, [LAYOUT_V1_KEY]: V1 });
      assert.deepEqual(layout.get(), migrateV1(V1));
      assert.deepEqual(open({ [LAYOUT_V2_KEY]: 'junk' }).layout.get(), defaultLayout());
    });
  });

  describe('migration from v1', () => {
    it('migrates once, stores the result under the v2 key and leaves the v1 key untouched', () => {
      const { layout, state } = open({ [LAYOUT_V1_KEY]: V1 });
      const got = layout.get();

      assert.deepEqual(got, migrateV1(V1));
      assert.equal(byId(got, 'models')?.w, 3);
      assert.equal(byId(got, 'models')?.hidden, true);
      assert.deepEqual([byId(got, 'daily')?.w, byId(got, 'daily')?.h], [4, 21]);
      assert.deepEqual(state.get(LAYOUT_V2_KEY), got, 'the migration is persisted');
      assert.deepEqual(state.get(LAYOUT_V1_KEY), V1, 'v1 stays for a downgrade');
      assert.equal(state.updates.length, 1, 'written exactly once, even though the constructor and get() both read it');
      assert.deepEqual(state.updates[0]!.key, LAYOUT_V2_KEY);
    });

    it('does not migrate again after a reload (v2 now exists), even if v1 changes', () => {
      const first = open({ [LAYOUT_V1_KEY]: V1 });
      first.layout.get();
      first.state.data.set(LAYOUT_V1_KEY, [{ id: 'sankey', span: 4 }]); // an older version rewrote its own key
      const reloaded = open({}, first.state);
      assert.deepEqual(reloaded.layout.get(), migrateV1(V1));
      assert.equal(first.state.updates.length, 1);
    });

    it('keeps serving the migrated layout from memory when persisting it fails, and logs once', async () => {
      const state = makeMemento({ [LAYOUT_V1_KEY]: V1 });
      state.update = () => Promise.reject(new Error('disk full'));
      const { layout, logger } = open({}, state);
      await new Promise((r) => setImmediate(r));

      assert.equal(byId(layout.get(), 'models')?.w, 3, 'the migrated layout is still in force');
      assert.equal(byId(layout.get(), 'models')?.hidden, true);
      assert.deepEqual(logger.warnings, ['could not persist the migrated dashboard layout']);
    });
  });

  describe('set()', () => {
    it('stores the sanitised layout under v2, leaves v1 alone and emits the change', async () => {
      const { layout, state } = open({ [LAYOUT_V1_KEY]: V1 });
      const fired: LayoutV2[] = [];
      layout.onDidChange((l) => fired.push(l));

      const next = layout.get();
      next.panels = next.panels.map((p) => (p.id === 'heatmap' ? { ...p, w: 1, hidden: true } : p));
      await layout.set(next);

      assert.deepEqual(state.get(LAYOUT_V2_KEY), next);
      assert.equal(fired.length, 1);
      assert.equal(byId(fired[0]!, 'heatmap')?.hidden, true);
      assert.deepEqual(state.get(LAYOUT_V1_KEY), V1);
    });

    it('does not emit when the layout is unchanged', async () => {
      const { layout } = open();
      const fired: LayoutV2[] = [];
      layout.onDidChange((l) => fired.push(l));
      await layout.set(layout.get());
      assert.equal(fired.length, 0);
    });

    it('clamps rects, drops duplicates, keeps unknown ids; anything unreadable becomes the default', async () => {
      const { layout, state } = open();
      await layout.set({
        version: 2,
        panels: [
          { id: 'daily', x: 3, y: 0, w: 99, h: 1, hidden: false },
          { id: 'daily', x: 0, y: 0, w: 1, h: 7, hidden: true },
          { id: 'from-the-future', x: 0, y: 30, w: 2, h: 21, hidden: false },
        ],
      });
      const stored = state.get<LayoutV2>(LAYOUT_V2_KEY)!;
      assert.deepEqual(byId(stored, 'daily'), { id: 'daily', x: 0, y: 0, w: 4, h: 7, hidden: false });
      assert.equal(stored.panels.filter((p) => p.id === 'daily').length, 1);
      assert.ok(byId(stored, 'from-the-future'), 'unknown ids survive a save');

      await layout.set('junk' as unknown as LayoutV2);
      assert.deepEqual(state.get(LAYOUT_V2_KEY), defaultLayout());
    });

    it('a set() after a failed migration write replaces the in-memory copy', async () => {
      const state = makeMemento({ [LAYOUT_V1_KEY]: V1 });
      const realUpdate = state.update;
      state.update = () => Promise.reject(new Error('disk full'));
      const { layout } = open({}, state);
      await new Promise((r) => setImmediate(r));
      state.update = realUpdate;
      await layout.set(defaultLayout());
      assert.deepEqual(layout.get(), defaultLayout(), 'the saved layout wins over the stale migration');
    });
  });

  describe('reset()', () => {
    it('clears both keys and returns to the default, without resurrecting v1 on a later load', async () => {
      const { layout, state } = open({ [LAYOUT_V1_KEY]: V1 });
      layout.get();
      const fired: LayoutV2[] = [];
      layout.onDidChange((l) => fired.push(l));

      await layout.reset();

      assert.equal(state.data.has(LAYOUT_V2_KEY), false);
      assert.equal(state.data.has(LAYOUT_V1_KEY), false);
      assert.deepEqual(layout.get(), defaultLayout());
      assert.equal(fired.length, 1);
      assert.deepEqual(open({}, state).layout.get(), defaultLayout(), 'a reload after the reset is the default too');
    });

    it('is a quiet no-op when the layout is already the default', async () => {
      const { layout } = open();
      const fired: LayoutV2[] = [];
      layout.onDidChange((l) => fired.push(l));
      await layout.reset();
      assert.equal(fired.length, 0);
    });

    it('"Prepare for Uninstall" leaves no layout key behind', async () => {
      const { layout, state } = open({ [LAYOUT_V1_KEY]: V1 });
      await layout.set({ ...layout.get(), panels: [...layout.get().panels].reverse() });
      assert.ok(state.data.has(LAYOUT_V2_KEY));

      await wipeAllData({
        storageDir: '/nonexistent-storage-dir',
        secrets: { delete: async () => {} },
        globalState: state,
        store: { clear: async () => {} },
        userConfig: { get: () => ({}) as never, reset: async () => {} },
        layout,
        pricing: { clearCache: async () => {} },
        restriction: { clearAll: async () => {} },
      });

      assert.deepEqual(state.keys(), [], 'every globalState key, the layout included, is cleared');
    });
  });
});

import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { defaultLayout } from '../../../src/extension-backend/domain/layout';
import { bindDashboard, DashboardDeps } from '../../../src/extension-backend/ui/dashboardBridge';
import type { WebviewBoundMsg } from '../../../src/extension-backend/ui/messaging';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const cmd = vscode.commands as Mutable<typeof vscode.commands>;

type Listener<T> = (value: T) => void;

function emitter<T>() {
  const listeners: Listener<T>[] = [];
  return {
    event: (l: Listener<T>) => {
      listeners.push(l);
      return { dispose() {} };
    },
    fire: (v: T) => listeners.forEach((l) => l(v)),
  };
}

function makeHarness() {
  const posted: WebviewBoundMsg[] = [];
  let receive: ((m: unknown) => void) | undefined;
  const webview = {
    postMessage: (m: WebviewBoundMsg) => {
      posted.push(m);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (handler: (m: unknown) => void) => {
      receive = handler;
      return { dispose() {} };
    },
  } as unknown as vscode.Webview;

  const snapshotEmitter = emitter<unknown>();
  const configEmitter = emitter<void>();
  let config: unknown = { monthlyBudget: 0 };
  const calls: Record<string, unknown[][]> = {
    refresh: [], setFilter: [], signIn: [], update: [], setLayout: [], snooze: [],
  };

  const deps = {
    usage: {
      current: { generatedAt: 1, budget: {} },
      refresh: async (...a: unknown[]) => void calls.refresh!.push(a),
      setFilter: async (...a: unknown[]) => void calls.setFilter!.push(a),
      signInGitHub: async (...a: unknown[]) => void calls.signIn!.push(a),
      onDidChangeSnapshot: snapshotEmitter.event,
    },
    userConfig: {
      get: () => config,
      update: async (...a: unknown[]) => void calls.update!.push(a),
      onDidChange: configEmitter.event,
    },
    layout: {
      get: () => defaultLayout(),
      set: async (...a: unknown[]) => void calls.setLayout!.push(a),
      onDidChange: emitter<unknown>().event,
    },
    restriction: {
      getState: () => ({ active: false }),
      snooze: async (...a: unknown[]) => void calls.snooze!.push(a),
      onDidChange: emitter<unknown>().event,
    },
  } as unknown as DashboardDeps;

  const disposables = bindDashboard(webview, deps);
  return {
    posted,
    send: (m: unknown) => receive!(m),
    calls,
    snapshotEmitter,
    disposables,
    /** The configuration changed (any mallard.* setting): new values, then the one event. */
    changeConfig: (next: unknown) => {
      config = next;
      configEmitter.fire(undefined as never);
    },
  };
}

describe('dashboardBridge — message routing', () => {
  it('answers "ready" with snapshot, config, layout, restriction, and theme', async () => {
    const h = makeHarness();
    h.send({ type: 'ready' });
    await Promise.resolve();
    assert.deepEqual(
      h.posted.map((m) => m.type),
      ['snapshot', 'config', 'layout', 'restriction', 'theme'],
    );
    const theme = h.posted.at(-1) as Extract<WebviewBoundMsg, { type: 'theme' }>;
    assert.equal(theme.kind, 'dark'); // mock activeColorTheme.kind = Dark
    assert.equal(theme.palette, 'swiss');
  });

  it('skips the snapshot on "ready" when none is computed yet', async () => {
    // Rebuild with no current snapshot
    const posted: WebviewBoundMsg[] = [];
    let receive: ((m: unknown) => void) | undefined;
    const webview = {
      postMessage: (m: WebviewBoundMsg) => (posted.push(m), Promise.resolve(true)),
      onDidReceiveMessage: (handler: (m: unknown) => void) => ((receive = handler), { dispose() {} }),
    } as unknown as vscode.Webview;
    const deps = {
      usage: { current: undefined, onDidChangeSnapshot: emitter<unknown>().event },
      userConfig: { get: () => ({}), onDidChange: emitter<unknown>().event },
      layout: { get: () => defaultLayout(), onDidChange: emitter<unknown>().event },
      restriction: { getState: () => ({ active: false }), onDidChange: emitter<unknown>().event },
    } as unknown as DashboardDeps;
    bindDashboard(webview, deps);
    receive!({ type: 'ready' });
    await Promise.resolve();
    assert.deepEqual(posted.map((m) => m.type), ['config', 'layout', 'restriction', 'theme']);
  });

  it('routes refresh, setFilter, setLayout, and restrictSnooze', async () => {
    const h = makeHarness();
    h.send({ type: 'refresh' });
    h.send({ type: 'setFilter', value: { models: ['gpt-4o'] } });
    h.send({ type: 'setLayout', value: defaultLayout() });
    h.send({ type: 'setLayout', value: [] }); // the v1 shape is rejected, never reaches the store
    h.send({ type: 'restrictSnooze', minutes: 15 });
    await new Promise((r) => setImmediate(r));

    assert.equal(h.calls.refresh!.length, 1);
    assert.deepEqual(h.calls.setFilter![0], [{ models: ['gpt-4o'] }]);
    assert.equal(h.calls.setLayout!.length, 1);
    assert.deepEqual(h.calls.snooze![0], [15]);
  });

  it('routes command messages to the right host actions', async () => {
    const executed: string[] = [];
    const originalExec = cmd.executeCommand;
    cmd.executeCommand = ((id: string) => {
      executed.push(id);
      return Promise.resolve(undefined);
    }) as typeof cmd.executeCommand;
    try {
      const h = makeHarness();
      h.send({ type: 'command', id: 'openDashboard' });
      h.send({ type: 'command', id: 'disableExtension' });
      h.send({ type: 'command', id: 'signIn' });
      h.send({ type: 'command', id: 'enableCopilotTelemetry' });
      h.send({ type: 'command', id: 'setGitHubPat' });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(executed, ['mallard.openDashboard', 'mallard.disableExtension', 'mallard.enableCopilotTelemetry', 'mallard.setGitHubPat']);
      assert.equal(h.calls.signIn!.length, 1);
    } finally {
      cmd.executeCommand = originalExec;
    }
  });

  it('writes setCurrency to the mallard.currency setting through the config service', async () => {
    const h = makeHarness();
    h.send({ type: 'setCurrency', value: 'eur' });
    await new Promise((r) => setImmediate(r));
    // update() validates and upper-cases it (see ConfigService); the settings
    // change event then recomputes the snapshot.
    assert.deepEqual(h.calls.update!.at(-1), [{ currency: 'eur' }]);
  });

  it('no longer accepts a setConfig patch from the webview: the dashboard writes nothing but the currency', async () => {
    const h = makeHarness();
    h.send({ type: 'setConfig', value: { monthlyBudget: 5 } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.calls.update, []);
  });

  it('opens the Settings UI on the alert settings for openConfig', async () => {
    const executed: unknown[][] = [];
    const originalExec = cmd.executeCommand;
    cmd.executeCommand = ((...a: unknown[]) => {
      executed.push(a);
      return Promise.resolve(undefined);
    }) as typeof cmd.executeCommand;
    try {
      const h = makeHarness();
      h.send({ type: 'openConfig' });
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(executed, [['workbench.action.openSettings', '@ext:RelativelyUnknown.mallard alerts']]);
    } finally {
      cmd.executeCommand = originalExec;
    }
  });

  it('pushes the new configuration to the webview whenever any setting changes', () => {
    const h = makeHarness();
    h.changeConfig({ monthlyBudget: 42 });
    assert.deepEqual(h.posted, [{ type: 'config', value: { monthlyBudget: 42 } }]);
  });

  it('ignores malformed messages entirely', async () => {
    const h = makeHarness();
    h.send(null);
    h.send({ type: 'sudo', value: 'rm -rf' });
    h.send({ type: 'restrictSnooze', minutes: -5 });
    await new Promise((r) => setImmediate(r));
    assert.equal(h.posted.length, 0);
    assert.equal(h.calls.snooze!.length, 0);
  });

  it('forwards snapshot updates from the usage service to the webview', () => {
    const h = makeHarness();
    h.snapshotEmitter.fire({ generatedAt: 2 });
    assert.equal(h.posted.length, 1);
    assert.equal(h.posted[0]!.type, 'snapshot');
  });

  it('returns disposables for every subscription', () => {
    const h = makeHarness();
    assert.equal(h.disposables.length, 7);
    for (const d of h.disposables) assert.doesNotThrow(() => d.dispose());
  });

  it('posts a new theme message when the mallard.palette setting changes, and not for other settings', async () => {
    const wsc = vscode.workspace as Mutable<typeof vscode.workspace>;
    const origGet = wsc.getConfiguration;
    let palette = 'swiss';
    wsc.getConfiguration = (() => ({
      get: (key: string) => (key === 'palette' ? palette : undefined),
      update: () => Promise.resolve(),
    })) as unknown as typeof wsc.getConfiguration;
    try {
      const h = makeHarness();
      const themes = () => h.posted.filter((m) => m.type === 'theme') as Array<Extract<WebviewBoundMsg, { type: 'theme' }>>;
      assert.equal(themes().length, 0);

      h.changeConfig({ monthlyBudget: 1 }); // another setting changed
      assert.equal(themes().length, 0, 'no theme re-post for unrelated config');

      palette = 'theme';
      h.changeConfig({ monthlyBudget: 1 });
      assert.equal(themes().length, 1, 'theme re-posted on palette change');
      assert.equal(themes()[0]!.palette, 'theme');
    } finally {
      wsc.getConfiguration = origGet;
    }
  });
});

describe('dashboardBridge — theme kind mapping', () => {
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  const win = vscode.window as Mutable<typeof vscode.window>;
  const origTheme = win.activeColorTheme;

  afterEach(() => { win.activeColorTheme = origTheme; });

  for (const [name, kind, expected] of [
    ['Light', vscode.ColorThemeKind.Light, 'light'],
    ['HighContrast', vscode.ColorThemeKind.HighContrast, 'high-contrast'],
    ['HighContrastLight', vscode.ColorThemeKind.HighContrastLight, 'high-contrast-light'],
    ['Dark (default)', vscode.ColorThemeKind.Dark, 'dark'],
  ] as const) {
    it(`maps ${name} to '${expected}'`, async () => {
      win.activeColorTheme = { kind };
      const posted: WebviewBoundMsg[] = [];
      let receive: ((m: unknown) => void) | undefined;
      const webview = {
        postMessage: (m: WebviewBoundMsg) => { posted.push(m); return Promise.resolve(true); },
        onDidReceiveMessage: (handler: (m: unknown) => void) => { receive = handler; return { dispose() {} }; },
      } as unknown as vscode.Webview;
      const deps = {
        usage: { current: undefined, onDidChangeSnapshot: emitter<unknown>().event },
        userConfig: { get: () => ({}), onDidChange: emitter<unknown>().event },
        layout: { get: () => defaultLayout(), onDidChange: emitter<unknown>().event },
        restriction: { getState: () => ({ active: false }), onDidChange: emitter<unknown>().event },
      } as unknown as DashboardDeps;
      bindDashboard(webview, deps);
      receive!({ type: 'ready' });
      await Promise.resolve();
      const theme = posted.at(-1) as Extract<WebviewBoundMsg, { type: 'theme' }>;
      assert.equal(theme.kind, expected);
    });
  }
});

import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { bindDashboard, DashboardDeps } from '../../../src/extension-backend/ui/dashboardBridge';
import { defaultLogger } from '../../../src/extension-backend/util/logger';

function emitter<T>() {
  const ls: Array<(v: T) => void> = [];
  return { event: (l: (v: T) => void) => (ls.push(l), { dispose() {} }), fire: (v: T) => ls.forEach((l) => l(v)) };
}

function harness(over: { refresh?: () => Promise<void>; set?: () => Promise<void> } = {}) {
  let receive: ((m: unknown) => void) | undefined;
  const setFilterCalls: unknown[] = [];
  const webview = {
    postMessage: () => Promise.resolve(true),
    onDidReceiveMessage: (h: (m: unknown) => void) => ((receive = h), { dispose() {} }),
  } as unknown as vscode.Webview;
  const deps = {
    usage: {
      current: undefined,
      refresh: over.refresh ?? (async () => {}),
      setFilter: async (f: unknown) => void setFilterCalls.push(f),
      onDidChangeSnapshot: emitter<unknown>().event,
    },
    userConfig: {
      get: () => ({}),
      set: over.set ?? (async () => {}),
      uri: vscode.Uri.file('/x'),
      onDidChange: emitter<unknown>().event,
    },
    layout: { get: () => ({ version: 2, panels: [] }), set: async () => {}, onDidChange: emitter<unknown>().event },
    restriction: { getState: () => ({ active: false }), snooze: async () => {}, onDidChange: emitter<unknown>().event },
  } as unknown as DashboardDeps;
  bindDashboard(webview, deps);
  return { send: (m: unknown) => receive!(m), setFilterCalls };
}

describe('dashboardBridge — hardening', () => {
  const origError = defaultLogger.error;
  let logged: string[];
  beforeEach(() => {
    logged = [];
    defaultLogger.error = (_tag: string, msg: string) => void logged.push(msg);
  });
  afterEach(() => {
    defaultLogger.error = origError;
  });

  it('logs a handler that rejects instead of leaving an unhandled rejection', async () => {
    const h = harness({
      refresh: async () => {
        throw new Error('db locked');
      },
    });
    h.send({ type: 'refresh' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(logged, ['message handler failed']);
  });

  it('logs a failing config write the same way', async () => {
    const h = harness({
      set: async () => {
        throw new Error('disk full');
      },
    });
    h.send({ type: 'setCurrency', value: 'EUR' });
    await new Promise((r) => setImmediate(r));
    assert.equal(logged.length, 1);
  });

  it('forwards a rebuilt filter, dropping unknown keys and unknown surfaces', async () => {
    const h = harness();
    h.send({ type: 'setFilter', value: { models: ['gpt-4o'], surfaces: ['chat', 'bogus'], evil: { x: 1 } } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.setFilterCalls, [{ models: ['gpt-4o'], surfaces: ['chat'] }]);
  });

  it('never reaches the usage service with a mis-shaped filter', async () => {
    const h = harness();
    h.send({ type: 'setFilter', value: { models: 'gpt-4o' } });
    h.send({ type: 'setFilter', value: { range: { start: 'a', end: 'b' } } });
    h.send({ type: 'setFilter', value: { repos: [{ $ne: null }] } });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(h.setFilterCalls, []);
  });
});

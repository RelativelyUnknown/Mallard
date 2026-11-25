import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import {
  detectAll,
  detectClaudeCode,
  detectCopilot,
  probeExtension,
} from '../../../src/extension-backend/util/extensionDetector';
import { defaultVscodeHost } from '../../../src/extension-backend/util/vscodeHost';
import { LayoutStore, LAYOUT_V2_KEY } from '../../../src/extension-backend/app/LayoutStore';
import { activeLanguage } from '../../../src/extension-backend/util/editor';
import { PANEL_IDS } from '../../../src/extension-backend/domain/layout';
import type { LayoutV2 } from '../../../src/extension-backend/domain/contracts';
import { makeMemento } from '../helpers';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
const ext = vscode.extensions as Mutable<typeof vscode.extensions>;
const win = vscode.window as Mutable<typeof vscode.window>;
const cmd = vscode.commands as Mutable<typeof vscode.commands>;

describe('extensionDetector', () => {
  const originalGetExtension = ext.getExtension;
  afterEach(() => { ext.getExtension = originalGetExtension; });

  function installed(ids: Record<string, { version: string; isActive: boolean }>) {
    ext.getExtension = ((id: string) => {
      const found = ids[id];
      return found
        ? { packageJSON: { version: found.version }, isActive: found.isActive }
        : undefined;
    }) as typeof ext.getExtension;
  }

  it('detects Copilot via the first matching candidate id', () => {
    installed({ 'github.copilot': { version: '1.250.0', isActive: true } });
    assert.deepEqual(detectCopilot(), { id: 'github.copilot', version: '1.250.0', isActive: true });
  });

  it('falls through to the next candidate id (copilot-chat only)', () => {
    installed({ 'github.copilot-chat': { version: '0.30.0', isActive: false } });
    assert.equal(detectCopilot()!.id, 'github.copilot-chat');
  });

  it('detects Claude Code', () => {
    installed({ 'anthropic.claude-code': { version: '2.0.1', isActive: true } });
    assert.equal(detectClaudeCode()!.id, 'anthropic.claude-code');
  });

  it('returns undefined when nothing is installed', () => {
    installed({});
    assert.equal(detectCopilot(), undefined);
    assert.equal(probeExtension({ name: 'x', ids: ['no.such'] }), undefined);
  });

  it('detectAll reports every probe with its result', () => {
    installed({ 'github.copilot': { version: '1.0.0', isActive: true } });
    const all = detectAll();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.name, 'GitHub Copilot');
    assert.ok(all[0]!.result);
    assert.equal(all[1]!.result, undefined);
  });
});

describe('defaultVscodeHost', () => {
  const originalWarn = win.showWarningMessage;
  const originalExec = cmd.executeCommand;
  afterEach(() => {
    win.showWarningMessage = originalWarn;
    cmd.executeCommand = originalExec;
  });

  it('forwards showWarningMessage and executeCommand to vscode', async () => {
    const warnings: string[] = [];
    const commands: unknown[][] = [];
    win.showWarningMessage = ((msg: string) => {
      warnings.push(msg);
      return Promise.resolve(undefined);
    }) as typeof win.showWarningMessage;
    cmd.executeCommand = ((...args: unknown[]) => {
      commands.push(args);
      return Promise.resolve('done');
    }) as typeof cmd.executeCommand;

    await defaultVscodeHost.showWarningMessage('careful');
    const result = await defaultVscodeHost.executeCommand('my.cmd', 1, 'two');

    assert.deepEqual(warnings, ['careful']);
    assert.deepEqual(commands, [['my.cmd', 1, 'two']]);
    assert.equal(result, 'done');
  });
});

describe('LayoutStore (globalState-backed)', () => {
  function makeStore() {
    const state = makeMemento();
    return { state, store: new LayoutStore(state) };
  }

  it('returns the default layout when nothing is stored', () => {
    const { store } = makeStore();
    assert.equal(store.get().panels.length, PANEL_IDS.length);
    store.dispose();
  });

  it('set() persists a layout into globalState (the v2 key) and fires onDidChange', async () => {
    const { state, store } = makeStore();
    const fired: LayoutV2[] = [];
    store.onDidChange((l) => fired.push(l));

    const reordered = { ...store.get(), panels: [...store.get().panels].reverse() };
    await store.set(reordered);

    assert.equal(fired.length, 1);
    assert.equal(store.get().panels[0]!.id, reordered.panels[0]!.id);
    const stored = state.get<LayoutV2>(LAYOUT_V2_KEY);
    assert.equal(stored?.panels[0]?.id, reordered.panels[0]!.id);
    store.dispose();
  });

  it('reset() restores the default layout', async () => {
    const { store } = makeStore();
    await store.set({ ...store.get(), panels: [...store.get().panels].reverse() });
    await store.reset();
    assert.deepEqual(store.get().panels.map((p) => p.id), [...PANEL_IDS]);
    store.dispose();
  });
});

describe('activeLanguage', () => {
  it('returns the active editor languageId', () => {
    win.activeTextEditor = { document: { languageId: 'rust' } } as never;
    assert.equal(activeLanguage(), 'rust');
  });

  it('returns undefined when no editor is open', () => {
    win.activeTextEditor = undefined as never;
    assert.equal(activeLanguage(), undefined);
  });
});

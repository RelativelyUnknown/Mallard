import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import {
  promptReloadWindow,
  watchReloadRequiredSettings,
} from '../../../src/extension-backend/util/reloadPrompt';

describe('reloadPrompt', () => {
  const ws = vscode.workspace as unknown as { getConfiguration: unknown };
  const win = vscode.window as unknown as { showInformationMessage: unknown };
  const cmds = vscode.commands as unknown as { executeCommand: unknown };
  const orig = {
    cfg: ws.getConfiguration,
    show: win.showInformationMessage,
    exec: cmds.executeCommand,
  };
  afterEach(() => {
    ws.getConfiguration = orig.cfg;
    win.showInformationMessage = orig.show;
    cmds.executeCommand = orig.exec;
  });

  /** `settings` is what getConfiguration('mallard').get() answers (short keys); `change()` is the one config event. */
  function arm(answer: string | undefined, settings: Record<string, unknown> = {}) {
    const shown: string[] = [];
    const executed: string[] = [];
    const emitter = new vscode.EventEmitter<void>();
    ws.getConfiguration = () => ({ get: (key: string) => settings[key], update: () => Promise.resolve() });
    win.showInformationMessage = (msg: string) => {
      shown.push(msg);
      return Promise.resolve(answer);
    };
    cmds.executeCommand = (id: string) => {
      executed.push(id);
      return Promise.resolve();
    };
    return { event: emitter.event, change: () => emitter.fire(), settings, shown, executed };
  }

  const flush = () => new Promise((r) => setImmediate(r));

  it('prompts and reloads when enabledConnectors changes and the user accepts', async () => {
    const h = arm('Reload Window', { enabledConnectors: ['copilot'] });
    const sub = watchReloadRequiredSettings(h.event);
    h.settings['enabledConnectors'] = ['copilot', 'claude-code'];
    h.change();
    await flush();
    assert.equal(h.shown.length, 1, 'one prompt shown');
    assert.deepEqual(h.executed, ['workbench.action.reloadWindow']);
    sub.dispose();
  });

  it('prompts but does not reload when the user dismisses', async () => {
    const h = arm(undefined);
    const sub = watchReloadRequiredSettings(h.event);
    h.settings['dataRetentionDays'] = 120;
    h.change();
    await flush();
    assert.equal(h.shown.length, 1);
    assert.deepEqual(h.executed, []);
    sub.dispose();
  });

  it('ignores a change that does not move an activation-time setting (including an out-of-range value that sanitises to the same one)', async () => {
    const h = arm('Reload Window');
    const sub = watchReloadRequiredSettings(h.event);
    h.settings['palette'] = 'theme';
    h.change();
    h.settings['dataRetentionDays'] = 99999; // clamps to 365: a change
    h.change();
    h.settings['dataRetentionDays'] = 365; // same effective value as above
    h.change();
    await flush();
    assert.equal(h.shown.length, 1, 'only the one real change prompts');
    sub.dispose();
  });

  it('promptReloadWindow includes the caller reason in the message', async () => {
    const h = arm(undefined);
    await promptReloadWindow('Connector choice saved.');
    assert.ok(h.shown[0]?.startsWith('Connector choice saved.'), h.shown[0] ?? 'no prompt shown');
  });
});

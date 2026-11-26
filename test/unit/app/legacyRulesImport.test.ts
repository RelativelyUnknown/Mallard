import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { vscodeLegacyRulesUi } from '../../../src/extension-backend/app/LegacyRulesImport';

describe('vscodeLegacyRulesUi', () => {
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  const win = vscode.window as Mutable<typeof vscode.window>;
  const cmds = vscode.commands as Mutable<typeof vscode.commands>;
  const original = { info: win.showInformationMessage, exec: cmds.executeCommand };
  afterEach(() => {
    win.showInformationMessage = original.info;
    cmds.executeCommand = original.exec;
  });

  it('shows the summary with an Open Settings action that opens the alert settings', async () => {
    const shown: unknown[][] = [];
    const executed: unknown[][] = [];
    win.showInformationMessage = ((...a: unknown[]) => (shown.push(a), Promise.resolve('Open Settings'))) as unknown as typeof win.showInformationMessage;
    cmds.executeCommand = ((...a: unknown[]) => (executed.push(a), Promise.resolve(undefined))) as unknown as typeof cmds.executeCommand;
    vscodeLegacyRulesUi.info('converted');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(shown, [['converted', 'Open Settings']]);
    assert.deepEqual(executed, [['workbench.action.openSettings', '@ext:RelativelyUnknown.mallard alerts']]);
  });

  it('does nothing more when the message is dismissed', async () => {
    const executed: unknown[][] = [];
    win.showInformationMessage = (() => Promise.resolve(undefined)) as unknown as typeof win.showInformationMessage;
    cmds.executeCommand = ((...a: unknown[]) => (executed.push(a), Promise.resolve(undefined))) as unknown as typeof cmds.executeCommand;
    vscodeLegacyRulesUi.info('converted');
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(executed, []);
  });
});

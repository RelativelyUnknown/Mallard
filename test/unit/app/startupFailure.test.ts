import { strict as assert } from 'assert';
import { promises as fs, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { contributedCommandIds, deleteDatabaseFiles, failedSidebarHtml, registerStartupFailure } from '../../../src/extension-backend/app/startupFailure';
import { defaultLogger } from '../../../src/extension-backend/util/logger';

type Handler = (...args: unknown[]) => unknown;
const manifest = JSON.parse(readFileSync(path.join(__dirname, '../../../package.json'), 'utf8')) as {
  contributes: { commands: Array<{ command: string }> };
};

const win = vscode.window as unknown as Record<string, unknown>;
const cmds = vscode.commands as unknown as Record<string, unknown>;

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'mallard-startup-fail-'));
}

describe('startup failure recovery', () => {
  const saved = {
    registerCommand: cmds['registerCommand'],
    executeCommand: cmds['executeCommand'],
    showErrorMessage: win['showErrorMessage'],
    showWarningMessage: win['showWarningMessage'],
    registerWebviewViewProvider: win['registerWebviewViewProvider'],
  };
  let handlers: Map<string, Handler>;
  let errors: Array<{ message: string; actions: string[] }>;
  let errorChoice: string | undefined;
  let warningChoice: string | undefined;
  let executed: string[];
  let providers: Array<{ viewId: string; provider: { resolveWebviewView(v: unknown): void } }>;

  beforeEach(() => {
    handlers = new Map();
    errors = [];
    executed = [];
    providers = [];
    errorChoice = undefined;
    warningChoice = undefined;
    cmds['registerCommand'] = (id: string, h: Handler) => {
      handlers.set(id, h);
      return { dispose() {} };
    };
    cmds['executeCommand'] = async (id: string) => void executed.push(id);
    win['showErrorMessage'] = async (message: string, ...actions: string[]) => {
      errors.push({ message, actions });
      return errorChoice;
    };
    win['showWarningMessage'] = async () => warningChoice;
    win['registerWebviewViewProvider'] = (viewId: string, provider: never) => {
      providers.push({ viewId, provider });
      return { dispose() {} };
    };
  });
  afterEach(() => {
    Object.assign(cmds, { registerCommand: saved.registerCommand, executeCommand: saved.executeCommand });
    Object.assign(win, {
      showErrorMessage: saved.showErrorMessage,
      showWarningMessage: saved.showWarningMessage,
      registerWebviewViewProvider: saved.registerWebviewViewProvider,
    });
  });

  function makeContext(dir: string) {
    return {
      subscriptions: [] as Array<{ dispose(): void }>,
      globalStorageUri: { fsPath: dir },
      extension: { packageJSON: manifest },
    } as unknown as vscode.ExtensionContext;
  }

  it('reads the contributed command ids from the extension manifest', () => {
    const ids = contributedCommandIds(makeContext('/x'));
    assert.deepEqual([...ids].sort(), manifest.contributes.commands.map((c) => c.command).sort());
    assert.ok(ids.length > 10);
  });

  it('registers a handler for EVERY contributed command, so none is "not found"', async () => {
    const dir = await tmpDir();
    registerStartupFailure(makeContext(dir), 'database is locked', { show() {} });
    assert.deepEqual(
      [...handlers.keys()].sort(),
      manifest.contributes.commands.map((c) => c.command).sort(),
    );
  });

  it('shows "Mallard failed to start: <message>" immediately and from any command, with recovery actions', async () => {
    const dir = await tmpDir();
    registerStartupFailure(makeContext(dir), 'database is locked', { show() {} });
    await new Promise((r) => setImmediate(r));
    assert.equal(errors.length, 1, 'shown once at startup');
    assert.match(errors[0]!.message, /^Mallard failed to start: database is locked/);
    assert.match(errors[0]!.message, /Output panel/);
    assert.deepEqual(errors[0]!.actions, ['Show Output', 'Reset Mallard Data…']);

    await handlers.get('mallard.openDashboard')!();
    assert.equal(errors.length, 2, 'running a command repeats the explanation');
  });

  it('"Show Output" reveals the Mallard output channel', async () => {
    let shown = 0;
    registerStartupFailure(makeContext(await tmpDir()), 'x', { show: () => void shown++ });
    errorChoice = 'Show Output';
    await handlers.get('mallard.refresh')!();
    assert.ok(shown >= 1);
  });

  it('"Reset Mallard Data…" (and mallard.clearData) delete events.duckdb after confirmation, then reload', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'events.duckdb'), 'db');
    await fs.writeFile(path.join(dir, 'events.duckdb.wal'), 'wal');
    await fs.writeFile(path.join(dir, 'config.json'), '{}');
    registerStartupFailure(makeContext(dir), 'corrupt', { show() {} });

    warningChoice = undefined; // user cancels the confirmation
    await handlers.get('mallard.clearData')!();
    assert.deepEqual((await fs.readdir(dir)).sort(), ['config.json', 'events.duckdb', 'events.duckdb.wal']);
    assert.deepEqual(executed, []);

    warningChoice = 'Delete and reload';
    await handlers.get('mallard.clearData')!();
    assert.deepEqual(await fs.readdir(dir), ['config.json'], 'database gone, user config kept');
    assert.deepEqual(executed, ['workbench.action.reloadWindow']);
  });

  it('registers a placeholder sidebar that escapes the message', async () => {
    registerStartupFailure(makeContext(await tmpDir()), '<img src=x onerror=alert(1)>', { show() {} });
    assert.equal(providers.length, 1);
    assert.equal(providers[0]!.viewId, 'mallard.sidebar');
    const view = { webview: { options: {}, html: '' } };
    providers[0]!.provider.resolveWebviewView(view);
    assert.match(view.webview.html, /Mallard failed to start/);
    assert.ok(!view.webview.html.includes('<img'), 'message must be escaped');
    assert.ok(view.webview.html.includes('&lt;img'));
    assert.equal((view.webview.options as { enableScripts: boolean }).enableScripts, false);
  });

  it('failedSidebarHtml has a script-free CSP', () => {
    assert.match(failedSidebarHtml('x'), /default-src 'none'/);
    assert.ok(!/<script/i.test(failedSidebarHtml('x')));
  });

  it('deleteDatabaseFiles removes only the database files and tolerates absent ones', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'events.duckdb'), 'db');
    assert.deepEqual(await deleteDatabaseFiles(dir), ['events.duckdb']);
    assert.deepEqual(await deleteDatabaseFiles(dir), []);
  });

  it('deleteDatabaseFiles logs and carries on when a database file cannot be deleted (not just absent)', async () => {
    const dir = await tmpDir();
    // A directory where the file should be: unlink() fails with EISDIR/EPERM, not ENOENT.
    await fs.mkdir(path.join(dir, 'events.duckdb'));
    await fs.writeFile(path.join(dir, 'events.duckdb.wal'), 'wal');
    const lines: string[] = [];
    const detach = defaultLogger.attachSink({ appendLine: (l) => void lines.push(l) });
    const warn = console.warn;
    console.warn = () => {};
    let removed: string[];
    try {
      removed = await deleteDatabaseFiles(dir);
    } finally {
      console.warn = warn;
      detach();
    }
    assert.deepEqual(removed, ['events.duckdb.wal'], 'the undeletable entry is not reported as removed');
    assert.equal(lines.filter((l) => l.includes('[warn]') && l.includes('could not delete events.duckdb')).length, 1);
    assert.ok((await fs.stat(path.join(dir, 'events.duckdb'))).isDirectory());
  });
});

import { strict as assert } from 'assert';
import * as vm from 'vm';
import * as vscode from 'vscode';
import { SidebarView } from '../../../src/extension-backend/ui/SidebarView';

/** Resolve the sidebar and return the page's inline script, evaluated in a sandbox. */
function loadSidebarScript(intl?: unknown): { fmtMoney(amount: number, currency?: unknown): string } {
  const context = { extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext;
  const view = new SidebarView(context, { onDidChangeSnapshot: () => ({ dispose() {} }), onAlertFired: () => ({ dispose() {} }) } as never);
  const webviewView = {
    webview: {
      options: {},
      html: '',
      cspSource: 'vscode-webview:',
      asWebviewUri: (u: vscode.Uri) => u,
      postMessage: () => Promise.resolve(true),
      onDidReceiveMessage: () => ({ dispose() {} }),
    },
    visible: false,
    onDidChangeVisibility: () => ({ dispose() {} }),
  } as unknown as vscode.WebviewView;
  view.resolveWebviewView(webviewView);

  const html = webviewView.webview.html;
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)![1]!;
  const el = { addEventListener() {}, innerHTML: '', classList: { add() {}, remove() {} } };
  const sandbox: Record<string, unknown> = {
    acquireVsCodeApi: () => ({ postMessage() {} }),
    document: { getElementById: () => el, querySelectorAll: () => [] },
    window: { addEventListener() {} },
    ...(intl ? { Intl: intl } : {}),
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return sandbox as unknown as { fmtMoney(amount: number, currency?: unknown): string };
}

describe('SidebarView — fmtMoney fallback never injects the raw currency', () => {
  // Force the Intl failure path, which used to echo the currency verbatim
  // into a string that is then assigned to innerHTML.
  const throwingIntl = {
    NumberFormat: class {
      constructor() {
        throw new RangeError('Invalid currency code');
      }
    },
  };

  it('replaces a markup-bearing currency with USD in the fallback', () => {
    const { fmtMoney } = loadSidebarScript(throwingIntl);
    const out = fmtMoney(5, '<img src=x onerror=alert(1)>');
    assert.ok(!out.includes('<') && !out.includes('onerror'), out);
    assert.equal(out, 'USD 5.00');
  });

  it('uses a well-formed 3-letter code (upper-cased) in the fallback', () => {
    const { fmtMoney } = loadSidebarScript(throwingIntl);
    assert.equal(fmtMoney(5, 'eur'), 'EUR 5.00');
  });

  it('treats non-strings and wrong-length codes as USD', () => {
    const { fmtMoney } = loadSidebarScript(throwingIntl);
    for (const bad of [undefined, null, 42, 'EURO', 'E', '', 'a;b']) {
      assert.equal(fmtMoney(5, bad), 'USD 5.00', String(bad));
    }
  });

  it('formats normally through Intl for a valid code', () => {
    const { fmtMoney } = loadSidebarScript();
    assert.match(fmtMoney(5, 'eur'), /5/);
    assert.ok(!/</.test(fmtMoney(5, '<b>')));
  });
});

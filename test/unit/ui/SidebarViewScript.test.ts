import { strict as assert } from 'assert';
import * as vscode from 'vscode';
import { SidebarView } from '../../../src/extension-backend/ui/SidebarView';

/**
 * Runs the sidebar's inline webview script against the shared jsdom document.
 * The markup is the real `webview.html` produced by SidebarView; the script
 * gets a stub `window` (so its message listener doesn't leak onto the global
 * jsdom window) and a stub acquireVsCodeApi that records what it posts.
 */
function loadSidebar() {
  const usage = {
    current: undefined,
    onDidChangeSnapshot: () => ({ dispose() {} }),
    onAlertFired: () => ({ dispose() {} }),
    setFilter: async () => {},
  };
  const view = new SidebarView({ extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext, usage as never);
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

  const bodyMarkup = /<body>([\s\S]*?)<script/.exec(html)![1]!;
  const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)![1]!;

  const host = document.createElement('div');
  host.innerHTML = bodyMarkup;
  document.body.appendChild(host);

  const posted: Array<Record<string, unknown>> = [];
  let onMessage: ((e: { origin: string; data: unknown }) => void) | undefined;
  const fakeWindow = {
    addEventListener(type: string, fn: (e: { origin: string; data: unknown }) => void) {
      if (type === 'message') onMessage = fn;
    },
  };
  new Function('window', 'acquireVsCodeApi', script)(fakeWindow, () => ({
    postMessage: (m: Record<string, unknown>) => posted.push(m),
  }));

  return {
    host,
    posted,
    body: () => host.querySelector<HTMLElement>('#body')!,
    snapshot(payload: Record<string, unknown>, origin = 'vscode-webview://abc') {
      onMessage!({ origin, data: { type: 'snapshot', payload } });
    },
    dispose: () => host.remove(),
  };
}

function snap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: 'USD',
    budget: { monthly: 100, usedCost: 25 },
    today: { cost: 1.5 },
    topModels: [
      { key: 'gpt-4o', credits: 120 },
      { key: 'claude-sonnet-4-5', credits: 60 },
    ],
    filter: {},
    ...overrides,
  };
}

describe('SidebarView inline script', () => {
  it('announces itself with ready, and ignores messages not from a vscode-webview origin', () => {
    const sb = loadSidebar();
    assert.deepEqual(sb.posted[0], { type: 'ready' });

    sb.snapshot(snap(), 'https://evil.example');
    assert.equal(sb.body().querySelectorAll('.sb-model-row').length, 0, 'foreign-origin snapshot ignored');
    sb.snapshot(snap());
    assert.equal(sb.body().querySelectorAll('.sb-model-row').length, 2);
    sb.dispose();
  });

  it('renders model rows as buttons and posts toggleModelFilter when one is clicked', () => {
    const sb = loadSidebar();
    sb.snapshot(snap());
    const rows = sb.body().querySelectorAll<HTMLElement>('.sb-model-row');
    assert.equal(rows.length, 2);
    rows[1]!.click();
    assert.deepEqual(sb.posted.at(-1), { type: 'toggleModelFilter', model: 'claude-sonnet-4-5' });
    sb.dispose();
  });

  it('escapes model ids, in element content and in the data attribute', () => {
    const sb = loadSidebar();
    sb.snapshot(snap({ topModels: [{ key: '<img src=x onerror=1>', credits: 5 }] }));
    assert.equal(sb.body().querySelector('img'), null, 'no element was injected');
    const row = sb.body().querySelector<HTMLElement>('.sb-model-row')!;
    assert.equal(row.dataset.model, '<img src=x onerror=1>');
    assert.equal(row.querySelector('.sb-model-name')!.textContent, '<img src=x onerror=1>');
    sb.dispose();
  });

  it('escapes a hostile currency code that Intl cannot format (fmtMoney falls back to echoing it)', () => {
    const sb = loadSidebar();
    sb.snapshot(snap({ currency: '<u>' }));
    assert.equal(sb.body().querySelector('u'), null);
    assert.match(sb.body().textContent!, /<u>/);
    sb.dispose();
  });

  it('keeps keyboard focus on the same model row when a snapshot re-renders the list', () => {
    const sb = loadSidebar();
    sb.snapshot(snap());
    const second = sb.body().querySelectorAll<HTMLElement>('.sb-model-row')[1]!;
    second.focus();
    assert.equal(document.activeElement, second);

    // Selecting the row changes the filter; the host answers with a new snapshot.
    sb.snapshot(snap({ filter: { models: ['claude-sonnet-4-5'] }, topModels: [{ key: 'gpt-4o', credits: 130 }, { key: 'claude-sonnet-4-5', credits: 61 }] }));
    const rebuilt = sb.body().querySelectorAll<HTMLElement>('.sb-model-row')[1]!;
    assert.notEqual(rebuilt, second, 'the list was rebuilt (selection and numbers changed)');
    assert.equal(rebuilt.dataset.model, 'claude-sonnet-4-5');
    assert.equal(rebuilt.getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, rebuilt, 'focus restored to the same model');
    sb.dispose();
  });

  it('skips the rebuild entirely when nothing it shows has changed', () => {
    const sb = loadSidebar();
    sb.snapshot(snap());
    const row = sb.body().querySelector('.sb-model-row');
    sb.snapshot(snap());
    assert.equal(sb.body().querySelector('.sb-model-row'), row, 'identical snapshot leaves the DOM alone');
    sb.dispose();
  });

  it('rows re-rendered after a snapshot are still wired to post toggles', () => {
    const sb = loadSidebar();
    sb.snapshot(snap());
    sb.snapshot(snap({ topModels: [{ key: 'only-model', credits: 9 }] }));
    sb.body().querySelector<HTMLElement>('.sb-model-row')!.click();
    assert.deepEqual(sb.posted.at(-1), { type: 'toggleModelFilter', model: 'only-model' });
    sb.dispose();
  });
});

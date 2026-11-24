import { strict as assert } from 'assert';
import { createRequire } from 'module';
import { fetchJson } from '../../src/extension-backend/pricing/httpJson';

// A real module object (not an import namespace copy) so stubbing https.get is visible to the fetcher.
const https = createRequire(__filename)('https') as typeof import('https');

interface Reply {
  statusCode: number;
  headers?: Record<string, string>;
  body?: string;
  /** Keep sending data forever (a slow-drip server). */
  drip?: boolean;
}

/** https.get stub answering per URL; records drained responses and destroyed requests. */
function stub(route: (url: string) => Reply) {
  const orig = https.get;
  const seen = { urls: [] as string[], resumed: 0, destroyed: 0 };
  https.get = ((url: string, _opts: unknown, cb: (res: unknown) => void) => {
    seen.urls.push(String(url));
    let dripTimer: ReturnType<typeof setInterval> | undefined;
    const fakeReq = {
      on() { return fakeReq; },
      destroy() { seen.destroyed++; if (dripTimer) clearInterval(dripTimer); return fakeReq; },
    } as unknown as ReturnType<typeof https.get>;
    setImmediate(() => {
      const r = route(String(url));
      const listeners: Record<string, (d?: Buffer) => void> = {};
      const res = {
        statusCode: r.statusCode,
        headers: r.headers ?? {},
        resume(): void { seen.resumed++; },
        on(ev: string, fn: (d?: Buffer) => void) { listeners[ev] = fn; return res; },
      };
      cb(res);
      if (r.drip) {
        dripTimer = setInterval(() => listeners['data']?.(Buffer.from(' ')), 5);
        return;
      }
      setImmediate(() => {
        if (r.body !== undefined) listeners['data']?.(Buffer.from(r.body));
        listeners['end']?.();
      });
    });
    return fakeReq;
  }) as typeof https.get;
  return { seen, restore: () => { https.get = orig; } };
}

describe('fetchJson', () => {
  it('parses a 200 JSON body', async () => {
    const s = stub(() => ({ statusCode: 200, body: '{"a":1}' }));
    try {
      assert.deepEqual(await fetchJson('https://example.com/x'), { a: 1 });
    } finally { s.restore(); }
  });

  it('drains the response of a non-200 so the socket is released, and rejects', async () => {
    const s = stub(() => ({ statusCode: 503 }));
    try {
      await assert.rejects(fetchJson('https://example.com/x'), /HTTP 503/);
      assert.equal(s.seen.resumed, 1, 'res.resume() called on the failed response');
    } finally { s.restore(); }
  });

  it('follows a redirect (relative or absolute) and resolves the final body', async () => {
    const s = stub((u) =>
      u.endsWith('/old') ? { statusCode: 301, headers: { location: '/new' } } : { statusCode: 200, body: '{"ok":true}' },
    );
    try {
      assert.deepEqual(await fetchJson('https://example.com/old'), { ok: true });
      assert.deepEqual(s.seen.urls, ['https://example.com/old', 'https://example.com/new']);
      assert.equal(s.seen.resumed, 1, 'the redirect response is drained');
    } finally { s.restore(); }
  });

  it('gives up after the redirect limit', async () => {
    const s = stub(() => ({ statusCode: 302, headers: { location: 'https://example.com/again' } }));
    try {
      await assert.rejects(fetchJson('https://example.com/x', { maxRedirects: 2 }), /Too many redirects/);
      assert.equal(s.seen.urls.length, 3);
    } finally { s.restore(); }
  });

  it('refuses a redirect to a non-https URL', async () => {
    const s = stub(() => ({ statusCode: 302, headers: { location: 'http://example.com/plain' } }));
    try {
      await assert.rejects(fetchJson('https://example.com/x'), /non-https/);
      assert.equal(s.seen.urls.length, 1, 'the plain-http target is never requested');
    } finally { s.restore(); }
  });

  it('enforces an overall deadline even when data keeps trickling in (idle timeout never fires)', async () => {
    const s = stub(() => ({ statusCode: 200, drip: true }));
    try {
      const t0 = Date.now();
      await assert.rejects(fetchJson('https://example.com/x', { timeoutMs: 60 }), /Timeout/);
      assert.ok(Date.now() - t0 < 2_000);
      assert.ok(s.seen.destroyed >= 1, 'the request is destroyed on timeout');
    } finally { s.restore(); }
  });

  it('rejects a body over the size cap and destroys the request', async () => {
    const s = stub(() => ({ statusCode: 200, body: 'x'.repeat(100) }));
    try {
      await assert.rejects(fetchJson('https://example.com/x', { maxBytes: 10 }), /exceeds 10 bytes/);
      assert.equal(s.seen.destroyed, 1);
    } finally { s.restore(); }
  });
});

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WebhookProtocol } from '../../src/extension-backend/export/WebhookProtocol';

/* eslint-disable @typescript-eslint/no-require-imports */
const https = require('https') as typeof import('https');
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

function fetchReturning(status: number, inits: RequestInit[] = []): RequestInit[] {
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    inits.push(init);
    return { status } as Response;
  }) as typeof fetch;
  return inits;
}

async function sendOnce(retries = 0) {
  const p = new WebhookProtocol({ url: 'https://x/ingest', retries }, quietLogger);
  const r = await p.send('t', { schema_version: 3 });
  p.dispose();
  return r;
}

describe('WebhookProtocol — status classification', () => {
  for (const status of [401, 403, 408, 429, 500, 502, 503]) {
    it(`treats ${status} as retryable`, async () => {
      fetchReturning(status);
      assert.deepEqual(await sendOnce(), { ok: false, retryable: true });
    });
  }

  for (const status of [400, 404, 410, 413, 422]) {
    it(`treats ${status} as fatal (the payload will never be accepted)`, async () => {
      fetchReturning(status);
      assert.deepEqual(await sendOnce(), { ok: false, retryable: false });
    });
  }

  for (const status of [301, 302, 303, 307, 308]) {
    it(`never treats a ${status} redirect as success, and does not retry it`, async () => {
      const calls = fetchReturning(status);
      assert.deepEqual(await sendOnce(2), { ok: false, retryable: false });
      assert.equal(calls.length, 1);
    });
  }

  it('retries a 401 like any transient failure and stays retryable when it keeps failing', async () => {
    const calls = fetchReturning(401);
    const r = await sendOnce(1);
    assert.deepEqual(r, { ok: false, retryable: true });
    assert.equal(calls.length, 2, 'initial attempt + one retry');
  });
});

describe('WebhookProtocol — redirects are never followed', () => {
  it('asks fetch to reject redirects (redirect:"error") so credentials are not forwarded', async () => {
    const calls = fetchReturning(202);
    const p = new WebhookProtocol(
      { url: 'https://x/ingest', headers: { 'X-API-Key': 'secret' }, retries: 0 },
      quietLogger,
    );
    await p.send('t', { schema_version: 3 });
    p.dispose();
    assert.equal(calls[0]!.redirect, 'error');
  });

  it('reports a refused redirect as fatal and does not retry it', async () => {
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts += 1;
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    }) as typeof fetch;
    assert.deepEqual(await sendOnce(2), { ok: false, retryable: false });
    assert.equal(attempts, 1);
  });

  it('still treats an ordinary network error as retryable', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNREFUSED') });
    }) as typeof fetch;
    assert.deepEqual(await sendOnce(), { ok: false, retryable: true });
  });

  it('treats a 3xx on the client-certificate path as fatal too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mallard-webhook-3xx-'));
    const certFile = path.join(dir, 'c.pem');
    const keyFile = path.join(dir, 'k.pem');
    fs.writeFileSync(certFile, 'cert');
    fs.writeFileSync(keyFile, 'key');
    const origRequest = https.request;
    https.request = ((_opts: unknown, cb: (res: { statusCode: number; resume(): void }) => void) => {
      const req = {
        on() { return req; },
        write() { return true; },
        end() { setTimeout(() => cb({ statusCode: 302, resume() {} }), 0); return req; },
        destroy() { return req; },
      } as unknown as ReturnType<typeof https.request>;
      return req;
    }) as typeof https.request;
    try {
      const p = new WebhookProtocol({ url: 'https://x/ingest', certFile, keyFile, retries: 0 }, quietLogger);
      assert.deepEqual(await p.send('t', { schema_version: 3 }), { ok: false, retryable: false });
      p.dispose();
    } finally {
      https.request = origRequest;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

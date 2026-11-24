/**
 * Bounded HTTPS GET → parsed JSON, shared by the pricing and FX feeds.
 *
 * Bounds: a socket-idle timeout AND an overall deadline (a slow-drip server
 * can otherwise keep a request alive indefinitely), a response size cap,
 * HTTPS-only redirects up to a small limit, and every non-200 response is
 * drained so its socket is released.
 */
import * as https from 'https';

/** Idle-socket timeout; the overall deadline below bounds the whole exchange. */
const IDLE_TIMEOUT_MS = 5_000;
const OVERALL_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 3;
/** Hard cap on response bodies; LiteLLM's full price sheet is ~2 MB. */
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface FetchJsonOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export function fetchJson(url: string, opts: FetchJsonOptions = {}): Promise<unknown> {
  const maxBytes = opts.maxBytes ?? MAX_RESPONSE_BYTES;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  return new Promise((resolve, reject) => {
    let settled = false;
    let current: ReturnType<typeof https.get> | undefined;
    const deadline = setTimeout(() => fail(new Error('Timeout')), opts.timeoutMs ?? OVERALL_TIMEOUT_MS);

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(deadline);
      return true;
    };
    const fail = (err: Error): void => {
      if (!settle()) return;
      current?.destroy(err);
      reject(err);
    };

    const get = (target: string, redirectsLeft: number): void => {
      const req = https.get(target, { timeout: IDLE_TIMEOUT_MS }, (res) => {
        const status = res.statusCode ?? 0;
        // https.get does not follow 30x on its own (hosts do move, e.g.
        // Frankfurter .app ↔ .dev), so follow a few, https-only.
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            fail(new Error('Too many redirects'));
            return;
          }
          let next: URL;
          try {
            next = new URL(res.headers.location, target);
          } catch {
            fail(new Error('Invalid redirect'));
            return;
          }
          if (next.protocol !== 'https:') {
            fail(new Error('Redirect to a non-https URL'));
            return;
          }
          get(next.toString(), redirectsLeft - 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          fail(new Error(`HTTP ${status}`));
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on('data', (c: Buffer) => {
          received += c.length;
          if (received > maxBytes) {
            fail(new Error(`Response exceeds ${maxBytes} bytes`));
            return;
          }
          chunks.push(c);
        });
        res.on('error', fail);
        res.on('end', () => {
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
          } catch (e) {
            fail(e instanceof Error ? e : new Error(String(e)));
            return;
          }
          if (settle()) resolve(body);
        });
      });
      current = req;
      req.on('timeout', () => fail(new Error('Timeout')));
      req.on('error', fail);
    };

    get(url, maxRedirects);
  });
}

// Tiny static server for dist/ that injects the extension's exact CSP (with a per-request nonce)
// into index.html's <meta http-equiv="Content-Security-Policy">. `cspSource` is `'self'` here.
//   ?csp=strict  -> style-src 'self' (NO 'unsafe-inline'), to find out what gridstack alone needs.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

export function buildCsp(nonce, strict = false) {
  const cspSource = `'self'`;
  return [
    `default-src 'none'`,
    `img-src ${cspSource} data:`,
    `font-src ${cspSource}`,
    strict ? `style-src ${cspSource}` : `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `connect-src ${cspSource}`,
  ].join('; ');
}

export function startServer(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404).end('nf'); return; }
    let body = readFileSync(file);
    const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
    if (rel.endsWith('index.html')) {
      const nonce = randomBytes(16).toString('base64');
      const csp = buildCsp(nonce, url.searchParams.get('csp') === 'strict');
      body = Buffer.from(body.toString().replace('__CSP__', csp).replace('__NONCE__', nonce));
    }
    res.writeHead(200, headers).end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer(Number(process.env.PORT ?? 4173));
  console.log(`S3 spike demo: http://127.0.0.1:${port}/?edit=1   (add &csp=strict, &stock=1, &kb=0, &cols=12 ...)`);
}

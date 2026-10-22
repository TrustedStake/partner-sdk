// Serve ONLY the mock example, its built browser modules and the existing brand asset.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const sdk = new URL('../../', import.meta.url);
const prefix = '/packages/partner-sdk/';
const files = new Map([
  [prefix + 'examples/native-ui/', new URL('index.html', import.meta.url)],
  [prefix + 'examples/native-ui/index.html', new URL('index.html', import.meta.url)],
  [prefix + 'examples/native-ui/app.mjs', new URL('app.mjs', import.meta.url)],
  [prefix + 'examples/native-ui/mock.mjs', new URL('mock.mjs', import.meta.url)],
  ['/public/TS_logo_wordmark_white.svg', new URL('assets/TS_logo_wordmark_white.svg', import.meta.url)],
  ...['browser', 'core', 'contracts', 'fees', 'signing', 'allocation', 'encoding', 'types', 'chain', 'transport', 'request-policy', 'ownership', 'exit', 'exit-api', 'exit-browser', 'exit-types', 'exit-submission'].map(name => [prefix + `dist/${name}.js`, new URL(`dist/${name}.js`, sdk)]),
]);
createServer(async (request, response) => {
  const file = files.get(new URL(request.url, 'http://127.0.0.1:4360').pathname);
  if (request.method !== 'GET' || !file) { response.writeHead(404).end(); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': file.pathname.endsWith('.html') ? 'text/html' : file.pathname.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(body);
  } catch { response.writeHead(503).end('Build the SDK before running the mock example.'); }
}).listen(4360, '127.0.0.1', () => console.log(`Mock demo: http://127.0.0.1:4360${prefix}examples/native-ui/`));

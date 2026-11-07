import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';

const root = resolve('test/e2e/harness');
const assets = new Map([
  ['/', resolve(root, 'index.html')],
  ['/harness.js', resolve(root, 'dist/harness.js')],
  ['/harness.js.map', resolve(root, 'dist/harness.js.map')],
  ['/client.js', resolve('lib/client.js')],
  ['/client.js.map', resolve('lib/client.js.map')],
]);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json' };
const server = createServer(async (request, response) => {
  const path = assets.get(new URL(request.url ?? '/', 'http://fixture.local').pathname);
  if (!path) { response.writeHead(404).end('not found'); return; }
  try {
    const info = await stat(path);
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream',
      'content-length': String(info.size), 'cache-control': 'no-store' });
    createReadStream(path).pipe(response);
  } catch { response.writeHead(500).end('fixture missing'); }
});
server.listen(4173, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));

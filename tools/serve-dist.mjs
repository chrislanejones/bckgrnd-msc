/**
 * Serve dist/ the way a static host does: plain files, no PHP, no rewrites.
 *
 *   node tools/serve-dist.mjs [port] [host]   # default 8090 on 127.0.0.1
 *
 * A request for a directory gets its index.html. Anything else that isn't a file is
 * a 404, so an accidental /api call shows up exactly as it would on Netlify.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

const dist = resolve(import.meta.dirname, '..', 'dist');
const port = Number(process.argv[2] ?? 8090);
const host = process.argv[3] ?? '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ts': 'text/plain',
};

createServer((req, res) => {
  let path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (path !== dist && !path.startsWith(dist + sep)) { res.writeHead(403).end(); return; }
  if (existsSync(path) && statSync(path).isDirectory()) path = resolve(path, 'index.html');
  if (!existsSync(path) || !statSync(path).isFile()) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, {
    'Content-Type': types[extname(path)] ?? 'application/octet-stream',
    'Cache-Control': 'public, max-age=0, must-revalidate',
  });
  createReadStream(path).pipe(res);
}).listen(port, host, () => console.log(`[serve-dist] http://${host}:${port}/`));

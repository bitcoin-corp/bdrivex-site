// Local preview of the static site with Vercel's cleanUrls and the /s/:id rewrite. Binds 127.0.0.1 only.
//   node scripts/dev.mjs   -> http://127.0.0.1:5173
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const isFile = async (p) => { try { return (await stat(p)).isFile(); } catch { return false; } };

createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (/^\/s\/[^/]+$/.test(p)) p = '/s';
  if (p.endsWith('/')) p += 'index';
  let f = normalize(join(root, p));
  if (!f.startsWith(root) || /\/(scripts|\.git|node_modules)(\/|$)/.test(f)) { res.writeHead(404); return res.end('Not found'); }
  if (!extname(f) && (await isFile(f + '.html'))) f += '.html';
  if (!(await isFile(f))) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(await readFile(f));
}).listen(5173, '127.0.0.1', () => console.log('bdrivex-site on http://127.0.0.1:5173'));

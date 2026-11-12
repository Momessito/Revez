// Deliberately independent of server.mjs: no database, providers or API implementation.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve('public');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
createServer(async (req, res) => {
  res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const pathname = new URL(req.url, 'http://127.0.0.1:8796').pathname;
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) { res.writeHead(501); res.end('API is never available in the static test server.'); return; }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
  try { const data = await readFile(file); res.writeHead(200, { 'content-type': `${mime[extname(file)] || 'application/octet-stream'}; charset=utf-8` }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
}).listen(8796, '127.0.0.1');

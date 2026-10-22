#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * Serve the built demo locally, the way GitHub Pages will.
 *
 *   node demo/serve.mjs [--dir docs] [--port 8080] [--base /OpenPanopticon/] [--open]
 *
 * A plain static file server and nothing more: no /api, no server.js, so
 * what works here works on Pages. The site is served under --base, as Pages
 * serves a project site under /<repo>/; the root redirects there. Use
 * --base / to serve it at the root instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  // Served as-is, like Pages: the demo unzips vector tiles itself.
  '.gz': 'application/gzip', '.pbf': 'application/x-protobuf',
};

/** Start serving `dir` under `base`. Resolves to { url, server, close }. */
export function serveDir({ dir, port = 8080, host = '127.0.0.1', base = '/OpenPanopticon/' }) {
  const root = path.resolve(dir);
  const prefix = `/${String(base).replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');

  const server = http.createServer((req, res) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch {
      res.writeHead(400).end('bad request'); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (prefix !== '/' && (pathname === '/' || pathname === prefix.slice(0, -1))) {
      res.writeHead(302, { Location: prefix }).end();
      return;
    }
    if (!pathname.startsWith(prefix)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }

    let rel = pathname.slice(prefix.length);
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, rel);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }

    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const p = server.address().port;
      resolve({
        url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${p}${prefix}`,
        server,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true })
      .on('error', () => {}).unref();
  } catch { /* no browser to open; the URL is printed */ }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const o = { dir: path.join(ROOT, 'docs'), port: 8080, base: '/OpenPanopticon/', open: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = path.resolve(argv[++i]);
    else if (a === '--port') o.port = Number(argv[++i]);
    else if (a === '--base') o.base = argv[++i];
    else if (a === '--open') o.open = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(4, 12)
        .map((l) => l.replace(/^ \* ?/, '')).join('\n'));
      process.exit(0);
    } else { console.error(`unknown argument: ${a}`); process.exit(2); }
  }
  if (!fs.existsSync(path.join(o.dir, 'index.html')) || !fs.existsSync(path.join(o.dir, 'demo', 'manifest.js'))) {
    console.error(`\n  No built demo in ${o.dir}. Run "node demo/build.mjs" (after demo/capture.mjs) first.\n`);
    process.exit(1);
  }
  serveDir(o).then(({ url }) => {
    console.log(`\n  Serving ${o.dir}\n  ▸ ${url}\n\n  Ctrl+C to stop.\n`);
    if (o.open) openBrowser(url);
  }).catch((e) => {
    console.error(`\n  Could not listen on port ${o.port}: ${e.message}${e.code === 'EADDRINUSE' ? ' (try --port 8081)' : ''}\n`);
    process.exit(1);
  });
}

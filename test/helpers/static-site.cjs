// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * A bare static file server, standing in for GitHub Pages: one folder served
 * under a sub-path (as https://<user>.github.io/<repo>/ is), nothing else,
 * and no server-side logic of any kind. Requests it saw are kept, so a test
 * can check the demo never asked for /api/*.
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.gz': 'application/gzip', '.pbf': 'application/octet-stream',
};

function serveStatic(dir, { prefix = '/OpenPanopticon/' } = {}) {
  const seen = [];
  const root = path.resolve(dir);
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push(url.pathname);
    if (!url.pathname.startsWith(prefix)) { res.writeHead(404).end('not found'); return; }
    let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(body);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    resolve({
      base: `http://127.0.0.1:${port}${prefix.replace(/\/$/, '')}`,
      seen,
      close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }),
    });
  }));
}

module.exports = { serveStatic };

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { serveDir } from '../../demo/serve.mjs';

/** Raw GET, so paths like /../ reach the server unnormalised. */
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

describe('demo/serve.mjs', () => {
  let dir;
  let s;
  let port;
  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-serve-'));
    fs.mkdirSync(path.join(dir, 'data', 'tiles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), '<title>x</title>');
    fs.writeFileSync(path.join(dir, 'data', 'tiles', '1.pbf.gz'), Buffer.from([0x1f, 0x8b, 1, 2]));
    fs.writeFileSync(path.join(os.tmpdir(), 'op-serve-outside.txt'), 'secret');
    s = await serveDir({ dir, port: 0, base: '/OpenPanopticon/' });
    port = s.server.address().port;
  });
  after(async () => {
    await s?.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), 'op-serve-outside.txt'), { force: true });
  });

  test('serves the site under the Pages-style sub-path', async () => {
    assert.equal(s.url, `http://127.0.0.1:${port}/OpenPanopticon/`);
    const r = await get(port, '/OpenPanopticon/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.equal(r.body.toString(), '<title>x</title>');
  });

  test('the root and the bare prefix redirect to it', async () => {
    for (const p of ['/', '/OpenPanopticon']) {
      const r = await get(port, p);
      assert.equal(r.status, 302, p);
      assert.equal(r.headers.location, '/OpenPanopticon/');
    }
  });

  test('gzipped tiles go out as stored, with no Content-Encoding', async () => {
    const r = await get(port, '/OpenPanopticon/data/tiles/1.pbf.gz');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-encoding'], undefined);
    assert.deepEqual([...r.body], [0x1f, 0x8b, 1, 2]);
  });

  test('nothing outside the folder, and no /api', async () => {
    for (const p of ['/OpenPanopticon/../op-serve-outside.txt', '/OpenPanopticon/%2e%2e/op-serve-outside.txt', '/api/health', '/OpenPanopticon/nope.js']) {
      const r = await get(port, p);
      assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
      assert.doesNotMatch(r.body.toString(), /secret/);
    }
  });

  test('--base / serves at the root', async () => {
    const t = await serveDir({ dir, port: 0, base: '/' });
    try {
      const r = await get(t.server.address().port, '/');
      assert.equal(r.status, 200);
      assert.equal(t.url.endsWith(':' + t.server.address().port + '/'), true);
    } finally { await t.close(); }
  });
});

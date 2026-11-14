// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../helpers/harness.cjs');
const { UpstreamMock } = require('../helpers/upstream.cjs');
const { png, status } = require('../helpers/responses.cjs');

const BING = 'http://ecn.t1.tiles.virtualearth.net/tiles/a0320120020.jpeg?n=z&g=15648';
const OSM = 'https://tile.openstreetmap.org/5/9/12.png';
const tileUrl = (u) => `/tiles/cache?u=${encodeURIComponent(u)}`;

describe('map tile disk cache', () => {
  let s;
  const mock = new UpstreamMock({ defaults: false });
  before(async () => { s = await startServer({ mock }); });
  after(() => s.close());
  beforeEach(() => { mock.reset(); mock.routes = []; });

  test('Esri Wayback tiles are cached; other paths on that host are refused', async () => {
    mock.on('wayback.maptiles.arcgis.com', () => png());
    const ok = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/90/12/1600/900';
    assert.equal((await s.request(tileUrl(ok))).status, 200);
    assert.equal((await s.request(tileUrl(ok))).headers['x-tile-cache'], 'hit');
    const bad = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap/90/12/1600/900';
    assert.notEqual((await s.request(tileUrl(bad))).status, 200);
  });

  test('fetches a tile once, then serves it from disk', async () => {
    mock.on('virtualearth.net', () => png());
    const a = await s.request(tileUrl(BING));
    assert.equal(a.status, 200);
    assert.equal(a.headers['content-type'], 'image/png');
    assert.equal(a.headers['x-tile-cache'], 'miss');
    const b = await s.request(tileUrl(BING));
    assert.equal(b.status, 200);
    assert.equal(b.headers['x-tile-cache'], 'hit');
    assert.deepEqual(b.buffer, a.buffer);
    assert.equal(mock.calls.filter((c) => String(c.url).includes('virtualearth')).length, 1);
  });

  test('stores "nothing here" too, so empty tiles are not re-asked', async () => {
    const u = 'https://tile.openstreetmap.org/2/1/1.png';
    mock.on('openstreetmap.org', () => status(404));
    assert.equal((await s.request(tileUrl(u))).status, 404);
    assert.equal((await s.request(tileUrl(u))).headers['x-tile-cache'], 'hit');
    assert.equal(mock.calls.length, 1);
  });

  test('an upstream error is passed on and not stored', async () => {
    const u = 'https://tile.openstreetmap.org/3/1/1.png';
    mock.fail('openstreetmap.org', 503);
    assert.equal((await s.request(tileUrl(u))).status, 503);
    mock.routes = [];
    mock.on('openstreetmap.org', () => png());
    const r = await s.request(tileUrl(u));
    assert.equal(r.status, 200);
    assert.equal(r.headers['x-tile-cache'], 'miss');
  });

  test('refuses anything that is not a known tile source', async () => {
    for (const u of [
      'https://example.com/1/2/3.png',
      'https://tile.openstreetmap.org/../../etc/passwd',
      'https://tile.openstreetmap.org/admin',
      'file:///etc/passwd',
      'https://user:pw@tile.openstreetmap.org/1/1/1.png',
      'not a url',
    ]) {
      assert.equal((await s.request(tileUrl(u))).status, 400, u);
    }
    assert.equal(mock.calls.length, 0);
  });

  test('refuses requests from other sites', async () => {
    const r = await s.request(tileUrl(OSM), { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
  });

  test('refuses a response that is not a tile', async () => {
    mock.on('openstreetmap.org', () => ({ __response: true, status: 200, body: '<html>', headers: { 'content-type': 'text/html' } }));
    assert.equal((await s.request(tileUrl('https://tile.openstreetmap.org/4/1/1.png'))).status, 502);
  });

  test('a tile older than a month is deleted when read, and fetched again', async () => {
    const u = 'https://tile.openstreetmap.org/6/1/1.png';
    mock.on('openstreetmap.org', () => png());
    await s.request(tileUrl(u));
    const file = s.mod.tileFile(`tile:${u}`);
    const past = (Date.now() - s.mod.TILE_MAX_AGE - 60_000) / 1000;
    fs.utimesSync(file, past, past);
    const r = await s.request(tileUrl(u));
    assert.equal(r.headers['x-tile-cache'], 'miss');
    assert.ok(fs.statSync(file).mtimeMs > Date.now() - 60_000, 'replaced with a fresh copy');
  });

  test('pruneTileCache() removes expired tiles and leftovers, keeps the rest', async () => {
    const S = s.mod;
    await S.writeTile('prune:old', { status: 200, type: 'image/png', body: Buffer.from('a') });
    await S.writeTile('prune:new', { status: 200, type: 'image/png', body: Buffer.from('b') });
    const old = S.tileFile('prune:old');
    const past = (Date.now() - S.TILE_MAX_AGE - 60_000) / 1000;
    fs.utimesSync(old, past, past);
    const stale = path.join(path.dirname(old), 'x.tile.1.y.tmp');
    fs.writeFileSync(stale, 'half');
    fs.utimesSync(stale, past, past);

    const r = await S.pruneTileCache();
    assert.ok(r.removed >= 2);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(stale), false);
    assert.equal((await S.readTile('prune:new')).body.toString(), 'b');
  });

  test('pruneTileCache() drops the oldest tiles beyond the size cap', async () => {
    const S = s.mod;
    const big = Buffer.alloc(1000);
    for (let i = 0; i < 5; i++) {
      await S.writeTile(`cap:${i}`, { status: 200, type: 'image/png', body: big });
      const t = (Date.now() - (10 - i) * 60_000) / 1000;      // cap:0 oldest
      fs.utimesSync(S.tileFile(`cap:${i}`), t, t);
    }
    await S.pruneTileCache({ maxBytes: 0 });   // everything else goes too
    for (let i = 0; i < 5; i++) assert.equal(fs.existsSync(S.tileFile(`cap:${i}`)), false);
  });

  test('/api/config lists the hosts to send through the cache', async () => {
    const cfg = (await s.api('/api/config')).json();
    assert.ok(cfg.tileCache.hosts.includes('ecn.t0.tiles.virtualearth.net'));
    assert.ok(cfg.tileCache.hosts.includes('tile.openstreetmap.org'));
    assert.ok(!cfg.tileCache.hosts.some((h) => /rainviewer/.test(h)), 'radar frames are not cached for a month');
  });
});

describe('tile ports', () => {
  const { request } = require('../helpers/harness.cjs');
  let s;
  let tp;
  const mock = new UpstreamMock({ defaults: false });
  before(async () => {
    s = await startServer({ mock, env: { TILE_PORTS: '1' } });
    await s.mod.startTilePorts();
    tp = s.mod.tilePortsLive[0];
  });
  after(async () => {
    await s.mod.stopTilePorts();
    await s.close();
  });
  beforeEach(() => { mock.reset(); mock.routes = []; });

  const own = () => ({ Origin: `http://127.0.0.1:${s.port}` });

  test('opens the next port and says so in /api/config', async (t) => {
    if (!tp) return t.skip('port in use on this machine');
    assert.equal(tp, s.port + 1);
    assert.deepEqual((await s.api('/api/config')).json().tileCache.ports, [tp]);
  });

  test('serves tiles to the app, with CORS for its origin', async (t) => {
    if (!tp) return t.skip('port in use on this machine');
    mock.on('openstreetmap.org', () => png());
    const r = await request(tp, tileUrl('https://tile.openstreetmap.org/7/1/1.png'), { headers: own() });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], `http://127.0.0.1:${s.port}`);
    assert.equal((await request(tp, '/tiles/ping', { headers: own() })).status, 204);
  });

  test('refuses other pages, and anything but tiles', async (t) => {
    if (!tp) return t.skip('port in use on this machine');
    const u = tileUrl('https://tile.openstreetmap.org/7/1/2.png');
    assert.equal((await request(tp, u)).status, 403, 'no origin');
    assert.equal((await request(tp, u, { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await request(tp, '/api/config', { headers: { ...own(), 'X-Panopticon': '1' } })).status, 404);
    assert.equal((await request(tp, '/index.html', { headers: own() })).status, 404);
    assert.equal((await request(tp, u, { headers: own(), host: `evil.example:${tp}` })).status, 421);
  });

  test('the page may load from the tile port', async (t) => {
    if (!tp) return t.skip('port in use on this machine');
    const csp = (await s.request('/')).headers['content-security-policy'];
    assert.match(csp, new RegExp(`img-src 'self' http://127\\.0\\.0\\.1:${tp}`));
    assert.match(csp, new RegExp(`connect-src 'self' http://127\\.0\\.0\\.1:${tp}`));
  });
});

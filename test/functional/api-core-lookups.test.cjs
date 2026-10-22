// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { startServer } = require('../helpers/harness.cjs');
const { TEST_KEYS, HOME } = require('../helpers/fixtures.cjs');
const { json, status, PNG_1PX } = require('../helpers/responses.cjs');

const BBOX = '34.95,-100.05,35.05,-99.95';

let s;
before(async () => { s = await startServer({ env: TEST_KEYS }); });
after(() => s.close());
beforeEach(async () => { s.mock.reset(); s.mod.cache.clear(); s.mod.cartoCache.clear(); await s.mod.clearDiskCache(); });

describe('/api/health', () => {
  test('reports every source and the UI presets, and no version', async () => {
    const d = (await s.api('/api/health')).json();
    assert.equal(d.ok, true);
    assert.equal('version' in d, false);
    assert.equal('node' in d, false);
    assert.equal(d.sources.shodan, 'configured');
    assert.equal(d.sources.opensky, 'authenticated');
    assert.match(d.sources.ais, /^configured \(stream: /);
    assert.equal(d.sources.fiveEleven, 'configured: GA');
    assert.equal(d.sources.censys, undefined, 'Censys was removed');
    for (const k of ['shodan', 'overpass', 'satellites', 'basemaps', 'alprVendors', 'netinfra', 'imagery', 'fiveElevenHosts', 'events']) {
      assert.ok(d.presets[k], k);
    }
    assert.equal(d.presets.events.firms.available, true);
    assert.equal(d.presets.events.edis.available, false);
  });

  test('says plainly what is missing when nothing is configured', async () => {
    const t = await startServer();
    try {
      const d = (await t.api('/api/health')).json();
      assert.equal(d.sources.shodan, 'missing SHODAN_API_KEY');
      assert.match(d.sources.opensky, /^anonymous/);
      assert.equal(d.sources.ais, 'missing AISSTREAM_API_KEY');
      assert.equal(d.sources.fiveEleven, 'no states in FIVE_ELEVEN_KEYS');
      assert.equal(d.presets.netinfra.cell.available, false);
      assert.equal(d.presets.netinfra.atlas.available, true);
      const bm = Object.fromEntries(d.presets.basemaps.map((b) => [b.key, b.available]));
      assert.deepEqual(bm, { osm: true, cesium: false, shortbread: true, sentinel2: true, gee: false });
    } finally { await t.close(); }
  });
});

describe('/api/config', () => {
  test('only what the browser needs: the Ion token and whether labels can be drawn', async () => {
    assert.deepEqual((await s.api('/api/config')).json(), { cesiumIonToken: null, cartoLabels: true });
    const t = await startServer();
    try {
      assert.deepEqual((await t.api('/api/config')).json(), { cesiumIonToken: null, cartoLabels: false });
    } finally { await t.close(); }
  });
});

describe('/api/geoip', () => {
  test('where this machine is, without its IP address', async () => {
    const d = (await s.api('/api/geoip')).json();
    assert.equal(d.lat, HOME.lat);
    assert.equal(d.lon, HOME.lon);
    assert.equal(d.label, 'Testville, Test State, Testland');
    assert.equal(d.isp, 'Test ISP');
    assert.equal(d.timezone, 'America/Chicago');
    assert.ok(!JSON.stringify(d).includes('192.0.2.1'), 'public IP is not passed on');
  });

  test('held in memory, never written to disk', async () => {
    await s.api('/api/geoip');
    await s.api('/api/geoip');
    assert.equal(s.mock.callsTo('ipwho.is').length, 1);
    const onDisk = fs.existsSync(s.mod.DISK_CACHE_DIR) ? fs.readdirSync(s.mod.DISK_CACHE_DIR)
      .map((f) => fs.readFileSync(`${s.mod.DISK_CACHE_DIR}/${f}`, 'utf8')).join('') : '';
    assert.ok(!onDisk.includes('Testville'), 'geoIP answer must not be persisted');
    const ttl = s.mod.cache.get('geoip').expires - Date.now();
    assert.ok(ttl <= 30 * 60_000 && ttl > 29 * 60_000);
  });

  test('fresh=1 (the Geolocate button) asks again', async () => {
    await s.api('/api/geoip');
    await s.api('/api/geoip', { fresh: 1 });
    assert.equal(s.mock.callsTo('ipwho.is').length, 2);
  });

  test('a failed lookup is a 502 with the reason', async () => {
    s.mock.on('ipwho.is', () => json({ success: false, message: 'reserved range' }));
    const r = await s.api('/api/geoip');
    assert.equal(r.status, 502);
    assert.match(r.json().error, /reserved range/);
  });
});

describe('/api/route and /api/aircraft (adsbdb)', () => {
  test('a known callsign resolves to airline and airports', async () => {
    const d = (await s.api('/api/route', { callsign: ' tst-123 ' })).json();
    assert.equal(d.callsign, 'TST123');
    assert.equal(d.known, true);
    assert.equal(d.airline.name, 'Test Air');
    assert.equal(d.origin.iata, 'AAA');
    assert.equal(d.destination.city, 'Bravotown');
    assert.equal(d.midpoint, null);
  });

  test('an unknown callsign is an ordinary "not known", not an error', async () => {
    const r = await s.api('/api/route', { callsign: 'ZZZ999' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { callsign: 'ZZZ999', known: false });
  });

  test('schedules are keyed by date as well as callsign', async () => {
    await s.api('/api/route', { callsign: 'TST123' });
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(s.mod.cache.has(`route:TST123:${day}`));
  });

  test('a short callsign is rejected', async () => {
    assert.equal((await s.api('/api/route', { callsign: 'ab' })).status, 400);
  });

  test('airframe lookup, with a filtered photo URL', async () => {
    const d = (await s.api('/api/aircraft', { icao24: 'A1B2C3' })).json();
    assert.equal(d.registration, 'N12345');
    assert.equal(d.icaoType, 'B738');
    assert.equal(d.photo, 'https://photos.example/a1b2c3.jpg');
    s.mock.on('/v0/aircraft/', () => json({ response: { aircraft: { registration: 'X', url_photo_thumbnail: 'javascript:alert(1)' } } }));
    s.mod.cache.clear(); await s.mod.clearDiskCache();
    assert.equal((await s.api('/api/aircraft', { icao24: 'a1b2c3' })).json().photo, null);
  });

  test('unknown airframes and bad hex', async () => {
    assert.deepEqual((await s.api('/api/aircraft', { icao24: 'ffffff' })).json(), { icao24: 'ffffff', known: false });
    assert.equal((await s.api('/api/aircraft', { icao24: 'xyz' })).status, 400);
  });

  test('other adsbdb errors are passed on', async () => {
    s.mock.fail('api.adsbdb.com', 500);
    assert.equal((await s.api('/api/route', { callsign: 'TST123' })).status, 500);
  });
});

describe('/api/weather', () => {
  test('radar frames (past and nowcast) and a working cloud source', async () => {
    const d = (await s.api('/api/weather')).json();
    assert.equal(d.radar.available, true);
    assert.equal(d.radar.maxLevel, 7);
    assert.equal(d.radar.frames.length, 3);
    assert.deepEqual(d.radar.frames.map((f) => f.nowcast), [false, false, true]);
    assert.equal(d.radar.frames[0].url, 'https://tilecache.rainviewer.com/v2/radar/1/512/{z}/{x}/{y}/4/1_1.png');
    assert.equal(d.satellite.available, false);
    assert.equal(d.clouds.source, 'gibs');
  });

  test('is cached briefly', async () => {
    await s.api('/api/weather');
    await s.api('/api/weather');
    assert.equal(s.mock.callsTo('rainviewer').length, 1);
  });
});

describe('/api/imagery (NASA GIBS)', () => {
  test('lists the layers and builds the selected template', async () => {
    const d = (await s.api('/api/imagery', { layer: 'MODIS_Terra_Land_Surface_Temp_Day', date: '2026-10-01' })).json();
    assert.equal(d.layers.length, s.mod.GIBS_LAYERS.length);
    assert.equal(d.selected.layer, 'MODIS_Terra_Land_Surface_Temp_Day');
    assert.equal(d.selected.date, '2026-10-01');
    assert.equal(d.defaultDate, s.mod.gibsDefaultDate());
  });

  test('a bad date or layer falls back to the defaults', async () => {
    const d = (await s.api('/api/imagery', { layer: 'x', date: 'tomorrow' })).json();
    assert.equal(d.selected.layer, 'VIIRS_SNPP_CorrectedReflectance_TrueColor');
    assert.equal(d.selected.date, d.defaultDate);
  });
});

describe('/api/basemap', () => {
  test('Sentinel-2: newest first, clearest flagged, scenes without imagery dropped', async () => {
    const d = (await s.api('/api/basemap', { provider: 'sentinel2', bbox: BBOX, from: '2026-10-01', to: '2026-10-20', maxCloud: '30' })).json();
    assert.equal(d.provider, 'sentinel2');
    assert.equal(d.returned, 2);
    assert.equal(d.matched, 3);
    assert.equal(d.clearest, 'S2B_TEST_2');
    assert.deepEqual(d.window, { from: '2026-10-01', to: '2026-10-20', maxCloud: 30 });
    assert.match(d.scenes[0].url, /\/cog\/tiles\/WebMercatorQuad\/\{z\}\/\{x\}\/\{y\}\.png\?url=https%3A%2F%2Fsentinel-cogs/);
    assert.equal(d.scenes[1].tile, 'G2');
    const body = JSON.parse(s.mock.callsTo('earth-search')[0].body);
    assert.deepEqual(body.collections, ['sentinel-2-l2a']);
    assert.deepEqual(body.query, { 'eo:cloud_cover': { lt: 30 } });
    assert.equal(body.datetime, '2026-10-01T00:00:00Z/2026-10-20T23:59:59Z');
  });

  test('Sentinel-2 defaults to the last 30 days at 40% cloud, and needs a bbox', async () => {
    const d = (await s.api('/api/basemap', { bbox: BBOX })).json();
    assert.equal(d.window.maxCloud, 40);
    const days = (Date.parse(d.window.to) - Date.parse(d.window.from)) / 86400_000;
    assert.equal(days, 30);
    assert.equal((await s.api('/api/basemap', { provider: 'sentinel2' })).status, 400);
  });

  test('builtins and the vector map', async () => {
    assert.equal((await s.api('/api/basemap', { provider: 'osm' })).json().url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
    const sb = (await s.api('/api/basemap', { provider: 'shortbread' })).json();
    assert.equal(sb.vector, true);
    assert.equal(sb.maxLevel, 14);
    assert.match(sb.url, /versatiles\.org/);
  });

  test('Cesium aerial needs an Ion token', async () => {
    const r = await s.api('/api/basemap', { provider: 'cesium' });
    assert.equal(r.status, 501);
    const t = await startServer({ env: { CESIUM_ION_TOKEN: 'ion' } });
    try {
      assert.equal((await t.api('/api/basemap', { provider: 'cesium' })).json().builtin, true);
    } finally { await t.close(); }
  });

  test('Earth Engine: 501 until configured, then a signed service-account flow', async () => {
    assert.equal((await s.api('/api/basemap', { provider: 'gee', bbox: BBOX })).status, 501);
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n');
    const t = await startServer({ env: { GEE_PROJECT: 'test-project', GEE_CLIENT_EMAIL: 'sa@test.iam', GEE_PRIVATE_KEY: pem } });
    try {
      const d = (await t.api('/api/basemap', { provider: 'gee', bbox: BBOX })).json();
      assert.equal(d.provider, 'gee');
      assert.equal(d.composite.url, 'https://earthengine.googleapis.com/v1/projects/test-project/maps/abc123/tiles/{z}/{x}/{y}');
      const tok = t.mock.callsTo('oauth2.googleapis.com')[0];
      const assertion = new URLSearchParams(tok.body).get('assertion');
      const parts = assertion.split('.');
      const [h, c] = parts.slice(0, 2).map((p) => JSON.parse(Buffer.from(p, 'base64url').toString()));
      assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey,
        Buffer.from(parts[2], 'base64url')), 'JWT signature verifies');
      assert.equal(h.alg, 'RS256');
      assert.equal(c.iss, 'sa@test.iam');
      assert.match(c.scope, /earthengine\.readonly/);
      const maps = t.mock.callsTo('earthengine.googleapis.com')[0];
      assert.equal(maps.headers.authorization, 'Bearer ya29.test');
      assert.ok(JSON.parse(maps.body).expression.values.out);
      assert.equal((await t.api('/api/health')).json().sources.earthengine, 'configured');
    } finally { await t.close(); }
  });

  test('an unknown provider is a 400', async () => {
    assert.equal((await s.api('/api/basemap', { provider: 'bing' })).status, 400);
  });
});

describe('/api/geocode (Nominatim)', () => {
  test('maps results, with the bounding box reordered to s,w,n,e', async () => {
    const d = (await s.api('/api/geocode', { q: 'Testville' })).json();
    assert.equal(d.results.length, 2);
    assert.deepEqual(d.results[0].bbox, [34.9, -100.1, 35.1, -99.9]);
    assert.equal(d.results[0].short, 'Testville');
    assert.equal(d.results[1].short, 'Test Lake', 'falls back to the first part of the display name');
    assert.equal(d.results[1].bbox, null);
    assert.match(s.mock.callsTo('nominatim')[0].headers['user-agent'], /OpenPanopticon/);
  });

  test('cached case-insensitively', async () => {
    await s.api('/api/geocode', { q: 'Testville' });
    await s.api('/api/geocode', { q: 'TESTVILLE' });
    assert.equal(s.mock.callsTo('nominatim').length, 1);
  });

  test('no results, and too-short queries', async () => {
    assert.deepEqual((await s.api('/api/geocode', { q: 'nowhere at all' })).json(), { results: [] });
    assert.equal((await s.api('/api/geocode', { q: 'a' })).status, 400);
  });
});

describe('/api/flush', () => {
  test('empties memory and disk and says how much', async () => {
    await s.api('/api/shodan', { bbox: BBOX });
    await s.api('/api/geocode', { q: 'Testville' });
    const d = (await s.api('/api/flush', {}, { method: 'POST' })).json();
    assert.equal(d.ok, true);
    assert.ok(d.memoryEntries >= 2);
    assert.ok(d.diskEntries >= 2);
    assert.equal(s.mod.cache.size, 0);
    await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(s.mock.callsTo('/shodan/host/search').length, 2, 'refetched after the flush');
  });
});

describe('/tiles/carto (label tiles proxy)', () => {
  test('proxies with the key, which never reaches the browser', async () => {
    const r = await s.request('/tiles/carto/dark_only_labels/5/7/12.png');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/png');
    assert.deepEqual(r.buffer, PNG_1PX);
    assert.match(r.headers['cache-control'], /max-age=86400/);
    const call = s.mock.callsTo('basemaps.cartocdn.com')[0];
    const u = new URL(call.url);
    assert.equal(u.hostname, `${'abcd'[(7 + 12) % 4]}.basemaps.cartocdn.com`);
    assert.equal(u.pathname, '/dark_only_labels/5/7/12.png');
    assert.equal(u.searchParams.get('key'), TEST_KEYS.CARTO_API_KEY);
  });

  test('sends only this server\'s origin as the Referer', async () => {
    await s.request('/tiles/carto/light_only_labels/3/1/2@2x.png', { headers: { Referer: `http://127.0.0.1:${s.port}/some/page?secret=1` } });
    const call = s.mock.callsTo('basemaps.cartocdn.com')[0];
    assert.equal(call.headers.referer, `http://127.0.0.1:${s.port}/`);
    assert.match(call.url, /@2x\.png/);
  });

  test('keeps an in-memory LRU, so repeat tiles cost nothing', async () => {
    await s.request('/tiles/carto/dark_only_labels/5/7/12.png');
    await s.request('/tiles/carto/dark_only_labels/5/7/12.png');
    assert.equal(s.mock.callsTo('basemaps.cartocdn.com').length, 1);
  });

  test('only label sets and sane coordinates match the route', async () => {
    for (const p of ['/tiles/carto/voyager/5/7/12.png', '/tiles/carto/dark_only_labels/5/7/12.jpg', '/tiles/carto/dark_only_labels/../../server.js']) {
      const r = await s.request(p);
      assert.notEqual(r.status, 200, p);
    }
    assert.equal(s.mock.callsTo('basemaps.cartocdn.com').length, 0);
  });

  test('a failing upstream is an error response, not a crash', async () => {
    s.mock.fail('basemaps.cartocdn.com', 403, 'API KEY REQUIRED');
    const r = await s.request('/tiles/carto/dark_only_labels/1/1/1.png');
    assert.equal(r.status, 403);
  });

  test('without a key: 503 and no upstream call', async () => {
    const t = await startServer();
    try {
      const r = await t.request('/tiles/carto/dark_only_labels/5/7/12.png');
      assert.equal(r.status, 503);
      assert.match(r.text, /CARTO_API_KEY/);
      assert.equal(t.mock.calls.length, 0);
    } finally { await t.close(); }
  });
});

describe('error handling', () => {
  test('an upstream timeout becomes a 504 naming the source', async () => {
    s.mock.unreachable('ipwho.is');
    const r = await s.api('/api/geoip');
    assert.equal(r.status, 504);
    assert.deepEqual(Object.keys(r.json()).sort(), ['detail', 'error', 'retryAfter', 'source']);
    assert.equal(r.json().source, '/api/geoip');
  });

  test('retryAfter from the upstream reaches the browser', async () => {
    s.mock.on('ipwho.is', () => status(429, '', { 'retry-after': '45' }));
    assert.equal((await s.api('/api/geoip')).json().retryAfter, 45);
  });

  test('nothing unmocked was requested during this file', () => {
    assert.deepEqual(s.mock.unmatched, []);
  });
});

describe('persistence across a restart', () => {
  test('a second server on the same data directory reuses paid-for answers', async () => {
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power' });
    const { startServer: start } = require('../helpers/harness.cjs');
    const t = await start({ env: TEST_KEYS });
    try {
      fs.mkdirSync(t.mod.DISK_CACHE_DIR, { recursive: true });
      for (const f of fs.readdirSync(s.mod.DISK_CACHE_DIR)) fs.copyFileSync(`${s.mod.DISK_CACHE_DIR}/${f}`, `${t.mod.DISK_CACHE_DIR}/${f}`);
      const d = (await t.api('/api/overpass', { bbox: BBOX, presets: 'power' })).json();
      assert.equal(d.count, 1);
      assert.equal(t.mock.callsTo('overpass').length, 0);
    } finally { await t.close(); }
  });
});

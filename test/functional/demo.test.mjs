// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * The static demo, end to end without a browser: capture a snapshot from the
 * fake upstreams, build the site, then load the demo runtime in a sandbox and
 * ask it what the page would ask the server.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { capture, REGION } from '../../demo/capture.mjs';
import { build } from '../../demo/build.mjs';

const SITE = 'http://demo.test/OpenPanopticon/';
const quiet = () => {};

let out;
let manifest;
let win;

/** Load demo.js the way the page does, with just enough of a browser around it. */
function loadRuntime(dir) {
  const stores = new Map();
  class Storage {
    constructor() { stores.set(this, new Map()); }
    getItem(k) { return stores.get(this).has(k) ? stores.get(this).get(k) : null; }
    setItem(k, v) { stores.get(this).set(k, String(v)); }
    removeItem(k) { stores.get(this).delete(k); }
  }
  const requested = [];
  const fetchFile = async (input) => {
    const u = new URL(String(input));
    requested.push(u.pathname);
    const rel = decodeURIComponent(u.pathname.replace('/OpenPanopticon/', ''));
    try {
      return new Response(fs.readFileSync(path.join(dir, rel)), { status: 200 });
    } catch { return new Response('not found', { status: 404 }); }
  };
  const sandbox = {
    console, URL, Response, Blob, DecompressionStream, Proxy, setTimeout, clearTimeout,
    Uint8Array, JSON, Math, Number, String, Object, Array, Promise, Map, Set, RegExp, Error, Date, Intl,
    Storage, localStorage: null,
    location: { href: `${SITE}index.html`, origin: 'http://demo.test' },
    document: {
      baseURI: `${SITE}index.html`, readyState: 'loading',
      addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    },
    fetch: fetchFile,
  };
  sandbox.window = sandbox;
  sandbox.localStorage = new Storage();
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, 'demo', 'manifest.js'), 'utf8'), sandbox);
  vm.runInContext(fs.readFileSync(path.join(dir, 'demo', 'demo.js'), 'utf8'), sandbox);
  sandbox.requested = requested;
  return sandbox;
}

const box = (b) => [b.south, b.west, b.north, b.east].join(',');
const ALL = box(REGION);
const NOWHERE = '10,10,10.5,10.5';

async function get(p, params = {}, init) {
  const u = new URL(p, 'http://demo.test');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await win.fetch(u, init);
  return { status: r.status, body: await r.json() };
}

before(async () => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'op-demo-'));
  manifest = await capture({ out, fixtures: true, tiles: true, aisWait: 0 }, quiet);
  build({ out, env: path.join(out, 'no.env') }, quiet);
  win = loadRuntime(out);
});
after(() => fs.rmSync(out, { recursive: true, force: true }));

describe('capture (fake upstreams)', () => {
  test('every step succeeds and the manifest says where and when', () => {
    const failed = Object.entries(manifest.steps).filter(([, s]) => !s.ok).map(([k]) => k);
    assert.deepEqual(failed, []);
    assert.deepEqual(manifest.region, REGION);
    assert.equal(manifest.home.city, 'New York');
    assert.ok(Math.abs(manifest.capturedAt - Date.now()) < 3600_000);
  });

  test('region layers are merged across cells without duplicates', () => {
    for (const name of ['shodan', 'overpass', 'alpr', 'webcams', 'events', 'netinfra', 'iot', 'flights']) {
      const d = JSON.parse(fs.readFileSync(path.join(out, 'data/api/region', `${name}.json`), 'utf8'));
      assert.ok(d.items.length > 0, name);
      assert.ok(d.meta && typeof d.meta === 'object', name);
    }
  });

  test('never records the capturing machine’s own location', () => {
    const all = fs.readFileSync(path.join(out, 'data/manifest.json'), 'utf8');
    assert.doesNotMatch(all, /Testville, Test State/);
    assert.ok(!fs.existsSync(path.join(out, 'data/api/geoip.json')));
  });

  test('webcam players are dropped; only stills remain', () => {
    const d = JSON.parse(fs.readFileSync(path.join(out, 'data/api/region/webcams.json'), 'utf8'));
    for (const c of d.items) {
      assert.equal(c.embed ?? null, null);
      assert.ok(c.image == null || c.image.startsWith('data/cams/'), c.image);
    }
  });
});

describe('capture --maps-only', () => {
  test('refetches map tiles and leaves the layer data and its moment alone', async () => {
    const region = path.join(out, 'data/api/region/overpass.json');
    const before = fs.statSync(region).mtimeMs;
    const health = fs.statSync(path.join(out, 'data/api/health.json')).mtimeMs;
    const tile = path.join(out, 'data/tiles/osm/0/0/0.png');
    fs.rmSync(tile);
    const lines = [];
    const m = await capture({ out, fixtures: true, tiles: true, aisWait: 0, mapsOnly: true }, (l) => lines.push(l));
    assert.ok(fs.existsSync(tile), 'missing tile fetched again');
    assert.equal(fs.statSync(region).mtimeMs, before, 'layer data untouched');
    assert.equal(fs.statSync(path.join(out, 'data/api/health.json')).mtimeMs, health);
    assert.equal(m.capturedAt, manifest.capturedAt, 'snapshot keeps its time');
    assert.deepEqual(m.buildings, manifest.buildings);
    assert.deepEqual(Object.keys(m.steps).sort(), Object.keys(manifest.steps).sort(), 'earlier steps kept');
    const ran = lines.filter((l) => / …$/.test(l)).map((l) => l.trim().replace(/ …$/, ''));
    assert.deepEqual(ran.sort(), ['basemap', 'labels', 'satellite mosaic', 'street map']);
    build({ out, env: path.join(out, 'no.env') }, quiet);
  });
});

describe('build', () => {
  test('a static site with relative paths and the demo runtime in front', () => {
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /<title>[^<]*\(demo\)<\/title>/);
    assert.ok(html.indexOf('demo/demo.js') < html.indexOf('js/cesium-base.js'));
    assert.ok(html.indexOf('demo/manifest.js') < html.indexOf('demo/demo.js'));
    assert.doesNotMatch(html, /(src|href)="\/(?!\/)/, 'no root-absolute paths');
    for (const f of ['.nojekyll', 'js/app.js', 'providers/satellite.min.js', 'demo/demo.css']) {
      assert.ok(fs.existsSync(path.join(out, f)), f);
    }
  });

  test('refuses to finish when a value from .env ended up in the output', () => {
    const env = path.join(out, 'leak.env');
    fs.writeFileSync(env, 'SHODAN_API_KEY=test-shodan-SECRET-1111\nHOST=0.0.0.0\n');
    fs.writeFileSync(path.join(out, 'data/leak.json'), '{"k":"test-shodan-SECRET-1111"}');
    try {
      assert.throws(() => build({ out, env }, quiet), /SHODAN_API_KEY[\s\S]*data[\\/]leak\.json|data[\\/]leak\.json[\s\S]*SHODAN_API_KEY/);
    } finally {
      fs.rmSync(path.join(out, 'data/leak.json'));
      fs.rmSync(env);
    }
  });

  test('refuses to build without a snapshot', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'op-empty-'));
    try {
      assert.throws(() => build({ out: empty, env: '' }, quiet), /Run "node demo\/capture\.mjs" first/);
    } finally { fs.rmSync(empty, { recursive: true, force: true }); }
  });
});

describe('demo runtime', () => {
  test('the clock starts at the moment of capture', () => {
    const now = vm.runInContext('Date.now()', win);
    assert.ok(Math.abs(now - manifest.capturedAt) < 60_000, `${now} vs ${manifest.capturedAt}`);
    assert.ok(Math.abs(vm.runInContext('new Date().getTime()', win) - manifest.capturedAt) < 60_000);
    assert.equal(vm.runInContext('typeof Date()', win), 'string');
    assert.equal(vm.runInContext('new Date(0).getTime()', win), 0, 'explicit dates are untouched');
    assert.equal(vm.runInContext('new Date() instanceof Date', win), true);
  });

  test('health says demo, and only the captured base maps are offered', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    assert.equal(body.demo, true);
    const avail = body.presets.basemaps.filter((b) => b.available).map((b) => b.key);
    assert.deepEqual(avail, ['osm', 'shortbread', 's2cloudless']);
    const sat = body.presets.basemaps.find((b) => b.key === 's2cloudless');
    assert.match(sat.label, /^Satellite \(Sentinel-2 cloudless \d{4}\)$/);
  });

  test('raster base maps: street map and satellite mosaic come from the snapshot', async () => {
    assert.equal(manifest.osm.maxLevel, 15);
    assert.match(manifest.cloudless.attribution, /EOX IT Services GmbH \(Contains modified Copernicus Sentinel data \d{4}\)/);
    assert.ok(fs.existsSync(path.join(out, 'data/tiles/osm/0/0/0.png')));
    assert.ok(fs.existsSync(path.join(out, 'data/tiles/s2cloudless/0/0/0.jpg')));
    assert.equal(win.OP_DEMO.osmTiles.url, `${SITE}data/tiles/osm/`);
    const d = (await get('/api/basemap', { provider: 's2cloudless' })).body;
    assert.equal(d.tiles, true);
    assert.equal(d.url, `${SITE}data/tiles/s2cloudless/{z}/{x}/{y}.jpg`);
    assert.equal(d.maxLevel, 14);
    assert.match(d.attribution, /s2maps\.eu/);
  });

  test('config carries no Ion token; geoip answers New York', async () => {
    assert.equal((await get('/api/config')).body.cesiumIonToken, null);
    const g = (await get('/api/geoip')).body;
    assert.equal(g.city, 'New York');
    assert.equal(g.lat, 40.7128);
  });

  test('FLUSH and anything not a GET are refused', async () => {
    for (const [p, init] of [['/api/flush', { method: 'POST' }], ['/api/flush', undefined], ['/api/shodan', { method: 'POST' }]]) {
      const r = await get(p, {}, init);
      assert.equal(r.status, 403, p);
      assert.match(r.body.error, /static snapshot/);
    }
  });

  test('region answers are filtered to the view, with counts to match', async () => {
    const all = (await get('/api/shodan', { bbox: ALL, preset: 'all' })).body;
    assert.ok(all.matches.length > 0);
    assert.equal(all.returned, all.matches.length);
    assert.equal(Object.values(all.byCategory).reduce((a, b) => a + b, 0), all.matches.length);
    const none = (await get('/api/shodan', { bbox: NOWHERE, preset: 'all' })).body;
    assert.equal(none.matches.length, 0);
    assert.deepEqual(none.byCategory, {});

    const alpr = (await get('/api/alpr', { bbox: ALL, vendor: 'all' })).body;
    assert.equal(alpr.count, alpr.cameras.length);
    assert.equal(alpr.covered, ALL.split(',').map((v) => +(+v).toFixed(4)).join(','));
  });

  test('flights are asked for rarely, since nothing new will come', async () => {
    const f = (await get('/api/flights', { bbox: ALL })).body;
    assert.ok(f.aircraft.length > 0);
    assert.equal(f.pollSec, 3600);
  });

  test('Overpass classes are re-attributed to what was asked for', async () => {
    const d = (await get('/api/overpass', { bbox: ALL, presets: 'aviation' })).body;
    assert.deepEqual(d.presets, ['aviation']);
    assert.ok(d.features.length > 0);
    for (const f of d.features) {
      assert.equal(f.preset, 'aviation');
      assert.deepEqual(f.presets, ['aviation']);
    }
    assert.equal(d.byPreset.aviation, d.count);
    const two = (await get('/api/overpass', { bbox: ALL, presets: 'surveillance,power' })).body;
    assert.deepEqual(Object.keys(two.byPreset), ['surveillance', 'power']);
    assert.equal(two.byPreset.surveillance + two.byPreset.power, two.count);
  });

  test('events honour sources and the severity floor', async () => {
    // Hazard cells are a whole degree, so these reach past the five boroughs.
    const WIDE = '34,-101,41,-73';
    const all = (await get('/api/events', { bbox: WIDE, sources: 'firms,eonet' })).body;
    assert.ok(all.count > 1);
    assert.equal(all.count, all.events.length);
    assert.equal(all.bySource.firms + all.bySource.eonet, all.count);
    const red = (await get('/api/events', { bbox: WIDE, sources: 'firms,eonet', minSeverity: 'red' })).body;
    assert.ok(red.events.every((e) => e.severity === 'red'));
    assert.ok(red.count < all.count);
    const usgs = (await get('/api/events', { bbox: WIDE, sources: 'usgs' })).body;
    assert.deepEqual(usgs.bySource, { usgs: 0 });
  });

  test('indoor sensors only when asked for', async () => {
    const out1 = (await get('/api/iot', { bbox: ALL })).body;
    const in1 = (await get('/api/iot', { bbox: ALL, indoor: '1' })).body;
    assert.ok(in1.count > out1.count);
    assert.ok(out1.sensors.every((s) => !s.indoor));
  });

  test('satellites respect the requested limit', async () => {
    const d = (await get('/api/satellites', { group: 'stations', limit: '1' })).body;
    assert.equal(d.satellites.length, 1);
    assert.equal(d.returned, 1);
    assert.equal((await get('/api/satellites', { group: 'nope' })).status, 404);
  });

  test('tile URLs point at the snapshot, with the template left intact', async () => {
    const w = (await get('/api/weather')).body;
    assert.ok(w.radar.frames[0].url.startsWith(`${SITE}data/tiles/radar/`));
    assert.match(w.radar.frames[0].url, /\/\{z\}\/\{x\}\/\{y\}\.png$/);
    const im = (await get('/api/imagery', { layer: 'MODIS_Terra_CorrectedReflectance_TrueColor' })).body;
    assert.equal(im.selected.url, `${SITE}data/tiles/imagery/MODIS_Terra_CorrectedReflectance_TrueColor/{z}/{x}/{y}.jpg`);
    const bm = (await get('/api/basemap', { provider: 'shortbread' })).body;
    assert.equal(bm.url, `${SITE}data/tiles/shortbread/{z}/{x}/{y}.pbf`);
    assert.equal((await get('/api/basemap', { provider: 'sentinel2', bbox: ALL })).status, 404);
  });

  test('vector tiles are unzipped on the way to the map', async () => {
    const raw = Buffer.from([0x1a, 0x03, 0x0a, 0x01, 0x6c]);
    const file = path.join(out, 'data/tiles/shortbread/3/2/1.pbf.gz');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(raw));
    const r = await win.fetch(`${SITE}data/tiles/shortbread/3/2/1.pbf`);
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), raw);
    assert.equal((await win.fetch(`${SITE}data/tiles/shortbread/3/2/9.pbf`)).status, 404);
  });

  test('place search runs over captured names', async () => {
    const d = (await get('/api/geocode', { q: 'substation' })).body;
    assert.equal(d.results[0].short, 'Test Substation');
    assert.ok(Number.isFinite(d.results[0].lat));
    assert.deepEqual((await get('/api/geocode', { q: 'zzzz' })).body.results, []);
  });

  test('lookups: captured answers, or a plain "unknown"', async () => {
    const r = (await get('/api/route', { callsign: 'NOPE999' })).body;
    assert.deepEqual(r, { callsign: 'NOPE999', known: false });
    const a = (await get('/api/aircraft', { icao24: 'ffffff' })).body;
    assert.equal(a.known, false);
    assert.equal((await get('/api/enrich', { ip: '203.0.113.250' })).status, 404);
  });

  test('anything else is answered as not available, never sent anywhere', async () => {
    const before = win.requested.length;
    const r = await get('/api/no-such-route');
    assert.ok([403, 404].includes(r.status));
    assert.ok(win.requested.slice(before).every((p) => p.startsWith('/OpenPanopticon/data/')));
  });

  test('the saved session is withheld, other storage still works', () => {
    const ls = win.localStorage;
    ls.setItem('openpanopticon.settings.v1', '{"x":1}');
    assert.equal(ls.getItem('openpanopticon.settings.v1'), null);
    ls.setItem('openpanopticon.detailWidth', '420');
    assert.equal(ls.getItem('openpanopticon.detailWidth'), '420');
  });
});

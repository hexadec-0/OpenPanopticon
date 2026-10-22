#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * Capture a static snapshot of New York City for the GitHub Pages demo.
 *
 *   node demo/capture.mjs [--out docs] [--maps-only] [--no-tiles] [--ais-wait 180]
 *
 * Run this on a machine with your .env and a normal internet connection. It
 * loads server.js in-process (on a random loopback port, using your keys and
 * your providers/ cache), asks it for everything the page would ask for over
 * the five boroughs, and writes the answers as plain files under --out:
 *
 *   data/manifest.json        when and where, and what worked
 *   data/api/...              one JSON file per answer the page needs
 *   data/tiles/...            base maps (vector, OSM streets, Sentinel-2 cloudless),
 *                             radar, clouds, NASA imagery
 *   tiles/carto/...           label tiles, at the path the page expects
 *   data/cams/...             one still frame per public camera
 *   data/buildings/...        OpenStreetMap building footprints with heights
 *
 * Then `node demo/build.mjs` copies the app next to it. Re-running is cheap:
 * answers come out of the server's disk cache and tiles already on disk are
 * kept, so an interrupted capture picks up where it stopped. Delete the
 * output folder for a completely fresh snapshot.
 *
 * Never captured: your own location (the demo's home is fixed in New York),
 * and anything from .env. The build step scans for your key values and
 * refuses to finish if one turns up.
 *
 * --maps-only fetches the map tiles only (vector, street and satellite base
 * maps and the labels) and leaves the layer data already in --out alone:
 * no Overpass, Shodan or other API queries, and the snapshot keeps its time.
 *
 * --fixtures runs against the test suite's fake upstreams instead of the
 * real ones. It exists for the tests and needs --out.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------ */
/* Where                                                               */
/* ------------------------------------------------------------------ */

/** The five boroughs. */
export const REGION = Object.freeze({ south: 40.49, west: -74.26, north: 40.92, east: -73.69 });

/** The demo's home. Fixed, so the snapshot never carries the capturer's own location. */
export const HOME = Object.freeze({
  lat: 40.7128, lon: -74.006,
  city: 'New York', region: 'New York', country: 'United States', countryCode: 'US',
  postal: null, timezone: 'America/New_York', isp: null, asn: null,
  label: 'New York, New York, United States',
});

/** Midtown and Lower Manhattan, plus the Brooklyn and Queens waterfront. */
const BUILDINGS_BOX = Object.freeze({ south: 40.695, west: -74.025, north: 40.815, east: -73.925 });
const BUILDINGS_STEP = 0.02;

const grow = (b, d) => ({ south: b.south - d, west: b.west - d, north: b.north + d, east: b.east + d });
const WORLD = { south: -85, west: -180, north: 85, east: 180 };
const METRO = grow(REGION, 4);
const CITY = grow(REGION, 0.25);

/** Zoom bands per tile set: [fromZ, toZ, box]. Wide and shallow, then narrow and deep. */
const TILE_PLANS = {
  shortbread: [[0, 4, WORLD], [5, 9, METRO], [10, 12, CITY], [13, 14, REGION]],
  labels: [[0, 3, WORLD], [4, 8, METRO], [9, 12, CITY], [13, 14, REGION]],
  radar: (max) => [[0, 3, WORLD], [4, max, METRO]],
  clouds: (max) => [[0, 3, WORLD], [4, max, METRO]],
  imagery: (max) => [[0, 3, WORLD], [4, Math.min(7, max), METRO], [8, max, CITY]],
  // OpenStreetMap's own tile servers are donated and their usage policy
  // discourages bulk downloads, so this set is kept small: the deep zooms
  // cover Manhattan and the waterfront only (about 1,300 tiles in all).
  osm: [[0, 4, WORLD], [5, 9, METRO], [10, 12, CITY], [13, 13, REGION], [14, 15, BUILDINGS_BOX]],
  cloudless: [[0, 4, WORLD], [5, 9, METRO], [10, 12, CITY], [13, 14, REGION]],
};
const LABELS_MAX = 14;
const SHORTBREAD_MAX = 14;
const OSM_MAX = 15;
const CLOUDLESS_MAX = 14;
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
/** What --maps-only runs. */
const MAP_STEPS = new Set(['basemap', 'labels', 'street map', 'satellite mosaic']);
/** EOX publishes one cloud-free mosaic per year; the newest that answers is used. */
const CLOUDLESS_YEARS = [2025, 2024, 2023, 2022, 2021, 2020];
const cloudlessUrl = (year, set = 'g') =>
  `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-${year}_3857/default/${set}/{z}/{y}/{x}.jpg`;

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const o = { out: path.join(ROOT, 'docs'), tiles: true, aisWait: 180, fixtures: false, outGiven: false, mapsOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { o.out = path.resolve(argv[++i]); o.outGiven = true; }
    else if (a === '--no-tiles') o.tiles = false;
    else if (a === '--maps-only') o.mapsOnly = true;
    else if (a === '--ais-wait') o.aisWait = Number(argv[++i]) || 0;
    else if (a === '--fixtures') o.fixtures = true;
    else if (a === '-h' || a === '--help') { o.help = true; }
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bboxStr = (b) => [b.south, b.west, b.north, b.east].map((v) => +v.toFixed(5)).join(',');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** Boxes of `step` degrees covering `b`. */
export function grid(b, step) {
  const out = [];
  for (let s = b.south; s < b.north - 1e-9; s += step) {
    for (let w = b.west; w < b.east - 1e-9; w += step) {
      out.push({ south: s, west: w, north: Math.min(s + step, b.north), east: Math.min(w + step, b.east) });
    }
  }
  return out;
}

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** Every {z, x, y} a tile plan asks for, without duplicates. */
export function tilesFor(plan) {
  const seen = new Set();
  const out = [];
  for (const [z0, z1, box] of plan) {
    for (let z = z0; z <= Math.min(z1, MAX_ZOOM); z++) {
      const n = 2 ** z;
      const x0 = Math.max(0, lon2x(box.west, z));
      const x1 = Math.min(n - 1, lon2x(box.east, z));
      const y0 = Math.max(0, lat2y(box.north, z));
      const y1 = Math.min(n - 1, lat2y(box.south, z));
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const k = `${z}/${x}/${y}`;
          if (!seen.has(k)) { seen.add(k); out.push({ z, x, y }); }
        }
      }
    }
  }
  return out;
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

let USER_AGENT = 'OpenPanopticon demo capture';
let ATTEMPTS = 2;
let MAX_ZOOM = Infinity;   // lowered for --fixtures, where tiles are only plumbing

/** Fetch to a file. Returns true when the file exists afterwards. */
async function download(url, file, { gzip = false, accept = null, maxBytes = 8e6, headers = {} } = {}) {
  if (fs.existsSync(file)) return true;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 204 || res.status === 404) return false;   // nothing there: ordinary
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (accept && !accept.test(type)) return false;
      let buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > maxBytes) return false;
      if (gzip) buf = zlib.gzipSync(buf, { level: 9 });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return true;
    } catch (e) {
      if (attempt + 1 >= ATTEMPTS) return false;
      await sleep(1500);
    }
  }
  return false;
}

/** Download one tile set. The template's {z}/{x}/{y} are filled in per tile. */
async function captureTiles(name, template, plan, dir, ext, log, opts = {}) {
  const tiles = tilesFor(plan);
  let ok = 0;
  let done = 0;
  await pool(tiles, opts.concurrency || 8, async ({ z, x, y }) => {
    const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const file = path.join(dir, String(z), String(x), `${y}.${ext}`);
    if (await download(url, file, opts)) ok++;
    if (++done % 250 === 0) log(`    ${name}: ${done}/${tiles.length}`);
  });
  log(`    ${name}: ${ok} of ${tiles.length} tiles`);
  return { requested: tiles.length, saved: ok };
}

/* ------------------------------------------------------------------ */
/* Merging per-cell answers into one region                            */
/* ------------------------------------------------------------------ */

/**
 * How each bbox endpoint's answer is laid out: which array holds the
 * features and how to tell two of them apart. The demo runtime uses the same
 * table to filter them back down to whatever box the page asks for.
 */
export const REGION_SPECS = {
  shodan: { path: '/api/shodan', key: 'matches', id: (m) => `${m.ip}:${m.port}/${m.transport}` },
  overpass: { path: '/api/overpass', key: 'features', id: (f) => f.id },
  alpr: { path: '/api/alpr', key: 'cameras', id: (c) => c.id },
  webcams: { path: '/api/webcams', key: 'webcams', id: (c) => c.id },
  events: { path: '/api/events', key: 'events', id: (e) => e.id },
  netinfra: { path: '/api/netinfra', key: 'nodes', id: (n) => n.id },
  iot: { path: '/api/iot', key: 'sensors', id: (s) => s.id },
  traffic: { path: '/api/traffic', key: 'features', id: (f) => f.id },
  flights: { path: '/api/flights', key: 'aircraft', id: (a) => a.icao24 },
  vessels: { path: '/api/vessels', key: 'vessels', id: (v) => v.mmsi },
};

/** Fold one answer into an accumulating region. */
export function mergeInto(acc, name, answer) {
  const spec = REGION_SPECS[name];
  const items = Array.isArray(answer?.[spec.key]) ? answer[spec.key] : [];
  acc.items ||= new Map();
  for (const it of items) {
    const id = spec.id(it);
    if (id != null) acc.items.set(String(id), it);
  }
  const meta = { ...answer };
  delete meta[spec.key];
  // Problems from any cell are worth keeping; the rest of the metadata is
  // the same in every answer.
  acc.problems = { ...(acc.problems || {}), ...(answer?.problems || {}) };
  acc.meta = { ...meta, problems: acc.problems };
  return acc;
}

/* ------------------------------------------------------------------ */
/* The server                                                          */
/* ------------------------------------------------------------------ */

async function startLocalServer({ fixtures }) {
  const harness = require(path.join(ROOT, 'test/helpers/harness.cjs'));
  if (fixtures) {
    const { TEST_KEYS, registerDefaults } = require(path.join(ROOT, 'test/helpers/fixtures.cjs'));
    const { UpstreamMock } = require(path.join(ROOT, 'test/helpers/upstream.cjs'));
    const s = await harness.startServer({
      env: { ...TEST_KEYS, CARTO_API_KEY: 'test-carto' },
      mock: registerDefaults(new UpstreamMock()),
    });
    // Stand-ins for the two raster base maps, which the server never proxies.
    const { png } = require(path.join(ROOT, 'test/helpers/responses.cjs'));
    s.mock.on((url) => url.hostname === 'tile.openstreetmap.org', () => png());
    s.mock.on((url) => url.hostname === 'tiles.maps.eox.at', () => png());
    return { ...s, fixtures: true };
  }

  // Your own configuration, on a private loopback port.
  const port = await harness.freePort();
  Object.assign(process.env, {
    PORT: String(port), HOST: '127.0.0.1', OPENPANOPTICON_QUIET: '1', OPENPANOPTICON_OPEN_BROWSER: '0',
  });
  const mod = require(path.join(ROOT, 'server.js'));
  await new Promise((resolve) => mod.server.listen(port, '127.0.0.1', resolve));
  const api = (pathname, params = {}) => {
    const u = new URL(pathname, `http://127.0.0.1:${port}`);
    for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') u.searchParams.set(k, v);
    return harness.request(port, u.pathname + u.search, { headers: { 'X-Panopticon': '1' } });
  };
  const close = async () => {
    try { mod.ais.socket?.close(); } catch { /* not open */ }
    clearTimeout(mod.ais.reconnectTimer);
    mod.server.closeAllConnections?.();
    await new Promise((r) => mod.server.close(() => r()));
  };
  return { mod, port, api, request: (p, o) => harness.request(port, p, o), close, fixtures: false };
}

/** GET an API route; returns the parsed body or throws with the server's message. */
async function getJson(srv, pathname, params) {
  const r = await srv.api(pathname, params);
  let body;
  try { body = r.json(); } catch { body = { error: r.text.slice(0, 200) }; }
  if (r.status !== 200) {
    const e = new Error(body?.error || `HTTP ${r.status}`);
    e.status = r.status;
    e.retryAfter = body?.retryAfter;
    throw e;
  }
  return body;
}

/** getJson, waiting out rate limits a few times. */
async function getJsonPatiently(srv, pathname, params, log) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getJson(srv, pathname, params);
    } catch (e) {
      if (attempt >= 3 || !(e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504)) throw e;
      const wait = Math.min(120, Math.max(10, Number(e.retryAfter) || 20 * (attempt + 1)));
      log(`    ${pathname}: ${e.message.slice(0, 90)} — waiting ${wait}s`);
      await sleep(wait * 1000);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

export async function capture(opts, log = console.log) {
  const out = opts.out;
  const D = (...p) => path.join(out, 'data', ...p);
  // --maps-only builds on the snapshot already there, so its layer data,
  // step results and moment of capture all carry over untouched.
  let previous = null;
  if (opts.mapsOnly) {
    try { previous = JSON.parse(fs.readFileSync(D('manifest.json'), 'utf8')); } catch { /* none yet */ }
    if (!previous) log('  No snapshot here yet: capturing the maps only, so the demo will have no layer data.');
  }
  const steps = { ...(previous?.steps || {}) };
  const wanted = (name) => !opts.mapsOnly || MAP_STEPS.has(name);
  const step = async (name, fn) => {
    if (!wanted(name)) return;
    const t0 = Date.now();
    log(`  ${name} …`);
    try {
      const r = await fn();
      steps[name] = { ok: true, ...(r || {}) };
      log(`  ${name}: done in ${Math.round((Date.now() - t0) / 1000)}s${r?.count != null ? ` (${r.count})` : ''}`);
    } catch (e) {
      steps[name] = { ok: false, error: e.message };
      log(`  ${name}: FAILED — ${e.message}`);
    }
  };

  fs.mkdirSync(D('api'), { recursive: true });
  const srv = await startLocalServer(opts);
  if (srv.fixtures) {
    // Fake upstreams: no one to be polite to, and tiles are only plumbing.
    ATTEMPTS = 1;
    MAX_ZOOM = 1;
    srv.mod.overpassGate.minGapMs = 0;
  }
  USER_AGENT = srv.mod.USER_AGENT || USER_AGENT;
  const startedAt = Date.now();
  let capturedAt = previous?.capturedAt ?? startedAt;
  const manifest = {
    ...(previous || {}),
    capturedAt, region: REGION, home: HOME, fixtures: srv.fixtures,
    tiles: { ...(previous?.tiles || {}) }, buildings: previous?.buildings ?? null, steps,
  };

  try {
    const health = await getJson(srv, '/api/health');
    if (wanted('health')) writeJson(D('api', 'health.json'), health);
    const config = await getJson(srv, '/api/config');
    const src = health.sources || {};
    const presets = health.presets || {};

    // ---------------------------------------------------------------- flights first: they set the moment
    await step('aircraft', async () => {
      const acc = mergeInto({}, 'flights', await getJsonPatiently(srv, '/api/flights', { bbox: bboxStr(REGION) }, log));
      if (acc.meta?.time) capturedAt = acc.meta.time * 1000;
      writeJson(D('api', 'region', 'flights.json'), { meta: acc.meta, items: [...acc.items.values()] });
      return { count: acc.items.size };
    });
    manifest.capturedAt = capturedAt;

    // ---------------------------------------------------------------- region layers, cell by cell
    const cells = grid(REGION, 0.125);
    const regionParams = {
      shodan: src.shodan === 'configured' && { preset: 'all' },
      overpass: { presets: Object.keys(presets.overpass || {}).join(','), limit: 3000 },
      alpr: { vendor: 'all' },
      webcams: {},
      events: {
        sources: Object.entries(presets.events || {}).filter(([, v]) => v.available).map(([k]) => k).join(','),
      },
      netinfra: {
        sources: Object.entries(presets.netinfra || {}).filter(([, v]) => v.available).map(([k]) => k).join(','),
      },
      iot: { indoor: '1' },
      traffic: !String(src.fiveEleven || '').startsWith('no states') && {},
    };
    for (const [name, params] of Object.entries(regionParams)) {
      if (!wanted(name)) continue;
      if (!params) { steps[name] = { ok: false, error: 'not configured' }; log(`  ${name}: skipped (not configured)`); continue; }
      await step(name, async () => {
        const acc = {};
        let failures = 0;
        let lastErr = null;
        for (const [i, c] of cells.entries()) {
          // A hair inside the cell, so the server snaps to exactly this one.
          const inset = { south: c.south + 1e-4, west: c.west + 1e-4, north: c.north - 1e-4, east: c.east - 1e-4 };
          try {
            mergeInto(acc, name, await getJsonPatiently(srv, REGION_SPECS[name].path, { ...params, bbox: bboxStr(inset) }, log));
          } catch (e) { failures++; lastErr = e; }
          if ((i + 1) % 5 === 0) log(`    ${name}: ${i + 1}/${cells.length} cells, ${acc.items?.size || 0} so far`);
        }
        if (!acc.items) throw lastErr || new Error('no answers');
        writeJson(D('api', 'region', `${name}.json`), { meta: acc.meta, items: [...acc.items.values()], params });
        return { count: acc.items.size, failedCells: failures };
      });
    }

    // ---------------------------------------------------------------- ships: let the stream warm up
    if (String(src.ais || '').startsWith('configured')) {
      await step('vessels', async () => {
        const deadline = Date.now() + (srv.fixtures ? 0 : opts.aisWait * 1000);
        let last;
        do {
          last = await getJson(srv, '/api/vessels', { bbox: bboxStr(REGION) });
          log(`    vessels: ${last.count} in view, stream ${last.stream?.status}`);
          if (Date.now() >= deadline) break;
          await sleep(20000);
        } while (Date.now() < deadline);
        const acc = mergeInto({}, 'vessels', last);
        writeJson(D('api', 'region', 'vessels.json'), { meta: acc.meta, items: [...acc.items.values()] });
        return { count: acc.items.size };
      });
    } else if (wanted('vessels')) steps.vessels = { ok: false, error: 'not configured' };

    // ---------------------------------------------------------------- the rest of the API
    await step('signals', async () => {
      writeJson(D('api', 'signals.json'), await getJson(srv, '/api/signals', { bbox: bboxStr(REGION) }));
    });
    if (src.shodan === 'configured') {
      await step('shodan credits', async () => {
        writeJson(D('api', 'shodan-credits.json'), await getJson(srv, '/api/shodan/credits'));
      });
    }
    await step('satellites', async () => {
      let n = 0;
      for (const group of Object.keys(presets.satellites || {})) {
        try {
          writeJson(D('api', 'satellites', `${group}.json`), await getJson(srv, '/api/satellites', { group, limit: 2000 }));
          n++;
        } catch (e) { log(`    satellites/${group}: ${e.message}`); }
      }
      return { count: n };
    });

    await step('lookups', async () => {
      const lookups = { route: {}, aircraft: {}, enrich: {} };
      const read = (n) => {
        try { return JSON.parse(fs.readFileSync(D('api', 'region', `${n}.json`), 'utf8')).items; } catch { return []; }
      };
      const flights = read('flights');
      const calls = [...new Set(flights.map((a) => (a.callsign || '').trim()).filter(Boolean))];
      const icaos = [...new Set(flights.map((a) => a.icao24).filter(Boolean))];
      const ips = [...new Set(read('shodan').map((m) => m.ip))].slice(0, 250);
      const save = async (bucket, key, p, params) => {
        try { lookups[bucket][key] = await getJson(srv, p, params); } catch (e) { lookups[bucket][key] = { error: e.message }; }
      };
      await pool(calls, 3, (c) => save('route', c, '/api/route', { callsign: c }));
      await pool(icaos, 3, (i) => save('aircraft', i, '/api/aircraft', { icao24: i }));
      await pool(ips, 2, (ip) => save('enrich', ip, '/api/enrich', { ip }));
      writeJson(D('api', 'lookups.json'), lookups);
      return { count: calls.length + icaos.length + ips.length };
    });

    // ---------------------------------------------------------------- weather, imagery, basemap: answers plus tiles
    await step('weather', async () => {
      const w = await getJson(srv, '/api/weather');
      const frames = w.radar?.frames || [];
      for (const f of frames) {
        const local = `data/tiles/radar/${f.time}/{z}/{x}/{y}.png`;
        if (opts.tiles) {
          manifest.tiles[`radar ${f.iso}`] = await captureTiles(`radar ${f.iso}`, f.url,
            TILE_PLANS.radar(w.radar.maxLevel ?? 7), D('tiles', 'radar', String(f.time)), 'png', log, { accept: /image/ });
        }
        f.url = local;
      }
      if (w.satellite?.frames?.length) {
        for (const f of w.satellite.frames) {
          const local = `data/tiles/satellite/${f.time}/{z}/{x}/{y}.png`;
          if (opts.tiles) {
            await captureTiles(`satellite ${f.iso}`, f.url, TILE_PLANS.radar(7),
              D('tiles', 'satellite', String(f.time)), 'png', log, { accept: /image/ });
          }
          f.url = local;
        }
      }
      if (w.clouds?.url) {
        const ext = /\.jpe?g/.test(w.clouds.url) ? 'jpg' : 'png';
        if (opts.tiles) {
          manifest.tiles.clouds = await captureTiles('clouds', w.clouds.url, TILE_PLANS.clouds(w.clouds.maxLevel ?? 7),
            D('tiles', 'clouds'), ext, log, { accept: /image/ });
        }
        w.clouds.url = `data/tiles/clouds/{z}/{x}/{y}.${ext}`;
      }
      writeJson(D('api', 'weather.json'), w);
      return { count: frames.length };
    });

    await step('imagery', async () => {
      const layers = presets.imagery || [];
      let n = 0;
      for (const l of layers) {
        const d = await getJson(srv, '/api/imagery', { layer: l.key });
        const ext = l.ext || (/\.png/.test(d.selected.url) ? 'png' : 'jpg');
        if (opts.tiles) {
          manifest.tiles[`imagery ${l.key}`] = await captureTiles(l.key, d.selected.url,
            TILE_PLANS.imagery(d.selected.maxLevel ?? 9), D('tiles', 'imagery', l.key), ext, log, { accept: /image/ });
        }
        d.selected.url = `data/tiles/imagery/${l.key}/{z}/{x}/{y}.${ext}`;
        writeJson(D('api', 'imagery', `${l.key}.json`), d);
        n++;
      }
      return { count: n };
    });

    await step('basemap', async () => {
      const b = await getJson(srv, '/api/basemap', { provider: 'shortbread' });
      if (opts.tiles) {
        manifest.tiles.shortbread = await captureTiles('shortbread', b.url, TILE_PLANS.shortbread,
          D('tiles', 'shortbread'), 'pbf.gz', log, { gzip: true, concurrency: 6 });
      }
      b.url = 'data/tiles/shortbread/{z}/{x}/{y}.pbf';
      b.maxLevel = SHORTBREAD_MAX;
      writeJson(D('api', 'basemap-shortbread.json'), b);
    });

    if (config.cartoLabels) {
      await step('labels', async () => {
        if (!opts.tiles) return { count: 0 };
        const base = `http://127.0.0.1:${srv.port}`;
        for (const style of ['dark_only_labels', 'light_only_labels']) {
          manifest.tiles[`labels ${style}`] = await captureTiles(style, `${base}/tiles/carto/${style}/{z}/{x}/{y}.png`,
            TILE_PLANS.labels, path.join(out, 'tiles', 'carto', style), 'png', log,
            { accept: /image/, concurrency: 6 });
        }
        return { count: 2 };
      });
    }
    manifest.labels = config.cartoLabels && opts.tiles ? { maxLevel: LABELS_MAX } : null;
    manifest.shortbread = { maxLevel: SHORTBREAD_MAX };

    // ---------------------------------------------------------------- raster base maps
    // Fetched straight from their publishers: the app's browser loads these
    // directly too, so there is no server route to go through.
    manifest.osm = null;
    manifest.cloudless = null;
    if (opts.tiles) {
      await step('street map', async () => {
        const t = await captureTiles('osm', OSM_TILES, TILE_PLANS.osm, D('tiles', 'osm'), 'png', log,
          { accept: /image/, concurrency: 2 });
        manifest.tiles.osm = t;
        if (t.saved) manifest.osm = { maxLevel: OSM_MAX, attribution: '© OpenStreetMap contributors' };
        return { count: t.saved };
      });
      await step('satellite mosaic', async () => {
        let found = null;
        for (const year of CLOUDLESS_YEARS) {
          for (const set of ['g', 'GoogleMapsCompatible']) {
            const probe = cloudlessUrl(year, set).replace('{z}', 0).replace('{y}', 0).replace('{x}', 0);
            try {
              const res = await fetch(probe, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
              if (res.ok && /image/.test(res.headers.get('content-type') || '')) { found = { year, set }; break; }
            } catch { /* try the next */ }
          }
          if (found) break;
        }
        if (!found) throw new Error('no Sentinel-2 cloudless year answered');
        log(`    satellite mosaic: Sentinel-2 cloudless ${found.year}`);
        const t = await captureTiles('cloudless', cloudlessUrl(found.year, found.set), TILE_PLANS.cloudless,
          D('tiles', 's2cloudless'), 'jpg', log, { accept: /image/, concurrency: 4 });
        manifest.tiles.cloudless = t;
        if (t.saved) {
          manifest.cloudless = {
            year: found.year, maxLevel: CLOUDLESS_MAX,
            attribution: `Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH `
              + `(Contains modified Copernicus Sentinel data ${found.year})`,
          };
        }
        return { count: t.saved };
      });
    }

    // ---------------------------------------------------------------- camera stills
    await step('camera stills', async () => {
      let saved = 0;
      for (const [name, key] of [['webcams', 'image'], ['traffic', 'image']]) {
        const file = D('api', 'region', `${name}.json`);
        if (!fs.existsSync(file)) continue;
        const region = JSON.parse(fs.readFileSync(file, 'utf8'));
        await pool(region.items, 4, async (c) => {
          // A player would be live; the demo shows one frame.
          if ('embed' in c) c.embed = null;
          const url = c[key];
          if (!url || !/^https?:/.test(url)) { c[key] = null; return; }
          const rel = `data/cams/${crypto.createHash('sha1').update(String(c.id)).digest('hex').slice(0, 16)}.jpg`;
          const ok = await download(url, path.join(out, rel), { accept: /^image\//, maxBytes: 3e6 });
          c[key] = ok ? rel : null;
          if (ok) saved++;
        });
        writeJson(file, region);
      }
      return { count: saved };
    });

    // ---------------------------------------------------------------- OpenStreetMap buildings and place names
    await step('buildings', async () => {
      const tiles = [];
      let total = 0;
      for (const [i, c] of grid(BUILDINGS_BOX, BUILDINGS_STEP).entries()) {
        const file = D('buildings', `${i}.json`);
        let list;
        if (fs.existsSync(file)) list = JSON.parse(fs.readFileSync(file, 'utf8')).b;
        else {
          const ql = `[out:json][timeout:120];way["building"](${bboxStr(c)});out tags geom;`;
          let raw;
          for (let attempt = 0; ; attempt++) {
            try { raw = await srv.mod.overpassQuery(ql, 'Overpass buildings'); break; } catch (e) {
              if (attempt >= 3) throw e;
              const wait = Math.max(15, Number(e.retryAfter) || 30);
              log(`    buildings ${i}: ${e.message.slice(0, 80)} — waiting ${wait}s`);
              await sleep(wait * 1000);
            }
          }
          list = buildingsFrom(raw);
          writeJson(file, { b: list });
        }
        tiles.push({ i, ...c, n: list.length });
        total += list.length;
        log(`    buildings: cell ${i + 1}, ${total} so far`);
      }
      manifest.buildings = { box: BUILDINGS_BOX, step: BUILDINGS_STEP, tiles };
      return { count: total };
    });

    await step('place names', async () => {
      const b = bboxStr(REGION);
      const ql = `[out:json][timeout:90];(`
        + `node["place"~"^(city|borough|suburb|neighbourhood|quarter|island)$"]["name"](${b});`
        + `nwr["tourism"~"^(attraction|museum|viewpoint|zoo)$"]["name"](${b});`
        + `nwr["aeroway"="aerodrome"]["name"](${b});`
        + `nwr["leisure"="park"]["name"]["wikidata"](${b});`
        + `nwr["building"]["name"]["wikidata"](${b});`
        + `);out center tags;`;
      const raw = await srv.mod.overpassQuery(ql, 'Overpass place names');
      const places = [];
      const seen = new Set();
      for (const el of raw.elements || []) {
        const t = el.tags || {};
        const lat = el.lat ?? el.center?.lat;
        const lon = el.lon ?? el.center?.lon;
        const name = t['name:en'] || t.name;
        if (!name || lat == null || lon == null) continue;
        const key = `${name}|${lat.toFixed(3)}|${lon.toFixed(3)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const type = t.place || t.tourism || t.aeroway || t.leisure || (t.building ? 'building' : 'place');
        places.push({ name, lat: +lat.toFixed(6), lon: +lon.toFixed(6), type });
      }
      writeJson(D('api', 'gazetteer.json'), places);
      return { count: places.length };
    });
  } finally {
    await srv.close();
  }

  manifest.capturedAt = capturedAt;
  manifest.finishedAt = Date.now();
  writeJson(D('manifest.json'), manifest);
  return manifest;
}

/** Compact footprints: [heightM, minHeightM, [lon, lat, lon, lat, …]]. */
export function buildingsFrom(raw) {
  const num = (v) => {
    const n = parseFloat(String(v ?? '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const out = [];
  for (const el of raw?.elements || []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 4) continue;
    const t = el.tags || {};
    const levels = num(t['building:levels']);
    const minLevel = num(t['building:min_level']);
    let h = num(t.height) ?? (levels != null ? levels * 3.2 + 2 : null) ?? 9;
    const minH = num(t.min_height) ?? (minLevel != null ? minLevel * 3.2 : 0);
    h = Math.max(h, minH + 2);
    const ring = [];
    for (const p of el.geometry) ring.push(+p.lon.toFixed(6), +p.lat.toFixed(6));
    out.push([Math.round(h * 10) / 10, Math.round(minH * 10) / 10, ring]);
  }
  return out;
}

/* ------------------------------------------------------------------ */

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  if (opts.help) {
    const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
    const end = lines.findIndex((l, i) => i > 3 && l.trim() === '*/');
    console.log(lines.slice(4, end).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
    process.exit(0);
  }
  if (opts.fixtures && !opts.outGiven) { console.error('--fixtures needs --out (it must not overwrite docs/)'); process.exit(2); }
  console.log(opts.mapsOnly
    ? `\n  Capturing the map tiles only into ${opts.out} (layer data is left as it is)\n`
    : `\n  Capturing a New York snapshot into ${opts.out}\n`);
  // The globe is lit by the sun at the snapshot's time, so a night capture
  // gives a dark demo.
  const nyHour = Number(new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  if (!opts.fixtures && !opts.mapsOnly && (nyHour < 8 || nyHour >= 17)) {
    console.log(`  Note: it is ${nyHour}:00 in New York. The demo is lit for the moment of capture,`
      + '\n  so it will look dark; capturing between 08:00 and 17:00 there looks best.\n');
  }
  const t0 = Date.now();
  capture(opts).then((m) => {
    const failed = Object.entries(m.steps).filter(([, s]) => !s.ok);
    console.log(`\n  Finished in ${Math.round((Date.now() - t0) / 60000)} min. Snapshot time: ${new Date(m.capturedAt).toISOString()}`);
    if (failed.length) {
      console.log('  Not captured:');
      for (const [k, s] of failed) console.log(`    ${k}: ${s.error}`);
    }
    console.log('\n  Next: node demo/build.mjs\n');
    process.exit(0);
  }).catch((e) => { console.error(e); process.exit(1); });
}

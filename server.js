#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * OPENPANOPTICON — OSINT Data Fusion
 * Zero-dependency Node server: static host + authenticated upstream proxy.
 *
 * Every credential stays in this process, with one deliberate exception: the
 * Cesium Ion token is handed to the browser (via /api/config), because Cesium
 * streams terrain and imagery from the browser by design. Scope that token to
 * read-only access on the assets you use.
 * Run:  node server.js      (Node 22+ required: global fetch and WebSocket)
 */

'use strict';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`  Node ${process.version} is too old. OpenPanopticon needs Node 22 or newer.`);
  process.exit(1);
}

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { AsyncLocalStorage } = require('node:async_hooks');
const { URL } = require('node:url');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = __dirname;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const PUBLIC_DIR = path.join(ROOT, 'public');
// Runtime data (disk cache, TLE copies). Overridable so the test suite can
// point it at a throwaway directory instead of the real cache.
const PROVIDERS_DIR = process.env.OPENPANOPTICON_DATA_DIR || path.join(ROOT, 'providers');

// This folder used to be called vendor/. Carry an existing one over, so an
// upgrade keeps the cached answers it already paid for.
if (!process.env.OPENPANOPTICON_DATA_DIR) {
  const legacy = path.join(ROOT, 'vendor');
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(PROVIDERS_DIR)) fs.renameSync(legacy, PROVIDERS_DIR);
  } catch (e) {
    console.warn(`  could not move vendor/ to providers/: ${e.message}`);
  }
}

loadDotEnv(process.env.OPENPANOPTICON_ENV_FILE || path.join(ROOT, '.env'));

const CFG = {
  port: parseInt(process.env.PORT || '8420', 10),
  host: process.env.HOST || '127.0.0.1',
  shodanKey: (process.env.SHODAN_API_KEY || '').trim(),
  windyKey: (process.env.WINDY_API_KEY || '').trim(),
  cesiumIonToken: (process.env.CESIUM_ION_TOKEN || '').trim(),
  openSkyId: (process.env.OPENSKY_CLIENT_ID || '').trim(),
  openSkySecret: (process.env.OPENSKY_CLIENT_SECRET || '').trim(),
  owcdbKey: (process.env.OPENWEBCAMDB_API_KEY || '').trim(),
  firmsKey: (process.env.FIRMS_MAP_KEY || '').trim(),
  edisUrl: (process.env.EDIS_API_URL || '').trim(),
  edisKey: (process.env.EDIS_API_KEY || '').trim(),
  aisKey: (process.env.AISSTREAM_API_KEY || '').trim(),
  openCellIdKey: (process.env.OPENCELLID_API_KEY || '').trim(),
  wigleName: (process.env.WIGLE_API_NAME || '').trim(),
  wigleToken: (process.env.WIGLE_API_TOKEN || '').trim(),
  greyNoiseKey: (process.env.GREYNOISE_API_KEY || '').trim(),
  eiaKey: (process.env.EIA_API_KEY || '').trim(),
  cloudflareToken: (process.env.CLOUDFLARE_API_TOKEN || '').trim(),
  cartoKey: (process.env.CARTO_API_KEY || '').trim(),
  // 511 state feeds: "TX:key,GA:key,NY:key" — see the 511 section below.
  fiveElevenKeys: parse511(process.env.FIVE_ELEVEN_KEYS || ''),
};

function parse511(raw) {
  const out = {};
  for (const pair of String(raw).split(',')) {
    const [state, key] = pair.split(':').map((s) => (s || '').trim());
    if (state && key) out[state.toUpperCase()] = key;
  }
  return out;
}

function loadDotEnv(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

// ---------------------------------------------------------------------------
// Cache retention: cache.conf
// ---------------------------------------------------------------------------
//
// How long each kind of thing is held, in one file an operator can edit
// without reading this one: cache.conf in the project folder (or wherever
// OPENPANOPTICON_CACHE_CONF points). It is written with the defaults and an
// explanation of every setting the first time the server starts, and read
// again whenever it changes, so an edit takes effect without a restart. A
// setting that is missing, misspelt or unreadable keeps its default and is
// reported in the console.
//
// Durations are a number and a unit: 90s, 30m, 6h, 3d, 2w (no unit means
// seconds). 0 means do not keep it at all. Sizes take MB or GB.

const CACHE_CONF_FILE = process.env.OPENPANOPTICON_CACHE_CONF || path.join(ROOT, 'cache.conf');

// [section, key, default, what it holds]. Order and wording are the file's.
const CACHE_SCHEMA = [
  ['maps', 'tiles', '30d', 'Map tiles on disk in providers/tiles: aerial imagery, street and vector\n# maps, place labels, NASA imagery, Sentinel-2 scenes. A tile is fetched again\n# this long after it was downloaded, however often it is used.'],
  ['maps', 'tiles_max_size', '4096MB', 'Largest the tile folder may grow. Past it, the oldest tiles go first.'],
  ['maps', 'browser', '1d', 'How long the browser keeps its own copy of a tile, on top of the disk one.'],
  ['maps', 'scenes', '3d', 'Sentinel-2 scene searches: which scenes cover a view (not the imagery).'],
  ['shodan', 'hosts', '3d', 'Shodan search results. Every miss spends a query credit, so this is also\n# how long a view is not paid for twice.'],
  ['shodan', 'credits', '1m', 'The remaining-credit count shown in the sidebar.'],
  ['overpass', 'infrastructure', '3d', 'OSM infrastructure layer (masts, substations, cameras, military, ...).\n# Overpass is donated capacity and rate-limits hard; mapped things change\n# over weeks.'],
  ['overpass', 'alpr', '3d', 'ALPR / Flock camera layer.'],
  ['overpass', 'truncated', '1h', 'An answer that hit the item cap is incomplete, so it is held in memory\n# only, for this long, and never written to disk.'],
  ['network', 'infrastructure', '3d', 'RIPE Atlas probes, cell towers (OpenCelliD), WiFi (WiGLE), Tor relays.'],
  ['cameras', 'directories', '3d', 'Webcam directories: NYC DOT, OpenWebcamDB, ALERTCalifornia.'],
  ['satellites', 'elements', '1d', 'Orbital elements from CelesTrak. Only accurate near their epoch: older\n# elements put low-orbit objects tens of kilometres from where they are.'],
  ['aircraft', 'airframes', '3d', 'Aircraft type and registration lookups.'],
  ['aircraft', 'routes', '30m', 'Flight routes by callsign. The same flight number flies different legs\n# on different days.'],
  ['places', 'geocode', '3d', 'Place-name searches.'],
  ['places', 'seismic', '3d', 'Seismometer station lists.'],
  ['current', 'events', '1h', 'Hazards and alerts: GDACS, EONET, USGS, NWS, FIRMS, EDIS. An old alert\n# drawn as live is worse than none.'],
  ['current', 'traffic', '1h', 'Traffic incidents and cameras from 511 services.'],
  ['current', 'sensors', '1h', 'Live sensor readings (Sensor.Community).'],
  ['current', 'threats', '1h', 'Feodo botnet command-and-control list.'],
  ['current', 'outages', '1h', 'Internet outages (IODA).'],
  ['current', 'radar', '4m', 'Weather radar frame list.'],
  ['memory', 'max_entries', '1000', 'Most answers held in memory at once. The disk copies stay; this only\n# bounds memory.'],
  ['memory', 'label_tiles', '3000', 'Place-label tiles held in memory, on top of the disk copy.'],
];

const kindOf = (name) => (name === 'maps.tiles_max_size' ? 'size' : name.startsWith('memory.') ? 'count' : 'duration');

function parseDuration(v) {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i.exec(String(v).trim());
  if (!m) return null;
  const unit = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[(m[2] || 's').toLowerCase()];
  return Math.round(Number(m[1]) * unit);
}
function parseSize(v) {
  const m = /^(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb)?$/i.exec(String(v).trim());
  if (!m) return null;
  return Math.round(Number(m[1]) * { kb: 2 ** 10, mb: 2 ** 20, gb: 2 ** 30, tb: 2 ** 40 }[(m[2] || 'mb').toLowerCase()]);
}
function parseCount(v) {
  const m = /^\d+$/.exec(String(v).trim());
  return m ? Number(m[0]) : null;
}
function parseSetting(name, v) {
  const k = kindOf(name);
  return k === 'size' ? parseSize(v) : k === 'count' ? parseCount(v) : parseDuration(v);
}

/** Current settings, by "section.key": milliseconds, bytes or a count. */
const RETAIN = {};
let cacheConfProblems = [];

/** Read cache.conf over the defaults. Returns what it could not use. */
function loadCacheConf(file = CACHE_CONF_FILE) {
  const vals = Object.fromEntries(CACHE_SCHEMA.map(([sec, key, def]) => [`${sec}.${key}`, parseSetting(`${sec}.${key}`, def)]));
  const problems = [];
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet: defaults */ }
  const set = new Set();
  if (text != null) {
    let sec = '';
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.replace(/\s+[#;].*$/, '').trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) return;
      const head = /^\[([\w.-]+)\]$/.exec(line);
      if (head) { sec = head[1].toLowerCase(); return; }
      const kv = /^([\w.-]+)\s*[=:]\s*(.+)$/.exec(line);
      if (!kv) { problems.push(`line ${i + 1}: expected "name = value"`); return; }
      const name = sec ? `${sec}.${kv[1].toLowerCase()}` : kv[1].toLowerCase();
      if (!(name in vals)) { problems.push(`line ${i + 1}: no setting called "${name}"`); return; }
      const v = parseSetting(name, kv[2]);
      if (v == null) { problems.push(`line ${i + 1}: "${kv[2].trim()}" is not a ${kindOf(name)} (${name})`); return; }
      vals[name] = v;
      set.add(name);
    });
  }
  // TILE_CACHE_MAX_MB in .env predates this file; honour it unless the file says otherwise.
  if (!set.has('maps.tiles_max_size') && Number(process.env.TILE_CACHE_MAX_MB) > 0) {
    vals['maps.tiles_max_size'] = Number(process.env.TILE_CACHE_MAX_MB) * 2 ** 20;
  }
  vals['maps.tiles_max_size'] = Math.max(64 * 2 ** 20, vals['maps.tiles_max_size']);
  Object.assign(RETAIN, vals);
  cacheConfProblems = problems;
  return { found: text != null, problems };
}

/** The file as first written: every setting at its default, explained. */
function cacheConfText() {
  const out = [
    '# OpenPanopticon cache retention',
    '#',
    '# How long each kind of data is kept before it is fetched again. Edit and',
    '# save: the server picks changes up within a few seconds, no restart needed',
    '# (reload the page too, so the browser follows).',
    '#',
    '# Durations: a number and a unit - 90s, 30m, 6h, 3d, 2w. 0 = do not keep.',
    '# Sizes: MB or GB. Delete a line to go back to its default.',
  ];
  let sec = null;
  for (const [s, key, def, help] of CACHE_SCHEMA) {
    if (s !== sec) { out.push('', `[${s}]`); sec = s; }
    out.push('', `# ${help}`, `${key} = ${def}`);
  }
  return out.join('\n') + '\n';
}

/** Longest any answer on disk can be served, so pruning keeps what is live. */
function diskMaxAge() {
  let max = 0;
  for (const [sec, key] of CACHE_SCHEMA) {
    const name = `${sec}.${key}`;
    if (sec === 'maps' && key !== 'scenes') continue;   // tiles are their own store
    if (kindOf(name) === 'duration') max = Math.max(max, RETAIN[name] || 0);
  }
  return max;
}

loadCacheConf();

// ---------------------------------------------------------------------------
// TTL cache + in-flight de-duplication
// ---------------------------------------------------------------------------

const cache = new Map();     // key -> { expires, value }, insertion order = LRU
const inflight = new Map();  // key -> Promise

// Most keys name a place (a snapped view cell) or something typed, so a long
// session keeps minting keys that are never asked for again. Expired entries
// are swept on a timer (see start()), and this caps what is live at once.
// Evicting a persistent entry costs a disk read, not an upstream call.
// memory.max_entries in cache.conf.
const cacheMaxEntries = () => Math.max(50, RETAIN['memory.max_entries'] || 1000);

/** Drop every expired entry. Returns how many went. */
function sweepCache(now = Date.now()) {
  let removed = 0;
  for (const [k, e] of cache) {
    if (!(e.expires > now)) { cache.delete(k); removed++; }
  }
  return removed;
}

function remember(key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  if (cache.size <= cacheMaxEntries()) return;
  sweepCache();
  while (cache.size > cacheMaxEntries()) cache.delete(cache.keys().next().value);
}

async function cached(key, ttlMs, producer) {
  // A manual refresh means the operator has decided the stored answer is not
  // good enough, so neither the memory copy nor an already-running fetch that
  // started before they asked will do.
  const fresh = wantsFresh();
  if (!fresh) {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) {
      remember(key, hit);   // most recently used goes to the back
      return hit.value;
    }
    if (hit) cache.delete(key);
    if (inflight.has(key)) return inflight.get(key);
  }

  const p = (async () => {
    try {
      const value = await producer();
      remember(key, { expires: Date.now() + ttlMs, value });
      return value;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, p);
  return p;
}



// ---------------------------------------------------------------------------
// Cache retention policy
// ---------------------------------------------------------------------------
//
// One table rather than thirty-three magic numbers scattered through the file,
// so the policy can be read and changed in one place.
//
// Inventories of fixed things are held for three days (`static`) and
// refreshed on demand: mapped infrastructure, scanned hosts, camera
// directories, airframes, place names. None of it changes meaningfully in that
// time, and several of these are metered or donated services.
//
// Present-tense data gets far shorter windows, because holding it that long
// would make the map lie rather than merely make it stale:
//
//   live    Positions. An aircraft cached for a day is not a track, it is a
//           historical record drawn as if it were current.
//   hazard  Warnings and alerts, held for an hour. A tornado warning,
//           earthquake or wildfire from yesterday, drawn as though it were
//           live, is worse than the API call it saved.
//
// SYNC and FLUSH bypass all of it — see wantsFresh().
const DAY = 24 * 60 * 60_000;

/**
 * How long each kind of answer is worth keeping.
 *
 * The axis is not importance, it is how an answer goes wrong as it ages. An
 * inventory of fixed things — where the cameras, hosts, towers and roads are
 * — is still true in three days, so holding it longer costs nothing and saves
 * every API budget here. A present-tense claim is different: a weather alert
 * has an expiry, a fire perimeter moves, an air-quality reading is about now.
 * Those do not become stale so much as false, and a false reading presented
 * as current is worse than no reading.
 */
// The retention classes below are the reasoning, and the defaults
// cache.conf starts from (see CACHE_SCHEMA); what is actually in force is
// RETAIN, read from that file.
const TTL = {
  // Where fixed things are: OSM infrastructure, ALPR and webcam directories,
  // Shodan hosts, cell and WiFi, Tor relays, seismometer stations, geocoding.
  static: 3 * DAY,

  // Orbital elements. Held apart from `static` because they are accurate only
  // near their epoch: an orbit is perturbed continuously, CelesTrak
  // republishes every two hours, and propagating three-day-old elements puts
  // a low-orbit object tens of kilometres from where it actually is. The pin
  // would still be drawn, confidently, in the wrong place.
  orbit: DAY,

  // Present-tense claims: active hazards and alerts (GDACS, EONET, USGS, NWS,
  // FIRMS, EDIS), traffic incidents, internet outages, and live sensor
  // readings. An hour is long enough that panning a region stops re-querying
  // all of them, short enough that an expired alert clears.
  hazard: 60 * 60_000,

  // A callsign is a scheduled service on a given day, not a permanent city
  // pair: the same flight number flies different legs on different days, and
  // often the reverse leg the next. Holding one for a day showed yesterday's
  // route for today's aircraft.
  schedule: 30 * 60_000,
  live: 4 * 60_000,     // radar frame index; aircraft use the feed's own rate

  // Map tiles: aerial photography, street and vector maps, label sheets,
  // dated satellite scenes. A tile at a given address is a picture of a
  // survey that changes over months or years, so a month on disk costs
  // nothing in truth and saves every re-download. Kept apart from the
  // answers above, in providers/tiles — see pruneTileCache().
  tile: 30 * DAY,
  account: 60_000,      // credit balances, shown as a number in the UI
};

/**
 * Per-request "ignore the cache" flag.
 *
 * Carried in async context rather than threaded through twenty function
 * signatures, so every cached() call site honours it without knowing it
 * exists. Set by the route dispatcher from ?fresh=1, which is what SYNC and
 * FLUSH send.
 */
const reqCtx = new AsyncLocalStorage();
const wantsFresh = () => reqCtx.getStore()?.fresh === true;

// ---------------------------------------------------------------------------
// Query-box snapping and durable caching
// ---------------------------------------------------------------------------
//
// The view is continuous but a cache key is a string, so an 11-metre pan used
// to mint a brand-new key — and a brand-new upstream query — for data that
// overlapped the previous answer almost entirely. Snapping the query box
// outward onto a grid means every view inside the same cell shares one key,
// one upstream call, and one cache entry.
//
// The cost is over-fetching: the snapped box is larger than the view. That is
// the right trade for these three sources, which are slow-moving (OSM edits
// propagate over days, Shodan rescans over days) and expensive to ask
// (Overpass is donated capacity, Shodan is metered by credit).

/**
 * Cell size per source, in degrees.
 *
 * Coarse where the upstream is generous and the features are sparse, fine
 * where it caps results hard: enlarging the queried box past a hard cap
 * means the cap starts truncating real features, so a cheaper cache would be
 * bought with a worse map. OpenCellID returns 50 rows and WiGLE 100, which
 * is why those two stay close to the view.
 */
const VIEW_CELL_DEG = {
  // Overpass is donated capacity and its cost scales with the area queried,
  // so these two stay close to the view. 0.125 degrees is ~14km.
  alpr: 0.125,
  overpass: 0.125,
  // Aircraft are the opposite case: OpenSky charges per *call*, at one credit
  // for anything up to 25 square degrees, so a generous box costs the same
  // as a tight one and returns more. Coarse cells also mean panning around a
  // city reuses one answer instead of spending a credit per nudge.
  flights: 1.0,
  // Hazard feeds and 511 are cheap per call but slow, so a coarse cell lets
  // panning around a region reuse one answer.
  events: 1.0,
  traffic: 0.5,
  atlas: 0.5,
  shake: 0.5,
  iot: 0.25,
  cell: 0.05,
  wigle: 0.05,
};

/**
 * The widest box each source will be asked for, in degrees.
 *
 * A query far larger than the upstream can answer does not degrade, it hangs:
 * ten Overpass preset clauses over several degrees runs past every mirror's
 * timeout, the browser gives up at 180s, and the layer shows nothing at all.
 * Returning the middle of a very wide view beats returning none of it.
 */
const VIEW_MAX_DEG = {
  alpr: 1.0,
  // 0.5 degrees is 16 cells. Wider than that over a city, ten classes is a
  // run of heavy queries, each followed by its cool-down, and the browser
  // gives up long before the last one comes back.
  overpass: 0.5,
  // 5 x 5 degrees is 25 square degrees: the exact point at which OpenSky's
  // tariff steps from one credit to two. Past it a single wide view would
  // quietly cost double, or quadruple beyond 400.
  flights: 5.0,
  atlas: 4,
  shake: 4,
  iot: 2,
  cell: 0.5,
  wigle: 0.5,
};

/**
 * Cover the view with whole cells of one fixed grid.
 *
 * The grid never changes size. That is the whole point, and it is what the
 * previous ladder got wrong: choosing the cell size from how much you can
 * see means zooming over one place keeps moving the grid underneath it, so
 * every zoom step mints a new cache key and pays for a new query.
 *
 * Snapping the view's edges outward onto a *fixed* grid instead gives the
 * smallest whole-cell box that contains the view. Reloading or nudging the
 * camera lands on the same cells; zooming changes the box by at most a ring
 * of cells rather than re-gridding the world.
 *
 * Expanding symmetrically from the view's centre cell would keep the key
 * stable across a zoom, but the box would be 2k+1 cells, never fewer than
 * three: at a close-in view, nine times the area being looked at. With ten
 * Overpass clauses on top that runs every mirror past its timeout. A tight
 * box that occasionally re-queries is worth more than a stable key that
 * never answers.
 */
function snapFixed(b, step, maxDeg = Infinity) {
  const r = (v) => Number(v.toFixed(4));
  const out = {
    south: r(clamp(Math.floor(b.south / step) * step, -85, 85)),
    west: r(clamp(Math.floor(b.west / step) * step, -180, 180)),
    north: r(clamp(Math.ceil(b.north / step) * step, -85, 85)),
    east: r(clamp(Math.ceil(b.east / step) * step, -180, 180)),
  };
  // Rounding at the clamps can collapse an edge to zero width.
  if (out.north <= out.south) out.north = r(out.south + step);
  if (out.east <= out.west) out.east = r(out.west + step);

  // Too wide to answer: keep the grid, but trim back towards the view's
  // centre cell so the query is one the upstream can actually complete.
  const cells = Math.max(1, Math.floor(maxDeg / step));
  const trim = (lo, hi, centre) => {
    if (r(hi - lo) <= cells * step) return [lo, hi];
    const c = Math.floor(centre / step);
    const half = Math.floor(cells / 2);
    return [
      r(clamp((c - half) * step, lo, hi)),
      r(clamp((c - half + cells) * step, lo, hi)),
    ];
  };
  [out.south, out.north] = trim(out.south, out.north, (b.south + b.north) / 2);
  [out.west, out.east] = trim(out.west, out.east, (b.west + b.east) / 2);
  if (out.north <= out.south) out.north = r(out.south + step);
  if (out.east <= out.west) out.east = r(out.west + step);

  out.step = step;
  out.trimmed = r(Math.max(b.north - b.south, b.east - b.west)) > cells * step;
  return out;
}

/**
 * The canonical region for a view, and the string that names it.
 *
 * Every view-scoped source goes through this, and it returns the key as well
 * as the box for one reason: the upstream query and the cache key have to
 * describe the same ground. Built separately from the raw view box, they
 * would not.
 *
 * A key built from the unsnapped box records a camera position rather than a
 * region, so every small pan or reload mints a new entry that can never be
 * hit again. A ladder of cell sizes chosen from the view span has the same
 * problem one zoom step at a time. A fixed grid per source makes the key name
 * a region, and nearby views land on the same cells.
 */
function viewCell(b, kind) {
  const step = VIEW_CELL_DEG[kind];
  if (!step) throw new Error(`no view cell size defined for "${kind}"`);
  const q = snapFixed(b, step, VIEW_MAX_DEG[kind] ?? Infinity);
  q.key = `${q.south},${q.west},${q.north},${q.east}`;
  return q;
}

/**
 * Cache that survives a restart.
 *
 * Results that took a donated Overpass slot or a metered Shodan credit are
 * worth more than the memory they sit in, and throwing them away because the
 * process restarted means paying for them twice. Memory stays the fast path;
 * disk is what makes a three-day TTL actually mean three days.
 */
const DISK_CACHE_DIR = path.join(PROVIDERS_DIR, 'cache');
const diskName = (key) => `${crypto.createHash('sha1').update(key).digest('hex')}.json`;

// A cache key can be something the operator typed (a custom Shodan query), so
// it is never written in clear. The record carries a hash of it instead,
// which is still enough to tell a filename collision from a hit.
const diskKeyHash = (key) => crypto.createHash('sha256').update(`openpanopticon:${key}`).digest('hex');

// Nothing reads the disk tier with a TTL longer than this, so a file older
// than it can never be served again and is only a record of where the map
// was pointed. pruneDiskCache() removes those.
// (diskMaxAge(), from cache.conf.)

async function readDiskCache(key, ttlMs) {
  if (wantsFresh()) return undefined;
  const file = path.join(DISK_CACHE_DIR, diskName(key));
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const rec = JSON.parse(raw);
    // A collision, unless it is a record from before keys were hashed that
    // pruneDiskCache() has not rewritten yet.
    if (rec.keyHash !== diskKeyHash(key) && rec.key !== key) return undefined;
    if (Date.now() - rec.savedAt > ttlMs) {                   // expired
      if (Date.now() - rec.savedAt > diskMaxAge()) await fsp.unlink(file).catch(() => {});
      return undefined;
    }
    return rec.value;
  } catch {
    return undefined;
  }
}

async function writeDiskCache(key, value) {
  try {
    await fsp.mkdir(DISK_CACHE_DIR, { recursive: true });
    const file = path.join(DISK_CACHE_DIR, diskName(key));
    // Write then rename, so a crash mid-write cannot leave a half file that
    // later parses as valid JSON.
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ keyHash: diskKeyHash(key), savedAt: Date.now(), value }), 'utf8');
    await fsp.rename(tmp, file);
  } catch (e) {
    log('warn', `could not persist cache entry: ${e.message}`);
  }
}

/**
 * Delete what the disk tier can no longer serve.
 *
 * Without this, expired answers stay in providers/cache until FLUSH, and
 * together they are a history of every place looked at. Runs at startup and
 * every few hours. Files written before keys were hashed carry the key in
 * clear: still-live ones are rewritten without it (they may have cost a
 * Shodan credit), expired ones are deleted.
 */
async function pruneDiskCache({ now = Date.now() } = {}) {
  let names;
  try { names = await fsp.readdir(DISK_CACHE_DIR); } catch { return { removed: 0, rewritten: 0 }; }
  let removed = 0; let rewritten = 0;
  for (const name of names) {
    const file = path.join(DISK_CACHE_DIR, name);
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) continue;
      const age = now - st.mtimeMs;
      if (name.endsWith('.tmp')) {
        // A write that never got renamed; give a live one an hour to finish.
        if (age > 60 * 60_000) { await fsp.unlink(file); removed++; }
        continue;
      }
      if (!name.endsWith('.json')) continue;
      if (age > diskMaxAge()) { await fsp.unlink(file); removed++; continue; }

      const fh = await fsp.open(file, 'r');
      const head = Buffer.alloc(16);
      try { await fh.read(head, 0, 16, 0); } finally { await fh.close(); }
      if (!head.toString('utf8').startsWith('{"key":')) continue;

      const rec = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (typeof rec.key !== 'string' || !(now - rec.savedAt <= diskMaxAge())) {
        await fsp.unlink(file); removed++; continue;
      }
      const tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ keyHash: diskKeyHash(rec.key), savedAt: rec.savedAt, value: rec.value }), 'utf8');
      await fsp.rename(tmp, file);
      // Keep the original age, which the mtime check above prunes by.
      const saved = new Date(rec.savedAt);
      await fsp.utimes(file, saved, saved).catch(() => {});
      rewritten++;
    } catch { /* unreadable or already gone: leave it for FLUSH */ }
  }
  return { removed, rewritten };
}

/** cached(), plus a disk tier underneath it. */
async function cachedPersistent(key, ttlMs, producer) {
  return cached(key, ttlMs, async () => {
    const hit = await readDiskCache(key, ttlMs);
    if (hit !== undefined) return hit;
    const value = await producer();
    // Awaited, not fired and forgotten. An answer that cost a donated
    // Overpass slot or a Shodan credit must be on disk before the caller is
    // told about it — otherwise a restart moments later pays for it twice.
    // The write is a few milliseconds against an upstream call of seconds.
    await writeDiskCache(key, value);
    return value;
  });
}

/** Drop everything on disk; wired to the FLUSH control. */
async function clearDiskCache() {
  try {
    const files = await fsp.readdir(DISK_CACHE_DIR);
    await Promise.all(files.map((f) => fsp.unlink(path.join(DISK_CACHE_DIR, f)).catch(() => {})));
    return files.length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Upstream fetch helper
// ---------------------------------------------------------------------------

/** Shorten to at most `max` characters on a word boundary, marking the cut. */
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\-–—]+$/, '')}…`;
}

const htmlText = (h) => h
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/&#?[a-z0-9]{1,8};/gi, ' ')
  .replace(/\s+/g, ' ')
  .replace(/\s+([:;,.])/g, '$1')
  .trim();

/**
 * The useful sentence out of an upstream's refusal body.
 *
 * Most APIs explain a refusal ("too many queries today", "invalid key"),
 * which is far more useful in the sidebar than a bare status code. JSON
 * bodies give it as a field. HTML error pages bury it in boilerplate, and
 * flattening the whole page gives the title twice and the useful part cut
 * mid-word. So for HTML take the title and the first paragraph, drop
 * anything repeated, and cut on a word boundary.
 */
function refusalReason(body, max = 220) {
  if (!body) return '';
  try {
    const j = JSON.parse(body);
    const msg = j.message || j.error || j.detail || j.error_message || j.remark
      || (typeof j.errors?.[0] === 'string' ? j.errors[0] : j.errors?.[0]?.message);
    return typeof msg === 'string' && msg.trim() ? clip(msg.trim().replace(/\s+/g, ' '), max) : '';
  } catch { /* not JSON */ }

  if (/<[a-z!][^>]*>/i.test(body)) {
    const pick = (re) => { const m = re.exec(body); return m ? htmlText(m[1]) : ''; };
    const parts = [];
    // A title like "OSM3S Response" says nothing; keep it only if it names
    // the failure.
    const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const telling = /\b\d{3}\b|error|denied|forbidden|limit|unavailable|timeout|too many|busy/i;
    for (const t of [
      telling.test(title) ? title : '',
      pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i),
      // Overpass reports its own errors in <p><strong>Error</strong>: … </p>
      pick(/<p[^>]*>((?:(?!<\/p>)[\s\S])*?(?:error|rate|timeout|load|busy)(?:(?!<\/p>)[\s\S])*?)<\/p>/i)
        || pick(/<p[^>]*>([\s\S]*?)<\/p>/i),
    ]) {
      if (!t) continue;
      const low = t.toLowerCase();
      // Skip a piece that repeats one already kept ("Internal Server Error"
      // under a title of "500 Internal Server Error"); replace a kept piece
      // that this one contains.
      if (parts.some((p) => p.toLowerCase().includes(low))) continue;
      for (let i = parts.length - 1; i >= 0; i--) {
        if (low.includes(parts[i].toLowerCase())) parts.splice(i, 1);
      }
      parts.push(t);
    }
    const out = parts.join(' — ') || htmlText(body);
    return out ? clip(out, max) : '';
  }
  return clip(body.replace(/\s+/g, ' ').trim(), max);
}

class UpstreamError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.retryAfter = null;   // seconds, when the upstream told us
  }
}

/**
 * Identify ourselves on every outbound request.
 *
 * Node's fetch sends no User-Agent at all. Several of the volunteer-run
 * services here refuse an anonymous client outright — CelesTrak answers 403,
 * Nominatim's policy requires a contactable agent — and the refusal looks
 * like an outage rather than a missing header. Setting it once in grab()
 * covers every call site; a per-call `headers` entry still wins, since the
 * spread below comes last.
 */
const USER_AGENT = `OpenPanopticon (self-hosted OSINT viewer; +${PKG.homepage})`;

async function grab(url, opts = {}, { as = 'json', timeoutMs = 25000, label = 'upstream', onHeaders } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const why = err.name === 'AbortError'
      ? `${label} timed out after ${timeoutMs / 1000}s`
      : `${label} unreachable: ${err.message}`;
    throw new UpstreamError(504, why);
  }
  clearTimeout(timer);

  // Before anything else, including the error path: a refusal carries the
  // rate-limit state that explains it, and that is exactly when it matters.
  try { onHeaders?.(res.headers, res.status); } catch { /* never fail a fetch on bookkeeping */ }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Most of these APIs explain a refusal in the body ("too many queries
    // today", "invalid key"). That is far more useful in the sidebar than a
    // bare status code, so surface it when there is one.
    const reason = refusalReason(body);
    const err = new UpstreamError(res.status,
      `${label} returned HTTP ${res.status}${reason ? `: ${reason}` : ''}`, body.slice(0, 400));
    err.reason = reason;   // the explanation alone, for callers that summarise
    // Retry-After is the standard; OpenSky uses a header of its own and
    // would otherwise have its answer thrown away, leaving the client to
    // guess and keep hammering the limit it had just been told about.
    const ra = res.headers?.get?.('retry-after')
      || res.headers?.get?.('x-rate-limit-retry-after-seconds');
    if (ra) {
      const secs = /^\d+$/.test(String(ra).trim())
        ? Number(String(ra).trim())
        : Math.max(0, Math.round((Date.parse(ra) - Date.now()) / 1000));
      if (Number.isFinite(secs)) err.retryAfter = secs;
    }
    throw err;
  }
  if (as === 'text') return res.text();
  if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError(502, `${label} returned malformed JSON`, text.slice(0, 300));
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function parseBbox(str) {
  // "south,west,north,east"
  const p = String(str || '').split(',').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  let [s, w, n, e] = p;
  if (s > n) [s, n] = [n, s];
  return {
    south: clamp(s, -85, 85), west: clamp(w, -180, 180),
    north: clamp(n, -85, 85), east: clamp(e, -180, 180),
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Approximate country centroids, [lat, lon] by ISO 3166-1 alpha-2.
 * Used only to place country-scale aggregates (Tor relay counts, IODA
 * outage scores) somewhere sensible on the globe — these are label anchors,
 * not geometry, and the UI says so.
 */
const COUNTRY_CENTROIDS = {
  __proto__: null,
  AD: [42.5, 1.5], AE: [24.0, 54.0], AF: [33.0, 65.0], AL: [41.0, 20.0], AM: [40.0, 45.0],
  AO: [-12.5, 18.5], AR: [-34.0, -64.0], AT: [47.3, 13.3], AU: [-25.0, 133.0], AZ: [40.5, 47.5],
  BA: [44.0, 18.0], BD: [24.0, 90.0], BE: [50.8, 4.0], BF: [13.0, -2.0], BG: [43.0, 25.0],
  BH: [26.0, 50.5], BI: [-3.5, 30.0], BJ: [9.5, 2.25], BN: [4.5, 114.7], BO: [-17.0, -65.0],
  BR: [-10.0, -55.0], BS: [24.25, -76.0], BT: [27.5, 90.5], BW: [-22.0, 24.0], BY: [53.0, 28.0],
  BZ: [17.25, -88.75], CA: [60.0, -95.0], CD: [0.0, 25.0], CF: [7.0, 21.0], CG: [-1.0, 15.0],
  CH: [47.0, 8.0], CI: [8.0, -5.0], CL: [-30.0, -71.0], CM: [6.0, 12.0], CN: [35.0, 105.0],
  CO: [4.0, -72.0], CR: [10.0, -84.0], CU: [21.5, -80.0], CY: [35.0, 33.0], CZ: [49.75, 15.5],
  DE: [51.0, 9.0], DJ: [11.5, 43.0], DK: [56.0, 10.0], DO: [19.0, -70.7], DZ: [28.0, 3.0],
  EC: [-2.0, -77.5], EE: [59.0, 26.0], EG: [27.0, 30.0], ER: [15.0, 39.0], ES: [40.0, -4.0],
  ET: [8.0, 38.0], FI: [64.0, 26.0], FJ: [-18.0, 175.0], FR: [46.0, 2.0], GA: [-1.0, 11.75],
  GB: [54.0, -2.0], GE: [42.0, 43.5], GH: [8.0, -2.0], GM: [13.47, -16.57], GN: [11.0, -10.0],
  GQ: [2.0, 10.0], GR: [39.0, 22.0], GT: [15.5, -90.25], GW: [12.0, -15.0], GY: [5.0, -59.0],
  HN: [15.0, -86.5], HR: [45.17, 15.5], HT: [19.0, -72.42], HU: [47.0, 20.0], ID: [-5.0, 120.0],
  IE: [53.0, -8.0], IL: [31.5, 34.75], IN: [20.0, 77.0], IQ: [33.0, 44.0], IR: [32.0, 53.0],
  IS: [65.0, -18.0], IT: [42.83, 12.83], JM: [18.25, -77.5], JO: [31.0, 36.0], JP: [36.0, 138.0],
  KE: [1.0, 38.0], KG: [41.0, 75.0], KH: [13.0, 105.0], KP: [40.0, 127.0], KR: [37.0, 127.5],
  KW: [29.34, 47.66], KZ: [48.0, 68.0], LA: [18.0, 105.0], LB: [33.83, 35.83], LK: [7.0, 81.0],
  LR: [6.5, -9.5], LT: [56.0, 24.0], LU: [49.75, 6.17], LV: [57.0, 25.0], LY: [25.0, 17.0],
  MA: [32.0, -5.0], MD: [47.0, 29.0], ME: [42.0, 19.0], MG: [-20.0, 47.0], MK: [41.83, 22.0],
  ML: [17.0, -4.0], MM: [22.0, 98.0], MN: [46.0, 105.0], MR: [20.0, -12.0], MT: [35.83, 14.58],
  MU: [-20.28, 57.55], MW: [-13.5, 34.0], MX: [23.0, -102.0], MY: [2.5, 112.5], MZ: [-18.25, 35.0],
  NA: [-22.0, 17.0], NE: [16.0, 8.0], NG: [10.0, 8.0], NI: [13.0, -85.0], NL: [52.5, 5.75],
  NO: [62.0, 10.0], NP: [28.0, 84.0], NZ: [-41.0, 174.0], OM: [21.0, 57.0], PA: [9.0, -80.0],
  PE: [-10.0, -76.0], PG: [-6.0, 147.0], PH: [13.0, 122.0], PK: [30.0, 70.0], PL: [52.0, 20.0],
  PR: [18.25, -66.5], PS: [32.0, 35.25], PT: [39.5, -8.0], PY: [-23.0, -58.0], QA: [25.5, 51.25],
  RO: [46.0, 25.0], RS: [44.0, 21.0], RU: [60.0, 100.0], RW: [-2.0, 30.0], SA: [25.0, 45.0],
  SD: [15.0, 30.0], SE: [62.0, 15.0], SG: [1.37, 103.8], SI: [46.12, 14.82], SK: [48.67, 19.5],
  SL: [8.5, -11.5], SN: [14.0, -14.0], SO: [10.0, 49.0], SS: [8.0, 30.0], SV: [13.83, -88.92],
  SY: [35.0, 38.0], TD: [15.0, 19.0], TG: [8.0, 1.17], TH: [15.0, 100.0], TJ: [39.0, 71.0],
  TM: [40.0, 60.0], TN: [34.0, 9.0], TR: [39.0, 35.0], TT: [11.0, -61.0], TW: [23.5, 121.0],
  TZ: [-6.0, 35.0], UA: [49.0, 32.0], UG: [1.0, 32.0], US: [39.5, -98.35], UY: [-33.0, -56.0],
  UZ: [41.0, 64.0], VE: [8.0, -66.0], VN: [16.17, 107.83], YE: [15.0, 48.0], ZA: [-29.0, 24.0],
  ZM: [-15.0, 30.0], ZW: [-20.0, 30.0],
};

function bboxCenter(b) {
  return { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 };
}

/** Approximate radius in km that covers the bbox from its centre. */
function bboxRadiusKm(b) {
  const c = bboxCenter(b);
  const dLat = (b.north - b.south) / 2 * 111.32;
  const dLon = (b.east - b.west) / 2 * 111.32 * Math.cos(c.lat * Math.PI / 180);
  return Math.min(500, Math.max(1, Math.round(Math.hypot(dLat, dLon))));
}

// ---------------------------------------------------------------------------
// SHODAN
// ---------------------------------------------------------------------------

// Lookup tables keyed by request parameters or upstream values are built with
// `__proto__: null`, so only their own keys answer. On an ordinary object a key
// such as "constructor" or "toString" finds an inherited value instead: a
// preset of "constructor" would send Shodan the query "undefined geo:…" and
// spend a credit on it.
const SHODAN_PRESETS = {
  __proto__: null,
  all: {
    label: 'Everything in view',
    query: '',
    note: 'No type filter — every host Shodan has indexed in this area. '
      + 'Points are coloured by service category.',
  },
  ics: {
    label: 'ICS / SCADA',
    query: 'tag:ics',
    note: 'Industrial control systems reachable from the public internet.',
  },
  rdp: {
    label: 'Exposed RDP',
    query: 'port:3389 has_screenshot:false',
    note: 'Remote Desktop endpoints — a top ransomware entry vector.',
  },
  vnc: {
    label: 'Unauthenticated VNC',
    query: 'port:5900 "RFB 003" -"authentication"',
    note: 'VNC services advertising no authentication handshake.',
  },
  databases: {
    label: 'Open databases',
    query: 'product:MongoDB OR product:Elasticsearch OR product:Redis',
    note: 'Document stores and caches answering on the open internet.',
  },
  vulnerable: {
    label: 'Known-CVE hosts',
    query: 'has_vuln:true',
    note: 'Hosts whose banners map to published CVEs.',
  },
  iot: {
    label: 'IoT / embedded',
    query: 'tag:iot',
    note: 'Consumer and embedded devices with a public listener.',
  },
  network: {
    label: 'Network edge gear',
    query: 'product:"MikroTik RouterOS" OR product:"Cisco IOS" OR product:Fortinet',
    note: 'Routers, firewalls and VPN concentrators at the network edge.',
  },
  maritime: {
    label: 'Maritime / AIS',
    query: 'port:10110 OR "AIS" port:2000',
    note: 'AIS receivers and NMEA feeds.',
  },
};

async function shodanSearch({ bbox, preset, custom, minGeo = true }) {
  if (!CFG.shodanKey) {
    throw new UpstreamError(412, 'SHODAN_API_KEY is not set in .env');
  }
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  // A fixed cell, not one sized to the view: zooming must not re-charge for
  // a place already paid for. Before settling on the snapped box, reuse any
  // box already bought that covers this view — see shodanIndex().
  // Shodan has no bbox filter; geo:lat,lon,radius_km is the spatial primitive.
  // With the "all" preset the base is empty and the geo filter stands alone,
  // which Shodan accepts as a valid (credit-consuming) filtered query.
  const presetDef = SHODAN_PRESETS[preset] || SHODAN_PRESETS.all;
  const base = custom && custom.trim() ? custom.trim() : presetDef.query;
  const buildQuery = (box) => {
    const cc = bboxCenter(box);
    const rr = bboxRadiusKm(box);
    return `${base} geo:"${cc.lat.toFixed(4)},${cc.lon.toFixed(4)},${rr}"`.trim();
  };

  let q = snapFixed(b, SHODAN_CELL_DEG, SHODAN_MAX_DEG);
  if (!wantsFresh()) {
    const bought = await findBoughtShodanBox(b, base, (box) => isCached(`shodan:${buildQuery(box)}`, RETAIN['shodan.hosts']));
    if (bought) q = bought;
  }
  const query = buildQuery(q);

  const url = new URL('https://api.shodan.io/shodan/host/search');
  url.searchParams.set('key', CFG.shodanKey);
  url.searchParams.set('query', query);
  url.searchParams.set('minify', 'true');

  // TTL.static, and on disk. Shodan rescans a host over days, so a fresher
  // answer would rarely differ — and every miss spends a query credit, which
  // is the one resource here that cannot be earned back by waiting.
  const key = `shodan:${query}`;
  let fetched = false;
  const raw = await cachedPersistent(key, RETAIN['shodan.hosts'], async () => {
    // About to spend a credit. Stop short of the wall rather than through
    // it: running out mid-session leaves the layer dead until the month
    // rolls over, and the reserve is what a deliberate lookup draws on.
    await assertShodanCredit();
    const out = await grab(url, {}, { label: 'Shodan' });
    fetched = true;
    return out;
  });
  await rememberShodanBox(q, base, fetched);

  const matches = (raw.matches || [])
    .map((m) => {
      const loc = m.location || {};
      if (minGeo && (loc.latitude == null || loc.longitude == null)) return null;
      return {
        ip: m.ip_str,
        lat: loc.latitude,
        lon: loc.longitude,
        city: loc.city || null,
        country: loc.country_name || loc.country_code || null,
        port: m.port,
        transport: m.transport || 'tcp',
        org: m.org || m.isp || null,
        asn: m.asn || null,
        product: m.product || null,
        version: m.version || null,
        os: m.os || null,
        hostnames: m.hostnames || [],
        vulns: m.vulns ? Object.keys(m.vulns) : [],
        tags: m.tags || [],
        timestamp: m.timestamp || null,
        banner: typeof m.data === 'string' ? m.data.slice(0, 900) : null,
        category: serviceCategory(m.port, m.product, m.data),
      };
    })
    .filter(Boolean);

  const byCategory = {};
  for (const m of matches) byCategory[m.category] = (byCategory[m.category] || 0) + 1;

  return {
    query,
    // The cell this answer covers. The browser marks *this* as covered, not
    // the view it happened to ask about, so every zoom and pan inside the
    // cell is served locally instead of being charged again.
    queried: { south: q.south, west: q.west, north: q.north, east: q.east },
    cellDeg: SHODAN_CELL_DEG,
    total: raw.total ?? matches.length,
    returned: matches.length,
    note: custom ? null : presetDef.note,
    byCategory,
    vulnerable: matches.filter((m) => m.vulns.length).length,
    matches,
  };
}

/**
 * Coarse service category for a banner, so the "everything" preset can be
 * colour-coded by what the service *is* rather than only by whether it is
 * known-vulnerable. Port first, then product name.
 */
const PORT_CATEGORY = {
  __proto__: null,
  21: 'file', 22: 'remote', 23: 'remote', 25: 'mail', 53: 'infra',
  80: 'web', 110: 'mail', 143: 'mail', 443: 'web', 445: 'file',
  465: 'mail', 587: 'mail', 993: 'mail', 995: 'mail',
  1433: 'database', 1521: 'database', 3306: 'database', 5432: 'database',
  6379: 'database', 27017: 'database', 9200: 'database', 11211: 'database',
  3389: 'remote', 5900: 'remote', 5901: 'remote', 23023: 'remote',
  102: 'ics', 502: 'ics', 20000: 'ics', 44818: 'ics', 47808: 'ics', 1911: 'ics',
  554: 'camera', 8554: 'camera', 37777: 'camera',
  161: 'infra', 123: 'infra', 179: 'infra', 500: 'infra',
  8080: 'web', 8443: 'web', 8000: 'web',
};

const PRODUCT_CATEGORY = [
  [/modbus|s7|bacnet|dnp3|ethernet\/ip|niagara|codesys|iec-?60870/i, 'ics'],
  [/rtsp|hikvision|dahua|webcam|ip camera|nvr|dvr/i, 'camera'],
  [/mongo|elastic|redis|mysql|postgres|mssql|couch|memcach|cassandra/i, 'database'],
  [/rdp|vnc|ssh|telnet|teamviewer|anydesk/i, 'remote'],
  [/smtp|imap|pop3|exchange|postfix|exim/i, 'mail'],
  [/ftp|smb|samba|nfs|rsync/i, 'file'],
  [/router|switch|mikrotik|cisco|fortinet|pfsense|openwrt|ubiquiti|juniper/i, 'network'],
  [/http|nginx|apache|iis|lighttpd|caddy|tomcat/i, 'web'],
];

function serviceCategory(port, product, data) {
  const hay = `${product || ''} ${String(data || '').slice(0, 200)}`;
  for (const [re, cat] of PRODUCT_CATEGORY) if (re.test(hay)) return cat;
  return PORT_CATEGORY[port] || 'other';
}

async function shodanCredits() {
  if (!CFG.shodanKey) throw new UpstreamError(412, 'SHODAN_API_KEY is not set in .env');
  const url = new URL('https://api.shodan.io/api-info');
  url.searchParams.set('key', CFG.shodanKey);
  return cached('shodan:apiinfo', RETAIN['shodan.credits'], () => grab(url, {}, { label: 'Shodan' }));
}


// How coarse a cell one Shodan query covers. Bigger means fewer credits and
// a wider blast radius per query; 0.25 degrees is roughly 28km, so a city is
// a handful of cells and every zoom level inside one reuses the same answer.
const SHODAN_CELL_DEG = Number(process.env.SHODAN_CELL_DEG || '0.25');

// And the widest box one query will cover. Shodan takes a centre and a
// radius, so an unbounded view becomes an unbounded radius.
const SHODAN_MAX_DEG = Number(process.env.SHODAN_MAX_DEG || '2');

// Stop spending when the account gets this low, leaving a reserve for
// deliberate lookups rather than map panning.
const SHODAN_CREDIT_FLOOR = Number(process.env.SHODAN_CREDIT_FLOOR || '10');

/**
 * Refuse to spend a credit when the account is nearly out.
 *
 * Shodan answers a query with data or with nothing; it does not warn you on
 * the way down. Checking first turns "the layer silently stopped working
 * three weeks ago" into a message that says what happened and what to do.
 */
async function assertShodanCredit() {
  let info;
  try {
    info = await shodanCredits();
  } catch {
    return;   // cannot tell: let the query through rather than block on a hiccup
  }
  const left = Number(info?.query_credits);
  if (!Number.isFinite(left)) return;
  if (left <= SHODAN_CREDIT_FLOOR) {
    const err = new UpstreamError(429,
      `Shodan query credits are down to ${left}, at or below the reserve of `
      + `${SHODAN_CREDIT_FLOOR}. Cached areas still draw normally; new ones are `
      + 'paused so a deliberate lookup still has credits. Raise or clear the '
      + 'reserve with SHODAN_CREDIT_FLOOR in .env.');
    err.retryAfter = null;
    throw err;
  }
}


/** Is the view entirely inside this box? */
function boxContains(outer, b) {
  return outer.south <= b.south && outer.north >= b.north
      && outer.west <= b.west && outer.east >= b.east;
}

/**
 * The boxes Shodan has already been paid for, per query filter.
 *
 * Queries are the minimal whole-cell cover of the view, so a later view that
 * sits inside an earlier, larger box snaps to a different (smaller) box and
 * would be charged again. Keeping a list of what was bought lets that view be
 * answered from the box that already covers it. The list lives in memory and
 * on disk, so it outlasts a restart just as the answers themselves do; an
 * entry is only used while its answer is still cached.
 */
const SHODAN_INDEX_KEY = 'shodan:index';
const SHODAN_INDEX_MAX = 500;
let shodanIdx = null;

async function shodanIndex() {
  if (!shodanIdx) {
    const stored = await readDiskCache(SHODAN_INDEX_KEY, RETAIN['shodan.hosts']);
    // The filter can be a query the operator typed, so the index keeps only
    // a hash of it. Entries saved before that carry it in clear: convert them.
    shodanIdx = (Array.isArray(stored) ? stored : []).map((e) => {
      if (!e || typeof e.base !== 'string') return e;
      const { base, ...rest } = e;
      return { ...rest, baseHash: diskKeyHash(base) };
    });
  }
  const cutoff = Date.now() - RETAIN['shodan.hosts'];
  shodanIdx = shodanIdx.filter((e) => e && e.savedAt > cutoff);
  return shodanIdx;
}

/** The smallest bought box for this filter that covers the view, if any. */
async function findBoughtShodanBox(view, base, stillCached) {
  const hits = (await shodanIndex())
    .filter((e) => e.baseHash === diskKeyHash(base) && boxContains(e, view))
    .sort((x, y) => (x.north - x.south) * (x.east - x.west) - (y.north - y.south) * (y.east - y.west));
  for (const e of hits) {
    const box = { south: e.south, west: e.west, north: e.north, east: e.east, step: e.step };
    if (await stillCached(box)) return box;
  }
  return null;
}

/** Record a box as bought. `fresh` means its answer was just fetched. */
async function rememberShodanBox(q, base, fresh) {
  const idx = await shodanIndex();
  const baseHash = diskKeyHash(base);
  const i = idx.findIndex((e) => e.baseHash === baseHash && e.south === q.south && e.west === q.west
    && e.north === q.north && e.east === q.east);
  if (i >= 0 && !fresh) return;            // already known, nothing new to save
  if (i >= 0) idx.splice(i, 1);
  idx.push({ south: q.south, west: q.west, north: q.north, east: q.east, step: q.step, baseHash, savedAt: Date.now() });
  if (idx.length > SHODAN_INDEX_MAX) idx.splice(0, idx.length - SHODAN_INDEX_MAX);
  await writeDiskCache(SHODAN_INDEX_KEY, idx);
}

/** Is this key already answered, in memory or on disk? */
async function isCached(key, ttlMs) {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return true;
  return (await readDiskCache(key, ttlMs)) !== undefined;
}

// ---------------------------------------------------------------------------
// OPENSKY — live aircraft
// ---------------------------------------------------------------------------

let openSkyToken = { value: null, expires: 0 };

async function openSkyAuthHeader() {
  if (!CFG.openSkyId || !CFG.openSkySecret) return {};
  if (openSkyToken.value && openSkyToken.expires > Date.now() + 30_000) {
    return { Authorization: `Bearer ${openSkyToken.value}` };
  }
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CFG.openSkyId,
    client_secret: CFG.openSkySecret,
  });
  const tok = await grab(
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    { label: 'OpenSky auth' },
  );
  openSkyToken = {
    value: tok.access_token,
    expires: Date.now() + (tok.expires_in || 1800) * 1000,
  };
  return { Authorization: `Bearer ${openSkyToken.value}` };
}

// Squawk codes worth flagging on the HUD.
const SQUAWK_ALERTS = { __proto__: null, '7500': 'HIJACK', '7600': 'RADIO FAIL', '7700': 'EMERGENCY' };

/**
 * OpenSky's credit budget, as the API reports it.
 *
 * The allowance is a daily bucket, not a rate: 400 credits anonymous, 4000
 * authenticated, refilled at UTC midnight. A /states/all call inside 25
 * square degrees costs one. That arithmetic is what caused the 429 — polling
 * every 6 seconds is 600 calls an hour, so a 4000-credit day was spent in
 * under seven hours of having the terminal open, and once spent the layer is
 * dead until the next UTC day.
 *
 * Every response carries X-Rate-Limit-Remaining, so none of this needs
 * guessing: the poll interval is derived from what is actually left and how
 * long it has to last.
 */
const openSky = { remaining: null, limit: null, checkedAt: 0, blockedUntil: 0 };

// Leave this much unspent, so a deliberate look at an area still works after
// a day of the map being left open.
const OPENSKY_FLOOR = Number(process.env.OPENSKY_CREDIT_FLOOR || '60');

/** Seconds until the daily bucket refills (UTC midnight). */
function openSkyRefillSec() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.round((next - now.getTime()) / 1000));
}

function noteOpenSkyHeaders(headers) {
  // A response without the header (an error page, a proxy's 503) says
  // nothing about the budget. Number(null) is 0, which would read as "spent"
  // and block every automatic poll until a manual SYNC.
  const raw = headers?.get?.('x-rate-limit-remaining');
  if (raw == null || String(raw).trim() === '') return;
  const left = Number(raw);
  if (Number.isFinite(left)) {
    openSky.remaining = left;
    openSky.checkedAt = Date.now();
    if (openSky.limit == null || left > openSky.limit) openSky.limit = left;
  }
}

/**
 * How often the browser should ask, given what is left in the bucket.
 *
 * Spreading the remaining credits over the time they have to cover turns "it
 * worked all morning and then stopped" into a map that stays alive all day,
 * updating more slowly as the budget tightens. The feed's own resolution is
 * the floor — polling faster than OpenSky publishes only returns the same
 * positions — and five minutes the ceiling, past which the layer is not
 * really live any more.
 */
function openSkyPollSec(resolutionSec) {
  const floor = resolutionSec + 1;
  const left = openSky.remaining;
  if (!Number.isFinite(left)) return floor;
  const spendable = left - OPENSKY_FLOOR;
  if (spendable <= 0) return 300;
  return clamp(Math.ceil(openSkyRefillSec() / spendable), floor, 300);
}

/**
 * Refuse to spend the last of the budget on an automatic poll.
 *
 * Shodan taught this one: an API that answers with data or with nothing, and
 * never warns you on the way down, turns "the layer stopped working" into a
 * mystery. Saying so costs nothing and keeps a reserve for a deliberate look.
 */
function assertOpenSkyCredit() {
  if (openSky.blockedUntil > Date.now()) {
    const secs = Math.ceil((openSky.blockedUntil - Date.now()) / 1000);
    const err = new UpstreamError(429,
      `OpenSky is rate-limiting this account — ${secs}s to go. `
      + 'Credits refill at 00:00 UTC.');
    err.retryAfter = secs;
    throw err;
  }
  if (Number.isFinite(openSky.remaining) && openSky.remaining <= OPENSKY_FLOOR && !wantsFresh()) {
    const mins = Math.ceil(openSkyRefillSec() / 60);
    const err = new UpstreamError(429,
      `OpenSky credits nearly spent (${openSky.remaining} left, holding ${OPENSKY_FLOOR} `
      + `in reserve). Refills in ${mins} min. SYNC still forces a lookup.`);
    err.retryAfter = Math.min(600, openSkyRefillSec());
    throw err;
  }
}

async function flights({ bbox }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  // Snapped, like every other view-scoped source. Keyed on the raw box this
  // spent a credit on every camera nudge: a 4dp bounding box names a camera
  // position, and no two of them are ever the same.
  const q = viewCell(b, 'flights');

  const url = new URL('https://opensky-network.org/api/states/all');
  url.searchParams.set('lamin', q.south.toFixed(4));
  url.searchParams.set('lomin', q.west.toFixed(4));
  url.searchParams.set('lamax', q.north.toFixed(4));
  url.searchParams.set('lomax', q.east.toFixed(4));
  url.searchParams.set('extended', '1');

  const key = `flights:${q.key}`;
  // OpenSky publishes new state vectors every 5s to authenticated callers and
  // every 10s otherwise. The cache must not outlive that: holding results for
  // longer than the feed's own resolution means a client polling at the right
  // rate still gets the same positions back, and the aircraft appear to crawl.
  const authed = !!(CFG.openSkyId && CFG.openSkySecret);
  const resolutionSec = authed ? 5 : 10;
  const raw = await cached(key, resolutionSec * 1000, async () => {
    assertOpenSkyCredit();
    const headers = await openSkyAuthHeader();
    try {
      return await grab(url, { headers },
        { label: 'OpenSky', onHeaders: noteOpenSkyHeaders });
    } catch (e) {
      // Hold off for as long as OpenSky asked, rather than letting the live
      // poll keep arriving every few seconds into a closed door.
      if (e.status === 429) {
        openSky.remaining = 0;
        openSky.blockedUntil = Date.now() + Math.max(60, (e.retryAfter || 600)) * 1000;
        if (!e.retryAfter) e.retryAfter = 600;
      }
      throw e;
    }
  });

  const CATEGORY = [
    'No info', 'No ADS-B info', 'Light', 'Small', 'Large', 'High-vortex large',
    'Heavy', 'High performance', 'Rotorcraft', 'Glider', 'Lighter-than-air',
    'Parachutist', 'Ultralight', 'Reserved', 'UAV', 'Space vehicle',
    'Emergency vehicle', 'Service vehicle', 'Point obstacle', 'Cluster obstacle',
    'Line obstacle',
  ];

  // OpenSky keeps returning the last known position of an aircraft it has
  // stopped hearing from, so a contact that has landed or dropped out sits
  // frozen on the map looking live. s[3] is when that position was actually
  // measured; the age of it is the only way to tell the two apart.
  const now = raw.time || Math.floor(Date.now() / 1000);
  const STALE_AFTER = 120;      // seconds; beyond this it is not a live track

  const aircraft = (raw.states || [])
    .filter((s) => s[5] != null && s[6] != null)
    .map((s) => ({
      icao24: s[0],
      timePosition: s[3] ?? null,
      ageSec: s[3] != null ? Math.max(0, now - s[3]) : null,
      callsign: (s[1] || '').trim() || null,
      country: s[2],
      lon: s[5],
      lat: s[6],
      baroAlt: s[7],
      onGround: !!s[8],
      velocity: s[9],          // m/s
      heading: s[10],          // deg from north
      verticalRate: s[11],     // m/s
      geoAlt: s[13],
      squawk: s[14],
      alert: SQUAWK_ALERTS[s[14]] || null,
      spi: !!s[15],
      category: CATEGORY[s[17]] || null,
      altitude: s[13] ?? s[7] ?? 0,
    }));

  const live = aircraft.filter((a) => a.ageSec == null || a.ageSec <= STALE_AFTER);

  return {
    time: raw.time,
    count: live.length,
    dropped: aircraft.length - live.length,
    staleAfter: STALE_AFTER,
    // How often it is worth asking again. The client polls on this rather
    // than a hard-coded interval, so the two can never drift apart — and it
    // now reflects the credit budget as well as the feed's resolution, so a
    // long session slows down instead of stopping dead.
    resolutionSec,
    pollSec: openSkyPollSec(resolutionSec),
    credits: Number.isFinite(openSky.remaining) ? openSky.remaining : null,
    creditFloor: OPENSKY_FLOOR,
    covered: q.key,
    authenticated: authed,
    aircraft: live,
  };
}

// ---------------------------------------------------------------------------
// CELESTRAK — orbital elements
// ---------------------------------------------------------------------------

const SAT_GROUPS = {
  __proto__: null,
  'stations': 'Space stations',
  'visual': 'Brightest / naked-eye',
  'last-30-days': 'Recent launches',
  'gps-ops': 'GPS operational',
  'galileo': 'Galileo (EU)',
  'glo-ops': 'GLONASS (RU)',
  'beidou': 'BeiDou (CN)',
  'starlink': 'Starlink',
  'oneweb': 'OneWeb',
  'planet': 'Planet Labs (imaging)',
  'spire': 'Spire (RF / weather)',
  'weather': 'Weather',
  'noaa': 'NOAA',
  'goes': 'GOES',
  'resource': 'Earth resources / imaging',
  'sarsat': 'Search & rescue',
  'dmc': 'Disaster monitoring',
  'tdrss': 'Tracking & data relay',
  'geo': 'Geostationary belt',
  'military': 'Miscellaneous military',
  'radar': 'Radar calibration',
  'cubesat': 'CubeSats',
  'science': 'Space & Earth science',
  'active': 'All active (large)',
};

// CelesTrak refuses a repeat download of a group it has not regenerated yet,
// and signals that with a 403 rather than a 304. That is a "you already have
// the current data" answer, not an outage — so the elements are kept on disk
// and served back when it comes.
const TLE_DIR = path.join(PROVIDERS_DIR, 'tle');
const TLE_STALE_RE = /(has not updated since your last successful download|already have the current data)/i;

function tleCachePath(group) {
  // Group names come from SAT_GROUPS, but build the path defensively anyway.
  return path.join(TLE_DIR, `${group.replace(/[^a-z0-9_-]/gi, '_')}.txt`);
}

async function readCachedTle(group) {
  try {
    const file = tleCachePath(group);
    const [text, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
    return text.trim() ? { text, savedAt: stat.mtime.toISOString() } : null;
  } catch {
    return null;
  }
}

async function writeCachedTle(group, text) {
  try {
    await fsp.mkdir(TLE_DIR, { recursive: true });
    await fsp.writeFile(tleCachePath(group), text, 'utf8');
  } catch (e) {
    log('warn', `could not cache TLEs for ${group}: ${e.message}`);
  }
}

/**
 * Fetch a group's elements, falling back to the last good copy.
 *
 * Returns { text, stale, savedAt }. `stale` means CelesTrak declined to
 * re-send and this came off disk — normal, and the elements are still the
 * current ones, since a refusal is precisely their way of saying so.
 */
async function fetchTle(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'tle');

  try {
    const text = await grab(url, {}, { as: 'text', label: 'CelesTrak', timeoutMs: 30000 });
    if (text.trim() && !/^\s*(No GP data found|Invalid query)/i.test(text)) {
      await writeCachedTle(group, text);
      return { text, stale: false, savedAt: new Date().toISOString() };
    }
    // An empty or "no data" answer: prefer the last good copy, marked stale.
    // With none on disk, pass the answer through and let the caller report it.
    const disk = await readCachedTle(group);
    if (disk) return { text: disk.text, stale: true, savedAt: disk.savedAt };
    return { text, stale: false, savedAt: null };
  } catch (err) {
    const disk = await readCachedTle(group);
    const refusedAsUnchanged = err.status === 403
      && (TLE_STALE_RE.test(err.message || '') || TLE_STALE_RE.test(err.detail || ''));

    if (disk) {
      if (!refusedAsUnchanged) {
        log('warn', `CelesTrak unavailable (${err.message}); serving cached ${group} elements`);
      }
      return { text: disk.text, stale: true, savedAt: disk.savedAt };
    }
    // Nothing on disk: a throttle refusal with no cache is genuinely useless
    // to the caller, so say what it actually means rather than "403", and
    // work out when it is worth asking again.
    if (refusedAsUnchanged) {
      // Their message names the last successful download; the next refresh
      // is two hours after it.
      const when = (`${err.message} ${err.detail || ''}`)
        .match(/(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})\s*UTC/i);
      let retryAfter = null;
      if (when) {
        const last = Date.parse(`${when[1].replace(' ', 'T')}Z`);
        if (Number.isFinite(last)) {
          retryAfter = Math.max(60, Math.round((last + 2 * 60 * 60_000 - Date.now()) / 1000));
        }
      }
      const mins = retryAfter ? Math.ceil(retryAfter / 60) : null;
      const e = new UpstreamError(503,
        `CelesTrak is holding the "${group}" elements until its next two-hourly refresh`
        + (mins ? ` (about ${mins} min away)` : '')
        + ', and no local copy has been saved yet. Once one download succeeds this '
        + 'is cached on disk and stops mattering.');
      e.retryAfter = retryAfter;
      throw e;
    }
    throw err;
  }
}

async function satellites({ group, limit }) {
  const g = SAT_GROUPS[group] ? group : 'stations';
  const cap = clamp(parseInt(limit || '300', 10) || 300, 1, 2000);

  // Memory only, deliberately. TLEs already have their own disk cache in
  // providers/tle, which does something cachedPersistent cannot: when CelesTrak
  // refuses a repeat download it serves the stored elements back and says
  // they are stale. A second disk tier on top would shadow that.
  const { text, stale, savedAt } = await cached(`sat:${g}`, RETAIN['satellites.elements'],
    () => fetchTle(g));

  if (/^\s*(No GP data found|Invalid query)/i.test(text)) {
    throw new UpstreamError(404, `CelesTrak has no group "${g}"`);
  }

  // 3LE: name line, then "1 ..." and "2 ..." — the browser feeds these
  // straight into satellite.js twoline2satrec().
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length);
  const sats = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const [name, l1, l2] = [lines[i], lines[i + 1], lines[i + 2]];
    if (!l1 || !l2 || l1[0] !== '1' || l2[0] !== '2') continue;
    sats.push({
      name: name.trim(),
      norad: parseInt(l2.slice(2, 7), 10),
      classification: l1[7],
      intlDes: l1.slice(9, 17).trim(),
      inclination: parseFloat(l2.slice(8, 16)),
      raan: parseFloat(l2.slice(17, 25)),
      eccentricity: parseFloat(`0.${l2.slice(26, 33).trim()}`),
      meanMotion: parseFloat(l2.slice(52, 63)),
      revNum: parseInt(l2.slice(63, 68), 10),
      tle1: l1,
      tle2: l2,
    });
    if (sats.length >= cap) break;
  }

  return {
    group: g,
    label: SAT_GROUPS[g],
    total: Math.floor(lines.length / 3),
    returned: sats.length,
    stale,
    elementsAt: savedAt,
    satellites: sats,
  };
}

// ---------------------------------------------------------------------------
// OVERPASS — OpenStreetMap infrastructure
// ---------------------------------------------------------------------------

// Public instances, in order of preference. overpass.kumi.systems and
// overpass.private.coffee are the same operator and the same machines under
// two names, so listing both only asked one server twice. A self-hosted
// instance, or one you pay for, goes in OVERPASS_URL (comma-separated, tried
// in order) and replaces these.
const OVERPASS_ENDPOINTS = (process.env.OVERPASS_URL || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
if (!OVERPASS_ENDPOINTS.length) {
  OVERPASS_ENDPOINTS.push(
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  );
}

// ---------------------------------------------------------------------------
// Overpass is a donated, shared service with a small number of execution
// slots per IP. How it counts them is what this code is shaped around:
//
//   - a query holds its slot for its run time PLUS a cool-down afterwards,
//     proportional to that run time (a fraction of it when the server is
//     quiet, a multiple of it when busy);
//   - a request that finds no free slot waits up to 15 s on the server, then
//     gets a 429;
//   - /api/status says exactly when each blocked slot frees up, and asking it
//     costs no slot.
//
// So a fixed 1 s gap between queries was a guaranteed 429 after any heavy
// one, and rotating every mirror on each retry spent 15 s per mirror and
// spread the load the operators ask clients not to spread. Instead each
// mirror carries its own "free at" time: modelled from the run time after a
// success, and read from /api/status after a refusal. The queue waits for
// the first free mirror, briefly, or answers 429 with the real wait at once.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const overpassGate = {
  chain: Promise.resolve(),
  lastStartedAt: 0,
  minGapMs: 1100,
  cooldownUntil: 0,        // global: nobody asks any mirror before this
  consecutive429: 0,       // all mirrors refused, this many times in a row
  mirrors: new Map(),      // endpoint -> { freeAt, strikes }
  // Cool-down modelled after a success, as a multiple of the run time.
  // Overpass's own ratio varies with load; 1.0 matches it under moderate
  // load, and /api/status corrects us whenever we guess short.
  coolFactor: 1.0,
  // Longest a request waits in the queue for a mirror to free up before it
  // is answered with a 429 instead. Kept short: a parked request holds one
  // of the browser's six connections to this server.
  maxInlineWaitMs: 20_000,
};

function overpassMirror(endpoint) {
  let m = overpassGate.mirrors.get(endpoint);
  if (!m) { m = { freeAt: 0, strikes: 0 }; overpassGate.mirrors.set(endpoint, m); }
  return m;
}

/** When the first mirror is free, in preference order, as a timestamp. */
function overpassNextFree() {
  return Math.min(...OVERPASS_ENDPOINTS.map((e) => overpassMirror(e).freeAt));
}

/** Cooldown after the nth refusal in a row: 15 s doubling, capped at 5 min. */
function overpassBackoffMs(n) {
  return Math.min(300_000, 15_000 * 2 ** Math.max(0, n - 1));
}

/** A few seconds of spread, so two retries never land on the same instant. */
const jitterMs = () => Math.floor(Math.random() * 3000);

/**
 * Seconds until a slot is free, from an /api/status page; null if the page
 * is not one (some mirrors don't serve it, or serve something else).
 *
 *   Rate limit: 2
 *   2 slots available now.
 * or
 *   Rate limit: 2
 *   Slot available after: 2026-11-05T20:31:12Z, in 23 seconds.
 */
function parseOverpassStatus(text) {
  if (typeof text !== 'string' || !/Rate limit:/i.test(text)) return null;
  const now = /(\d+)\s+slots?\s+available\s+now/i.exec(text);
  if (now && Number(now[1]) > 0) return 0;
  const waits = [...text.matchAll(/Slot available after:[^\n]*?in\s+(-?\d+)\s+seconds?/gi)]
    .map((m) => Math.max(0, Number(m[1])));
  return waits.length ? Math.min(...waits) : null;
}

/** Ask a mirror how long until it has a slot for us. Never throws. */
async function overpassSlotWait(endpoint) {
  if (!/\/interpreter$/.test(endpoint)) return null;
  try {
    const text = await grab(endpoint.replace(/\/interpreter$/, '/status'), {},
      { as: 'text', timeoutMs: 8000, label: 'Overpass status' });
    return parseOverpassStatus(text);
  } catch {
    return null;
  }
}

/** Run `fn` on the shared Overpass queue, one at a time. */
function overpassQueued(fn) {
  // Captured now, while still inside the request's context.
  const signal = reqCtx.getStore()?.signal;
  const run = overpassGate.chain.then(async () => {
    // The browser gave up (moved on, timed out) while this waited its turn.
    // Its answer would go nowhere, and running it would spend a slot that a
    // view somebody IS looking at needs. Queries already running are left
    // to finish: their results are cached, so those are not wasted.
    if (signal?.aborted) {
      throw new UpstreamError(499, 'Overpass request dropped: the browser stopped waiting for it.');
    }
    const now = Date.now();
    const freeAt = Math.max(overpassGate.cooldownUntil, overpassNextFree());
    // Too long to wait here: answer at once with how long is left rather
    // than parking the request. A request parked for minutes held one of the
    // browser's six connections to this server the whole time, and map
    // tiles queued behind it. The layer's own backoff brings it back.
    if (freeAt - now > overpassGate.maxInlineWaitMs) {
      const secs = Math.ceil((freeAt - now) / 1000);
      const err = new UpstreamError(429,
        `Overpass is cooling down after rate limits — trying again in ${secs}s.`);
      err.retryAfter = secs;
      throw err;
    }
    const wait = Math.max(freeAt - now, overpassGate.lastStartedAt + overpassGate.minGapMs - now, 0);
    if (wait > 0) await sleep(wait);
    if (signal?.aborted) {
      throw new UpstreamError(499, 'Overpass request dropped: the browser stopped waiting for it.');
    }
    overpassGate.lastStartedAt = Date.now();
    return fn();
  });
  // Keep the chain alive regardless of this call's outcome.
  overpassGate.chain = run.then(() => {}, () => {});
  return run;
}

/**
 * POST an Overpass QL query to the first mirror that is free.
 *
 * A mirror still cooling down is skipped, not asked. A 429 asks that
 * mirror's /api/status how long its slots are held and books exactly that,
 * so the next attempt lands when a slot is actually free instead of on an
 * exponential guess. Every mirror is asked at most once per call.
 */
async function overpassQuery(ql, label = 'Overpass') {
  return overpassQueued(async () => {
    let rateLimited = 0;
    let lastErr;
    const failures = [];   // one short line per mirror, for the summary

    for (const endpoint of OVERPASS_ENDPOINTS) {
      const m = overpassMirror(endpoint);
      const cooling = m.freeAt - Date.now();
      if (cooling > 1000) {
        rateLimited++;
        failures.push(`${hostOf(endpoint)}: cooling down ${Math.ceil(cooling / 1000)}s`);
        continue;
      }
      if (cooling > 0) await sleep(cooling);

      const t0 = Date.now();
      try {
        const out = await grab(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
          },
          body: new URLSearchParams({ data: ql }),
        }, { label, timeoutMs: 45000 });

        // The slot is held for a cool-down after we are done with it. Book
        // that, so the next query waits it out here instead of being turned
        // away there.
        const ran = Date.now() - t0;
        m.freeAt = Date.now() + Math.min(60_000, Math.round(ran * overpassGate.coolFactor));
        m.strikes = 0;
        overpassGate.consecutive429 = 0;
        return out;
      } catch (e) {
        lastErr = e;
        failures.push(mirrorFailure(endpoint, e));
        if (e.status === 429) {
          rateLimited++;
          m.strikes++;
          // How long, according to the mirror itself. Retry-After if it sent
          // one, else its status page, else the exponential ladder.
          let secs = e.retryAfter;
          if (secs == null) secs = await overpassSlotWait(endpoint);
          const ms = secs != null ? secs * 1000 + 1000 : overpassBackoffMs(m.strikes);
          m.freeAt = Math.max(m.freeAt, Date.now() + ms + jitterMs());
        } else if (e.status === 504) {
          // Overpass's own 504 is "server too busy for a query this size";
          // ours is a timeout, after which the query still runs there and
          // still holds the slot. Either way that mirror wants a rest.
          rateLimited++;
          m.strikes++;
          m.freeAt = Math.max(m.freeAt, Date.now() + overpassBackoffMs(m.strikes) + jitterMs());
        } else {
          // Down or erroring: try it again later, not on the very next call.
          m.freeAt = Math.max(m.freeAt, Date.now() + 30_000);
        }
      }
    }

    // Nobody would take it. Report when the first of them is free again.
    const retryIn = Math.max(1, Math.ceil((overpassNextFree() - Date.now()) / 1000));

    if (rateLimited === OVERPASS_ENDPOINTS.length) {
      overpassGate.consecutive429++;
      const backoffMs = retryIn * 1000;
      overpassGate.cooldownUntil = Math.max(overpassGate.cooldownUntil, Date.now() + backoffMs);
      const secs = Math.ceil(backoffMs / 1000);
      const err = new UpstreamError(429,
        `Overpass is rate-limiting every mirror — retrying in ${secs}s. `
        + 'Selecting fewer feature classes, or zooming in, reduces the load.',
        failures.join('; '));
      err.retryAfter = secs;
      throw err;
    }

    // Mixed or server-side failures. Saying only what the last mirror said
    // hid the others and made an outage read like a rate limit; list each
    // one briefly instead. These are their faults, not ours, so this is a
    // 502 with a retry rather than a bare 500.
    if (rateLimited) overpassGate.consecutive429++;
    const retry = Math.max(30, lastErr?.retryAfter || 0, retryIn);
    const err = new UpstreamError(502,
      `No Overpass mirror could answer (${failures.join('; ')}). `
      + `This is on their side — retrying in ${retry}s.`,
      lastErr?.detail || null);
    err.retryAfter = retry;
    throw err;
  });
}

function hostOf(endpoint) {
  try { return new URL(endpoint).hostname; } catch { return endpoint; }
}

/** "overpass-api.de: HTTP 500 Internal Server Error", kept short. */
function mirrorFailure(endpoint, e) {
  let host = endpoint;
  try { host = new URL(endpoint).hostname; } catch { /* keep as is */ }
  let what;
  if (/timed out/i.test(e.message)) what = 'timed out';
  else if (/unreachable/i.test(e.message)) what = 'unreachable';
  else if (e.status) {
    // First clause of the reason only; the full text is in the detail.
    // Overpass's own errors are long internal traces; name the gist.
    const r = e.status === 429 ? 'rate-limited'
      : /too busy|timeout|load/i.test(e.reason || '') ? 'server busy'
      : (e.reason || '').split(/ — |\. /)[0].replace(/^\d{3}\s+/, '');
    what = `HTTP ${e.status}${r ? ` ${clip(r, 60)}` : ''}`;
  } else what = clip(e.message, 60);
  return `${host}: ${what}`;
}

// Each preset carries both its Overpass clauses and a predicate over the
// returned tags. The clauses are unioned into a single query; the predicate
// is what assigns each returned element back to the class it came from.
const OVERPASS_PRESETS = {
  __proto__: null,
  surveillance: {
    label: 'Surveillance cameras',
    color: '#ff4d6d',
    body: (bb) => `nwr["man_made"="surveillance"](${bb});`,
    match: (t) => t.man_made === 'surveillance',
  },
  military: {
    label: 'Military sites',
    color: '#ff9f1c',
    body: (bb) => `nwr["landuse"="military"](${bb});nwr["military"](${bb});`,
    match: (t) => t.landuse === 'military' || t.military != null,
  },
  comms: {
    label: 'Comms towers',
    color: '#4cc9f0',
    body: (bb) => `nwr["man_made"="communications_tower"](${bb});nwr["tower:type"="communication"](${bb});`,
    match: (t) => t.man_made === 'communications_tower' || t['tower:type'] === 'communication',
  },
  power: {
    label: 'Power infrastructure',
    color: '#ffd166',
    body: (bb) => `nwr["power"="plant"](${bb});nwr["power"="substation"](${bb});`,
    match: (t) => t.power === 'plant' || t.power === 'substation',
  },
  aviation: {
    label: 'Airfields & helipads',
    color: '#a0e548',
    body: (bb) => `nwr["aeroway"="aerodrome"](${bb});nwr["aeroway"="helipad"](${bb});`,
    match: (t) => t.aeroway === 'aerodrome' || t.aeroway === 'helipad',
  },
  maritime: {
    label: 'Ports & harbours',
    color: '#00b4d8',
    body: (bb) => `nwr["industrial"="port"](${bb});nwr["harbour"="yes"](${bb});nwr["landuse"="harbour"](${bb});`,
    match: (t) => t.industrial === 'port' || t.harbour === 'yes' || t.landuse === 'harbour',
  },
  government: {
    label: 'Government & diplomatic',
    color: '#c77dff',
    body: (bb) => `nwr["office"="government"](${bb});nwr["amenity"="embassy"](${bb});nwr["office"="diplomatic"](${bb});`,
    match: (t) => t.office === 'government' || t.amenity === 'embassy' || t.office === 'diplomatic',
  },
  emergency: {
    label: 'Police, fire & hospital',
    color: '#ef476f',
    body: (bb) => `nwr["amenity"="police"](${bb});nwr["amenity"="fire_station"](${bb});nwr["amenity"="hospital"](${bb});`,
    match: (t) => t.amenity === 'police' || t.amenity === 'fire_station' || t.amenity === 'hospital',
  },
  datacenter: {
    label: 'Data centres',
    color: '#06d6a0',
    body: (bb) => `nwr["telecom"="data_center"](${bb});nwr["building"="data_center"](${bb});`,
    match: (t) => t.telecom === 'data_center' || t.building === 'data_center',
  },
  fuel: {
    label: 'Fuel & storage tanks',
    color: '#f4a261',
    body: (bb) => `nwr["man_made"="storage_tank"](${bb});nwr["landuse"="depot"](${bb});`,
    match: (t) => t.man_made === 'storage_tank' || t.landuse === 'depot',
  },
};

/**
 * Overpass elements for a snapped box, cached per grid cell and per class.
 *
 * Keying the cache on the whole view box meant an answer was only reused for
 * exactly that box: any other zoom or pan after a restart made a new key,
 * and ground already fetched (and on disk) was asked for again. Instead the
 * box is split into its 0.125° cells, and each (class, cell) pair is stored
 * on its own. A view is assembled from whatever pairs are already held, in
 * memory or on disk, and only the missing ones are queried: one query, over
 * the smallest box around the missing cells, for the missing classes. Every
 * cell inside that box is then complete for those classes and is stored.
 *
 * An answer the cap truncated is incomplete, so its cells are kept in memory
 * for an hour only and never written to disk, where they would stand in for
 * the full answer for days.
 */
function overpassCellsOf(box) {
  const step = box.step;
  const r = (v) => Number(v.toFixed(4));
  const cells = [];
  for (let s = box.south; s < box.north - 1e-9; s = r(s + step)) {
    for (let w = box.west; w < box.east - 1e-9; w = r(w + step)) {
      const c = { south: s, west: w, north: r(s + step), east: r(w + step) };
      c.key = `${c.south},${c.west},${c.north},${c.east}`;
      cells.push(c);
    }
  }
  return cells;
}

const overpassCellKey = (cls, cell) => `overpass-cell:${cls}:${cell.key}`;

/** A cached value without producing one: memory, then disk. */
async function peekCached(key, ttlMs) {
  if (wantsFresh()) return undefined;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) { remember(key, hit); return hit.value; }
  const disk = await readDiskCache(key, ttlMs);
  if (disk !== undefined) remember(key, { expires: Date.now() + ttlMs, value: disk });
  return disk;
}

/**
 * `classes` is a list of { key, body(bbox) -> QL clauses, match(tags) }: the
 * infrastructure presets, or the ALPR layer's single class. `key` names the
 * class in the cache, so it must be unique across every caller.
 */
// The most elements one Overpass query may return. Generous on purpose: an
// answer that reaches it is incomplete, cannot be stored for long, and gets
// asked for again, so a cap sized for drawing (the browser's 800) made dense
// areas re-query every hour. Past this the area is split and asked in parts.
const overpassLimits = {   // an object so tests can lower it
  queryCap: 4000,
  cellBudget: 32,      // cells x classes one query may cover (see overpassMaxCells)
  minCells: 4,
  timeoutSec: 30,
  maxsize: 128 * 1024 * 1024,
};

async function overpassCells(box, classes, cap, label = 'Overpass', ttl = RETAIN['overpass.infrastructure'], centre = null) {
  const byKey = new Map(classes.map((c) => [c.key, c]));
  const chosen = classes.map((c) => c.key);
  const cells = overpassCellsOf(box);
  const held = new Map();   // pair key -> { elements, truncated }
  const missing = [];
  let partial = null;
  await Promise.all(chosen.flatMap((p) => cells.map(async (c) => {
    const k = overpassCellKey(p, c);
    const v = await peekCached(k, ttl);
    if (v && Array.isArray(v.elements)) held.set(k, v);
    else missing.push({ p, c });
  })));

  if (missing.length) {
    const presets = chosen.filter((p) => missing.some((m) => m.p === p));
    const need = [...new Map(missing.map((m) => [m.c.key, m.c])).values()];
    log('info', `${label}: ${need.length} of ${cells.length} cells not cached (${presets.join(', ')}) — querying`);
    const at = centre || { lat: (box.south + box.north) / 2, lon: (box.west + box.east) / 2 };
    try {
      await overpassFetchCells(need, presets, byKey, box.step, label, ttl, held, at);
    } catch (e) {
      // A view is fetched in parts, one after another, and a refusal can
      // land part-way through. Throwing then discarded every part already in
      // hand — and the cells that were cached before this request even
      // started — so a busy Overpass showed nothing at all. Return what there
      // is, say it is partial, and let the browser ask for the rest later.
      if (!(e instanceof UpstreamError)) throw e;
      if (held.size === 0) throw e;
      partial = { error: e, retryAfter: e.retryAfter ?? 30 };
    }
  }

  // Assemble the view, each element once however many classes or cells
  // brought it in.
  const seen = new Set();
  const elements = [];
  let truncated = false;
  for (const p of chosen) {
    for (const c of cells) {
      const v = held.get(overpassCellKey(p, c));
      if (!v) continue;
      if (v.truncated) truncated = true;
      for (const el of v.elements) {
        const id = `${el.type}/${el.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        elements.push(el);
      }
    }
  }
  if (!partial) return { elements, truncated };
  const pending = cells.filter((c) => chosen.some((p) => !held.has(overpassCellKey(p, c)))).length;
  return {
    elements, truncated,
    partial: true,
    cells: cells.length,
    missing: pending,
    retryAfter: partial.retryAfter,
    reason: partial.error.message,
  };
}

/**
 * Query a set of cells for some classes, and store each cell. If the answer
 * reaches overpassLimits.queryCap it is incomplete, so the cells are split in two
 * along the longer side and each half asked separately, down to single
 * cells. Every complete part is stored as soon as it arrives, so a rate
 * limit part-way through keeps what was already fetched, and the next
 * request only asks for the rest.
 */
/**
 * Cells known to be too dense to share a query: an answer that covered them
 * reached the cap. Asking for them again in a group would run the same
 * heavy query, hit the same cap and be thrown away before the split — the
 * most expensive way to get nothing, and over somewhere like Manhattan it is
 * what tipped every retry into a 429. Remembered per class set, in memory.
 */
const overpassDense = new Map();   // `${presets}|${cell}` -> expires
const OVERPASS_DENSE_MS = 24 * 60 * 60_000;
const denseKey = (presets, c) => `${presets.join(',')}|${c.key}`;
function isDense(presets, c) {
  const t = overpassDense.get(denseKey(presets, c));
  if (t && t > Date.now()) return true;
  if (t) overpassDense.delete(denseKey(presets, c));
  return false;
}

/**
 * The most cells one query may cover. Cost on the server scales with area
 * times the number of classes, so the more classes, the smaller the box:
 * one class (ALPR) may take 32 cells, all ten take 4.
 */
function overpassMaxCells(presets) {
  return Math.max(overpassLimits.minCells, Math.floor(overpassLimits.cellBudget / Math.max(1, presets.length)));
}

/** Two halves along the longer side; null if they cannot be separated. */
function splitCells(need) {
  const s = Math.min(...need.map((c) => c.south)), n = Math.max(...need.map((c) => c.north));
  const w = Math.min(...need.map((c) => c.west)), e = Math.max(...need.map((c) => c.east));
  const wide = e - w >= n - s;
  const mid = wide ? (w + e) / 2 : (s + n) / 2;
  const a = need.filter((c) => (wide ? c.west < mid : c.south < mid));
  const b = need.filter((c) => !a.includes(c));
  return a.length && b.length ? [a, b] : null;
}

/** Parts nearest a point first: the middle of the view arrives first. */
function nearestPartsFirst(parts, at) {
  if (!at) return parts;
  const d = (part) => {
    const lat = part.reduce((a, c) => a + (c.south + c.north) / 2, 0) / part.length;
    const lon = part.reduce((a, c) => a + (c.west + c.east) / 2, 0) / part.length;
    return (lat - at.lat) ** 2 + ((lon - at.lon) * Math.cos((at.lat * Math.PI) / 180)) ** 2;
  };
  return [...parts].sort((a, b) => d(a) - d(b));
}

async function overpassFetchCells(need, presets, byKey, step, label, ttl, held, at = null) {
  // Split BEFORE asking when the box is bigger than one query should cover,
  // or holds a cell already known to overflow the cap.
  if (need.length > 1
      && (need.length > overpassMaxCells(presets) || need.some((c) => isDense(presets, c)))) {
    const parts = splitCells(need);
    if (parts) {
      for (const part of nearestPartsFirst(parts, at)) {
        await overpassFetchCells(part, presets, byKey, step, label, ttl, held, at);
      }
      return;
    }
  }

  const qb = {
    south: Math.min(...need.map((c) => c.south)), west: Math.min(...need.map((c) => c.west)),
    north: Math.max(...need.map((c) => c.north)), east: Math.max(...need.map((c) => c.east)),
    step,
  };
  const bb = `${qb.south},${qb.west},${qb.north},${qb.east}`;
  const clauses = presets.map((k) => byKey.get(k).body(bb)).join('');
  // Declared limits are what Overpass admits a query on: it must fit in half
  // the server's remaining time and memory, else a 504. The defaults (180 s,
  // 512 MiB) are far more than a few cells need, and a smaller claim gets in
  // when the server is busy and a large one does not.
  const ql = `[out:json][timeout:${overpassLimits.timeoutSec}][maxsize:${overpassLimits.maxsize}];`
    + `(${clauses});out center ${overpassLimits.queryCap};`;
  // Memory-only, briefly: joins a duplicate request already in flight.
  const raw = await cached(`overpass-q:${ql}`, 60_000, () => overpassQuery(ql, label));
  const elements = raw.elements || [];
  const full = elements.length >= overpassLimits.queryCap;

  if (full) {
    for (const c of need) overpassDense.set(denseKey(presets, c), Date.now() + OVERPASS_DENSE_MS);
  }
  if (full && need.length > 1) {
    const parts = splitCells(need);
    // Degenerate split (all on one side): fall through and store as truncated.
    if (parts) {
      log('info', `${label}: ${need.length} cells came back over ${overpassLimits.queryCap} elements — asking in two parts`);
      for (const part of nearestPartsFirst(parts, at)) {
        await overpassFetchCells(part, presets, byKey, step, label, ttl, held, at);
      }
      return;
    }
  }

  // Sort the answer into cells by each element's point (its centre, for
  // ways), and into every class it belongs to. Every cell inside the query
  // box is complete for these classes, so all of them are stored.
  const inBox = overpassCellsOf(qb);
  const bucket = new Map(presets.flatMap((p) => inBox.map((c) => [overpassCellKey(p, c), []])));
  const cols = Math.round((qb.east - qb.west) / qb.step);
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const iy = Math.floor((lat - qb.south) / qb.step);
    const ix = Math.floor((lon - qb.west) / qb.step);
    const c = inBox[iy * cols + ix];
    if (!c || ix < 0 || ix >= cols) continue;
    const t = el.tags || {};
    for (const p of presets) {
      let ok = false;
      try { ok = byKey.get(p).match(t); } catch { /* not this class */ }
      if (ok) bucket.get(overpassCellKey(p, c)).push(el);
    }
  }
  for (const [k, list] of bucket) {
    // Only a single cell can still be full here; it is held in memory only.
    const value = { elements: list, truncated: full };
    if (full) {
      remember(k, { expires: Date.now() + RETAIN['overpass.truncated'], value });
    } else {
      remember(k, { expires: Date.now() + ttl, value });
      await writeDiskCache(k, value);
    }
    held.set(k, value);
  }
}

/** What a partly fetched answer tells the browser, or nothing if complete. */
function partialFields(raw) {
  if (!raw.partial) return {};
  return {
    partial: true,
    cells: raw.cells,
    missing: raw.missing,
    retryAfter: raw.retryAfter,
    partialReason: raw.reason,
  };
}

/**
 * Keep the `cap` features nearest the middle of a box, for drawing. The
 * cache holds everything; this only limits what one answer sends.
 */
function nearestFirst(items, b, cap) {
  if (items.length <= cap) return items;
  const lat = (b.south + b.north) / 2;
  const lon = (b.west + b.east) / 2;
  const k = Math.cos((lat * Math.PI) / 180);
  const d = (f) => (f.lat - lat) ** 2 + ((f.lon - lon) * k) ** 2;
  return items.map((f) => [d(f), f]).sort((x, y) => x[0] - y[0]).slice(0, cap).map((x) => x[1]);
}

/**
 * Fetch several feature classes in ONE Overpass query.
 *
 * One request per class would mean ten simultaneous requests to a service
 * that allows about two, a guaranteed 429. Overpass unions natively, so all
 * selected classes go out as one query and are partitioned on the way back
 * using each preset's tag predicate.
 */
async function overpass({ bbox, presets, preset, limit }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  const requested = (presets || preset || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (!requested.length) throw new UpstreamError(400, 'presets required');

  const unknown = requested.filter((p) => !OVERPASS_PRESETS[p]);
  if (unknown.length) throw new UpstreamError(400, `unknown preset "${unknown[0]}"`);

  // Order by the canonical preset list, not alphabetically and not by the
  // order the client happened to send. That keeps the cache key stable AND
  // makes "primary class" predictable: a military airfield attributes to
  // military because military is defined before aviation.
  const order = Object.keys(OVERPASS_PRESETS);
  const chosen = [...new Set(requested)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const cap = clamp(parseInt(limit || '800', 10) || 800, 1, 3000);
  // Query the snapped cell, not the literal view: neighbouring views then
  // share one Overpass slot instead of each taking their own.
  const q = viewCell(b, 'overpass');
  const bb = q.key;

  // TTL.static. Mapped infrastructure — masts, substations, cameras — changes
  // on the order of weeks, and Overpass is donated capacity.
  const raw = await overpassCells(q,
    chosen.map((k) => ({ key: k, body: OVERPASS_PRESETS[k].body, match: OVERPASS_PRESETS[k].match })), cap,
    'Overpass', RETAIN['overpass.infrastructure'],
    { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 });

  const byPreset = Object.fromEntries(chosen.map((k) => [k, 0]));
  const features = [];

  for (const el of raw.elements || []) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const t = el.tags || {};

    // An element can satisfy more than one class (a military airfield, say).
    // Attribute it to the first selected class that claims it, but record
    // them all so the detail panel can be honest about it.
    const matched = chosen.filter((k) => {
      try { return OVERPASS_PRESETS[k].match(t); } catch { return false; }
    });
    if (!matched.length) continue;

    const primary = matched[0];
    byPreset[primary]++;
    features.push({
      id: `${el.type}/${el.id}`,
      lat, lon,
      name: t.name || t['name:en'] || null,
      tags: t,
      preset: primary,
      presets: matched,
      presetLabel: OVERPASS_PRESETS[primary].label,
      color: OVERPASS_PRESETS[primary].color,
      kind: t.man_made || t.military || t.power || t.aeroway || t.amenity
            || t.office || t.telecom || t.landuse || el.type,
    });
  }

  // The cache holds everything; one answer sends at most `cap` to draw, the
  // ones nearest the middle of the view.
  const shown = nearestFirst(features, b, cap);
  if (shown.length < features.length) {
    for (const k of chosen) byPreset[k] = 0;
    for (const f of shown) byPreset[f.preset]++;
  }

  return {
    presets: chosen,
    byPreset,
    colors: Object.fromEntries(chosen.map((k) => [k, OVERPASS_PRESETS[k].color])),
    labels: Object.fromEntries(chosen.map((k) => [k, OVERPASS_PRESETS[k].label])),
    count: shown.length,
    truncated: raw.truncated || shown.length < features.length,
    // The ground this answer actually covers, which is the snapped cell and
    // not the box the browser asked for. Telling it lets it record coverage
    // from what was fetched instead of guessing from what it requested — and
    // the cell is the larger of the two, so panning stays inside it.
    // A partial answer covers only some of the cell, so it claims none of
    // it: the browser must come back for the rest.
    covered: raw.partial ? null : bb,
    ...partialFields(raw),
    trimmed: q.trimmed || false,
    features: shown,
  };
}

// ---------------------------------------------------------------------------
// AIS — live vessel positions
//
// AISStream is a websocket feed, not a request/response API, and it forbids
// direct browser connections. So this process holds one socket, keeps an
// in-memory table of the most recent report per MMSI, and serves that table
// over REST like every other layer. The subscription follows the camera:
// when the view moves far enough, the bounding box is re-sent.
//
// Node 22 has a global WebSocket, so this still needs no dependencies.
// ---------------------------------------------------------------------------

const VESSEL_TTL_MS = 15 * 60_000;   // drop a vessel after 15 min of silence

const SHIP_TYPES = [
  [20, 29, 'Wing in ground'], [30, 30, 'Fishing'], [31, 32, 'Towing'],
  [33, 35, 'Dredging / military ops'], [36, 36, 'Sailing'], [37, 37, 'Pleasure craft'],
  [40, 49, 'High-speed craft'], [50, 50, 'Pilot vessel'], [51, 51, 'Search & rescue'],
  [52, 52, 'Tug'], [53, 53, 'Port tender'], [54, 54, 'Anti-pollution'],
  [55, 55, 'Law enforcement'], [58, 58, 'Medical transport'], [59, 59, 'Special craft'],
  [60, 69, 'Passenger'], [70, 79, 'Cargo'], [80, 89, 'Tanker'], [90, 99, 'Other'],
];

const shipTypeName = (n) => {
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const [lo, hi, label] of SHIP_TYPES) if (n >= lo && n <= hi) return label;
  return 'Unknown';
};

const NAV_STATUS = [
  'Under way (engine)', 'At anchor', 'Not under command', 'Restricted manoeuvrability',
  'Constrained by draught', 'Moored', 'Aground', 'Fishing', 'Under way (sailing)',
  'Reserved (HSC)', 'Reserved (WIG)', 'Towing astern', 'Pushing ahead',
  'Reserved', 'AIS-SART', 'Undefined',
];

const ais = {
  socket: null,
  status: 'idle',          // idle | connecting | open | error | disabled
  error: null,
  vessels: new Map(),      // mmsi -> record
  bbox: null,
  connectedAt: null,
  messages: 0,
  unreadable: 0,           // frames that could not be decoded as JSON
  views: new Map(),        // box key -> { b, at }: every view asking lately
  reconnectDelay: 2000,
  reconnectTimer: null,
};

// The subscription is one per process, but several browsers (or tabs) can be
// watching different places. Following whichever asked last made two viewers
// steal it from each other on every poll, and each got almost nothing.
// AISStream takes several boxes in one subscription, so keep every view
// that asked recently and subscribe to all of them.
const AIS_VIEW_TTL_MS = 3 * 60_000;
const AIS_MAX_BOXES = 8;

/** Note a view that wants vessels. True if the subscription should change. */
function aisNoteView(b) {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of ais.views) {
    if (now - v.at > AIS_VIEW_TTL_MS) { ais.views.delete(k); changed = true; }
  }
  const same = [...ais.views.values()].find((v) => !boxMovedEnough(v.b, b));
  if (same) { same.at = now; return changed; }
  ais.views.set(`${b.south},${b.west},${b.north},${b.east}`, { b, at: now });
  while (ais.views.size > AIS_MAX_BOXES) ais.views.delete(ais.views.keys().next().value);
  return true;
}

function aisBoxesFor(b) {
  // AISStream wants [[[north, west], [south, east]]].
  return [[[b.north, b.west], [b.south, b.east]]];
}

function aisSubscribe(b) {
  if (!ais.socket || ais.socket.readyState !== 1) return;
  const views = [...ais.views.values()].map((v) => v.b);
  const boxes = views.length ? views : [b || ais.bbox || { south: -90, west: -180, north: 90, east: 180 }];
  ais.socket.send(JSON.stringify({
    APIKey: CFG.aisKey,
    BoundingBoxes: boxes.flatMap(aisBoxesFor),
    FilterMessageTypes: ['PositionReport', 'ShipStaticData', 'StandardClassBPositionReport'],
  }));
  ais.bbox = b || boxes[boxes.length - 1];
}

// AISStream sends its JSON in *binary* frames. Node's WebSocket hands those
// over as a Blob unless told otherwise, and String(blob) is "[object Blob]",
// so every message was counted, failed to parse, and was dropped without a
// word: a live stream that never produced a single vessel. Asking for
// ArrayBuffers and decoding them fixes that; text frames and Blobs (another
// runtime, a changed default) are still handled.
const aisDecoder = new TextDecoder();

function aisHandleFrame(data) {
  if (typeof data === 'string') return aisHandleText(data);
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return aisHandleText(aisDecoder.decode(data));
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.text().then(aisHandleText, () => { ais.unreadable++; });
  }
  ais.unreadable++;
}

function aisHandleText(text) {
  let msg;
  try { msg = JSON.parse(text); } catch {
    ais.unreadable++;
    // Say so once, loudly, rather than counting silently forever.
    if (ais.unreadable === 20 && ais.vessels.size === 0) {
      log('warn', `AIS: 20 messages could not be read (first: ${clip(String(text), 80)})`);
    }
    return;
  }
  // A refused subscription (bad key, malformed box) is a JSON {"error": ...}
  // followed by a close. It has no MMSI, so it used to vanish in aisIngest.
  if (msg && typeof msg.error === 'string') {
    ais.error = `AISStream: ${msg.error}`;
    log('warn', ais.error);
    return;
  }
  aisIngest(msg);
}

function aisConnect(b) {
  if (!CFG.aisKey) { ais.status = 'disabled'; return; }
  const changed = b ? aisNoteView(b) : false;
  if (ais.socket && (ais.socket.readyState === 0 || ais.socket.readyState === 1)) {
    // Already up — resubscribe only if the set of views changed materially.
    if (changed) aisSubscribe(b);
    return;
  }
  if (typeof WebSocket === 'undefined') {
    ais.status = 'error';
    ais.error = 'this Node build has no global WebSocket (needs Node 22+)';
    return;
  }

  ais.status = 'connecting';
  ais.error = null;
  const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
  ws.binaryType = 'arraybuffer';
  ais.socket = ws;

  ws.addEventListener('open', () => {
    ais.status = 'open';
    ais.connectedAt = Date.now();
    ais.reconnectDelay = 2000;
    aisSubscribe(b || ais.bbox || { south: -90, west: -180, north: 90, east: 180 });
    log('info', 'AIS stream connected');
  });

  ws.addEventListener('message', (ev) => {
    ais.messages++;
    aisHandleFrame(ev.data);
  });

  ws.addEventListener('error', () => {
    ais.status = 'error';
    ais.error = 'websocket error (check AISSTREAM_API_KEY)';
  });

  ws.addEventListener('close', () => {
    ais.socket = null;
    if (ais.status !== 'disabled') {
      ais.status = 'closed';
      clearTimeout(ais.reconnectTimer);
      // Back off so a bad key doesn't turn into a reconnect storm.
      ais.reconnectTimer = setTimeout(() => aisConnect(ais.bbox), ais.reconnectDelay);
      ais.reconnectDelay = Math.min(ais.reconnectDelay * 2, 60_000);
    }
  });
}

function boxMovedEnough(a, b) {
  return Math.abs(a.south - b.south) > 0.25 || Math.abs(a.west - b.west) > 0.25
      || Math.abs(a.north - b.north) > 0.25 || Math.abs(a.east - b.east) > 0.25;
}

function aisIngest(msg) {
  const meta = msg.MetaData || {};
  const mmsi = String(meta.MMSI ?? meta.MMSI_String ?? '').trim();
  if (!mmsi) return;

  const prev = ais.vessels.get(mmsi) || { mmsi };
  const type = msg.MessageType;
  const body = msg.Message?.[type] || {};

  if (type === 'PositionReport' || type === 'StandardClassBPositionReport') {
    const lat = body.Latitude ?? meta.latitude;
    const lon = body.Longitude ?? meta.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    Object.assign(prev, {
      lat, lon,
      sog: body.Sog ?? null,                       // speed over ground, knots
      cog: body.Cog ?? null,                       // course over ground
      heading: body.TrueHeading != null && body.TrueHeading < 360 ? body.TrueHeading : null,
      rot: body.RateOfTurn ?? null,
      navStatus: Number.isInteger(body.NavigationalStatus)
        ? (NAV_STATUS[body.NavigationalStatus] || null) : prev.navStatus ?? null,
      classB: type === 'StandardClassBPositionReport',
      updated: Date.now(),
    });
  } else if (type === 'ShipStaticData') {
    Object.assign(prev, {
      name: (body.Name || '').trim() || prev.name || null,
      callSign: (body.CallSign || '').trim() || prev.callSign || null,
      imo: body.ImoNumber || prev.imo || null,
      shipType: body.Type ?? prev.shipType ?? null,
      shipTypeName: shipTypeName(body.Type) || prev.shipTypeName || null,
      destination: (body.Destination || '').trim() || prev.destination || null,
      draught: body.MaximumStaticDraught ?? prev.draught ?? null,
      dimension: body.Dimension || prev.dimension || null,
      eta: body.Eta || prev.eta || null,
      updated: Date.now(),
    });
  } else return;

  if (!prev.name && meta.ShipName) prev.name = String(meta.ShipName).trim();
  ais.vessels.set(mmsi, prev);
}

/** Drop stale contacts so a long-running session doesn't grow without bound. */
setInterval(() => {
  const cutoff = Date.now() - VESSEL_TTL_MS;
  for (const [mmsi, v] of ais.vessels) if ((v.updated || 0) < cutoff) ais.vessels.delete(mmsi);
}, 60_000).unref?.();

async function vessels({ bbox }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  if (!CFG.aisKey) {
    throw new UpstreamError(412,
      'AISSTREAM_API_KEY is not set in .env — get a free key at aisstream.io');
  }

  aisConnect(b);

  const list = [];
  for (const v of ais.vessels.values()) {
    if (v.lat == null || !inBox(b, v.lat, v.lon)) continue;
    const dim = v.dimension || {};
    list.push({
      ...v,
      length: (dim.A ?? 0) + (dim.B ?? 0) || null,
      beam: (dim.C ?? 0) + (dim.D ?? 0) || null,
      ageSeconds: Math.round((Date.now() - (v.updated || 0)) / 1000),
    });
  }
  list.sort((a, b2) => (b2.sog || 0) - (a.sog || 0));

  const byType = {};
  for (const v of list) byType[v.shipTypeName || 'Unidentified'] =
    (byType[v.shipTypeName || 'Unidentified'] || 0) + 1;

  return {
    count: list.length,
    tracked: ais.vessels.size,
    byType,
    stream: {
      status: ais.status,
      error: ais.error,
      messages: ais.messages,
      unreadable: ais.unreadable,
      watching: ais.views.size,
      uptimeSeconds: ais.connectedAt ? Math.round((Date.now() - ais.connectedAt) / 1000) : 0,
      // The feed needs a moment after subscribing before anything arrives.
      warmingUp: ais.status === 'open' && list.length === 0 && ais.messages < 5,
    },
    vessels: list.slice(0, 2000),
  };
}

// ---------------------------------------------------------------------------
// ALPR — automated licence-plate readers (Flock Safety and friends)
//
// DeFlock (deflock.org) is the crowdsourced project that maps these, and it
// stores its data *in OpenStreetMap* rather than a private database, so the
// authoritative source is Overpass — no key, no scraping, and community edits
// show up here as soon as they are accepted upstream.
//
// Tagging per the OSM wiki: man_made=surveillance + surveillance:type=ALPR,
// with manufacturer="Flock Safety" (wikidata Q108485435), direction in
// degrees clockwise from north, surveillance:zone, camera:mount, electricity.
// ---------------------------------------------------------------------------

const ALPR_VENDORS = [
  { key: 'flock',    label: 'Flock Safety',        color: '#ff3b6b', match: /flock/i },
  { key: 'motorola', label: 'Motorola / Vigilant', color: '#ffa657', match: /motorola|vigilant|pips/i },
  { key: 'genetec',  label: 'Genetec / AutoVu',    color: '#7ee787', match: /genetec|autovu/i },
  { key: 'leonardo', label: 'Leonardo / Elsag',    color: '#c77dff', match: /leonardo|elsag|selex/i },
  { key: 'axis',     label: 'Axis Communications', color: '#4cc9f0', match: /axis/i },
  { key: 'neology',  label: 'Neology / PIPS',      color: '#f9c74f', match: /neology/i },
  { key: 'other',    label: 'Other / unlabelled',  color: '#8b949e', match: null },
];

const COMPASS = {
  __proto__: null,
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

/**
 * OSM `direction` is messy in the wild: plain degrees ("265"), compass points
 * ("NNE"), and semicolon-separated multi-value for dual-lens units ("350;500")
 * — where out-of-range members like 500 are simply bad data. Return every
 * valid bearing and drop the rest rather than rendering a cone pointing at a
 * number nobody meant.
 */
function parseDirections(raw) {
  if (raw == null) return [];
  return String(raw).split(/[;,]/).map((part) => {
    const s = part.trim().toUpperCase();
    if (!s) return null;
    if (s in COMPASS) return COMPASS[s];
    const n = Number.parseFloat(s);
    if (!Number.isFinite(n)) return null;
    if (n < 0 || n > 360) return null;      // 500° is not a bearing
    return n % 360;
  }).filter((n) => n !== null);
}

function vendorOf(tags) {
  const hay = `${tags.manufacturer || ''} ${tags.brand || ''} ${tags['camera:model'] || ''} ${tags.name || ''}`;
  for (const v of ALPR_VENDORS) if (v.match && v.match.test(hay)) return v.key;
  return 'other';
}

async function alpr({ bbox, vendor, limit }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');
  const cap = clamp(parseInt(limit || '1200', 10) || 1200, 1, 4000);
  const q = viewCell(b, 'alpr');
  const bb = q.key;

  // Three clauses: the canonical ALPR/ANPR tag, plus Flock units that carry
  // only a manufacturer or brand. Overlaps are de-duplicated by OSM id below.
  //
  // Cached per grid cell like the infrastructure layer, for the same reason:
  // a cache keyed on the whole view box was only ever reused for exactly that
  // box, so every other zoom or pan queried Overpass again. It shares the
  // Overpass queue with that layer, so both on can't put two concurrent
  // queries on the same mirror. TTL.static: OSM-sourced and slow-moving.
  const raw = await overpassCells(q, [{
    key: 'alpr-layer',
    body: (box) => `nwr["surveillance:type"~"^(ALPR|ANPR)$",i](${box});`
      + `nwr["man_made"="surveillance"]["manufacturer"~"flock",i](${box});`
      + `nwr["man_made"="surveillance"]["brand"~"flock",i](${box});`,
    match: () => true,   // the query is the filter
  }], cap, 'Overpass (ALPR)', RETAIN['overpass.alpr'],
  { lat: (b.south + b.north) / 2, lon: (b.west + b.east) / 2 });

  const seen = new Set();
  let cameras = [];

  for (const el of raw.elements || []) {
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);

    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const t = el.tags || {};
    const directions = parseDirections(t.direction ?? t['camera:direction']);

    cameras.push({
      id,
      osmId: el.id,
      osmType: el.type,
      lat, lon,
      vendor: vendorOf(t),
      manufacturer: t.manufacturer || t.brand || null,
      model: t['camera:model'] || null,
      operator: t.operator || null,
      operatorType: t['operator:type'] || null,
      directions,
      directionRaw: t.direction ?? t['camera:direction'] ?? null,
      zone: t['surveillance:zone'] || null,
      surveillance: t.surveillance || null,
      mount: t['camera:mount'] || null,
      power: t.electricity || null,
      ref: t.ref || null,
      name: t.name || null,
      image: safeUrl(t.image),
      tags: t,
    });
  }

  const byVendor = {};
  const byOperator = {};
  for (const c of cameras) {
    byVendor[c.vendor] = (byVendor[c.vendor] || 0) + 1;
    if (c.operator) byOperator[c.operator] = (byOperator[c.operator] || 0) + 1;
  }

  // The unfiltered, plottable population — not `seen.size`, which also counts
  // elements that were de-duplicated away or had no usable geometry.
  const total = cameras.length;

  if (vendor && vendor !== 'all') {
    const want = new Set(String(vendor).split(',').map((s) => s.trim()));
    cameras = cameras.filter((c) => want.has(c.vendor));
  }
  const filtered = cameras.length;
  cameras = nearestFirst(cameras, b, cap);

  return {
    count: cameras.length,
    total,
    byVendor,
    byOperator: Object.fromEntries(
      Object.entries(byOperator).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    withDirection: cameras.filter((c) => c.directions.length).length,
    vendors: ALPR_VENDORS.map(({ key, label, color }) => ({ key, label, color })),
    covered: raw.partial ? null : bb,
    ...partialFields(raw),
    trimmed: q.trimmed || false,
    truncated: raw.truncated || cameras.length < filtered,
    cameras,
  };
}

// ---------------------------------------------------------------------------
// NETWORK INFRASTRUCTURE — geolocated network and wireless hardware
// ---------------------------------------------------------------------------

const NETINFRA_SOURCES = {
  atlas: { label: 'RIPE Atlas probes', color: '#4cc9f0', keyed: false,
    note: 'Volunteer network measurement probes, with ASN and connection type.' },
  cell:  { label: 'Cell towers', color: '#ff9f1c', keyed: 'OPENCELLID_API_KEY',
    note: 'OpenCelliD: GSM/UMTS/LTE/NR cells with estimated position and range.' },
  wigle: { label: 'WiFi / Bluetooth', color: '#c77dff', keyed: 'WIGLE_API_NAME',
    note: 'WiGLE wardriving survey. Free accounts are heavily rate-limited.' },
  tor:   { label: 'Tor relays (by country)', color: '#7ee787', keyed: false,
    note: 'Onionoo stopped publishing per-relay coordinates, so this is country-level.' },
};

/* --- RIPE Atlas ------------------------------------------------------ */
async function atlasProbes(raw_b) {
  // Query the cell, not the view, so the key names a region rather than a
  // camera position — see viewCell().
  const b = viewCell(raw_b, 'atlas');
  const url = new URL('https://atlas.ripe.net/api/v2/probes/');
  url.searchParams.set('latitude__gte', b.south.toFixed(4));
  url.searchParams.set('latitude__lte', b.north.toFixed(4));
  url.searchParams.set('longitude__gte', b.west.toFixed(4));
  url.searchParams.set('longitude__lte', b.east.toFixed(4));
  url.searchParams.set('status', '1');          // connected only
  url.searchParams.set('format', 'json');
  url.searchParams.set('page_size', '500');

  const raw = await cachedPersistent(`atlas:${b.key}`, RETAIN['network.infrastructure'],
    () => grab(url, {}, { label: 'RIPE Atlas', timeoutMs: 25000 }));

  return (raw.results || []).map((p) => {
    // Coordinates come as GeoJSON [lon, lat].
    const c = p.geometry?.coordinates;
    const lon = c?.[0] ?? p.longitude;
    const lat = c?.[1] ?? p.latitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      source: 'atlas',
      id: `atlas:${p.id}`,
      lat, lon,
      title: `RIPE Atlas probe #${p.id}`,
      subtitle: p.description || null,
      asn: p.asn_v4 ?? p.asn_v6 ?? null,
      country: p.country_code || null,
      status: p.status?.name || null,
      isAnchor: !!p.is_anchor,
      prefix: p.prefix_v4 || null,
      tags: (p.tags || []).map((t) => t.name),
      detail: { 'First connected': p.first_connected
        ? new Date(p.first_connected * 1000).toISOString().slice(0, 10) : null },
    };
  }).filter(Boolean);
}

/* --- OpenCelliD ------------------------------------------------------ */
const RADIO_LABEL = { __proto__: null, GSM: '2G GSM', UMTS: '3G UMTS', LTE: '4G LTE', NR: '5G NR', CDMA: 'CDMA' };

async function cellTowers(raw_b) {
  if (!CFG.openCellIdKey) return [];
  const b = viewCell(raw_b, 'cell');
  const url = new URL('https://opencellid.org/cell/getInArea');
  url.searchParams.set('key', CFG.openCellIdKey);
  url.searchParams.set('BBOX', `${b.south},${b.west},${b.north},${b.east}`);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '50');       // API hard cap per request

  const raw = await cachedPersistent(`cell:${b.key}`, RETAIN['network.infrastructure'],
    () => grab(url, {}, { label: 'OpenCelliD', timeoutMs: 20000 }));

  if (raw?.error) throw new UpstreamError(502, `OpenCelliD: ${raw.error}`);

  return (raw.cells || []).map((c) => ({
    source: 'cell',
    id: `cell:${c.mcc}-${c.mnc}-${c.lac}-${c.cellid}`,
    lat: Number(c.lat), lon: Number(c.lon),
    title: `${RADIO_LABEL[c.radio] || c.radio || 'Cell'} ${c.cellid}`,
    subtitle: `MCC ${c.mcc} · MNC ${c.mnc} · LAC ${c.lac}`,
    asn: null,
    country: null,
    radius: Number(c.range) || null,
    samples: c.samples ?? null,
    detail: {
      Radio: RADIO_LABEL[c.radio] || c.radio,
      'Cell ID': c.cellid, MCC: c.mcc, MNC: c.mnc, LAC: c.lac,
      'Est. range': c.range ? `${c.range} m` : null,
      Samples: c.samples,
      'Avg signal': c.averageSignalStrength,
    },
  })).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
}

/* --- WiGLE ----------------------------------------------------------- */
async function wigleNetworks(raw_b) {
  if (!CFG.wigleName || !CFG.wigleToken) return [];
  const b = viewCell(raw_b, 'wigle');
  const url = new URL('https://api.wigle.net/api/v2/network/search');
  url.searchParams.set('latrange1', b.south.toFixed(5));
  url.searchParams.set('latrange2', b.north.toFixed(5));
  url.searchParams.set('longrange1', b.west.toFixed(5));
  url.searchParams.set('longrange2', b.east.toFixed(5));
  url.searchParams.set('resultsPerPage', '100');

  const auth = Buffer.from(`${CFG.wigleName}:${CFG.wigleToken}`).toString('base64');
  const raw = await cachedPersistent(`wigle:${b.key}`, RETAIN['network.infrastructure'],
    () => grab(url, { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } },
      { label: 'WiGLE', timeoutMs: 25000 }));

  if (raw?.success === false) {
    throw new UpstreamError(429, `WiGLE: ${raw.message || 'query refused (free tier is throttled)'}`);
  }

  return (raw.results || []).map((n) => ({
    source: 'wigle',
    id: `wigle:${n.netid}`,
    lat: n.trilat, lon: n.trilong,
    title: n.ssid || '(hidden SSID)',
    subtitle: n.netid,
    asn: null,
    country: n.country || null,
    detail: {
      BSSID: n.netid,
      Encryption: n.encryption,
      Channel: n.channel,
      Type: n.type,
      'First seen': n.firsttime,
      'Last seen': n.lasttime,
      'Last update': n.lastupdt,
      QoS: n.qos,
    },
  })).filter((n) => Number.isFinite(n.lat) && Number.isFinite(n.lon));
}

/* --- Tor relays (country aggregate) ---------------------------------- */
// Onionoo used to publish per-relay latitude/longitude. It no longer does —
// the fields are gone from the live details document even when requested —
// so the finest honest resolution is per country.
async function torRelays(b) {
  const url = new URL('https://onionoo.torproject.org/details');
  url.searchParams.set('type', 'relay');
  url.searchParams.set('running', 'true');
  url.searchParams.set('fields', 'country,country_name,as_name,observed_bandwidth,flags');

  const raw = await cachedPersistent('tor:relays', RETAIN['network.infrastructure'],
    () => grab(url, {}, { label: 'Onionoo', timeoutMs: 40000 }));

  const byCountry = new Map();
  for (const r of raw.relays || []) {
    const cc = (r.country || '').toUpperCase();
    if (!cc) continue;
    const e = byCountry.get(cc) || {
      cc, name: r.country_name || cc, relays: 0, exits: 0, guards: 0, bandwidth: 0,
    };
    e.relays++;
    if ((r.flags || []).includes('Exit')) e.exits++;
    if ((r.flags || []).includes('Guard')) e.guards++;
    e.bandwidth += r.observed_bandwidth || 0;
    byCountry.set(cc, e);
  }

  const out = [];
  for (const e of byCountry.values()) {
    const c = COUNTRY_CENTROIDS[e.cc];
    // Deliberately NOT bbox-filtered. These are country-scale markers placed
    // at centroids, and a centroid is almost never inside a city-sized view —
    // filtering them would make the layer look empty exactly when someone is
    // zoomed in. Cesium culls whatever is off-screen anyway.
    if (!c) continue;
    out.push({
      source: 'tor',
      id: `tor:${e.cc}`,
      lat: c[0], lon: c[1],
      title: `${e.name}: ${e.relays.toLocaleString()} Tor relays`,
      subtitle: `${(e.bandwidth / 1e9 * 8).toFixed(1)} Gbit/s observed`,
      country: e.cc,
      aggregate: true,
      weight: e.relays,
      detail: {
        Relays: e.relays.toLocaleString(),
        'Exit nodes': e.exits.toLocaleString(),
        'Guard nodes': e.guards.toLocaleString(),
        'Observed bandwidth': `${(e.bandwidth / 1e9 * 8).toFixed(2)} Gbit/s`,
        Resolution: 'country centroid — Onionoo no longer publishes relay coordinates',
      },
    });
  }
  return out.sort((x, y) => y.weight - x.weight).slice(0, 120);
}

const NETINFRA_FETCHERS = {
  __proto__: null,
  atlas: atlasProbes, cell: cellTowers, wigle: wigleNetworks, tor: torRelays,
};

async function netinfra({ bbox, sources }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  const want = String(sources || 'atlas,cell,wigle,tor')
    .split(',').map((s) => s.trim()).filter((s) => NETINFRA_FETCHERS[s]);
  if (!want.length) throw new UpstreamError(400, 'no valid sources requested');

  const settled = await Promise.allSettled(want.map((s) => NETINFRA_FETCHERS[s](b)));
  const nodes = [];
  const problems = {};
  const bySource = {};

  settled.forEach((r, i) => {
    const name = want[i];
    if (r.status === 'rejected') { problems[name] = r.reason?.message || String(r.reason); return; }
    bySource[name] = r.value.length;
    nodes.push(...r.value);
  });

  return {
    count: nodes.length,
    bySource,
    problems,
    sources: Object.fromEntries(Object.entries(NETINFRA_SOURCES).map(([k, v]) => [k, {
      label: v.label, color: v.color, note: v.note,
      available: !v.keyed || !!(v.keyed === 'OPENCELLID_API_KEY' ? CFG.openCellIdKey : CFG.wigleName),
    }])),
    nodes: nodes.slice(0, 2000),
  };
}

// ---------------------------------------------------------------------------
// IOT SENSORS — Sensor.Community citizen air / noise network
// ---------------------------------------------------------------------------

const VALUE_LABELS = {
  P0: 'PM1', P1: 'PM10', P2: 'PM2.5', P4: 'PM4',
  temperature: 'Temperature', humidity: 'Humidity', pressure: 'Pressure',
  pressure_at_sealevel: 'Pressure (MSL)',
  noise_LAeq: 'Noise LAeq', noise_LA_min: 'Noise min', noise_LA_max: 'Noise max',
};
const VALUE_UNITS = {
  P0: 'µg/m³', P1: 'µg/m³', P2: 'µg/m³', P4: 'µg/m³',
  temperature: '°C', humidity: '%', pressure: 'Pa', pressure_at_sealevel: 'Pa',
  noise_LAeq: 'dB(A)', noise_LA_min: 'dB(A)', noise_LA_max: 'dB(A)',
};

/** WHO 2021 24-hour guideline is 15 µg/m³ for PM2.5; colour against that. */
function airQualityBand(pm25) {
  if (pm25 == null) return null;
  if (pm25 <= 15) return { band: 'good', label: 'Within WHO guideline', color: '#7ee787' };
  if (pm25 <= 35) return { band: 'moderate', label: 'Above WHO guideline', color: '#ffd166' };
  if (pm25 <= 75) return { band: 'poor', label: 'Poor', color: '#ff9f1c' };
  return { band: 'severe', label: 'Severe', color: '#ff2d55' };
}

async function iotSensors({ bbox, includeIndoor }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  // Sensor.Community asks for a descriptive user agent so they can get in
  // touch about heavy use rather than just blocking.
  const q = viewCell(b, 'iot');
  const url = `https://data.sensor.community/airrohr/v1/filter/`
    + `box=${q.south.toFixed(4)},${q.west.toFixed(4)},${q.north.toFixed(4)},${q.east.toFixed(4)}`;

  // TTL.hazard, not TTL.static: this payload is readings with timestamps, and
  // the UI colours each sensor against the WHO PM2.5 guideline. Held for days
  // it would state three-day-old air quality as the current figure.
  const raw = await cachedPersistent(`iot:${q.key}`, RETAIN['current.sensors'],
    () => grab(url, { headers: { 'User-Agent': USER_AGENT } },
      { label: 'Sensor.Community', timeoutMs: 25000 }));

  if (!Array.isArray(raw)) throw new UpstreamError(502, 'Sensor.Community returned unexpected payload');

  // One device can post several readings in the window; keep the newest per sensor.
  const bySensor = new Map();
  for (const r of raw) {
    const id = r.sensor?.id;
    if (id == null) continue;
    const prev = bySensor.get(id);
    if (!prev || String(r.timestamp) > String(prev.timestamp)) bySensor.set(id, r);
  }

  const sensors = [];
  for (const r of bySensor.values()) {
    const loc = r.location || {};
    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const indoor = loc.indoor === 1 || loc.indoor === '1';
    if (indoor && !includeIndoor) continue;

    const readings = {};
    for (const v of r.sensordatavalues || []) {
      const n = Number(v.value);
      if (Number.isFinite(n)) readings[v.value_type] = n;
    }
    const pm25 = readings.P2 ?? null;

    sensors.push({
      id: `sc:${r.sensor.id}`,
      sensorId: r.sensor.id,
      lat, lon,
      model: r.sensor?.sensor_type?.name || null,
      manufacturer: r.sensor?.sensor_type?.manufacturer || null,
      country: loc.country || null,
      altitude: loc.altitude != null ? Number(loc.altitude) : null,
      indoor,
      exactLocation: loc.exact_location === 1,
      timestamp: r.timestamp || null,
      readings,
      pm25,
      air: airQualityBand(pm25),
      noise: readings.noise_LAeq ?? null,
      kinds: Object.keys(readings),
    });
  }

  const byModel = {};
  for (const s of sensors) byModel[s.model || 'unknown'] = (byModel[s.model || 'unknown'] || 0) + 1;

  return {
    count: sensors.length,
    byModel,
    withAir: sensors.filter((s) => s.pm25 != null).length,
    withNoise: sensors.filter((s) => s.noise != null).length,
    labels: VALUE_LABELS,
    units: VALUE_UNITS,
    sensors,
  };
}

// ---------------------------------------------------------------------------
// HOST ENRICHMENT — reputation and cross-references for one IP
// ---------------------------------------------------------------------------

/** abuse.ch Feodo Tracker: currently-active botnet command-and-control servers. */
//
// The disk cache stores JSON, and a Map serialises to {}. So the list is
// cached as a plain array and the Map is built after reading it back. The list
// names servers that are active now, so it takes the `hazard` TTL.
let feodoIndex = { rows: null, map: null };
async function feodoSet() {
  const rows = await cachedPersistent('feodo:rows', RETAIN['current.threats'], async () => {
    const list = await grab('https://feodotracker.abuse.ch/downloads/ipblocklist.json',
      {}, { label: 'Feodo Tracker', timeoutMs: 25000 });
    return (Array.isArray(list) ? list : []).filter((r) => r && r.ip_address);
  });
  if (feodoIndex.rows !== rows) {
    feodoIndex = { rows, map: new Map((Array.isArray(rows) ? rows : []).map((r) => [r.ip_address, r])) };
  }
  return feodoIndex.map;
}

async function greyNoiseLookup(ip) {
  const headers = { Accept: 'application/json' };
  if (CFG.greyNoiseKey) headers.key = CFG.greyNoiseKey;
  try {
    const j = await grab(`https://api.greynoise.io/v3/community/${encodeURIComponent(ip)}`,
      { headers }, { label: 'GreyNoise', timeoutMs: 12000 });
    return {
      seen: j.noise === true || j.riot === true,
      noise: j.noise ?? null,
      riot: j.riot ?? null,
      classification: j.classification || null,
      name: j.name || null,
      lastSeen: j.last_seen || null,
      link: safeUrl(j.link),
      message: j.message || null,
    };
  } catch (e) {
    if (e.status === 404) return { seen: false, message: 'not observed by GreyNoise' };
    if (e.status === 429) return { error: 'rate limit reached (10/day unauthenticated)' };
    return { error: e.message };
  }
}

async function enrich({ ip }) {
  const addr = String(ip || '').trim();
  if (!net.isIP(addr)) {
    throw new UpstreamError(400, 'a valid IP address is required');
  }

  const [gn, feodo] = await Promise.allSettled([
    greyNoiseLookup(addr),
    feodoSet().then((m) => m.get(addr) || null),
  ]);

  const c2 = feodo.status === 'fulfilled' ? feodo.value : null;

  return {
    ip: addr,
    greynoise: gn.status === 'fulfilled' ? gn.value : { error: gn.reason?.message },
    botnetC2: c2 ? {
      malware: c2.malware || null,
      firstSeen: c2.first_seen_utc || null,
      lastOnline: c2.last_online || null,
      port: c2.port ?? null,
      status: c2.status || null,
      hostname: c2.hostname || null,
      asName: c2.as_name || null,
      country: c2.country || null,
    } : null,
    onC2List: !!c2,
  };
}

// ---------------------------------------------------------------------------
// SIGNALS — region-scale telemetry with no useful point geometry
// ---------------------------------------------------------------------------

async function iodaOutages() {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL('https://api.ioda.inetintel.cc.gatech.edu/v2/outages/summary');
  url.searchParams.set('from', String(now - 86400));
  url.searchParams.set('until', String(now));
  url.searchParams.set('entityType', 'country');
  url.searchParams.set('limit', '40');

  const raw = await cached('ioda:summary', RETAIN['current.outages'],
    () => grab(url, {}, { label: 'IODA', timeoutMs: 25000 }));

  return (raw.data || [])
    .filter((d) => (d.event_cnt || 0) > 0)
    .map((d) => {
      const cc = d.entity?.code;
      const centroid = COUNTRY_CENTROIDS[cc] || null;
      return {
        code: cc,
        name: d.entity?.name || cc,
        events: d.event_cnt,
        score: d.scores?.overall ?? null,
        lat: centroid?.[0] ?? null,
        lon: centroid?.[1] ?? null,
        signals: {
          bgp: d.scores?.['bgp.median'] ?? null,
          activeProbing: d.scores?.['ping-slash24.median'] ?? null,
          darknet: d.scores?.['merit-nt.median'] ?? null,
        },
      };
    })
    .sort((a, b) => b.events - a.events);
}

async function eiaGrid() {
  if (!CFG.eiaKey) return null;
  const url = new URL('https://api.eia.gov/v2/electricity/rto/region-data/data/');
  url.searchParams.set('api_key', CFG.eiaKey);
  url.searchParams.set('frequency', 'hourly');
  url.searchParams.append('data[]', 'value');
  url.searchParams.set('facets[type][]', 'D');            // demand
  url.searchParams.set('sort[0][column]', 'period');
  url.searchParams.set('sort[0][direction]', 'desc');
  url.searchParams.set('length', '60');

  const raw = await grab(url, {}, { label: 'EIA', timeoutMs: 25000 });
  const rows = raw?.response?.data || [];
  const byRegion = new Map();
  for (const r of rows) {
    if (byRegion.has(r.respondent)) continue;
    byRegion.set(r.respondent, {
      code: r.respondent, name: r['respondent-name'] || r.respondent,
      demandMW: Number(r.value) || null, period: r.period,
      units: r['value-units'] || 'MWh',
    });
  }
  return [...byRegion.values()].sort((a, b) => (b.demandMW || 0) - (a.demandMW || 0)).slice(0, 12);
}

async function cloudflareRadar() {
  if (!CFG.cloudflareToken) return null;
  const url = 'https://api.cloudflare.com/client/v4/radar/annotations/outages?limit=15&format=json';
  const raw = await grab(url, {
    headers: { Authorization: `Bearer ${CFG.cloudflareToken}`, Accept: 'application/json' },
  }, { label: 'Cloudflare Radar', timeoutMs: 20000 });

  return (raw?.result?.annotations || []).map((a) => ({
    id: a.id, locations: a.locations || [], asns: a.asns || [],
    scope: a.scope || null, eventType: a.eventType || null,
    startDate: a.startDate || null, endDate: a.endDate || null,
    description: a.description || null, linkedUrl: safeUrl(a.linkedUrl),
  }));
}

/** Raspberry Shake: citizen seismograph network, keyless station list. */
async function shakeStations(raw_b) {
  const b = viewCell(raw_b, 'shake');
  const url = 'https://data.raspberryshake.org/fdsnws/station/1/query'
    + `?level=station&format=text&minlatitude=${b.south.toFixed(3)}`
    + `&maxlatitude=${b.north.toFixed(3)}&minlongitude=${b.west.toFixed(3)}`
    + `&maxlongitude=${b.east.toFixed(3)}`;

  const text = await cachedPersistent(`shake:${b.key}`, RETAIN['places.seismic'],
    () => grab(url, {}, { as: 'text', label: 'Raspberry Shake', timeoutMs: 25000 }));

  // FDSN text format: #Network|Station|Latitude|Longitude|Elevation|SiteName|...
  return text.split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [net, sta, lat, lon, elev, site, start] = l.split('|');
      if (!Number.isFinite(Number(lat))) return null;
      return {
        id: `shake:${net}.${sta}`, network: net, station: sta,
        lat: Number(lat), lon: Number(lon),
        elevation: Number(elev) || null, site: (site || '').trim() || null,
        since: (start || '').slice(0, 10) || null,
      };
    }).filter(Boolean);
}

async function signals({ bbox }) {
  const b = parseBbox(bbox);

  const [ioda, eia, cf, shake] = await Promise.allSettled([
    iodaOutages(),
    eiaGrid(),
    cloudflareRadar(),
    b ? shakeStations(b) : Promise.resolve([]),
  ]);

  const unwrap = (r) => (r.status === 'fulfilled' ? r.value : null);
  const err = (r) => (r.status === 'rejected' ? (r.reason?.message || String(r.reason)) : null);

  return {
    outages: unwrap(ioda) || [],
    grid: unwrap(eia),
    cloudflare: unwrap(cf),
    seismographs: unwrap(shake) || [],
    configured: {
      ioda: true,
      eia: !!CFG.eiaKey,
      cloudflare: !!CFG.cloudflareToken,
      seismographs: true,
    },
    problems: {
      ioda: err(ioda), eia: err(eia), cloudflare: err(cf), seismographs: err(shake),
    },
  };
}

// ---------------------------------------------------------------------------
// TRAFFIC — state 511 camera and incident feeds
//
// Most US state 511 sites run the same vendor platform, which exposes
// /api/v2/get/cameras and /api/v2/get/event with a per-state key. Add states
// to FIVE_ELEVEN_KEYS in .env as "TX:key,GA:key"; each one you add appears
// in the traffic layer.
// ---------------------------------------------------------------------------

const FIVE_ELEVEN_HOSTS = {
  __proto__: null,
  GA: 'https://511ga.org', LA: 'https://www.511la.org', AZ: 'https://www.az511.com',
  NY: 'https://511ny.org', FL: 'https://fl511.com', IA: 'https://511ia.org',
  NE: 'https://511.nebraska.gov', KY: 'https://goky.ky.gov', MA: 'https://mass511.com',
  NH: 'https://newengland511.org', VT: 'https://newengland511.org', ME: 'https://newengland511.org',
  WI: 'https://511wi.gov', IN: 'https://511in.org', MD: 'https://chart.maryland.gov',
  UT: 'https://www.udottraffic.utah.gov', CO: 'https://maps.cotrip.org',
  NV: 'https://www.nvroads.com', WY: 'https://www.wyoroad.info', MT: 'https://www.511mt.net',
  SD: 'https://sd511.org', ND: 'https://travel.dot.nd.gov', KS: 'https://www.kandrive.gov',
};

async function fiveElevenState(state, key, b) {
  const host = FIVE_ELEVEN_HOSTS[state];
  if (!host) throw new UpstreamError(400, `no known 511 host for "${state}"`);

  const [camsRes, eventsRes] = await Promise.allSettled([
    grab(`${host}/api/v2/get/cameras?key=${encodeURIComponent(key)}&format=json`,
      {}, { label: `511 ${state} cameras`, timeoutMs: 25000 }),
    grab(`${host}/api/v2/get/event?key=${encodeURIComponent(key)}&format=json`,
      {}, { label: `511 ${state} events`, timeoutMs: 25000 }),
  ]);

  const cams = camsRes.status === 'fulfilled' && Array.isArray(camsRes.value)
    ? camsRes.value.map((c) => ({
      kind: 'camera',
      source: `511-${state}`,
      id: `511:${state}:cam:${c.Id ?? c.id}`,
      lat: Number(c.Latitude ?? c.latitude),
      lon: Number(c.Longitude ?? c.longitude),
      title: c.Name ?? c.name ?? 'Traffic camera',
      roadway: c.RoadwayName ?? c.roadway ?? null,
      direction: c.DirectionOfTravel ?? null,
      image: safeUrl(c.Url ?? c.url ?? c.ImageUrl),
      status: c.Status ?? null,
    })).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && inBox(b, c.lat, c.lon))
    : [];

  const events = eventsRes.status === 'fulfilled' && Array.isArray(eventsRes.value)
    ? eventsRes.value.map((e) => ({
      kind: 'incident',
      source: `511-${state}`,
      id: `511:${state}:evt:${e.ID ?? e.id}`,
      lat: Number(e.Latitude ?? e.latitude),
      lon: Number(e.Longitude ?? e.longitude),
      title: e.EventType ?? e.eventType ?? 'Incident',
      roadway: e.RoadwayName ?? e.roadwayName ?? null,
      direction: e.DirectionOfTravel ?? null,
      description: e.Description ?? e.description ?? null,
      severity: e.Severity ?? null,
      lanesAffected: e.LanesAffected ?? null,
      started: e.Reported ?? e.StartDate ?? null,
      updated: e.LastUpdated ?? null,
    })).filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lon) && inBox(b, e.lat, e.lon))
    : [];

  const problems = [];
  if (camsRes.status === 'rejected') problems.push(camsRes.reason?.message);
  if (eventsRes.status === 'rejected') problems.push(eventsRes.reason?.message);

  return { cams, events, problems };
}

async function traffic({ bbox }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  const states = Object.entries(CFG.fiveElevenKeys);
  if (!states.length) {
    return {
      count: 0, cameras: 0, incidents: 0, byState: {}, problems: {},
      configuredStates: [],
      hint: 'No 511 states configured. Add FIVE_ELEVEN_KEYS to .env as "GA:yourkey,NY:yourkey" '
        + `— free keys per state. Known hosts: ${Object.keys(FIVE_ELEVEN_HOSTS).join(', ')}`,
      features: [],
    };
  }

  const cell = viewCell(b, 'traffic');
  const settled = await Promise.allSettled(
    states.map(([state, key]) =>
      cached(`511:${state}:${cell.key}`, RETAIN['current.traffic'],
        () => fiveElevenState(state, key, cell))),
  );

  const features = [];
  const problems = {};
  const byState = {};

  settled.forEach((r, i) => {
    const state = states[i][0];
    if (r.status === 'rejected') { problems[state] = r.reason?.message || String(r.reason); return; }
    const { cams, events, problems: p } = r.value;
    if (p?.length) problems[state] = p.join('; ');
    byState[state] = { cameras: cams.length, incidents: events.length };
    features.push(...cams, ...events);
  });

  return {
    count: features.length,
    cameras: features.filter((f) => f.kind === 'camera').length,
    incidents: features.filter((f) => f.kind === 'incident').length,
    byState,
    problems,
    configuredStates: states.map(([s]) => s),
    features,
  };
}

// ---------------------------------------------------------------------------
// GEOIP — where is this machine, roughly
// ---------------------------------------------------------------------------

async function geoip() {
  // Resolved server-side, so it describes the machine running OpenPanopticon
  // rather than whatever browser happens to be pointed at it. Held in memory
  // only, for 30 minutes: the app opens over wherever the machine is now, so
  // a laptop that moved must not reopen over yesterday's city, and the
  // answer (city, postal code, ISP) is not written to disk.
  return cached('geoip', 30 * 60_000, async () => {
    const j = await grab('https://ipwho.is/', {}, { label: 'ipwho.is', timeoutMs: 12000 });
    if (!j || j.success === false || !Number.isFinite(j.latitude)) {
      throw new UpstreamError(502, `geoip lookup failed: ${j?.message || 'no coordinates'}`);
    }
    return {
      lat: j.latitude,
      lon: j.longitude,
      city: j.city || null,
      region: j.region || null,
      country: j.country || null,
      countryCode: j.country_code || null,
      postal: j.postal || null,
      timezone: j.timezone?.id || null,
      isp: j.connection?.isp || j.connection?.org || null,
      asn: j.connection?.asn ?? null,
      // The public IP is deliberately not returned to the browser.
      label: [j.city, j.region, j.country].filter(Boolean).join(', ') || 'Unknown',
    };
  });
}

// ---------------------------------------------------------------------------
// FLIGHT ROUTES — callsign to origin/destination airports (adsbdb, no key)
// ---------------------------------------------------------------------------

const airport = (a) => (a && Number.isFinite(a.latitude) ? {
  icao: a.icao_code || null,
  iata: a.iata_code || null,
  name: a.name || null,
  city: a.municipality || null,
  country: a.country_name || null,
  lat: a.latitude,
  lon: a.longitude,
  elevationFt: a.elevation ?? null,
} : null);

async function flightRoute({ callsign }) {
  const cs = String(callsign || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (cs.length < 3) throw new UpstreamError(400, 'callsign required');

  // Date-scoped as well as short-lived: the TTL bounds staleness within a
  // day, and the key guarantees a stored answer can never bleed across one.
  const day = new Date().toISOString().slice(0, 10);
  return cachedPersistent(`route:${cs}:${day}`, RETAIN['aircraft.routes'], async () => {
    let raw;
    try {
      raw = await grab(`https://api.adsbdb.com/v0/callsign/${encodeURIComponent(cs)}`,
        {}, { label: 'adsbdb', timeoutMs: 15000 });
    } catch (e) {
      // adsbdb answers 404 for callsigns it has no schedule for, which is
      // an ordinary outcome rather than a failure worth surfacing as an error.
      if (e.status === 404) return { callsign: cs, known: false };
      throw e;
    }
    const fr = raw?.response?.flightroute;
    if (!fr) return { callsign: cs, known: false };

    return {
      callsign: cs,
      known: true,
      callsignIata: fr.callsign_iata || null,
      airline: fr.airline ? {
        name: fr.airline.name, icao: fr.airline.icao,
        iata: fr.airline.iata, country: fr.airline.country,
        radioCallsign: fr.airline.callsign,
      } : null,
      origin: airport(fr.origin),
      destination: airport(fr.destination),
      midpoint: airport(fr.midpoint),
    };
  });
}

async function aircraftInfo({ icao24 }) {
  const hex = String(icao24 || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 6) throw new UpstreamError(400, 'icao24 hex required');
  // v2: answers stored before the full-size photo was kept had only the
  // thumbnail, and would otherwise serve it for as long as they are retained.
  return cachedPersistent(`ac:v2:${hex}`, RETAIN['aircraft.airframes'], async () => {
    try {
      const raw = await grab(`https://api.adsbdb.com/v0/aircraft/${hex}`,
        {}, { label: 'adsbdb aircraft', timeoutMs: 15000 });
      const a = raw?.response?.aircraft;
      if (!a) return { icao24: hex, known: false };
      return {
        icao24: hex, known: true,
        registration: a.registration || null,
        type: a.type || null,
        icaoType: a.icao_type || null,
        manufacturer: a.manufacturer || null,
        owner: a.registered_owner || null,
        ownerCountry: a.registered_owner_country_name || null,
        ownerOperatorFlag: a.registered_owner_operator_flag_code || null,
        // The full-size photo for the panel, and the thumbnail as a stand-in
        // that arrives quickly while it loads. adsbdb's thumbnails are about
        // 200 px wide, which looked like a smudge at panel width.
        photo: safeUrl(a.url_photo) || safeUrl(a.url_photo_thumbnail),
        photoThumb: safeUrl(a.url_photo_thumbnail),
      };
    } catch (e) {
      if (e.status === 404) return { icao24: hex, known: false };
      throw e;
    }
  });
}

// ---------------------------------------------------------------------------
// NASA GIBS — daily global satellite imagery, keyless WMTS
//
// Template: /wmts/epsg3857/best/{layer}/default/{time}/{matrixSet}/{z}/{y}/{x}.{ext}
// Note the y/x (row/col) ordering, which is the reverse of the {x}/{y} most
// tile libraries expect — Cesium's UrlTemplateImageryProvider handles it via
// {TileRow}/{TileCol}.
// ---------------------------------------------------------------------------

const GIBS_LAYERS = [
  { key: 'MODIS_Terra_CorrectedReflectance_TrueColor', label: 'MODIS Terra (true colour)',
    ext: 'jpg', matrix: 'GoogleMapsCompatible_Level9', maxLevel: 9,
    note: 'Morning overpass, ~10:30 local.' },
  { key: 'MODIS_Aqua_CorrectedReflectance_TrueColor', label: 'MODIS Aqua (true colour)',
    ext: 'jpg', matrix: 'GoogleMapsCompatible_Level9', maxLevel: 9,
    note: 'Afternoon overpass, ~13:30 local.' },
  { key: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', label: 'VIIRS SNPP (true colour)',
    ext: 'jpg', matrix: 'GoogleMapsCompatible_Level9', maxLevel: 9,
    note: 'Sharper than MODIS; best default.' },
  { key: 'VIIRS_NOAA20_CorrectedReflectance_TrueColor', label: 'VIIRS NOAA-20 (true colour)',
    ext: 'jpg', matrix: 'GoogleMapsCompatible_Level9', maxLevel: 9,
    note: 'Second VIIRS platform, ~50 min offset.' },
  { key: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance', label: 'VIIRS night lights',
    ext: 'png', matrix: 'GoogleMapsCompatible_Level8', maxLevel: 8,
    note: 'Day/night band — city lights, gas flares, fishing fleets.' },
  { key: 'MODIS_Terra_Land_Surface_Temp_Day', label: 'Land surface temperature',
    ext: 'png', matrix: 'GoogleMapsCompatible_Level7', maxLevel: 7,
    note: 'Daytime skin temperature.' },
  { key: 'MODIS_Terra_Thermal_Anomalies_All', label: 'Thermal anomalies / fires',
    ext: 'png', matrix: 'GoogleMapsCompatible_Level9', maxLevel: 9,
    note: 'Detected heat sources, complements FIRMS points.' },
  { key: 'GOES-East_ABI_GeoColor', label: 'GOES-East GeoColor (clouds)',
    ext: 'png', matrix: 'GoogleMapsCompatible_Level7', maxLevel: 7,
    note: 'Near-real-time cloud cover over the Americas.' },
  { key: 'MODIS_Terra_Cloud_Fraction_Day', label: 'Cloud fraction',
    ext: 'png', matrix: 'GoogleMapsCompatible_Level6', maxLevel: 6,
    note: 'Global daily cloud fraction.' },
];

// Cloud imagery, best first. RainViewer's free infrared band is advertised but
// returns zero frames in practice, so GIBS is what actually makes the CLOUD
// toggle do something.
const CLOUD_SOURCES = [
  { key: 'GOES-East_ABI_GeoColor', label: 'GOES-East GeoColor' },
  { key: 'MODIS_Terra_Cloud_Fraction_Day', label: 'MODIS cloud fraction' },
];

function gibsTemplate(layerKey, dateStr) {
  const layer = GIBS_LAYERS.find((l) => l.key === layerKey) || GIBS_LAYERS[2];
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateStr || '') ? dateStr : gibsDefaultDate();
  return {
    layer: layer.key,
    label: layer.label,
    date,
    maxLevel: layer.maxLevel,
    note: layer.note,
    url: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer.key}/default/`
       + `${date}/${layer.matrix}/{z}/{y}/{x}.${layer.ext}`,
  };
}

/** Imagery for "today" often isn't published yet; step back a day. */
function gibsDefaultDate() {
  const d = new Date(Date.now() - 24 * 3600_000);
  return d.toISOString().slice(0, 10);
}

async function imagery({ layer, date }) {
  return {
    layers: GIBS_LAYERS,
    selected: gibsTemplate(layer, date),
    defaultDate: gibsDefaultDate(),
  };
}

// ---------------------------------------------------------------------------
// WEATHER — RainViewer radar + satellite tile frames (no key)
// ---------------------------------------------------------------------------

async function weather() {
  return cached('weather:frames', RETAIN['current.radar'], async () => {
    const j = await grab('https://api.rainviewer.com/public/weather-maps.json',
      {}, { label: 'RainViewer', timeoutMs: 15000 });

    const host = j.host || 'https://tilecache.rainviewer.com';
    const radar = [...(j.radar?.past || []), ...(j.radar?.nowcast || [])];
    const satellite = j.satellite?.infrared || [];

    // Tile template per RainViewer's scheme:
    //   {host}{path}/{size}/{z}/{x}/{y}/{colourScheme}/{smooth}_{snow}.png
    const tile = (path, opts) => `${host}${path}/512/{z}/{x}/{y}/${opts}.png`;

    return {
      generated: j.generated,
      host,
      radar: {
        available: radar.length > 0,
        // RainViewer's free 512px radar tiles carry real data only to zoom 7.
        // From zoom 8 up it returns a byte-identical "Zoom Level Not
        // Supported" placeholder rather than a 404 or a transparent tile, so
        // letting Cesium request deeper smears that notice across the globe.
        // Capping here makes Cesium upsample zoom 7 instead, which is what
        // the data actually supports.
        maxLevel: 7,
        frames: radar.map((f) => ({
          time: f.time,
          iso: new Date(f.time * 1000).toISOString(),
          nowcast: !(j.radar?.past || []).includes(f),
          url: tile(f.path, '4/1_1'),
        })),
      },
      satellite: {
        available: satellite.length > 0,
        frames: satellite.map((f) => ({
          time: f.time,
          iso: new Date(f.time * 1000).toISOString(),
          url: tile(f.path, '0/0_0'),
        })),
      },
      // What the CLOUD toggle should actually draw.
      clouds: cloudSource(satellite),
    };
  });
}

/**
 * Pick a working cloud layer. Prefers RainViewer's infrared frames when it
 * publishes any, otherwise falls back to a NASA GIBS product so the toggle is
 * never a button that does nothing.
 */
function cloudSource(rainviewerFrames) {
  if (rainviewerFrames && rainviewerFrames.length) {
    return {
      available: true, source: 'rainviewer', label: 'RainViewer infrared',
      maxLevel: 12, note: 'Infrared cloud tops.',
    };
  }
  const pick = gibsTemplate(CLOUD_SOURCES[0].key);
  return {
    available: true,
    source: 'gibs',
    label: pick.label,
    url: pick.url,
    maxLevel: pick.maxLevel,
    date: pick.date,
    note: pick.note,
    alternatives: CLOUD_SOURCES.map((c) => c.key),
    fallbackReason: 'RainViewer publishes no infrared frames, so NASA GIBS is used instead.',
  };
}

// ---------------------------------------------------------------------------
// WEBCAMS — intentionally-public cameras only
// ---------------------------------------------------------------------------

async function windyWebcams(b) {
  if (!CFG.windyKey) return [];
  const url = new URL('https://api.windy.com/webcams/api/v3/webcams');
  url.searchParams.set('bbox', `${b.north},${b.east},${b.south},${b.west}`);
  url.searchParams.set('limit', '50');
  url.searchParams.set('include', 'location,images,player,urls');
  const raw = await grab(url, { headers: { 'x-windy-api-key': CFG.windyKey } }, { label: 'Windy' });
  return (raw.webcams || []).map((w) => ({
    source: 'windy',
    id: `windy:${w.webcamId}`,
    title: w.title,
    lat: w.location?.latitude,
    lon: w.location?.longitude,
    place: [w.location?.city, w.location?.country].filter(Boolean).join(', ') || null,
    status: w.status,
    updated: w.lastUpdatedOn || null,
    image: safeUrl(w.images?.current?.preview || w.images?.current?.thumbnail),
    embed: safeUrl(w.player?.day || w.player?.live, { httpsOnly: true }),
    link: safeUrl(w.urls?.detail),
  })).filter((w) => w.lat != null && w.lon != null);
}

async function nycWebcams(b) {
  // NYC DOT publishes its traffic camera roster openly, no key required.
  const raw = await cachedPersistent('cams:nyc', RETAIN['cameras.directories'], () =>
    grab('https://webcams.nyctmc.org/api/cameras', {}, { label: 'NYC DOT' }));
  const list = Array.isArray(raw) ? raw : (raw.cameras || raw.results || []);
  return list
    .map((c) => {
      const lat = Number(c.latitude ?? c.lat);
      const lon = Number(c.longitude ?? c.lng ?? c.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
      const id = c.id || c.cameraId;
      return {
        source: 'nycdot',
        id: `nyc:${id}`,
        title: c.name || c.area || 'NYC DOT camera',
        lat, lon,
        place: c.area || 'New York City',
        status: c.isOnline === 'true' || c.isOnline === true ? 'active' : 'unknown',
        updated: null,
        image: safeUrl(c.imageUrl) || (id ? `https://webcams.nyctmc.org/api/cameras/${encodeURIComponent(id)}/image` : null),
        embed: null,
        link: id ? `https://webcams.nyctmc.org/map?cid=${encodeURIComponent(id)}` : null,
      };
    })
    .filter(Boolean)
    .filter((c) => c.lat >= b.south && c.lat <= b.north && c.lon >= b.west && c.lon <= b.east);
}

/**
 * OpenWebcamDB — a hand-curated directory of operator-published streams
 * (openwebcamdb.com). The public docs cover auth and the two webcam routes
 * but not the list filter parameters, so rather than guess at a bbox filter
 * we page through the whole catalogue once (it is ~1,500 cameras), cache it
 * (TTL.static), and filter locally. Field names are normalised
 * defensively.
 */
const OWCDB_BASE = 'https://openwebcamdb.com/api/v1';

function normaliseOwcdb(w) {
  const lat = Number(w.latitude ?? w.lat ?? w.location?.latitude ?? w.location?.lat);
  const lon = Number(w.longitude ?? w.lon ?? w.lng ?? w.location?.longitude ?? w.location?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const slug = w.slug ?? w.id;
  return {
    source: 'openwebcamdb',
    id: `owcdb:${slug}`,
    slug,
    title: w.title || w.name || 'Webcam',
    lat, lon,
    place: [w.city ?? w.location?.city, w.country ?? w.location?.country ?? w.country_name]
      .filter(Boolean).join(', ') || null,
    category: w.category ?? w.categories?.[0]?.name ?? w.categories?.[0] ?? null,
    status: w.status ?? (w.is_online === false ? 'offline' : 'active'),
    updated: w.last_checked ?? w.updated_at ?? w.checked_at ?? null,
    image: safeUrl(w.thumbnail ?? w.thumbnail_url ?? w.image ?? w.preview_url),
    embed: safeUrl(w.embed_url ?? w.player_url, { httpsOnly: true }),
    stream: safeUrl(w.stream_url),
    link: slug ? `https://openwebcamdb.com/webcams/${encodeURIComponent(slug)}` : 'https://openwebcamdb.com',
  };
}

async function owcdbCatalogue() {
  if (!CFG.owcdbKey) return [];
  return cachedPersistent('cams:owcdb:all', RETAIN['cameras.directories'], async () => {
    const headers = { Authorization: `Bearer ${CFG.owcdbKey}`, Accept: 'application/json' };
    const out = [];
    const seen = new Set();

    for (let page = 1; page <= 30; page++) {
      const url = new URL(`${OWCDB_BASE}/webcams`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('per_page', '100');
      url.searchParams.set('limit', '100');

      const raw = await grab(url, { headers }, { label: 'OpenWebcamDB', timeoutMs: 25000 });
      const list = raw.data ?? raw.webcams ?? raw.results ?? (Array.isArray(raw) ? raw : []);
      if (!Array.isArray(list) || !list.length) break;

      let added = 0;
      for (const w of list) {
        const n = normaliseOwcdb(w);
        if (!n || seen.has(n.id)) continue;
        seen.add(n.id);
        out.push(n);
        added++;
      }
      // No new records means pagination isn't advancing — stop rather than loop.
      if (!added) break;

      const total = raw.meta?.total ?? raw.total ?? null;
      const lastPage = raw.meta?.last_page ?? raw.last_page ?? null;
      if (lastPage && page >= lastPage) break;
      if (total && out.length >= total) break;
      if (list.length < 100) break;
    }
    return out;
  });
}

async function owcdbWebcams(b) {
  const all = await owcdbCatalogue();
  return all.filter((c) => inBox(b, c.lat, c.lon));
}

/**
 * ALERTCalifornia — ~1,290 wildfire-detection PTZ cameras run by UC San Diego
 * with CAL FIRE, published as an open ArcGIS feature service. No key, and the
 * feed carries a live latest-frame image URL per camera.
 */
const ALERTCA_URL = 'https://services8.arcgis.com/X84q166Srnyl4JMV/arcgis/rest/services'
  + '/ALERTCalifornia_Camera_Feed/FeatureServer/0/query';

async function alertCaWebcams(b) {
  const raw = await cachedPersistent('cams:alertca', RETAIN['cameras.directories'], async () => {
    const url = new URL(ALERTCA_URL);
    url.searchParams.set('where', '1=1');
    url.searchParams.set('outFields',
      'cameraName,siteId,county,isActive,isOnline,cameraURL,imageURL,viewTime,positionPan,positionTilt');
    url.searchParams.set('f', 'json');
    url.searchParams.set('returnGeometry', 'true');
    url.searchParams.set('outSR', '4326');          // geometry comes back in WGS84
    url.searchParams.set('resultRecordCount', '2000');
    return grab(url, {}, { label: 'ALERTCalifornia', timeoutMs: 30000 });
  });

  if (raw?.error) throw new UpstreamError(502, `ALERTCalifornia: ${raw.error.message || 'query failed'}`);

  return (raw.features || []).map((f) => {
    const a = f.attributes || {};
    const lat = f.geometry?.y;
    const lon = f.geometry?.x;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      source: 'alertca',
      id: `alertca:${a.siteId || a.OBJECTID}`,
      title: a.cameraName || 'ALERTCalifornia camera',
      lat, lon,
      place: a.county ? `${titleCase(a.county)} County, CA` : 'California',
      category: 'Wildfire detection',
      status: a.isOnline === 'online' && a.isActive === 'active' ? 'active' : (a.isOnline || 'unknown'),
      updated: a.viewTime || null,
      image: safeUrl(a.imageURL),
      embed: null,
      pan: a.positionPan ?? null,
      tilt: a.positionTilt ?? null,
      link: safeUrl(a.cameraURL) || 'https://cameras.alertcalifornia.org/',
    };
  }).filter((c) => c && inBox(b, c.lat, c.lon));
}

const titleCase = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());

async function webcams({ bbox }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  const named = [
    ['windy', windyWebcams], ['nycdot', nycWebcams],
    ['openwebcamdb', owcdbWebcams], ['alertca', alertCaWebcams],
  ];
  const results = await Promise.allSettled(named.map(([, fn]) => fn(b)));

  const cams = [];
  const problems = {};
  const bySource = {};
  results.forEach((r, i) => {
    const name = named[i][0];
    if (r.status === 'fulfilled') { bySource[name] = r.value.length; cams.push(...r.value); }
    else problems[name] = r.reason?.message || String(r.reason);
  });

  return {
    count: cams.length,
    bySource,
    windyConfigured: !!CFG.windyKey,
    owcdbConfigured: !!CFG.owcdbKey,
    problems,
    webcams: cams,
  };
}

// ---------------------------------------------------------------------------
// SITUATIONAL AWARENESS — live hazard and disaster events
//
// Five independent feeds normalised into one record shape. Each is fetched
// and cached separately so a single upstream outage degrades one source
// rather than the whole layer.
//
// Note on RSOE EDIS (rsoe-edis.org): its event feed is an enterprise product
// (GeoJSON API, €4,000/year at time of writing) with no free tier. If you
// license it, set EDIS_API_URL and EDIS_API_KEY in .env and the `edis`
// source below will fetch and normalise it alongside the rest.
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { __proto__: null, red: 3, orange: 2, green: 1, info: 0 };

const EVENT_SOURCES = {
  gdacs: { label: 'GDACS alerts', color: '#ff2d55', note: 'Global Disaster Alert & Coordination System — EU JRC / UN.' },
  eonet: { label: 'NASA EONET', color: '#ff9f1c', note: 'Natural event tracker: storms, fires, ice, volcanoes.' },
  usgs:  { label: 'USGS quakes', color: '#f72585', note: 'Every earthquake reported in the last 24 hours.' },
  nws:   { label: 'NWS alerts', color: '#4cc9f0', note: 'US watches, warnings and advisories. Only ~15% carry polygons.' },
  firms: { label: 'NASA FIRMS fires', color: '#ff6b35', note: 'VIIRS active-fire detections. Needs FIRMS_MAP_KEY.' },
  edis:  { label: 'RSOE EDIS', color: '#c77dff', note: 'Enterprise feed — needs EDIS_API_URL + EDIS_API_KEY.' },
};

/** GDACS event-type codes → readable names. */
const GDACS_TYPES = {
  __proto__: null,
  EQ: 'Earthquake', TC: 'Tropical cyclone', FL: 'Flood',
  VO: 'Volcano', DR: 'Drought', WF: 'Wildfire', TS: 'Tsunami',
};

const inBox = (b, lat, lon) =>
  lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;

/* --- GDACS ---------------------------------------------------------- */
async function gdacsEvents(b) {
  const day = 86400_000;
  const to = new Date();
  const from = new Date(to.getTime() - 30 * day);
  const iso = (d) => d.toISOString().slice(0, 10);

  const url = new URL('https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH');
  url.searchParams.set('fromDate', iso(from));
  url.searchParams.set('toDate', iso(to));
  url.searchParams.set('alertlevel', 'Green;Orange;Red');

  const raw = await cached('ev:gdacs', RETAIN['current.events'], () =>
    grab(url, {}, { label: 'GDACS', timeoutMs: 30000 }));

  return (raw.features || []).map((f) => {
    const [lon, lat] = f.geometry?.coordinates || [];
    if (lat == null || lon == null) return null;
    const p = f.properties || {};
    const sev = p.severitydata || {};
    return {
      source: 'gdacs',
      id: `gdacs:${p.eventtype}:${p.eventid}:${p.episodeid}`,
      title: p.name || p.description || GDACS_TYPES[p.eventtype] || 'Event',
      kind: GDACS_TYPES[p.eventtype] || p.eventtype,
      lat, lon,
      severity: String(p.alertlevel || 'info').toLowerCase(),
      severityLabel: `${p.alertlevel} alert`,
      magnitude: sev.severity ?? null,
      magnitudeUnit: sev.severityunit || null,
      magnitudeText: sev.severitytext || null,
      country: p.country || null,
      time: p.fromdate || null,
      endTime: p.todate || null,
      description: p.htmldescription ? String(p.htmldescription).replace(/<[^>]*>/g, '') : null,
      url: safeUrl(p.url?.report),
      polygon: null,
    };
  }).filter((e) => e && inBox(b, e.lat, e.lon));
}

/* --- NASA EONET ------------------------------------------------------ */
async function eonetEvents(view) {
  const b = viewCell(view, 'events');
  const url = new URL('https://eonet.gsfc.nasa.gov/api/v3/events/geojson');
  url.searchParams.set('status', 'open');
  url.searchParams.set('days', '60');
  // EONET's bbox order is min-lon, max-lat, max-lon, min-lat.
  url.searchParams.set('bbox', `${b.west},${b.north},${b.east},${b.south}`);

  const key = `ev:eonet:${b.key}`;
  const raw = await cached(key, RETAIN['current.events'], () =>
    grab(url, {}, { label: 'EONET', timeoutMs: 25000 }));

  return (raw.features || []).map((f) => {
    const p = f.properties || {};
    let lat, lon, polygon = null;
    if (f.geometry?.type === 'Point') {
      [lon, lat] = f.geometry.coordinates;
    } else if (f.geometry?.type === 'Polygon') {
      polygon = f.geometry.coordinates[0];
      const n = polygon.length || 1;
      lon = polygon.reduce((s, c) => s + c[0], 0) / n;
      lat = polygon.reduce((s, c) => s + c[1], 0) / n;
    } else return null;
    if (lat == null || lon == null) return null;

    return {
      source: 'eonet',
      id: `eonet:${p.id}`,
      title: p.title,
      kind: p.categories?.[0]?.title || 'Natural event',
      lat, lon,
      severity: 'orange',
      severityLabel: 'Active event',
      magnitude: p.magnitudeValue ?? null,
      magnitudeUnit: p.magnitudeUnit || null,
      magnitudeText: p.magnitudeValue ? `${p.magnitudeValue} ${p.magnitudeUnit || ''}`.trim() : null,
      country: null,
      time: p.date || null,
      endTime: p.closed || null,
      description: p.description || null,
      url: safeUrl(p.sources?.[0]?.url) || `https://eonet.gsfc.nasa.gov/api/v3/events/${encodeURIComponent(p.id)}`,
      polygon,
    };
  }).filter(Boolean);
}

/* --- USGS ------------------------------------------------------------ */
async function usgsEvents(b) {
  const raw = await cached('ev:usgs', RETAIN['current.events'], () =>
    grab('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
      {}, { label: 'USGS', timeoutMs: 25000 }));

  return (raw.features || []).map((f) => {
    const [lon, lat, depth] = f.geometry?.coordinates || [];
    if (lat == null || lon == null) return null;
    const p = f.properties || {};
    const m = p.mag ?? 0;
    return {
      source: 'usgs',
      id: `usgs:${f.id}`,
      title: p.title || `M ${m} earthquake`,
      kind: 'Earthquake',
      lat, lon,
      severity: m >= 6 ? 'red' : m >= 4.5 ? 'orange' : 'green',
      severityLabel: `M ${m}`,
      magnitude: m,
      magnitudeUnit: 'M',
      magnitudeText: `M ${m}, depth ${depth != null ? depth.toFixed(0) : '?'} km`,
      country: p.place || null,
      time: p.time ? new Date(p.time).toISOString() : null,
      endTime: null,
      description: [p.place, p.felt ? `${p.felt} felt reports` : null,
        p.tsunami ? 'TSUNAMI FLAG SET' : null].filter(Boolean).join(' · '),
      url: safeUrl(p.url),
      polygon: null,
      depthKm: depth ?? null,
    };
  }).filter((e) => e && inBox(b, e.lat, e.lon));
}

/* --- NWS ------------------------------------------------------------- */
const NWS_SEVERITY = { __proto__: null, Extreme: 'red', Severe: 'red', Moderate: 'orange', Minor: 'green', Unknown: 'info' };

async function nwsEvents(b) {
  const url = new URL('https://api.weather.gov/alerts/active');
  url.searchParams.set('status', 'actual');
  url.searchParams.set('message_type', 'alert');

  const raw = await cached('ev:nws', RETAIN['current.events'], () =>
    grab(url, {
      headers: {
        Accept: 'application/geo+json',
        'User-Agent': USER_AGENT,
      },
    }, { label: 'NWS', timeoutMs: 25000 }));

  // Roughly 85% of active alerts reference forecast zones rather than
  // carrying a polygon. Resolving each zone would be hundreds of extra
  // requests, so zone-only alerts are counted but not drawn.
  let zoneOnly = 0;
  const events = (raw.features || []).map((f) => {
    const p = f.properties || {};
    if (!f.geometry) { zoneOnly++; return null; }

    let ring = null;
    if (f.geometry.type === 'Polygon') ring = f.geometry.coordinates[0];
    else if (f.geometry.type === 'MultiPolygon') ring = f.geometry.coordinates[0]?.[0];
    if (!ring?.length) return null;

    const n = ring.length;
    const lon = ring.reduce((s, c) => s + c[0], 0) / n;
    const lat = ring.reduce((s, c) => s + c[1], 0) / n;

    return {
      source: 'nws',
      id: `nws:${p.id}`,
      title: p.event || 'Weather alert',
      kind: p.event || 'Weather alert',
      lat, lon,
      severity: NWS_SEVERITY[p.severity] || 'info',
      severityLabel: `${p.severity || 'Unknown'} · ${p.urgency || ''}`.trim(),
      magnitude: null,
      magnitudeUnit: null,
      magnitudeText: p.certainty ? `Certainty: ${p.certainty}` : null,
      country: p.areaDesc || null,
      time: p.onset || p.effective || p.sent || null,
      endTime: p.ends || p.expires || null,
      description: p.headline || (p.description || '').slice(0, 500) || null,
      instruction: p.instruction || null,
      url: safeUrl(p['@id']),
      polygon: ring,
    };
  }).filter((e) => e && inBox(b, e.lat, e.lon));

  events.zoneOnly = zoneOnly;
  return events;
}

/* --- NASA FIRMS ------------------------------------------------------ */
function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(head.map((h, i) => [h, (cells[i] ?? '').trim()]));
  });
}

async function firmsEvents(view) {
  if (!CFG.firmsKey) return [];
  const b = viewCell(view, 'events');
  const area = `${b.west.toFixed(3)},${b.south.toFixed(3)},${b.east.toFixed(3)},${b.north.toFixed(3)}`;
  const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(CFG.firmsKey)}`
    + `/VIIRS_SNPP_NRT/${area}/2`;

  const text = await cached(`ev:firms:${area}`, RETAIN['current.events'], () =>
    grab(url, {}, { as: 'text', label: 'FIRMS', timeoutMs: 30000 }));

  if (/Invalid|error/i.test(text.slice(0, 120)) && !text.includes('latitude')) {
    throw new UpstreamError(502, `FIRMS rejected the request: ${text.slice(0, 120)}`);
  }

  return parseCsv(text).map((r, i) => {
    const lat = Number(r.latitude), lon = Number(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const conf = (r.confidence || '').toLowerCase();
    const frp = Number(r.frp);
    return {
      source: 'firms',
      id: `firms:${r.acq_date}:${r.acq_time}:${i}`,
      title: `Fire detection${frp ? ` · ${frp.toFixed(1)} MW` : ''}`,
      kind: 'Active fire',
      lat, lon,
      severity: conf === 'h' || conf === 'high' ? 'red'
        : conf === 'n' || conf === 'nominal' ? 'orange' : 'green',
      severityLabel: `Confidence: ${conf || 'unknown'}`,
      magnitude: Number.isFinite(frp) ? frp : null,
      magnitudeUnit: 'MW',
      magnitudeText: [
        Number.isFinite(frp) ? `Radiative power ${frp.toFixed(1)} MW` : null,
        r.bright_ti4 ? `Brightness ${r.bright_ti4} K` : null,
      ].filter(Boolean).join(' · ') || null,
      country: null,
      time: r.acq_date && r.acq_time
        ? `${r.acq_date}T${String(r.acq_time).padStart(4, '0').replace(/(\d{2})(\d{2})/, '$1:$2')}:00Z`
        : null,
      endTime: null,
      description: `VIIRS ${r.daynight === 'D' ? 'daytime' : 'night-time'} detection, `
        + `scan ${r.scan || '?'} × track ${r.track || '?'}`,
      url: 'https://firms.modaps.eosdis.nasa.gov/',
      polygon: null,
    };
    // FIRMS is queried with an area parameter and should only return rows
    // inside it, but filter anyway so a widened upstream box can't leak
    // detections into a view that didn't ask for them.
  }).filter((e) => e && inBox(b, e.lat, e.lon));
}

/* --- RSOE EDIS (enterprise, opt-in) ---------------------------------- */
async function edisEvents(b) {
  if (!CFG.edisUrl) return [];
  const raw = await cached('ev:edis', RETAIN['current.events'], () =>
    grab(CFG.edisUrl, {
      headers: CFG.edisKey ? { Authorization: `Bearer ${CFG.edisKey}` } : {},
    }, { label: 'RSOE EDIS', timeoutMs: 30000 }));

  // EDIS ships GeoJSON; field names are not public, so normalise defensively.
  const feats = raw.features || raw.events || (Array.isArray(raw) ? raw : []);
  return feats.map((f, i) => {
    const p = f.properties || f;
    const g = f.geometry?.coordinates;
    const lat = Number(g?.[1] ?? p.latitude ?? p.lat);
    const lon = Number(g?.[0] ?? p.longitude ?? p.lon ?? p.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return {
      source: 'edis',
      id: `edis:${p.id ?? p.eventid ?? i}`,
      title: p.title || p.name || p.event_type || 'EDIS event',
      kind: p.category || p.event_type || p.type || 'Event',
      lat, lon,
      severity: String(p.severity || p.alertlevel || 'info').toLowerCase(),
      severityLabel: p.severity || p.alertlevel || 'reported',
      magnitude: null, magnitudeUnit: null, magnitudeText: null,
      country: p.country || p.area || null,
      time: p.date || p.created || p.fromdate || null,
      endTime: null,
      description: p.description || p.summary || null,
      url: safeUrl(p.url || p.link),
      polygon: null,
    };
  }).filter((e) => e && inBox(b, e.lat, e.lon));
}

/* --- unified endpoint ------------------------------------------------ */
const EVENT_FETCHERS = {
  __proto__: null,
  gdacs: gdacsEvents, eonet: eonetEvents, usgs: usgsEvents,
  nws: nwsEvents, firms: firmsEvents, edis: edisEvents,
};

async function events({ bbox, sources, minSeverity }) {
  const b = parseBbox(bbox);
  if (!b) throw new UpstreamError(400, 'bbox required as south,west,north,east');

  const want = String(sources || 'gdacs,eonet,usgs,nws')
    .split(',').map((s) => s.trim()).filter((s) => EVENT_FETCHERS[s]);
  if (!want.length) throw new UpstreamError(400, 'no valid sources requested');

  const floor = SEVERITY_RANK[minSeverity] ?? 0;
  const settled = await Promise.allSettled(want.map((s) => EVENT_FETCHERS[s](b)));

  const all = [];
  const problems = {};
  const bySource = {};
  let zoneOnly = 0;

  settled.forEach((r, i) => {
    const name = want[i];
    if (r.status === 'rejected') { problems[name] = r.reason?.message || String(r.reason); return; }
    const list = r.value || [];
    if (list.zoneOnly) zoneOnly += list.zoneOnly;
    const kept = list.filter((e) => (SEVERITY_RANK[e.severity] ?? 0) >= floor);
    bySource[name] = kept.length;
    all.push(...kept);
  });

  // Most severe first, then most recent.
  all.sort((x, y) => (SEVERITY_RANK[y.severity] ?? 0) - (SEVERITY_RANK[x.severity] ?? 0)
    || String(y.time || '').localeCompare(String(x.time || '')));

  return {
    count: all.length,
    bySource,
    problems,
    zoneOnlyAlerts: zoneOnly,
    firmsConfigured: !!CFG.firmsKey,
    edisConfigured: !!CFG.edisUrl,
    events: all.slice(0, 1500),
  };
}

// ---------------------------------------------------------------------------
// GEOCODING — Nominatim (requires a descriptive User-Agent per their policy)
// ---------------------------------------------------------------------------

async function geocode({ q }) {
  const query = String(q || '').trim();
  if (query.length < 2) throw new UpstreamError(400, 'q required');

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '6');
  url.searchParams.set('addressdetails', '1');

  // Memory only: the key is whatever was typed into the search box, and an
  // on-disk copy would be a search history that outlives the session.
  const raw = await cached(`geo:${query.toLowerCase()}`, RETAIN['places.geocode'], () =>
    grab(url, {
      headers: { 'User-Agent': USER_AGENT },
    }, { label: 'Nominatim' }));

  return {
    results: (raw || []).map((r) => ({
      name: r.display_name,
      short: r.name || r.display_name.split(',')[0],
      lat: Number(r.lat),
      lon: Number(r.lon),
      type: r.type,
      category: r.category,
      bbox: Array.isArray(r.boundingbox)
        ? [Number(r.boundingbox[0]), Number(r.boundingbox[2]),
           Number(r.boundingbox[1]), Number(r.boundingbox[3])]   // s,w,n,e
        : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Request gate — who may talk to this server
// ---------------------------------------------------------------------------
//
// The server holds paid API keys, so a request has to prove it came from this
// app's own page, not just reach the port:
//
//  1. Host check. Only the names this server is meant to be reached by are
//     accepted. That defeats DNS rebinding, where an attacker's domain is
//     re-pointed at 127.0.0.1 so their page counts as same-origin.
//  2. X-Panopticon header on /api/*. A page on another origin cannot add a
//     custom header without a CORS preflight, and this server never approves
//     one, so blind cross-site requests (spending Shodan credits, flushing the
//     cache) are refused. State-changing or free-form routes are POST-only.
//  3. Access key, only when bound beyond loopback (HOST=0.0.0.0 on Crostini,
//     or a LAN address). A LAN client can forge any Host header, so there the
//     browser must first open the URL printed at startup, which carries a
//     random key and exchanges it for an HttpOnly, SameSite=Strict cookie.

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const BOUND_TO_LOOPBACK = LOOPBACK_NAMES.has(CFG.host);

const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${CFG.port}`,
  `localhost:${CFG.port}`,
  `[::1]:${CFG.port}`,
  ...(BOUND_TO_LOOPBACK || CFG.host === '0.0.0.0' || CFG.host === '::'
    ? [] : [`${CFG.host.includes(':') ? `[${CFG.host}]` : CFG.host}:${CFG.port}`.toLowerCase()]),
  ...String(process.env.ALLOWED_HOSTS || '')
    .split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
]);

const ACCESS_KEY = BOUND_TO_LOOPBACK ? null
  : ((process.env.ACCESS_KEY || '').trim() || crypto.randomBytes(18).toString('base64url'));
const ACCESS_COOKIE = 'op_access';

function sameSecret(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** Host and (when bound beyond loopback) access-key check. False = handled. */
function gate(req, res) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    log('warn', `refused request for Host "${host || '(none)'}" — add it to ALLOWED_HOSTS if it is yours`);
    res.writeHead(421, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('Misdirected request');
    return false;
  }
  if (!ACCESS_KEY) return true;

  const url = new URL(req.url, `http://${host}`);
  const offered = url.searchParams.get('key');
  if (offered && sameSecret(offered, ACCESS_KEY)) {
    url.searchParams.delete('key');
    res.writeHead(303, {
      ...SECURITY_HEADERS,
      'Set-Cookie': `${ACCESS_COOKIE}=${ACCESS_KEY}; HttpOnly; SameSite=Strict; Path=/`,
      Location: url.pathname + url.search,
    }).end();
    return false;
  }
  const held = cookieValue(req, ACCESS_COOKIE);
  if (held && sameSecret(held, ACCESS_KEY)) return true;
  res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' })
    .end('OpenPanopticon is reachable from the network, so it needs its access key.\n'
      + 'Open the full URL (with ?key=…) printed in the terminal where the server started.');
  return false;
}

const POST_ONLY = new Set(['/api/flush']);

/** Custom-header and method rules for /api/*. False = handled. */
function apiAllowed(req, res, pathname, params) {
  if (req.headers['x-panopticon'] !== '1') {
    sendJson(res, 403, { error: 'missing X-Panopticon header', source: pathname });
    return false;
  }
  const needsPost = POST_ONLY.has(pathname) || (pathname === '/api/shodan' && params.has('q'));
  const ok = needsPost ? req.method === 'POST' : (req.method === 'GET' || req.method === 'POST');
  if (!ok) {
    res.setHeader('Allow', needsPost ? 'POST' : 'GET, POST');
    sendJson(res, 405, { error: `${pathname} needs ${needsPost ? 'POST' : 'GET'}`, source: pathname });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Response hardening
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // The browser default, stated explicitly: same-origin requests (the CARTO
  // tile proxy) keep the full referrer; third parties see only the origin,
  // which OSM's tile policy requires.
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  // Pages on other sites cannot embed anything this server answers, so they
  // cannot use an image load to learn that OpenPanopticon is running here.
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// Enforced. What each directive allows, and why:
//  - script-src: this origin and the pinned Cesium build on cdnjs, nothing
//    else, and no 'unsafe-inline'. Markup that slips past esc() cannot run:
//    inline handlers, javascript: URLs and injected <script> are refused, and
//    script-src-attr 'none' says the same for on* attributes.
//    'unsafe-eval' is there for Cesium alone: the Knockout build bundled in
//    Cesium.js calls eval("this") as it loads (and Function() for widget
//    bindings), and WebAssembly decoders (Draco, Basis) need it too. Without
//    it Cesium.js throws before the globe exists. It does not let injected
//    markup run; only script already on the page can eval.
//  - worker-src: Cesium builds its workers from blob: URLs that importScripts
//    its own files from cdnjs.
//  - style-src keeps 'unsafe-inline': the UI sets inline styles throughout,
//    and CSS cannot run script.
//  - img-src is https only (plus data:/blob: for Cesium and canvases). Every
//    camera and photo source in use serves https; an http image now fails
//    and its panel hides it.
//  - connect-src stays https: because the browser fetches map tiles itself
//    from hosts that are configurable (TITILER_URL, SHORTBREAD_URL) and from
//    Cesium Ion's CDN.
//  - The one http exception: Cesium World Imagery is Bing aerial tiles, and
//    Cesium asks Bing for tile URLs in the page's own scheme. Served from
//    http://localhost that means http:// tile URLs, which an https-only
//    policy blocks tile by tile, leaving a bare blue globe. Only Bing's tile
//    hosts are allowed over http.
//  - frame-src stays https: because webcam players come from whatever host a
//    camera directory names. Those frames are cross-origin and sandboxed
//    (see WebcamLayer.enrich), so they cannot reach this page.
const BING_TILES_HTTP = 'http://*.tiles.virtualearth.net';
// The tile ports (see "Tile ports") are other origins as far as the browser
// is concerned, so a page served as host:PORT may also load from host:PORT+n.
const cspFor = (host) => {
  const name = String(host || '').replace(/:\d+$/, '');
  const extra = name && tilePortsLive.length
    ? ' ' + tilePortsLive.map((p) => `http://${name}:${p}`).join(' ') : '';
  return CSP.replace(`img-src 'self'`, `img-src 'self'${extra}`)
    .replace(`connect-src 'self'`, `connect-src 'self'${extra}`);
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' https://cdnjs.cloudflare.com",
  "script-src-attr 'none'",
  "worker-src 'self' blob: https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  `img-src 'self' data: blob: https: ${BING_TILES_HTTP}`,
  "media-src 'self' blob: https:",
  `connect-src 'self' data: blob: https: ${BING_TILES_HTTP}`,
  'frame-src https:',
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * An upstream-supplied URL, or null unless its scheme is http(s).
 *
 * Escaping HTML does nothing about a `javascript:` or `data:` URL, and these
 * values end up as hrefs, image sources and iframe sources. Iframes run
 * scripts, so their sources must be https.
 */
function safeUrl(u, { httpsOnly = false } = {}) {
  if (typeof u !== 'string' || !u.trim()) return null;
  try {
    const p = new URL(u.trim());
    if (p.protocol === 'https:' || (!httpsOnly && p.protocol === 'http:')) return p.href;
  } catch { /* not an absolute URL */ }
  return null;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const MIME = {
  __proto__: null,
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}


// ---------------------------------------------------------------------------
// BASE MAP — swappable ground imagery
// ---------------------------------------------------------------------------
//
// Three providers, deliberately ordered by how much setup they need:
//
//   osm       the default. No key, no quota, always works.
//   sentinel2 10m Sentinel-2 L2A from the AWS Open Data mirror. Scenes are
//             discovered through the Earth Search STAC API and rendered to
//             XYZ tiles by a TiTiler instance. No credentials at all — the
//             same scenes a Google Earth Engine viewer would show, reached
//             without Earth Engine.
//   gee       true Earth Engine. Requires a Google Cloud service account, so
//             it only appears once one is configured.
//
// Tile URLs are handed to the browser rather than proxied: imagery is
// megabytes per screen, and relaying it through this process would add a hop
// for no benefit. Scene *discovery* does come through here, so the STAC query
// is cached and shared between clients.

const STAC_SEARCH = 'https://earth-search.aws.element84.com/v1/search';

// Shortbread-schema OpenStreetMap vector tiles. VersaTiles serves these
// worldwide, unauthenticated and CORS-open, to zoom 14. Point this at your own
// deployment with SHORTBREAD_URL if you would rather not lean on theirs.
const SHORTBREAD_URL = (process.env.SHORTBREAD_URL
  || 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}').trim();
const STAC_COLLECTION = 'sentinel-2-l2a';

/** Public TiTiler by default; point at your own with TITILER_URL. */
const TITILER = (process.env.TITILER_URL || 'https://titiler.xyz').replace(/\/+$/, '');

/**
 * Recent Sentinel-2 scenes covering a view.
 *
 * `from`/`to` bound the search, `maxCloud` drops the ones you cannot see
 * through. Results are newest first, which is almost always what you want —
 * but the least cloudy scene is flagged too, since "most recent" and "most
 * useful" are often different scenes.
 */
async function sentinelScenes({ bbox, from, to, maxCloud, limit }) {
  const box = parseBbox(bbox);
  if (!box) throw new UpstreamError(400, 'a bbox is required to find imagery');
  const { south, west, north, east } = box;

  const end = to || new Date().toISOString().slice(0, 10);
  const start = from || (() => {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  const cloud = clamp(parseInt(maxCloud ?? '40', 10) || 40, 0, 100);
  const cap = clamp(parseInt(limit || '24', 10) || 24, 1, 50);

  const body = {
    collections: [STAC_COLLECTION],
    bbox: [west, south, east, north],
    datetime: `${start}T00:00:00Z/${end}T23:59:59Z`,
    query: { 'eo:cloud_cover': { lt: cloud } },
    sortby: [{ field: 'properties.datetime', direction: 'desc' }],
    limit: cap,
  };

  const key = `stac:${JSON.stringify(body)}`;
  const raw = await cachedPersistent(key, RETAIN['maps.scenes'], () => grab(STAC_SEARCH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { label: 'Earth Search', timeoutMs: 25000 }));

  const scenes = (raw.features || []).map((f) => {
    // TCI is the pre-rendered true-colour composite: no band maths needed,
    // which keeps tile rendering fast enough to pan around on.
    const href = f.assets?.visual?.href || f.assets?.visual_jp2?.href || null;
    if (!href) return null;
    return {
      id: f.id,
      datetime: f.properties?.datetime || null,
      date: (f.properties?.datetime || '').slice(0, 10),
      cloud: Math.round(f.properties?.['eo:cloud_cover'] ?? 0),
      platform: f.properties?.platform || null,
      tile: f.properties?.['grid:code'] || f.properties?.['s2:granule_id'] || null,
      url: sentinelTileTemplate(href),
    };
  }).filter(Boolean);

  const clearest = scenes.length
    ? scenes.reduce((a, b) => (b.cloud < a.cloud ? b : a)).id
    : null;

  return {
    provider: 'sentinel2',
    label: 'Sentinel-2 L2A (10 m)',
    attribution: 'Copernicus Sentinel data / AWS Open Data / TiTiler',
    window: { from: start, to: end, maxCloud: cloud },
    matched: raw.numberMatched ?? scenes.length,
    returned: scenes.length,
    clearest,
    maxLevel: 15,          // 10 m ground sample; past z15 it is just upsampled
    scenes,
  };
}

function sentinelTileTemplate(cogHref) {
  const u = `${TITILER}/cog/tiles/WebMercatorQuad/{z}/{x}/{y}.png`
    + `?url=${encodeURIComponent(cogHref)}`;
  // Cesium substitutes {z}/{x}/{y} itself, so they must survive un-encoded.
  return u;
}

/* ---- Google Earth Engine (optional) -------------------------------- */

const GEE = {
  project: (process.env.GEE_PROJECT || '').trim(),
  clientEmail: (process.env.GEE_CLIENT_EMAIL || '').trim(),
  privateKey: (process.env.GEE_PRIVATE_KEY || '').trim().replace(/\\n/g, '\n'),
};
const geeConfigured = () => !!(GEE.project && GEE.clientEmail && GEE.privateKey);

let geeToken = { value: null, expires: 0 };

/** Service-account JWT -> OAuth access token, cached until just before expiry. */
async function geeAccessToken() {
  if (geeToken.value && geeToken.expires > Date.now() + 60_000) return geeToken.value;

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({
    iss: GEE.clientEmail,
    scope: 'https://www.googleapis.com/auth/earthengine.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  });
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claim}`);
  const sig = signer.sign(GEE.privateKey, 'base64url');

  const res = await grab('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claim}.${sig}`,
    }),
  }, { label: 'Google OAuth', timeoutMs: 15000 });

  geeToken = {
    value: res.access_token,
    expires: Date.now() + (res.expires_in || 3600) * 1000,
  };
  return geeToken.value;
}

/**
 * A cloud-masked Sentinel-2 median composite over the requested window.
 *
 * Earth Engine takes a serialised expression graph rather than source, so the
 * pipeline below is spelled out node by node: filter the collection by date
 * and bounds, drop scenes above the cloud threshold, take the per-pixel
 * median, then visualise B4/B3/B2.
 */
async function geeComposite({ bbox, from, to, maxCloud }) {
  if (!geeConfigured()) {
    throw new UpstreamError(501,
      'Earth Engine is not configured. Set GEE_PROJECT, GEE_CLIENT_EMAIL and '
      + 'GEE_PRIVATE_KEY in .env to enable it — see the README.');
  }
  const box = parseBbox(bbox);
  if (!box) throw new UpstreamError(400, 'a bbox is required');
  const { south, west, north, east } = box;
  const end = to || new Date().toISOString().slice(0, 10);
  const start = from || (() => {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 30);
    return d.toISOString().slice(0, 10);
  })();
  const cloud = clamp(parseInt(maxCloud ?? '40', 10) || 40, 0, 100);

  const token = await geeAccessToken();
  const expression = {
    values: {
      out: {
        functionInvocationValue: {
          functionName: 'Image.visualize',
          arguments: {
            image: {
              functionInvocationValue: {
                functionName: 'reduce.median',
                arguments: {
                  collection: {
                    functionInvocationValue: {
                      functionName: 'Collection.filter',
                      arguments: {
                        collection: {
                          functionInvocationValue: {
                            functionName: 'Collection.filterBounds',
                            arguments: {
                              collection: {
                                functionInvocationValue: {
                                  functionName: 'Collection.filterDate',
                                  arguments: {
                                    collection: {
                                      functionInvocationValue: {
                                        functionName: 'ImageCollection.load',
                                        arguments: { id: { constantValue: 'COPERNICUS/S2_SR_HARMONIZED' } },
                                      },
                                    },
                                    start: { constantValue: start },
                                    end: { constantValue: end },
                                  },
                                },
                              },
                              geometry: {
                                functionInvocationValue: {
                                  functionName: 'GeometryConstructors.Rectangle',
                                  arguments: {
                                    coordinates: { constantValue: [west, south, east, north] },
                                    geodesic: { constantValue: false },
                                  },
                                },
                              },
                            },
                          },
                        },
                        filter: {
                          functionInvocationValue: {
                            functionName: 'Filter.lessThan',
                            arguments: {
                              leftField: { constantValue: 'CLOUDY_PIXEL_PERCENTAGE' },
                              rightValue: { constantValue: cloud },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            bands: { constantValue: ['B4', 'B3', 'B2'] },
            min: { constantValue: [0] },
            max: { constantValue: [3000] },
          },
        },
      },
    },
    result: 'out',
  };

  const made = await grab(
    `https://earthengine.googleapis.com/v1/projects/${encodeURIComponent(GEE.project)}/maps`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression, fileFormat: 'PNG' }),
    }, { label: 'Earth Engine', timeoutMs: 45000 });

  return {
    provider: 'gee',
    label: 'Earth Engine — Sentinel-2 median composite',
    attribution: 'Google Earth Engine / Copernicus',
    window: { from: start, to: end, maxCloud: cloud },
    maxLevel: 15,
    scenes: [],
    composite: {
      id: made.name,
      url: `https://earthengine.googleapis.com/v1/${made.name}/tiles/{z}/{x}/{y}`,
    },
  };
}

/** What the client may offer in the base-map menu. */
function basemapProviders() {
  return [
    { key: 'osm', label: 'Streets (OpenStreetMap)', kind: 'static', available: true,
      note: 'Street map. No key, no quota.' },
    // Aerial photography, and the honest caveat about it: coverage is
    // stitched from many surveys and a given place can be years old.
    { key: 'cesium', label: 'Aerial (Cesium World Imagery)', kind: 'static',
      available: !!CFG.cesiumIonToken,
      note: CFG.cesiumIonToken
        ? 'High resolution, but capture dates vary by years between regions. '
          + 'Use Sentinel-2 when you need to know how recent the picture is.'
        : 'Needs CESIUM_ION_TOKEN in .env.' },
    { key: 'shortbread', label: 'Vector (OSM Shortbread)', kind: 'vector', available: true,
      note: 'OpenStreetMap vector tiles drawn in the terminal palette. Rendered in '
        + 'the browser from the Shortbread schema via VersaTiles; no key, to zoom 14.' },
    { key: 'sentinel2', label: 'Sentinel-2 (10 m)', kind: 'scenes', available: true,
      note: 'Recent Copernicus imagery via AWS Open Data. Pick a date window and a scene.' },
    { key: 'gee', label: 'Earth Engine composite', kind: 'composite',
      available: geeConfigured(),
      note: geeConfigured()
        ? 'Cloud-masked Sentinel-2 median over the chosen window.'
        : 'Needs a Google service account — set GEE_* in .env.' },
  ];
}

async function basemap({ provider, bbox, from, to, maxCloud, limit }) {
  const p = provider || 'sentinel2';
  if (p === 'sentinel2') return sentinelScenes({ bbox, from, to, maxCloud, limit });
  if (p === 'gee') return geeComposite({ bbox, from, to, maxCloud });
  if (p === 'osm') {
    return {
      provider: 'osm', label: 'Streets (OpenStreetMap)',
      attribution: '© OpenStreetMap contributors',
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxLevel: 19, scenes: [],
    };
  }
  if (p === 'shortbread') {
    // Vector tiles: the browser fetches and draws these itself, so the only
    // thing to settle here is where they come from.
    return {
      provider: 'shortbread', label: 'Vector (OSM Shortbread)',
      attribution: '© OpenStreetMap contributors · Shortbread schema via VersaTiles',
      url: SHORTBREAD_URL, vector: true, maxLevel: 14, scenes: [],
      note: 'Drawn in the browser from vector tiles, so it carries no imagery date '
        + '— it is the map, not a photograph.',
    };
  }
  if (p === 'cesium') {
    // Handled in the browser, which already holds the Ion session — the
    // server only says whether it is available and what it is.
    if (!CFG.cesiumIonToken) {
      throw new UpstreamError(501, 'Aerial imagery needs CESIUM_ION_TOKEN in .env.');
    }
    return {
      provider: 'cesium', label: 'Aerial (Cesium World Imagery)',
      attribution: 'Cesium Ion / Maxar / Earthstar Geographics',
      builtin: true, maxLevel: 19, scenes: [],
      note: 'Capture dates vary by region; this is a mosaic of many surveys.',
    };
  }
  throw new UpstreamError(400, `unknown base map provider "${p}"`);
}

const ROUTES = {
  '/api/health': async () => ({
    ok: true,
    sources: {
      shodan: CFG.shodanKey ? 'configured' : 'missing SHODAN_API_KEY',
      opensky: CFG.openSkyId ? 'authenticated' : 'anonymous (400 credits/day)',
      celestrak: 'open',
      sentinel2: 'open (AWS Open Data)',
      earthengine: geeConfigured() ? 'configured' : 'not configured (optional)',
      overpass: 'open',
      windy: CFG.windyKey ? 'configured' : 'missing WINDY_API_KEY (other cam sources still work)',
      openwebcamdb: CFG.owcdbKey ? 'configured' : 'missing OPENWEBCAMDB_API_KEY',
      alertcalifornia: 'open (wildfire PTZ cameras)',
      cesiumIon: CFG.cesiumIonToken ? 'configured' : 'not set (OSM basemap only)',
      gdacs: 'open', eonet: 'open', usgs: 'open', nws: 'open',
      alpr: 'open (OpenStreetMap via Overpass)',
      geoip: 'open (ipwho.is)',
      adsbdb: 'open (flight routes)',
      rainviewer: 'open (radar + satellite)',
      gibs: 'open (NASA daily imagery)',
      ais: CFG.aisKey ? `configured (stream: ${ais.status})` : 'missing AISSTREAM_API_KEY',
      atlas: 'open (RIPE Atlas probes)',
      tor: 'open (country-level only — Onionoo dropped relay coordinates)',
      opencellid: CFG.openCellIdKey ? 'configured' : 'missing OPENCELLID_API_KEY',
      wigle: CFG.wigleName ? 'configured' : 'missing WIGLE_API_NAME / WIGLE_API_TOKEN',
      sensorCommunity: 'open (IoT air + noise sensors)',
      greynoise: CFG.greyNoiseKey ? 'configured' : 'unauthenticated (10 lookups/day)',
      abusech: 'open (botnet C2 list)',
      ioda: 'open (internet outages)',
      eia: CFG.eiaKey ? 'configured' : 'missing EIA_API_KEY',
      cloudflareRadar: CFG.cloudflareToken ? 'configured' : 'missing CLOUDFLARE_API_TOKEN',
      raspberryShake: 'open (citizen seismographs)',
      fiveEleven: Object.keys(CFG.fiveElevenKeys).length
        ? `configured: ${Object.keys(CFG.fiveElevenKeys).join(', ')}`
        : 'no states in FIVE_ELEVEN_KEYS',
      firms: CFG.firmsKey ? 'configured' : 'missing FIRMS_MAP_KEY',
      edis: CFG.edisUrl ? 'configured' : 'not licensed (enterprise feed)',
    },
    presets: {
      shodan: Object.fromEntries(
        Object.entries(SHODAN_PRESETS).map(([k, v]) => [k, { label: v.label, note: v.note }])),
      overpass: Object.fromEntries(
        Object.entries(OVERPASS_PRESETS).map(([k, v]) => [k, { label: v.label, color: v.color }])),
      satellites: SAT_GROUPS,
      basemaps: basemapProviders(),
      alprVendors: ALPR_VENDORS.map(({ key, label, color }) => ({ key, label, color })),
      netinfra: Object.fromEntries(Object.entries(NETINFRA_SOURCES).map(([k, v]) => [k, {
        label: v.label, color: v.color, note: v.note,
        available: !v.keyed
          || (k === 'cell' ? !!CFG.openCellIdKey : k === 'wigle' ? !!CFG.wigleName : true),
      }])),
      imagery: GIBS_LAYERS,
      fiveElevenHosts: Object.keys(FIVE_ELEVEN_HOSTS),
      events: Object.fromEntries(Object.entries(EVENT_SOURCES).map(([k, v]) => [k, {
        label: v.label, color: v.color, note: v.note,
        available: k === 'firms' ? !!CFG.firmsKey : k === 'edis' ? !!CFG.edisUrl : true,
      }])),
    },
  }),

  '/api/config': async () => ({
    cesiumIonToken: CFG.cesiumIonToken || null,
    // Only whether labels can be drawn; the CARTO key itself stays here.
    cartoLabels: !!CFG.cartoKey,
    // Tile hosts the browser should fetch through the disk cache.
    tileCache: { hosts: tileCacheHosts(), ports: tilePortsLive },
    // How long the browser should treat a view as already fetched, per
    // layer, so it does not re-ask the server about what it still holds.
    retention: {
      shodan: RETAIN['shodan.hosts'],
      overpass: RETAIN['overpass.infrastructure'],
      alpr: RETAIN['overpass.alpr'],
      netinfra: RETAIN['network.infrastructure'],
      webcams: RETAIN['cameras.directories'],
      events: RETAIN['current.events'],
      iot: RETAIN['current.sensors'],
      traffic: RETAIN['current.traffic'],
    },
  }),
  // A free-form query (q=) is accepted only by POST — see apiAllowed().
  '/api/shodan': (q) => shodanSearch({ bbox: q.get('bbox'), preset: q.get('preset'), custom: q.get('q') }),
  '/api/shodan/credits': () => shodanCredits(),
  '/api/flights': (q) => flights({ bbox: q.get('bbox') }),
  '/api/satellites': (q) => satellites({ group: q.get('group'), limit: q.get('limit') }),
  '/api/overpass': (q) => overpass({
    bbox: q.get('bbox'),
    presets: q.get('presets'),
    preset: q.get('preset'),        // still accepted, single class
    limit: q.get('limit'),
  }),
  '/api/webcams': (q) => webcams({ bbox: q.get('bbox') }),
  '/api/events': (q) => events({
    bbox: q.get('bbox'), sources: q.get('sources'), minSeverity: q.get('minSeverity'),
  }),
  '/api/alpr': (q) => alpr({ bbox: q.get('bbox'), vendor: q.get('vendor'), limit: q.get('limit') }),
  '/api/geoip': () => geoip(),
  '/api/route': (q) => flightRoute({ callsign: q.get('callsign') }),
  '/api/aircraft': (q) => aircraftInfo({ icao24: q.get('icao24') }),
  '/api/weather': () => weather(),
  '/api/vessels': (q) => vessels({ bbox: q.get('bbox') }),
  '/api/netinfra': (q) => netinfra({ bbox: q.get('bbox'), sources: q.get('sources') }),
  '/api/iot': (q) => iotSensors({ bbox: q.get('bbox'), includeIndoor: q.get('indoor') === '1' }),
  '/api/enrich': (q) => enrich({ ip: q.get('ip') }),
  '/api/signals': (q) => signals({ bbox: q.get('bbox') }),
  '/api/traffic': (q) => traffic({ bbox: q.get('bbox') }),
  '/api/imagery': (q) => imagery({ layer: q.get('layer'), date: q.get('date') }),
  '/api/flush': async () => {
    // FLUSH has to reach the disk tier too, otherwise "drop everything and
    // refetch" quietly serves the same days-old answer straight back.
    const files = await clearDiskCache();
    const entries = cache.size;
    cache.clear();
    shodanIdx = null;
    return { ok: true, memoryEntries: entries, diskEntries: files };
  },
  '/api/basemap': (q) => basemap({
    provider: q.get('provider'), bbox: q.get('bbox'), from: q.get('from'),
    to: q.get('to'), maxCloud: q.get('maxCloud'), limit: q.get('limit'),
  }),
  '/api/geocode': (q) => geocode({ q: q.get('q') }),
};

// ---------------------------------------------------------------------------
// Map tile disk cache
// ---------------------------------------------------------------------------
//
// Base-map and imagery tiles, kept on disk for TTL.tile (a month) so that
// returning to a place, a reload or a restart is drawn from here rather than
// fetched again. The browser asks /tiles/cache?u=<tile url>; this fetches the
// tile once, stores it under providers/tiles, and serves the copy until it
// expires. Expired tiles are deleted when read and swept by pruneTileCache()
// at startup and every six hours, which also keeps the folder under
// TILE_CACHE_MAX_MB by dropping the oldest tiles first.
//
// Only known tile sources are fetched, each limited to its tile paths: an
// open "fetch any URL for me" endpoint would let any page that can reach
// this server use it as a proxy. Weather radar is deliberately absent; a
// radar frame is a moment, not a map, and is useless within the hour.

const TILE_DIR = path.join(PROVIDERS_DIR, 'tiles');
// maps.tiles and maps.tiles_max_size in cache.conf.
const tileMaxAge = () => RETAIN['maps.tiles'];
const TILE_MAX_BYTES = 8 * 1024 * 1024;   // no real tile is this big

/** A configured URL template's host and the path prefix its tiles live under. */
function templateSource(template, label) {
  try {
    const u = new URL(template.replace(/\{[^}]+\}/g, '0'));
    const raw = new URL(template.split('{')[0]);
    const prefix = decodeURIComponent(raw.pathname);
    return [{ label, hosts: [u.host], path: (p) => p.startsWith(prefix) }];
  } catch {
    return [];
  }
}

const TILE_SOURCES = [
  // Cesium World Imagery: Bing aerial tiles, quadkey addressed.
  { label: 'Bing aerial', hosts: [0, 1, 2, 3, 4, 5, 6, 7].map((n) => `ecn.t${n}.tiles.virtualearth.net`),
    path: (p) => /^\/tiles\/[a-z]\d{1,30}\.(jpeg|png)$/.test(p) },
  { label: 'OpenStreetMap', hosts: ['tile.openstreetmap.org'],
    path: (p) => /^\/\d{1,2}\/\d{1,7}\/\d{1,7}\.png$/.test(p) },
  // The location inset's aerial style.
  { label: 'Esri imagery', hosts: ['server.arcgisonline.com'],
    path: (p) => p.startsWith('/ArcGIS/rest/services/World_Imagery/MapServer/tile/') },
  { label: 'NASA GIBS', hosts: ['gibs.earthdata.nasa.gov'], path: (p) => p.startsWith('/wmts/') },
  ...templateSource(SHORTBREAD_URL, 'Shortbread'),
  ...templateSource(`${TITILER}/cog/tiles/{z}`, 'TiTiler'),
];

/** Hosts whose tiles the browser should ask for through /tiles/cache. */
function tileCacheHosts() {
  return [...new Set(TILE_SOURCES.flatMap((s) => s.hosts))];
}

/** The tile source a URL belongs to, or null if this server will not fetch it. */
function tileSourceFor(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  return TILE_SOURCES.find((s) => s.hosts.includes(u.host) && s.path(u.pathname)) || null;
}

// Named by a hash of the address, never the address itself, in keeping with
// the answer cache: the folder should not read as a list of places looked at.
// Sharded by the first two hex digits so no one directory holds them all.
function tileFile(key) {
  const h = crypto.createHash('sha1').update(`openpanopticon:${key}`).digest('hex');
  return path.join(TILE_DIR, h.slice(0, 2), `${h}.tile`);
}

/**
 * A stored tile, or null. One file per tile: a header line
 * "<status> <content-type>" and then the bytes. The age is the file's mtime,
 * which is when it was fetched; reading it does not renew it, so a tile is
 * re-fetched a month after it was downloaded however often it is used.
 */
async function readTile(key, now = Date.now()) {
  const file = tileFile(key);
  let st;
  try { st = await fsp.stat(file); } catch { return null; }
  if (now - st.mtimeMs > tileMaxAge()) {
    await fsp.unlink(file).catch(() => {});
    return null;
  }
  try {
    const buf = await fsp.readFile(file);
    const nl = buf.indexOf(10);
    if (nl < 0 || nl > 200) return null;
    const [code, type] = buf.subarray(0, nl).toString('utf8').split(' ');
    const status = Number(code);
    if (!Number.isInteger(status)) return null;
    return { status, type: type || 'application/octet-stream', body: buf.subarray(nl + 1) };
  } catch {
    return null;
  }
}

async function writeTile(key, { status, type, body }) {
  if (!(tileMaxAge() > 0)) return;   // maps.tiles = 0: do not keep tiles
  const file = tileFile(key);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Write then rename, so a crash mid-write never leaves half a tile.
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fsp.writeFile(tmp, Buffer.concat([Buffer.from(`${status} ${type}\n`), body]));
    await fsp.rename(tmp, file);
  } catch (e) {
    log('warn', `could not store tile: ${e.message}`);
  }
}

const tileInflight = new Map();
const TILE_TYPE_RE = /^(image\/[\w.+-]+|application\/(x-protobuf|vnd\.mapbox-vector-tile|octet-stream))$/;

/**
 * A tile from disk, or fetched and stored. `fetcher` returns the upstream
 * Response. "Nothing here" (204/404, which vector sources answer over open
 * ocean) is stored too, so empty tiles are not asked for again either.
 */
async function cachedTile(key, fetcher) {
  if (tileInflight.has(key)) return tileInflight.get(key);
  const p = (async () => {
    const hit = await readTile(key);
    if (hit) return { ...hit, cache: 'hit' };
    let res;
    try {
      res = await fetcher();
    } catch (err) {
      throw err instanceof UpstreamError ? err : new UpstreamError(504, `tile source unreachable: ${err.message}`);
    }
    if (res.status === 204 || res.status === 404) {
      const rec = { status: res.status, type: 'text/plain', body: Buffer.alloc(0) };
      await writeTile(key, rec);
      return { ...rec, cache: 'miss' };
    }
    if (!res.ok) throw new UpstreamError(res.status, `tile source returned HTTP ${res.status}`);
    const type = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (!TILE_TYPE_RE.test(type)) throw new UpstreamError(502, `tile source returned ${type}, not a tile`);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > TILE_MAX_BYTES) throw new UpstreamError(502, 'tile source returned an oversized tile');
    const rec = { status: 200, type, body };
    await writeTile(key, rec);
    return { ...rec, cache: 'miss' };
  })().finally(() => tileInflight.delete(key));
  tileInflight.set(key, p);
  return p;
}

function fetchTileUpstream(url, headers = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  // No redirects: a source on the list must not be able to bounce this
  // server to an address that is not.
  return fetch(url, { headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'error', signal: ac.signal })
    .finally(() => clearTimeout(timer));
}

function sendTile(res, t) {
  const headers = {
    ...SECURITY_HEADERS,
    // The browser keeps its own copy for a day on top of the disk one.
    'Cache-Control': `public, max-age=${Math.round(RETAIN['maps.browser'] / 1000)}`,
    'X-Tile-Cache': t.cache || 'hit',
  };
  if (t.status !== 200) {
    res.writeHead(t.status, { ...headers, 'Content-Length': 0 }).end();
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Type': t.type, 'Content-Length': t.body.length });
  res.end(t.body);
}

async function serveCachedTile(req, res, url, { trusted = false } = {}) {
  if (!trusted && !fromOwnPage(req)) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
      .end('Tiles are served to this app\'s own page only');
    return;
  }
  const raw = url.searchParams.get('u') || '';
  if (!tileSourceFor(raw)) {
    res.writeHead(400, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
      .end('Not a tile source this server caches');
    return;
  }
  try {
    sendTile(res, await cachedTile(`tile:${raw}`, () => fetchTileUpstream(raw)));
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 502;
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end(err.message);
  }
}

/**
 * Delete expired tiles, and the oldest beyond the size cap.
 *
 * Runs at startup and every six hours. Without it a month-old tile would
 * only go when that exact tile was asked for again, and a place visited once
 * would sit on disk for good.
 */
async function pruneTileCache({ now = Date.now(), maxBytes = RETAIN['maps.tiles_max_size'] } = {}) {
  let shards;
  try { shards = await fsp.readdir(TILE_DIR); } catch { return { removed: 0, kept: 0, bytes: 0 }; }
  let removed = 0;
  const live = [];
  for (const shard of shards) {
    const dir = path.join(TILE_DIR, shard);
    let names;
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        if (!st.isFile()) continue;
        const age = now - st.mtimeMs;
        if (name.endsWith('.tmp')) {
          // A write that never got renamed; give a live one an hour.
          if (age > 60 * 60_000) { await fsp.unlink(file); removed++; }
          continue;
        }
        if (age > tileMaxAge()) { await fsp.unlink(file); removed++; continue; }
        live.push({ file, mtime: st.mtimeMs, size: st.size });
      } catch { /* already gone */ }
    }
    try { if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir); } catch { /* in use */ }
  }
  let bytes = live.reduce((a, t) => a + t.size, 0);
  let kept = live.length;
  if (bytes > maxBytes) {
    // Down to 90%, so the cap is not hit again by the next few tiles.
    live.sort((a, b) => a.mtime - b.mtime);
    for (const t of live) {
      if (bytes <= maxBytes * 0.9) break;
      try { await fsp.unlink(t.file); bytes -= t.size; kept--; removed++; } catch { /* gone */ }
    }
  }
  return { removed, kept, bytes };
}


// ---------------------------------------------------------------------------
// CARTO label tiles, proxied
//
// Since 25 Sep 2026 CARTO serves raster basemaps only with a key, and
// without one every tile comes back stamped "API KEY REQUIRED". The key goes
// on the upstream request here so it never reaches the browser, in keeping
// with every other credential in .env.
// ---------------------------------------------------------------------------

const CARTO_TILE_RE = /^\/tiles\/carto\/(dark_only_labels|light_only_labels)\/(\d{1,2})\/(\d{1,7})\/(\d{1,7})(@2x)?\.png$/;
const cartoCacheMax = () => RETAIN['memory.label_tiles'] ?? 3000;   // cache.conf
const cartoCache = new Map();   // path -> Buffer, insertion order = LRU

/**
 * Whether a request came from this app's own page, or from no page at all.
 *
 * The tile proxy spends the CARTO key, and an <img> on any other site can point
 * at it. An image request cannot carry the X-Panopticon header, so the check
 * that guards /api/* cannot guard tiles. Browsers label every request with
 * Sec-Fetch-Site instead: "same-origin" is this app, "none" is a URL typed into
 * the address bar, and a missing header is a client that is not a browser
 * (curl, the test suite), which no web page can make requests through.
 * "same-site" and "cross-site" mean another page asked.
 */
function fromOwnPage(req) {
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

async function serveCartoTile(req, res, m, { trusted = false } = {}) {
  if (!trusted && !fromOwnPage(req)) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
      .end('Tiles are served to this app\'s own page only');
    return;
  }
  if (!CFG.cartoKey) {
    res.writeHead(503, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
      .end('CARTO_API_KEY is not set — see .env.example');
    return;
  }
  const [, set, z, x, y, retina = ''] = m;
  const key = `${set}/${z}/${x}/${y}${retina}`;
  let buf = cartoCache.get(key);
  if (buf) {
    cartoCache.delete(key); cartoCache.set(key, buf);   // refresh LRU position
  } else {
    const sub = 'abcd'[(Number(x) + Number(y)) % 4];
    const upstream = `https://${sub}.basemaps.cartocdn.com/${key}.png`
      + `?key=${encodeURIComponent(CFG.cartoKey)}`;
    // A key with website restrictions checks Referer. Send this server's own
    // origin (the Host header has already been checked against ALLOWED_HOSTS)
    // so a key restricted to it still works, without forwarding the browser's
    // full page URL upstream.
    const headers = { Referer: `http://${req.headers.host}/` };
    // On disk for a month like every other tile, keyed without the API key.
    const t = await cachedTile(`carto:${key}`, async () => {
      const r = await fetchTileUpstream(upstream, headers);
      if (!r.ok && r.status !== 404 && r.status !== 204) {
        throw new UpstreamError(r.status, `CARTO returned HTTP ${r.status}`);
      }
      return r;
    });
    if (t.status !== 200) { sendTile(res, t); return; }
    buf = t.body;
    cartoCache.set(key, buf);
    while (cartoCache.size > cartoCacheMax() && cartoCache.size) cartoCache.delete(cartoCache.keys().next().value);
  }
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'image/png',
    'Content-Length': buf.length,
    'Cache-Control': `public, max-age=${Math.round(RETAIN['maps.browser'] / 1000)}`,
  });
  res.end(buf);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, SECURITY_HEADERS).end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(target);
    const ext = path.extname(target);
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      ...(ext === '.html' ? { 'Content-Security-Policy': cspFor(req.headers.host) } : {}),
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('404 Not Found');
  }
}

// Query parameters whose values the operator typed. The request log keeps
// their names and drops their values: stdout is often redirected to a file
// (chromebook.sh keeps one), and a file of typed searches is a search history.
const TYPED_PARAMS = new Set(['q']);

/** The request path and query as the log may show them. */
function loggable(url) {
  if (!url.search) return url.pathname;
  const pairs = url.search.slice(1).split('&').map((pair) => {
    const i = pair.indexOf('=');
    const raw = i < 0 ? pair : pair.slice(0, i);
    let name;
    try { name = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch { name = raw; }
    return TYPED_PARAMS.has(name) ? `${raw}=<redacted>` : pair;
  });
  return `${url.pathname}?${pairs.join('&')}`;
}

// ---------------------------------------------------------------------------
// Tile ports
// ---------------------------------------------------------------------------
//
// A browser opens at most six HTTP/1.1 connections to one host:port. With
// every map tile coming through the disk cache, tiles shared those six with
// the API — and an Overpass or OpenSky call can hold one for many seconds —
// where Bing alone had offered four hosts and twenty-four connections. So
// the tile routes are also served on TILE_PORTS extra ports (PORT+1 …), each
// a separate six as far as the browser is concerned. Only the tile routes
// answer there. A port that cannot be bound is skipped, and with none the
// page simply uses the main port. Loopback-bound servers only; see
// startTilePorts().

const TILE_PORT_COUNT = clamp(Number.parseInt(process.env.TILE_PORTS ?? '4', 10) || 0, 0, 8);
const tilePortsLive = [];      // the ones actually listening
const tileServers = [];

/** The main-port host a tile-port Host header stands for, or null. */
function mainHostFor(host) {
  const m = /^(.*):(\d+)$/.exec(String(host || '').toLowerCase());
  if (!m || !tilePortsLive.includes(Number(m[2]))) return null;
  return `${m[1]}:${CFG.port}`;
}

async function serveTilePort(req, res) {
  const main = mainHostFor(req.headers.host);
  if (!main || !ALLOWED_HOSTS.has(main)) {
    res.writeHead(421, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('Misdirected request');
    return;
  }
  // Same page only: the request must come from this app on its main port.
  // Image and fetch requests from it carry an Origin; plain <img>s a Referer.
  let from = req.headers.origin || null;
  if (!from && req.headers.referer) { try { from = new URL(req.headers.referer).origin; } catch { /* none */ } }
  const ok = from === `http://${main}` || from === `https://${main}`;
  if (!ok) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' })
      .end('Tiles are served to this app\'s own page only');
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', from);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (ACCESS_KEY) {
    const held = cookieValue(req, ACCESS_COOKIE);
    if (!held || !sameSecret(held, ACCESS_KEY)) {
      res.writeHead(401, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('Access key required');
      return;
    }
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/tiles/ping') { res.writeHead(204, SECURITY_HEADERS).end(); return; }
    if (url.pathname === '/tiles/cache') { await serveCachedTile(req, res, url, { trusted: true }); return; }
    const carto = CARTO_TILE_RE.exec(url.pathname);
    if (carto) { await serveCartoTile(req, res, carto, { trusted: true }); return; }
    res.writeHead(404, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' }).end('Tile routes only on this port');
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    if (!res.headersSent) res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
    res.end(err.message);
  }
}

/** Close the tile ports (shutdown, tests). */
function stopTilePorts() {
  return Promise.all(tileServers.splice(0).map((t) => new Promise((resolve) => {
    t.closeAllConnections?.();
    t.close(() => resolve());
  }))).then(() => { tilePortsLive.length = 0; });
}

/** Open the tile ports. Resolves once each has listened or failed. */
function startTilePorts() {
  // Loopback only. Beyond this machine every request needs the access
  // cookie, and Cesium sends cookies to other origins only for servers it is
  // told to trust ahead of time, which a tile URL it rewrites is not.
  if (ACCESS_KEY) return Promise.resolve();
  const ports = Array.from({ length: TILE_PORT_COUNT }, (_, i) => CFG.port + 1 + i);
  return Promise.all(ports.map((port) => new Promise((resolve) => {
    const srv = http.createServer((req, res) => { serveTilePort(req, res); });
    srv.keepAliveTimeout = 30_000;
    srv.once('error', (e) => {
      log('warn', `tile port ${port} unavailable (${e.code || e.message}); tiles use the main port`);
      resolve();
    });
    srv.listen(port, CFG.host, () => {
      tilePortsLive.push(port);
      tilePortsLive.sort((a, b) => a - b);
      tileServers.push(srv);
      resolve();
    });
  })));
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  if (!gate(req, res)) return;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  if (pathname.startsWith('/api/') && !apiAllowed(req, res, pathname, url.searchParams)) return;

  // Logged only on completion, a slow upstream would look identical to a
  // request that never arrived. So announce anything still running after
  // 5s, and say so when the browser gives up first.
  let settled = false;
  let slowTimer = null;
  // Aborted when the browser hangs up first, so queued upstream work that
  // has not started yet can be dropped instead of spending a rate limit.
  const gone = new AbortController();
  if (pathname.startsWith('/api/')) {
    slowTimer = setTimeout(() => {
      if (!settled) log('req', `${loggable(url)} still running after 5s…`);
    }, 5000);
    res.on('close', () => {
      if (settled) return;
      settled = true;
      gone.abort();
      clearTimeout(slowTimer);
      log('warn', `${pathname} — browser disconnected after `
        + `${Math.round((Date.now() - started) / 1000)}s; the work continues and its `
        + 'result is cached, so a retry should be quick');
    });
  }
  const done = () => { settled = true; clearTimeout(slowTimer); };

  try {
    if (pathname === '/tiles/cache') {
      await serveCachedTile(req, res, url);
      return;
    }
    const cartoTile = CARTO_TILE_RE.exec(pathname);
    if (cartoTile) {
      await serveCartoTile(req, res, cartoTile);
      return;
    }

    const handler = ROUTES[pathname];
    if (handler) {
      const fresh = url.searchParams.get('fresh') === '1';
      const payload = await reqCtx.run({ fresh, signal: gone.signal }, () => handler(url.searchParams));
      done();
      sendJson(res, 200, payload);
      log('req', `${loggable(url)} -> 200 (${Date.now() - started}ms)`);
      return;
    }

    if (pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: 'no such endpoint', path: pathname });
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (err) {
    const status = err instanceof UpstreamError ? err.status : 500;
    done();
    log('err', `${pathname} -> ${status}: ${err.message}`);
    sendJson(res, status, {
      error: err.message,
      detail: err.detail || null,
      // Lets the browser schedule its own retry instead of failing outright.
      retryAfter: err.retryAfter ?? null,
      source: pathname,
    });
  }
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

const C = { dim: '\x1b[2m', grn: '\x1b[32m', yel: '\x1b[33m', red: '\x1b[31m', cyn: '\x1b[36m', rst: '\x1b[0m' };

function log(kind, msg) {
  // The test suite sets this so request logs don't drown the test output.
  if (process.env.OPENPANOPTICON_QUIET === '1') return;
  const t = new Date().toISOString().slice(11, 19);
  const tag = kind === 'err' ? `${C.red}ERR${C.rst}`
    : kind === 'warn' ? `${C.yel}WRN${C.rst}`
    : kind === 'req' ? `${C.dim}···${C.rst}`
    : `${C.cyn}···${C.rst}`;
  console.log(`${C.dim}${t}${C.rst} ${tag} ${msg}`);
}

// Listening, the banner and the signal handlers only happen when this file is
// run directly. Required from the test suite it is a plain module: nothing
// binds a port, and the tests call server.listen() themselves.
function start() {
// Clear out what the disk tier can no longer serve, now and every six hours.
const prune = () => pruneDiskCache().then(({ removed, rewritten }) => {
  if (removed || rewritten) log('info', `disk cache: removed ${removed} expired, rewrote ${rewritten} old-format entries`);
}).catch(() => {});
prune();
setInterval(prune, 6 * 60 * 60_000).unref();
// Map tiles: a month on disk, then gone, on the same schedule.
const pruneTiles = () => pruneTileCache().then(({ removed, kept, bytes }) => {
  if (removed) log('info', `tile cache: removed ${removed}, kept ${kept} (${Math.round(bytes / 1048576)} MB)`);
}).catch(() => {});
pruneTiles();
setInterval(pruneTiles, 6 * 60 * 60_000).unref();
// The shortest TTL is minutes, so the memory tier is swept far more often.
setInterval(sweepCache, 10 * 60_000).unref();

// cache.conf: write it with the defaults if there is none, say what could not
// be used, and re-read it whenever it is saved.
if (!fs.existsSync(CACHE_CONF_FILE)) {
  try { fs.writeFileSync(CACHE_CONF_FILE, cacheConfText(), 'utf8'); log('info', `wrote ${path.basename(CACHE_CONF_FILE)} with the default cache retention`); }
  catch (e) { log('warn', `could not write ${CACHE_CONF_FILE}: ${e.message}`); }
}
for (const p of cacheConfProblems) log('warn', `cache.conf ${p} — using the default`);
fs.watchFile(CACHE_CONF_FILE, { interval: 2000 }, (cur, prev) => {
  if (cur.mtimeMs === prev.mtimeMs) return;
  const { problems } = loadCacheConf();
  log('info', `cache.conf reloaded${problems.length ? ` (${problems.length} problem${problems.length > 1 ? 's' : ''})` : ''}`);
  for (const p of problems) log('warn', `cache.conf ${p} — using the default`);
});

startTilePorts();
server.listen(CFG.port, CFG.host, () => {
  const ok = (b) => (b ? `${C.grn}ready${C.rst}` : `${C.yel}not configured${C.rst}`);
  console.log(`
${C.cyn}  ╔═╗╔═╗╔═╗╔╗╔╔═╗╔═╗╔╗╔╔═╗╔═╗╔╦╗╦╔═╗╔═╗╔╗╔${C.rst}
${C.cyn}  ║ ║╠═╝╠╣ ║║║╠═╝╠═╣║║║║ ║╠═╝ ║ ║║  ║ ║║║║${C.rst}
${C.cyn}  ╚═╝╩  ╚═╝╝╚╝╩  ╩ ╩╝╚╝╚═╝╩   ╩ ╩╚═╝╚═╝╝╚╝${C.rst}
${C.dim}  OSINT data fusion${C.rst}

  ${C.grn}▸${C.rst} ${ACCESS_KEY
    ? `http://${[...ALLOWED_HOSTS].find((h) => !h.startsWith('127.') && !h.startsWith('localhost') && !h.startsWith('[::1]')) || `127.0.0.1:${CFG.port}`}/?key=${ACCESS_KEY}`
    : `http://${CFG.host}:${CFG.port}`}
${ACCESS_KEY ? `  ${C.yel}!${C.rst} Listening on ${CFG.host}, beyond this machine. Requests need the access key above.\n` : ''}
  Shodan .............. ${ok(!!CFG.shodanKey)}
  OpenSky ............. ${CFG.openSkyId ? `${C.grn}authenticated${C.rst}` : `${C.yel}anonymous${C.rst} (400 credits/day)`}
  CelesTrak ........... ${C.grn}open${C.rst}
  Overpass / OSM ...... ${C.grn}open${C.rst}
  ALPR / Flock ........ ${C.grn}open${C.rst} (DeFlock data via OSM)
  Flight routes ....... ${C.grn}open${C.rst} (adsbdb)
  Weather radar ....... ${C.grn}open${C.rst} (RainViewer)
  GDACS ............... ${C.grn}open${C.rst}
  NASA EONET .......... ${C.grn}open${C.rst}
  USGS quakes ......... ${C.grn}open${C.rst}
  NWS alerts .......... ${C.grn}open${C.rst}
  NASA FIRMS .......... ${ok(!!CFG.firmsKey)}
  RSOE EDIS ........... ${CFG.edisUrl ? `${C.grn}licensed${C.rst}` : `${C.dim}enterprise feed, not licensed${C.rst}`}
  Windy webcams ....... ${ok(!!CFG.windyKey)}
  OpenWebcamDB ........ ${ok(!!CFG.owcdbKey)}
  ALERTCalifornia ..... ${C.grn}open${C.rst} (wildfire cams)
  Cesium Ion .......... ${CFG.cesiumIonToken ? `${C.grn}terrain + buildings${C.rst}` : `${C.yel}OSM basemap only${C.rst}`}
`);

  // START.bat sets this so the browser opens only once the server is
  // listening. start.sh polls /api/health itself and does not set it.
  if (process.env.OPENPANOPTICON_OPEN_BROWSER === '1') {
    const host = CFG.host === '0.0.0.0' || CFG.host === '::' ? '127.0.0.1' : CFG.host;
    const openUrl = `http://${host}:${CFG.port}/${ACCESS_KEY ? `?key=${ACCESS_KEY}` : ''}`;
    const { spawn } = require('node:child_process');
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', `start "" "${openUrl}"`]]
      : process.platform === 'darwin' ? ['open', [openUrl]] : ['xdg-open', [openUrl]];
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: true })
        .on('error', () => {}).unref();
    } catch { /* no browser to open */ }
  }
});

// Keep-alive sockets and the AIS websocket would otherwise hold server.close()
// open indefinitely, so close them and give up after a few seconds.
function shutdown(signal) {
  console.log(`\n  shutting down (${signal})`);
  try { ais.socket?.close(); } catch { /* already closed */ }
  for (const t of tileServers) { t.close(); t.closeAllConnections?.(); }
  server.close(() => process.exit(0));
  server.closeAllConnections?.();
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) start();

// For the test suite. Nothing in the app imports these.
module.exports = {
  server, start, CFG, TTL, ROUTES, PROVIDERS_DIR, DISK_CACHE_DIR, TLE_DIR,
  cache, inflight, cached, sweepCache, cachedPersistent, readDiskCache, writeDiskCache, clearDiskCache,
  pruneDiskCache, diskName, diskKeyHash,
  RETAIN, CACHE_SCHEMA, loadCacheConf, cacheConfText, parseDuration, parseSize, diskMaxAge,
  reqCtx, wantsFresh, isCached, peekCached, overpassCellsOf, overpassBackoffMs, overpassLimits, nearestFirst,
  parse511, loadDotEnv, clip, htmlText, refusalReason, UpstreamError, grab, USER_AGENT,
  parseBbox, clamp, bboxCenter, bboxRadiusKm, snapFixed, viewCell, VIEW_CELL_DEG, VIEW_MAX_DEG,
  boxContains, shodanIndex, findBoughtShodanBox, rememberShodanBox, serviceCategory, SHODAN_PRESETS, SHODAN_CELL_DEG,
  openSky, openSkyPollSec, openSkyRefillSec, noteOpenSkyHeaders, assertOpenSkyCredit, OPENSKY_FLOOR,
  SAT_GROUPS, fetchTle, readCachedTle, writeCachedTle, tleCachePath,
  overpassGate, overpassQuery, mirrorFailure, OVERPASS_PRESETS, OVERPASS_ENDPOINTS,
  parseOverpassStatus, overpassDense,
  ais, aisIngest, aisConnect, aisBoxesFor, boxMovedEnough, shipTypeName,
  parseDirections, vendorOf, ALPR_VENDORS, airQualityBand, parseCsv,
  feodoSet, greyNoiseLookup, enrich, normaliseOwcdb, cloudSource, gibsTemplate, gibsDefaultDate,
  GIBS_LAYERS, COUNTRY_CENTROIDS, FIVE_ELEVEN_HOSTS, basemapProviders, sentinelTileTemplate,
  safeUrl, sameSecret, cookieValue, gate, apiAllowed, ALLOWED_HOSTS, ACCESS_KEY, fromOwnPage, loggable,
  SECURITY_HEADERS, CSP, cspFor, MIME, cartoCache, log,
  tilePortsLive, startTilePorts, stopTilePorts, serveTilePort, mainHostFor,
  TILE_DIR, tileMaxAge, TILE_SOURCES, tileSourceFor, tileCacheHosts, tileFile, readTile, writeTile,
  cachedTile, pruneTileCache,
};

// Read at call time, so a cache.conf edit shows through to the tests too.
Object.defineProperties(module.exports, {
  DISK_MAX_AGE: { get: diskMaxAge, enumerable: true },
  TILE_MAX_AGE: { get: tileMaxAge, enumerable: true },
  CACHE_MAX_ENTRIES: { get: cacheMaxEntries, enumerable: true },
});

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * demo.js — stands in for server.js on a static host (GitHub Pages).
 *
 * Loaded before Cesium and the app. It answers every /api/* request from the
 * files demo/capture.mjs recorded, so the page runs unchanged with no server
 * behind it:
 *
 * - The clock is set to the moment of capture and runs on from there, so
 *   aircraft ages, satellite positions, "3 hours ago" and the HUD's UTC all
 *   agree with the data rather than with today.
 * - Answers covering the whole of New York are filtered down to the box the
 *   page asked for, with their counts recomputed, the way the server would.
 * - Anything that would change data or reach out live (FLUSH, SYNC, the home
 *   editor, other dates, other base maps) is switched off and says so.
 * - OpenStreetMap buildings, captured with the rest, stand in for Cesium Ion.
 *
 * window.OP_DEMO_MANIFEST is written by demo/build.mjs into manifest.js.
 */
(function () {
  'use strict';

  const M = window.OP_DEMO_MANIFEST;
  if (!M) { console.error('OpenPanopticon demo: manifest.js is missing'); return; }

  // Everything the snapshot holds sits next to index.html. Built by string
  // rather than new URL(): the tile templates' {z}/{x}/{y} must stay literal.
  const SITE = new URL('.', document.baseURI).href;
  const site = (rel) => (/^[a-z]+:/i.test(rel) ? rel : SITE + String(rel).replace(/^\.?\//, ''));

  const DISABLED_MSG = 'Not available in the demo: this is a static snapshot, nothing here is live.';

  /* ---------------------------------------------------------------- */
  /* Clock                                                             */
  /* ---------------------------------------------------------------- */

  const RealDate = Date;
  const offset = M.capturedAt - RealDate.now();
  class DemoDate extends RealDate {
    constructor(...a) {
      if (a.length) super(...a);
      else super(RealDate.now() + offset);
    }
    static now() { return RealDate.now() + offset; }
  }
  // Date() called without `new` returns the current time as a string.
  window.Date = new Proxy(DemoDate, { apply: () => new DemoDate().toString() });

  /* ---------------------------------------------------------------- */
  /* What the app reads at boot                                        */
  /* ---------------------------------------------------------------- */

  window.OP_DEMO = {
    capturedAt: M.capturedAt,
    region: M.region,
    baseLayer: {
      url: site('data/tiles/shortbread/{z}/{x}/{y}.pbf'),
      maxLevel: M.shortbread?.maxLevel ?? 14,
      credit: '© OpenStreetMap contributors · Shortbread schema via VersaTiles',
    },
    labelsMaxLevel: M.labels?.maxLevel ?? 14,
    // The street map, when its tiles were captured. OpenStreetMapImageryProvider
    // appends {z}/{x}/{y}.png to this.
    osmTiles: M.osm ? { url: site('data/tiles/osm/'), maxLevel: M.osm.maxLevel ?? 15 } : null,
    defaultLayers: {
      flights: true, events: true, shodan: true, alpr: true, webcams: true, overpass: true, netinfra: true,
    },
    overpassAllClasses: true,
    lockedLayers: { satellites: 'Not part of the demo.' },
  };

  /* ---------------------------------------------------------------- */
  /* Settings are not kept                                             */
  /* ---------------------------------------------------------------- */

  // Every visit starts from the demo's own defaults. Only the saved session
  // is withheld; small conveniences (panel width, inset style) still work.
  const SETTINGS_KEY = /^(openpanopticon|worldview)\.settings\./;
  try {
    const proto = Storage.prototype;
    const get = proto.getItem;
    const set = proto.setItem;
    proto.getItem = function (k) { return SETTINGS_KEY.test(k) ? null : get.call(this, k); };
    proto.setItem = function (k, v) { if (!SETTINGS_KEY.test(k)) set.call(this, k, v); };
  } catch { /* storage unavailable: nothing to withhold */ }

  /* ---------------------------------------------------------------- */
  /* Files                                                             */
  /* ---------------------------------------------------------------- */

  const realFetch = window.fetch.bind(window);
  const files = new Map();

  /** A snapshot file, parsed once. Resolves to null when it was not captured. */
  function load(rel) {
    if (!files.has(rel)) {
      files.set(rel, realFetch(site(`data/${rel}`))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null));
    }
    return files.get(rel);
  }

  const json = (status, body) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json' },
  });
  const notCaptured = (what) => json(404, { error: `${what} was not captured in this demo snapshot.`, retryAfter: null });

  /* ---------------------------------------------------------------- */
  /* Region answers, filtered to the view                              */
  /* ---------------------------------------------------------------- */

  const SEVERITY_RANK = { red: 3, orange: 2, green: 1, info: 0 };

  function parseBbox(s) {
    const p = String(s || '').split(',').map(Number);
    if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
    return { south: Math.min(p[0], p[2]), west: p[1], north: Math.max(p[0], p[2]), east: p[3] };
  }
  const bboxStr = (b) => [b.south, b.west, b.north, b.east].map((v) => +v.toFixed(4)).join(',');
  const inside = (it, b) => {
    const lat = Number(it?.lat);
    const lon = Number(it?.lon);
    return Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
  };
  const countBy = (items, f) => {
    const out = {};
    for (const it of items) { const k = f(it); if (k != null) out[k] = (out[k] || 0) + 1; }
    return out;
  };
  const list = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const absolutize = (items, key) => items.map((it) => (it[key] && !/^[a-z]+:/i.test(it[key])
    ? { ...it, [key]: site(it[key]) } : it));

  /**
   * Per endpoint: the region file, and how to turn the features inside the
   * requested box back into the answer the server would have given. Each
   * mirrors the summary fields the server computes for that route.
   */
  const REGIONS = {
    '/api/shodan': {
      file: 'shodan', key: 'matches',
      shape: (items, meta, q, b) => ({
        ...meta, queried: b, total: items.length, returned: items.length,
        byCategory: countBy(items, (m) => m.category),
        vulnerable: items.filter((m) => m.vulns?.length).length,
        matches: items,
      }),
    },
    '/api/flights': {
      file: 'flights', key: 'aircraft',
      // One answer, so no re-poll would bring anything new. Ask rarely.
      shape: (items, meta, q, b) => ({ ...meta, count: items.length, covered: bboxStr(b), pollSec: 3600, aircraft: items }),
    },
    '/api/overpass': {
      file: 'overpass', key: 'features',
      shape: (items, meta, q, b) => {
        const order = Object.keys(meta.labels || {});
        const want = list(q.get('presets') || q.get('preset'));
        const chosen = order.filter((k) => want.includes(k));
        const features = [];
        const byPreset = Object.fromEntries(chosen.map((k) => [k, 0]));
        for (const f of items) {
          const matched = chosen.filter((k) => (f.presets || [f.preset]).includes(k));
          if (!matched.length) continue;
          const primary = matched[0];
          byPreset[primary]++;
          features.push({
            ...f, preset: primary, presets: matched,
            presetLabel: meta.labels?.[primary] ?? f.presetLabel,
            color: meta.colors?.[primary] ?? f.color,
          });
        }
        const pick = (o) => Object.fromEntries(chosen.map((k) => [k, o?.[k]]));
        return {
          ...meta, presets: chosen, byPreset, colors: pick(meta.colors), labels: pick(meta.labels),
          count: features.length, truncated: false, covered: bboxStr(b), trimmed: false, features,
        };
      },
    },
    '/api/alpr': {
      file: 'alpr', key: 'cameras',
      shape: (all, meta, q, b) => {
        const v = q.get('vendor');
        const items = v && v !== 'all' ? all.filter((c) => c.vendor === v) : all;
        return {
          ...meta, count: items.length, total: items.length,
          byVendor: countBy(items, (c) => c.vendor), byOperator: countBy(items, (c) => c.operator || null),
          withDirection: items.filter((c) => c.directions?.length).length,
          covered: bboxStr(b), trimmed: false, cameras: items,
        };
      },
    },
    '/api/webcams': {
      file: 'webcams', key: 'webcams',
      shape: (items, meta) => ({
        ...meta, count: items.length, bySource: countBy(items, (c) => c.source), webcams: absolutize(items, 'image'),
      }),
    },
    '/api/events': {
      file: 'events', key: 'events',
      shape: (all, meta, q) => {
        const want = list(q.get('sources') || 'gdacs,eonet,usgs,nws');
        const floor = SEVERITY_RANK[q.get('minSeverity')] ?? 0;
        const items = all.filter((e) => want.includes(e.source) && (SEVERITY_RANK[e.severity] ?? 0) >= floor)
          .sort((x, y) => (SEVERITY_RANK[y.severity] ?? 0) - (SEVERITY_RANK[x.severity] ?? 0)
            || String(y.time || '').localeCompare(String(x.time || '')));
        const bySource = Object.fromEntries(want.map((s) => [s, 0]));
        for (const e of items) bySource[e.source]++;
        return { ...meta, count: items.length, bySource, events: items };
      },
    },
    '/api/netinfra': {
      file: 'netinfra', key: 'nodes',
      shape: (all, meta, q) => {
        const want = list(q.get('sources'));
        const items = want.length ? all.filter((n) => want.includes(n.source)) : all;
        const sources = want.length && meta.sources
          ? Object.fromEntries(Object.entries(meta.sources).filter(([k]) => want.includes(k))) : meta.sources;
        return { ...meta, sources, count: items.length, bySource: countBy(items, (n) => n.source), nodes: items };
      },
    },
    '/api/iot': {
      file: 'iot', key: 'sensors',
      shape: (all, meta, q) => {
        const items = q.get('indoor') === '1' ? all : all.filter((s) => !s.indoor);
        return {
          ...meta, count: items.length, byModel: countBy(items, (s) => s.model),
          withAir: items.filter((s) => s.air).length, withNoise: items.filter((s) => s.noise).length,
          sensors: items,
        };
      },
    },
    '/api/traffic': {
      file: 'traffic', key: 'features',
      shape: (items, meta) => {
        const byState = {};
        for (const f of items) {
          const st = String(f.source || '').replace(/^511-/, '') || '?';
          const s = (byState[st] ||= { cameras: 0, incidents: 0 });
          if (f.kind === 'camera') s.cameras++; else s.incidents++;
        }
        return {
          ...meta, count: items.length, byState,
          cameras: items.filter((f) => f.kind === 'camera').length,
          incidents: items.filter((f) => f.kind !== 'camera').length,
          features: absolutize(items, 'image'),
        };
      },
    },
    '/api/vessels': {
      file: 'vessels', key: 'vessels',
      shape: (items, meta) => ({
        ...meta, count: items.length, byType: countBy(items, (v) => v.shipTypeName || 'Unidentified'), vessels: items,
      }),
    },
  };

  async function regionAnswer(route, q) {
    const spec = REGIONS[route];
    const data = await load(`api/region/${spec.file}.json`);
    if (!data) return notCaptured('This layer');
    const b = parseBbox(q.get('bbox'));
    if (!b) return json(400, { error: 'bbox required as south,west,north,east' });
    const items = (data.items || []).filter((it) => inside(it, b));
    return json(200, spec.shape(items, data.meta || {}, q, b));
  }

  /* ---------------------------------------------------------------- */
  /* Place search, from captured OpenStreetMap names                   */
  /* ---------------------------------------------------------------- */

  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const TYPE_LABEL = {
    city: 'City', borough: 'Borough', suburb: 'Neighbourhood', neighbourhood: 'Neighbourhood',
    quarter: 'Neighbourhood', island: 'Island', attraction: 'Attraction', museum: 'Museum',
    viewpoint: 'Viewpoint', zoo: 'Zoo', aerodrome: 'Airport', park: 'Park', building: 'Building',
  };
  const TYPE_RANK = { city: 6, borough: 5, aerodrome: 4, suburb: 3, neighbourhood: 3, island: 3, park: 2, attraction: 2, museum: 2 };

  async function geocode(q) {
    const places = (await load('api/gazetteer.json')) || [];
    const needle = fold(q);
    if (needle.length < 2) return json(200, { results: [] });
    const scored = [];
    for (const p of places) {
      const name = fold(p.name);
      let s = 0;
      if (name === needle) s = 100;
      else if (name.startsWith(needle)) s = 80;
      else if (name.split(/[\s\-/]+/).some((w) => w.startsWith(needle))) s = 60;
      else if (name.includes(needle)) s = 40;
      if (s) scored.push([s + (TYPE_RANK[p.type] || 0), p]);
    }
    scored.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
    return json(200, {
      results: scored.slice(0, 8).map(([, p]) => ({
        name: `${p.name}, ${TYPE_LABEL[p.type] || 'Place'}, New York`,
        short: p.name, lat: p.lat, lon: p.lon, type: p.type, category: 'place',
      })),
    });
  }

  /* ---------------------------------------------------------------- */
  /* The API                                                           */
  /* ---------------------------------------------------------------- */

  const LIVE_ONLY = new Set(['/api/flush']);
  const CLOUDLESS_NOTE = 'A cloud-free mosaic of a year of Sentinel-2 passes, by EOX, captured with the snapshot. '
    + 'About 10 m per pixel, so it blurs below street level.';

  async function api(u, init) {
    const route = u.pathname.replace(/\/+$/, '');
    const q = u.searchParams;
    const method = String(init?.method || 'GET').toUpperCase();
    if (LIVE_ONLY.has(route) || method !== 'GET') return json(403, { error: DISABLED_MSG, retryAfter: null });
    if (REGIONS[route]) return regionAnswer(route, q);

    switch (route) {
      case '/api/health': {
        const h = await load('api/health.json');
        if (!h) return json(503, { error: 'The demo snapshot is missing (data/api/health.json).' });
        const captured = {
          shortbread: 'OpenStreetMap vector tiles, captured with the snapshot.',
          osm: M.osm && 'The standard OpenStreetMap street map, captured with the snapshot (detail to street level over Manhattan).',
        };
        const basemaps = (h.presets?.basemaps || []).map((b) => (captured[b.key]
          ? { ...b, available: true, note: captured[b.key] }
          : { ...b, available: false, note: 'Not part of the demo snapshot.' }));
        if (M.cloudless) {
          basemaps.push({
            key: 's2cloudless', label: `Satellite (Sentinel-2 cloudless ${M.cloudless.year})`, kind: 'static',
            available: true, note: CLOUDLESS_NOTE,
          });
        }
        return json(200, { ...h, demo: true, presets: { ...h.presets, basemaps } });
      }
      case '/api/config':
        return json(200, { cesiumIonToken: null, cartoLabels: !!M.labels });
      case '/api/geoip':
        return json(200, { ...M.home });
      case '/api/shodan/credits': {
        const c = await load('api/shodan-credits.json');
        return c ? json(200, c) : notCaptured('The Shodan credit count');
      }
      case '/api/signals': {
        const s = await load('api/signals.json');
        return s ? json(200, s) : notCaptured('The signals panel');
      }
      case '/api/satellites': {
        const g = q.get('group') || 'stations';
        const d = await load(`api/satellites/${encodeURIComponent(g)}.json`);
        if (!d) return notCaptured(`The "${g}" satellite group`);
        const cap = Math.max(1, Math.min(2000, parseInt(q.get('limit') || '300', 10) || 300));
        const satellites = (d.satellites || []).slice(0, cap);
        return json(200, { ...d, returned: satellites.length, satellites });
      }
      case '/api/weather': {
        const w = await load('api/weather.json');
        if (!w) return notCaptured('Weather radar');
        const fix = (f) => ({ ...f, url: site(f.url) });
        return json(200, {
          ...w,
          radar: w.radar && { ...w.radar, frames: (w.radar.frames || []).map(fix) },
          satellite: w.satellite && { ...w.satellite, frames: (w.satellite.frames || []).map(fix) },
          clouds: w.clouds && (w.clouds.url ? { ...w.clouds, url: site(w.clouds.url) } : w.clouds),
        });
      }
      case '/api/imagery': {
        const h = await load('api/health.json');
        const keys = (h?.presets?.imagery || []).map((l) => l.key);
        const layer = keys.includes(q.get('layer')) ? q.get('layer') : keys[0];
        const d = layer && await load(`api/imagery/${encodeURIComponent(layer)}.json`);
        if (!d) return notCaptured('This imagery layer');
        return json(200, { ...d, selected: { ...d.selected, url: site(d.selected.url) } });
      }
      case '/api/basemap': {
        if (q.get('provider') === 's2cloudless' && M.cloudless) {
          return json(200, {
            provider: 's2cloudless', label: `Satellite (Sentinel-2 cloudless ${M.cloudless.year})`,
            attribution: M.cloudless.attribution, note: CLOUDLESS_NOTE,
            url: site('data/tiles/s2cloudless/{z}/{x}/{y}.jpg'), maxLevel: M.cloudless.maxLevel ?? 14,
            tiles: true, scenes: [],
          });
        }
        if ((q.get('provider') || '') !== 'shortbread') return json(404, { error: 'Not part of the demo snapshot.' });
        const b = await load('api/basemap-shortbread.json');
        return b ? json(200, { ...b, url: site(b.url) }) : notCaptured('The vector basemap');
      }
      case '/api/geocode':
        return geocode(q.get('q'));
      case '/api/route':
      case '/api/aircraft':
      case '/api/enrich': {
        const L = (await load('api/lookups.json')) || {};
        const bucket = route.slice(5);
        const key = bucket === 'route' ? String(q.get('callsign') || '').trim()
          : bucket === 'aircraft' ? q.get('icao24') : q.get('ip');
        const hit = L[bucket]?.[key];
        if (hit && !hit.error) return json(200, hit);
        if (bucket === 'route') return json(200, { callsign: key, known: false });
        if (bucket === 'aircraft') return json(200, { icao24: key, known: false });
        return notCaptured('A reputation lookup for this address');
      }
      default:
        return json(404, { error: DISABLED_MSG, retryAfter: null });
    }
  }

  /** Vector tiles are stored gzipped; a static host serves them as-is. */
  async function vectorTile(u) {
    const r = await realFetch(`${u.href}.gz`);
    if (!r.ok) return new Response(null, { status: 404 });
    let buf = new Uint8Array(await r.arrayBuffer());
    // A host may already have undone the gzip (Content-Encoding); check the magic.
    if (buf[0] === 0x1f && buf[1] === 0x8b && typeof DecompressionStream === 'function') {
      const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      buf = new Uint8Array(await new Response(s).arrayBuffer());
    }
    return new Response(buf, { status: 200, headers: { 'Content-Type': 'application/x-protobuf' } });
  }

  window.fetch = function (input, init) {
    let u;
    try {
      u = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
    } catch { return realFetch(input, init); }
    if (u.origin === location.origin) {
      if (u.pathname.startsWith('/api/')) {
        return api(u, init).catch((e) => json(500, { error: `demo: ${e.message}` }));
      }
      if (/\/data\/tiles\/shortbread\/\d+\/\d+\/\d+\.pbf$/.test(u.pathname)) return vectorTile(u);
    }
    return realFetch(input, init);
  };

  /* ---------------------------------------------------------------- */
  /* Controls that do not apply                                        */
  /* ---------------------------------------------------------------- */

  const OFF = [
    '#flush-cache', '#refresh-now', '#reset-settings',
    '#he-geolocate', '#he-here', '#he-save', '#he-clear',
    '#im-prev', '#im-next', '#im-date', '#bm-from', '#bm-to', '#bm-cloud', '#bm-clearest',
  ].join(',');

  function tell() {
    try { window.WV?.toast?.(DISABLED_MSG); } catch { /* app not up yet */ }
  }
  for (const type of ['click', 'change', 'input', 'keydown']) {
    document.addEventListener(type, (e) => {
      const t = e.target instanceof Element ? e.target.closest(OFF) : null;
      if (!t) return;
      // Typing into a switched-off field is blocked; tabbing past it, and
      // the app's own shortcuts while a button has focus, are not.
      if (type === 'keydown' && (t.tagName !== 'INPUT' || e.key === 'Tab' || e.key === 'Escape')) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (type === 'click') tell();
    }, true);
  }

  function markOff() {
    for (const n of document.querySelectorAll(OFF)) {
      n.classList.add('demo-off');
      n.setAttribute('aria-disabled', 'true');
      n.title = DISABLED_MSG;
      if ('readOnly' in n && n.tagName === 'INPUT') n.readOnly = true;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Banner                                                            */
  /* ---------------------------------------------------------------- */

  function when() {
    const d = new RealDate(M.capturedAt);
    try {
      // dateStyle cannot be combined with timeZoneName, so the fields are spelled out.
      return d.toLocaleString('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
      });
    } catch { return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
  }

  function banner() {
    const b = document.createElement('div');
    b.id = 'demo-banner';
    b.setAttribute('role', 'note');
    const strong = document.createElement('strong');
    strong.textContent = 'DEMO';
    const text = document.createElement('span');
    text.textContent = `Static snapshot of New York City, captured ${when()}. Nothing here is live.`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'demo-x';
    x.setAttribute('aria-label', 'hide');
    x.textContent = '×';
    x.onclick = () => b.classList.add('hidden');
    b.append(strong, text, x);
    document.body.append(b);

    const sub = document.querySelector('#boot .boot-sub');
    if (sub) sub.textContent = 'OSINT Data Fusion · static demo';
  }

  /* ---------------------------------------------------------------- */
  /* OpenStreetMap buildings                                           */
  /* ---------------------------------------------------------------- */

  const BUILDINGS_MAX_HEIGHT_M = 9000;   // camera height above which they are hidden
  const BUILDINGS_BATCH = 250;           // footprints per Primitive

  function ringArea(r) {
    let a = 0;
    for (let i = 0, n = r.length; i < n; i += 2) {
      const j = (i + 2) % n;
      a += r[i] * r[j + 1] - r[j] * r[i + 1];
    }
    return Math.abs(a / 2);
  }

  function startBuildings(viewer) {
    const B = M.buildings;
    if (!B?.tiles?.some((t) => t.n)) return;
    const C = window.Cesium;
    const low = C.Color.fromCssColorString('#2b3843');
    const high = C.Color.fromCssColorString('#8aa3b3');
    const state = new Map();       // tile index -> 'loading' | 'ready' | 'failed'
    const prims = [];

    async function loadTile(t) {
      state.set(t.i, 'loading');
      try {
        const d = await (await realFetch(site(`data/buildings/${t.i}.json`))).json();
        const instances = [];
        for (const [h, minH, ring] of d.b || []) {
          // Unclosed or degenerate outlines are what make a batch fail to
          // build, so they are dropped here rather than sent to the worker.
          if (!Array.isArray(ring) || ring.length < 8 || ringArea(ring) < 1e-10) continue;
          const shade = C.Color.lerp(low, high, Math.min(1, h / 250), new C.Color());
          instances.push(new C.GeometryInstance({
            geometry: new C.PolygonGeometry({
              polygonHierarchy: new C.PolygonHierarchy(C.Cartesian3.fromDegreesArray(ring)),
              height: minH, extrudedHeight: h,
              vertexFormat: C.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(shade) },
          }));
        }
        if (!instances.length) { state.set(t.i, 'failed'); return; }
        // Built on the main thread, a few hundred at a time with a pause
        // between, rather than in Cesium's workers: worker-built geometry
        // depends on the CDN's module workers loading, and when they do not
        // the buildings silently never appear. Small batches keep each
        // frame's share of the work short.
        state.set(t.i, 'ready');
        for (let k = 0; k < instances.length; k += BUILDINGS_BATCH) {
          const p = new C.Primitive({
            geometryInstances: instances.slice(k, k + BUILDINGS_BATCH),
            appearance: new C.PerInstanceColorAppearance({ translucent: false, closed: true }),
            asynchronous: false,
            releaseGeometryInstances: true,
            allowPicking: false,
          });
          p.show = viewer.camera.positionCartographic.height < BUILDINGS_MAX_HEIGHT_M;
          viewer.scene.primitives.add(p);
          prims.push(p);
          await new Promise((r) => setTimeout(r, 60));
        }
      } catch (e) {
        console.warn('demo buildings: tile', t.i, e.message);
        state.set(t.i, 'failed');
      }
    }

    function update() {
      const h = viewer.camera.positionCartographic.height;
      const show = h < BUILDINGS_MAX_HEIGHT_M;
      for (const p of prims) p.show = show;
      if (!show) return;
      const r = viewer.camera.computeViewRectangle();
      if (!r) return;
      const deg = C.Math.toDegrees;
      const v = { south: deg(r.south), west: deg(r.west), north: deg(r.north), east: deg(r.east) };
      for (const t of B.tiles) {
        if (!t.n || state.has(t.i)) continue;
        if (t.north < v.south || t.south > v.north || t.east < v.west || t.west > v.east) continue;
        loadTile(t);
      }
    }

    viewer.camera.percentageChanged = 0.1;
    viewer.camera.changed.addEventListener(update);
    viewer.camera.moveEnd.addEventListener(update);
    update();
  }

  /* ---------------------------------------------------------------- */

  function whenAppReady(fn, tries = 240) {
    const v = window.WV?.viewer;
    if (v && window.WV.layers) fn(v);
    else if (tries > 0) setTimeout(() => whenAppReady(fn, tries - 1), 250);
  }

  /** Sections of the left panel that have no use in the demo. */
  function hideSections() {
    document.querySelector('#targets')?.closest('section')?.classList.add('demo-hidden');
    document.querySelector('#reset-settings')?.closest('.panel-actions')?.classList.add('demo-hidden');
  }

  function onReady() {
    banner();
    hideSections();
    markOff();
    whenAppReady((viewer) => {
      markOff();
      try { startBuildings(viewer); } catch (e) { console.warn('demo buildings unavailable', e); }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady);
  else onReady();

  // For the test suite.
  window.OP_DEMO_INTERNALS = { REGIONS, parseBbox, geocode, api };
}());

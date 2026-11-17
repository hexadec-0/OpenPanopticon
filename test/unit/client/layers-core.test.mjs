// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * The browser side of every layer: the api() dispatch queue, and the Layer
 * base class's caching, coverage, de-duplication and retry backoff.
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installCesium, makeViewer } from '../../helpers/cesium-stub.mjs';
import { installDom } from '../../helpers/dom-stub.mjs';
import { api, apiQueueDepth, OverpassLayer, ShodanLayer, AlprLayer, DEPTH_FREE_M } from '../../../public/js/layers.js';

/** A fetch whose requests stay open until the test releases them. */
function controlledFetch() {
  const pending = [];
  const fn = mock.fn((url, init) => new Promise((resolve, reject) => {
    const p = { url: String(url), init, resolve, reject, path: new URL(String(url)).pathname };
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    pending.push(p);
  }));
  fn.pending = pending;
  fn.respond = (p, body = {}, status = 200) => p.resolve(new Response(JSON.stringify(body), { status }));
  fn.releaseAll = () => { while (pending.length) fn.respond(pending.shift()); };
  return fn;
}

const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => { installCesium(); installDom(); });

describe('api()', () => {
  test('sends the X-Panopticon header and drops empty parameters', async () => {
    const f = controlledFetch();
    globalThis.fetch = f;
    const p = api('/api/geocode', { q: 'x y', empty: '', nil: null, undef: undefined, zero: 0 });
    await tick();
    const [req] = f.pending;
    assert.equal(req.init.headers['X-Panopticon'], '1');
    const u = new URL(req.url);
    assert.equal(u.origin, 'http://127.0.0.1:8420');
    assert.deepEqual([...u.searchParams.keys()].sort(), ['q', 'zero']);
    f.respond(req, { results: [] });
    assert.deepEqual(await p, { results: [] });
  });

  test('can POST', async () => {
    const f = controlledFetch();
    globalThis.fetch = f;
    const p = api('/api/flush', null, { method: 'POST' });
    await tick();
    assert.equal(f.pending[0].init.method, 'POST');
    f.releaseAll();
    await p;
  });

  test('an error response becomes an Error with the status, message and retryAfter', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'slow down', retryAfter: 42 }), { status: 429 });
    await assert.rejects(api('/api/flights'), (e) => e.message === 'slow down' && e.status === 429 && e.retryAfter === 42);
  });

  test('a non-JSON error body still yields a useful message', async () => {
    globalThis.fetch = async () => new Response('<html>bad gateway</html>', { status: 502 });
    await assert.rejects(api('/api/flights'), (e) => e.message === 'HTTP 502' && e.status === 502);
  });

  test('times out with a clear message, and frees its slot', async () => {
    globalThis.fetch = controlledFetch();
    await assert.rejects(api('/api/geocode', { q: 'x' }, { timeoutMs: 30 }), (e) => e.timeout === true && /no response after 0s/.test(e.message));
    assert.equal(apiQueueDepth().inflight, 0);
  });

  test('a network failure is passed on and frees its slot', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(api('/api/geocode', { q: 'x' }), /Failed to fetch/);
    assert.deepEqual(apiQueueDepth(), { inflight: 0, bulkInflight: 0, waiting: 0 });
  });

  test('holds bulk refreshes to three lanes, keeping one free for clicks', async () => {
    const f = controlledFetch();
    globalThis.fetch = f;
    const bulk = Array.from({ length: 5 }, (_, i) => api('/api/overpass', { i }));
    await tick();
    assert.deepEqual(apiQueueDepth(), { inflight: 3, bulkInflight: 3, waiting: 2 });
    assert.equal(f.pending.length, 3, 'queued requests never reach the browser');

    const click = api('/api/route', { callsign: 'X' });
    await tick();
    assert.equal(apiQueueDepth().inflight, 4, 'an interactive lookup takes the reserved lane');
    assert.equal(f.pending.at(-1).path, '/api/route');

    // A live poll queued behind bulk work starts first when a lane frees.
    const live = api('/api/flights', { bbox: '1,2,3,4' });
    await tick();
    assert.equal(apiQueueDepth().waiting, 3);
    f.respond(f.pending.find((p) => p.path === '/api/route'));
    await click;
    await tick();
    assert.equal(f.pending.at(-1).path, '/api/flights', 'the live poll jumped the bulk queue');

    // Drain everything.
    while (f.pending.length || apiQueueDepth().waiting) { f.releaseAll(); await tick(); }
    await Promise.all([...bulk, live]);
    assert.deepEqual(apiQueueDepth(), { inflight: 0, bulkInflight: 0, waiting: 0 });
  });
});

/** A layer whose load() is fully under the test's control. */
class TestLayer extends OverpassLayer {
  constructor(viewer) {
    super(viewer);
    this.loads = 0;
    this.nextLoad = null;
  }

  async load(ctx) {
    this.loads++;
    if (this.nextLoad) return this.nextLoad(ctx);
    this.remember([{ id: `r${this.loads}`, lat: 1, lon: 1, preset: 'surveillance' }]);
    this.redraw();
  }
}

describe('markers on real terrain', () => {
  const cam = (id, lat, lon) => ({ id, lat, lon, directions: [90], vendor: 'flock' });

  test('are placed at the sampled ground height, not left to Cesium\'s clamp', async () => {
    const viewer = makeViewer();
    viewer.scene.terrainProvider = { availability: {} };
    viewer.scene.requestRender = () => {};
    const asked = [];
    Cesium.sampleTerrainMostDetailed = async (tp, cs) => {
      asked.push(cs.length);
      return cs.map((c) => ({ ...c, height: 64.8 }));
    };
    const l = new AlprLayer(viewer);
    l.accumulate = true;
    l.remember([cam('a', 35.7701, -78.6401), cam('b', 35.7702, -78.6402)]);
    l.redraw();
    await tick(); await tick();
    const pins = l.source.entities.values.filter((e) => e.billboard);
    assert.equal(pins.length, 2);
    for (const p of pins) {
      assert.equal(p.billboard.heightReference, Cesium.HeightReference.NONE);
      const h = (p.position.getValue?.() ?? p.position).h;
      assert.ok(Math.abs(h - 65.3) < 0.01, `placed at ${h}`);
    }
    // A redraw reuses the heights already known.
    l.redraw();
    await tick();
    assert.deepEqual(asked, [2]);
  });

  test('are left clamped on the plain ellipsoid, where clamping is exact', () => {
    const viewer = makeViewer();
    let called = false;
    Cesium.sampleTerrainMostDetailed = async () => { called = true; return []; };
    const l = new AlprLayer(viewer);
    l.accumulate = true;
    l.remember([cam('a', 35.7703, -78.6403)]);
    l.redraw();
    const pin = l.source.entities.values.find((e) => e.billboard);
    assert.equal(pin.billboard.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
    assert.equal(called, false);
  });
});

describe('altitude hold while a request is running', () => {
  test('a request already in flight keeps the layer "loading", and rejoining it never says "held"', async () => {
    const l = new OverpassLayer(makeViewer());
    l.setEnabled(true);
    let release;
    l._inFlight = new Promise((r) => { release = r; });
    l.status = 'loading';
    await l.holdForAltitude();
    assert.equal(l.status, 'loading', 'the hold leaves a running request alone');
    l.status = 'held';   // e.g. held before this request started
    const joined = l.refresh({ bbox: '35,-79,35.1,-78.9' });
    assert.equal(l.status, 'loading', 'coming back down shows it loading');
    release();
    await joined;
  });
});

describe('a view change while a request is running', () => {
  function slowLayer() {
    const l = new OverpassLayer(makeViewer());
    l.setEnabled(true);
    const calls = [];
    l.load = (ctx) => new Promise((resolve) => {
      calls.push({ bbox: ctx.bbox, resolve });
      l.coveredBbox = ctx.bbox;
    });
    return { l, calls };
  }
  const RALEIGH = '35.7,-78.7,35.8,-78.6';
  const GREENSBORO = '36.0,-79.9,36.1,-79.8';

  test('back over ground already fetched: drawn at once, not left "loading" behind the other query', async () => {
    const { l, calls } = slowLayer();
    l.markCovered(RALEIGH);
    const away = l.refresh({ bbox: GREENSBORO });
    assert.equal(l.status, 'loading');
    await l.refresh({ bbox: RALEIGH });
    assert.equal(l.status, 'ok', 'served from what is held');
    assert.equal(calls.length, 1, 'no request for Raleigh');
    calls[0].resolve();
    await away;
    assert.equal(calls.length, 1, 'and none queued after');
  });

  test('the other place failing does not mark the view you came back to as failed', async () => {
    const { l, calls } = slowLayer();
    l.markCovered(RALEIGH);
    const away = l.refresh({ bbox: GREENSBORO });
    await l.refresh({ bbox: RALEIGH });
    calls[0].resolve(Promise.reject(Object.assign(new Error('Overpass busy'), { status: 502 })));
    await away;
    assert.equal(l.status, 'ok');
    assert.equal(l.error, null);
    assert.equal(l.retryAt, null, 'no retry booked for Greensboro');
  });

  test('somewhere new is asked for once the running query finishes, latest view only', async () => {
    const { l, calls } = slowLayer();
    const first = l.refresh({ bbox: GREENSBORO });
    l.refresh({ bbox: '30,-80,30.1,-79.9' });   // panned through
    l.refresh({ bbox: RALEIGH });               // where the camera stopped
    calls[0].resolve();
    await first;
    await tick();
    assert.equal(calls.length, 2);
    assert.equal(calls[1].bbox, RALEIGH);
    calls[1].resolve();
  });
});

describe('markers and the far side of the planet', () => {
  test('skip the depth test only near the camera, so the globe can hide them', () => {
    assert.ok(Number.isFinite(DEPTH_FREE_M) && DEPTH_FREE_M <= 100_000);
    const l = new AlprLayer(makeViewer());
    l.accumulate = true;
    l.remember([{ id: 'a', lat: 35.77, lon: -78.64, directions: [], vendor: 'flock' }]);
    l.redraw();
    const pin = l.source.entities.values.find((e) => e.billboard);
    assert.equal(pin.billboard.disableDepthTestDistance, DEPTH_FREE_M);
  });
});

describe('retry timing', () => {
  test('a 429 that says when to come back is believed, and never climbs to the hour step', () => {
    const l = new OverpassLayer(makeViewer());
    l.setEnabled(true);
    for (let i = 0; i < 8; i++) l.scheduleRetry(Object.assign(new Error('busy'), { status: 429, retryAfter: 40 }), {});
    assert.ok(l.retryInSec >= 40 && l.retryInSec < 45, `waits ${l.retryInSec}s`);
    clearTimeout(l._retryTimer);
  });

  test('other failures still back off up the ladder', () => {
    const l = new OverpassLayer(makeViewer());
    l.setEnabled(true);
    for (let i = 0; i < 8; i++) l.scheduleRetry(new Error('down'), {});
    assert.equal(l.retryInSec, 3600);
    clearTimeout(l._retryTimer);
  });

  test('a partial OSM answer is drawn, claims no coverage, and books the rest', async () => {
    const l = new OverpassLayer(makeViewer());
    l.setEnabled(true);
    l.fetch = async () => ({ features: [{ id: 'n/1', lat: 35, lon: -79, preset: 'surveillance', tags: {} }],
      partial: true, cells: 16, missing: 12, retryAfter: 25, covered: null });
    await l.refresh({ bbox: '35,-79,35.1,-78.9' });
    assert.equal(l.store.size, 1, 'what came back is kept');
    assert.equal(l.covered.length, 0);
    assert.equal(l.status, 'error');
    assert.match(l.error, /Partly loaded: 4 of 16/);
    assert.ok(l.retryInSec >= 25 && l.retryInSec < 30);
    clearTimeout(l._retryTimer);
  });
});

describe('altitude hold during a backoff', () => {
  test('coming back down says it is waiting on the backoff, and books the retry again', async () => {
    const l = new OverpassLayer(makeViewer());
    l.setEnabled(true);
    l.error = 'Overpass is rate-limiting every mirror';
    l.status = 'error';
    l.retryAt = Date.now() + 60_000;
    await l.holdForAltitude();
    assert.equal(l.status, 'held');
    assert.equal(l._retryTimer, null, 'the hold cancels the timer');
    await l.refresh({ bbox: '35,-79,35.1,-78.9' });
    assert.equal(l.status, 'error', 'no longer claims to be held');
    assert.match(l.error, /rate-limiting/);
    assert.ok(l._retryTimer, 'a retry is booked again');
    clearTimeout(l._retryTimer);
  });
});

describe('Layer base class', () => {
  let layer;
  beforeEach(() => {
    layer = new TestLayer(makeViewer());
    layer.setEnabled(true);
  });
  afterEach(() => { clearTimeout(layer._retryTimer); });

  test('registers its own data source, hidden until enabled', () => {
    const l = new TestLayer(makeViewer());
    assert.equal(l.source.show, false);
    l.setEnabled(true);
    assert.equal(l.source.show, true);
    l.setEnabled(false);
    assert.equal(l.status, 'idle');
  });

  test('padBbox widens the view by the pad factor, within the world', () => {
    assert.equal(layer.padBbox('10,20,11,22', 0.5), '9.5000,19.0000,11.5000,23.0000');
    assert.equal(layer.padBbox('84,179,85,180', 1), '83.0000,178.0000,85.0000,180.0000');
    assert.equal(layer.padBbox('junk'), 'junk');
  });

  test('coverage: a view inside a fetched region is covered until it expires', () => {
    layer.markCovered('0,0,10,10');
    assert.equal(layer.isCovered('1,1,2,2'), true);
    assert.equal(layer.isCovered('9,9,11,11'), false);
    assert.equal(layer.isCovered('nope'), false);
    layer.covered[0].at = Date.now() - layer.coverageTtlMs - 1;
    assert.equal(layer.isCovered('1,1,2,2'), false);
  });

  test('coverage keeps at most 40 regions', () => {
    layer.coverMax = undefined;   // the base default; the OSM layer keeps more
    for (let i = 0; i < 45; i++) layer.markCovered(`${i},0,${i + 1},1`);
    assert.equal(layer.covered.length, 40);
    assert.equal(layer.covered[0].south, 5);
  });

  test('accumulates records by id, newest copy wins', () => {
    layer.remember([{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { v: 'no id' }]);
    layer.remember([{ id: 'a', v: 2 }]);
    const recs = layer.records();
    assert.equal(recs.length, 2);
    assert.equal(recs.find((r) => r.id === 'a').v, 2);
  });

  test('evicts least-recently-seen records past the cap', () => {
    layer.cacheCap = 3;
    layer.remember([{ id: 1 }, { id: 2 }]);
    for (const v of layer.store.values()) v.seen -= 1000;
    layer.remember([{ id: 3 }, { id: 4 }]);
    assert.deepEqual(layer.records().map((r) => r.id).sort(), [2, 3, 4]);
  });

  test('never drops records from an area it still claims to cover', () => {
    layer.cacheTtlMs = 1000;
    layer.coverageTtlMs = 60_000;
    layer.remember([{ id: 'old' }]);
    layer.store.get('old').seen = Date.now() - 5000;
    layer.prune();
    assert.equal(layer.store.has('old'), true, 'coverage lifetime is the floor');
    layer.store.get('old').seen = Date.now() - 120_000;
    layer.prune();
    assert.equal(layer.store.has('old'), false);
  });

  test('a successful refresh marks the server\'s covered box, not the request', async () => {
    layer.nextLoad = async () => { layer.coveredBbox = '0,0,5,5'; };
    await layer.refresh({ bbox: '1,1,2,2' });
    assert.equal(layer.status, 'ok');
    assert.equal(layer.isCovered('3,3,4,4'), true);
    assert.ok(layer.lastFetchAt > 0);
  });

  test('a covered view repaints from cache without fetching', async () => {
    await layer.refresh({ bbox: '1,1,2,2' });
    const statuses = [];
    await layer.refresh({ bbox: '1.2,1.2,1.8,1.8', onStatus: () => statuses.push(layer.status) });
    assert.equal(layer.loads, 1);
    assert.equal(layer.fromCache, true);
    assert.equal(layer.skipped, 1);
    assert.deepEqual(statuses, ['ok']);
    assert.equal(layer.count, 1);
  });

  test('SYNC (force) fetches even when covered, and asks the server for fresh data', async () => {
    await layer.refresh({ bbox: '1,1,2,2' });
    let forced;
    layer.nextLoad = async () => { forced = layer._forced; };
    await layer.refresh({ bbox: '1,1,2,2' }, { force: true });
    assert.equal(layer.loads, 2);
    assert.equal(forced, true);
  });

  test('fetch() adds fresh=1 only while forced', async () => {
    const calls = [];
    globalThis.fetch = async (url) => { calls.push(new URL(String(url))); return new Response('{"features":[]}'); };
    layer._forced = false;
    await layer.fetch('/api/overpass', { a: 1 });
    layer._forced = true;
    await layer.fetch('/api/overpass', { a: 1 });
    assert.equal(calls[0].searchParams.get('fresh'), null);
    assert.equal(calls[1].searchParams.get('fresh'), '1');
  });

  test('overlapping refreshes join the one in flight', async () => {
    let release;
    layer.nextLoad = () => new Promise((r) => { release = r; });
    const a = layer.refresh({ bbox: '1,1,2,2' });
    const b = layer.refresh({ bbox: '1,1,2,2' });
    release();
    await Promise.all([a, b]);
    assert.equal(layer.loads, 1);
  });

  test('a disabled layer does nothing', async () => {
    layer.setEnabled(false);
    await layer.refresh({ bbox: '1,1,2,2' });
    assert.equal(layer.loads, 0);
  });

  test('changing what is asked for drops the cache and the backoff', async () => {
    await layer.refresh({ bbox: '1,1,2,2' });
    layer.failures = 3;
    layer.retryAt = Date.now() + 60_000;
    layer.presets.add('power');
    await layer.refresh({ bbox: '1,1,2,2' });
    assert.equal(layer.loads, 2, 'not skipped by the backoff or the coverage');
    assert.equal(layer.failures, 0);
    assert.deepEqual(layer.records().map((r) => r.id), ['r2'], 'old results under other criteria are gone');
  });

  test('a failure steps through the retry ladder, honouring a longer retryAfter', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      layer.nextLoad = async () => { throw new Error('boom'); };
      const retries = [];
      const ctx = { bbox: '1,1,2,2', retry: () => retries.push(Date.now()) };
      const waits = [];
      for (let i = 0; i < 7; i++) {
        await layer.refresh(ctx, { isRetry: true });
        waits.push(layer.retryInSec);
      }
      assert.deepEqual(waits, [30, 60, 90, 120, 300, 3600, 3600]);
      assert.equal(layer.status, 'error');
      assert.equal(layer.error, 'boom');

      layer.resetBackoff();
      layer.nextLoad = async () => { throw Object.assign(new Error('429'), { retryAfter: 137 }); };
      await layer.refresh(ctx, { isRetry: true });
      assert.equal(layer.retryInSec, 137, 'the upstream asked for longer than the ladder step');

      mock.timers.tick(137_000 + 500);
      assert.equal(retries.length, 1, 'the retry goes back through the app, not a replay');
    } finally { mock.timers.reset(); }
  });

  test('while backing off, ordinary refreshes are skipped; SYNC is not', async () => {
    layer.retryAt = Date.now() + 60_000;
    layer.failures = 2;
    await layer.refresh({ bbox: '1,1,2,2' });
    assert.equal(layer.loads, 0);
    assert.equal(layer.skipped, 1);
    await layer.refresh({ bbox: '1,1,2,2' }, { force: true });
    assert.equal(layer.loads, 1);
    assert.equal(layer.failures, 0);
  });

  test('success clears the backoff', async () => {
    layer.nextLoad = async () => { throw new Error('x'); };
    await layer.refresh({ bbox: '1,1,2,2' }, { isRetry: true });
    layer.nextLoad = null;
    await layer.refresh({ bbox: '5,5,6,6' }, { isRetry: true });
    assert.equal(layer.failures, 0);
    assert.equal(layer.retryAt, null);
  });

  test('switching off cancels a pending retry; switching on starts the ladder over', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let retried = 0;
      layer.nextLoad = async () => { throw new Error('x'); };
      await layer.refresh({ bbox: '1,1,2,2', retry: () => retried++ }, { isRetry: true });
      layer.setEnabled(false);
      mock.timers.tick(60_000);
      assert.equal(retried, 0);
      layer.setEnabled(true);
      assert.equal(layer.failures, 0);
    } finally { mock.timers.reset(); }
  });

  test('holding for altitude keeps what is drawn and says why', async () => {
    await layer.refresh({ bbox: '1,1,2,2' });
    await layer.holdForAltitude();
    assert.equal(layer.status, 'held');
    assert.equal(layer.count, 1);
    assert.equal(layer.isCovered('1,1,2,2'), true);
  });

  test('clearCache empties everything', async () => {
    await layer.refresh({ bbox: '1,1,2,2' });
    layer.clearCache();
    assert.equal(layer.cached, 0);
    assert.equal(layer.count, 0);
    assert.equal(layer.isCovered('1,1,2,2'), false);
    assert.equal(layer.source.entities.values.length, 0);
  });

  test('Shodan keys records by ip:port and records the cell it was charged for', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      query: 'q', total: 2, byCategory: { web: 1 }, vulnerable: 1, cellDeg: 0.25,
      queried: { south: 1, west: 2, north: 3, east: 4 },
      matches: [{ ip: '1.2.3.4', port: 80, lat: 1, lon: 2, vulns: [], category: 'web' },
        { ip: '1.2.3.4', port: 443, lat: 1, lon: 2, vulns: ['CVE-1'], category: 'web' }],
    }));
    const s = new ShodanLayer(makeViewer());
    s.setEnabled(true);
    await s.refresh({ bbox: '1.5,2.5,2.5,3.5' });
    assert.deepEqual(s.records().map((r) => r.id).sort(), ['1.2.3.4:443', '1.2.3.4:80']);
    assert.equal(s.lastFetchedBbox, '1,2,3,4');
    assert.equal(s.isCovered('1.1,2.1,2.9,3.9'), true);
    assert.equal(s.count, 2);
  });
});

describe('OSM layer fetches the view tile by tile', () => {
  // The fake server: every tile holds `perCell` features per 0.125° cell,
  // and an answer over `limit` is cut, like the real draw limit.
  function osmLayer({ perCell = 1, limit = 3000, dense = new Set() } = {}) {
    const l = new OverpassLayer(makeViewer());
    l.setEnabled(true);
    l.padFactor = 0;
    const asked = [];
    l.fetch = async (path, params) => {
      asked.push(params.bbox);
      const [s, w, n, e] = params.bbox.split(',').map(Number);
      const feats = [];
      for (let y = s; y < n - 1e-9; y += 0.125) {
        for (let x = w; x < e - 1e-9; x += 0.125) {
          const k = `${y.toFixed(4)},${x.toFixed(4)}`;
          const count = dense.has(k) ? limit + 1 : perCell;
          for (let i = 0; i < count; i++) {
            feats.push({ id: `${k}:${i}`, lat: y + 0.06, lon: x + 0.06, preset: 'surveillance' });
          }
        }
      }
      const shown = feats.slice(0, limit);
      return { features: shown, count: shown.length, capped: shown.length < feats.length,
        truncated: shown.length < feats.length, covered: params.bbox };
    };
    return { l, asked };
  }
  const VIEW = '35.5,139.5,36.0,140.0';   // 2 x 2 tiles

  test('one request per tile, and the view is covered only when all of them are in', async () => {
    const { l, asked } = osmLayer();
    await l.refresh({ bbox: VIEW });
    assert.equal(asked.length, 4);
    assert.equal(l.status, 'ok');
    assert.equal(l.isCovered(VIEW), true);
    assert.equal(l.isCovered('35.4,139.5,36.0,140.0'), false, 'ground outside was never fetched');
    assert.equal(l.store.size, 16);
  });

  test('a tile cut to the draw limit is asked for again cell by cell, not marked as covered whole', async () => {
    const { l, asked } = osmLayer({ perCell: 2, limit: 5 });
    await l.refresh({ bbox: '35.5,139.5,35.75,139.75' });
    assert.deepEqual(asked.length, 5, 'the tile, then its four cells');
    assert.equal(l.store.size, 8, 'every feature arrived');
    assert.equal(l.truncated, false);
    assert.equal(l.isCovered('35.5,139.5,35.75,139.75'), true);
  });

  test('a single cell over the limit is kept and flagged, not asked for forever', async () => {
    const { l, asked } = osmLayer({ limit: 5, dense: new Set(['35.5000,139.5000']) });
    await l.refresh({ bbox: '35.5,139.5,35.75,139.75' });
    assert.equal(l.truncated, true);
    assert.equal(l.isCovered('35.5,139.5,35.75,139.75'), true);
    const n = asked.length;
    await l.refresh({ bbox: '35.5,139.5,35.75,139.75' });
    assert.equal(asked.length, n, 'no second round');
  });

  test('a pan only asks for the tiles it has not seen', async () => {
    const { l, asked } = osmLayer();
    await l.refresh({ bbox: VIEW });
    await l.refresh({ bbox: '35.5,139.75,36.0,140.25' });
    assert.equal(asked.length, 6);
  });

  test('evicted features give their ground back', async () => {
    const { l } = osmLayer();
    await l.refresh({ bbox: VIEW });
    l.cacheCap = 12;
    l.remember([{ id: 'x', lat: 10, lon: 10, preset: 'surveillance' }]);
    assert.equal(l.isCovered(VIEW), false);
  });

  test('a view wider than the limit is trimmed to its middle and says so', () => {
    const l = new OverpassLayer(makeViewer());
    const { tiles, trimmed } = l.tilesFor('34,138,38,142');
    assert.equal(trimmed, true);
    assert.equal(tiles.length, 16);
    assert.equal(tiles[0].key.split(',').map(Number).every((v) => Math.abs(v - 36) <= 0.25 || Math.abs(v - 140) <= 0.25), true,
      'nearest the middle first');
  });
});

describe('OSM layer loads only the view and a 25% margin', () => {
  test('requests are clipped to the padded view, and features past it are dropped', async () => {
    const l = new OverpassLayer(makeViewer());
    l.setEnabled(true);
    const asked = [];
    // Like the real server: answers for the whole 0.125° cells the box touches.
    l.fetch = async (path, params) => {
      asked.push(params.bbox);
      const [s, w, n, e] = params.bbox.split(',').map(Number);
      const g = 0.125;
      const feats = [];
      for (let y = Math.floor(s / g) * g; y < n - 1e-9; y += g) {
        for (let x = Math.floor(w / g) * g; x < e - 1e-9; x += g) {
          for (let i = 0; i < 4; i++) {
            feats.push({ id: `${y},${x},${i}`, lat: y + 0.01 + i * 0.03, lon: x + 0.01 + i * 0.03, preset: 'surveillance' });
          }
        }
      }
      return { features: feats, count: feats.length, capped: false, truncated: false };
    };
    const VIEW = '35.6,139.6,35.7,139.7';
    await l.refresh({ bbox: VIEW });
    const [S, W, N, E] = [35.575, 139.575, 35.725, 139.725];   // + 25% of the span each side
    assert.ok(asked.length > 0);
    for (const b of asked) {
      const [s, w, n, e] = b.split(',').map(Number);
      assert.ok(s >= S && w >= W && n <= N && e <= E, `request ${b} stays inside the padded view`);
    }
    for (const f of l.records()) {
      assert.ok(f.lat >= S && f.lat <= N && f.lon >= W && f.lon <= E, `feature ${f.id} is inside`);
    }
    assert.equal(l.isCovered(VIEW), true);
    assert.equal(asked.length, (await (async () => { await l.refresh({ bbox: '35.61,139.61,35.69,139.69' }); return asked.length; })()),
      'a small pan inside the margin needs no request');
  });
});

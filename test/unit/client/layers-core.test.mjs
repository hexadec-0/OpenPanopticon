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
import { api, apiQueueDepth, OverpassLayer, ShodanLayer } from '../../../public/js/layers.js';

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

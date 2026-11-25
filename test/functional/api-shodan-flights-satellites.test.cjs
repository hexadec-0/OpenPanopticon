// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers/harness.cjs');
const { TEST_KEYS } = require('../helpers/fixtures.cjs');
const { json, text, status } = require('../helpers/responses.cjs');

const BBOX = '34.95,-100.05,35.05,-99.95';

let s;
before(async () => { s = await startServer({ env: TEST_KEYS }); });
after(() => s.close());
beforeEach(async () => {
  s.mock.reset();
  s.mod.cache.clear();
  await s.mod.clearDiskCache();
  Object.assign(s.mod.openSky, { remaining: null, limit: null, checkedAt: 0, blockedUntil: 0 });
});

describe('/api/shodan', () => {
  test('returns geolocated hosts for the cell, with categories and CVEs', async () => {
    const r = await s.api('/api/shodan', { bbox: BBOX, preset: 'all' });
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.returned, 2, 'the host without a location is dropped');
    assert.equal(d.total, 3);
    assert.equal(d.vulnerable, 1);
    assert.deepEqual(d.byCategory, { web: 1, ics: 1 });
    const web = d.matches.find((m) => m.port === 443);
    assert.deepEqual(web.vulns.sort(), ['CVE-2021-44228', 'CVE-2023-0001']);
    assert.deepEqual(web.hostnames, ['host.example']);
    assert.equal(web.city, 'Testville');
    assert.equal(d.matches.find((m) => m.port === 502).country, 'TL');
    assert.equal(d.cellDeg, 0.25);
    assert.deepEqual(d.queried, { south: 34.75, west: -100.25, north: 35.25, east: -99.75 });
  });

  test('queries Shodan by bounding box, with the key, minified', async () => {
    await s.api('/api/shodan', { bbox: BBOX, preset: 'all' });
    const call = s.mock.callsTo('/shodan/host/search')[0];
    const u = new URL(call.url);
    assert.equal(u.searchParams.get('key'), TEST_KEYS.SHODAN_API_KEY);
    assert.equal(u.searchParams.get('minify'), 'true');
    // The snapped cell as Shodan's 4-value geo box: north,west,south,east.
    assert.equal(u.searchParams.get('query'), 'geo:"35.2500,-100.2500,34.7500,-99.7500"');
  });

  test('a named preset adds its filter; an unknown one falls back to "all"', async () => {
    const ics = (await s.api('/api/shodan', { bbox: BBOX, preset: 'ics' })).json();
    assert.match(ics.query, /^tag:ics geo:/);
    assert.equal(ics.note, s.mod.SHODAN_PRESETS.ics.note);
    const unknown = (await s.api('/api/shodan', { bbox: '40,-80,40.1,-79.9', preset: 'bogus' })).json();
    assert.match(unknown.query, /^geo:/);
  });

  test('a repeat view costs no credit (memory), nor after a restart (disk)', async () => {
    await s.api('/api/shodan', { bbox: BBOX });
    await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(s.mock.callsTo('/shodan/host/search').length, 1);
    s.mod.cache.clear();
    await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(s.mock.callsTo('/shodan/host/search').length, 1);
  });

  // Regression: a view inside a box already paid for snapped to a smaller box
  // and was charged again. Bought boxes are now indexed and reused.
  test('a nearby view inside an already-bought cell reuses it', async () => {
    await s.api('/api/shodan', { bbox: BBOX });
    const before = s.mock.callsTo('/shodan/host/search').length;
    const d = (await s.api('/api/shodan', { bbox: '35.06,-99.94,35.1,-99.9' })).json();
    assert.equal(s.mock.callsTo('/shodan/host/search').length, before);
    assert.deepEqual(d.queried, { south: 34.75, west: -100.25, north: 35.25, east: -99.75 });
  });

  test('the bought-box index survives a restart', async () => {
    await s.api('/api/shodan', { bbox: BBOX });
    const fs = require('node:fs');
    const t = await startServer({ env: TEST_KEYS });
    try {
      fs.mkdirSync(t.mod.DISK_CACHE_DIR, { recursive: true });
      for (const f of fs.readdirSync(s.mod.DISK_CACHE_DIR)) {
        fs.copyFileSync(`${s.mod.DISK_CACHE_DIR}/${f}`, `${t.mod.DISK_CACHE_DIR}/${f}`);
      }
      const d = (await t.api('/api/shodan', { bbox: '35.06,-99.94,35.1,-99.9' })).json();
      assert.equal(t.mock.callsTo('/shodan/host/search').length, 0, 'no credit spent after the restart');
      assert.equal(d.returned, 2);
    } finally { await t.close(); }
  });

  test('a box bought under one filter is not reused for another', async () => {
    await s.api('/api/shodan', { bbox: BBOX, preset: 'all' });
    await s.api('/api/shodan', { bbox: '35.06,-99.94,35.1,-99.9', preset: 'ics' });
    assert.equal(s.mock.callsTo('/shodan/host/search').length, 2);
  });

  test('the smallest covering box wins, and an expired answer is not reused', async () => {
    await s.api('/api/shodan', { bbox: '34.6,-100.4,35.4,-99.6' });     // a wide box
    await s.api('/api/shodan', { bbox: BBOX });                          // inside it: reused
    assert.equal(s.mock.callsTo('/shodan/host/search').length, 1);
    s.mod.cache.clear();
    await s.mod.clearDiskCache();                                        // answers gone
    await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(s.mock.callsTo('/shodan/host/search').length, 2, 'refetched rather than trusting the index');
  });

  test('fresh=1 (SYNC) refetches', async () => {
    await s.api('/api/shodan', { bbox: BBOX });
    await s.api('/api/shodan', { bbox: BBOX, fresh: 1 });
    assert.equal(s.mock.callsTo('/shodan/host/search').length, 2);
  });

  test('refuses to spend below the credit reserve, and spends nothing', async () => {
    s.mock.on('/api-info', () => json({ query_credits: 3 }));
    const r = await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(r.status, 429);
    assert.match(r.json().error, /credits are down to 3/);
    assert.equal(s.mock.callsTo('/shodan/host/search').length, 0);
  });

  test('if the credit check itself fails, the query goes ahead', async () => {
    s.mock.fail('/api-info', 500);
    assert.equal((await s.api('/api/shodan', { bbox: BBOX })).status, 200);
  });

  test('upstream errors are passed on with their status and reason', async () => {
    s.mock.on('/shodan/host/search', () => json({ error: 'Invalid API key' }, { status: 401 }));
    const r = await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(r.status, 401);
    assert.equal(r.json().error, 'Shodan returned HTTP 401: Invalid API key');
    assert.equal(r.json().source, '/api/shodan');
  });

  test('bbox is required', async () => {
    const r = await s.api('/api/shodan', { bbox: 'nope' });
    assert.equal(r.status, 400);
  });

  test('without a key: 412 and no upstream call', async () => {
    const t = await startServer();
    try {
      const r = await t.api('/api/shodan', { bbox: BBOX });
      assert.equal(r.status, 412);
      assert.match(r.json().error, /SHODAN_API_KEY/);
      assert.equal(t.mock.calls.length, 0);
      assert.equal((await t.api('/api/shodan/credits')).status, 412);
    } finally { await t.close(); }
  });

  test('/api/shodan/credits reports the account and is cached briefly', async () => {
    const a = (await s.api('/api/shodan/credits')).json();
    assert.equal(a.query_credits, 100);
    await s.api('/api/shodan/credits');
    assert.equal(s.mock.callsTo('/api-info').length, 1);
  });
});

describe('/api/shodan paging, reuse and area totals', () => {
  // A search that reports `total` matches and serves them 100 to a page.
  const paged = (total) => ({ params }) => {
    const page = Number(params.get('page') || 1);
    const from = (page - 1) * 100;
    const n = Math.max(0, Math.min(100, total - from));
    return json({ total, matches: Array.from({ length: n }, (_, i) => ({
      ip_str: `10.0.${page}.${i}`, port: 80, transport: 'tcp', data: 'HTTP/1.1 200 OK',
      location: { latitude: 35, longitude: -100 },
    })) });
  };
  const pagesAsked = () => s.mock.callsTo('/shodan/host/search')
    .map((c) => new URL(c.url).searchParams.get('page') || '1');

  test('a new area buys up to SHODAN_PAGES pages and says it is a sample', async () => {
    s.mock.on('/shodan/host/search', paged(1000));
    const d = (await s.api('/api/shodan', { bbox: BBOX })).json();
    assert.equal(s.mod.SHODAN_PAGES, 3);
    assert.deepEqual(pagesAsked(), ['1', '2', '3']);
    assert.equal(d.returned, 300);
    assert.equal(d.pages, 3);
    assert.equal(d.complete, false);
    assert.equal(d.total, 1000);
  });

  test('paging stops once every match is held', async () => {
    s.mock.on('/shodan/host/search', paged(150));
    const d = (await s.api('/api/shodan', { bbox: BBOX })).json();
    assert.deepEqual(pagesAsked(), ['1', '2']);
    assert.equal(d.returned, 150);
    assert.equal(d.complete, true);
  });

  test('a later page that fails keeps the pages already bought', async () => {
    // Later routes are matched first.
    s.mock.on('/shodan/host/search', paged(1000));
    s.mock.on((url) => url.pathname === '/shodan/host/search' && url.searchParams.get('page') === '2',
      () => json({ error: 'busy' }, { status: 503 }));
    const r = await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.returned, 100);
    assert.equal(d.pages, 1);
    assert.match(d.partial, /503/);
  });

  test('every page is cached: a repeat view buys nothing', async () => {
    s.mock.on('/shodan/host/search', paged(1000));
    await s.api('/api/shodan', { bbox: BBOX });
    s.mod.cache.clear();
    await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(pagesAsked().length, 3);
  });

  // Regression: zooming into a city inside a box answered with a 100-host
  // sample of 14 million redrew that sample instead of asking about the city.
  test('a sampled box is not reused for a smaller view inside it', async () => {
    s.mock.on('/shodan/host/search', paged(1000));
    await s.api('/api/shodan', { bbox: '34.6,-100.4,35.4,-99.6' });   // wide, sampled
    const before = pagesAsked().length;
    const d = (await s.api('/api/shodan', { bbox: BBOX })).json();     // inside it
    assert.ok(pagesAsked().length > before, 'the smaller view was asked about');
    assert.deepEqual(d.queried, { south: 34.75, west: -100.25, north: 35.25, east: -99.75 });
  });

  test('a box whose answer was complete is still reused', async () => {
    s.mock.on('/shodan/host/search', paged(40));
    await s.api('/api/shodan', { bbox: '34.6,-100.4,35.4,-99.6' });
    const before = pagesAsked().length;
    await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(pagesAsked().length, before);
  });

  test('area totals come from the count endpoint, by category from ports', async () => {
    const d = (await s.api('/api/shodan', { bbox: BBOX })).json();
    assert.equal(d.area.total, 125591);
    assert.equal(d.area.byCategory.web, 10118 + 9928);
    assert.equal(d.area.byCategory.remote, 5099);
    assert.equal(d.area.byCategory.ics, 12);
    const sum = Object.values(d.area.byCategory).reduce((a, b) => a + b, 0);
    assert.equal(sum, 125591, 'ports outside the top hundred count as other');
    assert.deepEqual(d.area.topIps[0], { ip: '198.51.100.99', count: 1246 });
    assert.equal(d.radiusKm > 0, true);
    const count = s.mock.callsTo('/shodan/host/count')[0];
    assert.equal(new URL(count.url).searchParams.get('query'), d.query);
  });

  test('a failed count leaves the answer without totals, not failed', async () => {
    s.mock.fail('/shodan/host/count', 500);
    const r = await s.api('/api/shodan', { bbox: BBOX });
    assert.equal(r.status, 200);
    assert.equal(r.json().area, null);
  });
});

describe('/api/shodan/host', () => {
  test('every port on the address, summarised, and the most notable category', async () => {
    const d = (await s.api('/api/shodan/host', { ip: '198.51.100.10' })).json();
    assert.equal(d.found, true);
    assert.deepEqual(d.ports, [22, 443, 8080]);
    assert.deepEqual(d.services.map((v) => v.port), [22, 443, 8080]);
    assert.equal(d.services.find((v) => v.port === 22).category, 'remote');
    assert.equal(d.category, 'remote', 'SSH outranks web');
    assert.deepEqual(d.vulns, ['CVE-2021-44228', 'CVE-2023-0001']);
    assert.equal(d.servicesTotal, 3);
    assert.equal(d.lat, 35.002);
  });

  test('spends no credit check, and is cached', async () => {
    await s.api('/api/shodan/host', { ip: '198.51.100.10' });
    s.mod.cache.clear();
    await s.api('/api/shodan/host', { ip: '198.51.100.10' });
    assert.equal(s.mock.callsTo('/shodan/host/198.51.100.10').length, 1);
    assert.equal(s.mock.callsTo('/api-info').length, 0);
  });

  test('an address Shodan holds nothing on is an answer, not an error', async () => {
    const r = await s.api('/api/shodan/host', { ip: '192.0.2.200' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { ip: '192.0.2.200', found: false });
  });

  test('only an IP address is accepted', async () => {
    for (const ip of ['', 'example.com', '../api-info', '1.2.3.4/24']) {
      assert.equal((await s.api('/api/shodan/host', { ip })).status, 400, ip);
    }
    assert.equal(s.mock.calls.length, 0);
  });

  test('without a key: 412', async () => {
    const t = await startServer();
    try {
      assert.equal((await t.api('/api/shodan/host', { ip: '198.51.100.10' })).status, 412);
    } finally { await t.close(); }
  });

  test('a huge host is capped, lowest ports first, with the full count kept', () => {
    const data = Array.from({ length: 400 }, (_, i) => ({ port: 1000 + i, data: '' }));
    const d = s.mod.summariseShodanHost('192.0.2.1', { data, ports: data.map((x) => x.port) });
    assert.equal(d.services.length, 300);
    assert.equal(d.services[0].port, 1000);
    assert.equal(d.servicesTotal, 400);
    assert.equal(d.ports.length, 400);
  });
});

describe('/api/flights', () => {
  test('returns live aircraft, drops stale and unpositioned ones', async () => {
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    // OpenSky's three live contacts plus the military one only adsb.lol hears;
    // one stale contact from each side is dropped.
    assert.equal(d.count, 4);
    assert.equal(d.dropped, 2);
    assert.equal(d.staleAfter, 120);
    assert.deepEqual(d.aircraft.map((a) => a.icao24).sort(), ['a1b2c3', 'ae1234', 'd4e5f6', 'ffeedd']);
    const a = d.aircraft.find((x) => x.icao24 === 'a1b2c3');
    assert.equal(a.callsign, 'TST123');
    assert.equal(a.altitude, 10100, 'geometric altitude preferred');
    assert.equal(a.category, 'Large');
    assert.ok(a.ageSec >= 0 && a.ageSec < 10);
  });

  test('flags emergency squawks', async () => {
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    const e = d.aircraft.find((x) => x.squawk === '7700');
    assert.equal(e.alert, 'EMERGENCY');
    assert.equal(d.aircraft.find((x) => x.icao24 === 'ffeedd').onGround, true);
  });

  test('asks for the snapped 1° cell and reports it as covered', async () => {
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    assert.equal(d.covered, '34,-101,36,-99');
    const u = new URL(s.mock.callsTo('/api/states/all')[0].url);
    assert.equal(u.searchParams.get('lamin'), '34.0000');
    assert.equal(u.searchParams.get('lomax'), '-99.0000');
    assert.equal(u.searchParams.get('extended'), '1');
  });

  test('authenticates with OAuth client credentials, reusing the token', async () => {
    s.mod.cache.clear();
    await s.api('/api/flights', { bbox: BBOX });
    await s.api('/api/flights', { bbox: '40,-80,40.1,-79.9' });
    const auth = s.mock.callsTo('auth.opensky-network.org');
    assert.ok(auth.length <= 1, 'token fetched at most once');
    for (const c of s.mock.callsTo('/api/states/all')) assert.equal(c.headers.authorization, 'Bearer opensky-test-token');
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    assert.equal(d.authenticated, true);
    assert.equal(d.resolutionSec, 5);
  });

  test('records the credit budget and derives a poll interval from it', async () => {
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    assert.equal(d.credits, 3900);
    assert.equal(d.creditFloor, 60);
    assert.ok(d.pollSec >= 6 && d.pollSec <= 300);
  });

  test('is cached only for the feed resolution', async () => {
    await s.api('/api/flights', { bbox: BBOX });
    await s.api('/api/flights', { bbox: BBOX });
    assert.equal(s.mock.callsTo('/api/states/all').length, 1);
    const entry = [...s.mod.cache.entries()].find(([k]) => k.startsWith('flights:'))[1];
    assert.ok(entry.expires - Date.now() <= 5000);
  });

  test('a 429 blocks further automatic polls for as long as OpenSky asked', async () => {
    // With the unfiltered feed also down, OpenSky's refusal is the answer.
    s.mock.fail('api.adsb.lol', 503, 'down');
    s.mock.on('/api/states/all', () => status(429, 'Too many requests', { 'x-rate-limit-retry-after-seconds': '120' }));
    const r = await s.api('/api/flights', { bbox: BBOX });
    assert.equal(r.status, 429);
    assert.equal(r.json().retryAfter, 120);
    const calls = s.mock.callsTo('/api/states/all').length;
    const again = await s.api('/api/flights', { bbox: '40,-80,40.1,-79.9' });
    assert.equal(again.status, 429);
    assert.match(again.json().error, /rate-limiting this account/);
    assert.equal(s.mock.callsTo('/api/states/all').length, calls, 'no request into a closed door');
  });

  test('anonymous: no auth call and the slower resolution', async () => {
    const t = await startServer({ env: { ADSB_FEED: 'off' } });
    try {
      const d = (await t.api('/api/flights', { bbox: BBOX })).json();
      assert.equal(d.authenticated, false);
      assert.equal(d.resolutionSec, 10);
      assert.equal(t.mock.callsTo('auth.opensky-network.org').length, 0);
      assert.equal(t.mock.callsTo('/api/states/all')[0].headers.authorization, undefined);
    } finally { await t.close(); }
  });

  test('bbox is required', async () => {
    assert.equal((await s.api('/api/flights', {})).status, 400);
  });
});

describe('/api/flights with an unfiltered ADS-B feed', () => {
  test('asks adsb.lol by point and radius over the snapped cell', async () => {
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    const call = s.mock.callsTo('api.adsb.lol')[0];
    assert.match(new URL(call.url).pathname, /^\/v2\/point\/35\/-100\/\d+$/);
    const nm = Number(new URL(call.url).pathname.split('/').pop());
    assert.ok(nm >= 75 && nm <= 250, `radius ${nm} nm covers the 2x2 degree cell corners`);
    assert.deepEqual({ ...d.feed, count: undefined }, {
      name: 'adsb.lol', label: 'adsb.lol', licence: 'ODbL', ok: true, count: undefined, military: 1 });
    assert.equal(d.resolutionSec, 5);
    assert.deepEqual(d.problems, {});
  });

  test('merges by hex: OpenSky\'s fresher fix, the feed\'s registration and type', async () => {
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    const a = d.aircraft.find((x) => x.icao24 === 'a1b2c3');
    assert.deepEqual(a.sources, ['opensky', 'adsb.lol']);
    assert.equal(a.registration, 'N123TS');
    assert.equal(a.aircraftType, 'B738');
    assert.equal(a.country, 'United States', 'OpenSky\'s registration country kept');
    assert.equal(a.nic, 8);
  });

  test('military aircraft only the feed hears, in OpenSky\'s units', async () => {
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    const m = d.aircraft.find((x) => x.icao24 === 'ae1234');
    assert.equal(m.military, true);
    assert.equal(m.callsign, 'RCH417');
    assert.equal(m.category, 'Heavy');
    assert.equal(Math.round(m.altitude), Math.round(31400 * 0.3048));
    assert.equal(Math.round(m.velocity), Math.round(442 * 0.514444));
    assert.equal(Math.round(m.verticalRate * 100), Math.round(-640 * 0.00508 * 100));
    assert.equal(m.nic, 0);
    assert.equal(m.nacp, 0);
    const g = d.aircraft.find((x) => x.icao24 === 'ffeedd');
    assert.equal(g.onGround, true);
  });

  test('OpenSky refusing is a note, not a failure, while the feed answers', async () => {
    s.mock.on('/api/states/all', () => status(429, 'Too many requests', { 'x-rate-limit-retry-after-seconds': '120' }));
    const r = await s.api('/api/flights', { bbox: BBOX });
    assert.equal(r.status, 200);
    const d = r.json();
    assert.match(d.problems.opensky, /429|rate/i);
    assert.deepEqual(d.aircraft.map((a) => a.icao24).sort(), ['a1b2c3', 'ae1234', 'ffeedd']);
    assert.deepEqual(d.aircraft.find((a) => a.icao24 === 'a1b2c3').sources, ['adsb.lol']);
  });

  test('OpenSky is asked at its budgeted pace, the feed every poll', async () => {
    await s.api('/api/flights', { bbox: BBOX });
    await new Promise((r) => setTimeout(r, 5100));   // past the feed's 5s cache
    await s.api('/api/flights', { bbox: BBOX });
    assert.equal(s.mock.callsTo('api.adsb.lol').length, 2);
    assert.equal(s.mock.callsTo('/api/states/all').length, 1, 'held OpenSky answer reused');
  });

  test('airplanes.live and adsb.fi use the same adapter; off asks neither', async () => {
    for (const [feed, host, path] of [
      ['airplanes.live', 'api.airplanes.live', /^\/v2\/point\//],
      ['adsb.fi', 'opendata.adsb.fi', /^\/api\/v2\/lat\/35\/lon\/-100\/dist\/\d+$/],
    ]) {
      const t = await startServer({ env: { ADSB_FEED: feed } });
      try {
        const d = (await t.api('/api/flights', { bbox: BBOX })).json();
        assert.equal(d.feed.name, feed);
        assert.match(new URL(t.mock.callsTo(host)[0].url).pathname, path);
        assert.ok(d.aircraft.some((a) => a.military));
      } finally { await t.close(); }
    }
    const off = await startServer({ env: { ADSB_FEED: 'off' } });
    try {
      const d = (await off.api('/api/flights', { bbox: BBOX })).json();
      assert.equal(d.feed, undefined);
      assert.equal(off.mock.callsTo('adsb').length, 0);
    } finally { await off.close(); }
  });
});

describe('ADS-B normalising and merging', () => {
  test('ground, missing fields and privacy flags', () => {
    const g = s.mod.normaliseAdsb({ hex: 'ABC123', lat: 1, lon: 2, alt_baro: 'ground', dbFlags: 8 }, 'adsb.lol');
    assert.equal(g.icao24, 'abc123');
    assert.equal(g.onGround, true);
    assert.equal(g.altitude, 0);
    assert.equal(g.privacyBlocked, true);
    assert.equal(g.military, false);
    assert.equal(s.mod.normaliseAdsb({ hex: 'x', lat: 'nope', lon: 2 }, 'adsb.lol'), null);
    assert.equal(s.mod.normaliseAdsb({ lat: 1, lon: 2 }, 'adsb.lol'), null);
    assert.equal(s.mod.normaliseAdsb({ hex: 'e1', lat: 1, lon: 2, squawk: '7700' }, 'x').alert, 'EMERGENCY');
  });

  test('the fresher position wins; flags and alerts from either side survive', () => {
    const sky = { icao24: 'aa', lat: 1, lon: 1, ageSec: 20, country: 'X', alert: null, sources: ['opensky'] };
    const feed = { icao24: 'aa', lat: 2, lon: 2, ageSec: 1, country: null, military: true, alert: 'EMERGENCY', registration: 'R', sources: ['adsb.lol'] };
    const [m] = s.mod.mergeAircraft([sky], [feed]);
    assert.equal(m.lat, 2);
    assert.equal(m.country, 'X');
    assert.equal(m.military, true);
    assert.equal(m.alert, 'EMERGENCY');
    assert.equal(m.registration, 'R');
    assert.deepEqual(m.sources, ['opensky', 'adsb.lol']);
  });
});

describe('/api/satellites', () => {
  test('parses the element sets, skipping a malformed record', async () => {
    const d = (await s.api('/api/satellites', { group: 'stations' })).json();
    assert.equal(d.group, 'stations');
    assert.equal(d.label, 'Space stations');
    assert.equal(d.returned, 2);
    const iss = d.satellites.find((x) => x.norad === 25544);
    assert.equal(iss.name, 'ISS (ZARYA)');
    assert.equal(iss.intlDes, '98067A');
    assert.equal(iss.classification, 'U');
    assert.equal(iss.inclination, 51.6416);
    assert.equal(iss.eccentricity, 0.0006703);
    assert.equal(iss.meanMotion, 15.72125391);
    assert.equal(iss.tle1.length, 69);
    assert.equal(d.stale, false);
  });

  test('respects the limit', async () => {
    const d = (await s.api('/api/satellites', { group: 'stations', limit: '1' })).json();
    assert.equal(d.returned, 1);
  });

  test('an unknown group falls back to stations', async () => {
    require('node:fs').rmSync(s.mod.TLE_DIR, { recursive: true, force: true });
    const d = (await s.api('/api/satellites', { group: '../../etc' })).json();
    assert.equal(d.group, 'stations');
    assert.equal(new URL(s.mock.callsTo('celestrak.org').at(-1).url).searchParams.get('GROUP'), 'stations');
  });

  test('every advertised group is accepted', async () => {
    const groups = (await s.api('/api/health')).json().presets.satellites;
    assert.ok(Object.keys(groups).length >= 20);
    const d = (await s.api('/api/satellites', { group: 'starlink' })).json();
    assert.equal(d.group, 'starlink');
  });

  test('"No GP data found" with nothing saved is a 404', async () => {
    s.mock.on('celestrak.org', () => text('No GP data found'));
    const d = await s.api('/api/satellites', { group: 'gps-ops' });
    assert.equal(d.status, 404);
    assert.match(d.json().error, /no group "gps-ops"/);
  });

  test('when CelesTrak declines a repeat download, the saved copy is served and flagged', async () => {
    await s.api('/api/satellites', { group: 'weather' });
    s.mod.cache.clear();
    s.mock.fail('celestrak.org', 403, 'GP data has not updated since your last successful download');
    const d = (await s.api('/api/satellites', { group: 'weather' })).json();
    assert.equal(d.stale, true);
    assert.equal(d.returned, 2);
    assert.ok(d.elementsAt);
  });
});

describe('Shodan request spacing', () => {
  test('calls to Shodan wait their turn, at least minGapMs apart', async () => {
    const gate = s.mod.shodanGate;
    const savedGap = gate.minGapMs;
    gate.minGapMs = 150;
    gate.lastDoneAt = 0;
    const times = [];
    s.mock.on('/api-info', () => { times.push(Date.now()); return json({ query_credits: 100 }); });
    s.mock.on('/shodan/host/search', () => { times.push(Date.now()); return json({ matches: [], total: 0 }); });
    try {
      // Two different cells at once: both need a credit check and a search.
      const [a, b] = await Promise.all([
        s.api('/api/shodan', { bbox: BBOX }),
        s.api('/api/shodan', { bbox: '40.1,-80.2,40.2,-80.1' }),
      ]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.ok(times.length >= 3, `${times.length} Shodan calls`);
      for (let i = 1; i < times.length; i++) {
        assert.ok(times[i] - times[i - 1] >= 140, `gap ${times[i] - times[i - 1]}ms between calls ${i} and ${i + 1}`);
      }
    } finally {
      gate.minGapMs = savedGap;
    }
  });

  test('defaults to just over a second, and the test harness turns it off', () => {
    assert.equal(s.mod.shodanGate.minGapMs, 0);
    const { loadServer } = require('../helpers/harness.cjs');
    const t = loadServer({ env: { SHODAN_MIN_GAP_MS: '' } });
    try { assert.equal(t.mod.shodanGate.minGapMs, 1100); } finally { t.restore?.(); }
  });
});

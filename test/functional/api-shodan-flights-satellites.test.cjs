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

  test('queries Shodan by centre and radius, with the key, minified', async () => {
    await s.api('/api/shodan', { bbox: BBOX, preset: 'all' });
    const call = s.mock.callsTo('/shodan/host/search')[0];
    const u = new URL(call.url);
    assert.equal(u.searchParams.get('key'), TEST_KEYS.SHODAN_API_KEY);
    assert.equal(u.searchParams.get('minify'), 'true');
    assert.match(u.searchParams.get('query'), /^geo:"35\.0000,-100\.0000,\d+"$/);
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

describe('/api/flights', () => {
  test('returns live aircraft, drops stale and unpositioned ones', async () => {
    const d = (await s.api('/api/flights', { bbox: BBOX })).json();
    assert.equal(d.count, 3);
    assert.equal(d.dropped, 1);
    assert.equal(d.staleAfter, 120);
    assert.deepEqual(d.aircraft.map((a) => a.icao24).sort(), ['a1b2c3', 'd4e5f6', 'ffeedd']);
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
    const t = await startServer();
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

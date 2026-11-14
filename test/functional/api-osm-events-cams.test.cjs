// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers/harness.cjs');
const { TEST_KEYS } = require('../helpers/fixtures.cjs');
const { json, status } = require('../helpers/responses.cjs');

const BBOX = '34.95,-100.05,35.05,-99.95';

let s;
before(async () => {
  s = await startServer({ env: { ...TEST_KEYS, EDIS_API_URL: 'https://edis.example/api/events', EDIS_API_KEY: 'edis-key' } });
});
after(() => s.close());
beforeEach(async () => {
  s.mock.reset();
  s.mod.cache.clear();
  await s.mod.clearDiskCache();
  Object.assign(s.mod.overpassGate, { chain: Promise.resolve(), lastStartedAt: 0, minGapMs: 0, cooldownUntil: 0, consecutive429: 0, mirrors: new Map(), coolFactor: 0 });
  s.mod.overpassDense.clear();
});

const overpassQl = () => new URLSearchParams(s.mock.callsTo('overpass-api.de').at(-1).body).get('data');

describe('/api/overpass when Overpass refuses part-way', () => {
  const WIDE = '34.76,-100.24,35.24,-99.76';   // 16 cells, asked in four parts
  const isQuery = (url, call) => /overpass/.test(url.hostname) && call.method === 'POST';
  /** One element at the middle of whatever box the query asked for. */
  const oneInBox = ({ body }) => {
    const data = new URLSearchParams(String(body)).get('data');
    const [s1, w, n, e] = /\((-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\)/.exec(data).slice(1).map(Number);
    return json({ elements: [{ type: 'node', id: Math.round((s1 + w) * 1000), lat: (s1 + n) / 2, lon: (w + e) / 2,
      tags: { man_made: 'surveillance' } }] });
  };

  test('the parts already fetched are returned and drawn, marked partial, with when to ask again', async () => {
    s.mock.on(isQuery, () => status(429, 'rate limited'));
    s.mock.once(isQuery, oneInBox);
    const all = Object.keys(s.mod.OVERPASS_PRESETS).join(',');
    const r = await s.api('/api/overpass', { bbox: WIDE, presets: all });
    assert.equal(r.status, 200);
    const d = r.json();
    assert.equal(d.partial, true);
    assert.equal(d.cells, 16);
    assert.equal(d.missing, 12);
    assert.equal(d.count, 1, 'the part that came back is in the answer');
    assert.equal(d.covered, null, 'claims no coverage it does not have');
    assert.ok(d.retryAfter > 0);
  });

  test('nothing in hand at all is still an error', async () => {
    s.mock.on(isQuery, () => status(429, 'rate limited'));
    const r = await s.api('/api/overpass', { bbox: WIDE, presets: 'surveillance' });
    assert.equal(r.status, 429);
  });

  test('cached ground is shown even while Overpass is cooling down', async () => {
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power' });
    s.mod.overpassGate.cooldownUntil = Date.now() + 120_000;
    const d = (await s.api('/api/overpass', { bbox: WIDE, presets: 'power' })).json();
    assert.equal(d.partial, true);
    assert.ok(d.count > 0, 'the cached cells are drawn');
    assert.ok(d.retryAfter >= 100);
  });
});

describe('/api/overpass request sizing', () => {
  test('a wide view with every class is asked in small boxes, not one huge one', async () => {
    // 0.5 x 0.5 degrees = 16 cells; ten classes allow 4 cells per query.
    const all = Object.keys(s.mod.OVERPASS_PRESETS).join(',');
    await s.api('/api/overpass', { bbox: '34.76,-100.24,35.24,-99.76', presets: all });
    assert.equal(s.mock.callsTo('overpass').length, 4);
    assert.match(overpassQl(), /^\[out:json\]\[timeout:30\]\[maxsize:\d+\];/);
  });

  test('cells that overflowed the cap are asked one at a time next time, with no doomed group query', async () => {
    s.mod.overpassLimits.queryCap = 4;
    try {
      await s.api('/api/overpass', { bbox: BBOX, presets: 'surveillance,military,power,comms,aviation,emergency' });
      s.mod.cache.clear();
      await s.mod.clearDiskCache();
      const before = s.mock.callsTo('overpass').length;
      await s.api('/api/overpass', { bbox: BBOX, presets: 'surveillance,military,power,comms,aviation,emergency' });
      assert.equal(s.mock.callsTo('overpass').length - before, 4, 'four single-cell queries only');
    } finally {
      s.mod.overpassLimits.queryCap = 4000;
    }
  });
});

describe('/api/overpass', () => {
  test('one unioned query for every selected class, partitioned on the way back', async () => {
    const d = (await s.api('/api/overpass', { bbox: BBOX, presets: 'surveillance,military,power,comms,aviation,emergency' })).json();
    assert.equal(s.mock.callsTo('overpass').length, 1);
    assert.deepEqual(d.byPreset, { surveillance: 1, military: 1, comms: 1, power: 1, aviation: 0, emergency: 1 });
    assert.equal(d.count, 5, 'the café and the element with no geometry are skipped');
    assert.equal(d.labels.military, 'Military sites');
    assert.match(d.colors.power, /^#/);
  });

  test('a feature matching several classes goes to the first, and lists them all', async () => {
    const d = (await s.api('/api/overpass', { bbox: BBOX, presets: 'aviation,military' })).json();
    const base = d.features.find((f) => f.name === 'Test Air Force Base');
    assert.equal(base.preset, 'military');
    assert.deepEqual(base.presets, ['military', 'aviation']);
    assert.equal(base.presetLabel, 'Military sites');
    assert.equal(base.id, 'way/3002');
  });

  test('the query is over the snapped cell, in canonical order, so the cache key is stable', async () => {
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power,surveillance' });
    const ql = overpassQl();
    assert.match(ql, /^\[out:json\]\[timeout:30\]\[maxsize:\d+\];\(/);
    assert.ok(ql.indexOf('surveillance') < ql.indexOf('power'), 'canonical order, not request order');
    assert.match(ql, /\(34\.875,-100\.125,35\.125,-99\.875\)/);
    // Same classes in another order: served from cache.
    await s.api('/api/overpass', { bbox: BBOX, presets: 'surveillance,power,power' });
    assert.equal(s.mock.callsTo('overpass').length, 1);
  });

  test('reports the covered cell and whether the cap truncated the answer', async () => {
    const d = (await s.api('/api/overpass', { bbox: BBOX, presets: 'surveillance,military,power,comms,aviation,emergency', limit: '3' })).json();
    assert.equal(d.covered, '34.875,-100.125,35.125,-99.875');
    assert.equal(d.truncated, true);
    assert.equal(d.trimmed, false);
    // The query asks for far more than the view draws, so the cache can
    // hold the area complete; the answer is cut to the limit afterwards.
    assert.match(overpassQl(), /out center 4000;$/);
    assert.equal(d.count, 3);
  });

  test('cached per cell: a smaller view inside one already fetched needs no query', async () => {
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power' });
    s.mod.cache.clear();   // as after a restart: only the disk copy is left
    const d = (await s.api('/api/overpass', { bbox: '34.88,-100.12,34.99,-100.01', presets: 'power' })).json();
    assert.equal(s.mock.callsTo('overpass').length, 1, 'served from the cells on disk');
    assert.equal(d.covered, '34.875,-100.125,35,-100');
  });

  test('a pan only queries the cells it has not seen', async () => {
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power' });
    await s.api('/api/overpass', { bbox: '34.95,-99.95,35.05,-99.85', presets: 'power' });
    assert.equal(s.mock.callsTo('overpass').length, 2);
    assert.match(overpassQl(), /\(34\.875,-99\.875,35\.125,-99\.75\)/, 'only the new column of cells');
  });

  test('adding a class only queries that class', async () => {
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power' });
    const d = (await s.api('/api/overpass', { bbox: BBOX, presets: 'power,military' })).json();
    assert.equal(s.mock.callsTo('overpass').length, 2);
    const ql = overpassQl();
    assert.ok(ql.includes('military') && !ql.includes('substation'), 'power is not asked for again');
    assert.equal(d.byPreset.power, 1);
  });

  test('a small drawing limit still stores the area complete', async () => {
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power', limit: '3' });
    s.mod.cache.clear();
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power', limit: '3' });
    assert.equal(s.mock.callsTo('overpass').length, 1, 'served from disk the second time');
  });

  test('an answer over the query cap is split until each part is complete', async () => {
    s.mod.overpassLimits.queryCap = 4;
    try {
      const d = (await s.api('/api/overpass', { bbox: BBOX, presets: 'surveillance,military,power,comms,aviation,emergency' })).json();
      assert.ok(s.mock.callsTo('overpass').length > 1, 'asked in parts');
      assert.equal(d.truncated, true, 'single cells still over the cap say so');
      // What was complete is on disk; what was not is not.
      s.mod.cache.clear();
      const before = s.mock.callsTo('overpass').length;
      await s.api('/api/overpass', { bbox: BBOX, presets: 'surveillance,military,power,comms,aviation,emergency' });
      assert.ok(s.mock.callsTo('overpass').length > before, 'the incomplete cells are asked again');
    } finally {
      s.mod.overpassLimits.queryCap = 4000;
    }
  });

  test('a truncated cell is not kept on disk', async () => {
    s.mod.overpassLimits.queryCap = 1;
    try {
      await s.api('/api/overpass', { bbox: '34.88,-100.12,34.99,-100.01', presets: 'power,surveillance' });
      s.mod.cache.clear();
      await s.api('/api/overpass', { bbox: '34.88,-100.12,34.99,-100.01', presets: 'power,surveillance' });
      assert.equal(s.mock.callsTo('overpass').length, 2);
    } finally {
      s.mod.overpassLimits.queryCap = 4000;
    }
  });

  test('a view wider than Overpass can answer is trimmed to its centre and says so', async () => {
    const d = (await s.api('/api/overpass', { bbox: '33,-102,37,-98', presets: 'power' })).json();
    assert.equal(d.trimmed, true);
  });

  test('accepts the single-class "preset" parameter too', async () => {
    const d = (await s.api('/api/overpass', { bbox: BBOX, preset: 'surveillance' })).json();
    assert.deepEqual(d.presets, ['surveillance']);
  });

  test('validation', async () => {
    assert.equal((await s.api('/api/overpass', { bbox: BBOX })).status, 400);
    const r = await s.api('/api/overpass', { bbox: BBOX, presets: 'surveillance,nukes' });
    assert.equal(r.status, 400);
    assert.match(r.json().error, /unknown preset "nukes"/);
    assert.equal((await s.api('/api/overpass', { presets: 'power' })).status, 400);
  });

  test('every mirror rate-limited: 429 with a retry time for the browser', async () => {
    for (const h of ['overpass-api.de', 'overpass.kumi.systems', 'overpass.private.coffee']) s.mock.fail(h, 429, 'slow down');
    const r = await s.api('/api/overpass', { bbox: BBOX, presets: 'power' });
    assert.equal(r.status, 429);
    assert.ok(r.json().retryAfter > 0);
  });

  test('a failed first mirror is retried on the next, transparently', async () => {
    s.mock.fail('overpass-api.de', 504, 'gateway timeout');
    const r = await s.api('/api/overpass', { bbox: BBOX, presets: 'power' });
    assert.equal(r.status, 200);
    assert.equal(r.json().count, 1);
  });
});

describe('Overpass cooldown', () => {
  test('doubles from 15 s and stops at five minutes', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map((n) => s.mod.overpassBackoffMs(n) / 1000), [15, 30, 60, 120, 240, 300, 300]);
  });
});

describe('/api/alpr', () => {
  test('cached per cell: another view over fetched ground needs no query, even after a restart', async () => {
    await s.api('/api/alpr', { bbox: BBOX });
    s.mod.cache.clear();   // as after a restart: only the disk copy is left
    const d = (await s.api('/api/alpr', { bbox: '34.88,-100.12,35.1,-99.9' })).json();
    assert.equal(s.mock.callsTo('overpass').length, 1);
    assert.equal(d.total, 4);
  });

  test('de-duplicates, classifies vendors and parses bearings', async () => {
    const d = (await s.api('/api/alpr', { bbox: BBOX })).json();
    assert.equal(d.count, 4);
    assert.equal(d.total, 4);
    assert.deepEqual(d.byVendor, { flock: 1, motorola: 1, other: 1, genetec: 1 });
    const flock = d.cameras.find((c) => c.vendor === 'flock');
    assert.deepEqual(flock.directions, [90], '500 is dropped');
    assert.equal(flock.directionRaw, '90;500');
    assert.equal(flock.operator, 'Testville Police Department');
    assert.equal(flock.mount, 'pole');
    assert.equal(flock.image, 'https://images.example/flock1.jpg');
    assert.deepEqual(d.cameras.find((c) => c.vendor === 'motorola').directions, [22.5]);
    assert.equal(d.withDirection, 2);
    assert.equal(d.byOperator['Test County Sheriff'], 1);
    assert.equal(d.vendors.length, 7);
  });

  test('a javascript: image tag is dropped', async () => {
    const d = (await s.api('/api/alpr', { bbox: BBOX })).json();
    const other = d.cameras.find((c) => c.vendor === 'other');
    assert.equal(other.image, null);
    assert.deepEqual(other.directions, []);
  });

  test('a way is placed at its centre', async () => {
    const d = (await s.api('/api/alpr', { bbox: BBOX })).json();
    const way = d.cameras.find((c) => c.osmType === 'way');
    assert.equal(way.vendor, 'genetec');
    assert.ok(Number.isFinite(way.lat));
  });

  test('vendor filter narrows the list but not the totals', async () => {
    const d = (await s.api('/api/alpr', { bbox: BBOX, vendor: 'flock,motorola' })).json();
    assert.equal(d.count, 2);
    assert.equal(d.total, 4);
  });

  test('queries the canonical ALPR tags plus Flock by manufacturer and brand', async () => {
    await s.api('/api/alpr', { bbox: BBOX });
    const ql = overpassQl();
    assert.match(ql, /"surveillance:type"~"\^\(ALPR\|ANPR\)\$",i/);
    assert.match(ql, /\["manufacturer"~"flock",i\]/);
    assert.match(ql, /\["brand"~"flock",i\]/);
  });
});

describe('/api/events', () => {
  test('merges every requested source into one shape, most severe first', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'gdacs,eonet,usgs,nws,firms,edis' })).json();
    assert.deepEqual(d.problems, {});
    assert.deepEqual(d.bySource, { gdacs: 1, eonet: 2, usgs: 3, nws: 2, firms: 3, edis: 1 });
    assert.equal(d.count, 12);
    const rank = { red: 3, orange: 2, green: 1, info: 0 };
    for (let i = 1; i < d.events.length; i++) {
      assert.ok(rank[d.events[i - 1].severity] >= rank[d.events[i].severity], 'sorted by severity');
    }
    for (const e of d.events) {
      for (const k of ['source', 'id', 'title', 'lat', 'lon', 'severity']) assert.ok(k in e, `${e.id} lacks ${k}`);
    }
    assert.equal(d.firmsConfigured, true);
    assert.equal(d.edisConfigured, true);
  });

  test('defaults to the four keyless sources', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX })).json();
    assert.deepEqual(Object.keys(d.bySource).sort(), ['eonet', 'gdacs', 'nws', 'usgs']);
  });

  test('GDACS: alert level, magnitude, stripped HTML, events outside the view dropped', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'gdacs' })).json();
    assert.equal(d.count, 1);
    const e = d.events[0];
    assert.equal(e.severity, 'red');
    assert.equal(e.kind, 'Earthquake');
    assert.equal(e.magnitudeText, 'Magnitude 6.5M');
    assert.equal(e.description, 'Strong quake');
    assert.equal(e.url, 'https://www.gdacs.org/report.aspx?eventid=1');
  });

  test('USGS: severity from magnitude, depth, tsunami flag', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'usgs' })).json();
    const by = Object.fromEntries(d.events.map((e) => [e.id, e]));
    assert.equal(by['usgs:us3'].severity, 'red');
    assert.equal(by['usgs:us1'].severity, 'orange');
    assert.equal(by['usgs:us2'].severity, 'green');
    assert.match(by['usgs:us3'].description, /TSUNAMI FLAG SET/);
    assert.equal(by['usgs:us1'].depthKm, 10.2);
  });

  test('NWS: polygons, a centroid, and zone-only alerts counted but not drawn', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'nws' })).json();
    assert.equal(d.zoneOnlyAlerts, 1);
    const tornado = d.events.find((e) => e.title === 'Tornado Warning');
    assert.equal(tornado.severity, 'red');
    assert.equal(tornado.instruction, 'Take shelter now.');
    assert.equal(tornado.polygon.length, 5);
    assert.equal(d.events.find((e) => e.title === 'Flood Watch').severity, 'orange');
    const call = s.mock.callsTo('api.weather.gov')[0];
    assert.equal(call.headers.accept, 'application/geo+json');
  });

  test('EONET: points and polygons, queried over the snapped cell', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'eonet' })).json();
    assert.equal(d.count, 2);
    const ice = d.events.find((e) => e.title === 'Test Ice Sheet');
    assert.equal(ice.polygon.length, 4);
    assert.equal(d.events.find((e) => e.title === 'Test Wildfire').magnitudeText, '1200 acres');
    const u = new URL(s.mock.callsTo('eonet').at(-1).url);
    assert.equal(u.searchParams.get('bbox'), '-101,36,-99,34');   // min-lon,max-lat,max-lon,min-lat
  });

  test('EONET and FIRMS reuse one answer for nearby views (snapped cache key)', async () => {
    await s.api('/api/events', { bbox: BBOX, sources: 'eonet,firms' });
    await s.api('/api/events', { bbox: '34.9,-100.1,35.1,-99.9', sources: 'eonet,firms' });   // same 1° cover
    assert.equal(s.mock.callsTo('eonet').length, 1);
    assert.equal(s.mock.callsTo('firms').length, 1);
  });

  test('FIRMS: confidence grading, radiative power and timestamp', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'firms' })).json();
    assert.deepEqual(d.events.map((e) => e.severity).sort(), ['green', 'orange', 'red']);
    const hot = d.events.find((e) => e.severity === 'red');
    assert.equal(hot.magnitude, 12.34);
    assert.equal(hot.time, '2026-10-21T09:30:00Z');
    assert.match(s.mock.callsTo('firms')[0].url, new RegExp(TEST_KEYS.FIRMS_MAP_KEY));
  });

  test('FIRMS rejecting the key becomes a per-source problem, not a failure', async () => {
    s.mock.on('firms.modaps', () => ({ __response: true, status: 200, body: 'Invalid MAP_KEY.', headers: {} }));
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'usgs,firms' })).json();
    assert.match(d.problems.firms, /FIRMS rejected the request/);
    assert.equal(d.bySource.usgs, 3);
  });

  test('RSOE EDIS: bearer key, defensive field mapping, javascript: URL dropped', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'edis' })).json();
    assert.equal(d.events[0].title, 'Industrial fire');
    assert.equal(d.events[0].severity, 'orange');
    assert.equal(d.events[0].url, null);
    assert.equal(s.mock.callsTo('edis.example')[0].headers.authorization, 'Bearer edis-key');
  });

  test('minSeverity filters', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'usgs,gdacs', minSeverity: 'red' })).json();
    assert.ok(d.events.every((e) => e.severity === 'red'));
    assert.equal(d.count, 2);
  });

  test('one failing source degrades only itself', async () => {
    s.mock.fail('www.gdacs.org', 500, 'down');
    const d = (await s.api('/api/events', { bbox: BBOX })).json();
    assert.match(d.problems.gdacs, /GDACS returned HTTP 500/);
    assert.ok(d.bySource.usgs > 0);
  });

  test('validation', async () => {
    assert.equal((await s.api('/api/events', { bbox: BBOX, sources: 'nope' })).status, 400);
    assert.equal((await s.api('/api/events', {})).status, 400);
  });

  test('without the optional keys, FIRMS and EDIS return nothing and are not called', async () => {
    const t = await startServer();
    try {
      const d = (await t.api('/api/events', { bbox: BBOX, sources: 'firms,edis' })).json();
      assert.equal(d.count, 0);
      assert.equal(d.firmsConfigured, false);
      assert.equal(t.mock.calls.length, 0);
    } finally { await t.close(); }
  });
});

describe('/api/webcams', () => {
  test('merges all four sources within the view', async () => {
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    assert.deepEqual(d.bySource, { windy: 2, nycdot: 1, openwebcamdb: 1, alertca: 2 });
    assert.deepEqual(d.problems, {});
    assert.equal(d.windyConfigured, true);
    assert.equal(d.owcdbConfigured, true);
  });

  test('Windy: key header, https player kept, http player and javascript: link dropped', async () => {
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    const ok = d.webcams.find((w) => w.id === 'windy:9001');
    const bad = d.webcams.find((w) => w.id === 'windy:9002');
    assert.match(ok.embed, /^https:\/\/webcams\.windy\.com\//);
    assert.equal(bad.embed, null);
    assert.equal(bad.link, null);
    assert.equal(ok.place, 'Testville, Testland');
    assert.equal(s.mock.callsTo('api.windy.com')[0].headers['x-windy-api-key'], TEST_KEYS.WINDY_API_KEY);
    assert.equal(new URL(s.mock.callsTo('api.windy.com')[0].url).searchParams.get('bbox'), '35.05,-99.95,34.95,-100.05');
  });

  test('NYC DOT: filtered to the view, image URL synthesised when absent', async () => {
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    const cam = d.webcams.find((w) => w.source === 'nycdot');
    assert.equal(cam.id, 'nyc:nyc-home');
    assert.equal(cam.image, 'https://webcams.nyctmc.org/api/cameras/nyc-home/image');
    assert.equal(cam.status, 'active');
    const nyc = (await s.api('/api/webcams', { bbox: '40.7,-74.0,40.8,-73.9' })).json();
    assert.ok(nyc.webcams.some((w) => w.id === 'nyc:nyc-1'));
  });

  test('OpenWebcamDB: bearer key, pages until done, embed kept', async () => {
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    const cam = d.webcams.find((w) => w.source === 'openwebcamdb');
    assert.equal(cam.embed, 'https://openwebcamdb.com/embed/test-harbour');
    const calls = s.mock.callsTo('openwebcamdb.com');
    assert.equal(calls.length, 1, 'last_page: 1 stops pagination');
    assert.equal(calls[0].headers.authorization, `Bearer ${TEST_KEYS.OPENWEBCAMDB_API_KEY}`);
  });

  test('ALERTCalifornia: status, county and pan/tilt', async () => {
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    const peak = d.webcams.find((w) => w.id === 'alertca:TP1');
    assert.equal(peak.status, 'active');
    assert.equal(peak.place, 'Test County County, CA');
    assert.equal(peak.pan, 120.5);
    assert.equal(d.webcams.find((w) => w.id === 'alertca:OH1').status, 'offline');
  });

  test('a failing source is reported without hiding the rest', async () => {
    s.mock.fail('api.windy.com', 401, '{"message":"bad key"}');
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    assert.match(d.problems.windy, /bad key/);
    assert.ok(d.bySource.alertca > 0);
  });

  test('keyless sources still work without any keys', async () => {
    const t = await startServer();
    try {
      const d = (await t.api('/api/webcams', { bbox: BBOX })).json();
      assert.deepEqual(d.bySource, { windy: 0, nycdot: 1, openwebcamdb: 0, alertca: 2 });
      assert.equal(t.mock.callsTo('windy').length, 0);
    } finally { await t.close(); }
  });
});

describe('/api/youtube', () => {
  test('searches around the snapped cell for the last 72h and keeps geotagged videos', async () => {
    const d = (await s.api('/api/youtube', { bbox: BBOX })).json();
    assert.equal(d.configured, true);
    assert.equal(d.window, '72h');
    assert.deepEqual(d.videos.map((v) => v.id).sort(), ['yt:aaaaaaaaaa1', 'yt:cccccccccc3']);
    assert.equal(d.found, 3, 'the malformed id is never looked up');

    const searches = s.mock.callsTo('/youtube/v3/search');
    assert.equal(searches.length, 2, 'follows nextPageToken, stops when there is none');
    const q = new URL(searches[0].url).searchParams;
    assert.equal(q.get('type'), 'video');
    assert.equal(q.get('order'), 'date');
    assert.equal(q.get('location'), '35.00000,-100.00000', 'centre of the 0.5° cell box');
    assert.match(q.get('locationRadius'), /^\d+km$/);
    const ageH = (Date.now() - Date.parse(q.get('publishedAfter'))) / 3600e3;
    assert.ok(ageH > 71.9 && ageH < 72.1, `publishedAfter is 72h back (got ${ageH}h)`);
    assert.equal(q.get('key'), null, 'the key is not in the URL');
    assert.equal(searches[0].headers['x-goog-api-key'], TEST_KEYS.YOUTUBE_API_KEY);
    const lookups = s.mock.callsTo('/youtube/v3/videos');
    assert.equal(lookups.length, 1);
    assert.match(new URL(lookups[0].url).searchParams.get('part'), /recordingDetails/);
  });

  test('records: links built from the id, http thumbnails dropped', async () => {
    const d = (await s.api('/api/youtube', { bbox: BBOX })).json();
    const v = d.videos.find((x) => x.id === 'yt:aaaaaaaaaa1');
    assert.equal(v.link, 'https://www.youtube.com/watch?v=aaaaaaaaaa1');
    assert.equal(v.embed, 'https://www.youtube-nocookie.com/embed/aaaaaaaaaa1');
    assert.equal(v.thumb, 'https://i.ytimg.com/vi/aaaaaaaaaa1/mqdefault.jpg');
    assert.equal(v.channelLink, 'https://www.youtube.com/channel/UCtest');
    assert.equal(v.views, 1234);
    assert.equal(v.place, 'Testville');
    const live = d.videos.find((x) => x.id === 'yt:cccccccccc3');
    assert.equal(live.live, 'live');
    assert.equal(live.thumb, null);
  });

  test('a repeat view in the same cell is served from the cache, also after a restart of memory', async () => {
    await s.api('/api/youtube', { bbox: BBOX });
    await s.api('/api/youtube', { bbox: '34.96,-100.04,35.04,-99.96' });
    assert.equal(s.mock.callsTo('/youtube/v3/search').length, 2, 'one search (two pages), not two');
    s.mod.cache.clear();
    await s.api('/api/youtube', { bbox: BBOX });
    assert.equal(s.mock.callsTo('/youtube/v3/search').length, 2, 'served from disk');
  });

  test('retention defaults: kept 72 hours, sent to the browser', async () => {
    assert.equal(s.mod.RETAIN['youtube.videos'], 72 * 3600e3);
    assert.equal(s.mod.RETAIN['youtube.window'], 72 * 3600e3);
    assert.equal((await s.api('/api/config')).json().retention.youtube, 72 * 3600e3);
  });

  test('a quota refusal is reported', async () => {
    s.mock.fail('/youtube/v3/search', 403,
      '{"error":{"code":403,"message":"The request cannot be completed because you have exceeded your quota."}}');
    const r = await s.api('/api/youtube', { bbox: BBOX });
    assert.equal(r.status, 403);
    assert.match(r.text, /quota/);
  });

  test('without a key it returns nothing and calls nothing', async () => {
    const t = await startServer();
    try {
      const d = (await t.api('/api/youtube', { bbox: BBOX })).json();
      assert.equal(d.configured, false);
      assert.equal(d.count, 0);
      assert.equal(t.mock.calls.length, 0);
      assert.match((await t.api('/api/health')).json().sources.youtube, /missing YOUTUBE_API_KEY/);
    } finally { await t.close(); }
  });
});

describe('/api/traffic', () => {
  test('cameras and incidents from each configured state, inside the view', async () => {
    const d = (await s.api('/api/traffic', { bbox: BBOX })).json();
    assert.deepEqual(d.configuredStates, ['GA']);
    assert.deepEqual(d.byState, { GA: { cameras: 1, incidents: 1 } });
    const cam = d.features.find((f) => f.kind === 'camera');
    assert.equal(cam.roadway, 'I-75');
    assert.equal(cam.image, 'https://511ga.org/map/Cctv/1');
    const inc = d.features.find((f) => f.kind === 'incident');
    assert.equal(inc.lanesAffected, '2 Right Lanes');
    assert.match(s.mock.callsTo('/api/v2/get/cameras')[0].url, /^https:\/\/511ga\.org\/.*key=test-511ga/);
  });

  test('a nearby view reuses the cached state answer', async () => {
    await s.api('/api/traffic', { bbox: BBOX });
    await s.api('/api/traffic', { bbox: '34.96,-100.04,35.04,-99.96' });
    assert.equal(s.mock.callsTo('/api/v2/get/cameras').length, 1);
  });

  test('a failing endpoint is a per-state problem', async () => {
    s.mock.fail('/api/v2/get/event', 503);
    const d = (await s.api('/api/traffic', { bbox: BBOX })).json();
    assert.match(d.problems.GA, /HTTP 503/);
    assert.equal(d.cameras, 1);
  });

  test('an unknown state is reported rather than crashing', async () => {
    const t = await startServer({ env: { FIVE_ELEVEN_KEYS: 'ZZ:key' } });
    try {
      const d = (await t.api('/api/traffic', { bbox: BBOX })).json();
      assert.match(d.problems.ZZ, /no known 511 host/);
    } finally { await t.close(); }
  });

  test('with no states configured, a hint listing the known hosts', async () => {
    const t = await startServer();
    try {
      const d = (await t.api('/api/traffic', { bbox: BBOX })).json();
      assert.equal(d.count, 0);
      assert.match(d.hint, /FIVE_ELEVEN_KEYS/);
      assert.match(d.hint, /GA, LA, AZ/);
      assert.ok(!d.hint.includes('KS2'));
    } finally { await t.close(); }
  });
});

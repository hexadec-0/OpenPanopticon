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

  test('cached=1 answers from what is held and never asks Overpass', async () => {
    await s.api('/api/overpass', { bbox: BBOX, presets: 'power' });
    s.mod.cache.clear();   // as after a restart: only the disk copy is left
    const before = s.mock.callsTo('overpass').length;
    const d = (await s.api('/api/overpass', { bbox: WIDE, presets: 'power', cached: '1' })).json();
    assert.equal(s.mock.callsTo('overpass').length, before, 'no query, no status probe');
    assert.equal(d.partial, true);
    assert.ok(d.count > 0, 'the cells on disk are in the answer');
    assert.ok(d.missing > 0);
    assert.equal(d.covered, null);
    const none = (await s.api('/api/overpass', { bbox: '40.1,-90.1,40.2,-90', presets: 'power', cached: '1' })).json();
    assert.equal(none.count, 0, 'nothing held is an empty answer, not an error');
    assert.equal(s.mock.callsTo('overpass').length, before);
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

  test('defaults to the keyless official sources', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX })).json();
    // MeteoAlarm is asked too, but has no countries over the US to answer for.
    assert.deepEqual(Object.keys(d.bySource).sort(), ['acled', 'cems', 'emsc', 'eonet', 'gdacs', 'nws', 'odin', 'tfr', 'usgs']);
  });

  test('EMSC: a quake USGS also reported is drawn once, the other kept', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'usgs,emsc' })).json();
    assert.equal(d.bySource.usgs, 3);
    assert.equal(d.bySource.emsc, 1);
    const e = d.events.find((x) => x.source === 'emsc');
    assert.equal(e.id, 'emsc:20261121_0000002');
    assert.equal(e.severity, 'orange');
    assert.match(e.title, /^MB 5\.1 — TEST REGION$/);
    assert.match(e.url, /^https:\/\/www\.seismicportal\.eu\/eventdetails\.html\?unid=/);
    const alone = (await s.api('/api/events', { bbox: BBOX, sources: 'emsc' })).json();
    assert.equal(alone.bySource.emsc, 2, 'without USGS both are kept');
  });

  test('FAA TFRs: boundary polygons joined to the list, duplicates and far ones dropped', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'tfr' })).json();
    assert.equal(d.count, 1);
    const t = d.events[0];
    assert.equal(t.severity, 'red', 'VIP');
    assert.equal(t.severityLabel, 'NOTAM 6/1234');
    assert.equal(t.description, 'Testville, TX — VIP movement');
    assert.equal(t.polygon.length, 5);
    assert.equal(t.magnitudeText, '0 to 17999 FT');
    assert.equal(t.url, 'https://tfr.faa.gov/tfr3/?page=detail_6_1234');
  });

  test('FAA TFRs: shapes still draw when the list is down', async () => {
    s.mock.fail('/tfrapi/', 500);
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'tfr' })).json();
    assert.equal(d.count, 1);
    assert.equal(d.events[0].description, null);
  });

  test('MeteoAlarm: polygons drawn, shapeless warnings grouped, expired ones left out', async () => {
    const d = (await s.api('/api/events', { bbox: '50,8,50.6,8.6', sources: 'meteoalarm' })).json();
    assert.deepEqual(d.problems, {});
    const drawn = d.events.filter((e) => e.polygon);
    assert.equal(drawn.length, 1);
    assert.equal(drawn[0].title, 'Orange wind warning', 'the English info block');
    assert.equal(drawn[0].severity, 'orange');
    assert.deepEqual(drawn[0].polygon[0], [8.2, 50.2], 'CAP lat,lon turned to lon,lat');
    // Germany's centroid is outside this box, so the grouped marker is not here...
    assert.equal(d.events.filter((e) => e.approximate).length, 0);
    // ...but is in a view over the whole country.
    const wide = (await s.api('/api/events', { bbox: '47,5,55,15', sources: 'meteoalarm' })).json();
    const grouped = wide.events.find((e) => e.approximate);
    assert.match(grouped.title, /^1 weather warning in Germany$/);
    assert.match(grouped.description, /Snow: Bergland/);
    assert.ok(s.mock.callsTo('feeds-germany').length >= 1);
    assert.equal(s.mock.callsTo('feeds-spain').length, 0, 'only countries in view are asked');
  });

  test('MeteoAlarm is not asked over the US', async () => {
    await s.api('/api/events', { bbox: BBOX, sources: 'meteoalarm' });
    assert.equal(s.mock.callsTo('meteoalarm').length, 0);
  });

  test('Copernicus EMS: live activation with its mapped extent, old closed one dropped', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'cems' })).json();
    assert.equal(d.count, 1);
    const c = d.events[0];
    assert.equal(c.id, 'cems:EMSR900');
    assert.equal(c.severity, 'orange');
    assert.equal(c.kind, 'Copernicus EMS · Flood');
    assert.equal(c.country, 'Testland');
    assert.equal(c.polygon.length, 5);
    assert.equal(s.mock.callsTo('public-activations/?code=EMSR900').length, 1);
  });

  test('ODIN: county outages with their boundaries, graded by the share out', async () => {
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'odin' })).json();
    assert.deepEqual(d.problems, {});
    assert.equal(d.count, 1, 'counties with no one or a single customer out, and the one with no shape, are left out');
    const o = d.events[0];
    assert.equal(o.id, 'odin:99001');
    assert.equal(o.title, '400 customers without power — Testco County, Test State');
    assert.equal(o.severity, 'orange');
    assert.equal(o.severityLabel, '4.0% of 10,000 customers out');
    assert.equal(o.polygon.length, 5);
    assert.equal(o.description, 'Reported by TEST ELECTRIC COOP.');
    const q = new URL(s.mock.callsTo('/odi/map')[0].url).searchParams;
    assert.equal(q.get('scale'), 'COUNTY');
    assert.deepEqual(['minx', 'miny', 'maxx', 'maxy'].map((k) => q.get(k)), ['-101', '34', '-99', '36']);
  });

  test('ACLED: logs in once, asks the cell for the last 30 days, grades by fatalities', async () => {
    s.mod.CREDENTIAL_RESETS.acled();   // a token left by an earlier test would skip the login
    const d = (await s.api('/api/events', { bbox: BBOX, sources: 'acled' })).json();
    assert.deepEqual(d.problems, {});
    assert.equal(d.count, 2);
    const clash = d.events.find((e) => e.id === 'acled:TST1001');
    assert.equal(clash.severity, 'red');
    assert.equal(clash.severityLabel, '12 reported fatalities');
    assert.equal(clash.magnitudeText, 'Test Militia vs Test Army');
    const protest = d.events.find((e) => e.id === 'acled:TST1002');
    assert.equal(protest.severity, 'green');
    assert.match(protest.description, /approximate \(ACLED geo-precision 2\)/);
    const tok = s.mock.callsTo('/oauth/token');
    assert.equal(tok.length, 1);
    const form = new URLSearchParams(tok[0].body);
    assert.deepEqual([form.get('grant_type'), form.get('client_id'), form.get('scope')], ['password', 'acled', 'authenticated']);
    const read = s.mock.callsTo('/api/acled/read')[0];
    assert.equal(read.headers.authorization, 'Bearer acled-test-token');
    const q = new URL(read.url).searchParams;
    assert.equal(q.get('latitude'), '34|36');
    assert.equal(q.get('latitude_where'), 'BETWEEN');
    assert.equal(q.get('event_date_where'), 'BETWEEN');
    // A second cell reuses the token.
    await s.api('/api/events', { bbox: '40,-80,40.1,-79.9', sources: 'acled' });
    assert.equal(s.mock.callsTo('/oauth/token').length, 1);
  });

  test('ACLED: never written to the disk cache', async () => {
    await s.api('/api/events', { bbox: BBOX, sources: 'acled' });
    const fs = require('node:fs');
    const files = fs.existsSync(s.mod.DISK_CACHE_DIR) ? fs.readdirSync(s.mod.DISK_CACHE_DIR) : [];
    for (const f of files) assert.doesNotMatch(fs.readFileSync(`${s.mod.DISK_CACHE_DIR}/${f}`, 'utf8'), /TST100/);
  });

  test('ACLED: wrong login is a problem for ACLED alone; no login means it is not asked', async () => {
    const bad = await startServer({ env: { ACLED_EMAIL: 'analyst@example.org', ACLED_PASSWORD: 'wrong' } });
    try {
      const d = (await bad.api('/api/events', { bbox: BBOX, sources: 'acled,usgs' })).json();
      assert.match(d.problems.acled, /ACLED auth/);
      assert.equal(d.bySource.usgs, 3);
    } finally { await bad.close(); }
    const none = await startServer();
    try {
      const d = (await none.api('/api/events', { bbox: BBOX, sources: 'acled' })).json();
      assert.deepEqual(d.bySource, {});
      assert.equal(none.mock.callsTo('acleddata.com').length, 0);
      const h = (await none.api('/api/health')).json();
      assert.equal(h.presets.events.acled.available, false);
    } finally { await none.close(); }
  });

  test('health lists the new sources with their defaults', async () => {
    const h = (await s.api('/api/health')).json();
    for (const k of ['emsc', 'tfr', 'meteoalarm', 'cems', 'odin', 'acled']) {
      assert.ok(h.presets.events[k], k);
      assert.equal(h.presets.events[k].available, true);
    }
    assert.equal(h.presets.events.tfr.default, true);
    assert.match(h.sources.adsb, /^adsb\.lol/);
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
  test('merges every source within the view', async () => {
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    assert.deepEqual(d.bySource, { windy: 2, nycdot: 1, openwebcamdb: 1, alertca: 2, ytlive: 3, caltrans: 0, tfl: 0, digitraffic: 0, drivebc: 0, agency: 5 });
    assert.equal(s.mock.callsTo('dot.ca.gov').length + s.mock.callsTo('tfl.gov.uk').length + s.mock.callsTo('digitraffic').length + s.mock.callsTo('drivebc').length, 0,
      'agencies are asked only over their own area');
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
    // The snapped half-degree cell, not the raw view.
    const u = new URL(s.mock.callsTo('api.windy.com')[0].url).searchParams;
    assert.equal(u.get('bbox'), '35.5,-99.5,34.5,-100.5');
    assert.equal(u.get('offset'), '0');
    assert.match(u.get('include'), /categories/);
  });

  test('Windy: pages past 50 to the end of a dense cell, and holds the answer', async () => {
    const cam = (i) => ({ webcamId: 7000 + i, title: `Cam ${i}`, status: 'active',
      location: { latitude: 35 + (i % 50) / 1000, longitude: -100 + Math.floor(i / 50) / 1000 },
      player: { day: `https://webcams.windy.com/webcams/public/embed/player/${7000 + i}/day` } });
    const all = Array.from({ length: 120 }, (_, i) => cam(i));
    s.mock.on('api.windy.com', ({ params }) => {
      const off = Number(params.get('offset'));
      return json({ total: all.length, webcams: all.slice(off, off + Number(params.get('limit'))) });
    });
    const d = (await s.api('/api/webcams', { bbox: '34.99,-100.01,35.2,-99.8' })).json();
    assert.equal(d.bySource.windy, 120);
    assert.deepEqual(d.truncated, []);
    assert.deepEqual(s.mock.callsTo('api.windy.com').map((c) => new URL(c.url).searchParams.get('offset')), ['0', '50', '100']);
    await s.api('/api/webcams', { bbox: '34.99,-100.01,35.2,-99.8' });
    assert.equal(s.mock.callsTo('api.windy.com').length, 3, 'the cell is held, not paged again');
  });

  test('Windy: a cell too dense to page is split into quarters', async () => {
    s.mock.on('api.windy.com', ({ params }) => {
      const [n, e, so, w] = params.get('bbox').split(',').map(Number);
      // The whole cell claims 5,000; each quarter holds one camera.
      const whole = n - so > 0.6;
      return json({ total: whole ? 5000 : 1, webcams: whole ? [] : [{ webcamId: `${so},${w}`, title: 'Q',
        location: { latitude: (n + so) / 2, longitude: (e + w) / 2 } }] });
    });
    const d = (await s.api('/api/webcams', { bbox: '34.6,-100.4,35.4,-99.6' })).json();
    assert.equal(d.bySource.windy, 4);
    assert.equal(s.mock.callsTo('api.windy.com').length, 5);
  });

  test('Windy: stops at the call budget and says the answer is partial', async () => {
    s.mock.on('api.windy.com', ({ params }) => {
      const off = Number(params.get('offset'));
      return json({ total: 999, webcams: Array.from({ length: 50 }, (_, i) => ({ webcamId: off + i, title: 'x',
        location: { latitude: 35, longitude: -100 } })) });
    });
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    assert.equal(d.bySource.windy, 999 - 999 + 50 * 20, 'twenty full pages, then the total stops it');
    assert.deepEqual(d.truncated, []);
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
      assert.deepEqual(d.bySource, { windy: 0, nycdot: 1, openwebcamdb: 0, alertca: 2, ytlive: 0, caltrans: 0, tfl: 0, digitraffic: 0, drivebc: 0, agency: 5 });
      assert.equal(t.mock.callsTo('googleapis.com').length, 0);
      assert.equal(t.mock.callsTo('windy').length, 0);
    } finally { await t.close(); }
  });
});

describe('/api/webcams: transport-agency cameras', () => {
  const cams = async (bbox, source) => (await s.api('/api/webcams', { bbox })).json().webcams.filter((c) => c.source === source);

  test('Caltrans: every district file, cameras in view with an https still', async () => {
    const c = await cams('34.0,-118.3,34.2,-118.1', 'caltrans');
    assert.deepEqual(c.map((x) => x.id).sort(), ['caltrans:7:1', 'caltrans:7:3']);
    const a = c.find((x) => x.id === 'caltrans:7:1');
    assert.equal(a.image, 'https://cwwp2.dot.ca.gov/data/d7/cctv/image/i110196/i110196.jpg');
    assert.equal(a.hls, 'https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8', 'its live stream');
    assert.equal(c.find((x) => x.id === 'caltrans:7:3').hls, null);
    assert.equal(a.place, 'Cypress Park, Los Angeles County, CA');
    assert.equal(a.category, 'I-110, facing south');
    assert.equal(c.find((x) => x.id === 'caltrans:7:3').status, 'out of service');
    const files = s.mock.callsTo('cwwp2.dot.ca.gov').map((x) => new URL(x.url).pathname);
    assert.equal(files.length, 12);
    assert.ok(files.includes('/data/d7/cctv/cctvStatusD07.json') && files.includes('/data/d12/cctv/cctvStatusD12.json'));
  });

  test('TfL: JamCam stills, an unsafe image dropped', async () => {
    const c = await cams('51.5,-0.2,51.7,0.1', 'tfl');
    assert.equal(c.length, 1);
    assert.equal(c[0].title, 'A406 Billet Upass E');
    assert.equal(c[0].category, 'Traffic, facing west');
  });

  test('Digitraffic: one camera per collected view, asked with a user header', async () => {
    const c = await cams('59.9,23.8,60.2,24.2', 'digitraffic');
    assert.deepEqual(c.map((x) => x.image), ['https://weathercam.digitraffic.fi/C0150301.jpg', 'https://weathercam.digitraffic.fi/C0150302.jpg']);
    assert.equal(c[0].title, 'kt51 Inkoo (view 1)');
  });

  test('DriveBC: cameras that should appear, with their caption', async () => {
    const c = await cams('49.6,-125.1,49.8,-124.9', 'drivebc');
    assert.equal(c.length, 1);
    assert.equal(c[0].image, 'https://www.drivebc.ca/images/1033.jpg');
    assert.equal(c[0].link, 'https://www.drivebc.ca/cameras/1033');
    assert.match(c[0].description, /looking northbound/);
    assert.equal(c[0].category, 'Hwy 19A, facing N');
  });

  test('one agency failing is a problem for that agency only', async () => {
    s.mock.fail('api.tfl.gov.uk', 503);
    const d = (await s.api('/api/webcams', { bbox: '51.5,-0.2,51.7,0.1' })).json();
    assert.match(d.problems.tfl, /503/);
    assert.equal(d.bySource.caltrans, 0);
  });
});

describe('/api/webcams: OSIRIS catalogue', () => {
  const WIDE = '34.9,-100.1,35.2,-99.9';
  const agency = async (bbox = WIDE) => (await s.api('/api/webcams', { bbox })).json().webcams.filter((c) => c.source === 'agency');

  test('cameras the browser can load straight from their operator', async () => {
    const c = await agency();
    const by = Object.fromEntries(c.map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(by).sort(),
      ['osiris:hls-1', 'osiris:mjpeg-1', 'osiris:relay-ok', 'osiris:still-1', 'osiris:tx-1', 'osiris:yt-1']);
    // A YouTube embed becomes the click-to-play no-cookie player, never a bare iframe.
    const yt = by['osiris:yt-1'];
    assert.equal(yt.embed, null);
    assert.equal(yt.youtubeEmbed, 'https://www.youtube-nocookie.com/embed/AbCdEfGhIj0');
    assert.equal(yt.link, 'https://www.youtube.com/watch?v=AbCdEfGhIj0');
    assert.equal(by['osiris:still-1'].image, 'https://cams.example.gov/still/1.jpg');
    assert.equal(by['osiris:still-1'].link, 'https://cams.example.gov/');
    assert.equal(by['osiris:still-1'].category, 'Example DOT');
    // Relayed only for convenience: the original address, not OSIRIS's relay.
    assert.equal(by['osiris:relay-ok'].image, 'https://open.example.org/c.jpg');
    // With no page of its own, a camera links its operator's site.
    assert.equal(by['osiris:relay-ok'].link, 'https://open.example.org/');
    assert.equal(by['osiris:tx-1'].link, 'https://its.txdot.gov/');
    assert.equal(by['osiris:mjpeg-1'].mjpeg, 'https://mjpeg.example.net/video.mjpg');
    assert.equal(by['osiris:mjpeg-1'].image, null);
    assert.equal(by['osiris:hls-1'].hls, 'https://hls.example.net/live.m3u8');
    assert.equal(by['osiris:hls-1'].link, 'https://hls.example.net/', 'the operator; the panel links the stream itself as the feed');
    assert.equal(by['osiris:tx-1'].image, '/cams/frame?district=AUS&id=I35+Test&kind=texas');
  });

  test('left out: hotlink-protected hosts, plain-http players, bad schemes, cameras drawn elsewhere, outside the view', async () => {
    const ids = (await agency()).map((x) => x.id);
    for (const gone of ['relay-referer', 'iframe-http', 'js', 'tfl-dup', 'far']) assert.ok(!ids.includes(`osiris:${gone}`), gone);
  });

  test('the catalogue is asked once per region, then held', async () => {
    await agency();
    await agency();
    assert.equal(s.mock.callsTo('osiris-fixture.example').length, 1);
  });

  test('no region under the view asks nothing', async () => {
    assert.deepEqual(await agency('10,10,10.2,10.2'), []);
    assert.equal(s.mock.callsTo('osiris-fixture.example').length, 0);
  });

  test('a failing region costs its own cameras only', async () => {
    s.mock.fail('osiris-fixture.example', 503);
    const d = (await s.api('/api/webcams', { bbox: WIDE })).json();
    assert.equal(d.bySource.agency, 0);
    assert.equal(d.bySource.nycdot, 1);
  });
});

describe('/cams/frame', () => {
  const frame = (q) => s.request(`/cams/frame?${new URLSearchParams(q)}`);

  test('Texas: the base64 snapshot as a JPEG', async () => {
    const r = await frame({ kind: 'texas', district: 'AUS', id: 'I35 Test' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.equal(r.buffer[0], 0xff);
    assert.equal(r.buffer[1], 0xd8);
  });

  test('Texas: an unknown district is refused before any request', async () => {
    const r = await frame({ kind: 'texas', district: 'ZZZ', id: 'x' });
    assert.equal(r.status, 400);
    assert.equal(s.mock.callsTo('its.txdot.gov').length, 0);
  });

  test('Texas: an empty snapshot is a 404, not a broken image', async () => {
    assert.equal((await frame({ kind: 'texas', district: 'AUS', id: 'other' })).status, 404);
  });

  test('Scotland: a JPEG for a known camera, a numeric id required', async () => {
    assert.equal((await frame({ kind: 'scotland', sid: '42' })).status, 200);
    assert.equal((await frame({ kind: 'scotland', sid: '7' })).status, 404);
    assert.equal((await frame({ kind: 'scotland', sid: '../x' })).status, 400);
  });

  test('Estonia: redirects to the current picture; Singapore\'s unsafe answer is not followed', async () => {
    const r = await frame({ kind: 'estonia', id: 'ee1' });
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, 'https://pilt.example.ee/cam/ee1-1700000000.jpg');
    assert.equal((await frame({ kind: 'singapore', id: '1001' })).status, 404);
  });

  test('anything else is refused', async () => {
    assert.equal((await frame({ kind: 'proxy', url: 'https://example.com/' })).status, 400);
  });
});

describe('/api/webcams: YouTube live cameras', () => {
  const yt = async (bbox = BBOX) => (await s.api('/api/webcams', { bbox })).json().webcams.filter((c) => c.source === 'ytlive');

  test('geotagged, or named beyond doubt; non-cameras refused', async () => {
    const cams = await yt();
    assert.deepEqual(cams.map((c) => c.videoId).sort(), ['ytcamGEO001', 'ytnamedcam5', 'ytsquare009']);
    const harbour = cams.find((c) => c.videoId === 'ytcamGEO001');
    assert.equal(harbour.placement, 'geotag');
    assert.equal(harbour.approximate, false);
    assert.equal(harbour.embed, null, 'no player until asked for');
    assert.equal(harbour.youtubeEmbed, 'https://www.youtube-nocookie.com/embed/ytcamGEO001');
    assert.equal(harbour.link, 'https://www.youtube.com/watch?v=ytcamGEO001');
    const square = cams.find((c) => c.videoId === 'ytsquare009');
    assert.equal(square.placement, 'named');
    assert.equal(square.approximate, true);
    assert.ok(Math.abs(square.lat - 35.004) < 1e-6, 'at the square, not the town centre');
  });

  test('a stream found by a town search that names somewhere else is not put in that town', async () => {
    const ids = (await yt()).map((c) => c.videoId);
    assert.ok(!ids.includes('ytaquarium7'), 'Monterey Bay Aquarium is not in Testville');
    assert.ok(!ids.includes('ytspring008'), 'Springfield is many places');
    // Looking at Monterey, the same stream is where it belongs.
    const mba = (await yt('36.5,-122.0,36.7,-121.8')).find((c) => c.videoId === 'ytaquarium7');
    assert.ok(mba && Math.abs(mba.lat - 36.6182) < 1e-6);
  });

  test('a listed channel\'s stream is placed where its title says, or not at all', async () => {
    const nc = await yt('35.7,-78.9,35.9,-78.6');
    const cary = nc.find((c) => c.videoId === 'YVXZk3-kzcI');
    assert.ok(cary, 'Downtown Cary Park is found by name');
    assert.equal(cary.channel, 'Cary, NC');
    assert.equal(cary.placement, 'named');
    assert.equal(cary.place, 'Downtown Cary Park, Cary, North Carolina');
    assert.ok(!nc.some((c) => c.videoId === 'D9nujG0PUTQ'), 'no geotag and no certain place: not drawn');
  });

  test('asks YouTube for live streams only: geo, place name, and each listed channel', async () => {
    await yt();
    const searches = s.mock.callsTo('/youtube/v3/search').map((c) => new URL(c.url).searchParams);
    assert.ok(searches.every((q) => q.get('eventType') === 'live' && q.get('type') === 'video'));
    assert.ok(searches.some((q) => q.get('location') === '35.00000,-100.00000' && q.get('locationRadius')));
    assert.ok(searches.some((q) => /^Testville live cam\|Testville webcam\|Testville live view$/.test(q.get('q') || '')));
    assert.deepEqual(searches.map((q) => q.get('channelId')).filter(Boolean).sort(), ['UCcaryncgovTESTchann0002', 'UCncsusatTESTchannel0001']);
    assert.deepEqual(s.mock.callsTo('/youtube/v3/channels').map((c) => new URL(c.url).searchParams.get('forHandle')).sort(), ['@caryncgovchannel', '@ncsu-sat']);
    for (const c of s.mock.callsTo('googleapis.com')) {
      assert.equal(c.headers['x-goog-api-key'], TEST_KEYS.YOUTUBE_API_KEY);
      assert.ok(!c.url.includes(TEST_KEYS.YOUTUBE_API_KEY), 'the key never in a URL');
    }
  });

  test('held a week; only "is it still live" is asked again, and an ended stream drops out', async () => {
    await yt();
    const searches = s.mock.callsTo('/youtube/v3/search').length;
    // The liveness check is cached for its half hour: clear only that.
    for (const k of [...s.mod.cache.keys()]) if (k.startsWith('ytlive:check:')) s.mod.cache.delete(k);
    s.mock.on('/youtube/v3/videos', ({ params }) => json({ items: String(params.get('id')).split(',').map((id) => ({
      id, snippet: { liveBroadcastContent: id === 'ytnamedcam5' ? 'none' : 'live' } })) }));
    const again = await yt();
    assert.equal(s.mock.callsTo('/youtube/v3/search').length, searches, 'no new searches');
    assert.ok(!again.some((c) => c.videoId === 'ytnamedcam5'));
    assert.equal(again.length, 2);
    assert.equal(s.mod.RETAIN['cameras.youtube_live'], 7 * 86400e3);
    assert.equal(s.mod.RETAIN['cameras.youtube_live_check'], 30 * 60e3);
  });

  test('a camera shown here is left out of the YouTube geotags layer', async () => {
    await yt();
    s.mod.ytLiveShown.add('cccccccccc3');
    const d = (await s.api('/api/youtube', { bbox: BBOX })).json();
    assert.ok(!d.videos.some((v) => v.videoId === 'cccccccccc3'));
    s.mod.ytLiveShown.delete('cccccccccc3');
  });

  test('a YouTube failure is a problem for this source only', async () => {
    s.mock.fail('/youtube/v3/search', 403, '{"error":{"message":"quotaExceeded"}}');
    const d = (await s.api('/api/webcams', { bbox: BBOX })).json();
    assert.match(d.problems.ytlive, /403|quota/);
    assert.ok(d.bySource.windy > 0);
  });

  test('YOUTUBE_CAM_CHANNELS replaces the listed channels; malformed entries ignored', async () => {
    const t = await startServer({ env: { YOUTUBE_API_KEY: TEST_KEYS.YOUTUBE_API_KEY, YOUTUBE_CAM_CHANNELS: '@ncsu-sat, not a channel ,UCbad' } });
    try {
      t.mod.nominatimGate.gapMs = 0;
      await t.api('/api/webcams', { bbox: BBOX });
      assert.deepEqual(t.mod.CFG.ytCamChannels, ['@ncsu-sat']);
      assert.deepEqual(t.mock.callsTo('/youtube/v3/channels').map((c) => new URL(c.url).searchParams.get('forHandle')), ['@ncsu-sat']);
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

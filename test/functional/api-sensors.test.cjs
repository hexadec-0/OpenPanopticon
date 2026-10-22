// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers/harness.cjs');
const { TEST_KEYS } = require('../helpers/fixtures.cjs');
const { json } = require('../helpers/responses.cjs');
const { FakeWebSocket, positionReport, staticData } = require('../helpers/fake-websocket.cjs');

const BBOX = '34.95,-100.05,35.05,-99.95';

let s;
before(async () => { s = await startServer({ env: TEST_KEYS }); });
after(() => s.close());
beforeEach(async () => { s.mock.reset(); s.mod.cache.clear(); await s.mod.clearDiskCache(); });

describe('/api/netinfra', () => {
  test('probes, cells, WiFi and Tor in one call', async () => {
    const d = (await s.api('/api/netinfra', { bbox: BBOX, sources: 'atlas,cell,wigle,tor' })).json();
    assert.deepEqual(d.bySource, { atlas: 1, cell: 1, wigle: 2, tor: 2 });
    assert.deepEqual(d.problems, {});
    for (const k of ['atlas', 'cell', 'wigle', 'tor']) assert.equal(d.sources[k].available, true, k);
  });

  test('RIPE Atlas: GeoJSON coordinates, ASN, tags; queried over the snapped cell', async () => {
    const d = (await s.api('/api/netinfra', { bbox: BBOX, sources: 'atlas' })).json();
    const p = d.nodes[0];
    assert.equal(p.id, 'atlas:6001');
    assert.equal(p.asn, 64500);
    assert.deepEqual(p.tags, ['home', 'nat']);
    assert.equal(p.detail['First connected'], '2020-09-13');
    const u = new URL(s.mock.callsTo('atlas.ripe.net')[0].url);
    assert.equal(u.searchParams.get('latitude__gte'), '34.5000');
    assert.equal(u.searchParams.get('status'), '1');
  });

  test('OpenCelliD: range and radio label, junk coordinates dropped, key on the request', async () => {
    const d = (await s.api('/api/netinfra', { bbox: BBOX, sources: 'cell' })).json();
    assert.equal(d.nodes.length, 1);
    assert.equal(d.nodes[0].radius, 1500);
    assert.equal(d.nodes[0].title, '4G LTE 12345');
    assert.equal(new URL(s.mock.callsTo('opencellid')[0].url).searchParams.get('key'), TEST_KEYS.OPENCELLID_API_KEY);
  });

  test('OpenCelliD reporting an error in its payload becomes a problem', async () => {
    s.mock.on('opencellid.org', () => json({ error: 'API key invalid' }));
    const d = (await s.api('/api/netinfra', { bbox: BBOX, sources: 'cell,atlas' })).json();
    assert.match(d.problems.cell, /OpenCelliD: API key invalid/);
    assert.equal(d.bySource.atlas, 1);
  });

  test('WiGLE: basic auth from name and token; hidden SSIDs labelled', async () => {
    const d = (await s.api('/api/netinfra', { bbox: BBOX, sources: 'wigle' })).json();
    assert.ok(d.nodes.some((n) => n.title === '(hidden SSID)'));
    const auth = s.mock.callsTo('wigle')[0].headers.authorization;
    assert.equal(auth, `Basic ${Buffer.from(`${TEST_KEYS.WIGLE_API_NAME}:${TEST_KEYS.WIGLE_API_TOKEN}`).toString('base64')}`);
  });

  test('WiGLE refusing (success:false) is reported as throttling', async () => {
    s.mock.on('api.wigle.net', () => json({ success: false, message: 'too many queries today' }));
    const d = (await s.api('/api/netinfra', { bbox: BBOX, sources: 'wigle' })).json();
    assert.match(d.problems.wigle, /too many queries today/);
  });

  test('Tor: aggregated by country at the centroid, not filtered by the view', async () => {
    const d = (await s.api('/api/netinfra', { bbox: '-1,-1,1,1', sources: 'tor' })).json();
    const us = d.nodes.find((n) => n.id === 'tor:US');
    assert.equal(us.aggregate, true);
    assert.equal(us.weight, 2);
    assert.equal(us.detail['Exit nodes'], '1');
    assert.equal(us.lat, 39.5);
    assert.ok(!d.nodes.some((n) => n.id === 'tor:ZZ'), 'no centroid, no marker');
    assert.equal(d.nodes[0].id, 'tor:US', 'busiest first');
  });

  test('without keys, cells and WiFi are unavailable and not called', async () => {
    const t = await startServer();
    try {
      const d = (await t.api('/api/netinfra', { bbox: BBOX, sources: 'cell,wigle' })).json();
      assert.equal(d.count, 0);
      assert.equal(d.sources.cell.available, false);
      assert.equal(d.sources.wigle.available, false);
      assert.equal(t.mock.calls.length, 0);
    } finally { await t.close(); }
  });

  test('validation', async () => {
    assert.equal((await s.api('/api/netinfra', { bbox: BBOX, sources: 'nope' })).status, 400);
    assert.equal((await s.api('/api/netinfra', {})).status, 400);
  });
});

describe('/api/iot', () => {
  test('keeps the newest reading per sensor and bands PM2.5', async () => {
    const d = (await s.api('/api/iot', { bbox: BBOX, indoor: '1' })).json();
    assert.equal(d.count, 3);
    const sds = d.sensors.find((x) => x.sensorId === 7001);
    assert.equal(sds.pm25, 12.5, 'newer reading wins over the older 99');
    assert.equal(sds.air.band, 'good');
    assert.equal(sds.exactLocation, true);
    assert.equal(sds.altitude, 300);
    const noise = d.sensors.find((x) => x.sensorId === 7002);
    assert.equal(noise.noise, 58.2);
    assert.deepEqual(noise.kinds, ['noise_LAeq'], 'non-numeric readings dropped');
    assert.equal(d.withAir, 2);
    assert.equal(d.withNoise, 1);
    assert.equal(d.labels.P2, 'PM2.5');
    assert.equal(d.units.noise_LAeq, 'dB(A)');
  });

  test('indoor sensors are excluded unless asked for', async () => {
    const d = (await s.api('/api/iot', { bbox: BBOX })).json();
    assert.equal(d.count, 2);
    assert.ok(d.sensors.every((x) => !x.indoor));
  });

  test('identifies itself and queries the snapped cell', async () => {
    await s.api('/api/iot', { bbox: BBOX });
    const c = s.mock.callsTo('sensor.community')[0];
    assert.match(c.url, /box=34\.7500,-100\.2500,35\.2500,-99\.7500$/);
    assert.match(c.headers['user-agent'], /^OpenPanopticon \(/);
  });

  test('an unexpected payload is a 502', async () => {
    s.mock.on('data.sensor.community', () => json({ not: 'an array' }));
    const r = await s.api('/api/iot', { bbox: BBOX });
    assert.equal(r.status, 502);
  });
});

describe('/api/vessels (AIS)', () => {
  test('opens the stream, subscribes to the view and serves what arrives', async () => {
    FakeWebSocket.reset();
    let d = (await s.api('/api/vessels', { bbox: BBOX })).json();
    assert.equal(d.stream.status, 'connecting');
    const ws = FakeWebSocket.last;
    ws.open();
    assert.equal(ws.sent[0].APIKey, TEST_KEYS.AISSTREAM_API_KEY);
    d = (await s.api('/api/vessels', { bbox: BBOX })).json();
    assert.equal(d.stream.warmingUp, true);

    ws.message(positionReport(366000001, { lat: 35.0, lon: -100.0, sog: 14 }));
    ws.message(staticData(366000001, { name: 'TEST CARGO', type: 70 }));
    ws.message(positionReport(366000002, { lat: 35.01, lon: -100.01, sog: 0, nav: 1 }));
    ws.message(positionReport(366000003, { lat: 10, lon: 10 }));   // outside the view

    d = (await s.api('/api/vessels', { bbox: BBOX })).json();
    assert.equal(d.count, 2);
    assert.equal(d.tracked, 3);
    assert.equal(d.stream.status, 'open');
    assert.equal(d.vessels[0].mmsi, '366000001', 'fastest first');
    assert.equal(d.vessels[0].name, 'TEST CARGO');
    assert.equal(d.vessels[0].length, 200);
    assert.equal(d.vessels[0].beam, 30);
    assert.equal(d.vessels[1].navStatus, 'At anchor');
    assert.deepEqual(d.byType, { Cargo: 1, Unidentified: 1 });
  });

  test('the API key goes to AISStream over the socket, never to the browser', async () => {
    const body = (await s.api('/api/vessels', { bbox: BBOX })).text;
    assert.ok(!body.includes(TEST_KEYS.AISSTREAM_API_KEY));
  });

  test('without a key: 412 and no socket', async () => {
    const t = await startServer();
    try {
      FakeWebSocket.reset();
      const r = await t.api('/api/vessels', { bbox: BBOX });
      assert.equal(r.status, 412);
      assert.match(r.json().error, /AISSTREAM_API_KEY/);
      assert.equal(FakeWebSocket.instances.length, 0);
    } finally { await t.close(); }
  });
});

describe('/api/enrich', () => {
  test('a listed C2 server, flagged by GreyNoise as malicious', async () => {
    const d = (await s.api('/api/enrich', { ip: '203.0.113.66' })).json();
    assert.equal(d.ip, '203.0.113.66');
    assert.equal(d.onC2List, true);
    assert.equal(d.botnetC2.malware, 'QakBot');
    assert.equal(d.botnetC2.port, 443);
    assert.equal(d.greynoise.classification, 'malicious');
    assert.equal(d.censys, undefined, 'Censys was removed');
  });

  test('a clean host', async () => {
    const d = (await s.api('/api/enrich', { ip: '192.0.2.44' })).json();
    assert.equal(d.onC2List, false);
    assert.equal(d.botnetC2, null);
    assert.equal(d.greynoise.seen, false);
  });

  test('IPv6 is accepted', async () => {
    assert.equal((await s.api('/api/enrich', { ip: '2001:db8::1' })).status, 200);
  });

  for (const ip of ['abc', '', '999.1.1.1', '1.2.3', '1.2.3.4.5', '::g', '1.2.3.4; rm -rf /', ' ']) {
    test(`rejects ${JSON.stringify(ip)}`, async () => {
      const r = await s.api('/api/enrich', { ip });
      assert.equal(r.status, 400);
      assert.match(r.json().error, /valid IP/);
    });
  }

  test('the C2 check survives a restart (list read back from disk)', async () => {
    await s.api('/api/enrich', { ip: '203.0.113.66' });
    const t = await startServer({ env: TEST_KEYS });
    try {
      // Point the new server at the old one's disk cache and cut the network.
      const fs = require('node:fs');
      const path = require('node:path');
      fs.mkdirSync(t.mod.DISK_CACHE_DIR, { recursive: true });
      for (const f of fs.readdirSync(s.mod.DISK_CACHE_DIR)) {
        fs.copyFileSync(path.join(s.mod.DISK_CACHE_DIR, f), path.join(t.mod.DISK_CACHE_DIR, f));
      }
      t.mock.unreachable('feodotracker.abuse.ch');
      const d = (await t.api('/api/enrich', { ip: '203.0.113.66' })).json();
      assert.equal(d.onC2List, true, 'was "not on the list" after a restart before the fix');
      assert.equal(t.mock.callsTo('feodotracker').length, 0);
    } finally { await t.close(); }
  });

  test('if the C2 list is unreachable, the GreyNoise half still answers', async () => {
    s.mock.unreachable('feodotracker.abuse.ch');
    const d = (await s.api('/api/enrich', { ip: '203.0.113.66' })).json();
    assert.equal(d.onC2List, false);
    assert.equal(d.greynoise.classification, 'malicious');
  });
});

describe('/api/signals', () => {
  test('outages, grid demand, Cloudflare annotations and seismographs', async () => {
    const d = (await s.api('/api/signals', { bbox: BBOX })).json();
    assert.deepEqual(d.outages.map((o) => o.code), ['US', 'ZZ'], 'countries with events only, busiest first');
    assert.equal(d.outages[0].lat, 39.5);
    assert.equal(d.outages[1].lat, null, 'no centroid known');
    assert.deepEqual(d.grid.map((g) => [g.code, g.demandMW]), [['PJM', 90000], ['ERCO', 45000]]);
    assert.equal(d.cloudflare[0].eventType, 'OUTAGE');
    assert.equal(d.seismographs.length, 1);
    assert.equal(d.seismographs[0].id, 'shake:AM.R1234');
    assert.equal(d.seismographs[0].site, 'Test Site');
    assert.deepEqual(d.configured, { ioda: true, eia: true, cloudflare: true, seismographs: true });
    assert.deepEqual(d.problems, { ioda: null, eia: null, cloudflare: null, seismographs: null });
  });

  test('keys go on the upstream requests', async () => {
    await s.api('/api/signals', { bbox: BBOX });
    assert.equal(new URL(s.mock.callsTo('api.eia.gov')[0].url).searchParams.get('api_key'), TEST_KEYS.EIA_API_KEY);
    assert.equal(s.mock.callsTo('api.cloudflare.com')[0].headers.authorization, `Bearer ${TEST_KEYS.CLOUDFLARE_API_TOKEN}`);
  });

  test('each source fails on its own', async () => {
    s.mock.fail('api.ioda', 500);
    const d = (await s.api('/api/signals', { bbox: BBOX })).json();
    assert.deepEqual(d.outages, []);
    assert.match(d.problems.ioda, /IODA returned HTTP 500/);
    assert.ok(d.grid.length);
  });

  test('without a bbox, no seismographs; without keys, no grid or Cloudflare', async () => {
    const t = await startServer();
    try {
      const d = (await t.api('/api/signals')).json();
      assert.deepEqual(d.seismographs, []);
      assert.equal(d.grid, null);
      assert.equal(d.cloudflare, null);
      assert.equal(d.configured.eia, false);
      assert.equal(t.mock.callsTo('eia').length, 0);
    } finally { await t.close(); }
  });
});

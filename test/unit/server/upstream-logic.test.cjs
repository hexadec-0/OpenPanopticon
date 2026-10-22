// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadServer } = require('../../helpers/harness.cjs');
const { UpstreamMock } = require('../../helpers/upstream.cjs');
const { json, text, status } = require('../../helpers/responses.cjs');
const { FakeWebSocket, positionReport, staticData } = require('../../helpers/fake-websocket.cjs');
const { stationsTle, FEODO } = require('../../helpers/fixtures.cjs');

const mock = new UpstreamMock();
const { mod: S, restore, dataDir } = loadServer({ mock, env: { AISSTREAM_API_KEY: 'ais-key' } });
after(() => {
  clearTimeout(S.ais.reconnectTimer);
  restore();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
beforeEach(() => { mock.reset(); S.cache.clear(); });

describe('OpenSky credit budget', () => {
  beforeEach(() => Object.assign(S.openSky, { remaining: null, limit: null, checkedAt: 0, blockedUntil: 0 }));

  test('with no budget reading, poll at the feed resolution', () => {
    assert.equal(S.openSkyPollSec(5), 6);
    assert.equal(S.openSkyPollSec(10), 11);
  });

  test('spreads what is left over the time until the UTC refill', () => {
    S.openSky.remaining = S.OPENSKY_FLOOR + 10;
    const expected = Math.min(300, Math.max(6, Math.ceil(S.openSkyRefillSec() / 10)));
    assert.equal(S.openSkyPollSec(5), expected);
  });

  test('never polls faster than the feed publishes', () => {
    S.openSky.remaining = 1_000_000;
    assert.equal(S.openSkyPollSec(5), 6);
  });

  test('at or below the reserve, backs off to five minutes', () => {
    S.openSky.remaining = S.OPENSKY_FLOOR;
    assert.equal(S.openSkyPollSec(5), 300);
  });

  test('refill time is between one minute and one day', () => {
    const s = S.openSkyRefillSec();
    assert.ok(s >= 60 && s <= 86400);
  });

  test('noteOpenSkyHeaders records the remaining credits and the highest seen', () => {
    S.noteOpenSkyHeaders(new Headers({ 'x-rate-limit-remaining': '3000' }));
    S.noteOpenSkyHeaders(new Headers({ 'x-rate-limit-remaining': '2990' }));
    assert.equal(S.openSky.remaining, 2990);
    assert.equal(S.openSky.limit, 3000);
  });

  // Regression: Number(null) is 0, so a response without the header used to
  // record zero credits and block every automatic poll until a SYNC.
  test('a response without the header leaves the credit count alone', () => {
    S.noteOpenSkyHeaders(new Headers({ 'x-rate-limit-remaining': '2990' }));
    S.noteOpenSkyHeaders(new Headers({}));
    S.noteOpenSkyHeaders(new Headers({ 'x-rate-limit-remaining': '' }));
    S.noteOpenSkyHeaders(null);
    assert.equal(S.openSky.remaining, 2990);
  });

  test('a genuine zero is still recorded', () => {
    S.noteOpenSkyHeaders(new Headers({ 'x-rate-limit-remaining': '0' }));
    assert.equal(S.openSky.remaining, 0);
  });

  test('assertOpenSkyCredit refuses while rate-limited, with the wait', () => {
    S.openSky.blockedUntil = Date.now() + 30_000;
    assert.throws(() => S.assertOpenSkyCredit(), (e) => e.status === 429 && e.retryAfter <= 30 && /30s to go|29s to go/.test(e.message));
  });

  test('assertOpenSkyCredit holds the reserve for automatic polls, but not for SYNC', () => {
    S.openSky.remaining = S.OPENSKY_FLOOR - 1;
    assert.throws(() => S.assertOpenSkyCredit(), (e) => e.status === 429 && /nearly spent/.test(e.message));
    assert.doesNotThrow(() => S.reqCtx.run({ fresh: true }, () => S.assertOpenSkyCredit()));
  });
});

describe('AIS ingest', () => {
  beforeEach(() => S.ais.vessels.clear());

  test('a position report creates a vessel', () => {
    S.aisIngest(positionReport(123456789, { lat: 51.9, lon: 4.4, sog: 10, cog: 90, heading: 88, nav: 5 }));
    const v = S.ais.vessels.get('123456789');
    assert.equal(v.lat, 51.9);
    assert.equal(v.sog, 10);
    assert.equal(v.heading, 88);
    assert.equal(v.navStatus, 'Moored');
    assert.equal(v.classB, false);
    assert.ok(v.updated > 0);
  });

  test('static data and positions merge into one record', () => {
    S.aisIngest(positionReport(1, { lat: 1, lon: 2 }));
    S.aisIngest(staticData(1, { name: 'MV TEST', type: 84 }));
    const v = S.ais.vessels.get('1');
    assert.equal(v.name, 'MV TEST');
    assert.equal(v.shipTypeName, 'Tanker');
    assert.equal(v.lat, 1);
    assert.deepEqual(v.dimension, { A: 150, B: 50, C: 15, D: 15 });
  });

  test('heading 511 (not available) is dropped; class B is flagged', () => {
    S.aisIngest(positionReport(2, { lat: 1, lon: 2, heading: 511, classB: true }));
    const v = S.ais.vessels.get('2');
    assert.equal(v.heading, null);
    assert.equal(v.classB, true);
  });

  test('the metadata ship name fills in when static data has not arrived', () => {
    S.aisIngest(positionReport(3, { lat: 1, lon: 2, name: 'FROM META ' }));
    assert.equal(S.ais.vessels.get('3').name, 'FROM META');
  });

  test('ignores messages without an MMSI, without coordinates, or of other types', () => {
    S.aisIngest({ MessageType: 'PositionReport', MetaData: {}, Message: {} });
    S.aisIngest(positionReport(4, { lat: NaN, lon: 2 }));
    S.aisIngest({ MessageType: 'SafetyBroadcast', MetaData: { MMSI: 5 }, Message: {} });
    assert.equal(S.ais.vessels.size, 0);
  });

  test('bounding box order and movement threshold', () => {
    assert.deepEqual(S.aisBoxesFor({ south: 1, west: 2, north: 3, east: 4 }), [[[3, 2], [1, 4]]]);
    const a = { south: 0, west: 0, north: 1, east: 1 };
    assert.equal(S.boxMovedEnough(a, { ...a, north: 1.2 }), false);
    assert.equal(S.boxMovedEnough(a, { ...a, north: 1.3 }), true);
  });
});

describe('AIS websocket lifecycle', () => {
  test('connects, subscribes on open, ingests messages, and moves the subscription', () => {
    FakeWebSocket.reset();
    S.ais.socket = null;
    const box = { south: 51, west: 3, north: 52, east: 5 };
    S.aisConnect(box);
    const ws = FakeWebSocket.last;
    assert.equal(ws.url, 'wss://stream.aisstream.io/v0/stream');
    assert.equal(S.ais.status, 'connecting');

    ws.open();
    assert.equal(S.ais.status, 'open');
    assert.equal(ws.sent.length, 1);
    assert.equal(ws.sent[0].APIKey, 'ais-key');
    assert.deepEqual(ws.sent[0].BoundingBoxes, [[[52, 3], [51, 5]]]);
    assert.ok(ws.sent[0].FilterMessageTypes.includes('PositionReport'));

    ws.message(positionReport(777, { lat: 51.5, lon: 4 }));
    ws.message('not json');
    assert.ok(S.ais.vessels.has('777'));
    assert.ok(S.ais.messages >= 2);

    // A small nudge does not resubscribe; a real move does.
    S.aisConnect({ ...box, north: 52.1 });
    assert.equal(ws.sent.length, 1);
    S.aisConnect({ south: 40, west: -75, north: 41, east: -73 });
    assert.equal(ws.sent.length, 2);
  });

  test('an error is reported, and a close schedules a reconnect with backoff', () => {
    const ws = FakeWebSocket.last;
    ws.fail();
    assert.equal(S.ais.status, 'error');
    assert.match(S.ais.error, /AISSTREAM_API_KEY/);
    const before = S.ais.reconnectDelay;
    ws.serverClose();
    assert.equal(S.ais.status, 'closed');
    assert.equal(S.ais.socket, null);
    assert.ok(S.ais.reconnectTimer);
    assert.equal(S.ais.reconnectDelay, Math.min(before * 2, 60_000));
    clearTimeout(S.ais.reconnectTimer);
  });

  test('without a key it stays disabled and opens nothing', () => {
    const key = S.CFG.aisKey;
    S.CFG.aisKey = '';
    FakeWebSocket.reset();
    S.ais.socket = null;
    try {
      S.aisConnect({ south: 0, west: 0, north: 1, east: 1 });
      assert.equal(S.ais.status, 'disabled');
      assert.equal(FakeWebSocket.instances.length, 0);
    } finally { S.CFG.aisKey = key; }
  });

  test('a Node build without WebSocket reports why', () => {
    const ws = globalThis.WebSocket;
    globalThis.WebSocket = undefined;
    S.ais.socket = null;
    try {
      S.aisConnect({ south: 0, west: 0, north: 1, east: 1 });
      assert.equal(S.ais.status, 'error');
      assert.match(S.ais.error, /Node 22/);
    } finally { globalThis.WebSocket = ws; }
  });
});

describe('CelesTrak elements and their local copy', () => {
  beforeEach(() => fs.rmSync(S.TLE_DIR, { recursive: true, force: true }));

  test('a good download is returned fresh and saved to disk', async () => {
    const r = await S.fetchTle('stations');
    assert.equal(r.stale, false);
    assert.match(r.text, /ISS \(ZARYA\)/);
    assert.equal(fs.readFileSync(S.tleCachePath('stations'), 'utf8'), r.text);
  });

  test('a refusal falls back to the saved copy, marked stale', async () => {
    await S.fetchTle('stations');
    mock.fail('celestrak.org', 403, 'GP data has not updated since your last successful download of GROUP=stations at 2026-10-21 10:00:00 UTC.');
    const r = await S.fetchTle('stations');
    assert.equal(r.stale, true);
    assert.match(r.text, /ISS/);
    assert.ok(r.savedAt);
  });

  test('a "no data" answer falls back to the saved copy too', async () => {
    await S.fetchTle('stations');
    mock.on('celestrak.org', () => text('No GP data found'));
    const r = await S.fetchTle('stations');
    assert.equal(r.stale, true);
    assert.match(r.text, /ISS/);
  });

  test('with no copy, a "no data" answer is passed through for the caller to report', async () => {
    mock.on('celestrak.org', () => text('No GP data found'));
    const r = await S.fetchTle('stations');
    assert.equal(r.text, 'No GP data found');
    assert.equal(r.savedAt, null);
  });

  test('with no copy, a throttle refusal explains itself and says when to retry', async () => {
    const last = new Date(Date.now() - 30 * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    mock.fail('celestrak.org', 403, `GP data has not updated since your last successful download of GROUP=stations at ${last} UTC.`);
    await assert.rejects(S.fetchTle('stations'), (e) => {
      assert.equal(e.status, 503);
      assert.match(e.message, /two-hourly refresh/);
      assert.ok(e.retryAfter >= 85 * 60 && e.retryAfter <= 91 * 60, String(e.retryAfter));
      return true;
    });
  });

  test('with no copy, any other failure is passed on', async () => {
    mock.unreachable('celestrak.org');
    await assert.rejects(S.fetchTle('stations'), (e) => e.status === 504);
  });

  test('cache file names cannot escape the TLE folder', () => {
    const p = S.tleCachePath('../../etc/passwd');
    assert.ok(p.startsWith(S.TLE_DIR));
    assert.ok(!p.slice(S.TLE_DIR.length).includes('..' + require('node:path').sep));
  });

  test('the fixture itself parses into satellites', () => {
    assert.match(stationsTle(), /^ISS/);
  });
});

describe('the shared Overpass queue', () => {
  beforeEach(() => Object.assign(S.overpassGate, {
    chain: Promise.resolve(), lastStartedAt: 0, minGapMs: 0, cooldownUntil: 0, consecutive429: 0,
  }));

  test('moves to the next mirror when one is rate-limited', async () => {
    mock.once('overpass-api.de', () => status(429, 'Too Many Requests'));
    const out = await S.overpassQuery('[out:json];(node(1,2,3,4););out;');
    assert.ok(Array.isArray(out.elements));
    assert.deepEqual(mock.calls.map((c) => new URL(c.url).hostname), ['overpass-api.de', 'overpass.kumi.systems']);
    assert.equal(S.overpassGate.consecutive429, 0);
  });

  test('every mirror rate-limited: a 429 with a cooldown everyone waits out', async () => {
    for (const h of S.OVERPASS_ENDPOINTS) mock.fail(new URL(h).hostname, 429, 'rate limited');
    await assert.rejects(S.overpassQuery('q'), (e) => {
      assert.equal(e.status, 429);
      assert.ok(e.retryAfter >= 4);
      return true;
    });
    assert.ok(S.overpassGate.cooldownUntil > Date.now());
    assert.equal(S.overpassGate.consecutive429, 1);
  });

  test('mixed failures: a 502 that names every mirror', async () => {
    mock.fail('overpass-api.de', 500, '<title>500 Internal Server Error</title>');
    mock.unreachable('overpass.kumi.systems');
    mock.fail('overpass.private.coffee', 429, 'slow down');
    await assert.rejects(S.overpassQuery('q'), (e) => {
      assert.equal(e.status, 502);
      assert.match(e.message, /overpass-api\.de: HTTP 500/);
      assert.match(e.message, /overpass\.kumi\.systems: unreachable/);
      assert.match(e.message, /overpass\.private\.coffee: HTTP 429 rate-limited/);
      assert.ok(e.retryAfter >= 30);
      return true;
    });
  });

  test('requests run one at a time, spaced by the minimum gap', async () => {
    S.overpassGate.minGapMs = 60;
    const starts = [];
    mock.on('overpass-api.de', () => { starts.push(Date.now()); return json({ elements: [] }); });
    await Promise.all([S.overpassQuery('a'), S.overpassQuery('b'), S.overpassQuery('c')]);
    assert.equal(starts.length, 3);
    assert.ok(starts[1] - starts[0] >= 55, `gap ${starts[1] - starts[0]}`);
    assert.ok(starts[2] - starts[1] >= 55, `gap ${starts[2] - starts[1]}`);
  });

  test('a failure does not jam the queue for the next caller', async () => {
    for (const h of S.OVERPASS_ENDPOINTS) mock.once(new URL(h).hostname, () => status(500, 'x'));
    await assert.rejects(S.overpassQuery('first'));
    S.overpassGate.cooldownUntil = 0;
    const ok = await S.overpassQuery('second');
    assert.ok(Array.isArray(ok.elements));
  });
});

describe('Feodo C2 list', () => {
  test('is cached as plain rows and looked up through a Map', async () => {
    const m = await S.feodoSet();
    assert.ok(m instanceof Map);
    assert.equal(m.get('203.0.113.66').malware, 'QakBot');
    assert.equal(m.size, FEODO.filter((r) => r.ip_address).length);
  });

  test('still works when the list comes back from disk after a restart', async () => {
    await S.feodoSet();
    S.cache.clear();               // as a fresh process would have it
    mock.unreachable('feodotracker.abuse.ch');
    const m = await S.feodoSet();
    assert.equal(m.get('203.0.113.66')?.malware, 'QakBot');
  });

  test('uses the hazard TTL, not the three-day inventory one', async () => {
    S.cache.clear();
    await S.clearDiskCache();
    await S.feodoSet();
    const entry = S.cache.get('feodo:rows');
    const ttl = entry.expires - Date.now();
    assert.ok(ttl <= S.TTL.hazard && ttl > S.TTL.hazard - 5000, String(ttl));
  });
});

describe('GreyNoise lookups', () => {
  test('malicious, benign, unseen, rate-limited and failing', async () => {
    const bad = await S.greyNoiseLookup('203.0.113.66');
    assert.equal(bad.classification, 'malicious');
    assert.equal(bad.seen, true);

    const benign = await S.greyNoiseLookup('8.8.8.8');
    assert.equal(benign.riot, true);
    assert.equal(benign.link, null);     // its javascript: link was dropped

    assert.deepEqual(await S.greyNoiseLookup('192.0.2.200'), { seen: false, message: 'not observed by GreyNoise' });

    mock.fail('api.greynoise.io', 429, '{}');
    assert.match((await S.greyNoiseLookup('192.0.2.200')).error, /rate limit/);

    mock.unreachable('api.greynoise.io');
    assert.match((await S.greyNoiseLookup('192.0.2.200')).error, /unreachable/);
  });

  test('sends the key only when one is configured', async () => {
    await S.greyNoiseLookup('192.0.2.1');
    assert.equal(mock.callsTo('greynoise').at(-1).headers.key, undefined);
    S.CFG.greyNoiseKey = 'gn-key';
    try {
      await S.greyNoiseLookup('192.0.2.1');
      assert.equal(mock.callsTo('greynoise').at(-1).headers.key, 'gn-key');
    } finally { S.CFG.greyNoiseKey = ''; }
  });
});

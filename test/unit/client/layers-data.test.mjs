// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * Every layer class, loaded through the real server (in-process, with fake
 * upstreams) and drawn onto the Cesium stub: what gets drawn, what the
 * filters do without refetching, and what the detail panel says — including
 * that hostile upstream text and URLs come out inert.
 */
import { test, describe, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { installCesium, makeViewer } from '../../helpers/cesium-stub.mjs';
import { installDom, FakeElement } from '../../helpers/dom-stub.mjs';
import * as L from '../../../public/js/layers.js';

const require = createRequire(import.meta.url);
const { startServer } = require('../../helpers/harness.cjs');
const { TEST_KEYS, HOME } = require('../../helpers/fixtures.cjs');
const { json } = require('../../helpers/responses.cjs');

const BBOX = '34.97,-100.03,35.03,-99.97';
const XSS = '<img src=x onerror="window.__xss=1">';

let s;
let viewer;
before(async () => {
  s = await startServer({ env: { ...TEST_KEYS, EDIS_API_URL: 'https://edis.example/api' } });
  globalThis.satellite = require('../../../public/providers/satellite.min.js');
});
after(() => s.close());
beforeEach(async () => {
  installCesium();
  installDom({ origin: `${s.base}/` });
  viewer = makeViewer();
  s.mock.reset();
  s.mod.cache.clear();
  await s.mod.clearDiskCache();
  // Each test starts with a fresh OpenSky budget.
  Object.assign(s.mod.openSky, { remaining: null, limit: null, checkedAt: 0, blockedUntil: 0 });
});

const on = (layer) => { layer.setEnabled(true); return layer; };
const ents = (layer) => layer.source.entities.values;
const ctx = (bbox = BBOX) => ({ bbox, onStatus() {} });

/** No markup or script-capable URL from upstream data survives into HTML. */
function assertInert(html) {
  assert.ok(!/<img[^>]+onerror="window\.__xss/i.test(html), 'unescaped markup');
  assert.ok(!/(href|src)\s*=\s*["']?\s*javascript:/i.test(html), 'javascript: URL in an attribute');
}

describe('ShodanLayer', () => {
  test('draws a point per banner, coloured by category or by risk', async () => {
    const l = on(new L.ShodanLayer(viewer));
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.equal(l.count, 2);
    assert.equal(l.total, 3);
    assert.equal(l.vulnerable, 1);
    const colours = ents(l).map((e) => e.point.outlineColor.css).sort();
    assert.deepEqual(colours, ['#4cc9f0', '#ff2d55'], 'web blue, ICS red');
    assert.deepEqual(l.categoryLegend().map((c) => c.cat).sort(), ['ics', 'web']);
    l.colorBy = 'risk';
    l.redraw();
    assert.deepEqual(ents(l).map((e) => e.point.outlineColor.css).sort(), ['#00e5ff', '#ff2d55']);
    assert.equal(ents(l).find((e) => e.properties.record.value.vulns.length).point.pixelSize, 11);
  });

  test('co-located banners are spread out so each stays clickable', async () => {
    s.mock.on('/shodan/host/search', () => json({ total: 3, matches: [80, 443, 8080].map((port) => ({
      ip_str: '198.51.100.1', port, location: { latitude: HOME.lat, longitude: HOME.lon }, data: '' })) }));
    const l = on(new L.ShodanLayer(viewer));
    await l.refresh(ctx());
    const pos = ents(l).map((e) => `${e.position.value.lat},${e.position.value.lon}`);
    assert.equal(new Set(pos).size, 3);
  });

  test('detail: service, CVE links, banner, and a reputation slot', async () => {
    const l = on(new L.ShodanLayer(viewer));
    await l.refresh(ctx());
    const rec = l.records().find((r) => r.port === 443);
    const d = l.detail(rec);
    assert.equal(d.kind, 'SHODAN HOST');
    assert.equal(d.title, '198.51.100.10:443');
    assert.equal(d.accent, '#ff2d55');
    assert.match(d.html, /nginx 1\.18\.0/);
    assert.match(d.html, /2 known CVEs/);
    assert.match(d.html, /https:\/\/nvd\.nist\.gov\/vuln\/detail\/CVE-2021-44228/);
    assert.match(d.html, /data-slot="enrich"/);
    assert.match(d.html, /https:\/\/www\.shodan\.io\/host\/198\.51\.100\.10/);
    assertInert(d.html);
  });

  test('detail escapes a hostile banner, product and hostname', () => {
    const l = new L.ShodanLayer(viewer);
    const d = l.detail({ ip: '1.2.3.4', port: 80, transport: 'tcp', vulns: [`CVE-1"${XSS}`], hostnames: [XSS],
      tags: [], product: XSS, banner: `</pre>${XSS}`, category: 'web', city: XSS });
    assertInert(d.html);
    assert.match(d.html, /&lt;img src=x/);
  });

  test('enrich fills the slot with GreyNoise and C2 verdicts', async () => {
    const l = new L.ShodanLayer(viewer);
    const root = new FakeElement('div');
    await l.enrich({ ip: '203.0.113.66' }, root);
    const html = root.querySelector('[data-slot="enrich"]').innerHTML;
    assert.match(html, /Known malicious scanner/);
    assert.match(html, /Listed as active botnet C2 — QakBot/);
  });

  test('a stale enrich (operator clicked something else) writes nothing', async () => {
    const l = new L.ShodanLayer(viewer);
    const first = new FakeElement('div');
    const p1 = l.enrich({ ip: '203.0.113.66' }, first);
    const second = new FakeElement('div');
    const p2 = l.enrich({ ip: '192.0.2.5' }, second);
    await Promise.all([p1, p2]);
    assert.equal(first.querySelector('[data-slot="enrich"]').innerHTML, '');
    assert.match(second.querySelector('[data-slot="enrich"]').innerHTML, /Not observed scanning/);
  });
});

describe('enrichHost', () => {
  test('benign service, clean C2 list', async () => {
    const slot = new FakeElement('div');
    await L.enrichHost('8.8.8.8', slot);
    assert.match(slot.innerHTML, /Known benign service/);
    assert.match(slot.innerHTML, /Not on the abuse\.ch botnet C2 list/);
  });

  test('upstream errors are shown, escaped', async () => {
    s.mock.on('api.greynoise.io', () => { throw new TypeError(XSS); });
    const slot = new FakeElement('div');
    await L.enrichHost('192.0.2.1', () => slot);
    assert.match(slot.innerHTML, /GreyNoise: /);
    assertInert(slot.innerHTML);
  });

  test('the whole lookup failing is reported in the slot', async () => {
    const slot = new FakeElement('div');
    await L.enrichHost('not-an-ip', slot);
    assert.match(slot.innerHTML, /Enrichment unavailable: a valid IP address is required/);
  });
});

describe('FlightLayer', () => {
  test('one entity per aircraft, tinted by state, with labels and trails', async () => {
    const l = on(new L.FlightLayer(viewer));
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.equal(l.count, 3);
    assert.equal(l.dropped, 1);
    assert.equal(l.resolutionSec, 5);
    assert.ok(l.pollSec >= 6);
    assert.equal(l.credits, 3900);
    const byId = Object.fromEntries(ents(l).map((e) => [e.id, e]));
    assert.equal(byId.d4e5f6.label.fillColor.css, '#ff2d55', 'emergency is red');
    assert.match(byId.d4e5f6.label.text, /⚠ EMERGENCY/);
    assert.equal(byId.ffeedd.label.fillColor.css, '#8b949e', 'on the ground is grey');
    assert.match(byId.a1b2c3.label.text, /^TST123\n33100ft 447kt$/);
    assert.match(byId.ffeedd.label.text, /GND/);
    assert.ok(byId.a1b2c3.position instanceof Cesium.CallbackPositionProperty);
  });

  test('aircraft that drop out of the box are retired with their trails', async () => {
    const l = on(new L.FlightLayer(viewer));
    await l.refresh(ctx());
    s.mock.on('/api/states/all', () => json({ time: Math.floor(Date.now() / 1000), states: [] }));
    s.mod.cache.clear();
    await l.refresh(ctx(), { force: true });
    assert.equal(ents(l).length, 0);
    assert.equal(l.dr.size, 0);
    assert.equal(l.trails.size, 0);
  });

  test('dead reckoning carries a moving aircraft forward, and stops after 45s', async () => {
    const l = on(new L.FlightLayer(viewer));
    await l.refresh(ctx());
    const a = l.dr.get('a1b2c3');
    const t0 = a.atMs;
    const now = mock.method(Date, 'now', () => t0);
    try {
      const p0 = l.deadReckon('a1b2c3');
      now.mock.mockImplementation(() => t0 + 10_000);
      const p10 = l.deadReckon('a1b2c3');
      // Heading 90 at 230 m/s: about 2.3 km east in 10 s.
      const moved = Cesium.Cartesian3.distance(p0, p10);
      assert.ok(moved > 2200 && moved < 2400, String(moved));
      assert.ok(p10.lon > p0.lon);
      now.mock.mockImplementation(() => t0 + 60_000);
      const p60 = l.deadReckon('a1b2c3');
      now.mock.mockImplementation(() => t0 + 600_000);
      assert.deepEqual(l.deadReckon('a1b2c3'), p60, 'extrapolation capped');
    } finally { now.mock.restore(); }
  });

  test('a parked aircraft is not extrapolated', async () => {
    const l = on(new L.FlightLayer(viewer));
    await l.refresh(ctx());
    assert.equal(l.dr.get('ffeedd').move, false);
    assert.equal(l.deadReckon('ffeedd'), l.dr.get('ffeedd').fix);
    assert.deepEqual(l.deadReckon('unknown'), Cesium.Cartesian3.fromDegrees(0, 0, 0));
  });

  test('the trail ends at the aircraft\'s current position and ages out', async () => {
    const l = on(new L.FlightLayer(viewer));
    await l.refresh(ctx());
    const trail = l.trailWithHead('a1b2c3');
    assert.ok(trail.length >= 1);
    l.trails.get('a1b2c3').at = l.trails.get('a1b2c3').at.map(() => Date.now() - 10 * 60_000);
    assert.equal(l.trailWithHead('a1b2c3').length, 0);
    assert.equal(l.trailWithHead('nobody').length, 0);
  });

  test('detail and enrichment: route header, airframe, photo, route markers', async () => {
    const l = on(new L.FlightLayer(viewer));
    await l.refresh(ctx());
    const rec = ents(l).find((e) => e.id === 'a1b2c3').properties.record.value;
    const d = l.detail(rec);
    assert.equal(d.kind, 'AIR CONTACT');
    assert.equal(d.title, 'TST123');
    assert.match(d.html, /data-slot="route"/);
    assert.match(d.html, /Position age<\/th><td>live/);
    const root = new FakeElement('div');
    await l.enrich(rec, root);
    assert.match(root.querySelector('[data-slot="routehead"]').innerHTML, /AAA[\s\S]*→[\s\S]*BBB/);
    const route = root.querySelector('[data-slot="route"]').innerHTML;
    assert.match(route, /Airframe/);
    assert.match(route, /N12345/);
    assert.match(route, /Great-circle<\/th><td>\d+ km/);
    assert.match(root.querySelector('[data-slot="photo"]').innerHTML, /src="https:\/\/photos\.example\/a1b2c3\.jpg"/);
    assert.equal(l.routeSource.entities.values.length, 2, 'departure and arrival markers, no line');
    assert.ok(!l.routeSource.entities.values.some((e) => e.polyline));
    l.clearRoute();
    assert.equal(l.routeSource.entities.values.length, 0);
  });

  test('a schedule that cannot belong to this aircraft is flagged', async () => {
    const l = new L.FlightLayer(viewer);
    // Low, near the route's origin, far from its destination: yesterday's leg.
    const rec = { icao24: 'a1b2c3', callsign: 'TST123', lat: 33.0, lon: -97.0, altitude: 1000, onGround: false };
    const root = new FakeElement('div');
    await l.enrich(rec, root);
    assert.match(root.querySelector('[data-slot="route"]').innerHTML, /most likely a different leg/);
  });

  test('emergency squawks lead the panel; unknown callsigns say why there is nothing', async () => {
    const l = new L.FlightLayer(viewer);
    const rec = { icao24: '000001', callsign: 'NOPE1', lat: 1, lon: 1, altitude: 9000, squawk: '7500', alert: 'HIJACK', ageSec: 30 };
    const d = l.detail(rec);
    assert.match(d.html, /SQUAWK 7500 — HIJACK/);
    assert.match(d.html, /30s ago/);
    const root = new FakeElement('div');
    await l.enrich(rec, root);
    assert.match(root.querySelector('[data-slot="route"]').innerHTML, /No published schedule/);
  });

  test('switching off clears the route', async () => {
    const l = on(new L.FlightLayer(viewer));
    l.drawRoute({ origin: { lat: 1, lon: 1 }, destination: { lat: 2, lon: 2 } });
    l.setEnabled(false);
    assert.equal(l.routeSource.entities.values.length, 0);
    assert.equal(l.routeSource.show, false);
  });
});

describe('SatelliteLayer', () => {
  test('propagates each element set into a point collection', async () => {
    const l = on(new L.SatelliteLayer(viewer));
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.equal(l.count, 2);
    assert.equal(l.groupLabel, 'Space stations');
    assert.equal(l.viewportBound, false, 'orbits are not gated by altitude');
    const iss = l.records.find((r) => r.norad === 25544);
    assert.ok(iss.live.altKm > 300 && iss.live.altKm < 500, String(iss.live.altKm));
    assert.equal(l.points.get(0).show, true);
    assert.equal(l.points.get(0).color.css, '#ffd166', 'LEO colour');
  });

  test('detail draws one revolution of ground track', async () => {
    const l = on(new L.SatelliteLayer(viewer));
    await l.refresh(ctx());
    const iss = l.records.find((r) => r.norad === 25544);
    const d = l.detail(iss);
    assert.equal(d.kind, 'ORBITAL ASSET');
    assert.match(d.html, /NORAD ID<\/th><td>25544/);
    assert.match(d.html, /Period<\/th><td>9\d\.\d min/);
    assert.ok(l.orbit?.polyline.positions.length > 200);
    l.setEnabled(false);
    assert.equal(l.orbit, null);
    assert.equal(l.points.show, false);
  });

  test('without satellite.js it fails with a clear message', async () => {
    const sat = globalThis.satellite;
    delete globalThis.satellite;
    try {
      const l = on(new L.SatelliteLayer(viewer));
      await l.refresh(ctx(), { isRetry: true });
      assert.equal(l.status, 'error');
      assert.match(l.error, /satellite\.js not loaded/);
      clearTimeout(l._retryTimer);
    } finally { globalThis.satellite = sat; }
  });
});

describe('OverpassLayer', () => {
  test('draws the selected classes; deselecting repaints without refetching', async () => {
    const l = on(new L.OverpassLayer(viewer));
    l.presets = new Set(['surveillance', 'power', 'military']);
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.deepEqual(l.byPreset, { surveillance: 1, power: 1, military: 1 });
    const calls = s.mock.callsTo('overpass').length;
    l.presets.delete('power');
    l.redraw();
    assert.deepEqual(l.byPreset, { surveillance: 1, military: 1 });
    assert.equal(s.mock.callsTo('overpass').length, calls);
  });

  test('no classes selected: nothing drawn, nothing asked', async () => {
    const l = on(new L.OverpassLayer(viewer));
    l.presets = new Set();
    await l.refresh(ctx());
    assert.equal(l.count, 0);
    assert.equal(s.mock.callsTo('overpass').length, 0);
  });

  test('detail lists notable tags, other matching classes and every tag', async () => {
    const l = on(new L.OverpassLayer(viewer));
    l.presets = new Set(['military', 'aviation']);
    l.labels = { aviation: 'Airfields & helipads' };
    await l.refresh(ctx());
    const rec = l.records().find((r) => r.name === 'Test Air Force Base');
    const d = l.detail(rec);
    assert.equal(d.kind, 'MILITARY SITES');
    assert.match(d.html, /Also matches<\/th><td>Airfields &amp; helipads/);
    assert.match(d.html, /icao<\/th><td>KTST/);
    assert.match(d.html, /All OSM tags \(4\)/);
    assert.match(d.html, /openstreetmap\.org\/way\/3002/);
  });

  test('a hostile OSM tag is escaped', () => {
    const d = new L.OverpassLayer(viewer).detail({ id: 'node/1', lat: 1, lon: 1, name: XSS, tags: { [XSS]: XSS, operator: XSS } });
    assertInert(d.html);
  });
});

describe('AlprLayer', () => {
  test('cones per bearing, vendor chips and the facing filter repaint locally', async () => {
    const l = on(new L.AlprLayer(viewer));
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.equal(l.count, 4);
    assert.equal(ents(l).filter((e) => e.polygon).length, 2, 'one wedge for flock (90°), one for motorola (NNE)');
    l.vendorFilter = new Set(['flock']);
    l.redraw();
    assert.equal(l.count, 1);
    l.vendorFilter = new Set();
    l.onlyWithDirection = true;
    l.redraw();
    assert.equal(l.count, 2);
    l.showCones = false;
    l.redraw();
    assert.equal(ents(l).filter((e) => e.polygon).length, 0);
  });

  test('cone geometry: apex then an arc, never repeating the first vertex', async () => {
    const l = on(new L.AlprLayer(viewer));
    await l.refresh(ctx());
    const ring = ents(l).find((e) => e.polygon).polygon.hierarchy.args[0];
    assert.equal(ring.length, 12, 'apex + 11 arc points');
    assert.notDeepEqual(ring[0], ring.at(-1));
  });

  test('insetCones, compass facings, and the invalid-bearing note', async () => {
    const l = on(new L.AlprLayer(viewer));
    await l.refresh(ctx());
    const flock = l.records().find((r) => r.vendor === 'flock');
    assert.deepEqual(l.insetCones(flock), [{ bearing: 90, rangeM: 55, halfAngle: 20 }]);
    assert.deepEqual(l.insetCones(null), []);
    const d = l.detail(flock);
    assert.equal(d.kind, 'LICENCE PLATE READER');
    assert.equal(d.title, 'Testville Police Department');
    assert.match(d.html, /Facing<\/th><td>90° E/);
    assert.match(d.html, /deflock\.org/);
    const other = l.records().find((r) => r.directionRaw === 'sideways');
    assert.match(l.detail(other).html, /tagged &quot;sideways&quot; — not a valid bearing/);
    assertInert(l.detail(other).html);
  });
});

describe('EventLayer', () => {
  test('points, polygons and a pulsing halo for red alerts', async () => {
    const l = on(new L.EventLayer(viewer));
    l.sources = new Set(['gdacs', 'eonet', 'usgs', 'nws', 'firms', 'edis']);
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.equal(l.count, 12);
    assert.equal(l.zoneOnly, 1);
    const red = ents(l).filter((e) => e.ellipse);
    assert.ok(red.length >= 3);
    const r = red[0].ellipse.semiMajorAxis.getValue();
    assert.ok(r >= 2500 && r <= 9500);
    assert.ok(ents(l).some((e) => e.polygon), 'NWS / EONET polygons drawn');
    l.showPolygons = false;
    l.redraw();
    assert.ok(!ents(l).some((e) => e.polygon));
  });

  test('severity and source filters apply at draw time', async () => {
    const l = on(new L.EventLayer(viewer));
    await l.refresh(ctx());
    l.minSeverity = 'red';
    l.redraw();
    assert.ok(l.records().length > l.count);
    l.minSeverity = 'info';
    l.sources = new Set(['usgs']);
    l.redraw();
    assert.equal(l.count, 3);
  });

  test('every source failing is a layer error', async () => {
    for (const h of ['www.gdacs.org', 'eonet', 'earthquake.usgs.gov', 'api.weather.gov']) s.mock.fail(h, 500);
    const l = on(new L.EventLayer(viewer));
    await l.refresh(ctx(), { isRetry: true });
    assert.equal(l.status, 'error');
    clearTimeout(l._retryTimer);
  });

  test('detail: alarm for red, onset, instruction, safe source link', async () => {
    const l = on(new L.EventLayer(viewer));
    await l.refresh(ctx());
    const tornado = l.records().find((e) => e.title === 'Tornado Warning');
    const d = l.detail(tornado);
    assert.match(d.kind, /^NWS · Tornado Warning/);
    assert.match(d.html, /class="alarm"/);
    assert.match(d.html, /Take shelter now\./);
    assert.match(d.html, /href="https:\/\/api\.weather\.gov\/alerts\/urn:oid:1"/);
    assert.match(d.html, /Affected area<\/th><td>polygon, 5 vertices/);
    const bad = l.detail({ ...tornado, url: 'javascript:alert(1)', title: XSS, description: XSS, instruction: XSS });
    assertInert(bad.html);
    assert.ok(!bad.html.includes('Open source report'));
  });
});

describe('WebcamLayer', () => {
  test('draws every source, coloured per source', async () => {
    const l = on(new L.WebcamLayer(viewer));
    await l.refresh(ctx('34.9,-100.1,35.1,-99.9'));
    assert.equal(l.status, 'ok', l.error);
    assert.deepEqual(l.bySource, { windy: 2, nycdot: 1, openwebcamdb: 1, alertca: 2 });
  });

  test('a player is mounted in a locked-down iframe', async () => {
    const l = new L.WebcamLayer(viewer);
    const root = new FakeElement('div');
    await l.enrich({ source: 'windy', embed: 'https://webcams.windy.com/player/1', image: 'https://x/1.jpg', title: 't' }, root);
    const [frame, badge] = root.querySelector('[data-slot="camstage"]').children;
    assert.equal(frame.tagName, 'IFRAME');
    assert.equal(frame.src, 'https://webcams.windy.com/player/1');
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-presentation allow-popups');
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(badge.textContent, 'live player');
  });

  test('an http or javascript: player is never put in an iframe', async () => {
    const l = new L.WebcamLayer(viewer);
    for (const embed of ['http://insecure.example/p', 'javascript:alert(1)']) {
      const root = new FakeElement('div');
      await l.enrich({ source: 'windy', embed, image: null, title: 't' }, root);
      const stage = root.querySelector('[data-slot="camstage"]');
      assert.ok(!stage.children.some((c) => c.tagName === 'IFRAME'), embed);
      assert.match(stage.innerHTML, /publishes no still frame or player/);
    }
  });

  test('a still frame is refreshed on a timer with a cache-buster, and given up after three failures', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const l = new L.WebcamLayer(viewer);
      const root = new FakeElement('div');
      await l.enrich({ source: 'nycdot', image: 'https://webcams.nyctmc.org/api/cameras/1/image', title: 'Cam' }, root);
      const [img, stamp] = root.querySelector('[data-slot="camstage"]').children;
      const first = img.src;
      assert.match(first, /\/image\?_t=\d+$/);
      assert.equal(img.referrerPolicy, 'no-referrer');
      img.onload();
      assert.match(stamp.textContent, /^updated /);
      mock.timers.tick(3000);
      assert.ok(l.liveTimer);
      img.onerror(); img.onerror(); img.onerror();
      assert.equal(l.liveTimer, null);
      assert.equal(stamp.textContent, 'camera not responding');
    } finally { mock.timers.reset(); }
  });

  test('detail links only to safe URLs', () => {
    const l = new L.WebcamLayer(viewer);
    const ok = l.detail({ source: 'alertca', title: 'Peak', lat: 1, lon: 1, link: 'https://cameras.alertcalifornia.org/', pan: 120.4, tilt: -5 });
    assert.match(ok.html, /Open source page/);
    assert.match(ok.html, /120° pan, -5° tilt/);
    const bad = l.detail({ source: 'windy', title: XSS, lat: 1, lon: 1, link: 'javascript:alert(1)', place: XSS });
    assertInert(bad.html);
    assert.ok(!bad.html.includes('Open source page'));
  });
});

describe('VesselLayer', () => {
  test('draws vessels from the stream, honouring "moving only"', async () => {
    const { FakeWebSocket, positionReport, staticData } = require('../../helpers/fake-websocket.cjs');
    const l = on(new L.VesselLayer(viewer));
    await l.refresh(ctx());
    FakeWebSocket.last.open();
    FakeWebSocket.last.message(positionReport(1, { lat: HOME.lat, lon: HOME.lon, sog: 12, heading: 90 }));
    FakeWebSocket.last.message(staticData(1, { name: 'MOVER', type: 70 }));
    FakeWebSocket.last.message(positionReport(2, { lat: HOME.lat + 0.001, lon: HOME.lon, sog: 0 }));
    await l.refresh(ctx());
    assert.equal(l.count, 2);
    assert.equal(l.stream.status, 'open');
    const mover = ents(l).find((e) => e.id === 'v1');
    assert.equal(mover.label.text, 'MOVER');
    assert.equal(mover.billboard.rotation, -Math.PI / 2);
    l.movingOnly = true;
    await l.refresh(ctx());
    assert.equal(l.count, 1);
    const d = l.detail(mover.properties.record.value);
    assert.match(d.html, /Cargo/);
    assert.match(d.html, /Length × beam<\/th><td>200 × 30 m/);
    assert.match(d.html, /12\.0 kn/);
  });
});

describe('NetInfraLayer', () => {
  test('cells get a range circle; Tor is a country aggregate', async () => {
    const l = on(new L.NetInfraLayer(viewer));
    l.sources = new Set(['atlas', 'cell', 'wigle', 'tor']);
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.equal(l.count, 6);
    assert.equal(ents(l).filter((e) => e.ellipse).length, 1);
    const tor = ents(l).find((e) => e.properties.record.value.id === 'tor:US');
    assert.ok(tor.point.pixelSize > 7);
    l.showRanges = false;
    l.redraw();
    assert.equal(ents(l).filter((e) => e.ellipse).length, 0);
    assert.match(l.detail(tor.properties.record.value).html, /Country-level aggregate/);
    const probe = l.records().find((r) => r.source === 'atlas');
    assert.match(l.detail(probe).html, /atlas\.ripe\.net\/probes\/6001\//);
    const wifi = l.records().find((r) => r.source === 'wigle');
    assert.match(l.detail(wifi).html, /contributed by volunteers/);
  });
});

describe('IotLayer', () => {
  test('colours by air quality or noise; indoor filter repaints', async () => {
    const l = on(new L.IotLayer(viewer));
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.equal(l.count, 2, 'indoor hidden by default');
    l.includeIndoor = true;
    l.redraw();
    assert.equal(l.count, 3);
    assert.ok(ents(l).some((e) => e.point.color.css === '#7ee787'), 'good air is green');
    l.colorBy = 'noise';
    l.redraw();
    assert.ok(ents(l).some((e) => e.point.color.css === '#ff9f1c'), '58 dB is orange');
    const rec = l.records().find((r) => r.sensorId === 7001);
    const d = l.detail(rec);
    assert.match(d.html, /PM2\.5 12\.5 µg\/m³ — Within WHO guideline/);
    assert.match(d.html, /PM10<\/th><td>20\.1 µg\/m³/);
  });
});

describe('TrafficLayer', () => {
  test('cameras and incidents, each switchable', async () => {
    const l = on(new L.TrafficLayer(viewer));
    await l.refresh(ctx());
    assert.equal(l.status, 'ok', l.error);
    assert.equal(l.count, 2);
    l.showCameras = false;
    l.redraw();
    assert.equal(l.count, 1);
    const inc = l.records().find((r) => r.kind === 'incident');
    assert.match(l.detail(inc).kind, /^INCIDENT · 511-GA/);
    const cam = l.records().find((r) => r.kind === 'camera');
    assert.match(l.detail(cam).html, /<img class="cam" src="https:\/\/511ga\.org\/map\/Cctv\/1"/);
  });
});

describe('overlays', () => {
  test('weather radar: latest frame, frame scrubbing and animation', async () => {
    mock.timers.enable({ apis: ['setInterval'] });
    try {
      const w = new L.WeatherOverlay(viewer);
      const updates = [];
      w.onUpdate = () => updates.push(w.frameIndex);
      await w.setRadar(true);
      assert.equal(w.frames.length, 3);
      assert.equal(w.currentFrame().nowcast, true, 'latest frame');
      assert.equal(viewer.imageryLayers.length, 1);
      assert.equal(w.radarLayer.imageryProvider.maximumLevel, 7);
      w.setFrame(0);
      assert.equal(w.currentFrame().url, w.frames[0].url);
      assert.equal(viewer.imageryLayers.length, 1, 'replaced, not stacked');
      assert.equal(w.toggleAnimation(), true);
      mock.timers.tick(550 * 2);
      assert.equal(w.frameIndex, 2);
      assert.equal(w.toggleAnimation(), false);
      await w.setRadar(false);
      assert.equal(viewer.imageryLayers.length, 0);
      assert.equal(w.animating, false);
    } finally { mock.timers.reset(); }
  });

  test('cloud imagery falls back to NASA GIBS when RainViewer has no frames', async () => {
    const w = new L.WeatherOverlay(viewer);
    await w.setSatellite(true);
    assert.equal(w.cloudsAvailable, true);
    assert.match(w.satLayer.imageryProvider.url, /gibs\.earthdata\.nasa\.gov/);
    assert.equal(w.cloudLabel, 'GOES-East GeoColor (clouds)');
    await w.setSatellite(false);
    assert.equal(w.satLayer, null);
  });

  test('daily imagery: layer, opacity, and date stepping that stops at today', async () => {
    const im = new L.ImageryOverlay(viewer);
    await im.set(true);
    assert.equal(im.layers.length, 9);
    assert.equal(im.date, im.meta.date);
    assert.match(im.layer.imageryProvider.url, /VIIRS_SNPP_CorrectedReflectance_TrueColor/);
    im.setAlpha(0.3);
    assert.equal(im.layer.alpha, 0.3);
    await im.setLayer('MODIS_Terra_Land_Surface_Temp_Day');
    assert.match(im.layer.imageryProvider.url, /Land_Surface_Temp/);
    await im.setDate('2026-01-10');
    await im.shiftDate(-1);
    assert.equal(im.date, '2026-01-09');
    im.date = new Date().toISOString().slice(0, 10);
    await im.shiftDate(1);
    assert.equal(im.date, new Date().toISOString().slice(0, 10), 'no future dates');
    await im.set(false);
    assert.equal(viewer.imageryLayers.length, 0);
  });

  test('labels: proxied URL, retina tiles, boost pass, contrast tuning', () => {
    const lb = new L.LabelsOverlay(viewer);
    globalThis.devicePixelRatio = 1;
    assert.equal(lb.url(), 'tiles/carto/dark_only_labels/{z}/{x}/{y}.png', 'relative, so a sub-path works');
    globalThis.devicePixelRatio = 2;
    lb.style = 'light';
    assert.equal(lb.url(), 'tiles/carto/light_only_labels/{z}/{x}/{y}@2x.png');
    lb.set(true);
    assert.equal(viewer.imageryLayers.length, 2, 'base pass plus boost pass');
    lb.setBoost(false);
    assert.equal(viewer.imageryLayers.length, 1);
    lb.setContrast(3);
    assert.equal(lb.layer.contrast, 3);
    assert.equal(lb.layer.brightness, 1.7);
    assert.ok(Math.abs(lb.layer.gamma - 0.64) < 1e-9);
    lb.set(false);
    assert.equal(viewer.imageryLayers.length, 0);
  });

  test('labels without a CARTO key stay off and say so', () => {
    const lb = new L.LabelsOverlay(viewer);
    lb.available = false;
    let told = 0;
    lb.onUnavailable = () => told++;
    lb.set(true);
    assert.equal(lb.on, false);
    assert.equal(told, 1);
    assert.equal(viewer.imageryLayers.length, 0);
  });

  test('labels are raised above overlays added later', () => {
    const lb = new L.LabelsOverlay(viewer);
    lb.set(true);
    viewer.imageryLayers.add({ radar: true });
    lb.bringToFront();
    assert.equal(viewer.imageryLayers.get(viewer.imageryLayers.length - 1), lb.boostLayer);
  });
});

describe('BasemapOverlay', () => {
  const setup = () => {
    const base = { boot: true, show: true };
    viewer.imageryLayers.add(base);
    const bm = new L.BasemapOverlay(viewer);
    bm.adopt();
    bm.builtinKey = 'osm';
    return { bm, base };
  };

  test('Sentinel-2: searches the view, picks the newest scene, offers the clearest', async () => {
    const { bm, base } = setup();
    await bm.setProvider('sentinel2', { bbox: BBOX });
    assert.equal(bm.status, 'ok', bm.error);
    assert.equal(bm.scenes.length, 2);
    assert.equal(bm.sceneId, 'S2A_TEST_1');
    assert.equal(bm.meta.clearest, 'S2B_TEST_2');
    assert.equal(base.show, false, 'boot layer hidden, not removed');
    assert.equal(viewer.imageryLayers.get(0), bm.layer, 'new ground is at the bottom');
    await bm.selectScene('S2B_TEST_2');
    assert.equal(bm.sceneId, 'S2B_TEST_2');
    await bm.search({ bbox: BBOX });
    assert.equal(bm.sceneId, 'S2B_TEST_2', 'a re-search keeps the operator\'s pick');
    assert.equal(bm.active, true);
  });

  test('going back to the boot layer is exact and drops ours', async () => {
    const { bm, base } = setup();
    await bm.setProvider('sentinel2', { bbox: BBOX });
    await bm.setProvider('osm');
    assert.equal(base.show, true);
    assert.equal(bm.layer, null);
    assert.equal(viewer.imageryLayers.length, 1);
    assert.equal(bm.active, false);
  });

  test('an empty window and a failing search are reported', async () => {
    const { bm } = setup();
    s.mock.on('earth-search', () => json({ features: [] }));
    await bm.setProvider('sentinel2', { bbox: BBOX });
    assert.equal(bm.status, 'empty');
    assert.match(bm.error, /widen the dates/);
    s.mock.fail('earth-search', 500);
    s.mod.cache.clear(); await s.mod.clearDiskCache();
    await bm.setWindow({ maxCloud: 10 }, { bbox: BBOX });
    assert.equal(bm.status, 'error');
    assert.equal(bm.maxCloud, 10);
  });

  test('the vector map is drawn in the browser by the Shortbread provider', async () => {
    const { bm } = setup();
    await bm.setProvider('shortbread', { bbox: BBOX });
    assert.equal(bm.status, 'ok');
    assert.ok(bm.layer.imageryProvider.requestImage, 'a self-drawn provider');
    assert.equal(bm.layer.imageryProvider.maximumLevel, 14);
  });

  test('the other builtin is built rather than handed back', async () => {
    const { bm, base } = setup();
    await bm.setProvider('cesium');
    assert.equal(bm.layer.imageryProvider.worldImagery, true);
    assert.equal(base.show, false);
  });

  test('default window is the last 30 days', () => {
    const w = new L.BasemapOverlay(viewer).defaultWindow();
    assert.equal((Date.parse(w.to) - Date.parse(w.from)) / 86400_000, 30);
  });
});

test('nothing unmocked was requested', () => assert.deepEqual(s.mock.unmatched, []));

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * The sensor panel and the detail panel, layer by layer, in a real browser
 * with real Cesium: switching each layer on, its controls, what a pick shows,
 * the enrichment that fills in afterwards, and that hostile upstream data
 * cannot run script in the page.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { e2e, useStack, HOME, TEST_KEYS, json, text$, waitClass, row } from './setup.mjs';
import { waitForLayer, pickFirst, lookAt } from '../helpers/browser.mjs';

const XSS = '<img src=x onerror="window.__xss=1">';

e2e('layers and the detail panel', () => {
  const stack = useStack({ env: { ...TEST_KEYS, EDIS_API_URL: 'https://edis.example/api' } });
  let page;

  /** Switch a layer on through its panel switch and wait for its fetch. */
  async function enable(id, status = 'ok') {
    if (!(await page.evaluate((l) => WV.layers[l].enabled, id))) {
      await page.click(`${row(id)} .switch`);
    }
    await waitForLayer(page, id, { status });
    await waitClass(page, row(id), 'on');
  }

  async function detail() {
    await page.waitForSelector('#detail.open', { timeout: 10_000 });
    return {
      kind: await text$(page, '#detail-kind'),
      title: await text$(page, '#detail-title'),
      body: await page.$eval('#detail-body', (n) => n.innerHTML),
    };
  }

  before(async () => {
    await stack.reset();
    ({ page } = await stack.open());
    await lookAt(page, { lat: HOME.lat, lon: HOME.lon, h: 6000 });
  });

  test('every layer has a row with a switch, a name and a count', async () => {
    const ids = await page.$$eval('#layers .layer', (ns) => ns.map((n) => n.dataset.layer));
    assert.deepEqual(ids, ['shodan', 'flights', 'satellites', 'overpass', 'alpr', 'events', 'vessels', 'netinfra', 'iot', 'traffic', 'webcams', 'youtube']);
    for (const id of ids) {
      assert.ok(await page.$(`${row(id)} .switch`), id);
      assert.ok(await page.$(`${row(id)} .layer-name`), id);
    }
  });

  test('switching a layer off clears its count and hides its data', async () => {
    await enable('flights');
    await page.click(`${row('flights')} .switch`);
    await waitClass(page, row('flights'), 'on', false);
    assert.equal(await text$(page, `${row('flights')} .layer-count`), '—');
    assert.equal(await page.evaluate(() => WV.layers.flights.source.show), false);
    await page.click(`${row('flights')} .switch`);
    await waitForLayer(page, 'flights');
  });

  test('Shodan: machines drawn, legend by category or by CVEs, credits in the tooltip', async () => {
    await enable('shodan');
    assert.equal(await text$(page, `${row('shodan')} .layer-count`), '2');
    // Area services (from the count endpoint) · machines drawn. The drawn
    // counts move as port lookups land, so only the area half is pinned.
    const legend = await page.$$eval(`${row('shodan')} .legend-item`, (ns) => ns.map((n) => n.textContent));
    // The view spans four 0.25-degree cells; the area totals (free count
    // endpoint) are the sum across them, so each is 4x the per-cell figure.
    for (const want of [/^other 402k · \d$/, /^web 80k · \d$/, /^remote 20k · \d$/, /^ics 48 · \d$/]) {
      assert.ok(legend.some((t) => want.test(t)), `${want} in ${legend.join(' | ')}`);
    }
    await page.select(`${row('shodan')} select.ctl`, 'risk');
    const risk = await page.$$eval(`${row('shodan')} .legend-item`, (ns) => ns.map((n) => n.textContent));
    assert.deepEqual(risk, ['known CVEs 1', 'no known CVEs 1']);
    assert.equal(await text$(page, `${row('shodan')} .note`),
      '502,364 services in current view. Showing all 2 entries.');
    await page.waitForFunction(() => /Busiest address: 198\.51\.100\.99, 4,984 services/
      .test(document.querySelector('.layer[data-layer="shodan"] .layer-count').title));
    // Switching the layer on reads the credit count without a full refresh.
    await page.waitForFunction(() => /100 query credits left/.test(document.querySelector('.layer[data-layer="shodan"] .layer-count').title));
  });

  test('Shodan waits for the camera to settle before querying; the delay is adjustable', async () => {
    await enable('shodan');
    await page.evaluate(() => { WV.shodanSettleMs = 2000; WV.clearShodanSettle(); });
    const searches = () => stack.server.mock.callsTo('/shodan/host/search').length;
    const move = (lon, lat) => page.evaluate(([x, y]) => {
      WV.viewer.camera.moveStart.raiseEvent();
      WV.viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(x, y, 3000),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      // Render once so the camera reports its view rectangle (on-demand
      // rendering leaves it null until a frame is drawn), as a real move would.
      WV.viewer.scene.render();
      WV.viewer.camera.moveEnd.raiseEvent();
    }, [lon, lat]);

    try {
      // Somewhere not yet fetched: a countdown, and nothing asked until it ends.
      const before = searches();
      const movedAt = Date.now();
      await move(-97.4, 36.6);
      // The countdown starts once the other layers have refreshed for the new
      // view, which on a slow machine can take a few seconds.
      await page.waitForFunction(() => WV.layers.shodan.settleUntil > Date.now(), { timeout: 8000 })
        .catch(async (e) => {
          const dbg = await page.evaluate(() => ({
            settleUntil: WV.layers.shodan.settleUntil ?? null, key: WV._settleKey ?? null,
            bbox: WV.currentBbox(), covered: WV.currentBbox() ? WV.layers.shodan.isCovered(WV.currentBbox()) : null,
            enabled: WV.layers.shodan.enabled, held: WV.heldFor(WV.layers.shodan), auto: WV.autoRefresh,
          }));
          throw new Error('no countdown: ' + JSON.stringify(dbg) + ' ' + e.message);
        });
      assert.match(await text$(page, `${row('shodan')} .layer-count`), /^◴\d/);
      assert.equal(searches(), before, 'nothing queried while the camera is still settling');
      assert.equal(await page.evaluate(() => WV.layers.shodan.lookupsPaused), true, 'port lookups wait too');
      await page.waitForFunction(() => WV.layers.shodan.settleUntil == null, { timeout: 10_000 });
      assert.ok(Date.now() - movedAt >= 2000, 'waited the configured delay before querying');
      await waitForLayer(page, 'shodan');
      assert.ok(searches() > before, 'queried once the camera had settled');
      assert.equal(await page.evaluate(() => WV.layers.shodan.lookupsPaused), false, 'lookups resumed');

      // Back inside ground already held: no countdown, no request.
      const held = searches();
      await move(-97.4, 36.6);
      // The settle path runs after the 700 ms move debounce and the other
      // layers' refresh, which can take a few seconds on a slow machine. For a
      // held view it ends by resuming the port lookups, so wait for that rather
      // than a fixed sleep; a countdown started instead would keep them paused.
      await page.waitForFunction(() => WV.layers.shodan.lookupsPaused === false, { timeout: 8000 })
        .catch(async (e) => {
          const dbg = await page.evaluate(() => ({
            settleUntil: WV.layers.shodan.settleUntil ?? null, paused: WV.layers.shodan.lookupsPaused,
            covered: WV.currentBbox() ? WV.layers.shodan.isCovered(WV.currentBbox()) : null,
          }));
          throw new Error('lookups never resumed over a held view: ' + JSON.stringify(dbg) + ' ' + e.message);
        });
      assert.equal(await page.evaluate(() => WV.layers.shodan.settleUntil ?? null), null, 'no wait for a held view');
      assert.equal(searches(), held, 'nothing queried for a held view');
    } finally {
      // Always hand the camera back to home: the tests after this one share
      // this page and expect the home view, so a failure above must not leave
      // them over empty ground. Restore the default settle delay too.
      await move(HOME.lon, HOME.lat);
      await page.evaluate(() => { WV.shodanSettleMs = 15_000; });
      await waitForLayer(page, 'shodan').catch(() => {});
    }
  });

  test('SYNC leaves Shodan on its paid-for answers; Shift+SYNC re-buys them', async () => {
    const searches = () => stack.server.mock.callsTo('/shodan/host/search').length;
    const settle = () => new Promise((r) => setTimeout(r, 500));
    const before = searches();
    await page.click('#refresh-now');
    await waitForLayer(page, 'shodan');
    await settle();
    assert.equal(searches(), before, 'a plain SYNC spent no Shodan credit');

    await page.keyboard.down('Shift');
    await page.click('#refresh-now');
    await page.keyboard.up('Shift');
    for (let i = 0; i < 50 && searches() === before; i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(searches() > before, 'Shift+SYNC asked Shodan again');
    await waitForLayer(page, 'shodan');
  });

  test('Shodan detail: host, CVE links and the reputation lookup', async () => {
    assert.equal(await pickFirst(page, 'shodan', (r) => r.ip === '198.51.100.10'), true);
    const d = await detail();
    assert.equal(d.kind, 'SHODAN HOST');
    assert.equal(d.title, '198.51.100.10');
    // Every port on the machine, not only the one the area search matched.
    await page.waitForFunction(() => /3 services on this machine/.test(document.querySelector('[data-slot="ports"]').textContent));
    assert.match(d.body, /CVE-2021-44228/);
    await page.waitForFunction(() => /Scanner reputation/.test(document.querySelector('[data-slot="enrich"]').textContent));
    assert.match(await text$(page, '[data-slot="enrich"]'), /Not on the abuse\.ch botnet C2 list/);
    assert.ok(await page.$('#detail-body .detail-inset .inset-frame'), 'close-up map rendered');
    assert.match(await text$(page, '#detail-body .inset-coord'), /^35\.00\d\d, -99\.99\d\d · z17$/);
  });

  test('the selection ring follows the pick', async () => {
    assert.equal(await page.evaluate(() => WV.selection.entity.show), true);
    assert.equal(await page.evaluate(() => WV.selection.owns('shodan')), true);
  });

  test('closing the panel: the × button and Escape', async () => {
    await page.waitForFunction(() => document.querySelector('#detail').getBoundingClientRect().right <= innerWidth + 1);
    await page.$eval('#detail-close', (b) => b.click());
    await waitClass(page, '#detail', 'open', false);
    assert.equal(await page.evaluate(() => WV.selection.entity.show), false);
    await pickFirst(page, 'shodan');
    await detail();
    await page.keyboard.press('Escape');
    await waitClass(page, '#detail', 'open', false);
  });

  test('aircraft detail: route header, airframe, photo and airport markers', async () => {
    await enable('flights');
    await pickFirst(page, 'flights', (r) => r.icao24 === 'a1b2c3');
    const d = await detail();
    assert.equal(d.kind, 'AIR CONTACT');
    assert.equal(d.title, 'TST123');
    await page.waitForFunction(() => /Airframe/.test(document.querySelector('[data-slot="route"]').textContent));
    assert.match(await text$(page, '[data-slot="routehead"]'), /AAA\s+Alphaville\s+→\s+BBB\s+Bravotown/);
    assert.match(await text$(page, '[data-slot="route"]'), /N12345/);
    assert.equal(await page.$eval('[data-slot="photo"] img', (n) => n.src), 'https://photos.example/a1b2c3.jpg');
    assert.equal(await page.evaluate(() => WV.layers.flights.routeSource.entities.values.length), 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => WV.layers.flights.routeSource.entities.values.length), 0, 'route cleared on close');
  });

  test('emergency aircraft are flagged in the panel', async () => {
    await pickFirst(page, 'flights', (r) => r.squawk === '7700');
    await detail();
    assert.match(await text$(page, '#detail-body .alarm'), /SQUAWK 7700 — EMERGENCY/);
  });

  test('satellites: group menu, object limit, and a ground track on pick', async () => {
    await enable('satellites');
    const groups = await page.$$eval(`${row('satellites')} select.ctl option`, (os) => os.length);
    assert.ok(groups >= 20);
    await page.select(`${row('satellites')} select.ctl`, 'starlink');
    await page.waitForFunction(() => WV.layers.satellites.group === 'starlink' && WV.layers.satellites.status === 'ok');
    assert.equal(await text$(page, `${row('satellites')} .layer-count`), '2');
    await pickFirst(page, 'satellites', (r) => r.norad === 25544);
    const d = await detail();
    assert.equal(d.kind, 'ORBITAL ASSET');
    assert.equal(d.title, 'ISS (ZARYA)');
    assert.ok(await page.evaluate(() => WV.layers.satellites.orbit?.polyline.positions.getValue().length > 200));
  });

  test('OSM infrastructure: one chip per class, toggling refetches', async () => {
    const chips = await page.$$eval(`${row('overpass')} .chip`, (cs) => cs.map((c) => c.textContent));
    assert.equal(chips.length, 10);
    await enable('overpass');
    assert.equal(await text$(page, `${row('overpass')} .layer-count`), '1', 'surveillance only by default');
    await page.evaluate(() => [...document.querySelectorAll('.layer[data-layer="overpass"] .chip')]
      .find((c) => c.textContent === 'Military sites').click());
    await page.waitForFunction(() => WV.layers.overpass.status === 'ok' && WV.layers.overpass.count === 2);
    assert.match(await text$(page, `${row('overpass')} .note`), /Surveillance cameras: 1/);
    await pickFirst(page, 'overpass', (r) => r.preset === 'military');
    const d = await detail();
    assert.equal(d.kind, 'MILITARY SITES');
    assert.equal(d.title, 'Test Air Force Base');
  });

  test('ALPR: vendor chips filter locally, cones drawn, facing shown in the inset', async () => {
    await enable('alpr');
    assert.equal(await text$(page, `${row('alpr')} .layer-count`), '4');
    const calls = stack.server.mock.callsTo('overpass').length;
    await page.evaluate(() => [...document.querySelectorAll('.layer[data-layer="alpr"] .chip')]
      .find((c) => c.textContent === 'Flock Safety').click());
    await page.waitForFunction(() => document.querySelector('.layer[data-layer="alpr"] .layer-count').textContent === '1');
    assert.equal(stack.server.mock.callsTo('overpass').length, calls, 'vendor chips do not refetch');
    assert.match(await text$(page, `${row('alpr')} .srclist`), /with known facing\s*1\/1/);
    await pickFirst(page, 'alpr', (r) => r.vendor === 'flock');
    const d = await detail();
    assert.equal(d.kind, 'LICENCE PLATE READER');
    assert.match(d.body, /90° E/);
    assert.ok(await page.$('#detail-body .inset-frame.has-cones svg polygon'), 'field-of-view wedge on the map');
  });

  test('hazards: chips, severity menu, polygons, and an event detail', async () => {
    await enable('events');
    await page.select(`${row('events')} select.ctl`, 'red');
    await page.waitForFunction(() => WV.layers.events.minSeverity === 'red' && WV.layers.events.status === 'ok');
    const n = Number(await text$(page, `${row('events')} .layer-count`));
    assert.ok(n >= 2, String(n));
    assert.match(await text$(page, `${row('events')} .note`), /1 NWS alert reference forecast zones/);
    await pickFirst(page, 'events', (r) => r.title === 'Tornado Warning');
    const d = await detail();
    assert.match(d.kind, /^NWS · Tornado Warning/);
    assert.match(d.body, /Take shelter now\./);
    await page.select(`${row('events')} select.ctl`, 'info');
  });

  test('public cameras: a live player in a sandboxed iframe', async () => {
    await enable('webcams');
    await pickFirst(page, 'webcams', (r) => r.id === 'windy:9001');
    const d = await detail();
    assert.equal(d.kind, 'PUBLIC CAMERA');
    const frame = await page.waitForSelector('[data-slot="camstage"] iframe.cam-frame');
    assert.equal(await frame.evaluate((n) => n.getAttribute('sandbox')), 'allow-scripts allow-same-origin allow-presentation allow-popups');
    assert.equal(await frame.evaluate((n) => n.getAttribute('referrerpolicy')), 'no-referrer');
    assert.match(await frame.evaluate((n) => n.src), /^https:\/\/webcams\.windy\.com\//);
  });

  test('public cameras: a still frame that refreshes itself', async () => {
    await pickFirst(page, 'webcams', (r) => r.source === 'nycdot');
    await detail();
    const img = await page.waitForSelector('[data-slot="camstage"] img.cam-live');
    const first = await img.evaluate((n) => n.src);
    assert.match(first, /\/api\/cameras\/nyc-home\/image\?_t=\d+$/);
    await page.waitForFunction((f) => document.querySelector('img.cam-live')?.src !== f, { timeout: 8000 }, first);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => WV.layers.webcams.liveTimer), null, 'refresh stops when the panel closes');
  });

  test('network infrastructure, IoT sensors and traffic', async () => {
    await page.evaluate(() => [...document.querySelectorAll('.layer[data-layer="netinfra"] .chip')]
      .filter((c) => !c.classList.contains('on')).forEach((c) => c.click()));
    await enable('netinfra');
    await page.waitForFunction(() => WV.layers.netinfra.status === 'ok' && WV.layers.netinfra.sources.size === 5);
    // Probes, cells, WiFi and Tor (6), plus the Mesh / LoRa nodes in view.
    await page.waitForFunction(() => {
      const l = WV.layers.netinfra;
      return l.bySource.mesh > 0 && l.count === 6 + l.bySource.mesh;
    }, { timeout: 15_000 });
    await enable('iot');
    assert.match(await text$(page, `${row('iot')} .srclist`), /reporting air quality\s*1\s*reporting noise\s*1/);   // the indoor sensor is hidden
    await page.select(`${row('iot')} select.ctl`, 'noise');
    await enable('traffic');
    assert.match(await text$(page, `${row('traffic')} .note`), /GA: 1 cams, 1 incidents/);
    await pickFirst(page, 'traffic', (r) => r.kind === 'incident');
    assert.match((await detail()).kind, /^INCIDENT · 511-GA/);
  });

  test('vessels: the panel reports the AIS stream state', async () => {
    await enable('vessels');
    assert.match(await text$(page, `${row('vessels')} .note`), /Connecting to AIS stream|Stream /);
  });

  test('regional signals render in the sidebar', async () => {
    await page.evaluate(() => WV.refreshSignals());
    await page.waitForFunction(() => /Internet outages/.test(document.querySelector('#signals-body').textContent));
    const body = await text$(page, '#signals-body');
    assert.match(body, /United States\s*3 events/);
    assert.match(body, /US grid demand/);
    assert.match(body, /PJM Interconnection\s*90,000 MW/);
    assert.match(body, /Cloudflare Radar outages/);
    assert.match(body, /1 Raspberry Shake station reporting/);
  });

  test('a real mouse click on a drawn feature selects it', async () => {
    await page.keyboard.press('Escape');
    const pos = await page.evaluate(() => {
      const l = WV.layers.events;
      const ent = l.source.entities.values.find((e) => e.point && e.properties.record.getValue().severity === 'red');
      WV.viewer.camera.flyTo({ destination: ent.position.getValue(WV.viewer.clock.currentTime), duration: 0 });
      return true;
    });
    assert.equal(pos, true);
    await lookAt(page, { lat: HOME.lat + 0.005, lon: HOME.lon, h: 4000 });
    await page.waitForFunction(() => WV._frames > 0 || true);
    // Layers refresh about 700 ms after the camera settles (and Cesium can
    // raise a second moveEnd shortly after), redrawing their entities. A
    // click that lands mid-redraw hits nothing, so wait for the redraws to
    // finish, and click again if one still caught the first click.
    const where = () => page.evaluate(() => {
      const ent = WV.layers.events.source.entities.values.find((e) => e.point
        && e.properties.record.getValue().title === 'Earthquake in Testland');
      if (!ent) return null;
      const p = ent.position.getValue(WV.viewer.clock.currentTime);
      const w = Cesium.SceneTransforms.worldToWindowCoordinates(WV.viewer.scene, p);
      const r = WV.viewer.canvas.getBoundingClientRect();
      return w && { x: r.left + w.x, y: r.top + w.y };
    });
    let d = null;
    let xy = null;
    for (let attempt = 0; attempt < 3 && !d; attempt++) {
      await new Promise((r) => setTimeout(r, 1500));
      xy = await where();
      if (!xy) continue;
      await page.mouse.click(xy.x, xy.y);
      d = await page.waitForSelector('#detail.open', { timeout: 3000 }).then(() => detail(), () => null);
    }
    assert.ok(xy, 'feature is on screen');
    if (!d) {
      // Diagnostic: say what the click actually hit.
      const dbg = await page.evaluate(({ x, y }) => {
        const r = WV.viewer.canvas.getBoundingClientRect();
        const picked = WV.viewer.scene.pick(new Cesium.Cartesian2(x - r.left, y - r.top));
        const ev = WV.layers.events.source.entities.values;
        return {
          detailOpen: !!document.querySelector('#detail.open'),
          pickedLayer: picked?.id?.properties?.layer?.getValue?.() ?? (picked?.id?.id ?? null),
          nEvents: ev.length,
          shodanOn: WV.layers.shodan.enabled,
          // Whatever sits on top of the canvas at the click point, if anything.
          topElement: (() => { const n = document.elementFromPoint(x, y); return n && `${n.tagName}#${n.id}.${n.className}`; })(),
        };
      }, xy);
      throw new Error('click opened no detail: ' + JSON.stringify(dbg));
    }
    assert.match(d.title, /Earthquake in Testland/);
  });

  test('hostile upstream text and links cannot run script anywhere in the UI', async () => {
    await stack.reset();
    const { mock } = stack.server;
    mock.on('earthquake.usgs.gov', () => json({ features: [{ id: 'evil', geometry: { coordinates: [HOME.lon, HOME.lat, 1] },
      properties: { mag: 7, place: XSS, title: XSS, url: 'javascript:window.__xss=2', time: Date.now() } }] }));
    mock.on('www.gdacs.org', () => json({ features: [] }));
    mock.on('eonet', () => json({ features: [] }));
    mock.on('api.weather.gov', () => json({ features: [] }));
    mock.on('/shodan/host/search', () => json({ total: 1, matches: [{ ip_str: '198.51.100.9', port: 80, product: XSS,
      data: `</pre>${XSS}`, hostnames: [XSS], tags: [XSS], vulns: { [`CVE-1${XSS}`]: {} },
      location: { latitude: HOME.lat, longitude: HOME.lon, city: XSS } }] }));
    mock.on('api.greynoise.io', () => json({ noise: true, classification: XSS, name: XSS, link: 'javascript:alert(1)' }));
    mock.on('nominatim', () => json([{ display_name: XSS, name: XSS, lat: '35', lon: '-100' }]));

    const fresh = await stack.open();
    page = fresh.page;
    await lookAt(page, { lat: HOME.lat, lon: HOME.lon, h: 6000 });
    await page.evaluate(() => WV.refreshAll({ force: true }));
    await waitForLayer(page, 'events');
    await pickFirst(page, 'events', (r) => r.id === 'usgs:evil');
    await detail();
    assert.equal(await page.$('#detail-body a[href^="javascript"]'), null);
    assert.equal(await page.$('#detail-body img[src="x"]'), null);

    await enable('shodan');
    await pickFirst(page, 'shodan');
    await detail();
    await page.waitForFunction(() => /Scanner reputation/.test(document.querySelector('[data-slot="enrich"]')?.textContent || ''));
    assert.equal(await page.$('#detail-body img[src="x"]'), null);

    await page.type('#search', 'evil');
    await page.waitForSelector('#search-results.open .hit');
    assert.equal(await page.$('#search-results img'), null);
    assert.match(await text$(page, '#search-results .hit strong'), /<img src=x/);

    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'no injected script ran');
  });
});

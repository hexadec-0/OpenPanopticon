// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * Overlays (radar, clouds, daily imagery, labels, base map) and the settings
 * that survive a reload.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { e2e, useStack, HOME, TEST_KEYS, text$, hasClass, waitClass, waitToast, waitSaved, row } from './setup.mjs';
import { waitForLayer, waitForBooted, lookAt, openApp } from '../helpers/browser.mjs';

const imageryLayerCount = (page) => page.evaluate(() => WV.viewer.imageryLayers.length);

e2e('overlays', () => {
  const stack = useStack();
  let page;
  let external;
  before(async () => {
    await stack.reset();
    ({ page, external } = await stack.open());
  });

  test('labels are on by default and proxied through the server', async () => {
    assert.equal(await hasClass(page, '#wx-labels', 'active'), true);
    assert.equal(await page.evaluate(() => WV.labels.on), true);
    // The overlay points at the same-origin proxy…
    const template = await page.evaluate(() => WV.labels.layer.imageryProvider.url);
    assert.match(template, /^(http:\/\/127\.0\.0\.1:\d+\/|\/)?tiles\/carto\/dark_only_labels\/\{z\}\/\{x\}\/\{y\}(@2x)?\.png$/);
    // …which serves a tile the page can load. (When Cesium asks for tiles
    // depends on render speed, which under software WebGL is too variable
    // to wait on.)
    const tile = await page.evaluate(async () => {
      const r = await fetch('/tiles/carto/dark_only_labels/2/1/1.png');
      return { status: r.status, type: r.headers.get('content-type') };
    });
    assert.deepEqual(tile, { status: 200, type: 'image/png' });
    assert.ok(stack.server.mock.callsTo('basemaps.cartocdn.com').length > 0, 'the server fetched it from CARTO');
    assert.ok(!external.some((u) => /cartocdn/.test(u)), 'the browser never talks to CARTO directly');
  });

  test('label style, contrast and bold controls', async () => {
    await page.select('#lb-style', 'light');
    assert.equal(await page.evaluate(() => WV.labels.style), 'light');
    assert.match(await page.evaluate(() => WV.labels.url()), /light_only_labels/);
    await page.$eval('#lb-contrast', (n) => { n.value = '300'; n.dispatchEvent(new Event('input')); });
    assert.equal(await page.evaluate(() => WV.labels.contrast), 3);
    const before = await imageryLayerCount(page);
    await page.$eval('#lb-boost', (n) => n.click());
    assert.equal(await imageryLayerCount(page), before - 1, 'the boost pass is removed');
    await page.click('#wx-labels');
    assert.equal(await hasClass(page, '#wx-labels', 'active'), false);
    assert.equal(await page.evaluate(() => WV.labels.layer), null);
    await page.click('#wx-labels');
  });

  test('radar: the scrubber bar, frame times and the play button', async () => {
    await page.click('#wx-radar');
    await waitClass(page, '#weather', 'open');
    assert.equal(await hasClass(page, '#wx-radar', 'active'), true);
    assert.equal(await page.$eval('#wx-frame', (n) => n.max), '2');
    assert.equal(await page.$eval('#wx-frame', (n) => n.value), '2');
    assert.match(await text$(page, '#wx-time'), /^\d{2}:\d{2}Z · forecast$/);
    await page.$eval('#wx-frame', (n) => { n.value = '0'; n.dispatchEvent(new Event('input')); });
    assert.doesNotMatch(await text$(page, '#wx-time'), /forecast/);
    await page.click('#wx-play');
    assert.equal(await text$(page, '#wx-play'), '❚❚');
    await page.waitForFunction(() => document.querySelector('#wx-frame').value !== '0', { timeout: 15_000 });
    await page.click('#wx-play');
    assert.equal(await text$(page, '#wx-play'), '▶');
    await page.click('#wx-radar');
    await waitClass(page, '#weather', 'open', false);
  });

  test('clouds fall back to NASA GIBS and say so in the tooltip', async () => {
    await page.click('#wx-sat');
    await waitClass(page, '#wx-sat', 'active');
    assert.match(await page.$eval('#wx-sat', (n) => n.title), /GOES-East GeoColor/);
    await page.click('#wx-sat');
    await waitClass(page, '#wx-sat', 'active', false);
  });

  test('daily imagery: layer menu, day stepping and opacity', async () => {
    await page.click('#wx-imagery');
    await waitClass(page, '#imagery', 'open');
    assert.equal(await page.$$eval('#im-layer option', (os) => os.length), 9);
    const d0 = await page.$eval('#im-date', (n) => n.value);
    assert.match(d0, /^\d{4}-\d{2}-\d{2}$/);
    await page.click('#im-prev');
    await page.waitForFunction((d) => document.querySelector('#im-date').value !== d, {}, d0);
    const prev = new Date(`${d0}T00:00:00Z`); prev.setUTCDate(prev.getUTCDate() - 1);
    assert.equal(await page.$eval('#im-date', (n) => n.value), prev.toISOString().slice(0, 10));
    await page.select('#im-layer', 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance');
    await page.waitForFunction(() => WV.imagery.meta?.layer === 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance');
    await page.$eval('#im-alpha', (n) => { n.value = '40'; n.dispatchEvent(new Event('input')); });
    assert.equal(await page.evaluate(() => WV.imagery.layer.alpha), 0.4);
    await page.click('#wx-imagery');
    await waitClass(page, '#imagery', 'open', false);
  });

  test('base map menu lists every provider, unavailable ones disabled', async () => {
    const opts = await page.$$eval('#bm-provider option', (os) => os.map((o) => [o.value, o.disabled]));
    assert.deepEqual(opts, [['osm', false], ['cesium', true], ['shortbread', false], ['sentinel2', false], ['gee', true]]);
    assert.equal(await page.$eval('#bm-provider', (n) => n.value), 'osm');
    assert.match(await text$(page, '#bm-note'), /Street map/);
  });

  test('Sentinel-2: scenes over the view, newest picked, clearest starred', async () => {
    await lookAt(page, { lat: HOME.lat, lon: HOME.lon, h: 4000 });
    await page.select('#bm-provider', 'sentinel2');
    await page.waitForFunction(() => WV.basemap.status === 'ok', { timeout: 20_000 });
    assert.equal(await hasClass(page, '#wx-basemap', 'active'), true);
    const scenes = await page.$$eval('#bm-scene option', (os) => os.map((o) => [o.value, o.textContent]));
    assert.equal(scenes.length, 2);
    assert.equal(scenes[0][0], 'S2A_TEST_1');
    assert.match(scenes[1][1], /3% cloud\s+★$/);
    assert.equal(await page.$eval('#bm-scene', (n) => n.value), 'S2A_TEST_1');
    assert.match(await text$(page, '#bm-note'), /2 of 3 scenes in .* Copernicus Sentinel data/);
    await page.$eval('#bm-clearest', (b) => b.click());
    assert.equal(await page.evaluate(() => WV.basemap.sceneId), 'S2B_TEST_2');
    assert.equal(await page.$eval('#bm-window', (n) => n.style.display), '');
  });

  test('changing the date window searches again', async () => {
    const before = stack.server.mock.callsTo('earth-search').length;
    await page.$eval('#bm-cloud', (n) => { n.value = '15'; n.dispatchEvent(new Event('input')); n.dispatchEvent(new Event('change')); });
    assert.equal(await text$(page, '#bm-cloud-val'), '15%');
    await page.waitForFunction(() => WV.basemap.maxCloud === 15 && WV.basemap.status === 'ok');
    assert.ok(stack.server.mock.callsTo('earth-search').length > before);
    const body = JSON.parse(stack.server.mock.callsTo('earth-search').at(-1).body);
    assert.deepEqual(body.query, { 'eo:cloud_cover': { lt: 15 } });
  });

  test('the BASEMAP button toggles between streets and the last imagery source', async () => {
    await page.click('#wx-basemap');
    await page.waitForFunction(() => WV.basemap.provider === 'osm');
    assert.equal(await hasClass(page, '#wx-basemap', 'active'), false);
    assert.equal(await page.$eval('#bm-window', (n) => n.style.display), 'none');
    await page.click('#wx-basemap');
    await page.waitForFunction(() => WV.basemap.provider === 'sentinel2' && WV.basemap.status === 'ok');
  });

  test('the vector map draws in the browser', async () => {
    await page.select('#bm-provider', 'shortbread');
    await page.waitForFunction(() => WV.basemap.provider === 'shortbread' && WV.basemap.status === 'ok');
    assert.equal(await page.evaluate(() => typeof WV.basemap.layer.imageryProvider.requestImage), 'function');
    await page.select('#bm-provider', 'osm');
  });
});

e2e('settings survive a reload', () => {
  const stack = useStack();

  test('mode, layers, filters, overlays, ceiling, AUTO and sidebar come back', async () => {
    await stack.reset();
    const { page, context } = await stack.open();
    await page.click('#optics .optic[data-mode="flir"]');
    await page.click(`${row('overpass')} .switch`);
    await page.evaluate(() => [...document.querySelectorAll('.layer[data-layer="overpass"] .chip')]
      .find((c) => c.textContent === 'Power infrastructure').click());
    await page.click(`${row('flights')} .switch`);
    await page.select(`${row('events')} select.ctl`, 'orange');
    await page.click('#hud-gate');
    await page.click('#auto-toggle');
    await page.click('#sidebar-toggle');
    await page.click('#wx-radar');
    await waitClass(page, '#weather', 'open');
    await page.$$eval('.cycle-step', (bs) => bs.find((b) => b.dataset.s === '30').click());
    await waitSaved(page, (s) => s?.mode === 'flir' && s.overlays?.radar === true && s.cycle?.intervalS === 30);

    // A second tab in the same profile: same localStorage, fresh app.
    const { page: again } = await openApp(stack.browser, stack.server.base, { context });
    try {
      assert.equal(await text$(again, '#hud-mode'), 'FLIR');
      assert.equal(await hasClass(again, row('overpass'), 'on'), true);
      assert.equal(await hasClass(again, row('flights'), 'on'), false);
      assert.deepEqual(await again.evaluate(() => [...WV.layers.overpass.presets].sort()), ['power', 'surveillance']);
      assert.equal(await again.$eval(`${row('events')} select.ctl`, (n) => n.value), 'orange');
      assert.equal(await again.evaluate(() => WV.queryCeilingM), 100_000);
      assert.equal(await text$(again, '#auto-toggle span'), 'HOLD');
      assert.equal(await hasClass(again, 'body', 'sidebar-collapsed'), true);
      await waitClass(again, '#weather', 'open');
      assert.equal(await again.evaluate(() => WV.autoCycle.intervalS), 30);
      const chip = await again.evaluate(() => [...document.querySelectorAll('.layer[data-layer="overpass"] .chip')]
        .find((c) => c.textContent === 'Power infrastructure').classList.contains('on'));
      assert.equal(chip, true, 'chip state rendered from the restored settings');
    } finally { await again.close(); }
  });

  test('a pinned home is restored; a resolved one is not', async () => {
    await stack.reset();
    const pinned = { home: { lat: 48.8566, lon: 2.3522, h: 5000, label: 'Paris', source: 'manual' } };
    const { page } = await stack.open({ storage: { 'openpanopticon.settings.v1': pinned } });
    assert.equal(await text$(page, '#hud-home'), 'Paris');
    const cam = await page.evaluate(() => {
      const c = WV.viewer.camera.positionCartographic;
      return { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
    });
    assert.ok(Math.abs(cam.lat - 48.8566) < 0.2 && Math.abs(cam.lon - 2.3522) < 0.2, JSON.stringify(cam));
    assert.equal(stack.server.mock.callsTo('ipwho.is').length, 0, 'a pinned home needs no lookup');
  });

  test('a tampered home in storage is ignored', async () => {
    await stack.reset();
    const bad = { home: { lat: null, lon: null, source: 'manual' } };
    const { page } = await stack.open({ storage: { 'openpanopticon.settings.v1': bad } });
    assert.equal(await text$(page, '#hud-home'), `${HOME.city}, ${HOME.region}, ${HOME.country}`);
  });

  test('settings from before the rename are migrated', async () => {
    await stack.reset();
    const { page } = await stack.open({ storage: { 'worldview.settings.v1': { mode: 'crt' } } });
    assert.equal(await text$(page, '#hud-mode'), 'CRT');
    assert.equal(await page.evaluate(() => localStorage.getItem('worldview.settings.v1')), null);
  });

  // Regression: the beforeunload handler used to save the settings back as
  // the page unloaded, so Reset restored exactly what it had just cleared.
  test('"Reset saved settings" clears them and reloads with defaults', async () => {
    await stack.reset();
    const { page } = await stack.open({ storage: { 'openpanopticon.settings.v1': { mode: 'sar', enabled: { overpass: true } } } });
    assert.equal(await text$(page, '#hud-mode'), 'SAR');
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.click('#reset-settings');
    await waitToast(page, /Saved settings cleared/);
    await nav;
    await waitForBooted(page);
    assert.equal(await text$(page, '#hud-mode'), 'EO');
    assert.equal(await hasClass(page, row('overpass'), 'on'), false);
    assert.equal(await hasClass(page, row('flights'), 'on'), true);
  });

  test('a restored Sentinel-2 base map searches once the camera is placed', async () => {
    await stack.reset();
    const { page } = await stack.open({ storage: { 'openpanopticon.settings.v1': { basemap: { provider: 'sentinel2', maxCloud: 25 } } } });
    await page.waitForFunction(() => WV.basemap.provider === 'sentinel2' && WV.basemap.status === 'ok', { timeout: 20_000 });
    assert.equal(await page.$eval('#bm-provider', (n) => n.value), 'sentinel2');
    assert.deepEqual(JSON.parse(stack.server.mock.callsTo('earth-search').at(-1).body).query, { 'eo:cloud_cover': { lt: 25 } });
  });

  test('a restored provider that is no longer available is dropped', async () => {
    await stack.reset();
    const { page } = await stack.open({ storage: { 'openpanopticon.settings.v1': { basemap: { provider: 'gee' } } } });
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(await page.evaluate(() => WV.basemap.provider), 'osm');
    assert.equal(stack.server.mock.callsTo('earthengine').length, 0);
  });
});

void TEST_KEYS; void waitForLayer;

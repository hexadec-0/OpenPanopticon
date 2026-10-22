// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * The GitHub Pages demo in a real browser: a snapshot captured from the fake
 * upstreams, built, and served by a plain static file server under a
 * /<repo>/ sub-path — no server.js anywhere.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { e2e } from './setup.mjs';
import { launchBrowser, openApp, lookAt, textOf } from '../helpers/browser.mjs';
import { capture } from '../../demo/capture.mjs';
import { build } from '../../demo/build.mjs';

const require = createRequire(import.meta.url);
const { serveStatic } = require('../helpers/static-site.cjs');

e2e('static demo', () => {
  let out;
  let site;
  let browser;
  let app;
  const quiet = () => {};

  before(async () => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'op-demo-e2e-'));
    await capture({ out, fixtures: true, tiles: true, aisWait: 0 }, quiet);

    // The fake Overpass has no buildings, so plant a few in the first cell.
    const mf = path.join(out, 'data', 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
    const t = m.buildings.tiles[0];
    const sq = (lat, lon, d) => [lon, lat, lon + d, lat, lon + d, lat + d, lon, lat + d, lon, lat];
    const cLat = (t.south + t.north) / 2;
    const cLon = (t.west + t.east) / 2;
    fs.writeFileSync(path.join(out, 'data', 'buildings', `${t.i}.json`), JSON.stringify({ b: [
      [120, 0, sq(cLat, cLon, 0.0006)], [40, 0, sq(cLat + 0.001, cLon, 0.0004)],
    ] }));
    t.n = 2;
    fs.writeFileSync(mf, JSON.stringify(m));
    build({ out, env: path.join(out, 'no.env') }, quiet);

    site = await serveStatic(out, { prefix: '/OpenPanopticon/' });
    browser = await launchBrowser();
    app = await openApp(browser, site.base);
    app.buildingsAt = { lat: cLat + 0.0003, lon: cLon + 0.0003 };
    app.capturedAt = m.capturedAt;
  });

  after(async () => {
    await app?.page.close().catch(() => {});
    await browser?.close().catch(() => {});
    await site?.close();
    if (out) fs.rmSync(out, { recursive: true, force: true });
  });

  test('boots from static files under a sub-path, over New York, at capture time', async () => {
    const { page } = app;
    assert.match(await page.title(), /\(demo\)$/);
    assert.equal(await textOf(page, '#hud-home'), 'New York, New York, United States');
    assert.match(await textOf(page, '#demo-banner'), /Static snapshot of New York City, captured .+ Nothing here is live/);
    // Filled in on the first HUD redraw, which can trail boot under software WebGL.
    await page.waitForFunction(() => /^\d\d:\d\d:\d\dZ$/.test(document.querySelector('#hud-time')?.textContent || ''),
      { timeout: 20_000 });
    const utc = await textOf(page, '#hud-time');
    const want = new Date(app.capturedAt);
    const [h, mi] = utc.split(':').map(Number);
    const drift = Math.abs((h * 60 + mi) - (want.getUTCHours() * 60 + want.getUTCMinutes()));
    assert.ok(drift <= 2 || drift >= 1438, `HUD ${utc} vs capture ${want.toISOString()}`);
    // Nothing asked the host for /api/*; the snapshot answered.
    assert.deepEqual(site.seen.filter((p) => p.includes('/api/')).filter((p) => !p.includes('/data/api/')), []);
    assert.ok(site.seen.includes('/OpenPanopticon/data/api/health.json'));
    assert.deepEqual(app.errors.map(String), []);
    // The only outside requests are the fonts and the Cesium CDN.
    const hosts = new Set(app.external.map((u) => new URL(u).host));
    for (const h2 of hosts) assert.match(h2, /^(fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)$/, h2);
  });

  test('layers draw from the snapshot', async () => {
    const { page } = app;
    // Wide enough to take in the fake Shodan hosts and ALPR cameras.
    await lookAt(page, { lat: 40.81, lon: -73.75, h: 40000 });
    await page.evaluate(() => WV.refreshAll());
    await page.waitForFunction(() => WV.layers.shodan.count > 0 && WV.layers.alpr.count > 0,
      { timeout: 60_000, polling: 250 });
    assert.equal(await page.evaluate(() => WV.layers.shodan.status), 'ok');
  });

  test('FLUSH, SYNC and the R shortcut are switched off and say why', async () => {
    const { page } = app;
    const before = await page.evaluate(() => window.__toasts.length);
    assert.equal(await page.$eval('#flush-cache', (n) => n.classList.contains('demo-off')), true);
    await page.click('#flush-cache');
    await page.click('#refresh-now');
    await page.keyboard.press('r');
    await page.waitForFunction((n) => window.__toasts.length >= n + 3, { timeout: 10_000 }, before);
    const toasts = await page.evaluate((n) => window.__toasts.slice(n), before);
    for (const t of toasts.slice(0, 3)) assert.match(t, /Not available in the demo/);
    assert.ok(!site.seen.some((p) => p.endsWith('/api/flush')));
  });

  test('the demo layer set: no orbits, every OSM class, network infrastructure', async () => {
    const { page } = app;
    const st = await page.evaluate(() => ({
      sat: WV.layers.satellites.enabled, satLocked: WV.locked.satellites,
      osm: WV.layers.overpass.enabled, classes: [...WV.layers.overpass.presets].sort(),
      all: Object.keys(WV.health.presets.overpass).sort(), net: WV.layers.netinfra.enabled,
    }));
    assert.equal(st.sat, false);
    assert.match(st.satLocked, /Not part of the demo/);
    assert.equal(await page.$eval('.layer[data-layer="satellites"] .layer-count', (n) => n.textContent), 'OFF');
    await page.evaluate(() => WV.layers.satellites.setEnabled(true));
    assert.equal(await page.evaluate(() => WV.layers.satellites.enabled), false, 'stays off');
    assert.equal(st.osm, true);
    assert.deepEqual(st.classes, st.all);
    assert.equal(st.net, true);
  });

  test('saved targets and the reset button are not shown', async () => {
    const { page } = app;
    const hidden = (sel) => page.$eval(sel, (n) => getComputedStyle(n).display === 'none'
      || !n.offsetParent || getComputedStyle(n.closest('section, .panel-actions')).display === 'none');
    assert.equal(await hidden('#targets'), true);
    assert.equal(await hidden('#reset-settings'), true);
    assert.equal(await page.$eval('#layers', (n) => getComputedStyle(n.closest('section')).display !== 'none'), true);
  });

  test('settings are not kept between visits', async () => {
    const { page } = app;
    await page.evaluate(() => { WV.layers.alpr.setEnabled(false); WV.persist?.(); });
    await new Promise((r) => setTimeout(r, 1500));     // past the debounced save
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.WV?.restoring === false, { timeout: 90_000, polling: 250 });
    assert.equal(await page.evaluate(() => WV.layers.alpr.enabled), true, 'back to the demo defaults');
    assert.equal(await page.evaluate(() => WV.layers.shodan.enabled), true);
  });

  test('the base-map menu offers the captured street map and satellite mosaic', async () => {
    const { page } = app;
    const opts = await page.$$eval('#bm-provider option', (os) => os.filter((o) => !o.disabled).map((o) => o.value));
    assert.deepEqual(opts.sort(), ['osm', 's2cloudless', 'shortbread']);
    await page.select('#bm-provider', 's2cloudless');
    await page.waitForFunction(() => WV.basemap.status === 'ok'
      && /data\/tiles\/s2cloudless\//.test(WV.viewer.imageryLayers.get(0).imageryProvider.url || ''), { timeout: 20_000 });
    assert.match(await textOf(page, '#bm-note'), /EOX/);
    assert.equal(await page.$eval('#bm-window', (n) => n.style.display), 'none', 'no date window for a mosaic');
    await page.select('#bm-provider', 'osm');
    await page.waitForFunction(() => /data\/tiles\/osm\//.test(WV.viewer.imageryLayers.get(0).imageryProvider.url || ''),
      { timeout: 20_000 });
    // Neither went to the publishers' own servers.
    assert.ok(!app.external.some((u) => /tile\.openstreetmap\.org|maps\.eox\.at/.test(u)));
    await page.select('#bm-provider', 'shortbread');
  });

  test('place search uses the captured names', async () => {
    const { page } = app;
    await page.click('#search');
    await page.type('#search', 'substation');
    await page.waitForFunction(() => /Test Substation/.test(document.querySelector('#search-results')?.textContent || ''),
      { timeout: 15_000 });
  });

  test('OpenStreetMap buildings appear close in, instead of Cesium Ion', async () => {
    const { page } = app;
    await lookAt(page, { ...app.buildingsAt, h: 1500 });
    await page.waitForFunction(() => {
      const ps = WV.viewer.scene.primitives;
      for (let i = 0; i < ps.length; i++) {
        const p = ps.get(i);
        if (p instanceof Cesium.Primitive && p.show && p.ready) return true;
      }
      return false;
    }, { timeout: 120_000, polling: 500 });
  });
});

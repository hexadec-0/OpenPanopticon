// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * The top bar, the HUD, keyboard shortcuts, search, saved targets, the home
 * editor and the auto-cycle control.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { e2e, useStack, HOME, status, text$, hasClass, waitClass, waitToast, waitSaved, row } from './setup.mjs';
import { waitForLayer, lookAt, pickFirst } from '../helpers/browser.mjs';

/** Record calls to the app's flyTo without waiting for the flight. */
const spyFlights = (page) => page.evaluate(() => {
  window.__flights = [];
  const orig = WV.flyTo.bind(WV);
  WV.flyTo = (t) => { window.__flights.push(t); return orig(t); };
});
const flights = (page) => page.evaluate(() => window.__flights);

e2e('top bar, HUD and keyboard', () => {
  const stack = useStack();
  let page;
  before(async () => {
    await stack.reset();
    ({ page } = await stack.open());
  });

  test('optics buttons switch the sensor mode, the HUD and the post-process stage', async () => {
    const labels = await page.$$eval('#optics .optic', (bs) => bs.map((b) => b.textContent));
    assert.deepEqual(labels, ['EO', 'FLIR', 'SAR', 'CRT', 'CEL']);
    for (const [mode, label] of [['flir', 'FLIR'], ['sar', 'SAR'], ['crt', 'CRT'], ['cel', 'CEL'], ['eo', 'EO']]) {
      await page.click(`#optics .optic[data-mode="${mode}"]`);
      assert.equal(await page.$eval('body', (b) => b.dataset.mode), mode);
      assert.equal(await text$(page, '#hud-mode'), label);
      assert.equal(await hasClass(page, `#optics .optic[data-mode="${mode}"]`, 'active'), true);
      const stages = await page.evaluate(() => WV.viewer.scene.postProcessStages.length);
      assert.equal(stages > 0, mode !== 'eo', mode);
    }
    assert.match(await page.$eval('#optics .optic[data-mode="flir"]', (b) => b.title), /Thermal infrared/);
  });

  test('keys 1–5 pick the optic', async () => {
    await page.keyboard.press('3');
    assert.equal(await text$(page, '#hud-mode'), 'SAR');
    await page.keyboard.press('1');
    assert.equal(await text$(page, '#hud-mode'), 'EO');
    await page.keyboard.press('9');
    assert.equal(await text$(page, '#hud-mode'), 'EO', 'no sixth mode');
  });

  test('shortcuts are ignored while typing in a field', async () => {
    await page.focus('#search');
    await page.keyboard.type('2');
    assert.equal(await text$(page, '#hud-mode'), 'EO');
    await page.$eval('#search', (n) => { n.value = ''; n.blur(); });
  });

  test('H hides the chrome; [ collapses the sensor panel', async () => {
    await page.keyboard.press('h');
    assert.equal(await hasClass(page, 'body', 'chrome-hidden'), true);
    await page.keyboard.press('h');
    assert.equal(await hasClass(page, 'body', 'chrome-hidden'), false);
    await page.keyboard.press('[');
    assert.equal(await hasClass(page, 'body', 'sidebar-collapsed'), true);
    assert.equal(await page.$eval('#sidebar-toggle', (b) => b.getAttribute('aria-expanded')), 'false');
    await page.click('#sidebar-toggle');
    assert.equal(await hasClass(page, 'body', 'sidebar-collapsed'), false);
    assert.equal(await page.$eval('#sidebar-toggle', (b) => b.getAttribute('aria-expanded')), 'true');
  });

  test('the FETCH cell cycles the query ceiling, and holds layers above it', async () => {
    assert.equal(await text$(page, '#hud-gate'), 'ON <45km');
    await page.click('#hud-gate');
    await waitToast(page, /Queries now start below 100 km/);
    await page.waitForFunction(() => /100km/.test(document.querySelector('#hud-gate').textContent));
    for (const km of [250, 500, 45]) {
      await page.click('#hud-gate');
      await page.waitForFunction((k) => document.querySelector('#hud-gate').textContent.includes(`${k}km`), {}, km);
    }
    // Climb above the ceiling: view-bound layers hold, orbits carry on.
    try {
      await lookAt(page, { lat: HOME.lat, lon: HOME.lon, h: 200_000 });
      // A fetch already in flight when the camera climbed can still land and
      // report "ok", so settle and ask again until the hold shows.
      await page.waitForFunction(async () => {
        await WV.refreshAll();
        return WV.layers.flights.status === 'held';
      }, { timeout: 20_000, polling: 500 });
      // The HUD is redrawn per frame, which under software WebGL can be
      // seconds apart.
      await page.waitForFunction(() => /HOLD ▲45km/.test(document.querySelector('#hud-gate').textContent), { timeout: 20_000 });
      assert.equal(await text$(page, `${row('flights')} .layer-count`), '↓');
      assert.equal(await page.evaluate(() => WV.layers.satellites.status), 'ok');
      await waitToast(page, /Holding at 200 km/);
    } finally {
      await lookAt(page, { lat: HOME.lat, lon: HOME.lon, h: 4000 });
      await page.evaluate(() => WV.refreshAll());
      await waitForLayer(page, 'flights');
    }
  });

  test('AUTO toggles to HOLD and the HUD says auto-refresh is paused', async () => {
    await page.click('#auto-toggle');
    assert.equal(await text$(page, '#auto-toggle span'), 'HOLD');
    assert.equal(await hasClass(page, '#auto-toggle', 'active'), false);
    await page.evaluate(() => WV.renderHud());
    assert.equal(await text$(page, '#hud-gate'), 'PAUSED');
    await page.click('#auto-toggle');
    assert.equal(await text$(page, '#auto-toggle span'), 'AUTO');
  });

  // Regressions: these two readouts sat behind an earlier `id === 'flights'`
  // branch in renderLayerStatus() and could never appear.
  test('under HOLD the aircraft count says how old it is', async () => {
    await page.click('#auto-toggle');
    try {
      await page.evaluate(() => WV.renderLayerStatus());
      assert.match(await text$(page, `${row('flights')} .layer-count`), /old$|PAUSED/);
    } finally { await page.click('#auto-toggle'); }
  });

  test('the aircraft tooltip shows the poll interval and remaining credits', async () => {
    await page.evaluate(() => WV.renderLayerStatus());
    assert.match(await page.$eval(`${row('flights')} .layer-count`, (n) => n.title), /Polling every \d+s[\s\S]*OpenSky credits left today/);
  });

  // Regression: renderLayerStatus() used to empty #alerts on every redraw,
  // so toasts vanished within a second.
  test('a toast stays up for its full six seconds', async () => {
    await page.evaluate(() => WV.toast('persistent toast'));
    await page.evaluate(() => WV.renderLayerStatus());
    assert.equal(await page.$$eval('#alerts .alert', (as) => as.some((a) => a.textContent === 'persistent toast')), true);
    // Leaving HOLD clears the "waiting" style the paused readout set.
    await page.evaluate(() => WV.renderLayerStatus());
    assert.equal(await hasClass(page, row('flights'), 'waiting'), false);
  });

  test('SYNC refetches everything from source, past every cache', async () => {
    const before = stack.server.mock.callsTo('/api/states/all').length;
    await page.click('#refresh-now');
    await waitToast(page, /Refreshing from source/);
    await page.waitForFunction(() => WV.layers.flights.status === 'ok');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(stack.server.mock.callsTo('/api/states/all').length > before);
  });

  test('R is the SYNC shortcut', async () => {
    await page.keyboard.press('r');
    await waitToast(page, /Refreshing from source/);
  });

  test('FLUSH empties the browser and server caches and says how much', async () => {
    await page.click('#flush-cache');
    await waitToast(page, /Cache flushed — [\d,]+ features dropped, \d+ stored responses cleared\./);
  });

  test('the detail panel can be widened, and a double-click resets it', async () => {
    await page.waitForFunction(() => WV.layers.events.status === 'ok' && WV.layers.events.count > 0, { timeout: 20_000 });
    assert.equal(await pickFirst(page, 'events'), true);
    await waitClass(page, '#detail', 'open');
    const handle = await page.$('#detail-resize');
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x - 200, box.y + 100, { steps: 5 });
    await page.mouse.up();
    const w = await page.evaluate(() => document.documentElement.style.getPropertyValue('--detail-w'));
    assert.match(w, /^\d+px$/);
    assert.ok(await page.evaluate(() => localStorage.getItem('openpanopticon.detailWidth')));
    await page.mouse.click(box.x - 200 + 2, box.y + 100, { clickCount: 2 });
    await page.$eval('#detail-resize', (n) => n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--detail-w')), '');
    await page.keyboard.press('Escape');
  });

  test('the inset map: street/aerial switch (remembered) and zoom buttons', async () => {
    assert.equal(await pickFirst(page, 'events'), true);
    await page.waitForSelector('#detail-body .inset-bar');
    const z0 = await text$(page, '.inset-coord');
    await page.$$eval('.inset-bar button', (bs) => bs.find((b) => b.textContent === '+').click());
    assert.notEqual(await text$(page, '.inset-coord'), z0);
    await page.$$eval('.inset-bar button', (bs) => bs.find((b) => b.textContent === 'Aerial').click());
    assert.equal(await page.evaluate(() => localStorage.getItem('openpanopticon.insetStyle')), 'aerial');
    const src = await page.$eval('.inset-tiles img', (i) => i.src);
    assert.match(src, /arcgisonline\.com/);
    assert.match(await text$(page, '.inset-credit'), /Esri/);
    await page.keyboard.press('Escape');
  });
});

e2e('search, targets and home', () => {
  const stack = useStack();
  let page;
  before(async () => {
    await stack.reset();
    ({ page } = await stack.open());
    await spyFlights(page);
  });

  test('typing a place shows Nominatim results; picking one flies there', async () => {
    await page.type('#search', 'Testville');
    await page.waitForSelector('#search-results.open .hit');
    const hits = await page.$$eval('#search-results .hit', (hs) => hs.map((h) => h.querySelector('strong').textContent));
    assert.deepEqual(hits, ['Testville', 'Test Lake']);
    await page.click('#search-results .hit');
    assert.equal(await page.$eval('#search', (n) => n.value), 'Testville');
    assert.equal(await hasClass(page, '#search-results', 'open'), false);
    const f = (await flights(page)).at(-1);
    assert.equal(f.lat, HOME.lat);
    assert.equal(f.lon, HOME.lon);
    assert.ok(Math.abs(f.h - 32000) < 1e-6, 'height scales with the place\'s size');
  });

  test('one character is not searched; an empty result set stays closed', async () => {
    await page.$eval('#search', (n) => { n.value = ''; });
    await page.type('#search', 'T');
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await hasClass(page, '#search-results', 'open'), false);
    await page.$eval('#search', (n) => { n.value = ''; });
    await page.type('#search', 'nowhere at all');
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(await hasClass(page, '#search-results', 'open'), false);
  });

  test('a failing geocoder says so in the results', async () => {
    stack.server.mock.on('nominatim', () => status(503, 'busy'));
    await page.$eval('#search', (n) => { n.value = ''; });
    await page.type('#search', 'Somewhere else');
    await page.waitForSelector('#search-results.open .hit.err');
    assert.match(await text$(page, '#search-results .hit.err'), /Nominatim returned HTTP 503/);
    stack.server.mock.reset();
  });

  test('saved targets fly to their place', async () => {
    const names = await page.$$eval('#targets .target', (bs) => bs.map((b) => b.textContent));
    assert.deepEqual(names.slice(0, 2), ['⌂ Home', '⋯']);
    assert.ok(names.includes('London') && names.includes('Suez Canal'));
    await page.$$eval('#targets .target', (bs) => bs.find((b) => b.textContent === 'London').click());
    const f = (await flights(page)).at(-1);
    assert.equal(f.lat, 51.5072);
  });

  test('the home editor: open, validate, pin, and show it as pinned', async () => {
    await page.click('#targets .home-edit');
    assert.equal(await page.$eval('#home-editor', (n) => n.hidden), false);
    assert.equal(await page.$eval('#targets .home-edit', (n) => n.getAttribute('aria-expanded')), 'true');
    assert.match(await text$(page, '#he-current'), /Testville.*host geolocation/);
    assert.equal(await page.$eval('#he-clear', (n) => n.disabled), true, 'nothing pinned to clear');

    await page.$eval('#he-lat', (n) => { n.value = ''; });
    await page.$eval('#he-lon', (n) => { n.value = '-0.12'; });
    await page.click('#he-save');
    await waitToast(page, /Home needs a numeric latitude and longitude/);

    await page.$eval('#he-lat', (n) => { n.value = '95'; });
    await page.click('#he-save');
    await waitToast(page, /Latitude must be between -90 and 90/);

    await page.$eval('#he-lat', (n) => { n.value = '51.5'; });
    await page.$eval('#he-name', (n) => { n.value = 'The Office'; });
    await page.focus('#he-name');
    await page.keyboard.press('Enter');
    await waitToast(page, /Home set: The Office/);
    assert.equal(await text$(page, '#hud-home'), 'The Office');
    assert.match(await page.$eval('#hud-home', (n) => n.title), /^Pinned home — 51\.5000°N 0\.1200°W$/);
    assert.equal(await hasClass(page, '#he-current', 'pinned'), true);
    assert.equal(await page.$eval('#he-clear', (n) => n.disabled), false);
    await waitSaved(page, (st) => st?.home?.label === 'The Office');
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('openpanopticon.settings.v1')));
    assert.deepEqual({ lat: saved.home.lat, lon: saved.home.lon, label: saved.home.label, source: saved.home.source },
      { lat: 51.5, lon: -0.12, label: 'The Office', source: 'manual' });
  });

  test('⌂ Home flies to the pinned home', async () => {
    await page.click('#targets .home');
    const f = (await flights(page)).at(-1);
    assert.equal(f.lat, 51.5);
  });

  test('"Use current view" pins the camera position and altitude', async () => {
    await lookAt(page, { lat: 40.0, lon: -75.0, h: 12_345 });
    await page.$eval('#he-name', (n) => { n.value = ''; });
    await page.click('#he-here');
    await waitToast(page, /Home pinned: 40\.0000°N 75\.0000°W/);
    const h = await page.evaluate(() => WV.home);
    assert.ok(Math.abs(h.h - 12_345) < 1);
    assert.equal(h.source, 'manual');
  });

  test('"Geolocate host" pins the host location fresh from the server', async () => {
    const before = stack.server.mock.callsTo('ipwho.is').length;
    await page.click('#he-geolocate');
    await waitToast(page, /Home pinned to host location: Testville/);
    assert.equal(stack.server.mock.callsTo('ipwho.is').length, before + 1, 'fresh=1 bypassed the cache');
    assert.equal(await page.evaluate(() => WV.home.source), 'geoip-pinned');
    assert.match(await page.$eval('#hud-home', (n) => n.title), /Pinned from host geolocation/);
  });

  test('Clear forgets the pin and resolves the host again', async () => {
    await page.click('#he-clear');
    await waitToast(page, /Home cleared/);
    assert.equal(await page.evaluate(() => WV.home.source), 'geoip');
    await waitSaved(page, (st) => st && st.home === null);
  });
});

e2e('auto-cycle', () => {
  const stack = useStack();
  let page;
  before(async () => {
    await stack.reset();
    ({ page } = await stack.open());
    await lookAt(page, { lat: HOME.lat + 0.003, lon: HOME.lon, h: 5000 });
    await page.evaluate(() => WV.refreshAll());
    await waitForLayer(page, 'events');
  });

  test('lists a checkbox per layer that opens a detail panel', async () => {
    const types = await page.$$eval('#cycle-types .cycle-type', (rs) => rs.map((r) => r.dataset.layer));
    assert.equal(types.length, 11);
    assert.ok(types.includes('events') && types.includes('satellites'));
    assert.equal(await hasClass(page, '#cycle-types .cycle-type[data-layer="shodan"]', 'layer-off'), true);
  });

  test('CYCLE selects something in view straight away and counts down', async () => {
    await page.click('#cycle-toggle');
    assert.equal(await hasClass(page, '#cycle-toggle', 'active'), true);
    await waitClass(page, '#detail', 'open');
    await page.waitForFunction(() => /^\d+s$/.test(document.querySelector('#cycle-count').textContent));
    assert.match(await page.$eval('#cycle-toggle', (b) => b.title), /every 15s — click to stop/);
  });

  test('interval buttons and the None/All shortcuts', async () => {
    await page.$$eval('.cycle-step', (bs) => bs.find((b) => b.dataset.s === '60').click());
    assert.equal(await hasClass(page, '.cycle-step[data-s="60"]', 'active'), true);
    assert.equal(await page.evaluate(() => WV.autoCycle.intervalS), 60);
    await page.$eval('#cycle-none', (b) => b.click());
    assert.equal(await page.$$eval('#cycle-types input:checked', (cs) => cs.length), 0);
    await page.$eval('#cycle-all', (b) => b.click());
    assert.equal(await page.$$eval('#cycle-types input:checked', (cs) => cs.length), 11);
  });

  test('C stops it', async () => {
    await page.keyboard.press('c');
    assert.equal(await hasClass(page, '#cycle-toggle', 'active'), false);
    assert.equal(await text$(page, '#cycle-count'), '60s');
  });

  test('with nothing in view it says so', async () => {
    await page.$eval('#cycle-none', (b) => b.click());
    await page.click('#cycle-toggle');
    await waitToast(page, /Nothing selectable in view yet/);
    assert.equal(await text$(page, '#cycle-count'), '—');
    await page.click('#cycle-toggle');
  });
});

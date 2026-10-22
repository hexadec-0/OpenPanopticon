// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { e2e, useStack, TEST_KEYS, HOME, status, text$, hasClass, row } from './setup.mjs';
import { waitForLayer } from '../helpers/browser.mjs';

e2e('boot', () => {
  const stack = useStack();

  test('loads the globe, restores the session and opens over the host', async () => {
    await stack.reset();
    const { page, errors } = await stack.open();
    assert.equal(await page.title(), 'OpenPanopticon - OSINT Data Fusion');
    assert.equal(await page.$('.brand .ver'), null, 'no version badge');
    assert.doesNotMatch(await page.evaluate(() => document.body.textContent), /ver\.\s*\d/, 'no version on the page or splash');
    assert.equal(await text$(page, '#hud-home'), `${HOME.city}, ${HOME.region}, ${HOME.country}`);
    assert.match(await page.$eval('#hud-home', (n) => n.title), /Resolved from the host’s network address/);
    await page.waitForFunction(() => !document.querySelector('#boot'), { timeout: 5000 });   // removed after its fade
    assert.ok(await page.$('#globe canvas'), 'Cesium canvas present');
    assert.equal(await page.evaluate(() => WV.viewer.scene.context?.webgl2 !== undefined), true);
    assert.deepEqual(errors.map((e) => e.message), []);
  });

  test('runs under its enforced CSP without a single violation', async () => {
    await stack.reset();
    const { page } = await stack.open();
    for (const id of ['flights', 'satellites', 'events']) await waitForLayer(page, id);
    assert.deepEqual(await page.evaluate(() => window.__csp), []);
  });

  test('the CSP is a backstop: markup that skips esc() still cannot run script', async () => {
    await stack.reset();
    const { page } = await stack.open();
    await page.evaluate(() => {
      const d = document.createElement('div');
      d.innerHTML = '<img src="data:," onerror="window.__xss=1"><a id="jsurl" href="javascript:window.__xss=2">x</a>';
      document.body.append(d);
      d.querySelector('#jsurl').click();
    });
    await page.waitForFunction(() => window.__csp.length >= 1, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.ok((await page.evaluate(() => window.__csp)).some((v) => /^script-src/.test(v)));
  });

  test('first run switches on aircraft, satellites and hazards, and they draw', async () => {
    await stack.reset();
    const { page } = await stack.open();
    for (const id of ['flights', 'satellites', 'events']) {
      await waitForLayer(page, id);
      assert.equal(await hasClass(page, row(id), 'on'), true, id);
      assert.notEqual(await text$(page, `${row(id)} .layer-count`), '—', id);
    }
    assert.equal(await text$(page, `${row('flights')} .layer-count`), '3');
    assert.equal(await text$(page, `${row('satellites')} .layer-count`), '2');
    for (const id of ['shodan', 'overpass', 'alpr', 'webcams', 'netinfra', 'iot', 'traffic', 'vessels']) {
      assert.equal(await hasClass(page, row(id), 'on'), false, id);
    }
    const tracks = Number(await text$(page, '#hud-tracks'));
    assert.ok(tracks >= 12, `HUD tracks ${tracks}`);
  });

  test('the HUD shows position, altitude, heading, time, fetch state and frame rate', async () => {
    await stack.reset();
    const { page } = await stack.open();
    await page.waitForFunction(() => /fps|STALLED/.test(document.querySelector('#hud-fps').textContent), { timeout: 10_000 });
    assert.match(await text$(page, '#hud-eye'), /^\d+\.\d{4}°N\s+\d+\.\d{4}°W$/);
    assert.match(await text$(page, '#hud-alt'), /^4,500 m$/);
    assert.match(await text$(page, '#hud-hdg'), /^\d{3}°$/);
    assert.match(await text$(page, '#hud-time'), /^\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(await text$(page, '#hud-gate'), 'ON <45km');
    assert.equal(await text$(page, '#hud-mode'), 'EO');
  });

  test('the browser never sends an API key anywhere', async () => {
    await stack.reset();
    const { page, external } = await stack.open();
    const urls = [];
    page.on('request', (r) => urls.push(r.url() + (r.postData() || '')));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.WV?.layers?.events?.status === 'ok', { timeout: 60_000 });
    for (const v of Object.values(TEST_KEYS)) {
      if (!/SECRET/.test(v)) continue;
      for (const u of [...urls, ...external]) assert.ok(!u.includes(v), `${v} sent in ${u}`);
    }
    const html = await page.content();
    for (const v of Object.values(TEST_KEYS)) if (/SECRET/.test(v)) assert.ok(!html.includes(v));
  });

  test('third-party requests are limited to tiles, fonts and imagery', async () => {
    await stack.reset();
    const { external } = await stack.open();
    const hosts = new Set(external.map((u) => new URL(u).host));
    for (const h of hosts) {
      assert.match(h, /fonts\.(googleapis|gstatic)\.com|tile\.openstreetmap\.org|arcgisonline|gibs|rainviewer|versatiles|cartocdn|photos|images|cdnjs/, h);
    }
  });

  test('if the server cannot be reached, the boot screen says OFFLINE and why', async () => {
    const { page } = await stack.open({
      waitForBoot: false,
      intercept: (req) => {
        if (new URL(req.url()).pathname === '/api/health') { req.abort('connectionrefused'); return true; }
        return false;
      },
    });
    await page.waitForSelector('#boot .fatal', { timeout: 30_000 });
    assert.equal(await text$(page, '#boot .fatal h1'), 'OFFLINE');
    assert.match(await text$(page, '#boot .fatal p'), /^Cannot reach the OpenPanopticon server: /);
  });

  test('a fatal message is shown as text, never as markup', async () => {
    const { page } = await stack.open({
      waitForBoot: false,
      intercept: (req) => {
        if (new URL(req.url()).pathname === '/api/health') {
          req.respond({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: '<img src=x onerror="window.__xss=1">' }) });
          return true;
        }
        return false;
      },
    });
    await page.waitForSelector('#boot .fatal', { timeout: 30_000 });
    assert.match(await text$(page, '#boot .fatal p'), /<img src=x/);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  });

  test('at a narrow width the chrome reflows and the bars below it follow', async () => {
    await stack.reset();
    const { page } = await stack.open();
    await page.setViewport({ width: 760, height: 900 });
    await page.waitForFunction(() => {
      const h = Math.round(document.querySelector('#topbar').getBoundingClientRect().height);
      return getComputedStyle(document.documentElement).getPropertyValue('--topbar-h').trim() === `${h}px`;
    }, { timeout: 5000 });
    const h = await page.$eval('#topbar', (n) => n.getBoundingClientRect().height);
    assert.ok(h > 60, `top bar wraps (${h}px)`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'no sideways scroll');
  });

  test('controls carry accessible names', async () => {
    await stack.reset();
    const { page } = await stack.open();
    const unnamed = await page.$$eval('button, select, input', (els) => els
      .filter((e) => e.offsetParent !== null || e.closest('.hover-menu'))
      .filter((e) => !(e.getAttribute('aria-label') || e.title || e.textContent.trim() || e.closest('label') || e.placeholder))
      .map((e) => e.outerHTML.slice(0, 80)));
    assert.deepEqual(unnamed, []);
  });

  test('if geoIP fails, it opens over Austin and says so', async () => {
    await stack.reset();
    stack.server.mock.fail('ipwho.is', 500);
    const { page } = await stack.open();
    assert.equal(await text$(page, '#hud-home'), 'Austin, TX (geoIP unavailable)');
    assert.match(await page.$eval('#hud-home', (n) => n.title), /could not be resolved/);
  });
});

e2e('boot without any API keys', () => {
  const stack = useStack({ env: {} });

  test('keyed layers are locked off and say which variable they need', async () => {
    await stack.reset();
    const { page } = await stack.open();
    const expect = { shodan: 'SHODAN_API_KEY', vessels: 'AISSTREAM_API_KEY', traffic: 'FIVE_ELEVEN_KEYS' };
    for (const [id, key] of Object.entries(expect)) {
      assert.equal(await hasClass(page, row(id), 'locked'), true, id);
      assert.equal(await text$(page, `${row(id)} .layer-count`), 'NO KEY');
      assert.equal(await page.$eval(`${row(id)} .switch`, (n) => n.disabled), true);
      assert.match(await text$(page, `${row(id)} .layer-lock`), new RegExp(key));
    }
    await page.click(`${row('shodan')} .layer-head .layer-name`);
    await page.evaluate(() => WV.layers.shodan.setEnabled(true));
    assert.equal(await page.evaluate(() => WV.layers.shodan.enabled), false, 'cannot be switched on by any route');
  });

  test('a saved session cannot switch a locked layer on', async () => {
    await stack.reset();
    const { page } = await stack.open({ storage: { 'openpanopticon.settings.v1': { enabled: { shodan: true, flights: true } } } });
    assert.equal(await page.evaluate(() => WV.layers.shodan.enabled), false);
    assert.equal(await page.evaluate(() => WV.layers.flights.enabled), true);
  });

  test('the labels button explains the missing CARTO key', async () => {
    await stack.reset();
    const { page } = await stack.open();
    assert.equal(await page.$eval('#wx-labels', (n) => n.disabled), true);
    assert.equal(await hasClass(page, '#wx-labels', 'nokey'), true);
    assert.match(await page.$eval('#wx-labels', (n) => n.title), /CARTO_API_KEY/);
  });

  test('anonymous OpenSky is described as such', async () => {
    await stack.reset();
    const { page } = await stack.open();
    assert.match(await text$(page, `${row('flights')} .note`), /OpenSky anonymous — 10s resolution/);
  });

  test('unconfigured event sources are greyed out', async () => {
    await stack.reset();
    const { page } = await stack.open();
    const chips = await page.$$eval(`${row('events')} .chip`, (cs) => cs.map((c) => [c.textContent, c.disabled]));
    assert.deepEqual(Object.fromEntries(chips)['NASA FIRMS fires'], true);
    assert.deepEqual(Object.fromEntries(chips)['RSOE EDIS'], true);
    assert.deepEqual(Object.fromEntries(chips)['USGS quakes'], false);
  });

  test('a server error on one layer shows in the panel and as an alert', async () => {
    await stack.reset();
    stack.server.mock.on('earthquake.usgs.gov', () => status(500, 'boom'));
    stack.server.mock.on('www.gdacs.org', () => status(500, 'boom'));
    stack.server.mock.on('eonet', () => status(500, 'boom'));
    stack.server.mock.on('api.weather.gov', () => status(500, 'boom'));
    const { page } = await stack.open();
    await waitForLayer(page, 'events', { status: 'error' });
    await page.waitForFunction(() => document.querySelector('.layer[data-layer="events"]').classList.contains('failed'));
    assert.match(await text$(page, `${row('events')} .layer-count`), /^(30s|29s|ERR)$/);
    assert.match(await page.$eval(`${row('events')} .layer-count`, (n) => n.title), /Retrying in/);
    assert.match(await page.$eval('#alerts', (n) => n.textContent), /Situational awareness: .*HTTP 500/);
  });
});

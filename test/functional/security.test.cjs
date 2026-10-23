// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * The request gate: Host allow-list, the X-Panopticon header, POST-only
 * routes, the access key when bound beyond loopback, response hardening, and
 * the static file server's path checks.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../helpers/harness.cjs');
const { TEST_KEYS } = require('../helpers/fixtures.cjs');

describe('loopback server', () => {
  let s;
  before(async () => { s = await startServer({ env: { ...TEST_KEYS, ALLOWED_HOSTS: 'penguin.linux.test:9999, Extra.Example:1' } }); });
  after(() => s.close());

  describe('Host allow-list (DNS-rebinding defence)', () => {
    test('accepts 127.0.0.1, localhost and [::1] on the server port', async () => {
      for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, `[::1]:${s.port}`, `LOCALHOST:${s.port}`]) {
        const r = await s.api('/api/health', {}, { host });
        assert.equal(r.status, 200, host);
      }
    });

    test('accepts extra names from ALLOWED_HOSTS, case-insensitively', async () => {
      assert.equal((await s.api('/api/health', {}, { host: 'penguin.linux.test:9999' })).status, 200);
      assert.equal((await s.api('/api/health', {}, { host: 'extra.example:1' })).status, 200);
    });

    for (const host of ['evil.example', 'evil.example:80', '127.0.0.1', '127.0.0.1:1', 'localhost.evil.example']) {
      test(`refuses Host ${JSON.stringify(host)} with 421`, async () => {
        const r = await s.request('/api/health', { host, headers: { 'X-Panopticon': '1' } });
        assert.equal(r.status, 421);
        assert.equal(r.text, 'Misdirected request');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
      });
    }

    test('a request with no Host header at all is refused', async () => {
      // Node's own parser answers 400 before the handler runs; either is a refusal.
      const r = await s.request('/api/health', { host: '', headers: { 'X-Panopticon': '1' } });
      assert.ok([400, 421].includes(r.status), String(r.status));
    });

    test('static files are behind the same check', async () => {
      assert.equal((await s.request('/', { host: 'evil.example' })).status, 421);
    });
  });

  describe('X-Panopticon header', () => {
    test('/api/* without it is refused', async () => {
      const r = await s.request('/api/health');
      assert.equal(r.status, 403);
      assert.equal(r.json().error, 'missing X-Panopticon header');
    });

    test('a wrong value is refused too', async () => {
      assert.equal((await s.request('/api/health', { headers: { 'X-Panopticon': 'yes' } })).status, 403);
    });

    test('pages and assets do not need it', async () => {
      assert.equal((await s.request('/')).status, 200);
      assert.equal((await s.request('/js/app.js')).status, 200);
    });

    test('the header is checked before any upstream is touched', async () => {
      s.mock.calls.length = 0;
      await s.request(`/api/shodan?bbox=1,2,3,4`);
      assert.equal(s.mock.calls.length, 0);
    });
  });

  describe('methods', () => {
    test('/api/flush is POST-only', async () => {
      const r = await s.api('/api/flush');
      assert.equal(r.status, 405);
      assert.equal(r.headers.allow, 'POST');
      assert.equal((await s.api('/api/flush', {}, { method: 'POST' })).status, 200);
    });

    test('a free-form Shodan query is POST-only', async () => {
      const r = await s.api('/api/shodan', { bbox: '35,-100,35.1,-99.9', q: 'port:22' });
      assert.equal(r.status, 405);
      const p = await s.api('/api/shodan', { bbox: '35,-100,35.1,-99.9', q: 'port:22' }, { method: 'POST' });
      assert.equal(p.status, 200);
      assert.match(p.json().query, /^port:22 geo:/);
    });

    test('other routes accept GET and POST but not PUT or DELETE', async () => {
      assert.equal((await s.api('/api/health', {}, { method: 'POST' })).status, 200);
      for (const method of ['PUT', 'DELETE', 'PATCH']) {
        const r = await s.api('/api/health', {}, { method });
        assert.equal(r.status, 405, method);
        assert.equal(r.headers.allow, 'GET, POST');
      }
    });

    test('a CORS preflight is never approved', async () => {
      const r = await s.request('/api/health', {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.example', 'Access-Control-Request-Headers': 'x-panopticon' },
      });
      assert.notEqual(r.status, 200);
      assert.equal(r.headers['access-control-allow-origin'], undefined);
      assert.equal(r.headers['access-control-allow-headers'], undefined);
    });
  });

  describe('response hardening', () => {
    test('JSON responses carry the security headers and are not cached', async () => {
      const r = await s.api('/api/health');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-frame-options'], 'DENY');
      assert.equal(r.headers['referrer-policy'], 'strict-origin-when-cross-origin');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.match(r.headers['content-type'], /^application\/json/);
    });

    test('the page carries an enforced CSP; assets do not', async () => {
      const html = await s.request('/');
      assert.equal(html.headers['content-security-policy-report-only'], undefined, 'enforced, not report-only');
      const csp = html.headers['content-security-policy'];
      assert.ok(csp);
      for (const d of ["default-src 'self'", "script-src-attr 'none'", "object-src 'none'",
        "base-uri 'none'", "frame-ancestors 'none'"]) {
        assert.ok(csp.includes(d), d);
      }
      assert.ok(!/script-src[^;]*'unsafe-inline'/.test(csp), 'no inline scripts');
      const img = /img-src ([^;]*)/.exec(csp)[1].split(/\s+/);
      assert.ok(!img.includes('http:'), 'images are https only');
      assert.equal((await s.request('/js/app.js')).headers['content-security-policy'], undefined);
    });

    test('errors are JSON with the same headers', async () => {
      const r = await s.api('/api/nope');
      assert.equal(r.status, 404);
      assert.deepEqual(r.json(), { error: 'no such endpoint', path: '/api/nope' });
      assert.equal(r.headers['x-frame-options'], 'DENY');
    });
  });

  describe('keys stay on the server', () => {
    test('no configured secret appears in /api/health or /api/config', async () => {
      const bodies = [(await s.api('/api/health')).text, (await s.api('/api/config')).text];
      for (const [name, value] of Object.entries(TEST_KEYS)) {
        if (!/SECRET/.test(value)) continue;
        for (const b of bodies) assert.ok(!b.includes(value), `${name} leaked`);
      }
    });

    test('nor in any API response', async () => {
      const bbox = '34.95,-100.05,35.05,-99.95';
      const routes = [
        ['/api/shodan', { bbox }], ['/api/flights', { bbox }], ['/api/webcams', { bbox }],
        ['/api/events', { bbox, sources: 'gdacs,eonet,usgs,nws,firms' }], ['/api/netinfra', { bbox, sources: 'atlas,cell,wigle,tor' }],
        ['/api/signals', { bbox }], ['/api/traffic', { bbox }], ['/api/enrich', { ip: '203.0.113.66' }],
      ];
      for (const [p, q] of routes) {
        const body = (await s.api(p, q)).text;
        for (const value of Object.values(TEST_KEYS)) {
          if (/SECRET/.test(value)) assert.ok(!body.includes(value), `${p} leaked ${value}`);
        }
      }
    });

    test('the Cesium Ion token is the one deliberate exception', async () => {
      const t = await startServer({ env: { CESIUM_ION_TOKEN: 'ion-browser-token' } });
      try {
        assert.equal((await t.api('/api/config')).json().cesiumIonToken, 'ion-browser-token');
      } finally { await t.close(); }
    });
  });

  describe('static files', () => {
    test('serves the page, scripts, styles and the bundled satellite.js', async () => {
      const cases = [
        ['/', /^text\/html/], ['/index.html', /^text\/html/], ['/js/app.js', /^text\/javascript/],
        ['/style.css', /^text\/css/], ['/providers/satellite.min.js', /^text\/javascript/],
      ];
      for (const [p, type] of cases) {
        const r = await s.request(p);
        assert.equal(r.status, 200, p);
        assert.match(r.headers['content-type'], type, p);
        assert.equal(r.headers['cache-control'], 'no-cache');
      }
    });

    test('the page carries no version text', async () => {
      const html = (await s.request('/')).text;
      assert.ok(!html.includes('__VERSION__'));
      assert.doesNotMatch(html, /ver\.(&nbsp;|\s)/);
    });

    test('the old /vendor path is gone', async () => {
      assert.equal((await s.request('/vendor/satellite.min.js')).status, 404);
    });

    test('unknown types are served as octet-stream', async () => {
      const r = await s.request('/providers/satellite.LICENSE');
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'application/octet-stream');
    });

    for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/server.js', '/../.env', '/js/../../server.js',
      '/....//server.js', '/..\\server.js', '/%2e%2e%5cserver.js']) {
      test(`does not serve files outside public/: ${p}`, async () => {
        const r = await s.request(p);
        assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
        assert.ok(!r.text.includes('OPENPANOPTICON'), 'server source leaked');
      });
    }

    test('a missing file is a plain 404', async () => {
      const r = await s.request('/nope.html');
      assert.equal(r.status, 404);
      assert.equal(r.text, '404 Not Found');
    });
  });
});

describe('server bound beyond loopback (access key)', () => {
  let s;
  const KEY = 'test-access-key-123';
  before(async () => {
    // A TEST-NET address the test never binds: CFG.host is what switches the
    // key on. The harness itself still listens on 127.0.0.1.
    s = await startServer({ env: { HOST: '192.0.2.10', ACCESS_KEY: KEY } });
  });
  after(() => s.close());

  test('the bound address joins the allow-list', () => {
    assert.ok(s.mod.ALLOWED_HOSTS.has(`192.0.2.10:${s.port}`));
    assert.equal(s.mod.ACCESS_KEY, KEY);
  });

  test('without the key, pages and API are refused with an explanation', async () => {
    const page = await s.request('/');
    assert.equal(page.status, 401);
    assert.match(page.text, /needs its access key/);
    assert.equal((await s.api('/api/health')).status, 401);
  });

  test('a wrong key is refused', async () => {
    assert.equal((await s.request('/?key=wrong')).status, 401);
    assert.equal((await s.request('/', { headers: { Cookie: 'op_access=wrong' } })).status, 401);
  });

  test('the right key is exchanged for an HttpOnly, SameSite=Strict cookie and dropped from the URL', async () => {
    const r = await s.request(`/?key=${KEY}&keep=1`);
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, '/?keep=1');
    const cookie = r.headers['set-cookie'][0];
    assert.match(cookie, new RegExp(`^op_access=${KEY};`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
  });

  test('the cookie then opens both the page and the API', async () => {
    const headers = { Cookie: `other=1; op_access=${KEY}` };
    assert.equal((await s.request('/', { headers })).status, 200);
    assert.equal((await s.api('/api/health', {}, { headers })).status, 200);
  });

  test('a generated key is used when none is configured', async () => {
    const t = await startServer({ env: { HOST: '0.0.0.0' } });
    try {
      assert.match(t.mod.ACCESS_KEY, /^[A-Za-z0-9_-]{24}$/);
      // 0.0.0.0 is not a name anyone connects to, so it is not allow-listed.
      assert.ok(![...t.mod.ALLOWED_HOSTS].some((h) => h.startsWith('0.0.0.0')));
    } finally { await t.close(); }
  });

  test('loopback binding needs no key', async () => {
    const t = await startServer({ env: { HOST: 'localhost' } });
    try {
      assert.equal(t.mod.ACCESS_KEY, null);
      assert.equal((await t.request('/')).status, 200);
    } finally { await t.close(); }
  });
});

describe('the CARTO tile proxy only serves this app', () => {
  let s;
  before(async () => { s = await startServer({ env: TEST_KEYS }); });
  after(() => s.close());
  const tile = '/tiles/carto/dark_only_labels/5/10/12.png';

  for (const site of ['cross-site', 'same-site']) {
    test(`a ${site} request is refused before CARTO is asked`, async () => {
      s.mock.calls.length = 0;
      const r = await s.request(tile, { headers: { 'Sec-Fetch-Site': site } });
      assert.equal(r.status, 403);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(s.mock.callsTo('basemaps.cartocdn.com').length, 0);
    });
  }

  for (const site of ['same-origin', 'none', undefined]) {
    test(`Sec-Fetch-Site ${site ?? '(absent)'} is served`, async () => {
      const r = await s.request(tile, { headers: site ? { 'Sec-Fetch-Site': site } : {} });
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'image/png');
    });
  }

  test('every response forbids cross-origin embedding', async () => {
    for (const p of ['/', '/js/app.js', tile]) {
      assert.equal((await s.request(p)).headers['cross-origin-resource-policy'], 'same-origin', p);
    }
    assert.equal((await s.api('/api/health')).headers['cross-origin-resource-policy'], 'same-origin');
  });
});

describe('the request log never holds what the operator typed', () => {
  let s;
  before(async () => { s = await startServer({ env: TEST_KEYS }); });
  after(() => s.close());

  test('loggable() drops typed values and keeps everything else as sent', () => {
    const L = (u) => s.mod.loggable(new URL(u, 'http://x'));
    assert.equal(L('/api/health'), '/api/health');
    assert.equal(L('/api/geocode?q=123+Secret+Street'), '/api/geocode?q=<redacted>');
    assert.equal(L('/api/geocode?%71=Secret&fresh=1'), '/api/geocode?%71=<redacted>&fresh=1');
    assert.equal(L('/api/shodan?bbox=1,2,3,4&q=port:22'), '/api/shodan?bbox=1,2,3,4&q=<redacted>');
    assert.equal(L('/api/x?%zz=1&q'), '/api/x?%zz=1&q=<redacted>');
  });

  test('a geocode search reaches the log redacted', async () => {
    const lines = [];
    const quiet = process.env.OPENPANOPTICON_QUIET;
    const realLog = console.log;
    process.env.OPENPANOPTICON_QUIET = '0';
    console.log = (...a) => lines.push(a.join(' '));
    try {
      await s.api('/api/geocode', { q: '123 Secret Street' });
    } finally {
      console.log = realLog;
      process.env.OPENPANOPTICON_QUIET = quiet;
    }
    assert.ok(lines.some((l) => l.includes('/api/geocode?q=<redacted>')), lines.join('\n'));
    assert.ok(!lines.some((l) => /secret/i.test(l)), lines.join('\n'));
  });
});

describe('lookup tables answer only for their own keys', () => {
  let s;
  before(async () => { s = await startServer({ env: TEST_KEYS }); });
  after(() => s.close());
  const bbox = '34.95,-100.05,35.05,-99.95';

  test('a Shodan preset of "constructor" is the default preset, not "undefined"', async () => {
    const r = await s.api('/api/shodan', { bbox, preset: 'constructor' });
    assert.equal(r.status, 200);
    assert.match(r.json().query, /^geo:"/);
  });

  for (const [p, q] of [
    ['/api/overpass', { bbox, presets: 'constructor' }],
    ['/api/overpass', { bbox, presets: '__proto__' }],
    ['/api/events', { bbox, sources: 'toString' }],
    ['/api/netinfra', { bbox, sources: 'constructor' }],
  ]) {
    test(`${p} refuses ${JSON.stringify(q.presets || q.sources)} as unknown (400, not 500)`, async () => {
      assert.equal((await s.api(p, q)).status, 400);
    });
  }

  test('a satellite group of "constructor" falls back to the default group', async () => {
    const r = await s.api('/api/satellites', { group: 'constructor' });
    assert.equal(r.status, 200);
    assert.equal(r.json().group, 'stations');
  });

  test('a minSeverity of "constructor" filters nothing out', async () => {
    const all = (await s.api('/api/events', { bbox })).json().count;
    const r = await s.api('/api/events', { bbox, minSeverity: 'constructor' });
    assert.equal(r.status, 200);
    assert.equal(r.json().count, all);
  });

  test('tables built from upstream values have no prototype', () => {
    for (const t of ['SHODAN_PRESETS', 'OVERPASS_PRESETS', 'SAT_GROUPS', 'FIVE_ELEVEN_HOSTS',
      'COUNTRY_CENTROIDS', 'MIME']) {
      assert.equal(Object.getPrototypeOf(s.mod[t]), null, t);
    }
  });
});

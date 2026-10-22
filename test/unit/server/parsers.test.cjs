// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadServer } = require('../../helpers/harness.cjs');

const { mod: S, restore } = loadServer();
after(restore);

describe('safeUrl (server-side URL scheme filter)', () => {
  test('keeps https and http', () => {
    assert.equal(S.safeUrl('https://example.org/a?b=1'), 'https://example.org/a?b=1');
    assert.equal(S.safeUrl('http://example.org/'), 'http://example.org/');
  });

  test('normalises surrounding whitespace', () => {
    assert.equal(S.safeUrl('  https://example.org/x  '), 'https://example.org/x');
  });

  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)', 'file:///etc/passwd',
    'ftp://example.org/', '/relative/path', '//example.org/protocol-relative', 'not a url', '', '   ']) {
    test(`drops ${JSON.stringify(bad)}`, () => assert.equal(S.safeUrl(bad), null));
  }

  test('drops non-strings', () => {
    for (const v of [null, undefined, 42, {}, ['https://x']]) assert.equal(S.safeUrl(v), null);
  });

  test('httpsOnly drops plain http (iframes run scripts)', () => {
    assert.equal(S.safeUrl('http://example.org/player', { httpsOnly: true }), null);
    assert.equal(S.safeUrl('https://example.org/player', { httpsOnly: true }), 'https://example.org/player');
  });
});

describe('clip / htmlText / refusalReason', () => {
  test('clip leaves short text alone', () => assert.equal(S.clip('short', 10), 'short'));

  test('clip cuts on a word boundary and marks the cut', () => {
    const out = S.clip('the quick brown fox jumps over the lazy dog', 20);
    assert.ok(out.length <= 20);
    assert.ok(out.endsWith('…'));
    assert.ok(!/\s…$/.test(out));
  });

  test('htmlText strips tags, scripts and entities', () => {
    assert.equal(S.htmlText('<p>a &amp; b</p><script>x()</script><style>p{}</style> c &nbsp; d'), 'a & b c d');
  });

  test('refusalReason reads the usual JSON fields', () => {
    assert.equal(S.refusalReason('{"error":"Invalid API key"}'), 'Invalid API key');
    assert.equal(S.refusalReason('{"message":"Too many requests"}'), 'Too many requests');
    assert.equal(S.refusalReason('{"detail":"nope"}'), 'nope');
    assert.equal(S.refusalReason('{"errors":["first","second"]}'), 'first');
    assert.equal(S.refusalReason('{"errors":[{"message":"nested"}]}'), 'nested');
    assert.equal(S.refusalReason('{"status":"bad"}'), '');
  });

  test('refusalReason condenses an HTML error page without repeating itself', () => {
    const page = '<html><head><title>500 Internal Server Error</title></head><body>'
      + '<h1>Internal Server Error</h1><p>The server encountered an internal error.</p></body></html>';
    const out = S.refusalReason(page);
    assert.match(out, /500 Internal Server Error/);
    assert.match(out, /encountered an internal error/);
    assert.equal(out.match(/Internal Server Error/g).length, 1);
  });

  test('refusalReason prefers an Overpass error paragraph', () => {
    const page = '<html><head><title>OSM3S Response</title></head><body>'
      + '<p>Intro text</p><p><strong>Error</strong>: runtime error: Query timed out</p></body></html>';
    const out = S.refusalReason(page);
    assert.match(out, /Query timed out/);
    assert.doesNotMatch(out, /OSM3S/);   // an uninformative title is dropped
  });

  test('refusalReason falls back to trimmed plain text and caps length', () => {
    assert.equal(S.refusalReason('  plain   reason \n'), 'plain reason');
    assert.ok(S.refusalReason('x '.repeat(500)).length <= 220);
    assert.equal(S.refusalReason(''), '');
  });
});

describe('parse511 / loadDotEnv', () => {
  test('parse511 reads STATE:key pairs and upper-cases the state', () => {
    assert.deepEqual(S.parse511('ga:abc, NY:def ,bad,:nokey,TX:'), { GA: 'abc', NY: 'def' });
    assert.deepEqual(S.parse511(''), {});
  });

  test('loadDotEnv reads KEY=value, strips quotes, skips comments, keeps existing values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-env-'));
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, [
      '# comment', 'OP_T_A=plain', 'OP_T_B="double quoted"', "OP_T_C='single'", '  OP_T_D = spaced  ',
      'OP_T_E=', 'not a line', 'OP_T_EXISTING=from-file', 'OP_T_CRLF=value', '',
    ].join('\r\n'));   // Windows line endings, as Notepad writes them
    process.env.OP_T_EXISTING = 'from-shell';
    try {
      S.loadDotEnv(file);
      assert.equal(process.env.OP_T_A, 'plain');
      assert.equal(process.env.OP_T_B, 'double quoted');
      assert.equal(process.env.OP_T_C, 'single');
      assert.equal(process.env.OP_T_D, 'spaced');
      assert.equal(process.env.OP_T_E, '');
      assert.equal(process.env.OP_T_EXISTING, 'from-shell');
      assert.equal(process.env.OP_T_CRLF, 'value');
    } finally {
      for (const k of Object.keys(process.env)) if (k.startsWith('OP_T_')) delete process.env[k];
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadDotEnv ignores a missing file', () => {
    assert.doesNotThrow(() => S.loadDotEnv('/definitely/not/here/.env'));
  });
});

describe('Shodan service categories', () => {
  test('product wins over port', () => {
    assert.equal(S.serviceCategory(80, 'Modbus', ''), 'ics');
    assert.equal(S.serviceCategory(443, 'Hikvision IP Camera', ''), 'camera');
  });

  test('banner text is consulted', () => {
    assert.equal(S.serviceCategory(9999, '', 'SSH-2.0-OpenSSH_8.9'), 'remote');
  });

  test('port fallback and default', () => {
    assert.equal(S.serviceCategory(3306, null, ''), 'database');
    assert.equal(S.serviceCategory(502, null, ''), 'ics');
    assert.equal(S.serviceCategory(12345, null, ''), 'other');
  });

  test('every preset has a label, a query and a note; "all" has no filter', () => {
    for (const [k, p] of Object.entries(S.SHODAN_PRESETS)) {
      assert.ok(p.label && p.note && typeof p.query === 'string', k);
    }
    assert.equal(S.SHODAN_PRESETS.all.query, '');
  });
});

describe('ALPR parsing', () => {
  test('parseDirections: degrees, compass points, multi-value, junk', () => {
    assert.deepEqual(S.parseDirections('265'), [265]);
    assert.deepEqual(S.parseDirections('NNE'), [22.5]);
    assert.deepEqual(S.parseDirections('nw'), [315]);
    assert.deepEqual(S.parseDirections('350;500'), [350]);     // 500 is not a bearing
    assert.deepEqual(S.parseDirections('90, 270'), [90, 270]);
    assert.deepEqual(S.parseDirections('360'), [0]);
    assert.deepEqual(S.parseDirections('-10'), []);
    assert.deepEqual(S.parseDirections('sideways'), []);
    assert.deepEqual(S.parseDirections(null), []);
    assert.deepEqual(S.parseDirections(''), []);
  });

  test('vendorOf matches manufacturer, brand, model or name', () => {
    assert.equal(S.vendorOf({ manufacturer: 'Flock Safety' }), 'flock');
    assert.equal(S.vendorOf({ brand: 'Vigilant Solutions' }), 'motorola');
    assert.equal(S.vendorOf({ 'camera:model': 'AutoVu SharpZ3' }), 'genetec');
    assert.equal(S.vendorOf({ name: 'Elsag reader' }), 'leonardo');
    assert.equal(S.vendorOf({}), 'other');
  });

  test('every vendor has a colour and only "other" has no matcher', () => {
    for (const v of S.ALPR_VENDORS) assert.match(v.color, /^#[0-9a-f]{6}$/i);
    assert.deepEqual(S.ALPR_VENDORS.filter((v) => !v.match).map((v) => v.key), ['other']);
  });
});

describe('small normalisers', () => {
  test('airQualityBand follows the WHO PM2.5 guideline', () => {
    assert.equal(S.airQualityBand(null), null);
    assert.equal(S.airQualityBand(15).band, 'good');
    assert.equal(S.airQualityBand(15.1).band, 'moderate');
    assert.equal(S.airQualityBand(50).band, 'poor');
    assert.equal(S.airQualityBand(200).band, 'severe');
  });

  test('shipTypeName', () => {
    assert.equal(S.shipTypeName(70), 'Cargo');
    assert.equal(S.shipTypeName(84), 'Tanker');
    assert.equal(S.shipTypeName(30), 'Fishing');
    assert.equal(S.shipTypeName(1), 'Unknown');
    assert.equal(S.shipTypeName(0), null);
    assert.equal(S.shipTypeName(NaN), null);
  });

  test('parseCsv', () => {
    assert.deepEqual(S.parseCsv('a,b\n1,2\n3'), [{ a: '1', b: '2' }, { a: '3', b: '' }]);
    assert.deepEqual(S.parseCsv('only,header'), []);
    assert.deepEqual(S.parseCsv('a,b\r\n1,2\r\n'), [{ a: '1', b: '2' }]);
  });

  test('normaliseOwcdb accepts the field-name variants and filters URLs', () => {
    const n = S.normaliseOwcdb({
      slug: 'x', name: 'Cam', location: { lat: '1.5', lng: '2.5', city: 'C' }, country_name: 'K',
      categories: [{ name: 'City' }], thumbnail_url: 'javascript:alert(1)',
      player_url: 'http://insecure.example/p', is_online: false,
    });
    assert.equal(n.lat, 1.5);
    assert.equal(n.lon, 2.5);
    assert.equal(n.place, 'C, K');
    assert.equal(n.category, 'City');
    assert.equal(n.image, null);
    assert.equal(n.embed, null);      // http is not good enough for an iframe
    assert.equal(n.status, 'offline');
    assert.equal(n.link, 'https://openwebcamdb.com/webcams/x');
    assert.equal(S.normaliseOwcdb({ title: 'no coords' }), null);
  });
});

describe('imagery helpers', () => {
  test('gibsTemplate uses the requested layer and date, with row/col tile order', () => {
    const t = S.gibsTemplate('VIIRS_SNPP_DayNightBand_At_Sensor_Radiance', '2026-01-02');
    assert.equal(t.date, '2026-01-02');
    assert.equal(t.maxLevel, 8);
    assert.match(t.url, /\/VIIRS_SNPP_DayNightBand_At_Sensor_Radiance\/default\/2026-01-02\/GoogleMapsCompatible_Level8\/\{z\}\/\{y\}\/\{x\}\.png$/);
  });

  test('gibsTemplate falls back to the default layer and yesterday', () => {
    const t = S.gibsTemplate('nope', 'not-a-date');
    assert.equal(t.layer, 'VIIRS_SNPP_CorrectedReflectance_TrueColor');
    assert.equal(t.date, S.gibsDefaultDate());
    const y = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
    assert.equal(S.gibsDefaultDate(), y);
  });

  test('cloudSource prefers RainViewer frames, else a GIBS product', () => {
    assert.equal(S.cloudSource([{ time: 1 }]).source, 'rainviewer');
    const g = S.cloudSource([]);
    assert.equal(g.source, 'gibs');
    assert.ok(g.url.includes('GOES-East_ABI_GeoColor'));
    assert.ok(g.fallbackReason);
  });

  test('sentinelTileTemplate encodes the COG URL but keeps the {z}/{x}/{y} slots', () => {
    const u = S.sentinelTileTemplate('https://cogs.example/a b/TCI.tif?x=1&y=2');
    assert.match(u, /\{z\}\/\{x\}\/\{y\}\.png\?url=/);
    assert.ok(u.includes(encodeURIComponent('https://cogs.example/a b/TCI.tif?x=1&y=2')));
  });

  test('every GIBS layer is well-formed', () => {
    for (const l of S.GIBS_LAYERS) {
      assert.ok(l.key && l.label && l.matrix && l.maxLevel > 0, l.key);
      assert.match(l.ext, /^(png|jpg)$/);
    }
  });
});

describe('secrets and cookies', () => {
  test('sameSecret compares in constant time and handles length mismatches', () => {
    assert.equal(S.sameSecret('abc', 'abc'), true);
    assert.equal(S.sameSecret('abc', 'abd'), false);
    assert.equal(S.sameSecret('abc', 'abcd'), false);
    assert.equal(S.sameSecret('', ''), true);
  });

  test('cookieValue finds a named cookie among several', () => {
    const req = { headers: { cookie: 'a=1; op_access=secret=with=equals; b=2' } };
    assert.equal(S.cookieValue(req, 'op_access'), 'secret=with=equals');
    assert.equal(S.cookieValue(req, 'missing'), null);
    assert.equal(S.cookieValue({ headers: {} }, 'a'), null);
  });
});

describe('mirrorFailure', () => {
  const E = (status, message, reason) => Object.assign(new S.UpstreamError(status, message), { reason });

  test('summarises each kind of failure briefly', () => {
    assert.equal(S.mirrorFailure('https://overpass-api.de/api/interpreter', E(429, 'x')), 'overpass-api.de: HTTP 429 rate-limited');
    assert.equal(S.mirrorFailure('https://a.example/', E(504, 'Overpass timed out after 45s')), 'a.example: timed out');
    assert.equal(S.mirrorFailure('https://a.example/', E(504, 'Overpass unreachable: fetch failed')), 'a.example: unreachable');
    assert.equal(S.mirrorFailure('https://a.example/', E(503, 'x', 'The server is probably too busy')), 'a.example: HTTP 503 server busy');
    assert.equal(S.mirrorFailure('https://a.example/', E(500, 'x', '500 Internal Server Error — details')), 'a.example: HTTP 500 Internal Server Error');
  });
});

describe('no version number', () => {
  test('package.json has none and the server exports none', () => {
    assert.equal(require('../../../package.json').version, undefined);
    assert.equal(S.VERSION, undefined);
  });

  test('user agent names the app and a contact URL, without a version', () => {
    assert.match(S.USER_AGENT, /^OpenPanopticon \(.*\+https:\/\/github\.com\//);
    assert.doesNotMatch(S.USER_AGENT, /\d+\.\d+\.\d+/);
  });
});

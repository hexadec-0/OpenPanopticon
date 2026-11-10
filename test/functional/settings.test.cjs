// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * /api/settings, behind the settings menu: credentials are written to .env
 * and never read back, retention is written to cache.conf, both take effect
 * at once, and a request that is not the app's own page changes nothing.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../helpers/harness.cjs');

const H = 3600_000;
const D = 24 * H;
const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('settings menu API', () => {
  let s; let dir; let envFile; let confFile;
  const post = (body, headers = JSON_HEADERS) => s.api('/api/settings', {}, {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const env = () => fs.readFileSync(envFile, 'utf8');

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-settings-'));
    envFile = path.join(dir, '.env');
    confFile = path.join(dir, 'cache.conf');
    fs.writeFileSync(envFile, [
      '# my keys', 'SHODAN_API_KEY=old-shodan-SECRET', 'WINDY_API_KEY="old-windy-SECRET"', '',
      '# GEE_PROJECT=my-gcp-project-id', 'UNRELATED=keep me', '',
    ].join('\r\n'));
    s = await startServer({
      env: { OPENPANOPTICON_ENV_FILE: envFile, OPENPANOPTICON_CACHE_CONF: confFile, EIA_API_KEY: 'eia-from-environment-SECRET' },
    });
  });
  after(async () => { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  test('GET says which credentials are set, and never what they are', async () => {
    const r = await s.api('/api/settings');
    assert.equal(r.status, 200);
    assert.doesNotMatch(r.text, /-SECRET/);
    const by = Object.fromEntries(r.json().credentials.map((c) => [c.name, c]));
    assert.deepEqual([by.SHODAN_API_KEY.set, by.SHODAN_API_KEY.fixed], [true, false]);
    assert.deepEqual([by.AISSTREAM_API_KEY.set, by.AISSTREAM_API_KEY.fixed], [false, false]);
    // Supplied by the environment, so .env cannot change it.
    assert.deepEqual([by.EIA_API_KEY.set, by.EIA_API_KEY.fixed], [true, true]);
    for (const c of r.json().credentials) assert.equal('value' in c, false, c.name);
  });

  test('GET lists every cache setting with its value and default', async () => {
    const { cache } = (await s.api('/api/settings')).json();
    assert.equal(cache.length, s.mod.CACHE_SCHEMA.length);
    const tiles = cache.find((c) => c.name === 'maps.tiles');
    assert.deepEqual([tiles.value, tiles.default, tiles.kind], ['30d', '30d', 'duration']);
    assert.equal(cache.find((c) => c.name === 'maps.tiles_max_size').kind, 'size');
    for (const c of cache) assert.doesNotMatch(c.help, /\n/, c.name);
  });

  test('a save rewrites .env in place and is in force at once', async () => {
    const r = await post({ credentials: {
      SHODAN_API_KEY: '  new-shodan-SECRET ', WINDY_API_KEY: '', GEE_PROJECT: 'proj-1', OPENSKY_CLIENT_ID: 'sky-id',
    } });
    assert.equal(r.status, 200, r.text);
    assert.doesNotMatch(r.text, /-SECRET|proj-1|sky-id/);
    assert.deepEqual(r.json().saved.credentials.sort(), ['GEE_PROJECT', 'OPENSKY_CLIENT_ID', 'SHODAN_API_KEY', 'WINDY_API_KEY']);

    assert.deepEqual(env().split('\r\n'), [
      '# my keys', 'SHODAN_API_KEY=new-shodan-SECRET', 'WINDY_API_KEY=', '',
      'GEE_PROJECT=proj-1', 'UNRELATED=keep me', '',
      '# Set from the settings menu.', 'OPENSKY_CLIENT_ID=sky-id', '',
    ]);
    assert.equal(s.mod.CFG.shodanKey, 'new-shodan-SECRET');
    assert.equal(s.mod.CFG.windyKey, '');
    assert.equal(s.mod.CFG.openSkyId, 'sky-id');

    const by = Object.fromEntries(r.json().credentials.map((c) => [c.name, c.set]));
    assert.deepEqual([by.SHODAN_API_KEY, by.WINDY_API_KEY, by.GEE_PROJECT], [true, false, true]);
    const health = (await s.api('/api/health')).json();
    assert.match(health.sources.windy, /missing/);
  });

  test('what was written reads back as what was typed', () => {
    const tricky = ['"quoted"', "'single'", 'has = and # in it', 'a"b', '"'];
    for (const v of tricky) {
      const file = path.join(dir, 'roundtrip.env');
      fs.writeFileSync(file, s.mod.mergeEnvText('', new Map([['OP_T_ROUND', v]])));
      delete process.env.OP_T_ROUND;
      s.mod.loadDotEnv(file);
      assert.equal(process.env.OP_T_ROUND, v);
    }
    delete process.env.OP_T_ROUND;
  });

  test('a pasted PEM key is folded onto one line', async () => {
    const r = await post({ credentials: { GEE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n' } });
    assert.equal(r.status, 200, r.text);
    assert.match(env(), /^GEE_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----$/m);
  });

  test('a save rewrites cache.conf and changes retention at once', async () => {
    const r = await post({ cache: { 'shodan.hosts': '12h', 'maps.tiles_max_size': '2GB', 'memory.max_entries': '750' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(s.mod.RETAIN['shodan.hosts'], 12 * H);
    assert.equal(s.mod.RETAIN['maps.tiles_max_size'], 2 * 2 ** 30);
    assert.equal(s.mod.CACHE_MAX_ENTRIES, 750);
    assert.equal(r.json().cache.find((c) => c.name === 'shodan.hosts').value, '12h');
    const text = fs.readFileSync(confFile, 'utf8');
    assert.match(text, /^# Shodan search results\./m, 'the explanations stay');
    assert.match(text, /^hosts = 12h$/m);
    assert.deepEqual(s.mod.loadCacheConf(confFile).problems, []);
    assert.equal((await s.api('/api/config')).json().retention.shodan, 12 * H);
  });

  test('cache.conf edits keep comments, fix duplicates and add what is missing', () => {
    const before = ['[maps]', 'tiles = 3d   # short', 'tiles = 5d', '', '[shodan]', 'hosts: 1d', ''].join('\n');
    const out = s.mod.mergeCacheConfText(before, new Map([
      ['maps.tiles', '2w'], ['maps.browser', '1h'], ['vessels.photos', '9d'],
    ]));
    assert.deepEqual(out.split('\n').filter((l) => l && !l.startsWith('#')), [
      '[maps]', 'tiles = 2w   # short', 'tiles = 2w', 'browser = 1h', '[shodan]', 'hosts: 1d', '[vessels]', 'photos = 9d',
    ]);
    const file = path.join(dir, 'merged.conf');
    fs.writeFileSync(file, out);
    assert.deepEqual(s.mod.loadCacheConf(file).problems, []);
    assert.equal(s.mod.RETAIN['maps.browser'], H);
    assert.equal(s.mod.RETAIN['vessels.photos'], 9 * D);
    s.mod.loadCacheConf(confFile);
  });

  describe('refusals change nothing', () => {
    let envBefore; let confBefore;
    before(() => { envBefore = env(); confBefore = fs.readFileSync(confFile, 'utf8'); });
    const unchanged = () => {
      assert.equal(env(), envBefore);
      assert.equal(fs.readFileSync(confFile, 'utf8'), confBefore);
    };

    test('no X-Panopticon header', async () => {
      const r = await s.request('/api/settings', { method: 'POST', headers: JSON_HEADERS, body: '{"credentials":{"SHODAN_API_KEY":"x"}}' });
      assert.equal(r.status, 403);
      assert.equal((await s.request('/api/settings')).status, 403);
      unchanged();
    });

    test('a form-encoded body, as a cross-site form would send', async () => {
      const r = await post('{"credentials":{"SHODAN_API_KEY":"x"}}', { 'Content-Type': 'text/plain' });
      assert.equal(r.status, 415);
      unchanged();
    });

    test('another origin', async () => {
      for (const origin of ['https://evil.example', 'null']) {
        const r = await post({ credentials: { SHODAN_API_KEY: 'x' } }, { ...JSON_HEADERS, Origin: origin });
        assert.equal(r.status, 403, origin);
      }
      const own = await post({}, { ...JSON_HEADERS, Origin: `http://127.0.0.1:${s.port}` });
      assert.equal(own.status, 200);
      unchanged();
    });

    test('methods other than GET and POST', async () => {
      assert.equal((await s.api('/api/settings', {}, { method: 'PUT', headers: JSON_HEADERS, body: '{}' })).status, 405);
      unchanged();
    });

    test('one bad field refuses the whole save and names the field', async () => {
      const r = await post({
        credentials: {
          SHODAN_API_KEY: 'would-be-SECRET', PORT: '1', EIA_API_KEY: 'x', WINDY_API_KEY: 'two\nlines',
          EDIS_API_URL: 'javascript:alert(1)', FIVE_ELEVEN_KEYS: 'nonsense', AISSTREAM_API_KEY: 7,
        },
        cache: { 'shodan.hosts': 'forever', 'shodan.nope': '1d', 'memory.max_entries': '1.5' },
      });
      assert.equal(r.status, 400);
      assert.doesNotMatch(r.text, /-SECRET/);
      assert.deepEqual(Object.keys(r.json().fields).sort(), [
        'AISSTREAM_API_KEY', 'EDIS_API_URL', 'EIA_API_KEY', 'FIVE_ELEVEN_KEYS', 'PORT', 'WINDY_API_KEY',
        'memory.max_entries', 'shodan.hosts', 'shodan.nope',
      ]);
      assert.match(r.json().fields.EIA_API_KEY, /environment/);
      assert.equal(s.mod.CFG.shodanKey, 'new-shodan-SECRET');
      assert.equal(s.mod.CFG.eiaKey, 'eia-from-environment-SECRET');
      unchanged();
    });

    test('a body that is not a JSON object, or is too large', async () => {
      assert.equal((await post('not json')).status, 400);
      assert.equal((await post('[]')).status, 400);
      assert.equal((await post({ credentials: [] })).status, 400);
      const big = await post({ credentials: { SHODAN_API_KEY: 'x'.repeat(70_000) } }).catch(() => ({ status: 413 }));
      assert.equal(big.status, 413);
      unchanged();
    });
  });
});

describe('settings menu API with no files yet', () => {
  test('.env and cache.conf are created on the first save', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-settings-'));
    const envFile = path.join(dir, '.env');
    const confFile = path.join(dir, 'cache.conf');
    const s = await startServer({ env: { OPENPANOPTICON_ENV_FILE: envFile, OPENPANOPTICON_CACHE_CONF: confFile } });
    try {
      const r = await s.api('/api/settings', {}, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ credentials: { SHODAN_API_KEY: 'first-SECRET' }, cache: { 'current.events': '0' } }),
      });
      assert.equal(r.status, 200, r.text);
      assert.match(fs.readFileSync(envFile, 'utf8'), /^SHODAN_API_KEY=first-SECRET$/m);
      if (process.platform !== 'win32') assert.equal(fs.statSync(envFile).mode & 0o077, 0, '.env is private to its owner');
      assert.match(fs.readFileSync(confFile, 'utf8'), /^events = 0$/m);
      assert.equal(s.mod.RETAIN['current.events'], 0);
      assert.equal(s.mod.RETAIN['maps.tiles'], 30 * D);
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

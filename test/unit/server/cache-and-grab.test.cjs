// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadServer } = require('../../helpers/harness.cjs');
const { UpstreamMock } = require('../../helpers/upstream.cjs');
const { json, text, status } = require('../../helpers/responses.cjs');

const mock = new UpstreamMock({ defaults: false });
const { mod: S, restore, dataDir } = loadServer({ mock });
after(() => { restore(); fs.rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => { mock.reset(); mock.routes = []; S.cache.clear(); });

const fresh = (fn) => S.reqCtx.run({ fresh: true }, fn);

describe('cached()', () => {
  test('serves a hit until it expires', async () => {
    let n = 0;
    const producer = async () => ++n;
    assert.equal(await S.cached('k1', 60_000, producer), 1);
    assert.equal(await S.cached('k1', 60_000, producer), 1);
    S.cache.get('k1').expires = Date.now() - 1;
    assert.equal(await S.cached('k1', 60_000, producer), 2);
  });

  test('joins an in-flight request instead of starting a second', async () => {
    let n = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const producer = async () => { n++; await gate; return 'v'; };
    const a = S.cached('k2', 1000, producer);
    const b = S.cached('k2', 1000, producer);
    release();
    assert.deepEqual(await Promise.all([a, b]), ['v', 'v']);
    assert.equal(n, 1);
    assert.equal(S.inflight.has('k2'), false);
  });

  test('does not cache a failure', async () => {
    let n = 0;
    await assert.rejects(S.cached('k3', 1000, async () => { n++; throw new Error('boom'); }), /boom/);
    assert.equal(S.cache.has('k3'), false);
    assert.equal(await S.cached('k3', 1000, async () => { n++; return 'ok'; }), 'ok');
    assert.equal(n, 2);
  });

  test('fresh=1 (SYNC) bypasses both the stored copy and an in-flight one', async () => {
    let n = 0;
    await S.cached('k4', 60_000, async () => ++n);
    assert.equal(await fresh(() => S.cached('k4', 60_000, async () => ++n)), 2);
    // And the fresh answer replaces the stored one.
    assert.equal(await S.cached('k4', 60_000, async () => ++n), 2);
  });
});

describe('cachedPersistent() and the disk tier', () => {
  test('writes through to disk before resolving', async () => {
    await S.cachedPersistent('disk:a', 60_000, async () => ({ hello: 'world' }));
    const files = fs.readdirSync(S.DISK_CACHE_DIR);
    assert.equal(files.length >= 1, true);
    const rec = JSON.parse(fs.readFileSync(path.join(S.DISK_CACHE_DIR, files.find((f) => f.endsWith('.json'))), 'utf8'));
    assert.ok(rec.savedAt > 0);
    assert.equal(rec.keyHash, S.diskKeyHash('disk:a'));
    assert.equal(rec.key, undefined, 'the key itself is not written in clear');
  });

  test('a fresh process (empty memory) is served from disk', async () => {
    let n = 0;
    await S.cachedPersistent('disk:b', 60_000, async () => { n++; return [1, 2, 3]; });
    S.cache.clear();
    assert.deepEqual(await S.cachedPersistent('disk:b', 60_000, async () => { n++; return 'refetched'; }), [1, 2, 3]);
    assert.equal(n, 1);
  });

  test('an expired disk entry is ignored', async () => {
    await S.writeDiskCache('disk:c', 'old');
    const file = fs.readdirSync(S.DISK_CACHE_DIR)
      .map((f) => path.join(S.DISK_CACHE_DIR, f))
      .find((f) => f.endsWith(S.diskName('disk:c')));
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.savedAt = Date.now() - 2 * 60_000;
    fs.writeFileSync(file, JSON.stringify(rec));
    assert.equal(await S.readDiskCache('disk:c', 60_000), undefined);
    assert.equal(await S.readDiskCache('disk:c', 10 * 60_000), 'old');
  });

  test('a record whose stored key differs (hash collision) is not served', async () => {
    await S.writeDiskCache('disk:d', 'value');
    const file = fs.readdirSync(S.DISK_CACHE_DIR)
      .map((f) => path.join(S.DISK_CACHE_DIR, f))
      .find((f) => f.endsWith(S.diskName('disk:d')));
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.keyHash = S.diskKeyHash('something else');
    fs.writeFileSync(file, JSON.stringify(rec));
    assert.equal(await S.readDiskCache('disk:d', 60_000), undefined);
  });

  test('a corrupt file reads as a miss rather than throwing', async () => {
    await S.writeDiskCache('disk:e', 'value');
    for (const f of fs.readdirSync(S.DISK_CACHE_DIR)) {
      const p = path.join(S.DISK_CACHE_DIR, f);
      if (f === S.diskName('disk:e')) fs.writeFileSync(p, '{not json');
    }
    assert.equal(await S.readDiskCache('disk:e', 60_000), undefined);
  });

  test('fresh=1 skips the disk tier too', async () => {
    await S.cachedPersistent('disk:f', 60_000, async () => 'stored');
    S.cache.clear();
    assert.equal(await fresh(() => S.cachedPersistent('disk:f', 60_000, async () => 'new')), 'new');
  });

  test('pruneDiskCache() deletes what can no longer be served and keeps the rest', async () => {
    await S.writeDiskCache('prune:old', 'old');
    await S.writeDiskCache('prune:new', 'new');
    const old = path.join(S.DISK_CACHE_DIR, S.diskName('prune:old'));
    const past = (Date.now() - S.DISK_MAX_AGE - 60_000) / 1000;
    fs.utimesSync(old, past, past);
    const stale = path.join(S.DISK_CACHE_DIR, 'abandoned.json.123.tmp');
    fs.writeFileSync(stale, '{');
    fs.utimesSync(stale, past, past);

    const r = await S.pruneDiskCache();
    assert.ok(r.removed >= 2);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(await S.readDiskCache('prune:new', 60_000), 'new');
  });

  test('pruneDiskCache() rewrites old-format records without the key in clear', async () => {
    const file = path.join(S.DISK_CACHE_DIR, S.diskName('legacy:shodan custom query'));
    fs.mkdirSync(S.DISK_CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key: 'legacy:shodan custom query', savedAt: Date.now() - 3_600_000, value: [7] }));
    // Still served before the rewrite, so an upgrade does not re-spend credits.
    assert.deepEqual(await S.readDiskCache('legacy:shodan custom query', 2 * 3_600_000), [7]);

    const expired = path.join(S.DISK_CACHE_DIR, S.diskName('legacy:expired'));
    fs.writeFileSync(expired, JSON.stringify({ key: 'legacy:expired', savedAt: Date.now() - S.DISK_MAX_AGE - 1, value: 1 }));

    const r = await S.pruneDiskCache();
    assert.ok(r.rewritten >= 1);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('custom query'), 'key no longer stored in clear');
    assert.ok(Math.abs(fs.statSync(file).mtimeMs - JSON.parse(raw).savedAt) < 2000, 'rewrite keeps the record age');
    assert.deepEqual(await S.readDiskCache('legacy:shodan custom query', 2 * 3_600_000), [7]);
    assert.equal(fs.existsSync(expired), false);
  });

  test('an entry past the longest TTL is deleted when read', async () => {
    await S.writeDiskCache('disk:h', 'v');
    const file = path.join(S.DISK_CACHE_DIR, S.diskName('disk:h'));
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.savedAt = Date.now() - S.DISK_MAX_AGE - 60_000;
    fs.writeFileSync(file, JSON.stringify(rec));
    assert.equal(await S.readDiskCache('disk:h', 60_000), undefined);
    assert.equal(fs.existsSync(file), false);
  });

  test('leaves no temporary files behind', async () => {
    await S.cachedPersistent('disk:g', 60_000, async () => 'x');
    assert.deepEqual(fs.readdirSync(S.DISK_CACHE_DIR).filter((f) => f.endsWith('.tmp')), []);
  });

  test('values that are not JSON-shaped do not survive a round trip — store plain data', async () => {
    // The Feodo regression: a Map serialises to {}. cachedPersistent callers
    // must cache arrays or objects, which is what feodoSet now does.
    await S.writeDiskCache('disk:map', new Map([['a', 1]]));
    assert.deepEqual(await S.readDiskCache('disk:map', 60_000), {});
  });

  test('isCached sees memory and disk entries', async () => {
    assert.equal(await S.isCached('disk:h', 60_000), false);
    await S.cachedPersistent('disk:h', 60_000, async () => 1);
    assert.equal(await S.isCached('disk:h', 60_000), true);
    S.cache.clear();
    assert.equal(await S.isCached('disk:h', 60_000), true);
  });

  test('clearDiskCache removes everything and reports the count', async () => {
    await S.cachedPersistent('disk:i', 60_000, async () => 1);
    await S.cachedPersistent('disk:j', 60_000, async () => 2);
    const n = await S.clearDiskCache();
    assert.ok(n >= 2);
    assert.deepEqual(fs.readdirSync(S.DISK_CACHE_DIR), []);
  });
});

describe('TTL policy', () => {
  test('inventories outlive orbits, which outlive present-tense data', () => {
    assert.ok(S.TTL.static > S.TTL.orbit);
    assert.ok(S.TTL.orbit > S.TTL.hazard);
    assert.ok(S.TTL.hazard > S.TTL.schedule);
    assert.ok(S.TTL.schedule > S.TTL.live);
    assert.ok(S.TTL.live > S.TTL.account);
    assert.equal(S.TTL.static, 3 * 24 * 3600_000);
    assert.equal(S.TTL.hazard, 3600_000);
  });
});

describe('grab()', () => {
  test('identifies itself with the app user agent', async () => {
    mock.on('a.example', () => json({ ok: true }));
    await S.grab('https://a.example/x');
    assert.equal(mock.calls[0].headers['user-agent'], S.USER_AGENT);
  });

  test('a per-call header wins over the default user agent', async () => {
    mock.on('a.example', () => json({}));
    await S.grab('https://a.example/x', { headers: { 'User-Agent': 'custom' } });
    assert.equal(mock.calls[0].headers['user-agent'], 'custom');
  });

  test('parses JSON by default, text or buffer on request', async () => {
    mock.on('/json', () => json({ a: 1 }));
    mock.on('/text', () => text('hello'));
    mock.on('/buf', () => text('bytes'));
    assert.deepEqual(await S.grab('https://a.example/json'), { a: 1 });
    assert.equal(await S.grab('https://a.example/text', {}, { as: 'text' }), 'hello');
    const buf = await S.grab('https://a.example/buf', {}, { as: 'buffer' });
    assert.ok(Buffer.isBuffer(buf));
    assert.equal(buf.toString(), 'bytes');
  });

  test('malformed JSON is a 502 with a snippet of the body', async () => {
    mock.on('a.example', () => text('<html>not json</html>'));
    await assert.rejects(S.grab('https://a.example/x', {}, { label: 'Thing' }), (e) => {
      assert.equal(e.status, 502);
      assert.match(e.message, /Thing returned malformed JSON/);
      assert.match(e.detail, /not json/);
      return true;
    });
  });

  test('an HTTP error carries the status, the upstream reason and the body', async () => {
    mock.on('a.example', () => json({ error: 'Invalid API key' }, { status: 401 }));
    await assert.rejects(S.grab('https://a.example/x', {}, { label: 'Shodan' }), (e) => {
      assert.ok(e instanceof S.UpstreamError);
      assert.equal(e.status, 401);
      assert.equal(e.message, 'Shodan returned HTTP 401: Invalid API key');
      assert.equal(e.reason, 'Invalid API key');
      assert.match(e.detail, /Invalid API key/);
      return true;
    });
  });

  test('Retry-After in seconds, as a date, and OpenSky\'s own header', async () => {
    mock.once('a.example', () => status(429, '', { 'retry-after': '120' }));
    await assert.rejects(S.grab('https://a.example/1'), (e) => e.retryAfter === 120);

    const when = new Date(Date.now() + 90_000).toUTCString();
    mock.once('a.example', () => status(503, '', { 'retry-after': when }));
    await assert.rejects(S.grab('https://a.example/2'), (e) => e.retryAfter >= 85 && e.retryAfter <= 91);

    mock.once('a.example', () => status(429, '', { 'x-rate-limit-retry-after-seconds': '33' }));
    await assert.rejects(S.grab('https://a.example/3'), (e) => e.retryAfter === 33);

    mock.once('a.example', () => status(500, ''));
    await assert.rejects(S.grab('https://a.example/4'), (e) => e.retryAfter === null);
  });

  test('onHeaders sees the response even when it is an error', async () => {
    const seen = [];
    mock.on('a.example', () => status(429, '', { 'x-rate-limit-remaining': '0' }));
    await assert.rejects(S.grab('https://a.example/x', {}, {
      onHeaders: (h, code) => seen.push([h.get('x-rate-limit-remaining'), code]),
    }));
    assert.deepEqual(seen, [['0', 429]]);
  });

  test('a throwing onHeaders never fails the fetch', async () => {
    mock.on('a.example', () => json({ ok: 1 }));
    assert.deepEqual(await S.grab('https://a.example/x', {}, { onHeaders: () => { throw new Error('x'); } }), { ok: 1 });
  });

  test('an unreachable host is a 504 that names the upstream', async () => {
    mock.unreachable('a.example');
    await assert.rejects(S.grab('https://a.example/x', {}, { label: 'GDACS' }), (e) => {
      assert.equal(e.status, 504);
      assert.match(e.message, /^GDACS unreachable: fetch failed/);
      return true;
    });
  });

  test('a hung upstream times out as a 504', async () => {
    mock.hang('a.example');
    await assert.rejects(S.grab('https://a.example/x', {}, { label: 'Slow', timeoutMs: 50 }), (e) => {
      assert.equal(e.status, 504);
      assert.equal(e.message, 'Slow timed out after 0.05s');
      return true;
    });
  });
});

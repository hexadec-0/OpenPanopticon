// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * The memory tier's bounds: expired entries are swept, and the number of live
 * entries is capped, least recently used first.
 */
const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { loadServer } = require('../../helpers/harness.cjs');

const { mod: S, restore, dataDir } = loadServer();
after(() => { restore(); fs.rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => S.cache.clear());

describe('memory cache bounds', () => {
  test('sweepCache() drops expired entries and keeps live ones', () => {
    const now = Date.now();
    S.cache.set('old', { expires: now - 1, value: 1 });
    S.cache.set('live', { expires: now + 60_000, value: 2 });
    assert.equal(S.sweepCache(now), 1);
    assert.deepEqual([...S.cache.keys()], ['live']);
  });

  test('an expired entry is removed when it is next asked for', async () => {
    S.cache.set('k', { expires: Date.now() - 1, value: 'stale' });
    let release;
    const p = S.cached('k', 60_000, () => new Promise((r) => { release = r; }));
    assert.equal(S.cache.has('k'), false, 'gone while the refetch runs');
    release('new');
    assert.equal(await p, 'new');
  });

  test('the cap evicts the least recently used entry', async () => {
    const max = S.CACHE_MAX_ENTRIES;
    for (let i = 0; i < max; i++) await S.cached(`k${i}`, 60_000, async () => i);
    assert.equal(S.cache.size, max);
    assert.equal(await S.cached('k0', 60_000, async () => 'refetched'), 0, 'k0 is a hit');
    await S.cached('one-more', 60_000, async () => 'x');
    assert.equal(S.cache.size, max);
    assert.ok(S.cache.has('k0'), 'k0 was used recently, so it stays');
    assert.ok(!S.cache.has('k1'), 'k1 was the least recently used');
  });

  test('at the cap, expired entries go before live ones', async () => {
    const max = S.CACHE_MAX_ENTRIES;
    S.cache.set('expired', { expires: Date.now() - 1, value: 0 });
    for (let i = 1; i < max; i++) await S.cached(`k${i}`, 60_000, async () => i);
    await S.cached('one-more', 60_000, async () => 'x');
    assert.ok(!S.cache.has('expired'));
    assert.ok(S.cache.has('k1'), 'no live entry had to go');
  });
});

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadServer } = require('../../helpers/harness.cjs');

const { mod: S, restore, dataDir } = loadServer();
after(() => { restore(); fs.rmSync(dataDir, { recursive: true, force: true }); });
const conf = path.join(dataDir, 'cache.conf');
const H = 3600_000;
const D = 24 * H;

describe('cache.conf', () => {
  test('defaults with no file', () => {
    S.loadCacheConf(path.join(dataDir, 'none.conf'));
    assert.equal(S.RETAIN['maps.tiles'], 30 * D);
    assert.equal(S.RETAIN['shodan.hosts'], 30 * D);
    assert.equal(S.RETAIN['overpass.infrastructure'], 30 * D);
    assert.equal(S.RETAIN['current.events'], H);
    assert.equal(S.RETAIN['aircraft.trails'], 4 * 60_000);
    assert.equal(S.RETAIN['maps.tiles_max_size'], 4096 * 2 ** 20);
  });

  test('the written file round-trips to the defaults', () => {
    fs.writeFileSync(conf, S.cacheConfText());
    const r = S.loadCacheConf(conf);
    assert.deepEqual(r.problems, []);
    assert.equal(S.RETAIN['aircraft.routes'], 30 * 60_000);
    // Every setting appears in the file.
    for (const [sec, key] of S.CACHE_SCHEMA) assert.match(S.cacheConfText(), new RegExp(`\\[${sec}\\][\\s\\S]*\\n${key} = `));
  });

  test('settings, units, comments and sections', () => {
    fs.writeFileSync(conf, [
      '# a comment', '[maps]', 'tiles = 2w   # two weeks', 'tiles_max_size = 1GB',
      '[shodan]', 'hosts: 10d', '[overpass]', 'infrastructure = 12h', 'alpr = 90m',
      '[current]', 'events = 0', '[memory]', 'max_entries = 5000',
    ].join('\n'));
    const r = S.loadCacheConf(conf);
    assert.deepEqual(r.problems, []);
    assert.equal(S.RETAIN['maps.tiles'], 14 * D);
    assert.equal(S.RETAIN['maps.tiles_max_size'], 2 ** 30);
    assert.equal(S.RETAIN['shodan.hosts'], 10 * D);
    assert.equal(S.RETAIN['overpass.infrastructure'], 12 * H);
    assert.equal(S.RETAIN['overpass.alpr'], 90 * 60_000);
    assert.equal(S.RETAIN['current.events'], 0);
    assert.equal(S.CACHE_MAX_ENTRIES, 5000);
    assert.equal(S.TILE_MAX_AGE, 14 * D);
    // Pruning keeps anything still in force: the longest retention on disk.
    assert.equal(S.DISK_MAX_AGE, 30 * D);
    // A trail length is drawn in the browser; it never keeps disk files alive.
    fs.writeFileSync(conf, '[aircraft]\ntrails = 90d\n');
    S.loadCacheConf(conf);
    assert.equal(S.RETAIN['aircraft.trails'], 90 * D);
    assert.equal(S.DISK_MAX_AGE, 30 * D);
  });

  test('bad lines keep their default and are reported', () => {
    fs.writeFileSync(conf, ['[shodan]', 'hosts = forever', 'credit = 1m', '[maps]', 'tiles 3d'].join('\n'));
    const r = S.loadCacheConf(conf);
    assert.equal(r.problems.length, 3);
    assert.match(r.problems[0], /"forever" is not a duration/);
    assert.match(r.problems[1], /no setting called "shodan.credit"/);
    assert.equal(S.RETAIN['shodan.hosts'], 30 * D);
    assert.equal(S.RETAIN['maps.tiles'], 30 * D);
  });

  test('durations', () => {
    assert.equal(S.parseDuration('90s'), 90_000);
    assert.equal(S.parseDuration('90'), 90_000);
    assert.equal(S.parseDuration('1.5h'), 1.5 * H);
    assert.equal(S.parseDuration('3 d'), 3 * D);
    assert.equal(S.parseDuration('soon'), null);
  });

  test('an edit reaches what is served: config tells the browser', () => {
    fs.writeFileSync(conf, '[shodan]\nhosts = 5d\n');
    S.loadCacheConf(conf);
    assert.equal(S.RETAIN['shodan.hosts'], 5 * D);
    S.loadCacheConf(path.join(dataDir, 'none.conf'));   // back to defaults for anything after
  });
});

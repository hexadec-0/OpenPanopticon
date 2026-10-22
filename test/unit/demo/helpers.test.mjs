// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { grid, tilesFor, mergeInto, buildingsFrom, REGION, HOME } from '../../../demo/capture.mjs';
import { secretsFrom, findSecrets, demoIndex } from '../../../demo/build.mjs';

describe('demo capture helpers', () => {
  test('the region is New York and home sits inside it', () => {
    assert.ok(HOME.lat > REGION.south && HOME.lat < REGION.north);
    assert.ok(HOME.lon > REGION.west && HOME.lon < REGION.east);
  });

  test('grid covers the box exactly, without spilling past it', () => {
    const b = { south: 0, west: 0, north: 0.3, east: 0.2 };
    const cells = grid(b, 0.125);
    assert.equal(cells.length, 3 * 2);
    assert.equal(Math.max(...cells.map((c) => c.north)), 0.3);
    assert.equal(Math.max(...cells.map((c) => c.east)), 0.2);
    const area = cells.reduce((a, c) => a + (c.north - c.south) * (c.east - c.west), 0);
    assert.ok(Math.abs(area - 0.06) < 1e-9);
  });

  test('tile plans: the whole world at z0-1, then only tiles over the box', () => {
    const world = tilesFor([[0, 1, { south: -85, west: -180, north: 85, east: 180 }]]);
    assert.equal(world.length, 1 + 4);
    const nyc = tilesFor([[14, 14, REGION]]);
    assert.ok(nyc.length > 400 && nyc.length < 1500, String(nyc.length));
    for (const t of nyc) assert.equal(t.z, 14);
    // Overlapping bands do not repeat tiles.
    const twice = tilesFor([[5, 6, REGION], [6, 6, REGION]]);
    assert.equal(new Set(twice.map((t) => `${t.z}/${t.x}/${t.y}`)).size, twice.length);
  });

  test('mergeInto keeps one copy of each feature and the latest metadata', () => {
    const acc = {};
    mergeInto(acc, 'alpr', { count: 2, problems: { a: 'x' }, cameras: [{ id: 'n/1' }, { id: 'n/2' }] });
    mergeInto(acc, 'alpr', { count: 2, problems: { b: 'y' }, cameras: [{ id: 'n/2' }, { id: 'n/3' }] });
    assert.deepEqual([...acc.items.keys()], ['n/1', 'n/2', 'n/3']);
    assert.equal('cameras' in acc.meta, false);
    assert.deepEqual(acc.meta.problems, { a: 'x', b: 'y' });
  });

  test('buildings: heights from tags, levels, or a default; shapes under 4 points dropped', () => {
    const sq = (h) => [[0, 0], [0, 1e-4], [1e-4, 1e-4], [1e-4, 0], [0, 0]].map(([lat, lon]) => ({ lat, lon })).slice(0, h);
    const raw = { elements: [
      { type: 'way', tags: { building: 'yes', height: '120 m' }, geometry: sq(5) },
      { type: 'way', tags: { building: 'yes', 'building:levels': '10' }, geometry: sq(5) },
      { type: 'way', tags: { building: 'yes', min_height: '30' }, geometry: sq(5) },
      { type: 'way', tags: { building: 'yes' }, geometry: sq(2) },
      { type: 'node', lat: 1, lon: 1, tags: { building: 'yes' } },
    ] };
    const b = buildingsFrom(raw);
    assert.equal(b.length, 3);
    assert.equal(b[0][0], 120);
    assert.equal(b[1][0], 34);
    assert.equal(b[2][1], 30);
    assert.ok(b[2][0] > b[2][1], 'top above the base');
    assert.equal(b[0][2].length, 10, 'flat lon,lat pairs');
  });
});

describe('demo build helpers', () => {
  test('secretsFrom picks key-like variables and their parts, not hosts or ports', () => {
    const s = secretsFrom([
      'SHODAN_API_KEY="abcdefghijklmnop"',
      'HOST=0.0.0.0', 'PORT=8420',
      'FIVE_ELEVEN_KEYS=NY:nykey1234567,GA:gakey7654321',
      'OPENSKY_CLIENT_SECRET=short',
      '# CARTO_API_KEY=commentedout123',
    ].join('\n'));
    const values = s.map((x) => x.value);
    assert.ok(values.includes('abcdefghijklmnop'));
    assert.ok(values.includes('nykey1234567'));
    assert.ok(values.includes('gakey7654321'));
    assert.ok(!values.some((v) => v.includes('0.0.0.0') || v === '8420' || v === 'short'));
    assert.ok(!values.includes('commentedout123'));
  });

  test('findSecrets names the file and the variable, in text or binary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-sec-'));
    try {
      fs.mkdirSync(path.join(dir, 'a'));
      fs.writeFileSync(path.join(dir, 'a', 'x.json'), '{"ok":1}');
      fs.writeFileSync(path.join(dir, 'a', 'y.bin'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('zzSECRETVALUE99zz')]));
      const hits = findSecrets(dir, [{ name: 'WINDY_API_KEY', value: 'SECRETVALUE99' }]);
      assert.deepEqual(hits, [{ file: path.join('a', 'y.bin'), name: 'WINDY_API_KEY' }]);
      assert.deepEqual(findSecrets(dir, []), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('demoIndex loads the runtime before Cesium and marks the title', () => {
    const html = fs.readFileSync(new URL('../../../public/index.html', import.meta.url), 'utf8');
    const out = demoIndex(html);
    assert.match(out, /<title>OpenPanopticon - OSINT Data Fusion \(demo\)<\/title>/);
    const i = (s) => out.indexOf(s);
    assert.ok(i('demo/manifest.js') < i('demo/demo.js'));
    assert.ok(i('demo/demo.js') < i('js/cesium-base.js'));
    assert.ok(i('js/cesium-base.js') < i('Cesium.js"'));
    assert.throws(() => demoIndex('<html></html>'), /cesium-base/);
  });

  test('the app itself uses only relative paths, so it runs under /<repo>/', () => {
    const html = fs.readFileSync(new URL('../../../public/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /(src|href)="\/(?!\/)/);
  });
});

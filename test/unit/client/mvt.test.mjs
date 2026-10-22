// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMvt } from '../../../public/js/mvt.js';
import { encodeMvt } from '../../helpers/mvt-encode.mjs';

const ALL = new Set(['kind', 'name', 'f', 'd', 'i', 'u', 's', 'b']);

describe('decodeMvt', () => {
  test('decodes layer names, extent and version', () => {
    const buf = encodeMvt([{ name: 'water_polygons', extent: 512, version: 2, features: [] }]);
    const out = decodeMvt(buf);
    assert.deepEqual([...out.keys()], ['water_polygons']);
    const l = out.get('water_polygons');
    assert.equal(l.extent, 512);
    assert.equal(l.version, 2);
    assert.deepEqual(l.features, []);
  });

  test('points, lines and polygons come back as flat rings in tile units', () => {
    const buf = encodeMvt([{ name: 'streets', features: [
      { type: 'point', rings: [[10, 20], [30, 40]] },
      { type: 'line', rings: [[0, 0, 100, 0, 100, 100]] },
      { type: 'polygon', rings: [[0, 0, 10, 0, 10, 10, 0, 10], [2, 2, 4, 2, 4, 4]] },
    ] }]);
    const f = decodeMvt(buf).get('streets').features;
    assert.deepEqual(f.map((x) => x.type), ['point', 'line', 'polygon']);
    assert.deepEqual(f[0].rings, [[10, 20], [30, 40]]);
    assert.deepEqual(f[1].rings, [[0, 0, 100, 0, 100, 100]]);
    assert.deepEqual(f[2].rings, [[0, 0, 10, 0, 10, 10, 0, 10], [2, 2, 4, 2, 4, 4]]);
  });

  test('negative deltas (zig-zag) round-trip', () => {
    const buf = encodeMvt([{ name: 'l', features: [{ type: 'line', rings: [[4000, 4000, 10, 3000, -50, -60]] }] }]);
    assert.deepEqual(decodeMvt(buf).get('l').features[0].rings, [[4000, 4000, 10, 3000, -50, -60]]);
  });

  test('coordinates beyond 31 bits are not corrupted', () => {
    const big = 2 ** 33 + 7;
    const buf = encodeMvt([{ name: 'l', features: [{ type: 'point', rings: [[big, 1]] }] }]);
    assert.deepEqual(decodeMvt(buf).get('l').features[0].rings, [[big, 1]]);
  });

  test('every Value type decodes', () => {
    const props = { kind: 'motorway', name: 'Ünïcode ✓', f: { float: 1.5 }, d: 2.25, i: -7, u: 123456789, b: true };
    const buf = encodeMvt([{ name: 'l', features: [{ type: 'point', props, rings: [[0, 0]] }] }]);
    const got = decodeMvt(buf, { tags: ALL }).get('l').features[0].props;
    assert.deepEqual(got, { kind: 'motorway', name: 'Ünïcode ✓', f: 1.5, d: 2.25, i: -7, u: 123456789, b: true });
  });

  test('only the requested tags are built', () => {
    const buf = encodeMvt([{ name: 'streets', features: [{ type: 'line', props: { kind: 'primary', name: 'High St' }, rings: [[0, 0, 1, 1]] }] }]);
    assert.deepEqual(decodeMvt(buf, { tags: new Set(['kind']) }).get('streets').features[0].props, { kind: 'primary' });
    assert.equal(decodeMvt(buf).get('streets').features[0].props, null, 'no tags asked for, no property bag');
  });

  test('values are shared between features through the dictionary', () => {
    const buf = encodeMvt([{ name: 'streets', features: [
      { type: 'line', props: { kind: 'primary' }, rings: [[0, 0, 1, 1]] },
      { type: 'line', props: { kind: 'primary' }, rings: [[2, 2, 3, 3]] },
      { type: 'line', props: { kind: 'service' }, rings: [[4, 4, 5, 5]] },
    ] }]);
    const kinds = decodeMvt(buf, { tags: new Set(['kind']) }).get('streets').features.map((f) => f.props.kind);
    assert.deepEqual(kinds, ['primary', 'primary', 'service']);
  });

  test('the key dictionary may come before the features', () => {
    const buf = encodeMvt([{ name: 'l', features: [{ type: 'point', props: { kind: 'x' }, rings: [[1, 1]] }] }], { keysFirst: true });
    assert.equal(decodeMvt(buf, { tags: new Set(['kind']) }).get('l').features[0].props.kind, 'x');
  });

  test('a layer filter skips everything else without parsing it', () => {
    const buf = encodeMvt([
      { name: 'buildings', features: [{ type: 'polygon', rings: [[0, 0, 1, 0, 1, 1]] }] },
      { name: 'pois', features: [{ type: 'point', rings: [[5, 5]] }] },
      { name: 'water_polygons', features: [] },
    ]);
    assert.deepEqual([...decodeMvt(buf, { layers: new Set(['buildings', 'water_polygons']) }).keys()], ['buildings', 'water_polygons']);
  });

  test('unknown fields at any level are skipped', () => {
    const buf = encodeMvt([{ name: 'l', features: [{ id: 99, type: 'point', rings: [[1, 2]] }] }], { unknownTileField: true });
    assert.deepEqual(decodeMvt(buf).get('l').features[0].rings, [[1, 2]]);
  });

  test('an empty buffer is an empty tile', () => {
    assert.equal(decodeMvt(new Uint8Array(0)).size, 0);
  });

  // Regression: the reader used to stay mid-geometry after a bad command, so
  // the rest of the feature was misread and the whole tile threw.
  test('a geometry with an unknown command keeps what came before it', () => {
    // MoveTo(1,1) LineTo(2,2), then command id 5 (invalid) and garbage.
    const geom = [9, 2, 2, 10, 2, 2, 5, 99];
    const feature = [0x18, 0x02, 0x22, geom.length, ...geom];                  // type=line, geometry
    const layer = [0x0a, 0x01, 0x6c, 0x12, feature.length, ...feature, 0x78, 0x02]; // name "l", feature, version
    const tile = Uint8Array.from([0x1a, layer.length, ...layer]);
    assert.deepEqual(decodeMvt(tile).get('l').features[0].rings, [[1, 1, 2, 2]]);
  });

  test('a malformed geometry does not spoil the features after it', () => {
    const bad = [9, 2, 2, 5, 99];
    const f1 = [0x18, 0x02, 0x22, bad.length, ...bad];
    const good = [9, 4, 4];
    const f2 = [0x18, 0x01, 0x22, good.length, ...good];
    const layer = [0x0a, 0x01, 0x6c, 0x12, f1.length, ...f1, 0x12, f2.length, ...f2, 0x78, 0x02];
    const tile = Uint8Array.from([0x1a, layer.length, ...layer]);
    const feats = decodeMvt(tile).get('l').features;
    assert.equal(feats.length, 2);
    assert.deepEqual(feats[1].rings, [[2, 2]]);
    assert.equal(feats[1].type, 'point');
  });

  test('an unsupported wire type is reported, not silently misread', () => {
    // Field 1 with wire type 3 (deprecated groups) at the top level.
    assert.throws(() => decodeMvt(Uint8Array.from([0x0b, 0x00])), /unsupported wire type 3/);
  });

  test('an unknown geometry type reads as "unknown"', () => {
    const buf = encodeMvt([{ name: 'l', features: [{ type: 'unknown', rings: [] }] }]);
    assert.equal(decodeMvt(buf).get('l').features[0].type, 'unknown');
  });
});

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('../../helpers/harness.cjs');

const { mod: S, restore } = loadServer();
after(restore);

describe('parseBbox', () => {
  test('parses south,west,north,east', () => {
    assert.deepEqual(S.parseBbox('1,2,3,4'), { south: 1, west: 2, north: 3, east: 4 });
  });

  test('swaps an inverted latitude pair', () => {
    assert.deepEqual(S.parseBbox('10,0,5,1'), { south: 5, west: 0, north: 10, east: 1 });
  });

  test('clamps to the Web Mercator latitude range and to ±180 longitude', () => {
    assert.deepEqual(S.parseBbox('-90,-200,90,200'), { south: -85, west: -180, north: 85, east: 180 });
  });

  for (const bad of [undefined, null, '', '1,2,3', '1,2,3,4,5', 'a,b,c,d', '1,2,NaN,4', '1,2,Infinity,4']) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.equal(S.parseBbox(bad), null));
  }
});

describe('clamp / bboxCenter / bboxRadiusKm', () => {
  test('clamp', () => {
    assert.equal(S.clamp(5, 0, 10), 5);
    assert.equal(S.clamp(-5, 0, 10), 0);
    assert.equal(S.clamp(50, 0, 10), 10);
  });

  test('bboxCenter is the midpoint', () => {
    assert.deepEqual(S.bboxCenter({ south: 0, west: 10, north: 2, east: 20 }), { lat: 1, lon: 15 });
  });

  test('bboxRadiusKm covers the box from its centre', () => {
    // 1 x 1 degree at the equator: half-diagonal ~ 78.7 km.
    assert.equal(S.bboxRadiusKm({ south: -0.5, west: -0.5, north: 0.5, east: 0.5 }), 79);
  });

  test('bboxRadiusKm narrows with latitude (longitude degrees shrink)', () => {
    const eq = S.bboxRadiusKm({ south: -0.5, west: 0, north: 0.5, east: 2 });
    const north = S.bboxRadiusKm({ south: 59.5, west: 0, north: 60.5, east: 2 });
    assert.ok(north < eq);
  });

  test('bboxRadiusKm is bounded to 1..500 km', () => {
    assert.equal(S.bboxRadiusKm({ south: 0, west: 0, north: 0.00001, east: 0.00001 }), 1);
    assert.equal(S.bboxRadiusKm({ south: -40, west: -40, north: 40, east: 40 }), 500);
  });
});

describe('snapFixed', () => {
  const view = { south: 35.01, west: -100.07, north: 35.06, east: -100.02 };

  test('snaps outward to whole cells of a fixed grid', () => {
    const q = S.snapFixed(view, 0.125);
    assert.equal(q.south, 35);
    assert.equal(q.north, 35.125);
    assert.equal(q.west, -100.125);
    assert.equal(q.east, -100);
    assert.equal(q.step, 0.125);
    assert.equal(q.trimmed, false);
  });

  test('always contains the view', () => {
    for (const step of [0.05, 0.125, 0.25, 0.5, 1]) {
      const q = S.snapFixed(view, step);
      assert.ok(S.boxContains(q, view), `step ${step}`);
    }
  });

  test('nearby views inside one cell produce the same box', () => {
    const a = S.snapFixed({ south: 35.01, west: -99.99, north: 35.02, east: -99.98 }, 0.25);
    const b = S.snapFixed({ south: 35.11, west: -99.9, north: 35.13, east: -99.8 }, 0.25);
    assert.deepEqual(a, b);
  });

  test('collapsed edges are widened to one cell', () => {
    const q = S.snapFixed({ south: 85, west: 180, north: 85, east: 180 }, 0.5);
    assert.ok(q.north > q.south);
    assert.ok(q.east > q.west);
  });

  test('a view wider than maxDeg is trimmed around its centre and flagged', () => {
    const wide = { south: 30, west: -105, north: 40, east: -95 };
    const q = S.snapFixed(wide, 0.125, 0.75);
    assert.equal(q.trimmed, true);
    assert.ok(q.north - q.south <= 0.75 + 1e-9);
    assert.ok(q.east - q.west <= 0.75 + 1e-9);
    // Still centred on the view.
    assert.ok(q.south <= 35 && q.north >= 35);
    assert.ok(q.west <= -100 && q.east >= -100);
  });

  test('values are rounded to 4 dp, so keys do not carry float noise', () => {
    const q = S.snapFixed({ south: 0.1, west: 0.1, north: 0.2, east: 0.2 }, 0.05);
    for (const v of [q.south, q.west, q.north, q.east]) assert.equal(v, Number(v.toFixed(4)));
  });
});

describe('viewCell', () => {
  test('returns the snapped box plus a key naming it', () => {
    const q = S.viewCell({ south: 35.01, west: -100.07, north: 35.06, east: -100.02 }, 'overpass');
    assert.equal(q.key, `${q.south},${q.west},${q.north},${q.east}`);
  });

  test('every kind used by the server has a cell size', () => {
    for (const kind of ['alpr', 'overpass', 'flights', 'events', 'traffic', 'atlas', 'shake', 'iot', 'cell', 'wigle']) {
      assert.ok(S.VIEW_CELL_DEG[kind] > 0, kind);
    }
  });

  test('flights are capped at 5x5 degrees, the one-credit OpenSky band', () => {
    const q = S.viewCell({ south: 20, west: -120, north: 50, east: -70 }, 'flights');
    assert.ok((q.north - q.south) * (q.east - q.west) <= 25);
  });

  test('throws for an unknown kind', () => {
    assert.throws(() => S.viewCell({ south: 0, west: 0, north: 1, east: 1 }, 'nope'), /no view cell size/);
  });
});

describe('boxContains', () => {
  test('boxContains', () => {
    const outer = { south: 0, west: 0, north: 10, east: 10 };
    assert.equal(S.boxContains(outer, { south: 1, west: 1, north: 2, east: 2 }), true);
    assert.equal(S.boxContains(outer, outer), true);
    assert.equal(S.boxContains(outer, { south: -1, west: 1, north: 2, east: 2 }), false);
  });

});

describe('country centroids', () => {
  test('are valid coordinates', () => {
    for (const [cc, [lat, lon]] of Object.entries(S.COUNTRY_CENTROIDS)) {
      assert.match(cc, /^[A-Z]{2}$/);
      assert.ok(lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180, cc);
    }
  });
});

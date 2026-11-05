// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { levelFor } from '../../../public/js/uniform.js';

describe('levelFor', () => {
  test('one 256 px tile per ground pixel at level 0 is the whole equator', () => {
    assert.equal(levelFor((2 * Math.PI * 6378137) / 256, 0), 0);
  });

  test('halving the ground per pixel adds one level', () => {
    const a = levelFor(10, 0.6);
    assert.equal(levelFor(5, 0.6), a + 1);
  });

  test('~19 m/px over Raleigh is about level 13', () => {
    assert.equal(levelFor(15.5, 35.8 * Math.PI / 180), 13);
  });
});

describe('UniformDetail at altitude', () => {
  /** Just enough viewer for the pinning logic, with no rendering. */
  function fakeViewer(height) {
    const ev = () => ({ addEventListener() {} });
    const layers = [];
    return {
      camera: { positionCartographic: { height }, moveEnd: ev(), changed: ev() },
      scene: {
        globe: { tileLoadProgressEvent: ev(), baseColor: 'blue', tilesLoaded: false },
        requestRender() {},
      },
      imageryLayers: {
        _list: layers,
        add: (l, i) => layers.splice(i ?? layers.length, 0, l),
        remove: (l) => { const i = layers.indexOf(l); if (i >= 0) layers.splice(i, 1); },
        contains: (l) => layers.includes(l),
        indexOf: (l) => layers.indexOf(l),
      },
    };
  }

  test('above the release height it lets go and shows the base map again', async () => {
    globalThis.Cesium = { Color: { clone: (c) => c, fromCssColorString: (c) => c } };
    const { UniformDetail, RELEASE_ABOVE_M } = await import('../../../public/js/uniform.js');
    const viewer = fakeViewer(RELEASE_ABOVE_M + 50_000);
    const base = { show: false };
    viewer.imageryLayers.add(base);
    const u = new UniformDetail(viewer, () => base);
    // As if a pinned layer had been showing with the base hidden.
    u.layer = { alpha: 1 }; viewer.imageryLayers.add(u.layer);
    u.hidden = base; u.baseColor = 'blue'; viewer.scene.globe.baseColor = '#06090d';
    await u.update();
    assert.equal(u.active, false);
    assert.equal(base.show, true, 'base map is back');
    assert.equal(viewer.scene.globe.baseColor, 'blue', 'no dark globe');
    assert.ok(!viewer.imageryLayers.contains(u.layer));
  });

  test('a new level shows the base while it loads, instead of a dark globe', async () => {
    const tiles = { maximumLevel: 19 };
    globalThis.Cesium = {
      Color: { clone: (c) => c, fromCssColorString: (c) => c },
      ImageryLayer: class { constructor(p, o) { this.provider = p; Object.assign(this, o); } },
    };
    const { UniformDetail } = await import('../../../public/js/uniform.js');
    const viewer = fakeViewer(100_000);
    const base = { show: false };
    viewer.imageryLayers.add(base);
    const u = new UniformDetail(viewer, () => base);
    u.hidden = base; u.baseColor = 'blue'; viewer.scene.globe.baseColor = '#06090d';
    u.build(tiles, { tier: 'low', level: 6, floor: 9 }, base);
    clearTimeout(u.flushTimer);
    assert.equal(base.show, true, 'the base fills in while the new level loads');
    assert.equal(viewer.scene.globe.baseColor, 'blue');
    assert.equal(u.layer.alpha, 0, 'the new level is still loading invisibly');
  });
});

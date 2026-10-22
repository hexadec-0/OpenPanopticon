// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installCesium, makeViewer } from '../../helpers/cesium-stub.mjs';
import { installDom } from '../../helpers/dom-stub.mjs';
import { encodeMvt } from '../../helpers/mvt-encode.mjs';
import { OPTICAL_MODES, OpticsController } from '../../../public/js/optics.js';
import { zoomForHeight, INSET_STYLES } from '../../../public/js/inset.js';
import { SelectionMarker } from '../../../public/js/selection.js';
import { ShortbreadImageryProvider, SHORTBREAD_PALETTE, SHORTBREAD_LAYERS } from '../../../public/js/shortbread.js';

let dom;
beforeEach(() => { installCesium(); dom = installDom(); });

describe('optics', () => {
  test('five modes, each with a label, a caption and a HUD colour', () => {
    assert.deepEqual(Object.keys(OPTICAL_MODES), ['eo', 'flir', 'sar', 'crt', 'cel']);
    for (const [k, m] of Object.entries(OPTICAL_MODES)) {
      assert.ok(m.label && m.caption, k);
      assert.match(m.hud, /^#[0-9a-f]{6}$/i, k);
    }
  });

  test('EO is unfiltered; every other mode is a complete fragment shader', () => {
    assert.equal(OPTICAL_MODES.eo.shader, null);
    for (const k of ['flir', 'sar', 'crt', 'cel']) {
      const src = OPTICAL_MODES[k].shader;
      assert.match(src, /void main\(\)/, k);
      assert.match(src, /out_FragColor\s*=/, k);
      assert.match(src, /uniform sampler2D colorTexture/, k);
      assert.match(src, /in vec2 v_textureCoordinates/, k);
      assert.doesNotMatch(src, /gl_FragColor|texture2D\(/, `${k} uses WebGL1-only GLSL`);
    }
  });

  test('the controller swaps one post-process stage in and out', () => {
    const viewer = makeViewer();
    const o = new OpticsController(viewer);
    const stages = viewer.scene.postProcessStages._list;
    o.set('flir');
    assert.equal(stages.length, 1);
    assert.equal(stages[0].name, 'openpanopticon_flir');
    assert.equal(o.mode, 'flir');
    o.set('sar');
    assert.equal(stages.length, 1);
    assert.equal(stages[0].name, 'openpanopticon_sar');
    o.set('eo');
    assert.equal(stages.length, 0);
    o.set('nonsense');
    assert.equal(o.mode, 'eo');
  });

  test('uniforms report the drawing buffer size and elapsed time', () => {
    const viewer = makeViewer();
    const o = new OpticsController(viewer);
    o.set('crt');
    const u = viewer.scene.postProcessStages._list[0].uniforms;
    const res = u.resolution();
    assert.equal(res.x, 800);
    assert.equal(res.y, 600);
    assert.ok(u.uTime() >= 0);
    viewer.scene.context = {};
    assert.equal(u.resolution().x, 1920, 'falls back before the context exists');
  });
});

describe('inset map helpers', () => {
  test('zoom follows how high the picked thing is', () => {
    assert.equal(zoomForHeight(0), 17);
    assert.equal(zoomForHeight(1000), 17);
    assert.equal(zoomForHeight(10_000), 13);
    assert.equal(zoomForHeight(400_000), 6);
  });

  test('tile URL templates (ArcGIS is row/column order)', () => {
    assert.equal(INSET_STYLES.streets.url(5, 10, 12), 'https://tile.openstreetmap.org/5/10/12.png');
    assert.equal(INSET_STYLES.aerial.url(5, 10, 12),
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/5/12/10');
    for (const s of Object.values(INSET_STYLES)) assert.ok(s.label && s.credit);
  });
});

describe('SelectionMarker', () => {
  test('starts hidden; select shows it, clear hides it', () => {
    const m = new SelectionMarker(makeViewer());
    assert.equal(m.entity.show, false);
    m.select({ lat: 1, lon: 2 }, '#ff0000');
    assert.equal(m.entity.show, true);
    m.clear();
    assert.equal(m.entity.show, false);
    assert.equal(m.target, null);
    m.select(null);
    assert.equal(m.entity.show, false);
  });

  test('clamps the ring to the ground only for ground pins', () => {
    const m = new SelectionMarker(makeViewer());
    m.select({ lat: 1, lon: 2, clampToGround: true });
    assert.equal(m.entity.billboard.heightReference, Cesium.HeightReference.CLAMP_TO_GROUND);
    m.select({ lat: 1, lon: 2, height: 10000 });
    assert.equal(m.entity.billboard.heightReference, Cesium.HeightReference.NONE);
  });

  test('follows the live entity, then the primitive, then the record coordinates', () => {
    const m = new SelectionMarker(makeViewer());
    const live = { x: 1, y: 2, z: 3 };
    const layer = { id: 'flights', enabled: true, source: { entities: { getById: (id) => (id === 'abc' ? { position: { getValue: () => live } } : undefined) } } };
    m.select({ layer, entityId: 'abc', lat: 9, lon: 9 });
    assert.equal(m.position(), live);

    const prim = { position: { x: 7 }, isDestroyed: () => false };
    m.select({ layer, entityId: 'gone', primitive: prim, lat: 9, lon: 9 });
    assert.equal(m.position(), prim.position);

    prim.isDestroyed = () => true;
    const p = m.position();
    assert.equal(p.lat, 9);
    assert.equal(p.lon, 9);
  });

  test('a primitive that throws when read (collection rebuilt) falls back cleanly', () => {
    const m = new SelectionMarker(makeViewer());
    const prim = { isDestroyed: () => false, get position() { throw new Error('destroyed'); } };
    m.select({ primitive: prim, lat: 4, lon: 5, height: 100 });
    assert.equal(m.position().h, 100);
  });

  test('a hidden layer hides the ring, and owns() tracks the owning layer', () => {
    const m = new SelectionMarker(makeViewer());
    const layer = { id: 'events', enabled: true };
    m.select({ layer, lat: 1, lon: 1 });
    assert.equal(m.owns('events'), true);
    assert.equal(m.owns('flights'), false);
    layer.enabled = false;
    assert.equal(m.position(), undefined);
    m.select({});
    assert.equal(m.position(), undefined, 'nothing to place it at');
  });

  test('the pulse is a gentle breathe around 1', () => {
    const m = new SelectionMarker(makeViewer());
    m.select({ lat: 1, lon: 1 });
    for (let i = 0; i < 20; i++) {
      const v = m.pulse();
      assert.ok(v >= 0.88 && v <= 1.12, String(v));
    }
  });

  test('draws the ring on a canvas once per accent colour', () => {
    const before = dom.created.filter((e) => e.getContext).length;
    const m = new SelectionMarker(makeViewer());
    m.select({ lat: 1, lon: 1 }, '#123456');
    m.select({ lat: 1, lon: 1 }, '#123456');
    // Textures are cached for the life of the module, so the default accent
    // was drawn by an earlier test; only #123456 is new, and only once.
    const canvases = dom.created.filter((e) => e.getContext).slice(before);
    assert.equal(canvases.length, 1);
    const calls = canvases[0].ctx.calls;
    assert.ok(calls.some(([op, v]) => op === 'set:strokeStyle' && v === 'rgba(18,52,86,1)'), 'accent colour converted to rgba');
    assert.ok(calls.some(([op]) => op === 'arc'));
    assert.equal(m.entity.billboard.image, 'data:image/png;base64,STUB');
  });

  test('falls back to an SVG ring where there is no 2D canvas', () => {
    globalThis.document.createElement = () => ({ getContext: () => null });
    const m = new SelectionMarker(makeViewer());
    m.select({ lat: 1, lon: 1 }, '#abc');
    assert.match(m.entity.billboard.image, /^data:image\/svg\+xml/);
    assert.ok(decodeURIComponent(m.entity.billboard.image).includes('rgba(170,187,204,1)'), '#rgb expanded');
  });
});

describe('ShortbreadImageryProvider', () => {
  const draws = (canvas) => canvas.ctx.calls;

  test('presents Cesium\'s imagery provider surface', () => {
    const p = new ShortbreadImageryProvider({ url: 'https://t.example/{z}/{x}/{y}', maximumLevel: 12, tileSize: 256 });
    assert.equal(p.ready, true);
    assert.equal(p.tileWidth, 256);
    assert.equal(p.maximumLevel, 12);
    assert.equal(p.minimumLevel, 0);
    assert.equal(p.hasAlphaChannel, false);
    assert.deepEqual(p.getTileCredits(), [p.credit]);
    assert.equal(p.pickFeatures(), undefined);
    assert.ok(p.rectangle);
    return p.readyPromise.then((v) => assert.equal(v, true));
  });

  test('fills the URL template and draws the drawn layers in map order', async () => {
    const tile = encodeMvt([
      { name: 'water_polygons', features: [{ type: 'polygon', rings: [[0, 0, 4096, 0, 4096, 4096]] }] },
      { name: 'streets', features: [
        { type: 'line', props: { kind: 'motorway' }, rings: [[0, 0, 4096, 4096]] },
        { type: 'line', props: { kind: 'residential' }, rings: [[0, 4096, 4096, 0]] },
      ] },
      { name: 'buildings', features: [{ type: 'polygon', rings: [[10, 10, 20, 10, 20, 20]] }] },
      { name: 'pois', features: [{ type: 'point', rings: [[5, 5]] }] },
    ]);
    const fetchMock = mock.fn(async () => new Response(tile, { status: 200 }));
    globalThis.fetch = fetchMock;
    const p = new ShortbreadImageryProvider({ url: 'https://t.example/{z}/{x}/{y}' });
    const canvas = await p.requestImage(3, 4, 5);
    assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://t.example/5/3/4');
    assert.equal(canvas.width, 512);
    const fills = draws(canvas).filter(([op]) => op === 'set:fillStyle').map(([, v]) => v);
    assert.equal(fills[0], SHORTBREAD_PALETTE.background);
    assert.ok(fills.includes(SHORTBREAD_PALETTE.water));
    assert.ok(fills.includes(SHORTBREAD_PALETTE.building));
    // Minor roads first, majors over the top.
    const strokes = draws(canvas).filter(([op]) => op === 'set:strokeStyle').map(([, v]) => v);
    assert.ok(strokes.indexOf(SHORTBREAD_PALETTE.roadMinor) < strokes.indexOf(SHORTBREAD_PALETTE.motorway));
    assert.ok(!SHORTBREAD_LAYERS.has('pois'));
  });

  test('204 and 404 are "nothing here": a blank tile, no warning', async () => {
    const warn = mock.method(console, 'warn', () => {});
    for (const code of [204, 404]) {
      globalThis.fetch = async () => new Response(null, { status: code });
      const c = await new ShortbreadImageryProvider().requestImage(0, 0, 0);
      assert.deepEqual(draws(c).filter(([op]) => op === 'fillRect').length, 1);
    }
    assert.equal(warn.mock.callCount(), 0);
    warn.mock.restore();
  });

  test('a failing server gives a blank tile and warns only a few times', async () => {
    const warn = mock.method(console, 'warn', () => {});
    globalThis.fetch = async () => new Response('x', { status: 500 });
    const p = new ShortbreadImageryProvider();
    for (let i = 0; i < 6; i++) await p.requestImage(i, 0, 1);
    assert.equal(warn.mock.callCount(), 3);
    warn.mock.restore();
  });

  test('an undecodable tile gives a blank tile', async () => {
    const warn = mock.method(console, 'warn', () => {});
    globalThis.fetch = async () => new Response(Uint8Array.from([0x0b, 0x00]), { status: 200 });
    const c = await new ShortbreadImageryProvider().requestImage(0, 0, 0);
    assert.equal(draws(c).filter(([op]) => op === 'fillRect').length, 1);
    assert.match(String(warn.mock.calls[0].arguments[0]), /undecodable/);
    warn.mock.restore();
  });
});

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installDom, MemoryStorage } from '../../helpers/dom-stub.mjs';
import * as Settings from '../../../public/js/settings.js';

const KEY = 'openpanopticon.settings.v1';
const LEGACY = 'worldview.settings.v1';

let dom;
beforeEach(() => { dom = installDom(); });

/** The shape of the app object that collect() and apply() read. */
function fakeApp() {
  return {
    mode: 'flir',
    queryCeilingM: 100_000,
    autoRefresh: false,
    autoCycle: { on: true, intervalS: 30, excluded: new Set(['satellites']) },
    layers: {
      shodan: { enabled: true, colorBy: 'risk' },
      flights: { enabled: true, showLabels: false, showTrails: true },
      satellites: { enabled: false, group: 'starlink', limit: 500 },
      overpass: { enabled: true, presets: new Set(['power', 'military']) },
      alpr: { enabled: false, vendorFilter: new Set(['flock']), showCones: false, onlyWithDirection: true },
      events: { enabled: true, sources: new Set(['usgs']), minSeverity: 'orange', showPolygons: false },
      netinfra: { enabled: false, sources: new Set(['atlas', 'tor']), showRanges: false },
      iot: { enabled: false, colorBy: 'noise', includeIndoor: true },
      traffic: { enabled: false, showCameras: true, showIncidents: false },
      vessels: { enabled: false, showNames: false, movingOnly: true },
    },
    home: { lat: 51.5, lon: -0.12, h: 3000, label: 'London', source: 'manual' },
    basemap: { provider: 'sentinel2', from: '2026-09-01', to: '2026-09-30', maxCloud: 20 },
    weather: { radarOn: true, satOn: false },
    imagery: { on: true, selected: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance', date: '2026-10-01', alpha: 0.5 },
    labels: { on: true, style: 'light', contrast: 3, boost: false, setContrast(c) { this.contrast = c; } },
  };
}

/** A fresh app with defaults, for apply() to push saved state into. */
function blankApp() {
  const a = fakeApp();
  Object.assign(a.layers.shodan, { colorBy: 'category' });
  Object.assign(a.layers.flights, { showLabels: true });
  Object.assign(a.layers.satellites, { group: 'stations', limit: 250 });
  a.layers.overpass.presets = new Set(['surveillance']);
  a.layers.alpr.vendorFilter = new Set();
  a.layers.events.sources = new Set(['gdacs', 'eonet', 'usgs', 'nws']);
  a.home = null;
  a.basemap = { provider: 'osm', from: null, to: null, maxCloud: 40 };
  a.labels = { on: false, style: 'dark', contrast: 2.2, boost: true, setContrast(c) { this.contrast = c; } };
  a.imagery = { on: false, selected: 'VIIRS_SNPP_CorrectedReflectance_TrueColor', date: null, alpha: 0.85 };
  return a;
}

describe('load / save / clear', () => {
  test('round-trips through localStorage', () => {
    assert.equal(Settings.save({ a: 1 }), true);
    assert.deepEqual(JSON.parse(dom.storage.getItem(KEY)), { a: 1 });
    assert.deepEqual(Settings.load(), { a: 1 });
  });

  test('nothing stored reads as {}', () => assert.deepEqual(Settings.load(), {}));

  test('corrupt or non-object data reads as {}', () => {
    dom.storage.setItem(KEY, '{nope');
    assert.deepEqual(Settings.load(), {});
    dom.storage.setItem(KEY, '42');
    assert.deepEqual(Settings.load(), {});
    dom.storage.setItem(KEY, 'null');
    assert.deepEqual(Settings.load(), {});
  });

  test('migrates the pre-rename key once', () => {
    dom.storage.setItem(LEGACY, JSON.stringify({ mode: 'sar' }));
    assert.deepEqual(Settings.load(), { mode: 'sar' });
    assert.equal(dom.storage.getItem(LEGACY), null);
    assert.equal(JSON.parse(dom.storage.getItem(KEY)).mode, 'sar');
  });

  test('the new key wins over a leftover legacy one', () => {
    dom.storage.setItem(KEY, JSON.stringify({ mode: 'crt' }));
    dom.storage.setItem(LEGACY, JSON.stringify({ mode: 'sar' }));
    assert.equal(Settings.load().mode, 'crt');
  });

  test('clear removes both keys', () => {
    dom.storage.setItem(KEY, '{}');
    dom.storage.setItem(LEGACY, '{}');
    assert.equal(Settings.clear(), true);
    assert.equal(dom.storage.length, 0);
  });

  test('blocked storage degrades to defaults instead of throwing', () => {
    globalThis.localStorage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('x'); }, removeItem() { throw new Error('x'); } };
    assert.deepEqual(Settings.load(), {});
    assert.equal(Settings.save({}), false);
    assert.equal(Settings.clear(), false);
  });

  test('a full quota is reported, not thrown', () => {
    const st = new MemoryStorage();
    st.throwOnWrite = true;
    globalThis.localStorage = st;
    assert.equal(Settings.save({ a: 1 }), false);
  });
});

describe('collect', () => {
  test('captures every layer filter, overlay and UI preference', () => {
    dom.classes.add('sidebar-collapsed');
    const s = Settings.collect(fakeApp());
    assert.equal(s.version, 1);
    assert.ok(Date.parse(s.savedAt));
    assert.equal(s.mode, 'flir');
    assert.equal(s.queryCeilingM, 100_000);
    assert.equal(s.autoRefresh, false);
    assert.deepEqual(s.cycle, { on: true, intervalS: 30, excluded: ['satellites'] });
    assert.equal(s.sidebarCollapsed, true);
    assert.equal(s.enabled.shodan, true);
    assert.equal(s.enabled.satellites, false);
    assert.deepEqual(s.overpass.presets.sort(), ['military', 'power']);
    assert.deepEqual(s.alpr, { vendorFilter: ['flock'], showCones: false, onlyWithDirection: true });
    assert.deepEqual(s.events, { sources: ['usgs'], minSeverity: 'orange', showPolygons: false });
    assert.deepEqual(s.basemap, { provider: 'sentinel2', from: '2026-09-01', to: '2026-09-30', maxCloud: 20 });
    assert.deepEqual(s.overlays, {
      radar: true, clouds: false, imagery: true, imageryLayer: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance',
      imageryDate: '2026-10-01', imageryAlpha: 0.5, labels: true, labelStyle: 'light', labelContrast: 3, labelBoost: false,
    });
  });

  test('is JSON-serialisable (no Sets or Maps survive)', () => {
    const s = Settings.collect(fakeApp());
    assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  });

  test('writes a pinned home, but not one resolved from the host', () => {
    const a = fakeApp();
    assert.equal(Settings.collect(a).home.label, 'London');
    a.home = { ...a.home, source: 'geoip-pinned' };
    assert.equal(Settings.collect(a).home.source, 'geoip-pinned');
    for (const source of ['geoip', 'fallback', undefined]) {
      a.home = { lat: 1, lon: 2, label: 'x', source };
      assert.equal(Settings.collect(a).home, null, String(source));
    }
  });

  test('copes with an app that has no cycle or basemap yet', () => {
    const a = fakeApp();
    a.autoCycle = null;
    a.basemap = null;
    const s = Settings.collect(a);
    assert.equal(s.cycle, null);
    assert.deepEqual(s.basemap, { provider: 'osm', from: null, to: null, maxCloud: 40 });
  });
});

describe('apply', () => {
  test('a collect/apply round trip restores the state', () => {
    const saved = JSON.parse(JSON.stringify(Settings.collect(fakeApp())));
    const app = blankApp();
    const out = Settings.apply(app, saved);
    assert.equal(app.layers.shodan.colorBy, 'risk');
    assert.equal(app.layers.flights.showLabels, false);
    assert.equal(app.layers.satellites.group, 'starlink');
    assert.equal(app.layers.satellites.limit, 500);
    assert.deepEqual([...app.layers.overpass.presets].sort(), ['military', 'power']);
    assert.ok(app.layers.overpass.presets instanceof Set);
    assert.deepEqual([...app.layers.alpr.vendorFilter], ['flock']);
    assert.equal(app.layers.events.minSeverity, 'orange');
    assert.equal(app.layers.iot.colorBy, 'noise');
    assert.equal(app.layers.vessels.movingOnly, true);
    assert.equal(app.home.label, 'London');
    assert.equal(app.basemap.from, '2026-09-01');
    assert.equal(app.basemap.maxCloud, 20);
    assert.equal(app.labels.style, 'light');
    assert.equal(app.labels.contrast, 3);
    assert.equal(app.labels.boost, false);
    assert.equal(app.imagery.alpha, 0.5);
    assert.equal(out.mode, 'flir');
    assert.equal(out.queryCeilingM, 100_000);
    assert.equal(out.autoRefresh, false);
    assert.deepEqual(out.cycle, { on: true, intervalS: 30, excluded: ['satellites'] });
    assert.equal(out.enabled.overpass, true);
    assert.equal(out.overlays.radar, true);
    assert.equal(out.basemap.provider, 'sentinel2');
  });

  test('null or junk is ignored', () => {
    assert.equal(Settings.apply(blankApp(), null), null);
    assert.equal(Settings.apply(blankApp(), 'x'), null);
  });

  test('a settings blob from an older build only touches what it has', () => {
    const app = blankApp();
    const out = Settings.apply(app, { shodan: { colorBy: 'risk' } });
    assert.equal(app.layers.shodan.colorBy, 'risk');
    assert.deepEqual([...app.layers.overpass.presets], ['surveillance']);
    assert.equal(out.mode, null);
    assert.equal(out.enabled, null);
    assert.equal(out.autoRefresh, null);
  });

  test('wrong types fall back to the current value', () => {
    const app = blankApp();
    Settings.apply(app, {
      flights: { showLabels: 'no', showTrails: 0 },
      overpass: { presets: 'power' },
      satellites: { limit: 'lots' },
      cycle: { on: 'yes', intervalS: '15', excluded: ['a', 1, null] },
    });
    assert.equal(app.layers.flights.showLabels, true);
    assert.equal(app.layers.flights.showTrails, true);
    assert.deepEqual([...app.layers.overpass.presets], ['surveillance']);
    assert.equal(app.layers.satellites.limit, 250);
    const out = Settings.apply(blankApp(), { cycle: { on: 'yes', intervalS: '15', excluded: ['a', 1, null] } });
    assert.deepEqual(out.cycle, { on: false, intervalS: 15, excluded: ['a'] });
  });

  describe('a stored home is validated, not trusted', () => {
    const tryHome = (home) => { const app = blankApp(); Settings.apply(app, { home }); return app.home; };

    test('accepts a pinned home and fills defaults', () => {
      assert.deepEqual(tryHome({ lat: '10.5', lon: -20, source: 'manual' }),
        { lat: 10.5, lon: -20, h: 4500, label: '10.5000, -20.0000', source: 'manual' });
    });

    test('caps an over-long label', () => {
      assert.equal(tryHome({ lat: 1, lon: 1, label: 'x'.repeat(200), source: 'manual' }).label.length, 80);
    });

    for (const [why, home] of [
      ['an unpinned source', { lat: 1, lon: 1, source: 'geoip' }],
      ['null coordinates (would be 0,0)', { lat: null, lon: null, source: 'manual' }],
      ['empty strings (would be 0,0)', { lat: '', lon: ' ', source: 'manual' }],
      ['non-numeric', { lat: 'north', lon: 'west', source: 'manual' }],
      ['latitude out of range', { lat: 91, lon: 0, source: 'manual' }],
      ['longitude out of range', { lat: 0, lon: 181, source: 'manual' }],
    ]) {
      test(`rejects ${why}`, () => assert.equal(tryHome(home), null));
    }
  });
});

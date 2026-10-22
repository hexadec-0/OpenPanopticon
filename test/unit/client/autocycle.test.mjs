// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { installCesium, makeViewer } from '../../helpers/cesium-stub.mjs';
import { installDom } from '../../helpers/dom-stub.mjs';
import { AutoCycle, CYCLE_STEPS_S } from '../../../public/js/autocycle.js';

/** An entity-backed layer with records drawn at the given screen positions. */
function entityLayer(points, { enabled = true, detail = true } = {}) {
  const ents = points.map(([x, y, rec], i) => ({
    id: `e${i}`,
    position: { getValue: () => (x == null ? undefined : { x, y }) },
    properties: { layer: 'x', record: rec },
    isShowing: true,
  }));
  return {
    enabled,
    detail: detail ? () => ({}) : undefined,
    source: { entities: { values: ents } },
    _ents: ents,
  };
}

function makeApp(layers) {
  const picks = [];
  return { viewer: makeViewer(), layers, selectPicked: (p) => picks.push(p), picks };
}

beforeEach(() => {
  installCesium();
  installDom();
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
});
afterEach(() => mock.timers.reset());

describe('AutoCycle', () => {
  test('offers 15, 30 and 60 second steps, starting at 15', () => {
    assert.deepEqual(CYCLE_STEPS_S, [15, 30, 60]);
    assert.equal(new AutoCycle(makeApp({})).intervalS, 15);
  });

  test('switching on picks something straight away, then on every interval', () => {
    const a = { id: 'a' }; const b = { id: 'b' };
    const app = makeApp({ flights: entityLayer([[100, 100, a], [200, 200, b]]) });
    const changes = [];
    const c = new AutoCycle(app, (s) => changes.push(s.on));
    c.setEnabled(true);
    assert.equal(app.picks.length, 1);
    assert.ok(changes.length > 0);
    mock.timers.tick(15_000);
    assert.equal(app.picks.length, 2);
    mock.timers.tick(15_000);
    assert.equal(app.picks.length, 3);
  });

  test('never picks the same record twice running when there is a choice', () => {
    const recs = [{ id: 1 }, { id: 2 }];
    const app = makeApp({ flights: entityLayer([[100, 100, recs[0]], [200, 200, recs[1]]]) });
    const c = new AutoCycle(app);
    c.setEnabled(true);
    for (let i = 0; i < 10; i++) mock.timers.tick(15_000);
    const seq = app.picks.map((p) => p.id.properties.record.id);
    for (let i = 1; i < seq.length; i++) assert.notEqual(seq[i], seq[i - 1]);
  });

  test('with a single candidate it keeps showing it', () => {
    const app = makeApp({ flights: entityLayer([[100, 100, { id: 1 }]]) });
    const c = new AutoCycle(app);
    c.setEnabled(true);
    mock.timers.tick(15_000);
    assert.equal(app.picks.length, 2);
  });

  test('with nothing in view it says so and keeps trying', () => {
    const app = makeApp({ flights: entityLayer([]) });
    const c = new AutoCycle(app);
    c.setEnabled(true);
    assert.equal(c.empty, true);
    assert.equal(app.picks.length, 0);
    app.layers.flights = entityLayer([[100, 100, { id: 1 }]]);
    mock.timers.tick(15_000);
    assert.equal(c.empty, false);
    assert.equal(app.picks.length, 1);
  });

  test('switching off stops the timers and clears the empty flag', () => {
    const app = makeApp({ flights: entityLayer([]) });
    const c = new AutoCycle(app);
    c.setEnabled(true);
    c.setEnabled(false);
    assert.equal(c.on, false);
    assert.equal(c.empty, false);
    assert.equal(c.timer, null);
    mock.timers.tick(120_000);
    assert.equal(app.picks.length, 0);
    assert.equal(c.remaining(), 0);
  });

  test('toggle and idempotent setEnabled', () => {
    const c = new AutoCycle(makeApp({}));
    c.toggle(); assert.equal(c.on, true);
    c.setEnabled(true); assert.equal(c.on, true);
    c.toggle(); assert.equal(c.on, false);
  });

  test('changing the interval reschedules; values off the menu are ignored', () => {
    const app = makeApp({ flights: entityLayer([[100, 100, { id: 1 }], [200, 200, { id: 2 }]]) });
    const c = new AutoCycle(app);
    c.setEnabled(true);
    c.setIntervalS(60);
    assert.equal(c.intervalS, 60);
    mock.timers.tick(30_000);
    assert.equal(app.picks.length, 1);
    mock.timers.tick(30_000);
    assert.equal(app.picks.length, 2);
    c.setIntervalS(45);
    assert.equal(c.intervalS, 60);
  });

  test('a manual pick restarts the countdown', () => {
    const app = makeApp({ flights: entityLayer([[100, 100, { id: 1 }], [200, 200, { id: 2 }]]) });
    const c = new AutoCycle(app);
    c.setEnabled(true);
    mock.timers.tick(10_000);
    c.restart();
    mock.timers.tick(10_000);
    assert.equal(app.picks.length, 1, 'not yet: the interval restarted');
    mock.timers.tick(5_000);
    assert.equal(app.picks.length, 2);
  });

  test('excluding the layer on screen moves on immediately', () => {
    const app = makeApp({
      flights: entityLayer([[100, 100, { id: 'f' }]]),
      events: entityLayer([[300, 300, { id: 'e' }]]),
    });
    const c = new AutoCycle(app);
    c.setIncluded('events', false);
    c.setEnabled(true);
    assert.equal(c.lastLayer, 'flights');
    c.setIncluded('events', true);
    assert.equal(app.picks.length, 1, 'including a layer does not jump');
    c.setIncluded('flights', false);
    assert.equal(app.picks.length, 2, 'excluding the one on screen does');
    assert.equal(c.lastLayer, 'events');
    c.setIncluded('events', false);
    assert.equal(c.empty, true, 'nothing left to pick');
    assert.equal(c.includes('flights'), false);
    c.setIncluded('flights', true);
    assert.equal(c.includes('flights'), true);
  });

  test('a failing select does not stop the cycle', () => {
    const app = makeApp({ flights: entityLayer([[100, 100, { id: 1 }], [200, 200, { id: 2 }]]) });
    app.selectPicked = () => { throw new Error('boom'); };
    const warn = mock.method(console, 'warn', () => {});
    const c = new AutoCycle(app);
    c.setEnabled(true);
    mock.timers.tick(15_000);
    assert.equal(warn.mock.callCount(), 2);
    assert.equal(c.on, true);
    warn.mock.restore();
  });
});

describe('AutoCycle.candidates', () => {
  test('only items from enabled, included layers that open a detail panel', () => {
    const c = new AutoCycle(makeApp({
      on: entityLayer([[100, 100, { id: 1 }]]),
      off: entityLayer([[100, 100, { id: 2 }]], { enabled: false }),
      nodetail: entityLayer([[100, 100, { id: 3 }]], { detail: false }),
      excluded: entityLayer([[100, 100, { id: 4 }]]),
    }));
    c.setIncluded('excluded', false);
    assert.deepEqual(c.candidates().map((x) => x.record.id), [1]);
  });

  test('only items inside the viewport, away from the edges', () => {
    // Canvas is 800 x 600 in the stub viewer; the margin is 48 px.
    const c = new AutoCycle(makeApp({ l: entityLayer([
      [100, 100, { id: 'in' }], [10, 100, { id: 'left' }], [790, 100, { id: 'right' }],
      [100, 10, { id: 'top' }], [100, 590, { id: 'bottom' }], [null, null, { id: 'nopos' }],
    ]) }));
    assert.deepEqual(c.candidates().map((x) => x.record.id), ['in']);
  });

  test('items behind the globe are skipped', () => {
    const c = new AutoCycle(makeApp({ l: entityLayer([[100, 100, { id: 1 }]]) }));
    Cesium.EllipsoidalOccluder = class { isPointVisible() { return false; } };
    assert.equal(c.candidates().length, 0);
  });

  test('hidden entities, entities without a record, and duplicates are skipped', () => {
    const shared = { id: 'shared' };
    const layer = entityLayer([[100, 100, shared], [120, 120, shared], [140, 140, null], [160, 160, { id: 'hidden' }]]);
    layer._ents[3].isShowing = false;
    const c = new AutoCycle(makeApp({ l: layer }));
    assert.deepEqual(c.candidates().map((x) => x.record.id), ['shared']);
  });

  test('point-collection layers (satellites) are included', () => {
    const rec = { name: 'ISS' };
    const pts = [{ show: true, id: { layer: 'satellites', record: rec }, position: { x: 200, y: 200 } },
      { show: false, id: { layer: 'satellites', record: { name: 'hidden' } }, position: { x: 200, y: 200 } }];
    const c = new AutoCycle(makeApp({
      satellites: { enabled: true, detail: () => ({}), source: { entities: { values: [] } },
        points: { show: true, length: pts.length, get: (i) => pts[i] } },
    }));
    const out = c.candidates();
    assert.equal(out.length, 1);
    assert.equal(out[0].record, rec);
    assert.equal(out[0].picked.primitive, pts[0]);
  });

  test('stays clear of the open detail pane on the right', () => {
    globalThis.document.getElementById = (id) => (id === 'detail' ? { offsetWidth: 400 } : null);
    globalThis.getComputedStyle = () => ({ display: 'block' });
    globalThis.innerWidth = 800;
    const c = new AutoCycle(makeApp({ l: entityLayer([[100, 100, { id: 'left' }], [600, 100, { id: 'under-pane' }]]) }));
    assert.deepEqual(c.candidates().map((x) => x.record.id), ['left']);
  });
});

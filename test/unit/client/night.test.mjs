// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sunTimes } from '../../../public/js/night.js';

/** Minutes between a computed time and a published one. */
const off = (d, iso) => Math.abs(d.getTime() - Date.parse(iso)) / 60000;

describe('sunTimes', () => {
  test('Raleigh, 4 Nov 2026: sunrise ~06:39 EST, sunset ~17:16 EST', () => {
    const t = sunTimes(new Date('2026-11-04T21:00:00Z'), 35.78, -78.64);
    assert.ok(off(t.rise, '2026-11-04T11:39:00Z') < 5);
    assert.ok(off(t.set, '2026-11-04T22:16:00Z') < 5);
  });

  test('London midsummer: sunrise ~04:43 BST, sunset ~21:21 BST', () => {
    const t = sunTimes(new Date('2026-06-21T12:00:00Z'), 51.5, -0.12);
    assert.ok(off(t.rise, '2026-06-21T03:43:00Z') < 5);
    assert.ok(off(t.set, '2026-06-21T20:21:00Z') < 5);
  });

  test('east of Greenwich picks the local day, not the UTC one', () => {
    // 03:00Z is midday in Tokyo; its sunrise was the previous UTC evening.
    const t = sunTimes(new Date('2026-11-04T03:00:00Z'), 35.68, 139.69);
    assert.ok(t.rise < new Date('2026-11-04T03:00:00Z'));
    assert.ok(t.set > new Date('2026-11-04T03:00:00Z'));
  });

  test('polar night and midnight sun', () => {
    assert.equal(sunTimes(new Date('2026-12-21T12:00:00Z'), 78.2, 15.6).polar, 'night');
    assert.equal(sunTimes(new Date('2026-06-21T12:00:00Z'), 78.2, 15.6).polar, 'day');
  });
});

describe('marbleStrength', () => {
  test('faint below 50 km, building to full at 100 km', async () => {
    const { marbleStrength } = await import('../../../public/js/night.js');
    assert.equal(marbleStrength(10e3), 0);
    assert.ok(marbleStrength(40e3) > 0 && marbleStrength(40e3) < 0.15);
    assert.equal(marbleStrength(50e3), 0.15);
    let prev = 0.15;
    for (const km of [60, 70, 80, 90]) {
      const v = marbleStrength(km * 1e3);
      assert.ok(v > prev, `${km} km stronger than the last`);
      prev = v;
    }
    assert.equal(marbleStrength(100e3), 1);
    assert.equal(marbleStrength(400e3), 1);
  });
});

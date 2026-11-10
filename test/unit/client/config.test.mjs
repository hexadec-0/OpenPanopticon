// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pending, validSetting } from '../../../public/js/config.js';

const view = {
  credentials: [
    { name: 'SHODAN_API_KEY', set: true, fixed: false },
    { name: 'WINDY_API_KEY', set: false, fixed: false },
    { name: 'EIA_API_KEY', set: true, fixed: true },
  ],
  cache: [
    { name: 'maps.tiles', kind: 'duration', value: '30d', default: '30d' },
    { name: 'maps.tiles_max_size', kind: 'size', value: '4096MB', default: '4096MB' },
    { name: 'memory.max_entries', kind: 'count', value: '5000', default: '5000' },
  ],
};

describe('settings menu', () => {
  test('cache values are checked the way the server parses them', () => {
    for (const v of ['90s', '90', '1.5h', '3 d', '2W', '0', '250ms']) assert.equal(validSetting('duration', v), true, v);
    for (const v of ['', 'soon', '3 days', '-1d', 'd']) assert.equal(validSetting('duration', v), false, v);
    assert.equal(validSetting('size', '4GB'), true);
    assert.equal(validSetting('size', '4 gigs'), false);
    assert.equal(validSetting('count', '5000'), true);
    assert.equal(validSetting('count', '1.5'), false);
    assert.equal(validSetting('nonsense', '1'), false);
  });

  test('an untouched form sends nothing', () => {
    assert.deepEqual(pending(view, { credentials: {}, cache: {} }), { credentials: {}, cache: {}, invalid: [] });
    // A field typed in and emptied again leaves the stored key alone.
    assert.deepEqual(pending(view, { credentials: { SHODAN_API_KEY: { value: '  ', clear: false } }, cache: { 'maps.tiles': ' 30d ' } }),
      { credentials: {}, cache: {}, invalid: [] });
  });

  test('only what changed is sent; clearing sends an empty value', () => {
    const p = pending(view, {
      credentials: {
        SHODAN_API_KEY: { value: '', clear: true },
        WINDY_API_KEY: { value: ' abc ', clear: false },
        EIA_API_KEY: { value: 'ignored: fixed by the environment', clear: false },
      },
      cache: { 'maps.tiles': '2w', 'memory.max_entries': 'lots' },
    });
    assert.deepEqual(p.credentials, { SHODAN_API_KEY: '', WINDY_API_KEY: 'abc' });
    assert.deepEqual(p.cache, { 'maps.tiles': '2w' });
    assert.deepEqual(p.invalid, ['memory.max_entries']);
  });
});

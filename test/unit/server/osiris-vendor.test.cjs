'use strict';
// The vendored OSIRIS adapters must reach agencies as OpenPanopticon, never
// with the browser identities and made-up forwarding addresses upstream uses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const BUNDLE = path.join(__dirname, '../../../vendor/osiris/cctv.cjs');

test('every adapter request is sent with an honest identity', async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (input, init = {}) => {
    seen.push({ url: String(input), headers: new Headers(init.headers || {}) });
    return new Response('{}', { status: 503 });
  };
  globalThis.__OP_CCTV_UA = 'OpenPanopticon (test)';
  try {
    delete require.cache[BUNDLE];
    const m = require(BUNDLE);
    const regions = Object.keys(m.regionFetchers);
    assert.ok(regions.length > 50, `${regions.length} regions`);
    await Promise.allSettled(regions.map((r) => Promise.race([
      m.regionFetchers[r](), new Promise((res) => setTimeout(res, 3000)),
    ])));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.ok(seen.length > 50, `${seen.length} requests`);
  for (const { url, headers } of seen) {
    assert.equal(headers.get('user-agent'), 'OpenPanopticon (test)', url);
    for (const k of ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via', 'referer', 'origin', 'cookie']) {
      assert.equal(headers.get(k), null, `${k} on ${url}`);
    }
  }
});

test('the OpenCCTV adapter is not included', () => {
  const src = require('node:fs').readFileSync(BUNDLE, 'utf8');
  assert.ok(!/opencctv\.org\/api\/cameras\/batch/.test(src));
});

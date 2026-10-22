// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * A stand-in for every upstream API the server talks to.
 *
 * It replaces globalThis.fetch, so the real grab() code path runs unchanged:
 * headers, timeouts, status handling and JSON parsing are all exercised. Only
 * the network is fake. Requests to 127.0.0.1 / localhost pass straight through
 * to the real fetch, so a test can still talk to the server under test.
 *
 * Routes are matched newest first, which is what lets a test override one
 * upstream (make OpenSky answer 429, say) on top of the default fixtures.
 * Anything unmatched fails the way an unreachable host does, and is recorded
 * in `unmatched` so a test can assert that nothing leaked out unmocked.
 */

const { registerDefaults } = require('./fixtures.cjs');
const { toResponse, json, text, status, png, PNG_1PX, HANG } = require('./responses.cjs');

function matches(m, url, init) {
  if (typeof m === 'string') return url.href.includes(m);
  if (m instanceof RegExp) return m.test(url.href);
  if (typeof m === 'function') return !!m(url, init);
  return false;
}

class UpstreamMock {
  constructor({ defaults = true } = {}) {
    this.routes = [];
    this.calls = [];
    this.unmatched = [];
    this.realFetch = null;
    this.target = null;
    if (defaults) registerDefaults(this);
  }

  /** Add a route. `match` is a URL substring, a RegExp, or (url, init) => bool. */
  on(match, handler) {
    this.routes.push({ match, handler, times: Infinity });
    return this;
  }

  /** A route that answers once, then falls through to whatever is underneath. */
  once(match, handler) {
    this.routes.push({ match, handler, times: 1 });
    return this;
  }

  /** Shorthand: this upstream answers with an HTTP error. */
  fail(match, code = 500, body = 'upstream exploded', headers = {}) {
    return this.on(match, () => status(code, body, headers));
  }

  /** Shorthand: this upstream is unreachable (DNS / connection failure). */
  unreachable(match) {
    return this.on(match, () => { throw new TypeError('fetch failed'); });
  }

  /** Shorthand: this upstream never answers. */
  hang(match) { return this.on(match, () => HANG); }

  /** Drop test overrides and go back to the default fixtures. */
  reset() {
    this.routes = [];
    this.calls = [];
    this.unmatched = [];
    registerDefaults(this);
    return this;
  }

  /** Calls whose URL matches, for asserting on what the server sent. */
  callsTo(match) {
    return this.calls.filter((c) => matches(match, new URL(c.url), c));
  }

  install(target = globalThis) {
    this.target = target;
    this.realFetch = target.fetch;
    target.fetch = (input, init) => this.fetch(input, init);
    return this;
  }

  uninstall() {
    if (this.target && this.realFetch) this.target.fetch = this.realFetch;
    this.target = null;
  }

  async fetch(input, init = {}) {
    const href = typeof input === 'string' ? input
      : input instanceof URL ? input.href
        : input?.url ?? String(input);
    const url = new URL(href);

    // The server under test, and anything else local, is real.
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && this.realFetch) {
      return this.realFetch(input, init);
    }

    const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
    let body = init.body;
    if (body instanceof URLSearchParams) body = body.toString();
    const call = { url: url.href, method: (init.method || 'GET').toUpperCase(), headers, body };
    this.calls.push(call);

    for (let i = this.routes.length - 1; i >= 0; i--) {
      const r = this.routes[i];
      if (r.times <= 0 || !matches(r.match, url, call)) continue;
      r.times -= 1;
      const out = await r.handler({ url, init, call, params: url.searchParams, body });
      if (out === HANG) {
        return new Promise((_, reject) => {
          const signal = init.signal;
          const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
          if (signal?.aborted) abort();
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return toResponse(out);
    }

    this.unmatched.push(call);
    throw new TypeError(`fetch failed (unmocked upstream: ${url.origin}${url.pathname})`);
  }
}

module.exports = { UpstreamMock, json, text, status, png, PNG_1PX, HANG };

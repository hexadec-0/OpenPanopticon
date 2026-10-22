// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * layers.js — one class per intelligence source.
 *
 * Every layer owns a Cesium DataSource, knows how to refresh itself for the
 * current view, and returns a structured record when one of its entities is
 * picked. Nothing here talks to an upstream API directly — it all goes
 * through the local proxy on /api/*, which holds the credentials.
 */

import { ShortbreadImageryProvider } from './shortbread.js';

/**
 * How long to wait on each endpoint, in milliseconds.
 *
 * `fetch()` has no default timeout, so a request that never gets a response
 * never settles and the UI waiting on it hangs forever. But a blanket short
 * budget is just as wrong: the Overpass-backed routes can legitimately run
 * for minutes — the server tries three mirrors at 45s each, and every
 * Overpass caller shares one serial queue, so a second layer waits out the
 * first before its own attempt even starts. Cutting those off at 20s
 * reported a timeout while the server was still working, and nothing
 * appeared in its log because the request had not finished either way.
 *
 * Each budget below is the server's own worst case for that route plus
 * slack. The default covers the routes that talk to a single fast upstream.
 */
const API_TIMEOUTS = {
  // 3 Overpass mirrors x 45s, plus the wait for the shared queue.
  '/api/overpass': 180000,
  '/api/alpr': 180000,
  // Fan out across many upstreams at 25-30s each.
  '/api/webcams': 90000,
  '/api/events': 90000,
  '/api/netinfra': 90000,
  '/api/traffic': 90000,
  '/api/iot': 90000,
  '/api/signals': 90000,
  '/api/vessels': 60000,
  // CelesTrak at 30s, then parsing a few thousand TLEs.
  '/api/satellites': 60000,
};
const DEFAULT_API_TIMEOUT = 20000;

/**
 * Dispatch queue.
 *
 * A browser opens at most six connections per host over HTTP/1.1. Refreshing
 * every layer at once asks for more than that, so the surplus sits queued
 * inside the browser and is never put on the wire — invisible to the server,
 * which is why a pile-up showed up as several layers timing out with nothing
 * at all in the server log.
 *
 * Holding requests here instead of handing them all to the browser keeps two
 * connections free for page assets and interactive lookups, and lets the
 * timeout start when a request is actually sent rather than while it waits
 * its turn. A 180s Overpass query no longer makes a 20s Shodan request
 * "time out" without ever having been attempted.
 */
const MAX_INFLIGHT = 4;
// Bulk layer refreshes may never take the last lane. Priority alone was not
// enough: a queue-jumping request still has to wait for a slot, and with
// every slot held by a 180s Overpass query there was nothing to jump into —
// so aircraft stopped updating and detail lookups came back "flaky".
const BULK_LIMIT = MAX_INFLIGHT - 1;

// Short lookups behind a click.
const INTERACTIVE = new Set([
  '/api/route', '/api/aircraft', '/api/enrich', '/api/geocode',
  '/api/health', '/api/config', '/api/geoip',
]);
// Time-critical polls. These are worthless late: an aircraft position that
// arrives a minute after it was asked for is not a live track.
const LIVE = new Set(['/api/flights', '/api/vessels']);

const isBulk = (path) => !INTERACTIVE.has(path) && !LIVE.has(path);

let inflight = 0;
let bulkInflight = 0;
const waiting = [];            // { bulk, start }

function canStart(bulk) {
  if (inflight >= MAX_INFLIGHT) return false;
  if (bulk && bulkInflight >= BULK_LIMIT) return false;
  return true;
}

function pump() {
  // Walk the whole queue rather than only its head: a bulk request that
  // cannot start must not block a live one sitting behind it.
  for (let i = 0; i < waiting.length;) {
    const w = waiting[i];
    if (canStart(w.bulk)) {
      waiting.splice(i, 1);
      inflight++;
      if (w.bulk) bulkInflight++;
      w.start();
    } else i++;
  }
}

/** Resolves to a release function once there is room to send. */
function acquire(bulk) {
  const done = () => release(bulk);
  if (canStart(bulk)) {
    inflight++;
    if (bulk) bulkInflight++;
    return Promise.resolve(done);
  }
  return new Promise((resolve) => {
    const entry = { bulk, start: () => resolve(done) };
    if (bulk) waiting.push(entry);
    else waiting.unshift(entry);
  });
}

function release(bulk) {
  inflight = Math.max(0, inflight - 1);
  if (bulk) bulkInflight = Math.max(0, bulkInflight - 1);
  pump();
}

/** In-flight and queued counts, for the layer tooltips. */
export function apiQueueDepth() {
  return { inflight, bulkInflight, waiting: waiting.length };
}

/**
 * How far a reported aircraft fix is carried forward, in seconds.
 *
 * Long enough to cover any poll interval the credit budget will produce,
 * short enough that a contact which has genuinely dropped out stops moving
 * instead of gliding on as a ghost.
 */
const DR_MAX_SEC = 45;

/**
 * How long a trail segment stays on screen, in milliseconds.
 *
 * Capped by age rather than point count: at a 7-second poll, 40 points is most
 * of ten minutes of history, and with the aircraft box snapped to a whole
 * degree the globe carries a few hundred contacts. Two minutes of track is
 * enough to read a heading and a turn, and it bounds the line to the distance
 * an aircraft covers in that time rather than to a number of fixes.
 */
const TRAIL_MAX_AGE_MS = 120_000;

/** A hard ceiling on points per contact, whatever the poll rate does. */
const TRAIL_MAX_POINTS = 40;

/** Shared empty positions array, so a contact with no history allocates none. */
const EMPTY_TRAIL = Object.freeze([]);

/**
 * How long to wait after a failure, by consecutive failure count.
 *
 * A layer that failed and then retried on its own normal schedule is the
 * worst of both: it hammers an upstream that is already struggling, and it
 * fills the log with the same error. Backing off turns a dead mirror, an
 * exhausted credit bucket or an IP ban into something the terminal rides out
 * quietly instead of making worse.
 *
 * The last step repeats, so a persistent failure settles at one attempt an
 * hour — often enough to notice a recovery, rare enough to cost nothing.
 */
const RETRY_LADDER_SEC = [30, 60, 90, 120, 300, 3600];

/**
 * How long the browser treats an area as already fetched.
 *
 * Paired with the server's retention policy: INVENTORY_COVERAGE_MS matches
 * TTL.static there, so a layer that cannot have changed is not even asked
 * about again, and CURRENT_COVERAGE_MS matches TTL.hazard for the ones whose
 * answer is a statement about now. Setting only the server side would still
 * leave the browser re-asking on its own clock and getting a cached reply —
 * harmless, but a round trip for nothing.
 */
const INVENTORY_COVERAGE_MS = 72 * 60 * 60_000;
const CURRENT_COVERAGE_MS = 60 * 60_000;

/** Every call to the local proxy goes through here. */
const api = async (path, params, {
  timeoutMs = API_TIMEOUTS[path] ?? DEFAULT_API_TIMEOUT,
  method = 'GET',
} = {}) => {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params || {})) {
    if (v != null && v !== '') url.searchParams.set(k, v);
  }

  const done = await acquire(isBulk(path));

  // The clock starts here, once a slot is free — not when the caller asked.
  // Time spent queued is not the upstream's fault and must not be charged
  // against its budget.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    let res;
    try {
      // The server refuses /api/* without this header. A page on another
      // origin cannot add a custom header without a CORS preflight, which
      // the server never approves, so blind cross-site requests are blocked.
      res = await fetch(url, { method, signal: ac.signal, headers: { 'X-Panopticon': '1' } });
    } catch (e) {
      if (ac.signal.aborted) {
        const err = new Error(`no response after ${Math.round(timeoutMs / 1000)}s`);
        err.timeout = true;
        throw err;
      }
      throw e;
    }
    const json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok) {
      const err = new Error(json.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.retryAfter = json.retryAfter ?? null;
      throw err;
    }
    return json;
  } finally {
    // Only now is the connection actually free: the body has been read, or
    // the request failed. Releasing at the end of fetch() would let the next
    // request start while this one still holds a socket.
    clearTimeout(timer);
    done();
  }
};

// Images in detail panels that fail to load are hidden rather than left as a
// broken-image box. One capturing listener instead of inline onerror
// attributes, which the page's Content-Security-Policy refuses to run.
// (error does not bubble, so this listens in the capture phase.)
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('error', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.hasAttribute('data-hide-on-error')) t.style.display = 'none';
  }, true);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * An upstream URL, or null if its scheme is not http(s).
 *
 * esc() makes a value safe inside an attribute but does nothing about a
 * `javascript:` or `data:` scheme, so every upstream URL that becomes an
 * href or src passes through here as well. The server already filters these;
 * this is the second line. `httpsOnly` is for iframes, which run scripts.
 */
const safeUrl = (u, { httpsOnly = false } = {}) => {
  if (!u) return null;
  try {
    const p = new URL(String(u), location.origin);
    if (p.protocol === 'https:' || (!httpsOnly && p.protocol === 'http:')) return p.href;
  } catch { /* not a URL */ }
  return null;
};

const rows = (pairs) => pairs
  .filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
  .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${Array.isArray(v) ? esc(v.join(', ')) : esc(v)}</td></tr>`)
  .join('');

/* ================================================================== */
/* Base                                                                */
/* ================================================================== */

class Layer {
  constructor(viewer, id, label) {
    this.viewer = viewer;
    this.id = id;
    this.label = label;
    this.enabled = false;
    this.status = 'idle';
    this.count = 0;
    this.error = null;
    // Bumped by every enrich() call. A lookup that lands after the operator
    // has picked something else compares its own number and stays quiet.
    this.enrichSeq = 0;
    // Whether this layer's data is fetched for the current view. Everything
    // that takes a bbox is; orbital assets are not, and must keep working
    // from altitude because that is where you look at them from.
    this.viewportBound = true;
    this.source = new Cesium.CustomDataSource(id);
    viewer.dataSources.add(this.source);
    this.source.show = false;

    // Feature cache. Queries only ever cover the current view, and the view
    // span is capped, so redrawing from the response alone made everything
    // outside the current box vanish the moment you zoomed or panned.
    // Accumulating layers keep what they've seen and redraw from the cache.
    this.accumulate = false;
    this.store = new Map();          // id -> { rec, seen, first }
    this.cacheCap = 4000;
    this.cacheTtlMs = 60 * 60_000;
    this.covered = [];               // regions already fetched
    // How long a fetched area counts as still covered.
    //
    // The default is short, because the layers that keep it are the ones
    // tracking things that move. Layers holding an inventory of fixed things
    // override it to INVENTORY_COVERAGE_MS, matching the server: re-asking
    // for something that cannot have changed is a request for nothing.
    this.coverageTtlMs = 5 * 60_000;
    // How much wider than the view to fetch, so small pans stay inside cover.
    this.padFactor = 0.3;
    this.lastSig = null;
    this.skipped = 0;                // fetches avoided by the cache
    this.failures = 0;               // consecutive failures, indexes the ladder
    this.retryAt = null;             // when the next attempt is due
    this.retryInSec = null;          // the step being served, for the UI
    this.fromCache = false;
    this.lastFetchedBbox = null;
  }

  setEnabled(on) {
    this.enabled = on;
    this.source.show = on;
    if (!on) {
      this.status = 'idle';
      // Nothing should fire for a layer that has been switched off.
      clearTimeout(this._retryTimer);
    } else {
      // Switching a layer back on is a request to try it, not to resume a
      // backoff from an hour ago.
      this.resetBackoff();
    }
  }

  clear() { this.source.entities.removeAll(); }

  /** Fold a freshly fetched page into the cache. */
  remember(records) {
    if (!this.accumulate) { this.lastRecords = records; return records; }
    const now = Date.now();
    for (const r of records) {
      if (r?.id == null) continue;
      const prev = this.store.get(r.id);
      this.store.set(r.id, { rec: r, seen: now, first: prev?.first ?? now });
    }
    this.prune();
    return this.records();
  }

  records() {
    if (!this.accumulate) return this.lastRecords || [];
    return [...this.store.values()].map((v) => v.rec);
  }

  prune() {
    // An accumulating layer must not drop features from an area it still
    // claims to have covered. The two clocks are independent: `covered`
    // suppresses the refetch for coverageTtlMs, while this prune drops
    // features after cacheTtlMs. With the store expiring first, an hour after
    // a fetch every pin would be deleted, `isCovered` would still say the
    // area was done, and the layer would sit at zero with no error and
    // nothing in the server log — the refetch never happens.
    //
    // So the coverage lifetime is a floor: as long as we are telling
    // ourselves the ground is fetched, we keep what we fetched.
    const ttl = this.accumulate
      ? Math.max(this.cacheTtlMs, this.coverageTtlMs)
      : this.cacheTtlMs;
    const cutoff = Date.now() - ttl;
    for (const [id, v] of this.store) if (v.seen < cutoff) this.store.delete(id);
    if (this.store.size > this.cacheCap) {
      // Evict least-recently-seen first, so the area you're working in stays.
      const byAge = [...this.store.entries()].sort((a, b) => a[1].seen - b[1].seen);
      const excess = this.store.size - this.cacheCap;
      for (let i = 0; i < excess; i++) this.store.delete(byAge[i][0]);
    }
  }

  get cached() { return this.accumulate ? this.store.size : this.count; }

  clearCache() {
    this.store.clear();
    this.lastRecords = [];
    this.covered = [];
    this.skipped = 0;
    this.clear();
    this.count = 0;
    // Changing what is being asked for is a new question, so it is owed a
    // fresh attempt rather than the backoff earned by the old one.
    this.resetBackoff();
  }

  /**
   * Re-render from whatever is cached, applying the layer's current filters.
   * Subclasses implement draw(records) and return how many they rendered,
   * which lets a filter toggle repaint instantly with no network round-trip.
   */
  redraw() {
    if (typeof this.draw !== 'function') return;
    this.clear();
    this.count = this.draw(this.records()) || 0;
  }

  /**
   * Fingerprint of everything that changes what the *server* would return.
   * Display-only options must NOT appear here. When it changes the cache is
   * dropped, because records fetched under different criteria would
   * otherwise linger — switching the Shodan preset from ICS to RDP would
   * merge both sets together and mislabel the result.
   */
  settingsSig() { return ''; }

  /** True when this view sits inside a region already fetched recently. */
  isCovered(bbox) {
    const p = String(bbox).split(',').map(Number);
    if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return false;
    const [s, w, n, e] = p;
    const now = Date.now();
    this.covered = (this.covered || []).filter((c) => now - c.at < this.coverageTtlMs);
    return this.covered.some((c) =>
      s >= c.south && n <= c.north && w >= c.west && e <= c.east);
  }

  markCovered(bbox) {
    const p = String(bbox).split(',').map(Number);
    if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return;
    (this.covered ||= []).push({
      south: p[0], west: p[1], north: p[2], east: p[3], at: Date.now(),
    });
    if (this.covered.length > 40) this.covered.shift();
  }

  /** Fetch a little wider than the view so small pans stay inside cover. */
  padBbox(bbox, factor = this.padFactor) {
    const p = String(bbox).split(',').map(Number);
    if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return bbox;
    const [s, w, n, e] = p;
    const dy = (n - s) * factor;
    const dx = (e - w) * factor;
    return [
      Math.max(-85, s - dy), Math.max(-180, w - dx),
      Math.min(85, n + dy), Math.min(180, e + dx),
    ].map((v) => v.toFixed(4)).join(',');
  }

  /**
   * Stand down: the camera is too high for a query to be worth making.
   *
   * Anything already drawn stays drawn — the accumulated cache is still
   * valid ground truth, just not being added to — and coverage is left
   * alone so descending does not refetch what is already held.
   */
  async holdForAltitude() {
    clearTimeout(this._retryTimer);
    if (this.enabled) {
      this.status = 'held';
      this.error = null;
    }
  }

  async refresh(ctx, { isRetry = false, force = false } = {}) {
    if (!this.enabled) return;

    // One refresh at a time, per layer.
    //
    // The camera-settled handler and the poll timer can both fire within a
    // few hundred milliseconds of each other, and a slow layer's previous
    // refresh may still be in flight when the next is due. Joining the one
    // already running means the duplicate never reaches the queue, let alone
    // the network, and two near-identical answers never race.
    if (this._inFlight && !force) return this._inFlight;

    const run = this._doRefresh(ctx, { isRetry, force });
    this._inFlight = run;
    try { return await run; } finally { this._inFlight = null; }
  }

  /**
   * Fetch for this layer, carrying the manual-refresh flag.
   *
   * The server holds most things for days, so a forced refresh has to
   * say so: clearing only the browser's copy would refetch straight back out
   * of the server's. Layer state rather than a parameter, because refresh()
   * already guarantees one load() at a time per layer.
   */
  fetch(path, params) {
    return api(path, this._forced ? { ...params, fresh: 1 } : params);
  }

  async _doRefresh(ctx, { isRetry = false, force = false } = {}) {
    clearTimeout(this._retryTimer);
    this._forced = !!force;
    // SYNC means "try now": the ladder starts again rather than resuming at
    // the hour-long step it had crawled to.
    if (force) this.resetBackoff();
    // Never carry one fetch's coverage claim into the next.
    this.coveredBbox = null;

    // The signature is read before the backoff gate, not after: changing what
    // the layer is asking for is a different question, and clearCache()
    // resets the ladder so the new one is tried straight away. Gating first
    // would leave a filter change doing nothing for up to an hour.
    const sig = this.settingsSig();
    if (this.lastSig !== null && this.lastSig !== undefined && sig !== this.lastSig) {
      this.clearCache();
    }
    this.lastSig = sig;

    // Hold off while a backoff is running. Without this the live poll and the
    // camera-settle refetch kept arriving on their own schedule regardless,
    // so being told "too many requests" was answered with more requests.
    if (this.retryAt && Date.now() < this.retryAt && !force && !isRetry) {
      this.skipped = (this.skipped || 0) + 1;
      ctx.onStatus?.();
      return;
    }

    // Already-covered views repaint from cache instead of hitting the network.
    // This is what keeps panning around from burning Shodan query credits.
    if (this.accumulate && !force && !isRetry && ctx.bbox && this.isCovered(ctx.bbox)) {
      this.skipped = (this.skipped || 0) + 1;
      this.fromCache = true;
      this.redraw();
      this.status = 'ok';
      ctx.onStatus?.();
      return;
    }

    this.status = 'loading';
    this.error = null;
    ctx.onStatus?.();
    try {
      await this.load(ctx);
      this.fromCache = false;
      // Prefer the box the server says it covered: it snaps the request
      // outward to a whole cell, so the answer covers more ground than was
      // asked for. Recording the request instead threw that away and made
      // the next small pan refetch ground already in hand.
      if (this.accumulate && ctx.bbox) {
        this.markCovered(this.coveredBbox || this.lastFetchedBbox || ctx.bbox);
      }
      this.status = 'ok';
      this.lastFetchAt = Date.now();   // for "how old is this?" readouts
      this.retryAt = null;
      this.retryInSec = null;
      this.failures = 0;
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.scheduleRetry(e, ctx);
    }
    ctx.onStatus?.();
  }

  /**
   * Step the backoff and book the next attempt.
   *
   * Every failure, not only a rate limit: a mirror that is down, an upstream
   * that has banned the address, a malformed response, a timeout. They all
   * want the same treatment, which is to stop asking so often.
   *
   * Where the upstream has said how long to wait, that wins if it is longer
   * than the ladder step — being told 137 seconds and coming back in 30 is
   * not a retry, it is ignoring the answer.
   */
  scheduleRetry(err, ctx) {
    clearTimeout(this._retryTimer);
    const step = RETRY_LADDER_SEC[Math.min(this.failures, RETRY_LADDER_SEC.length - 1)];
    this.failures += 1;
    const wait = Math.max(step, Number(err?.retryAfter) || 0);
    this.retryInSec = wait;
    this.retryAt = Date.now() + wait * 1000;

    this._retryTimer = setTimeout(() => {
      if (!this.enabled) return;
      // Ask the app to refetch rather than replaying the captured context.
      // An hour into a backoff the camera is somewhere else, and the stale
      // bbox would fetch ground nobody is looking at — and skip the altitude
      // gate, which only the caller knows about.
      if (ctx.retry) ctx.retry();
      else this.refresh(ctx, { isRetry: true });
    }, wait * 1000 + 500);
  }

  /** A deliberate act starts the ladder over. */
  resetBackoff() {
    clearTimeout(this._retryTimer);
    this.failures = 0;
    this.retryAt = null;
    this.retryInSec = null;
  }
}

/* ================================================================== */
/* SHODAN — internet-exposed hosts                                     */
/* ================================================================== */

export class ShodanLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'shodan', 'Shodan exposure');
    // Every miss spends a query credit. Held for 72 hours (TTL.static), refreshed on demand.
    this.coverageTtlMs = INVENTORY_COVERAGE_MS;
    this.padFactor = 0.6;
    this.accumulate = true;
    // No type filter and no query box: the layer always asks for everything
    // Shodan has indexed in view, and reading it is done by colour instead.
    this.preset = 'all';
    this.lastQuery = null;
    this.total = 0;
    this.colorBy = 'category';   // 'risk' | 'category' — category by default,
                                 // since everything is on screen at once
    this.byCategory = {};
    this.vulnerable = 0;
  }

  settingsSig() { return 'all'; }

  async load({ bbox }) {
    const box = this.padBbox(bbox);
    this.lastFetchedBbox = box;
    // Replaced below with the cell the server actually charged for, which is
    // wider than this and covers every zoom level inside it.
    const data = await this.fetch('/api/shodan', { bbox: box, preset: 'all' });
    if (data.queried) {
      const q = data.queried;
      this.lastFetchedBbox = [q.south, q.west, q.north, q.east].join(',');
      this.cellDeg = data.cellDeg || null;
    }
    this.lastQuery = data.query;
    this.total = data.total;
    this.byCategory = data.byCategory || {};
    this.vulnerable = data.vulnerable || 0;
    // Shodan records have no natural id across services on one host, so key
    // by ip:port, which is exactly one banner.
    for (const m of data.matches) m.id = `${m.ip}:${m.port}`;
    this.remember(data.matches);
    this.redraw();
  }

  draw(matches) {
    // Shodan returns per-service banners; several can share one IP and
    // one coordinate, so jitter co-located points to keep them pickable.
    const seen = new Map();

    for (const m of matches) {
      const key = `${m.lat.toFixed(4)},${m.lon.toFixed(4)}`;
      const n = seen.get(key) || 0;
      seen.set(key, n + 1);
      const spiral = n === 0 ? [0, 0] : [
        Math.cos(n * 2.4) * 0.0016 * Math.sqrt(n),
        Math.sin(n * 2.4) * 0.0016 * Math.sqrt(n),
      ];

      const risky = m.vulns.length > 0;
      // Risk colouring answers "what's dangerous here"; category colouring
      // answers "what *is* all this", which is the useful question once the
      // type filter is off and everything in view is on the globe at once.
      const css = this.colorBy === 'category'
        ? (SERVICE_COLORS[m.category] || SERVICE_COLORS.other)
        : (risky ? '#ff2d55' : '#00e5ff');
      const color = Cesium.Color.fromCssColorString(css);

      this.source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(m.lon + spiral[0], m.lat + spiral[1], 0),
        point: {
          pixelSize: risky ? 11 : 7,
          color: color.withAlpha(0.85),
          outlineColor: color,
          outlineWidth: risky ? 2 : 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(1e3, 1.6, 6e5, 0.5),
        },
        properties: { layer: 'shodan', record: m },
      });
    }

    return matches.length;
  }

  categoryLegend() {
    return Object.entries(this.byCategory)
      .sort((a, b) => b[1] - a[1])
      .map(([cat, n]) => ({ cat, n, color: SERVICE_COLORS[cat] || SERVICE_COLORS.other }));
  }

  detail(rec) {
    const vulnList = rec.vulns.length
      ? `<div class="vulns">${rec.vulns.slice(0, 24)
          .map((v) => `<a href="https://nvd.nist.gov/vuln/detail/${encodeURIComponent(v)}"
                          target="_blank" rel="noopener">${esc(v)}</a>`).join('')}</div>`
      : '';

    return {
      kind: 'SHODAN HOST',
      title: `${rec.ip}:${rec.port}`,
      accent: rec.vulns.length ? '#ff2d55' : '#00e5ff',
      html: `
        <table>${rows([
          ['Service', [rec.product, rec.version].filter(Boolean).join(' ') || '—'],
          ['Category', rec.category],
          ['Transport', `${rec.transport}/${rec.port}`],
          ['Organisation', rec.org],
          ['ASN', rec.asn],
          ['OS', rec.os],
          ['Location', [rec.city, rec.country].filter(Boolean).join(', ')],
          ['Hostnames', rec.hostnames],
          ['Tags', rec.tags],
          ['Last seen', rec.timestamp?.replace('T', ' ').slice(0, 19)],
        ])}</table>
        ${rec.vulns.length ? `<h4>${rec.vulns.length} known CVE${rec.vulns.length > 1 ? 's' : ''}</h4>${vulnList}` : ''}
        ${rec.banner ? `<h4>Banner</h4><pre>${esc(rec.banner)}</pre>` : ''}
        <div data-slot="enrich"><p class="hint pending">Checking reputation…</p></div>
        <a class="ext" href="https://www.shodan.io/host/${encodeURIComponent(rec.ip)}"
           target="_blank" rel="noopener">Open in Shodan ↗</a>`,
    };
  }

  /** Cross-reference the host against GreyNoise and abuse.ch. */
  async enrich(rec, root) {
    // Re-query rather than reuse a captured node: see FlightLayer.enrich.
    const seq = ++this.enrichSeq;
    await enrichHost(rec.ip, () =>
      (this.enrichSeq === seq ? root.querySelector('[data-slot="enrich"]') : null));
  }
}

const SERVICE_COLORS = {
  web: '#4cc9f0', remote: '#ff9f1c', database: '#c77dff', ics: '#ff2d55',
  camera: '#00d9a3', mail: '#f9c74f', file: '#90be6d', network: '#f72585',
  infra: '#8ac6ff', other: '#8b949e',
};

/* ================================================================== */
/* FLIGHTS — live ADS-B via OpenSky                                    */
/* ================================================================== */

export class FlightLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'flights', 'Live aircraft');
    this.showLabels = true;
    this.showTrails = true;
    this.trails = new Map();   // icao24 -> { pos: Cartesian3[], at: number[] }
    // Dead-reckoning anchors: icao24 -> the last reported fix plus the motion
    // to carry it forward with. See deadReckon().
    this.dr = new Map();
    // Reused per-contact buffers for the drawn trail. See trailWithHead().
    this._trailBuf = new Map();
    this.authenticated = false;
    // How often the feed itself updates; the poll interval follows this
    // rather than a hard-coded number, so they cannot drift apart.
    this.resolutionSec = 10;
    this.dropped = 0;
    // Route geometry lives in its own source so clearing a selected flight's
    // route never disturbs the live aircraft entities.
    this.routeSource = new Cesium.CustomDataSource('flight-routes');
    viewer.dataSources.add(this.routeSource);
  }

  setEnabled(on) {
    super.setEnabled(on);
    this.routeSource.show = on;
    if (!on) this.clearRoute();
  }

  clearRoute() { this.routeSource.entities.removeAll(); }

  clearCache() {
    super.clearCache();
    // Anchors and tails are per-contact state. Left behind on a flush they
    // would keep extrapolating aircraft that are no longer drawn.
    this.dr.clear();
    this.trails.clear();
    this._trailBuf.clear();
  }

  /**
   * The reported track, with the aircraft's current position on the end.
   *
   * The trail is a history of real fixes and stays that way — those are
   * ground truth and are not extrapolated. But the aircraft is drawn at its
   * dead-reckoned position, which is ahead of the last fix by however stale
   * that fix was plus however long ago it arrived. Ending the line at the
   * last fix therefore left the tail floating behind the aircraft, detached
   * by anything up to a few kilometres — which is what "the trails don't
   * work" looked like. Where it has been includes where it is.
   *
   * The scratch array is reused: this runs for every aircraft on every frame,
   * and at a few hundred contacts a fresh array each time is a lot of garbage
   * for no gain.
   */
  trailWithHead(id) {
    const t = this.trails.get(id);
    if (!t || !t.pos.length) return EMPTY_TRAIL;

    // Trimmed here rather than at poll time: this runs every frame, so a
    // segment disappears when it is actually two minutes old instead of at
    // the next fetch, which could be seven seconds later or — with the feed
    // paused — never. The loop almost always does nothing.
    const cutoff = Date.now() - TRAIL_MAX_AGE_MS;
    let drop = 0;
    while (drop < t.at.length && t.at[drop] < cutoff) drop++;
    if (drop) { t.pos.splice(0, drop); t.at.splice(0, drop); }
    if (!t.pos.length) return EMPTY_TRAIL;

    const head = this.deadReckon(id);
    const last = t.pos[t.pos.length - 1];
    // A contact that is not moving sits on its last fix; a zero-length final
    // segment there is just noise for the tessellator.
    if (last && Cesium.Cartesian3.distance(last, head) < 1) return t.pos;

    let buf = this._trailBuf.get(id);
    if (!buf || buf.length !== t.pos.length + 1) {
      buf = new Array(t.pos.length + 1);
      this._trailBuf.set(id, buf);
    }
    for (let i = 0; i < t.pos.length; i++) buf[i] = t.pos[i];
    buf[t.pos.length] = head;
    return buf;
  }

  /**
   * Where an aircraft is *now*, carried forward from its last reported fix.
   *
   * Reported: "planes are not moving at all". They were — the layer was
   * healthy, the feed live, 33 of 40 contacts changed position between
   * samples. They moved in eight-second hops, because that is how often the
   * poll ran, and an icon that sits still and then teleports does not read as
   * movement. Tying the picture to the poll interval was the mistake: it also
   * meant every saving on API spend had to be paid for in apparent frames.
   *
   * So position is a function of time instead. The report is the anchor and
   * the aircraft's own velocity and heading carry it between polls, which the
   * next poll then corrects. Motion is continuous at frame rate however
   * slowly the feed is being asked.
   *
   * What it will not do is invent. A contact on the ground, one with no
   * velocity, or one already stale when it arrived is left exactly where it
   * was reported, and extrapolation stops after DR_MAX_SEC rather than flying
   * a lost contact off across the map.
   */
  deadReckon(id) {
    const a = this.dr.get(id);
    if (!a) return Cesium.Cartesian3.fromDegrees(0, 0, 0);
    if (!a.move) return a.fix;

    // Two different clocks, and folding them together froze contacts.
    //
    // `ageSec` is how stale the fix already was when it arrived, and it is a
    // real offset: a 30-second-old report genuinely is 30 seconds behind, so
    // it is added. DR_MAX_SEC bounds something else — how long we keep
    // extrapolating *after the last report*, so a contact that has dropped
    // out comes to a halt. Capping the sum meant a fix that arrived 45s stale
    // was pinned at the ceiling from its very first frame and never moved
    // again, which was 23 of 325 aircraft on the running install.
    const since = Math.min(DR_MAX_SEC, (Date.now() - a.atMs) / 1000);
    const dt = since + a.ageSec;
    if (dt <= 0) return a.fix;

    const [lat, lon] = offsetLatLon(a.lat, a.lon, a.heading, a.velocity * dt);
    const alt = Math.max(0, a.alt + (a.verticalRate || 0) * dt);
    return Cesium.Cartesian3.fromDegrees(lon, lat, alt);
  }

  async load({ bbox }) {
    const data = await this.fetch('/api/flights', { bbox });
    // The server works out how often to ask from what is left of the daily
    // credit bucket; the poll timer follows it rather than a constant.
    this.pollSec = data.pollSec || (data.resolutionSec || 10) + 1;
    this.credits = data.credits ?? null;
    this.creditFloor = data.creditFloor ?? null;
    this.coveredBbox = data.covered || null;
    this.authenticated = data.authenticated;

    const live = new Set();

    for (const a of data.aircraft) {
      live.add(a.icao24);
      const alt = a.onGround ? 0 : (a.altitude || 0);
      const pos = Cesium.Cartesian3.fromDegrees(a.lon, a.lat, alt);

      // Re-anchor the dead reckoning on every report, so the extrapolation is
      // corrected by each poll rather than compounded. `move` is the
      // judgement about whether this contact may be carried forward at all.
      this.dr.set(a.icao24, {
        fix: pos,
        lat: a.lat, lon: a.lon, alt,
        heading: a.heading || 0,
        velocity: a.velocity || 0,
        verticalRate: a.onGround ? 0 : (a.verticalRate || 0),
        ageSec: a.ageSec || 0,
        atMs: Date.now(),
        move: !a.onGround && (a.velocity || 0) > 1 && (a.ageSec ?? 0) < 60,
      });

      // Keep a short position history so aircraft draw a tail. Each fix is
      // stamped, because the trail is trimmed by age rather than by count.
      if (this.showTrails) {
        let t = this.trails.get(a.icao24);
        if (!t) { t = { pos: [], at: [] }; this.trails.set(a.icao24, t); }
        const last = t.pos[t.pos.length - 1];
        if (!last || Cesium.Cartesian3.distance(last, pos) > 30) {
          t.pos.push(pos);
          t.at.push(Date.now());
        }
        // The count ceiling is only a backstop now; age is what governs.
        while (t.pos.length > TRAIL_MAX_POINTS) { t.pos.shift(); t.at.shift(); }
      }

      const emergency = !!a.alert;
      const climbing = (a.verticalRate || 0) > 1.5;
      const descending = (a.verticalRate || 0) < -1.5;
      const tint = emergency ? '#ff2d55'
        : a.onGround ? '#8b949e'
        : climbing ? '#7ee787'
        : descending ? '#ffa657'
        : '#58d3ff';

      let ent = this.source.entities.getById(a.icao24);
      if (!ent) {
        ent = this.source.entities.add({
          id: a.icao24,
          // Not the fix itself: a callback, re-read every frame, so the
          // aircraft glides between polls instead of teleporting on each one.
          //
          // CallbackPositionProperty, not CallbackProperty. `entity.position`
          // has to be a PositionProperty — the renderer asks it for
          // getValueInReferenceFrame, which a plain CallbackProperty does not
          // implement. Assigning one leaves the entity drawn at whatever it
          // first picked up and never updated again, while getValue() keeps
          // returning correct, moving coordinates to anyone who asks from JS.
          // That is exactly how this was missed: the property was verified,
          // the renderer was not.
          position: positionCallback(() => this.deadReckon(a.icao24)),
          billboard: {
            image: planeSprite(tint),
            width: 26,
            height: 26,
            rotation: 0,
            alignedAxis: Cesium.Cartesian3.ZERO,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(1e4, 1.3, 1.2e6, 0.45),
          },
          label: {
            text: '',
            font: '600 11px "JetBrains Mono", ui-monospace, monospace',
            fillColor: Cesium.Color.fromCssColorString(tint),
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
            outlineWidth: 3,
            pixelOffset: new Cesium.Cartesian2(16, -14),
            horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 9e5),
          },
          polyline: {
            positions: new Cesium.CallbackProperty(
              () => this.trailWithHead(a.icao24), false),
            width: 1.5,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.22,
              color: Cesium.Color.fromCssColorString(tint).withAlpha(0.55),
            }),
            arcType: Cesium.ArcType.NONE,
          },
        });
      }
      // Nothing to reassign on an existing entity — the callback already
      // reads the anchor that was just updated above.

      ent.billboard.image = planeSprite(tint);
      ent.billboard.rotation = Cesium.Math.toRadians(-(a.heading || 0));
      ent.billboard.alignedAxis = Cesium.Cartesian3.ZERO;
      ent.polyline.show = this.showTrails;

      const ftLabel = a.altitude ? `${Math.round(a.altitude * 3.28084 / 100) * 100}ft` : 'GND';
      const ktLabel = a.velocity ? `${Math.round(a.velocity * 1.94384)}kt` : '';
      ent.label.show = this.showLabels;
      ent.label.text = `${a.callsign || a.icao24.toUpperCase()}\n${ftLabel} ${ktLabel}`
        + (emergency ? `\n⚠ ${a.alert}` : '');
      ent.label.fillColor = Cesium.Color.fromCssColorString(tint);
      ent.properties = new Cesium.PropertyBag({ layer: 'flights', record: a });
    }

    // Retire contacts that dropped out of the box.
    for (const ent of [...this.source.entities.values]) {
      if (!live.has(ent.id)) {
        this.source.entities.remove(ent);
        this.trails.delete(ent.id);
        this.dr.delete(ent.id);
        this._trailBuf.delete(ent.id);
      }
    }

    this.count = data.aircraft.length;
    this.resolutionSec = data.resolutionSec || this.resolutionSec;
    this.dropped = data.dropped || 0;
  }

  detail(rec) {
    const fpm = rec.verticalRate ? Math.round(rec.verticalRate * 196.85) : 0;
    return {
      kind: 'AIR CONTACT',
      title: rec.callsign || rec.icao24.toUpperCase(),
      accent: rec.alert ? '#ff2d55' : '#58d3ff',
      html: `
        ${rec.alert ? `<div class="alarm">SQUAWK ${rec.squawk} — ${esc(rec.alert)}</div>` : ''}
        <div data-slot="routehead"></div>
        <div data-slot="photo"></div>
        <div data-slot="inset"></div>
        <table>${rows([
          ['ICAO24', rec.icao24.toUpperCase()],
          ['Registered', rec.country],
          ['Category', rec.category],
          ['Position', `${rec.lat.toFixed(4)}, ${rec.lon.toFixed(4)}`],
          ['Altitude', rec.onGround ? 'on ground'
            : `${Math.round((rec.altitude || 0) * 3.28084).toLocaleString()} ft`],
          ['Ground speed', rec.velocity ? `${Math.round(rec.velocity * 1.94384)} kt` : null],
          ['Track', rec.heading != null ? `${Math.round(rec.heading)}°` : null],
          ['Vertical rate', fpm ? `${fpm > 0 ? '+' : ''}${fpm.toLocaleString()} fpm` : 'level'],
          ['Squawk', rec.squawk],
          ['Special ident', rec.spi ? 'yes' : null],
          // Worth showing: a contact can be in the feed but not recently
          // heard from, and then its position is a memory, not a fix.
          ['Position age', rec.ageSec == null ? 'unknown'
            : rec.ageSec < 10 ? 'live' : `${rec.ageSec}s ago`],
        ])}</table>
        <div data-slot="route"><p class="hint pending">Looking up route and airframe…</p></div>
        <a class="ext" href="https://globe.adsbexchange.com/?icao=${encodeURIComponent(rec.icao24)}"
           target="_blank" rel="noopener">Track on ADS-B Exchange ↗</a>`,
    };
  }

  /**
   * Called after the detail panel renders. Resolves the callsign to its
   * scheduled origin/destination and the hex to an airframe, fills the
   * placeholder, and draws the route on the globe.
   */
  async enrich(rec, root) {
    // The panel is re-rendered on every pick, so the placeholder captured now
    // may be a detached node by the time the round-trip lands — writing to it
    // would silently do nothing and leave "Looking up…" on screen forever.
    // Re-query the live slot after the await instead, and only write if this
    // call is still the most recent one.
    const seq = ++this.enrichSeq;
    const liveSlot = () => (this.enrichSeq === seq ? root.querySelector('[data-slot="route"]') : null);
    const photoSlot = () => (this.enrichSeq === seq ? root.querySelector('[data-slot="photo"]') : null);
    const headSlot = () => (this.enrichSeq === seq ? root.querySelector('[data-slot="routehead"]') : null);

    this.clearRoute();

    let routeRes, acRes;
    try {
      [routeRes, acRes] = await Promise.allSettled([
        // The schedule is looked up live on every pick.
        //
        // It is the one thing in this panel that changes between legs: a
        // callsign is a service on a given day, and a stored answer for one
        // has already shown yesterday's route for today's aircraft. A pick is
        // a deliberate act on a single flight, so it is worth the round trip
        // to be certain — and adsbdb is free and unmetered.
        //
        // The fetch still writes through the server's cache, so a pick also
        // corrects whatever stale answer was stored for that callsign.
        //
        // The airframe is keyed by the aircraft's own hex and does not change,
        // so it is served from cache as normal.
        rec.callsign
          ? api('/api/route', { callsign: rec.callsign, fresh: 1 })
          : Promise.resolve(null),
        api('/api/aircraft', { icao24: rec.icao24 }),
      ]);
    } catch (e) {
      const s = liveSlot();
      if (s) s.innerHTML = `<p class="hint">Lookup failed: ${esc(e.message)}</p>`;
      return;
    }

    const route = routeRes.status === 'fulfilled' ? routeRes.value : null;
    const ac = acRes.status === 'fulfilled' ? acRes.value : null;
    const slot = liveSlot();
    if (!slot) return;

    const parts = [];

    if (ac?.known) {
      parts.push(`<h4>Airframe</h4><table>${rows([
        ['Registration', ac.registration],
        ['Type', ac.type],
        ['ICAO type', ac.icaoType],
        ['Manufacturer', ac.manufacturer],
        ['Operator', ac.owner],
        ['Registered in', ac.ownerCountry],
      ])}</table>`);
      // The photo leads the panel rather than sitting under the airframe
      // table, so it is the first thing seen on a pick.
      const ps = photoSlot();
      if (ac.photo && ps) {
        ps.innerHTML = `<img class="cam" src="${esc(safeUrl(ac.photo) || '')}" alt="aircraft" data-hide-on-error>`;
      }
    }

    if (route?.known && route.origin && route.destination) {
      const o = route.origin;
      const d = route.destination;
      // Origin → destination leads the panel, above the photo and map: it is
      // the first question asked of any airliner. The full detail stays below.
      const head = headSlot();
      if (head) {
        head.innerHTML = `
        <div class="route">
          <div class="ap"><b>${esc(o.iata || o.icao || '???')}</b>
            <span>${esc(o.city || o.name || '')}</span></div>
          <div class="arrow">→</div>
          <div class="ap"><b>${esc(d.iata || d.icao || '???')}</b>
            <span>${esc(d.city || d.name || '')}</span></div>
        </div>`;
      }
      parts.push(`<h4>Route</h4>
        <table>${rows([
          ['Airline', route.airline?.name],
          ['Radio callsign', route.airline?.radioCallsign],
          ['IATA flight', route.callsignIata],
          ['Departs', [o.name, o.country].filter(Boolean).join(', ')],
          ['Arrives', [d.name, d.country].filter(Boolean).join(', ')],
          ['Great-circle', `${greatCircleKm(o.lat, o.lon, d.lat, d.lon).toFixed(0)} km`],
        ])}</table>`);

      const warn = routeMismatch(rec, route);
      if (warn) parts.push(`<div class="verdict warn">${esc(warn)}</div>`);

      this.drawRoute(route);
    } else if (route && !route.known) {
      parts.push('<p class="hint">No published schedule for this callsign — '
        + 'common for general aviation, military and charter traffic.</p>');
    }

    if (!parts.length) {
      // Say *why* there is nothing: an upstream that timed out reads very
      // differently to an aircraft that genuinely has no published record.
      const failed = [
        routeRes.status === 'rejected' ? `route (${routeRes.reason?.message || 'failed'})` : null,
        acRes.status === 'rejected' ? `airframe (${acRes.reason?.message || 'failed'})` : null,
      ].filter(Boolean);
      parts.push(failed.length
        ? `<p class="hint">Lookup unavailable — ${esc(failed.join('; '))}.</p>`
        : '<p class="hint">No route or airframe record found.</p>');
    }
    slot.innerHTML = parts.join('');
  }

  /**
   * Mark where a selected flight came from and where it is going.
   *
   * Endpoints only — no line between them.
   *
   * On anything longer than a short hop, route lines would cross half the
   * globe, and a flight's own track could not be told apart from where it is
   * merely supposed to be going. Marking the two airports says the same thing without drawing
   * over everything else, and the panel gives the great-circle distance as a
   * number.
   */
  drawRoute(route) {
    const { origin: o, destination: d } = route;

    for (const [ap, label, color] of [[o, 'DEP', '#7ee787'], [d, 'ARR', '#ff9f1c']]) {
      this.routeSource.entities.add({
        position: Cesium.Cartesian3.fromDegrees(ap.lon, ap.lat, 0),
        point: {
          pixelSize: 11,
          color: Cesium.Color.fromCssColorString(color).withAlpha(0.9),
          outlineColor: Cesium.Color.fromCssColorString(color),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        },
        label: {
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          text: `${label} ${ap.iata || ap.icao || ''}\n${ap.city || ''}`,
          font: '600 12px "JetBrains Mono", ui-monospace, monospace',
          fillColor: Cesium.Color.fromCssColorString(color),
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: 3,
          pixelOffset: new Cesium.Cartesian2(0, -22),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }
  }
}

/**
 * Does this schedule plausibly belong to the aircraft in front of us?
 *
 * A callsign is reused across days and legs, so a lookup can hand back a real
 * route that is simply not the flight being watched — and it looks completely
 * authoritative on screen. The aircraft's own position is the check: a
 * contact descending over New York does not belong to a route ending in San
 * Jose, and sitting on top of the route's *origin* while low is the signature
 * of yesterday's leg, or the return one.
 *
 * Returns a sentence to show, or null when nothing looks wrong. Deliberately
 * conservative: this warns, it does not hide the data.
 */
function routeMismatch(rec, route) {
  const o = route?.origin;
  const d = route?.destination;
  if (!o || !d || !Number.isFinite(rec?.lat) || !Number.isFinite(rec?.lon)) return null;
  if (!Number.isFinite(o.lat) || !Number.isFinite(d.lat)) return null;

  const toOrigin = greatCircleKm(rec.lat, rec.lon, o.lat, o.lon);
  const toDest = greatCircleKm(rec.lat, rec.lon, d.lat, d.lon);
  const leg = greatCircleKm(o.lat, o.lon, d.lat, d.lon);

  // Only meaningful for a real city pair; circuits and short hops say little.
  if (leg < 150) return null;

  const lowAndSlow = !rec.onGround && (rec.altitude ?? 0) < 3000;
  if (!lowAndSlow && !rec.onGround) return null;

  if (toOrigin < 50 && toDest > 300) {
    return `This aircraft is on the ground or in approach at ${o.iata || o.icao || 'the origin'}, `
      + `not ${d.iata || d.icao || 'the destination'}. Callsigns are reused between legs and `
      + 'days, so this is most likely a different leg\u2019s schedule rather than this flight\u2019s.';
  }
  if (toDest > 300 && toOrigin > 300) {
    return `This aircraft is low but ${Math.round(toDest)} km from ${d.iata || d.icao || 'the destination'} `
      + `and ${Math.round(toOrigin)} km from ${o.iata || o.icao || 'the origin'}, so this schedule `
      + 'probably belongs to a different flight with the same callsign.';
  }
  return null;
}

function greatCircleKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1);
  const dLon = r(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

let spriteCache = new Map();
function planeSprite(color) {
  if (spriteCache.has(color)) return spriteCache.get(color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <path d="M16 2 L19 13 L30 18 L30 21 L19 18.5 L18.2 26 L22 29 L22 30.5 L16 29 L10 30.5
             L10 29 L13.8 26 L13 18.5 L2 21 L2 18 L13 13 Z"
          fill="${color}" stroke="rgba(0,0,0,.65)" stroke-width="1"/></svg>`;
  const uri = `data:image/svg+xml;base64,${btoa(svg)}`;
  spriteCache.set(color, uri);
  return uri;
}

/* ================================================================== */
/* SATELLITES — SGP4 propagation from CelesTrak elements               */
/* ================================================================== */

export class SatelliteLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'satellites', 'Orbital assets');
    this.group = 'stations';
    this.limit = 250;
    this.records = [];
    this.satrecs = [];
    this.points = null;
    this.orbit = null;
    this.selectedIdx = -1;
    this.showFootprint = true;
    // Orbits are propagated from elements, not queried for the view, so the
    // altitude gate does not apply — and this is the layer you actually want
    // when you are looking down from 400km.
    this.viewportBound = false;
    this.stale = false;
    this.elementsAt = null;
  }

  async load() {
    if (typeof satellite === 'undefined') {
      throw new Error('satellite.js not loaded — check the server console');
    }
    const data = await this.fetch('/api/satellites', { group: this.group, limit: this.limit });

    this.clear();
    if (this.points) { this.viewer.scene.primitives.remove(this.points); this.points = null; }
    this.records = [];
    this.satrecs = [];

    for (const s of data.satellites) {
      let rec;
      try { rec = satellite.twoline2satrec(s.tle1, s.tle2); } catch { continue; }
      if (!rec || rec.error) continue;
      this.satrecs.push(rec);
      this.records.push(s);
    }

    // A PointPrimitiveCollection keeps a few thousand objects at 60fps in a
    // way that individual entities would not.
    this.points = this.viewer.scene.primitives.add(new Cesium.PointPrimitiveCollection());
    for (const s of this.records) {
      this.points.add({
        position: Cesium.Cartesian3.ZERO,
        pixelSize: 5,
        color: orbitColor(s),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.5),
        outlineWidth: 1,
        id: { layer: 'satellites', record: s },
      });
    }
    this.points.show = this.enabled;
    this.count = this.records.length;
    this.groupLabel = data.label;
    // CelesTrak declines to re-send a group it has not regenerated, so these
    // elements may have come off the local copy. They are still the current
    // ones — the refusal is how CelesTrak says so — but worth showing.
    this.stale = !!data.stale;
    this.elementsAt = data.elementsAt || null;
    this.tick(Cesium.JulianDate.now());
  }

  setEnabled(on) {
    super.setEnabled(on);
    if (this.points) this.points.show = on;
    if (!on && this.orbit) { this.source.entities.remove(this.orbit); this.orbit = null; }
  }

  /** Propagate every element set to `time` and move its point. */
  tick(julian) {
    if (!this.points || !this.enabled || !this.satrecs.length) return;
    const date = Cesium.JulianDate.toDate(julian);
    const gmst = satellite.gstime(date);

    for (let i = 0; i < this.satrecs.length; i++) {
      const pv = satellite.propagate(this.satrecs[i], date);
      const p = this.points.get(i);
      if (!pv || !pv.position) { p.show = false; continue; }
      const geo = satellite.eciToGeodetic(pv.position, gmst);
      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      const h = geo.height * 1000;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(h)) {
        p.show = false; continue;
      }
      p.show = true;
      p.position = Cesium.Cartesian3.fromDegrees(lon, lat, h);
      this.records[i].live = { lat, lon, altKm: geo.height };
    }
  }

  /** Draw one full revolution as a ground-relative polyline. */
  showOrbit(record) {
    const idx = this.records.indexOf(record);
    if (idx < 0) return;
    if (this.orbit) this.source.entities.remove(this.orbit);

    const rec = this.satrecs[idx];
    const periodMin = (2 * Math.PI) / rec.no;   // minutes per revolution
    const now = Cesium.JulianDate.toDate(this.viewer.clock.currentTime);
    const pts = [];
    const steps = 240;

    for (let i = 0; i <= steps; i++) {
      const t = new Date(now.getTime() + (i / steps) * periodMin * 60_000);
      const pv = satellite.propagate(rec, t);
      if (!pv?.position) continue;
      const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, geo.height * 1000));
    }

    this.orbit = this.source.entities.add({
      polyline: {
        positions: pts,
        width: 2,
        arcType: Cesium.ArcType.NONE,
        material: new Cesium.PolylineGlowMaterialProperty({
          glowPower: 0.25,
          color: Cesium.Color.fromCssColorString('#ffd166').withAlpha(0.75),
        }),
      },
    });
    return periodMin;
  }

  detail(rec) {
    const live = rec.live || {};
    const periodMin = rec.meanMotion ? 1440 / rec.meanMotion : null;
    const period = this.showOrbit(rec) ?? periodMin;
    // Circular-orbit ground velocity from altitude.
    const r = 6371 + (live.altKm || 0);
    const v = Math.sqrt(398600.4418 / r);

    return {
      kind: 'ORBITAL ASSET',
      title: rec.name,
      accent: '#ffd166',
      html: `
        <table>${rows([
          ['NORAD ID', rec.norad],
          ['Int’l designator', rec.intlDes],
          ['Sub-point', live.lat != null
            ? `${live.lat.toFixed(3)}, ${live.lon.toFixed(3)}` : null],
          ['Altitude', live.altKm != null ? `${live.altKm.toFixed(1)} km` : null],
          ['Orbital velocity', `${v.toFixed(2)} km/s`],
          ['Period', period ? `${period.toFixed(1)} min` : null],
          ['Inclination', `${rec.inclination.toFixed(2)}°`],
          ['Eccentricity', rec.eccentricity.toFixed(6)],
          ['RAAN', `${rec.raan.toFixed(2)}°`],
          ['Revolutions', rec.revNum?.toLocaleString()],
          ['Classification', rec.classification === 'U' ? 'Unclassified' : rec.classification],
        ])}</table>
        <p class="hint">Ground track for one revolution is drawn on the globe.</p>
        <a class="ext" href="https://celestrak.org/satcat/table-satcat.php?CATNR=${rec.norad}"
           target="_blank" rel="noopener">CelesTrak SATCAT ↗</a>`,
    };
  }
}

function orbitColor(s) {
  const n = s.meanMotion || 15;
  if (n > 14.5) return Cesium.Color.fromCssColorString('#ffd166');  // LEO
  if (n > 2.5) return Cesium.Color.fromCssColorString('#4cc9f0');   // MEO
  return Cesium.Color.fromCssColorString('#c77dff');                // GEO / HEO
}

/* ================================================================== */
/* OVERPASS — OSM infrastructure                                       */
/* ================================================================== */

export class OverpassLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'overpass', 'OSM infrastructure');
    // Mapped infrastructure changes over weeks. Held for 72 hours, refreshed on demand.
    this.coverageTtlMs = INVENTORY_COVERAGE_MS;
    // Modest, unlike Shodan's: the server snaps this outward onto a fixed
    // grid anyway, so the slack that keeps small pans inside coverage comes
    // from the cell rather than from padding. At 0.6 the padded box was 2.2x
    // the view in each axis — nearly five times the area — and for an
    // Overpass query that is paid for in seconds, not credits.
    this.padFactor = 0.15;
    this.accumulate = true;
    this.presets = new Set(['surveillance']);
    this.available = {};
    this.byPreset = {};
    this.labels = {};
    this.truncated = false;
  }

  settingsSig() { return [...this.presets].sort().join(','); }

  async load({ bbox }) {
    if (!this.presets.size) { this.clear(); this.count = 0; this.byPreset = {}; return; }

    // One request covering every selected class. Overpass allows ~2 slots per
    // IP, so fanning out one request per class is what caused 429s.
    const box = this.padBbox(bbox);
    this.lastFetchedBbox = box;
    const d = await this.fetch('/api/overpass', {
      bbox: box, presets: [...this.presets].join(','), limit: 800,
    });

    this.truncated = !!d.truncated;
    this.coveredBbox = d.covered || null;
    this.trimmed = !!d.trimmed;
    this.remember(d.features);
    this.redraw();
  }

  /** Cached features are filtered by the currently selected classes here,
   *  so ticking a chip off repaints instantly instead of refetching. */
  draw(features) {
    const visible = features.filter((f) => this.presets.has(f.preset));
    const byPreset = {};
    for (const f of visible) byPreset[f.preset] = (byPreset[f.preset] || 0) + 1;
    this.byPreset = byPreset;

    for (const f of visible) {
      const color = Cesium.Color.fromCssColorString(f.color || '#a0e548');
      this.source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
        point: {
          pixelSize: 6,
          color: color.withAlpha(0.9),
          outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(1e3, 1.5, 3e5, 0.4),
        },
        properties: { layer: 'overpass', record: f },
      });
    }
    return visible.length;
  }

  detail(rec) {
    const t = rec.tags || {};
    const notable = ['operator', 'surveillance', 'surveillance:type', 'surveillance:zone',
      'camera:type', 'camera:mount', 'camera:direction', 'height', 'operator:type',
      'military', 'power', 'voltage', 'output:electricity', 'aeroway', 'icao', 'iata',
      'ele', 'tower:type', 'telecom', 'start_date', 'website', 'opening_hours'];

    // A feature can satisfy several selected classes — a military airfield is
    // both. Say so rather than silently showing only the first.
    const alsoIn = (rec.presets || []).slice(1)
      .map((p) => this.labels?.[p] || p);

    return {
      kind: rec.presetLabel?.toUpperCase() || 'OSM FEATURE',
      title: rec.name || rec.kind || rec.id,
      accent: rec.color || '#a0e548',
      html: `
        <table>${rows([
          ['Type', rec.kind],
          ['Also matches', alsoIn.length ? alsoIn.join(', ') : null],
          ['Coordinates', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`],
          ...notable.filter((k) => t[k]).map((k) => [k, t[k]]),
        ])}</table>
        <details><summary>All OSM tags (${Object.keys(t).length})</summary>
          <table>${rows(Object.entries(t))}</table></details>
        <a class="ext" href="https://www.openstreetmap.org/${rec.id}"
           target="_blank" rel="noopener">View on OpenStreetMap ↗</a>`,
    };
  }
}

/* ================================================================== */
/* ALPR — licence-plate readers (Flock Safety and friends)             */
/* ================================================================== */

const EARTH_R = 6378137;

/** Offset a lat/lon by a bearing and distance. Equirectangular is exact
 *  enough at the ~60m scale of a camera's field of view. */
/**
 * A per-frame position for an entity.
 *
 * Cesium 1.109 added CallbackPositionProperty for exactly this: a position
 * that changes every frame. The older CallbackProperty satisfies the plain
 * Property interface but not PositionProperty, so the renderer's
 * reference-frame lookup throws and the entity silently stops moving. The
 * fallback keeps an older build drawing rather than crashing.
 */
function positionCallback(fn) {
  return typeof Cesium.CallbackPositionProperty === 'function'
    ? new Cesium.CallbackPositionProperty(fn, false)
    : new Cesium.CallbackProperty(fn, false);
}

function offsetLatLon(lat, lon, bearingDeg, metres) {
  const br = (bearingDeg * Math.PI) / 180;
  const dLat = (metres * Math.cos(br)) / EARTH_R;
  const dLon = (metres * Math.sin(br)) / (EARTH_R * Math.cos((lat * Math.PI) / 180));
  return [lat + (dLat * 180) / Math.PI, lon + (dLon * 180) / Math.PI];
}

/** A wedge from the camera position out along `bearing`. */
function coneRing(lat, lon, bearing, rangeM = 55, halfAngle = 20, steps = 10) {
  // Apex, then the arc. Cesium closes a polygon itself — repeating the first
  // vertex at the end leaves a zero-length edge, which produces degenerate
  // triangles and throws during re-tessellation when the camera tilts.
  const flat = [lon, lat];
  for (let i = 0; i <= steps; i++) {
    const a = bearing - halfAngle + (2 * halfAngle * i) / steps;
    const [la, lo] = offsetLatLon(lat, lon, a, rangeM);
    flat.push(lo, la);
  }
  return flat;
}

export class AlprLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'alpr', 'ALPR / Flock');
    // OSM-sourced, and changes over weeks. Held for 72 hours, refreshed on demand.
    this.coverageTtlMs = INVENTORY_COVERAGE_MS;
    // Modest, unlike Shodan's: the server snaps this outward onto a fixed
    // grid anyway, so the slack that keeps small pans inside coverage comes
    // from the cell rather than from padding. At 0.6 the padded box was 2.2x
    // the view in each axis — nearly five times the area — and for an
    // Overpass query that is paid for in seconds, not credits.
    this.padFactor = 0.15;
    this.accumulate = true;
    this.vendorFilter = new Set();   // empty = all vendors
    this.showCones = true;
    this.onlyWithDirection = false;
    this.vendors = [];
    this.byVendor = {};
    this.byOperator = {};
    this.withDirection = 0;
    this.total = 0;
  }

  // The fetch always asks for every vendor and filters in draw(), so the
  // vendor chips are a display option — they repaint, they don't refetch.
  settingsSig() { return 'all'; }

  async load({ bbox }) {
    // Always fetch every vendor; the vendor chips filter at draw time so the
    // cache stays useful when you change your mind about which to show.
    const box = this.padBbox(bbox);
    this.lastFetchedBbox = box;
    const data = await this.fetch('/api/alpr', { bbox: box, vendor: 'all' });
    this.coveredBbox = data.covered || null;
    this.trimmed = !!data.trimmed;

    this.vendors = data.vendors;
    this.byOperator = data.byOperator;
    this.total = data.total;
    this.remember(data.cameras);
    this.redraw();
  }

  draw(cameras) {
    const colorFor = Object.fromEntries((this.vendors || []).map((v) => [v.key, v.color]));
    const wanted = this.vendorFilter.size
      ? cameras.filter((c) => this.vendorFilter.has(c.vendor))
      : cameras;

    const byVendor = {};
    for (const c of wanted) byVendor[c.vendor] = (byVendor[c.vendor] || 0) + 1;
    this.byVendor = byVendor;
    this.withDirection = wanted.filter((c) => c.directions.length).length;

    let shown = 0;
    for (const c of wanted) {
      if (this.onlyWithDirection && !c.directions.length) continue;
      shown++;

      const css = colorFor[c.vendor] || '#8b949e';
      const color = Cesium.Color.fromCssColorString(css);

      // One wedge per bearing — dual-lens units legitimately have two.
      if (this.showCones) {
        for (const bearing of c.directions) {
          this.source.entities.add({
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                Cesium.Cartesian3.fromDegreesArray(coneRing(c.lat, c.lon, bearing)),
              ),
              material: color.withAlpha(0.18),
              outline: true,
              outlineColor: color.withAlpha(0.55),
              classificationType: Cesium.ClassificationType.TERRAIN,
            },
            properties: { layer: 'alpr', record: c },
          });
        }
      }

      this.source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 0),
        billboard: {
          image: alprSprite(css, c.directions.length > 0),
          width: 20,
          height: 20,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(500, 1.6, 2.5e5, 0.35),
        },
        properties: { layer: 'alpr', record: c },
      });
    }

    return shown;
  }

  /**
   * Field-of-view wedges for the detail panel's close-up map — the same
   * nominal range and spread the globe draws, one per lens.
   */
  insetCones(rec) {
    return (rec?.directions || [])
      .filter((b) => Number.isFinite(Number(b)))
      .map((b) => ({ bearing: Number(b), rangeM: 55, halfAngle: 20 }));
  }

  detail(rec) {
    const vendorLabel = this.vendors.find((v) => v.key === rec.vendor)?.label || 'Unknown';
    const accent = this.vendors.find((v) => v.key === rec.vendor)?.color || '#8b949e';
    const bearings = rec.directions.length
      ? rec.directions.map((d) => `${d.toFixed(0)}° ${compassOf(d)}`).join(', ')
      : null;
    const dropped = rec.directionRaw && rec.directions.length === 0
      ? `tagged "${rec.directionRaw}" — not a valid bearing`
      : null;

    return {
      kind: 'LICENCE PLATE READER',
      title: rec.operator || rec.manufacturer || vendorLabel,
      accent,
      html: `
        ${safeUrl(rec.image) ? `<img class="cam" src="${esc(safeUrl(rec.image))}" alt="camera" data-hide-on-error>` : ''}
        <table>${rows([
          ['Vendor', vendorLabel],
          ['Manufacturer', rec.manufacturer],
          ['Model', rec.model],
          ['Operator', rec.operator],
          ['Operator type', rec.operatorType],
          ['Facing', bearings || dropped],
          ['Zone', rec.zone],
          ['Surveillance', rec.surveillance],
          ['Mount', rec.mount],
          ['Power', rec.power],
          ['Reference', rec.ref],
          ['Coordinates', `${rec.lat.toFixed(6)}, ${rec.lon.toFixed(6)}`],
        ])}</table>
        <details><summary>All OSM tags (${Object.keys(rec.tags || {}).length})</summary>
          <table>${rows(Object.entries(rec.tags || {}))}</table></details>
        <a class="ext" href="https://www.openstreetmap.org/${rec.osmType}/${rec.osmId}"
           target="_blank" rel="noopener">View on OpenStreetMap ↗</a>
        <a class="ext" href="https://deflock.org/?lat=${rec.lat}&lon=${rec.lon}&zoom=17"
           target="_blank" rel="noopener">Open in DeFlock ↗</a>
        <p class="hint">Crowdsourced via DeFlock and stored in OpenStreetMap.
        Coverage is uneven — an empty area means nobody has mapped it, not that
        there are no cameras.</p>`,
    };
  }
}

const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compassOf = (deg) => COMPASS_POINTS[Math.round(((deg % 360) / 22.5)) % 16];

const alprCache = new Map();
function alprSprite(color, hasDirection) {
  const key = `${color}:${hasDirection}`;
  if (alprCache.has(key)) return alprCache.get(key);
  // A plate-reader glyph: camera body on a pole, with a tick when the
  // bearing is known so unmapped orientation is visible at a glance.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect x="6" y="7" width="20" height="12" rx="2.5" fill="${color}"
          stroke="rgba(0,0,0,.7)" stroke-width="1.4"/>
    <rect x="9" y="10.5" width="14" height="5" rx="1" fill="rgba(0,0,0,.62)"/>
    <rect x="14.6" y="19" width="2.8" height="9" fill="${color}"
          stroke="rgba(0,0,0,.7)" stroke-width="1"/>
    ${hasDirection ? `<circle cx="16" cy="5" r="2.4" fill="${color}" stroke="rgba(0,0,0,.7)" stroke-width="1"/>` : ''}
  </svg>`;
  const uri = `data:image/svg+xml;base64,${btoa(svg)}`;
  alprCache.set(key, uri);
  return uri;
}

/** Small status chip overlaid on a live camera view. */
function liveBadge(text) {
  const b = document.createElement('span');
  b.className = 'cam-badge';
  b.textContent = text;
  return b;
}

/* ================================================================== */
/* EVENTS — live hazard and disaster situational awareness             */
/* ================================================================== */

const SEVERITY_STYLE = {
  red:    { color: '#ff2d55', size: 15, label: 'Red' },
  orange: { color: '#ff9f1c', size: 12, label: 'Orange' },
  green:  { color: '#7ee787', size: 9,  label: 'Green' },
  info:   { color: '#4cc9f0', size: 8,  label: 'Info' },
};

export class EventLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'events', 'Situational awareness');
    // Hazards resolve, so keep them a shorter time than static infrastructure.
    this.accumulate = true;
    this.cacheTtlMs = CURRENT_COVERAGE_MS;
    this.sources = new Set(['gdacs', 'eonet', 'usgs', 'nws']);
    this.minSeverity = 'info';
    this.showPolygons = true;
    this.bySource = {};
    this.problems = {};
    this.zoneOnly = 0;
  }

  settingsSig() { return `${[...this.sources].sort().join(',')}|${this.minSeverity}`; }

  async load({ bbox }) {
    const box = this.padBbox(bbox);
    this.lastFetchedBbox = box;
    const data = await this.fetch('/api/events', {
      bbox: box,
      sources: [...this.sources].join(','),
      minSeverity: this.minSeverity,
    });
    this.problems = data.problems || {};
    this.zoneOnly = data.zoneOnlyAlerts || 0;
    this.remember(data.events);
    this.redraw();
    if (Object.keys(this.problems).length && !this.count) {
      throw new Error(Object.values(this.problems)[0]);
    }
  }

  draw(events) {
    const floor = { info: 0, green: 1, orange: 2, red: 3 }[this.minSeverity] ?? 0;
    const rank = { info: 0, green: 1, orange: 2, red: 3 };
    const visible = events.filter((e) =>
      this.sources.has(e.source) && (rank[e.severity] ?? 0) >= floor);

    const bySource = {};
    for (const e of visible) bySource[e.source] = (bySource[e.source] || 0) + 1;
    this.bySource = bySource;

    for (const e of visible) {
      const style = SEVERITY_STYLE[e.severity] || SEVERITY_STYLE.info;
      const color = Cesium.Color.fromCssColorString(style.color);

      // Affected-area polygon, where the source provides one.
      if (this.showPolygons && e.polygon?.length > 2) {
        this.source.entities.add({
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray(e.polygon.flat()),
            ),
            material: color.withAlpha(0.16),
            outline: true,
            outlineColor: color.withAlpha(0.75),
            outlineWidth: 2,
            classificationType: Cesium.ClassificationType.TERRAIN,
          },
          properties: { layer: 'events', record: e },
        });
      }

      this.source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat, 0),
        point: {
          pixelSize: style.size,
          color: color.withAlpha(0.9),
          outlineColor: color,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(1e4, 1.4, 4e6, 0.55),
        },
        // A pulsing halo makes red-level alerts findable at a glance.
        ellipse: e.severity === 'red' ? {
          semiMinorAxis: new Cesium.CallbackProperty(
            () => 6000 + 3500 * Math.sin(Date.now() / 450), false),
          semiMajorAxis: new Cesium.CallbackProperty(
            () => 6000 + 3500 * Math.sin(Date.now() / 450), false),
          material: color.withAlpha(0.14),
          outline: true,
          outlineColor: color.withAlpha(0.5),
          classificationType: Cesium.ClassificationType.TERRAIN,
        } : undefined,
        properties: { layer: 'events', record: e },
      });
    }

    return visible.length;
  }

  detail(rec) {
    const style = SEVERITY_STYLE[rec.severity] || SEVERITY_STYLE.info;
    const when = (t) => (t ? String(t).replace('T', ' ').replace(/(\.\d+)?Z?$/, '').slice(0, 16) : null);
    const ago = rec.time ? relTime(rec.time) : null;

    return {
      kind: `${rec.source.toUpperCase()} · ${rec.kind || 'EVENT'}`,
      title: rec.title,
      accent: style.color,
      html: `
        ${rec.severity === 'red'
          ? `<div class="alarm">${esc(rec.severityLabel || 'RED ALERT')}</div>` : ''}
        <table>${rows([
          ['Severity', rec.severityLabel || style.label],
          ['Magnitude', rec.magnitudeText || (rec.magnitude != null
            ? `${rec.magnitude} ${rec.magnitudeUnit || ''}`.trim() : null)],
          ['Location', rec.country],
          ['Coordinates', `${rec.lat.toFixed(4)}, ${rec.lon.toFixed(4)}`],
          ['Onset', when(rec.time) + (ago ? ` (${ago})` : '')],
          ['Ends', when(rec.endTime)],
          ['Affected area', rec.polygon?.length ? `polygon, ${rec.polygon.length} vertices` : null],
        ])}</table>
        ${rec.description ? `<h4>Detail</h4><p class="body">${esc(rec.description)}</p>` : ''}
        ${rec.instruction ? `<h4>Instruction</h4><p class="body">${esc(rec.instruction)}</p>` : ''}
        ${safeUrl(rec.url) ? `<a class="ext" href="${esc(safeUrl(rec.url))}" target="_blank" rel="noopener noreferrer">Open source report ↗</a>` : ''}`,
    };
  }
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const s = (Date.now() - t) / 1000;
  if (s < 0) return 'upcoming';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

/* ================================================================== */
/* WEBCAMS — intentionally public cameras                              */
/* ================================================================== */

export class WebcamLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'webcams', 'Public cameras');
    // Slow-moving: held for 72 hours, refreshed on demand.
    this.coverageTtlMs = INVENTORY_COVERAGE_MS;
    this.accumulate = true;
    this.windyConfigured = false;
    this.owcdbConfigured = false;
    this.bySource = {};
    this.problems = {};
  }

  async load({ bbox }) {
    const box = this.padBbox(bbox);
    this.lastFetchedBbox = box;
    const data = await this.fetch('/api/webcams', { bbox: box });
    this.windyConfigured = data.windyConfigured;
    this.owcdbConfigured = data.owcdbConfigured;
    this.problems = data.problems || {};
    this.remember(data.webcams);
    this.redraw();
  }

  draw(cams) {
    const bySource = {};
    for (const c of cams) bySource[c.source] = (bySource[c.source] || 0) + 1;
    this.bySource = bySource;

    for (const c of cams) {
      this.source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 0),
        billboard: {
          image: camSprite(CAM_COLOR[c.source] || '#ffd166'),
          width: 22,
          height: 22,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(1e3, 1.4, 4e5, 0.4),
        },
        properties: { layer: 'webcams', record: c },
      });
    }
    return cams.length;
  }

  /**
   * Mount the live view once the panel is on screen. Operators publish these
   * two different ways: an embeddable player (Windy) or a single frame that
   * is overwritten in place (DOT and wildfire cameras). The first goes in an
   * iframe, the second is re-fetched on a timer with a cache-busting param,
   * which is what makes a still image behave like a feed.
   */
  async enrich(rec, root) {
    const stage = root.querySelector('[data-slot="camstage"]');
    if (!stage) return;
    this.stopLive();

    const embed = safeUrl(rec.embed, { httpsOnly: true });
    const still = safeUrl(rec.image);
    if (embed) {
      const frame = document.createElement('iframe');
      frame.className = 'cam-frame';
      frame.src = embed;
      frame.loading = 'lazy';
      // sandbox is a DOMTokenList and referrerPolicy reflects an attribute —
      // setting these through setAttribute is the form every browser honours.
      // The player is third-party content: it gets what a video player needs
      // and nothing that would let it touch this page.
      frame.setAttribute('sandbox',
        'allow-scripts allow-same-origin allow-presentation allow-popups');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('allow', 'autoplay; fullscreen; picture-in-picture');
      stage.append(frame);
      stage.append(liveBadge('live player'));
      return;
    }

    if (!still) {
      stage.innerHTML = '<p class="hint">This camera publishes no still frame or player.</p>';
      return;
    }

    const img = document.createElement('img');
    img.className = 'cam-live';
    img.alt = `${rec.title} live view`;
    img.referrerPolicy = 'no-referrer';

    // The demo holds one frame per camera, captured with the snapshot.
    if (globalThis.OP_DEMO) {
      img.alt = `${rec.title} snapshot`;
      img.onerror = () => { img.replaceWith(Object.assign(document.createElement('p'),
        { className: 'hint', textContent: 'No frame was captured for this camera.' })); };
      img.src = still;
      stage.append(img, liveBadge('snapshot'));
      return;
    }
    const stamp = liveBadge('updating\u2026');
    stage.append(img, stamp);

    let fails = 0;
    const tick = () => {
      const sep = still.includes('?') ? '&' : '?';
      img.src = `${still}${sep}_t=${Date.now()}`;
    };
    img.onload = () => {
      fails = 0;
      stamp.textContent = `updated ${new Date().toLocaleTimeString()}`;
    };
    img.onerror = () => {
      // Some cameras go offline for long stretches; stop rather than hammer.
      if (++fails >= 3) {
        this.stopLive();
        stamp.textContent = 'camera not responding';
        img.style.display = 'none';
      }
    };

    tick();
    this.liveTimer = setInterval(tick, rec.source === 'nycdot' ? 3000 : 8000);
  }

  stopLive() {
    clearInterval(this.liveTimer);
    this.liveTimer = null;
  }

  detail(rec) {
    return {
      kind: 'PUBLIC CAMERA',
      title: rec.title,
      accent: CAM_COLOR[rec.source] || '#00d9a3',
      html: `
        <div class="cam-stage" data-slot="camstage"></div>
        <div data-slot="inset"></div>
        <table>${rows([
          ['Source', CAM_SOURCE_LABEL[rec.source] || rec.source],
          ['Category', rec.category],
          ['Pointing', rec.pan != null ? `${Math.round(rec.pan)}° pan, ${rec.tilt}° tilt` : null],
          ['Location', rec.place],
          ['Coordinates', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`],
          ['Status', rec.status],
          ['Updated', rec.updated],
        ])}</table>
        ${safeUrl(rec.link) ? `<a class="ext" href="${esc(safeUrl(rec.link))}" target="_blank" rel="noopener noreferrer">Open source page ↗</a>` : ''}
        <p class="hint">Cameras published for public viewing by their operators.</p>`,
    };
  }
}

const CAM_COLOR = {
  windy: '#00d9a3',
  nycdot: '#ffd166',
  openwebcamdb: '#8ac6ff',
  alertca: '#ff6b35',
};

const CAM_SOURCE_LABEL = {
  windy: 'Windy Webcams',
  nycdot: 'NYC DOT traffic camera',
  openwebcamdb: 'OpenWebcamDB (curated)',
  alertca: 'ALERTCalifornia (wildfire PTZ)',
};

let camCache = new Map();
function camSprite(color) {
  if (camCache.has(color)) return camCache.get(color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <rect x="4" y="10" width="16" height="12" rx="2" fill="${color}"
          stroke="rgba(0,0,0,.6)" stroke-width="1.2"/>
    <path d="M20 14 L28 9 L28 23 L20 18 Z" fill="${color}"
          stroke="rgba(0,0,0,.6)" stroke-width="1.2"/>
    <circle cx="9" cy="16" r="2.2" fill="rgba(0,0,0,.55)"/></svg>`;
  const uri = `data:image/svg+xml;base64,${btoa(svg)}`;
  camCache.set(color, uri);
  return uri;
}

/* ================================================================== */
/* VESSELS — live AIS ship positions                                   */
/* ================================================================== */

const VESSEL_COLORS = {
  Cargo: '#4cc9f0', Tanker: '#ff9f1c', Passenger: '#7ee787', Fishing: '#c77dff',
  Tug: '#f9c74f', 'Law enforcement': '#ff2d55', 'Search & rescue': '#ff2d55',
  'Pleasure craft': '#90be6d', Sailing: '#90be6d', 'High-speed craft': '#00d9a3',
  'Pilot vessel': '#f9c74f', Military: '#ff2d55',
};
const vesselColor = (t) => VESSEL_COLORS[t] || '#8ac6ff';

export class VesselLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'vessels', 'Vessels (AIS)');
    this.byType = {};
    this.stream = {};
    this.showNames = true;
    this.movingOnly = false;
    this.tracked = 0;
  }

  async load({ bbox }) {
    const data = await this.fetch('/api/vessels', { bbox });
    this.byType = data.byType || {};
    this.stream = data.stream || {};
    this.tracked = data.tracked || 0;
    this.clear();

    for (const v of data.vessels) {
      if (this.movingOnly && (v.sog ?? 0) < 0.5) continue;
      const css = vesselColor(v.shipTypeName);
      const color = Cesium.Color.fromCssColorString(css);
      // Heading is the hull's true heading; course over ground is where it's
      // actually going. Prefer heading, fall back to COG.
      const bearing = v.heading ?? v.cog ?? 0;
      const moving = (v.sog ?? 0) >= 0.5;

      this.source.entities.add({
        id: `v${v.mmsi}`,
        position: Cesium.Cartesian3.fromDegrees(v.lon, v.lat, 0),
        billboard: {
          image: vesselSprite(css, moving),
          width: 22, height: 22,
          rotation: Cesium.Math.toRadians(-bearing),
          alignedAxis: Cesium.Cartesian3.ZERO,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(1e4, 1.3, 2e6, 0.4),
        },
        label: {
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          text: v.name || v.mmsi,
          font: '600 10px "JetBrains Mono", ui-monospace, monospace',
          fillColor: color,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
          outlineWidth: 3,
          pixelOffset: new Cesium.Cartesian2(14, -10),
          horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4e5),
          show: this.showNames,
        },
        properties: { layer: 'vessels', record: v },
      });
    }
    this.count = this.source.entities.values.length;
  }

  detail(rec) {
    const kn = (n) => (n == null ? null : `${Number(n).toFixed(1)} kn`);
    return {
      kind: 'VESSEL',
      title: rec.name || `MMSI ${rec.mmsi}`,
      accent: vesselColor(rec.shipTypeName),
      html: `
        <table>${rows([
          ['MMSI', rec.mmsi],
          ['IMO', rec.imo || null],
          ['Call sign', rec.callSign],
          ['Type', rec.shipTypeName],
          ['Navigation', rec.navStatus],
          ['Position', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`],
          ['Speed', kn(rec.sog)],
          ['Course', rec.cog != null ? `${Number(rec.cog).toFixed(0)}°` : null],
          ['Heading', rec.heading != null ? `${rec.heading}°` : null],
          ['Destination', rec.destination],
          ['Draught', rec.draught ? `${rec.draught} m` : null],
          ['Length × beam', rec.length ? `${rec.length} × ${rec.beam || '?'} m` : null],
          ['Transponder', rec.classB ? 'Class B' : 'Class A'],
          ['Last report', rec.ageSeconds != null ? `${rec.ageSeconds}s ago` : null],
        ])}</table>
        <a class="ext" href="https://www.vesselfinder.com/vessels?name=${encodeURIComponent(rec.mmsi)}"
           target="_blank" rel="noopener">Look up vessel ↗</a>
        <p class="hint">Positions are self-reported over AIS. Transponders can be
        switched off or spoofed, so absence is not evidence of absence.</p>`,
    };
  }
}

const vesselCache = new Map();
function vesselSprite(color, moving) {
  const key = `${color}:${moving}`;
  if (vesselCache.has(key)) return vesselCache.get(key);
  // A hull outline pointing "up" so billboard rotation reads as heading.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
    <path d="M16 2 L23 12 L23 27 L16 24 L9 27 L9 12 Z" fill="${color}"
          stroke="rgba(0,0,0,.7)" stroke-width="1.5" stroke-linejoin="round"
          opacity="${moving ? 1 : 0.55}"/>
    ${moving ? '' : '<circle cx="16" cy="17" r="3" fill="rgba(0,0,0,.5)"/>'}
  </svg>`;
  const uri = `data:image/svg+xml;base64,${btoa(svg)}`;
  vesselCache.set(key, uri);
  return uri;
}

/* ================================================================== */
/* NETWORK INFRASTRUCTURE — probes, cells, wireless, Tor              */
/* ================================================================== */

export class NetInfraLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'netinfra', 'Network infrastructure');
    // Slow-moving: held for 72 hours, refreshed on demand.
    this.coverageTtlMs = INVENTORY_COVERAGE_MS;
    this.accumulate = true;
    this.sources = new Set(['atlas']);
    this.bySource = {};
    this.problems = {};
    this.sourceMeta = {};
    this.showRanges = true;
  }

  settingsSig() { return [...this.sources].sort().join(','); }

  async load({ bbox }) {
    const box = this.padBbox(bbox);
    this.lastFetchedBbox = box;
    const data = await this.fetch('/api/netinfra', { bbox: box, sources: [...this.sources].join(',') });
    this.problems = data.problems || {};
    this.sourceMeta = data.sources || {};
    this.remember(data.nodes);
    this.redraw();
  }

  draw(nodes) {
    const colorFor = Object.fromEntries(
      Object.entries(this.sourceMeta).map(([k, v]) => [k, v.color]));
    const visible = nodes.filter((n) => this.sources.has(n.source));

    const bySource = {};
    for (const n of visible) bySource[n.source] = (bySource[n.source] || 0) + 1;
    this.bySource = bySource;

    for (const n of visible) {
      const css = colorFor[n.source] || '#8b949e';
      const color = Cesium.Color.fromCssColorString(css);

      // Cell towers carry an estimated range — drawing it is more honest than
      // a point, since the position is a centroid of observations.
      if (this.showRanges && n.radius && n.radius > 20) {
        this.source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(n.lon, n.lat, 0),
          ellipse: {
            semiMinorAxis: Math.min(n.radius, 20000),
            semiMajorAxis: Math.min(n.radius, 20000),
            material: color.withAlpha(0.08),
            outline: true,
            outlineColor: color.withAlpha(0.4),
            classificationType: Cesium.ClassificationType.TERRAIN,
          },
          properties: { layer: 'netinfra', record: n },
        });
      }

      this.source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(n.lon, n.lat, 0),
        point: {
          // Country aggregates scale with relay count; everything else is fixed.
          pixelSize: n.aggregate
            ? Math.min(26, 7 + Math.log10(Math.max(1, n.weight || 1)) * 8)
            : 7,
          color: color.withAlpha(0.9),
          outlineColor: color,
          outlineWidth: n.aggregate ? 2 : 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(1e3, 1.4, 3e6, 0.5),
        },
        properties: { layer: 'netinfra', record: n },
      });
    }
    return visible.length;
  }

  detail(rec) {
    const meta = this.sourceMeta[rec.source] || {};
    return {
      kind: (meta.label || rec.source).toUpperCase(),
      title: rec.title,
      accent: meta.color || '#8b949e',
      html: `
        ${rec.aggregate ? '<div class="alarm agg">Country-level aggregate</div>' : ''}
        <table>${rows([
          ['Detail', rec.subtitle],
          ['ASN', rec.asn ? `AS${rec.asn}` : null],
          ['Country', rec.country],
          ['Coordinates', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`],
          ...Object.entries(rec.detail || {}),
          ['Tags', rec.tags],
        ])}</table>
        ${rec.source === 'atlas' ? `<a class="ext" href="https://atlas.ripe.net/probes/${encodeURIComponent(rec.id.split(':')[1] ?? '')}/"
           target="_blank" rel="noopener">Open in RIPE Atlas ↗</a>` : ''}
        ${rec.source === 'wigle' ? '<p class="hint">Wireless survey data is contributed by volunteers '
          + 'and reflects where a network was observed, not who owns it.</p>' : ''}`,
    };
  }
}

/* ================================================================== */
/* IOT SENSORS — Sensor.Community                                      */
/* ================================================================== */

export class IotLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'iot', 'IoT sensors');
    // Slow-moving: held for 72 hours, refreshed on demand.
    this.coverageTtlMs = INVENTORY_COVERAGE_MS;
    // Readings go stale faster than positions, but the position is the point.
    this.accumulate = true;
    this.cacheTtlMs = CURRENT_COVERAGE_MS;
    this.includeIndoor = false;
    this.colorBy = 'air';    // 'air' | 'noise' | 'model'
    this.byModel = {};
    this.labels = {};
    this.units = {};
    this.withAir = 0;
    this.withNoise = 0;
  }

  // Indoor sensors are always fetched and filtered in draw(), so this is a
  // display option too.
  settingsSig() { return 'all'; }

  async load({ bbox }) {
    // Always ask for indoor sensors too; the toggle filters at draw time.
    const box = this.padBbox(bbox);
    this.lastFetchedBbox = box;
    const data = await this.fetch('/api/iot', { bbox: box, indoor: '1' });
    this.labels = data.labels || {};
    this.units = data.units || {};
    this.remember(data.sensors);
    this.redraw();
  }

  draw(sensors) {
    const visible = this.includeIndoor ? sensors : sensors.filter((s) => !s.indoor);

    const byModel = {};
    for (const s of visible) byModel[s.model || 'unknown'] = (byModel[s.model || 'unknown'] || 0) + 1;
    this.byModel = byModel;
    this.withAir = visible.filter((s) => s.pm25 != null).length;
    this.withNoise = visible.filter((s) => s.noise != null).length;

    for (const s of visible) {
      let css = '#4cc9f0';
      if (this.colorBy === 'air' && s.air) css = s.air.color;
      else if (this.colorBy === 'noise' && s.noise != null) css = noiseColor(s.noise);
      const color = Cesium.Color.fromCssColorString(css);

      this.source.entities.add({
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
        point: {
          pixelSize: s.indoor ? 6 : 9,
          color: color.withAlpha(0.9),
          outlineColor: s.indoor ? Cesium.Color.fromCssColorString('#8b949e') : color,
          outlineWidth: s.indoor ? 1 : 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          scaleByDistance: new Cesium.NearFarScalar(1e3, 1.5, 3e5, 0.4),
        },
        properties: { layer: 'iot', record: s },
      });
    }
    return visible.length;
  }

  detail(rec) {
    const readings = Object.entries(rec.readings || {}).map(([k, v]) => [
      this.labels[k] || k,
      `${v} ${this.units[k] || ''}`.trim(),
    ]);
    return {
      kind: 'IOT SENSOR',
      title: rec.model ? `${rec.model} #${rec.sensorId}` : `Sensor #${rec.sensorId}`,
      accent: rec.air?.color || '#4cc9f0',
      html: `
        ${rec.air ? `<div class="alarm" style="background:${rec.air.color}22;
           border-color:${rec.air.color}88;color:${rec.air.color}">
           PM2.5 ${rec.pm25} µg/m³ — ${esc(rec.air.label)}</div>` : ''}
        <table>${rows([
          ['Hardware', rec.model],
          ['Manufacturer', rec.manufacturer],
          ['Placement', rec.indoor ? 'Indoor' : 'Outdoor'],
          ['Position', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`
            + (rec.exactLocation ? '' : ' (approximate)')],
          ['Altitude', rec.altitude != null ? `${rec.altitude} m` : null],
          ['Country', rec.country],
          ['Reported', rec.timestamp],
        ])}</table>
        <h4>Live readings</h4><table>${rows(readings)}</table>
        <a class="ext" href="https://maps.sensor.community/#14/${rec.lat}/${rec.lon}"
           target="_blank" rel="noopener">Open on Sensor.Community ↗</a>
        <p class="hint">Citizen-run hardware. Positions are self-declared and some
        owners deliberately blur them, so treat placement as approximate.</p>`,
    };
  }
}

function noiseColor(db) {
  if (db < 45) return '#7ee787';
  if (db < 55) return '#ffd166';
  if (db < 65) return '#ff9f1c';
  return '#ff2d55';
}

/* ================================================================== */
/* TRAFFIC — 511 cameras and incidents                                 */
/* ================================================================== */

export class TrafficLayer extends Layer {
  constructor(viewer) {
    super(viewer, 'traffic', 'Traffic (511)');
    // Cameras are fixed, but incidents clear — keep the window short.
    this.accumulate = true;
    this.cacheTtlMs = 15 * 60_000;
    this.showCameras = true;
    this.showIncidents = true;
    this.byState = {};
    this.problems = {};
    this.configuredStates = [];
    this.hint = null;
  }

  async load({ bbox }) {
    const box = this.padBbox(bbox);
    this.lastFetchedBbox = box;
    const data = await this.fetch('/api/traffic', { bbox: box });
    this.byState = data.byState || {};
    this.problems = data.problems || {};
    this.configuredStates = data.configuredStates || [];
    this.hint = data.hint || null;
    this.remember(data.features);
    this.redraw();
  }

  draw(features) {
    let shown = 0;
    for (const f of features) {
      if (f.kind === 'camera' && !this.showCameras) continue;
      if (f.kind === 'incident' && !this.showIncidents) continue;
      shown++;

      const css = f.kind === 'camera' ? '#ffd166' : '#ff2d55';
      if (f.kind === 'camera') {
        this.source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
          billboard: {
            image: camSprite(css), width: 20, height: 20,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            scaleByDistance: new Cesium.NearFarScalar(1e3, 1.4, 3e5, 0.4),
          },
          properties: { layer: 'traffic', record: f },
        });
      } else {
        this.source.entities.add({
          position: Cesium.Cartesian3.fromDegrees(f.lon, f.lat, 0),
          point: {
            pixelSize: 11,
            color: Cesium.Color.fromCssColorString(css).withAlpha(0.9),
            outlineColor: Cesium.Color.fromCssColorString(css),
            outlineWidth: 2,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          },
          properties: { layer: 'traffic', record: f },
        });
      }
    }
    return shown;
  }

  detail(rec) {
    if (rec.kind === 'camera') {
      return {
        kind: `TRAFFIC CAMERA · ${rec.source.toUpperCase()}`,
        title: rec.title,
        accent: '#ffd166',
        html: `
          ${safeUrl(rec.image) ? `<img class="cam" src="${esc(safeUrl(rec.image))}" alt="camera view" data-hide-on-error>` : ''}
          <table>${rows([
            ['Roadway', rec.roadway],
            ['Direction', rec.direction],
            ['Status', rec.status],
            ['Coordinates', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`],
          ])}</table>
          <p class="hint">State DOT camera, published for public traffic information.</p>`,
      };
    }
    return {
      kind: `INCIDENT · ${rec.source.toUpperCase()}`,
      title: rec.title,
      accent: '#ff2d55',
      html: `
        <table>${rows([
          ['Roadway', rec.roadway],
          ['Direction', rec.direction],
          ['Severity', rec.severity],
          ['Lanes affected', rec.lanesAffected],
          ['Reported', rec.started],
          ['Updated', rec.updated],
          ['Coordinates', `${rec.lat.toFixed(5)}, ${rec.lon.toFixed(5)}`],
        ])}</table>
        ${rec.description ? `<h4>Detail</h4><p class="body">${esc(rec.description)}</p>` : ''}`,
    };
  }
}

/* ================================================================== */
/* WEATHER — RainViewer radar + satellite imagery overlays             */
/* ================================================================== */

export class WeatherOverlay {
  constructor(viewer) {
    this.viewer = viewer;
    this.data = null;
    this.radarLayer = null;
    this.satLayer = null;
    this.radarOn = false;
    this.satOn = false;
    this.frameIndex = -1;     // -1 = latest
    this.animating = false;
    this.timer = null;
    this.onUpdate = null;
  }

  async refresh() {
    this.data = await api('/api/weather', this.forced ? { fresh: 1 } : null);
    if (this.radarOn) this.applyRadar();
    if (this.satOn) this.applySatellite();
    return this.data;
  }

  get frames() { return this.data?.radar?.frames || []; }

  currentFrame() {
    const f = this.frames;
    if (!f.length) return null;
    return f[this.frameIndex < 0 ? f.length - 1 : Math.min(this.frameIndex, f.length - 1)];
  }

  makeLayer(url, alpha, maximumLevel = 12) {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel,
      credit: /gibs\.earthdata/.test(url) ? 'NASA GIBS' : 'RainViewer',
    });
    const layer = new Cesium.ImageryLayer(provider);
    layer.alpha = alpha;
    return layer;
  }

  applyRadar() {
    const frame = this.currentFrame();
    if (!frame) return;
    // Respect the source's real resolution ceiling; beyond it RainViewer
    // serves a "Zoom Level Not Supported" placeholder image.
    const next = this.makeLayer(frame.url, 0.78, this.data?.radar?.maxLevel ?? 7);
    this.viewer.imageryLayers.add(next);
    // Add the replacement before removing the old one so the globe never
    // flashes bare basemap between frames.
    if (this.radarLayer) this.viewer.imageryLayers.remove(this.radarLayer, true);
    this.radarLayer = next;
  }

  applySatellite() {
    // RainViewer advertises an infrared band but publishes no frames, so the
    // server nominates a GIBS product instead. Use whichever is actually
    // available rather than silently drawing nothing.
    const frames = this.data?.satellite?.frames || [];
    const clouds = this.data?.clouds;
    const url = frames.length ? frames[frames.length - 1].url : clouds?.url;
    if (!url) return;
    const next = this.makeLayer(url, 0.6, clouds?.maxLevel ?? 12);
    this.viewer.imageryLayers.add(next);
    if (this.satLayer) this.viewer.imageryLayers.remove(this.satLayer, true);
    this.satLayer = next;
    this.cloudLabel = frames.length ? 'RainViewer infrared' : (clouds?.label || 'cloud imagery');
  }

  /** True when something can actually be drawn for the CLOUD toggle. */
  get cloudsAvailable() {
    return !!(this.data?.satellite?.frames?.length || this.data?.clouds?.url);
  }

  async setRadar(on) {
    this.radarOn = on;
    if (on) {
      if (!this.data) await this.refresh();
      this.applyRadar();
    } else {
      this.stop();
      if (this.radarLayer) { this.viewer.imageryLayers.remove(this.radarLayer, true); this.radarLayer = null; }
    }
    this.onUpdate?.();
  }

  async setSatellite(on) {
    this.satOn = on;
    if (on) {
      if (!this.data) await this.refresh();
      this.applySatellite();
    } else if (this.satLayer) {
      this.viewer.imageryLayers.remove(this.satLayer, true);
      this.satLayer = null;
    }
    this.onUpdate?.();
  }

  setFrame(i) {
    this.frameIndex = i;
    if (this.radarOn) this.applyRadar();
    this.onUpdate?.();
  }

  toggleAnimation() {
    this.animating ? this.stop() : this.play();
    return this.animating;
  }

  play() {
    if (!this.radarOn || !this.frames.length) return;
    this.animating = true;
    // Reflect the state change now — waiting for the first tick leaves the
    // button showing "play" for half a second after it was pressed.
    this.onUpdate?.();
    this.timer = setInterval(() => {
      const n = this.frames.length;
      this.frameIndex = ((this.frameIndex < 0 ? n - 1 : this.frameIndex) + 1) % n;
      this.applyRadar();
      this.onUpdate?.();
    }, 550);
  }

  stop() {
    this.animating = false;
    clearInterval(this.timer);
    this.timer = null;
    this.onUpdate?.();
  }
}

/* ================================================================== */
/* IMAGERY — NASA GIBS daily global satellite tiles                    */
/* ================================================================== */

export class ImageryOverlay {
  constructor(viewer) {
    this.viewer = viewer;
    this.layer = null;
    this.on = false;
    this.layers = [];
    this.selected = 'VIIRS_SNPP_CorrectedReflectance_TrueColor';
    this.date = null;
    this.alpha = 0.85;
    this.meta = null;
    this.onUpdate = null;
  }

  async apply() {
    const data = await api('/api/imagery', { layer: this.selected, date: this.date || undefined });
    this.layers = data.layers;
    this.meta = data.selected;
    if (!this.date) this.date = data.selected.date;

    const provider = new Cesium.UrlTemplateImageryProvider({
      url: data.selected.url,
      maximumLevel: data.selected.maxLevel,
      credit: 'NASA GIBS',
    });
    const next = new Cesium.ImageryLayer(provider);
    next.alpha = this.alpha;
    this.viewer.imageryLayers.add(next);
    if (this.layer) this.viewer.imageryLayers.remove(this.layer, true);
    this.layer = next;
    this.onUpdate?.();
  }

  async set(on) {
    this.on = on;
    if (on) await this.apply();
    else if (this.layer) {
      this.viewer.imageryLayers.remove(this.layer, true);
      this.layer = null;
      this.onUpdate?.();
    }
  }

  async setLayer(key) { this.selected = key; if (this.on) await this.apply(); }
  async setDate(d) { this.date = d; if (this.on) await this.apply(); }

  setAlpha(a) {
    this.alpha = a;
    if (this.layer) this.layer.alpha = a;
  }

  /** Step the imagery date by whole days. */
  async shiftDate(days) {
    const d = new Date(`${this.date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    const today = new Date();
    if (d > today) return;
    await this.setDate(d.toISOString().slice(0, 10));
  }
}

/* ================================================================== */
/* LABELS — place and road names as a transparent tile overlay         */
/* ================================================================== */

/**
 * CARTO publishes a labels-only basemap: transparent PNG tiles carrying just
 * place names and road names. Because it is an ordinary tile pyramid the
 * detail scales itself — motorways and city names when zoomed out, then
 * arterials, then residential street names as you come in.
 *
 * Since 25 Sep 2026 CARTO wants a (free) key for raster tiles. The server
 * holds it as CARTO_API_KEY and proxies the tiles under /tiles/carto/, so the
 * key never reaches the browser. Without one the overlay stays off and says why.
 *
 * It matters most with a Cesium Ion token, where the basemap is photographic
 * imagery with no lettering at all; over plain OSM raster tiles it sharpens
 * the labels already baked into the basemap.
 */
export class LabelsOverlay {
  constructor(viewer) {
    this.viewer = viewer;
    this.layer = null;
    this.on = false;
    this.style = 'dark';       // 'dark' | 'light'
    this.alpha = 1;
    // CARTO's lettering is deliberately understated for a basemap. Over
    // imagery it needs help, so the layer is drawn with boosted contrast and
    // brightness, and optionally stacked twice — two passes of the same
    // semi-transparent glyphs is what actually makes them punch.
    this.contrast = 2.2;
    this.brightness = 1.5;
    this.gamma = 0.75;
    this.boost = true;
    this.boostLayer = null;
    this.onUpdate = null;
    // Set from /api/config: false when the server has no CARTO key.
    this.available = true;
    this.onUnavailable = null;
  }

  tune(layer) {
    layer.alpha = this.alpha;
    layer.contrast = this.contrast;
    layer.brightness = this.brightness;
    layer.gamma = this.gamma;
    return layer;
  }

  url() {
    const set = this.style === 'light' ? 'light_only_labels' : 'dark_only_labels';
    // @2x keeps lettering legible on high-DPI displays. The demo snapshot
    // holds the standard tiles only.
    const retina = !globalThis.OP_DEMO && (window.devicePixelRatio || 1) > 1.25 ? '@2x' : '';
    // Same-origin proxy; the server adds the CARTO key. Relative, so it
    // resolves under a sub-path too.
    return `tiles/carto/${set}/{z}/{x}/{y}${retina}.png`;
  }

  apply() {
    const maximumLevel = globalThis.OP_DEMO?.labelsMaxLevel ?? 18;
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: this.url(),
      maximumLevel,
      credit: '\u00a9 OpenStreetMap contributors, \u00a9 CARTO',
    });
    const next = this.tune(new Cesium.ImageryLayer(provider));
    this.viewer.imageryLayers.add(next);

    // Second pass over the first, which compounds the glyph alpha.
    let boostNext = null;
    if (this.boost) {
      boostNext = this.tune(new Cesium.ImageryLayer(
        new Cesium.UrlTemplateImageryProvider({
          url: this.url(), maximumLevel, credit: '',
        })));
      boostNext.alpha = this.alpha * 0.85;
      this.viewer.imageryLayers.add(boostNext);
    }

    if (this.layer) this.viewer.imageryLayers.remove(this.layer, true);
    if (this.boostLayer) this.viewer.imageryLayers.remove(this.boostLayer, true);
    this.layer = next;
    this.boostLayer = boostNext;
    this.onUpdate?.();
  }

  removeLayers() {
    if (this.layer) { this.viewer.imageryLayers.remove(this.layer, true); this.layer = null; }
    if (this.boostLayer) { this.viewer.imageryLayers.remove(this.boostLayer, true); this.boostLayer = null; }
  }

  set(on) {
    if (on && !this.available) {
      this.on = false;
      this.removeLayers();
      this.onUnavailable?.();
      this.onUpdate?.();
      return;
    }
    this.on = on;
    if (on) this.apply();
    else { this.removeLayers(); this.onUpdate?.(); }
  }

  setStyle(style) { this.style = style; if (this.on) this.apply(); }

  setContrast(c) {
    this.contrast = c;
    // Brightness and gamma track contrast so one slider reads as "punchier".
    this.brightness = 1 + (c - 1) * 0.35;
    this.gamma = Math.max(0.5, 1 - (c - 1) * 0.18);
    if (this.layer) this.tune(this.layer);
    if (this.boostLayer) { this.tune(this.boostLayer); this.boostLayer.alpha = this.alpha * 0.85; }
    this.onUpdate?.();
  }

  setBoost(on) { this.boost = on; if (this.on) this.apply(); }

  setAlpha(a) {
    this.alpha = a;
    if (this.layer) this.layer.alpha = a;
    if (this.boostLayer) this.boostLayer.alpha = a * 0.85;
  }

  /** Keep lettering above any overlay added after it (radar, imagery). */
  bringToFront() {
    const raise = this.viewer.imageryLayers.raiseToTop;
    if (!raise) return;
    if (this.layer) this.viewer.imageryLayers.raiseToTop(this.layer);
    if (this.boostLayer) this.viewer.imageryLayers.raiseToTop(this.boostLayer);
  }
}

/* ================================================================== */
/* HOST ENRICHMENT — reputation lookup for a Shodan result             */
/* ================================================================== */

/**
 * @param {string} ip
 * @param {Element|(() => Element|null)} slot  A node, or — preferably — a
 *   function that resolves the live node at the moment of writing, so a slow
 *   lookup cannot write into a panel the operator has already clicked away
 *   from.
 */
export async function enrichHost(ip, slot) {
  const target = () => (typeof slot === 'function' ? slot() : slot);
  let d;
  try {
    d = await api('/api/enrich', { ip });
  } catch (e) {
    const s = target();
    if (s) s.innerHTML = `<p class="hint">Enrichment unavailable: ${esc(e.message)}</p>`;
    return;
  }

  const parts = [];

  const gn = d.greynoise || {};
  if (gn.error) {
    parts.push(`<h4>Scanner reputation</h4><p class="hint">GreyNoise: ${esc(gn.error)}</p>`);
  } else if (gn.seen) {
    const bad = gn.classification === 'malicious';
    parts.push(`<h4>Scanner reputation</h4>
      <div class="verdict ${bad ? 'bad' : gn.riot ? 'ok' : 'warn'}">
        ${bad ? 'Known malicious scanner'
          : gn.riot ? 'Known benign service' : 'Observed scanning the internet'}
      </div>
      <table>${rows([
        ['Classification', gn.classification],
        ['Attributed to', gn.name],
        ['Mass-scanner', gn.noise ? 'yes' : 'no'],
        ['Common business service', gn.riot ? 'yes' : 'no'],
        ['Last seen', gn.lastSeen],
      ])}</table>`);
  } else {
    parts.push('<h4>Scanner reputation</h4>'
      + '<div class="verdict ok">Not observed scanning by GreyNoise</div>');
  }

  if (d.onC2List && d.botnetC2) {
    const c = d.botnetC2;
    parts.push(`<h4>Threat intelligence</h4>
      <div class="verdict bad">Listed as active botnet C2 — ${esc(c.malware || 'unknown family')}</div>
      <table>${rows([
        ['Malware family', c.malware],
        ['C2 port', c.port],
        ['Status', c.status],
        ['Hostname', c.hostname],
        ['Network', c.asName],
        ['First seen', c.firstSeen],
        ['Last online', c.lastOnline],
      ])}</table>`);
  } else {
    parts.push('<h4>Threat intelligence</h4>'
      + '<div class="verdict ok">Not on the abuse.ch botnet C2 list</div>');
  }

  const s = target();
  if (s) s.innerHTML = parts.join('');
}

export { api };

/* ================================================================== */
/* BASE MAP — swappable ground imagery                                 */
/* ================================================================== */

/**
 * The layer under everything else.
 *
 * Cesium's base imagery is just index 0 of the imagery stack, so swapping
 * providers means adding the replacement and removing the old one — in that
 * order, so the globe is never briefly bare. Everything the other overlays
 * add (radar, cloud, GIBS, labels) sits above index 0 and is untouched.
 *
 * OSM stays the default. Satellite imagery is a deliberate choice: it costs
 * a scene search, renders more slowly, and has holes where cloud was.
 */

/** Drawn by the browser with no server round trip and no scene to pick. */
const BUILTIN_BASEMAPS = new Set(['osm', 'cesium']);

/** Providers whose imagery is a dated scene over a particular place. */
const SCENE_BASED = new Set(['sentinel2', 'gee']);

export class BasemapOverlay {
  constructor(viewer) {
    this.viewer = viewer;
    this.provider = 'osm';
    // Which provider the boot layer actually is. With a Cesium Ion token the
    // globe starts on aerial imagery, not the street map, and the menu has to
    // say so rather than mislabel what is on screen.
    this.builtinKey = null;
    this.layer = null;            // our layer, once we have replaced the original
    this.original = null;         // the layer Cesium started with
    this.scenes = [];
    this.sceneId = null;
    this.from = null;
    this.to = null;
    this.maxCloud = 40;
    this.status = 'idle';
    this.error = null;
    this.meta = null;
    this.onUpdate = null;
  }

  /** Remember the layer Cesium booted with so returning to it is exact. */
  adopt() {
    this.original = this.viewer.imageryLayers.get(0) || null;
  }

  /**
   * Whether a camera settle should re-run the scene search.
   *
   * Only the scene-based providers: what covers Atlanta does not cover
   * Rotterdam. The builtins and the vector map are global and are applied
   * once, so re-searching on every settle would rebuild an identical layer —
   * a visible flash, and for Shortbread a whole tile pyramid thrown away and
   * fetched again. Worse for aerial, which has no scenes to find at all and
   * would keep declaring itself empty.
   */
  get active() { return SCENE_BASED.has(this.provider); }

  /** Default window: the last month, which is 2-6 Sentinel-2 passes. */
  defaultWindow() {
    const to = new Date();
    const from = new Date(to.getTime() - 30 * 86400_000);
    return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }

  async setProvider(key, ctx) {
    this.provider = key;
    // The boot layer is already one of the builtins, so going back to it is
    // exact and costs no tiles. The *other* builtin has to be built.
    //
    // These two were once the same branch, on the assumption that "the layer
    // Cesium booted with" meant OSM. With an Ion token it does not — the
    // globe boots on aerial — so picking Streets handed back the boot layer
    // and quietly showed aerial under a street-map label. Two menu entries,
    // one picture, no error.
    if (key === this.builtinKey) { this.restoreBuiltin(); return; }
    if (BUILTIN_BASEMAPS.has(key)) { this.applyBuiltin(key); return; }
    if (!this.from || !this.to) Object.assign(this, this.defaultWindow());
    await this.search(ctx);
  }

  /** Build the builtin that is *not* what the globe booted with. */
  applyBuiltin(key) {
    this.sceneId = null;
    this.scenes = [];
    this.error = null;
    if (key === 'cesium') {
      // World Imagery comes from the Ion session and arrives as a ready-made
      // layer rather than a provider, so it skips applyProvider.
      this.applyLayer(Cesium.ImageryLayer.fromWorldImagery({}));
    } else {
      // The static demo carries its own copy of these tiles.
      const demo = globalThis.OP_DEMO?.osmTiles;
      this.applyProvider(new Cesium.OpenStreetMapImageryProvider({
        url: demo?.url || 'https://tile.openstreetmap.org/',
        ...(demo?.maxLevel ? { maximumLevel: demo.maxLevel } : {}),
        credit: '© OpenStreetMap contributors',
      }));
    }
    this.status = 'ok';
    this.onUpdate?.();
  }

  restoreBuiltin() {
    this.sceneId = null;
    this.scenes = [];
    this.status = 'idle';
    this.error = null;
    // Show the original again *before* removing ours, so there is never a
    // frame with no ground at all.
    if (this.original) {
      this.original.show = true;
      this.viewer.imageryLayers.lowerToBottom(this.original);
    }
    if (this.layer) {
      this.viewer.imageryLayers.remove(this.layer, true);
      this.layer = null;
    }
    this.onUpdate?.();
  }

  /** Find what is available over the current view. */
  async search(ctx) {
    this.status = 'loading';
    this.error = null;
    this.onUpdate?.();
    try {
      const d = await api('/api/basemap', {
        provider: this.provider,
        bbox: ctx?.bbox || undefined,
        from: this.from, to: this.to, maxCloud: this.maxCloud,
      });
      this.meta = d;
      this.scenes = d.scenes || [];

      if (d.vector && d.url) {
        // Vector tiles are drawn in the browser, so there is no scene to
        // pick and nothing to search for — apply and done.
        this.sceneId = null;
        this.applyProvider(new ShortbreadImageryProvider({
          url: d.url, maximumLevel: d.maxLevel || 14, credit: d.attribution,
        }));
        this.status = 'ok';
        this.onUpdate?.();
        return;
      }
      if (d.tiles && d.url) {
        // A ready-made tile set with nothing to choose (the demo's satellite
        // mosaic): apply it as is.
        this.sceneId = null;
        this.applyTiles(d.url, d.maxLevel, d.attribution);
      } else if (this.provider === 'gee' && d.composite) {
        this.sceneId = d.composite.id;
        this.applyTiles(d.composite.url, d.maxLevel, d.attribution);
      } else if (this.scenes.length) {
        // Keep the operator's pick if it is still in range, else take the
        // newest. The clearest scene is offered in the menu, not forced.
        const keep = this.scenes.find((s) => s.id === this.sceneId);
        const pick = keep || this.scenes[0];
        this.sceneId = pick.id;
        this.applyTiles(pick.url, d.maxLevel, d.attribution);
      } else {
        this.status = 'empty';
        this.error = 'No imagery in this window — widen the dates or raise the cloud limit.';
        this.onUpdate?.();
        return;
      }
      this.status = 'ok';
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
    }
    this.onUpdate?.();
  }

  async selectScene(id, ctx) {
    const s = this.scenes.find((x) => x.id === id);
    if (!s) return;
    this.sceneId = id;
    this.applyTiles(s.url, this.meta?.maxLevel, this.meta?.attribution);
    this.onUpdate?.();
    void ctx;
  }

  applyTiles(url, maxLevel, credit) {
    this.applyProvider(new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel: maxLevel || 15,
      credit: credit || '',
    }));
  }

  /** Swap in any imagery provider, raster or self-drawn. */
  applyProvider(provider) {
    this.applyLayer(new Cesium.ImageryLayer(provider));
  }

  /** Swap in a ready-made layer. */
  applyLayer(next) {
    this.viewer.imageryLayers.add(next);
    this.viewer.imageryLayers.lowerToBottom(next);
    // Only now drop what it replaced: adding first means no bare globe.
    if (this.layer) this.viewer.imageryLayers.remove(this.layer, true);
    else if (this.original) this.original.show = false;
    this.layer = next;
  }

  async setWindow({ from, to, maxCloud }, ctx) {
    if (from) this.from = from;
    if (to) this.to = to;
    if (maxCloud != null) this.maxCloud = maxCloud;
    if (this.active) await this.search(ctx);
    else this.onUpdate?.();
  }
}

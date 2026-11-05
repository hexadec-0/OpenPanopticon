// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
//
// Send map tile requests through the server's disk cache (/tiles/cache),
// which keeps each tile for a month.
//
// The tile URLs are not ours to choose: Cesium World Imagery gets its Bing
// addresses from Cesium Ion at run time, and the other providers build their
// own. So rather than threading a proxy option through every provider, this
// rewrites requests at the one place Cesium sends them all: its Resource
// implementations, for images and for XHR alike. Only hosts the server says
// it caches are rewritten; everything else (Ion, terrain, the APIs) goes out
// unchanged. The server checks every address again before fetching it.
//
// Spread across ports. A browser opens at most six connections to one
// host:port, and the API shares this one, so the server also answers tile
// requests on a few extra ports. Each counts as its own six. A tile always
// goes to the same port (chosen from a hash of its address), so the
// browser's own cache still recognises it next time. If the extra ports
// cannot be reached (a container that publishes only the main one, say),
// everything goes to the main port as before.

let hosts = null;
let endpoints = [];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * The cached address for a tile URL, or the URL itself if not cached.
 * `sameOrigin` keeps it on the main port, for consumers (plain <img>s) that
 * cannot make a credentialed cross-origin request.
 */
export function viaCache(url, { sameOrigin = false } = {}) {
  if (!hosts || typeof url !== 'string') return url;
  let u;
  try { u = new URL(url, location.href); } catch { return url; }
  if (u.origin === location.origin || !hosts.has(u.host)) return url;
  const list = sameOrigin ? endpoints.slice(0, 1) : endpoints;
  const base = list.length > 1 ? list[1 + (hash(u.href) % (list.length - 1))] : list[0];
  return `${base}?u=${encodeURIComponent(u.href)}`;
}

/** Whether a tile port answers, within a short wait. */
async function reachable(origin) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 1200);
  try {
    const r = await fetch(`${origin}/tiles/ping`, { mode: 'cors', credentials: 'include', signal: ac.signal });
    return r.status === 204 || r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Start rewriting. `list` is the host list from /api/config and `ports` the
 * extra tile ports. Does nothing in the static demo, which serves its own
 * captured tiles.
 */
export async function installTileCache(list, ports = []) {
  if (hosts || !Array.isArray(list) || !list.length || globalThis.OP_DEMO) return false;
  hosts = new Set(list);
  endpoints = [new URL('tiles/cache', document.baseURI).href];

  if (Array.isArray(ports) && ports.length && location.protocol === 'http:') {
    const origins = ports.map((p) => `${location.protocol}//${location.hostname}:${p}`);
    if (await reachable(origins[0])) {
      // Index 0 stays the main port; tiles are spread over the others.
      endpoints.push(...origins.map((o) => `${o}/tiles/cache`));
      // Cesium sends credentials (the access cookie, when there is one) only
      // to servers it is told to trust.
      for (const p of ports) globalThis.Cesium?.TrustedServers?.add(location.hostname, p);
    }
  }

  const impl = globalThis.Cesium?.Resource?._Implementations;
  if (!impl?.createImage || !impl?.loadWithXhr) return true;   // viaCache still works for our own fetches

  const createImage = impl.createImage;
  impl.createImage = function (request, ...rest) {
    if (request && typeof request.url === 'string') request.url = viaCache(request.url);
    return createImage.call(this, request, ...rest);
  };
  const loadWithXhr = impl.loadWithXhr;
  impl.loadWithXhr = function (url, ...rest) {
    return loadWithXhr.call(this, viaCache(url), ...rest);
  };
  return true;
}

/** How many origins tiles are being spread over (for diagnostics). */
export function tileEndpoints() { return endpoints.slice(); }

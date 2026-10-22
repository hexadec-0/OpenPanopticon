// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * settings.js — remember how the terminal was left.
 *
 * Everything here is per-browser convenience state: which layers were on,
 * how each was filtered, which overlays were showing, the optical mode, the
 * sidebar's collapsed state. It lives in localStorage, so it survives a
 * refresh and a server restart.
 *
 * Nothing sensitive goes in: no API keys (those never reach the browser at
 * all), no query results, no positions of anything. Reads and writes are
 * wrapped because storage can be unavailable in a private window or when a
 * browser is set to block site data — a missing store just means defaults.
 */

const KEY = 'openpanopticon.settings.v1';
const LEGACY_KEY = 'worldview.settings.v1';   // pre-rename; migrated on first read

export function load() {
  try {
    let raw = localStorage.getItem(KEY);
    if (!raw) {
      // Carry a pre-rename session over rather than silently resetting every
      // filter the operator had set.
      raw = localStorage.getItem(LEGACY_KEY);
      if (raw) {
        localStorage.setItem(KEY, raw);
        localStorage.removeItem(LEGACY_KEY);
      }
    }
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
    return true;
  } catch { return false; }
}

/** Home origins the operator chose, as opposed to ones we worked out. */
const PINNED = new Set(['manual', 'geoip-pinned']);

/** Read the whole UI back out as a plain object. */
export function collect(wv) {
  const L = wv.layers;
  const set = (s) => [...s];

  return {
    version: 1,
    savedAt: new Date().toISOString(),

    mode: wv.mode,
    queryCeilingM: wv.queryCeilingM,
    autoRefresh: wv.autoRefresh,
    cycle: wv.autoCycle ? {
      on: wv.autoCycle.on,
      intervalS: wv.autoCycle.intervalS,
      excluded: [...wv.autoCycle.excluded],
    } : null,
    sidebarCollapsed: document.body.classList.contains('sidebar-collapsed'),

    enabled: Object.fromEntries(Object.entries(L).map(([k, l]) => [k, l.enabled])),

    shodan: { colorBy: L.shodan.colorBy },
    flights: { showLabels: L.flights.showLabels, showTrails: L.flights.showTrails },
    satellites: { group: L.satellites.group, limit: L.satellites.limit },
    overpass: { presets: set(L.overpass.presets) },
    alpr: {
      vendorFilter: set(L.alpr.vendorFilter),
      showCones: L.alpr.showCones,
      onlyWithDirection: L.alpr.onlyWithDirection,
    },
    events: {
      sources: set(L.events.sources),
      minSeverity: L.events.minSeverity,
      showPolygons: L.events.showPolygons,
    },
    netinfra: { sources: set(L.netinfra.sources), showRanges: L.netinfra.showRanges },
    iot: { colorBy: L.iot.colorBy, includeIndoor: L.iot.includeIndoor },
    traffic: { showCameras: L.traffic.showCameras, showIncidents: L.traffic.showIncidents },
    vessels: { showNames: L.vessels.showNames, movingOnly: L.vessels.movingOnly },

    // Only a *pinned* home is written. A home resolved from the host on boot
    // is an observation with a shelf life, and storing it would quietly turn
    // it into a pin: the machine could move networks and the terminal would
    // keep opening over an address it no longer has.
    home: PINNED.has(wv.home?.source)
      ? { lat: wv.home.lat, lon: wv.home.lon, h: wv.home.h, label: wv.home.label, source: wv.home.source }
      : null,

    basemap: {
      provider: wv.basemap?.provider || 'osm',
      from: wv.basemap?.from || null,
      to: wv.basemap?.to || null,
      maxCloud: wv.basemap?.maxCloud ?? 40,
    },

    overlays: {
      radar: wv.weather.radarOn,
      clouds: wv.weather.satOn,
      imagery: wv.imagery.on,
      imageryLayer: wv.imagery.selected,
      imageryDate: wv.imagery.date,
      imageryAlpha: wv.imagery.alpha,
      labels: wv.labels.on,
      labelStyle: wv.labels.style,
      labelContrast: wv.labels.contrast,
      labelBoost: wv.labels.boost,
    },
  };
}

/**
 * Push saved state back into the layers. Only the parts that exist are
 * touched, so a settings blob written by an older build still loads.
 * Returns the set of layer ids that should be switched on.
 */
export function apply(wv, s) {
  if (!s || typeof s !== 'object') return null;
  const L = wv.layers;
  const asSet = (v, fallback) => (Array.isArray(v) ? new Set(v) : fallback);
  const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

  if (s.shodan) L.shodan.colorBy = s.shodan.colorBy || L.shodan.colorBy;

  if (s.flights) {
    L.flights.showLabels = bool(s.flights.showLabels, L.flights.showLabels);
    L.flights.showTrails = bool(s.flights.showTrails, L.flights.showTrails);
  }
  if (s.satellites) {
    L.satellites.group = s.satellites.group || L.satellites.group;
    L.satellites.limit = Number(s.satellites.limit) || L.satellites.limit;
  }
  if (s.overpass) L.overpass.presets = asSet(s.overpass.presets, L.overpass.presets);
  if (s.alpr) {
    L.alpr.vendorFilter = asSet(s.alpr.vendorFilter, L.alpr.vendorFilter);
    L.alpr.showCones = bool(s.alpr.showCones, L.alpr.showCones);
    L.alpr.onlyWithDirection = bool(s.alpr.onlyWithDirection, L.alpr.onlyWithDirection);
  }
  if (s.events) {
    L.events.sources = asSet(s.events.sources, L.events.sources);
    L.events.minSeverity = s.events.minSeverity || L.events.minSeverity;
    L.events.showPolygons = bool(s.events.showPolygons, L.events.showPolygons);
  }
  if (s.netinfra) {
    L.netinfra.sources = asSet(s.netinfra.sources, L.netinfra.sources);
    L.netinfra.showRanges = bool(s.netinfra.showRanges, L.netinfra.showRanges);
  }
  if (s.iot) {
    L.iot.colorBy = s.iot.colorBy || L.iot.colorBy;
    L.iot.includeIndoor = bool(s.iot.includeIndoor, L.iot.includeIndoor);
  }
  if (s.traffic) {
    L.traffic.showCameras = bool(s.traffic.showCameras, L.traffic.showCameras);
    L.traffic.showIncidents = bool(s.traffic.showIncidents, L.traffic.showIncidents);
  }
  if (s.vessels) {
    L.vessels.showNames = bool(s.vessels.showNames, L.vessels.showNames);
    L.vessels.movingOnly = bool(s.vessels.movingOnly, L.vessels.movingOnly);
  }

  // A stored home is re-validated rather than trusted: this is localStorage,
  // which anything on the origin can write, and a bad pair here would put the
  // camera somewhere undefined on every boot with no obvious cause.
  if (s.home && PINNED.has(s.home.source)) {
    // Number() rather than a strict parse would let null and '' through as 0,
    // a perfectly valid-looking point in the Gulf of Guinea.
    const num = (v) => (typeof v === 'number' ? v
      : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
    const lat = num(s.home.lat);
    const lon = num(s.home.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)
        && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      wv.home = {
        lat,
        lon,
        h: Number.isFinite(num(s.home.h)) ? num(s.home.h) : 4500,
        label: typeof s.home.label === 'string' && s.home.label.trim()
          ? s.home.label.slice(0, 80) : `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        source: s.home.source,
      };
    }
  }

  if (s.basemap && wv.basemap) {
    // The provider itself is applied in restoreSession, which can await the
    // scene search; only the plain settings are pushed back here.
    wv.basemap.from = s.basemap.from || wv.basemap.from;
    wv.basemap.to = s.basemap.to || wv.basemap.to;
    if (Number.isFinite(s.basemap.maxCloud)) wv.basemap.maxCloud = s.basemap.maxCloud;
  }

  const o = s.overlays || {};
  if (o.labelStyle) wv.labels.style = o.labelStyle;
  if (Number.isFinite(o.labelContrast)) wv.labels.setContrast(o.labelContrast);
  if (typeof o.labelBoost === 'boolean') wv.labels.boost = o.labelBoost;
  if (o.imageryLayer) wv.imagery.selected = o.imageryLayer;
  if (o.imageryDate) wv.imagery.date = o.imageryDate;
  if (Number.isFinite(o.imageryAlpha)) wv.imagery.alpha = o.imageryAlpha;

  return {
    enabled: s.enabled && typeof s.enabled === 'object' ? s.enabled : null,
    overlays: o,
    mode: typeof s.mode === 'string' ? s.mode : null,
    queryCeilingM: Number.isFinite(s.queryCeilingM) ? s.queryCeilingM : null,
    autoRefresh: bool(s.autoRefresh, null),
    cycle: s.cycle && typeof s.cycle === 'object'
      ? {
        on: s.cycle.on === true,
        intervalS: Number(s.cycle.intervalS),
        excluded: Array.isArray(s.cycle.excluded)
          ? s.cycle.excluded.filter((v) => typeof v === 'string') : [],
      } : null,
    sidebarCollapsed: bool(s.sidebarCollapsed, null),
    basemap: s.basemap && typeof s.basemap === 'object' ? s.basemap : null,
  };
}

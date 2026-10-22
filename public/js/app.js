// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * app.js — viewer bootstrap, HUD, and the refresh loop that keeps every
 * layer pointed at whatever the camera is currently looking at.
 */

import { OPTICAL_MODES, OpticsController } from './optics.js';
import * as Settings from './settings.js';
import { SelectionMarker } from './selection.js';
import { AutoCycle, CYCLE_STEPS_S } from './autocycle.js';
import { LocationInset } from './inset.js';
import { ShortbreadImageryProvider } from './shortbread.js';
import {
  ShodanLayer, FlightLayer, SatelliteLayer, OverpassLayer, WebcamLayer,
  EventLayer, AlprLayer, VesselLayer, NetInfraLayer, IotLayer, TrafficLayer,
  WeatherOverlay, ImageryOverlay, LabelsOverlay, BasemapOverlay, api,
} from './layers.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * Above this the app asks nothing.
 *
 * Worth knowing how low this is: at 45km the view spans roughly 40km, while
 * the query box itself is capped at 4 degrees (~440km). So the ceiling bites
 * well before the point where a query would actually be wasteful — a normal
 * "look at the whole city" view sits above it and holds everything.
 *
 * It is a dial, not a constant: the FETCH cell in the HUD cycles it, and the
 * choice persists.
 *
 * Orbital assets are exempt regardless — they come from a TLE set rather than
 * a view box, and are the one thing you are looking at from up there.
 */
const QUERY_CEILING_DEFAULT_M = 45_000;
const QUERY_CEILING_STEPS_M = [45_000, 100_000, 250_000, 500_000];


const TARGETS = [
  { name: 'Austin, TX',    lat: 30.2672,  lon: -97.7431, h: 2600 },
  { name: 'New York, NY',  lat: 40.7128,  lon: -74.0060, h: 3000 },
  { name: 'Washington DC', lat: 38.8977,  lon: -77.0365, h: 2400 },
  { name: 'London',        lat: 51.5072,  lon: -0.1276,  h: 3000 },
  { name: 'Singapore',     lat: 1.3521,   lon: 103.8198, h: 3200 },
  { name: 'Rotterdam',     lat: 51.9244,  lon: 4.4777,   h: 4000 },
  { name: 'Suez Canal',    lat: 30.5852,  lon: 32.2654,  h: 9000 },
  { name: 'Gibraltar',     lat: 36.1408,  lon: -5.3536,  h: 6000 },
];

class OpenPanopticon {
  constructor() {
    this.viewer = null;
    this.layers = {};
    this.optics = null;
    this.mode = 'eo';
    this.autoRefresh = true;
    this.refreshTimer = null;
    this.moveTimer = null;
    this.health = null;
    this.selected = null;
    this.queryCeilingM = QUERY_CEILING_DEFAULT_M;
    // Set by Settings.apply when a home is pinned, else resolved on boot.
    this.home = null;
  }

  /* ---------------------------------------------------------------- */
  async boot() {
    this.setBoot('querying local proxy');
    this.health = await api('/api/health').catch((e) => {
      this.fatal(`Cannot reach the OpenPanopticon server: ${e.message}`);
      throw e;
    });

    const cfg = await api('/api/config').catch(() => ({}));

    this.setBoot('initialising globe');
    await this.initViewer(cfg.cesiumIonToken);

    this.setBoot('loading orbital propagator');
    await this.loadSatelliteJs();

    this.setBoot('arming sensors');
    this.layers = {
      shodan: new ShodanLayer(this.viewer),
      flights: new FlightLayer(this.viewer),
      satellites: new SatelliteLayer(this.viewer),
      overpass: new OverpassLayer(this.viewer),
      webcams: new WebcamLayer(this.viewer),
      events: new EventLayer(this.viewer),
      alpr: new AlprLayer(this.viewer),
      vessels: new VesselLayer(this.viewer),
      netinfra: new NetInfraLayer(this.viewer),
      iot: new IotLayer(this.viewer),
      traffic: new TrafficLayer(this.viewer),
    };
    // Layers that cannot work without a key in .env. They are locked off:
    // nothing — a click, a saved session, a shortcut — can switch them on.
    this.locked = {};
    const src = this.health.sources || {};
    const needs = {
      shodan: src.shodan !== 'configured' && 'SHODAN_API_KEY',
      vessels: !String(src.ais || '').startsWith('configured') && 'AISSTREAM_API_KEY',
      traffic: String(src.fiveEleven || '').startsWith('no states') && 'FIVE_ELEVEN_KEYS',
    };
    const reasons = {};
    for (const [id, envVar] of Object.entries(needs)) {
      if (envVar) reasons[id] = `Needs ${envVar} in .env — add it and restart the server.`;
    }
    // The static demo leaves some layers out altogether, the same way.
    this.lockedTag = {};
    for (const [id, why] of Object.entries(globalThis.OP_DEMO?.lockedLayers || {})) {
      reasons[id] = why;
      this.lockedTag[id] = 'OFF';
    }
    for (const [id, why] of Object.entries(reasons)) {
      if (!this.layers[id]) continue;
      this.locked[id] = why;
      const layer = this.layers[id];
      const setEnabled = layer.setEnabled.bind(layer);
      layer.setEnabled = () => setEnabled(false);
      setEnabled(false);
    }

    this.weather = new WeatherOverlay(this.viewer);
    this.imagery = new ImageryOverlay(this.viewer);
    this.labels = new LabelsOverlay(this.viewer);
    this.labels.available = cfg.cartoLabels !== false;
    this.labels.onUnavailable = () => $('#wx-labels').classList.remove('active');
    this.basemap = new BasemapOverlay(this.viewer);
    this.basemap.adopt();
    // Name what the globe actually booted with, so the menu and the map agree.
    this.basemap.builtinKey = this.hasIon ? 'cesium' : globalThis.OP_DEMO?.baseLayer ? 'shortbread' : 'osm';
    this.basemap.provider = this.basemap.builtinKey;
    this.layers.overpass.available = this.health.presets.overpass;
    this.layers.overpass.labels = Object.fromEntries(
      Object.entries(this.health.presets.overpass).map(([k, v]) => [k, v.label]));
    // The demo starts with every infrastructure class showing.
    if (globalThis.OP_DEMO?.overpassAllClasses) {
      this.layers.overpass.presets = new Set(Object.keys(this.health.presets.overpass));
    }

    this.optics = new OpticsController(this.viewer);
    this.selection = new SelectionMarker(this.viewer);
    this.autoCycle = new AutoCycle(this, () => this.renderCycle());

    // Saved filter state has to land before buildUI so every control renders
    // already reflecting it, rather than flipping a moment later.
    this.restoring = true;
    this.saved = Settings.apply(this, Settings.load());

    this.buildUI();
    this.wireGlobe();
    await this.restoreSession();
    this.restoring = false;

    // Open over home: whatever the operator pinned, or failing that wherever
    // this machine appears to be, falling back to Austin if that can't
    // resolve either.
    this.setBoot(this.home ? 'moving to home' : 'resolving host location');
    await this.goHome(true);

    // Layers the session had on, else a sensible first-run set.
    const wanted = this.saved?.enabled
      || globalThis.OP_DEMO?.defaultLayers
      || { flights: true, satellites: true, events: true };
    for (const [id, on] of Object.entries(wanted)) {
      if (this.layers[id]) this.layers[id].setEnabled(!!on);
    }
    this.renderLayerStatus();
    $('#boot').classList.add('gone');
    setTimeout(() => $('#boot')?.remove(), 900);

    this.refreshAll();
    this.refreshSignals().catch(() => {});
    if (this.layers.shodan.enabled) this.refreshShodanCredits().catch(() => {});
    if (this.pendingBasemap && !this.basemapAvailable(this.pendingBasemap)) {
      this.pendingBasemap = null;
    }
    if (this.pendingBasemap) {
      const p = this.pendingBasemap;
      this.pendingBasemap = null;
      this.lastSatSource = p;
      const sel = $('#bm-provider');
      if (sel) sel.value = p;
      this.basemap.setProvider(p, { bbox: this.currentBbox() }).catch(() => {});
    }
    this.startTimers();
  }

  /** Whether a basemap provider has what it needs (e.g. a key) to run. */
  basemapAvailable(key) {
    if (!key) return false;
    const p = (this.health?.presets?.basemaps || []).find((b) => b.key === key);
    return !p || p.available !== false;
  }

  /** Write the current UI state to localStorage, debounced. */
  persist() {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      if (this.restoring || this.resetting) return;
      Settings.save(Settings.collect(this));
    }, 350);
  }

  setBoot(msg) { const n = $('#boot-msg'); if (n) n.textContent = msg + '…'; }

  fatal(msg) {
    const b = $('#boot');
    if (!b) return;
    b.innerHTML = '<div class="fatal"><h1>OFFLINE</h1><p></p></div>';
    b.querySelector('p').textContent = msg;
  }

  /* ---------------------------------------------------------------- */
  async initViewer(ionToken) {
    if (ionToken) Cesium.Ion.defaultAccessToken = ionToken;

    const opts = {
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      shouldAnimate: true,
      contextOptions: { webgl: { alpha: false, powerPreference: 'high-performance' } },
    };

    // Set the ground layer explicitly in both cases.
    //
    // Leaving it unset with an Ion token in play handed the job to Cesium's
    // own default — Cesium World Imagery, aerial photography whose capture
    // date varies by years from region to region. That is why the map "looks
    // old in places", and why the BASEMAP menu claimed OpenStreetMap while
    // something else entirely was drawing. Whatever is on screen is now a
    // named choice.
    this.hasIon = !!ionToken;
    // The static demo brings its own ground: vector tiles captured with the
    // rest of the snapshot, so nothing on screen is fetched live.
    const demoBase = globalThis.OP_DEMO?.baseLayer;
    opts.baseLayer = ionToken
      ? Cesium.ImageryLayer.fromWorldImagery({})
      : demoBase
        ? new Cesium.ImageryLayer(new ShortbreadImageryProvider({
          url: demoBase.url, maximumLevel: demoBase.maxLevel, credit: demoBase.credit,
        }))
        : new Cesium.ImageryLayer(
          new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
        );
    if (!ionToken) opts.terrainProvider = new Cesium.EllipsoidTerrainProvider();

    this.viewer = new Cesium.Viewer('globe', opts);
    const scene = this.viewer.scene;

    if (ionToken) {
      try {
        scene.setTerrain(new Cesium.Terrain(Cesium.CesiumTerrainProvider.fromIonAssetId(1)));
        const bldg = await Cesium.createOsmBuildingsAsync();
        scene.primitives.add(bldg);
        this.buildings = bldg;
      } catch (e) {
        console.warn('Ion assets unavailable, continuing without terrain/buildings', e);
      }
    }

    scene.globe.enableLighting = true;
    scene.globe.depthTestAgainstTerrain = false;
    scene.skyAtmosphere.show = true;
    scene.fog.enabled = true;
    scene.highDynamicRange = false;
    this.viewer.clock.shouldAnimate = true;

    // Show attribution, restyled rather than hidden.
    //
    // This was suppressed as "not our HUD", which was wrong twice over: OSM,
    // CARTO, NASA, Copernicus and Cesium Ion all require it, and it is the
    // only thing that answers "where is this imagery from and how old is
    // it". Cesium aggregates credits from whatever is actually drawing, and
    // updates them as layers change — far more reliable than a string
    // maintained by hand.
    const credit = this.viewer.cesiumWidget.creditContainer;
    if (credit) {
      credit.classList?.add('attribution');
      if (credit.style) credit.style.display = '';
    }
  }

  async loadSatelliteJs() {
    return new Promise((resolve) => {
      const s = document.createElement('script');
      // Relative to this module, so the page also works under a sub-path
      // (the GitHub Pages demo is served from /<repo>/).
      s.src = new URL('../providers/satellite.min.js', import.meta.url).href;
      s.onload = () => resolve(true);
      s.onerror = () => { console.warn('satellite.js unavailable'); resolve(false); };
      document.head.appendChild(s);
    });
  }

  /* ---------------------------------------------------------------- */
  /* View geometry                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Bounding box of what the camera is looking at, capped to a span we are
   * willing to query.
   *
   * The cap has to be centred on the camera's own ground point. Cesium
   * returns a whole-globe rectangle as soon as the horizon comes into view,
   * and centring the cap on *that* rectangle put every query at 0,0 — the
   * Gulf of Guinea — no matter where the operator was actually looking.
   */
  currentBbox() {
    const cam = this.viewer.camera;
    const carto = cam.positionCartographic;
    if (!carto) return null;

    const deg = Cesium.Math.toDegrees;
    const MAX = 4.0;
    const camLat = clampNum(deg(carto.latitude), -85, 85);
    const camLon = wrapLon(deg(carto.longitude));

    const rect = cam.computeViewRectangle();
    let south = camLat - MAX / 2;
    let north = camLat + MAX / 2;
    let west = camLon - MAX / 2;
    let east = camLon + MAX / 2;

    if (rect) {
      const rs = deg(rect.south);
      const rn = deg(rect.north);
      const rw = deg(rect.west);
      const re = deg(rect.east);
      const spanLat = rn - rs;
      // A rectangle crossing the antimeridian comes back with east < west.
      const spanLon = re >= rw ? re - rw : re - rw + 360;

      // Only trust the rectangle while it is both valid and small enough.
      if (Number.isFinite(spanLat) && spanLat > 0 && spanLat <= MAX) {
        south = rs; north = rn;
      }
      if (Number.isFinite(spanLon) && spanLon > 0 && spanLon <= MAX && re >= rw) {
        west = rw; east = re;
      }
    }

    south = clampNum(south, -85, 85);
    north = clampNum(north, -85, 85);
    if (north <= south) { south = camLat - 0.05; north = camLat + 0.05; }

    // Keep the longitude window inside a single -180..180 span so upstreams
    // that do not understand a wrapped box still get something sensible.
    if (west < -180) { east += -180 - west; west = -180; }
    if (east > 180) { west -= east - 180; east = 180; }
    west = clampNum(west, -180, 180);
    east = clampNum(east, -180, 180);
    if (east <= west) { west = camLon - 0.05; east = camLon + 0.05; }

    return [south, west, north, east].map((v) => v.toFixed(4)).join(',');
  }

  /**
   * Fly to home, resolving it first if there is nothing to fly to.
   *
   * A *pinned* home — one the operator set — is authoritative and costs no
   * lookup. Only when none is pinned does this fall back to asking where the
   * host is, and that answer is deliberately not pinned: a laptop that moves
   * networks should open over wherever it is now, not over the café it was
   * in last week. Pinning is what the geolocate button is for.
   */
  async goHome(initial = false) {
    if (!this.home) {
      try {
        this.home = { ...await api('/api/geoip'), source: 'geoip' };
      } catch (e) {
        console.warn('geoip unavailable, falling back to Austin', e);
        this.home = {
          ...TARGETS[0],
          label: `${TARGETS[0].name} (geoIP unavailable)`,
          fallback: true,
          source: 'fallback',
        };
      }
    }
    const h = this.home;
    const height = Number.isFinite(h.h) ? h.h : 4500;
    if (initial) {
      // Jump straight there on boot — a 2s flight from a default position
      // the user never asked for is just a delay.
      this.viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(h.lon, h.lat, height),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
      });
    } else {
      this.flyTo({ lat: h.lat, lon: h.lon, h: height });
    }
    this.renderHome();
  }

  /* ---------------------------------------------------------------- */
  /* Home — where the terminal opens, and the ⌂ button goes            */
  /* ---------------------------------------------------------------- */

  /** A coordinate pair as a label, when there is no name for the place. */
  static coordLabel(lat, lon) {
    return `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} `
      + `${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
  }

  /** Push the current home into the HUD and the editor. */
  renderHome() {
    const h = this.home;
    const hud = $('#hud-home');
    if (hud) {
      hud.textContent = h?.label || '—';
      // A pinned home and a resolved one are different claims about the
      // world; the HUD should not present them as the same thing.
      hud.title = !h ? ''
        : h.source === 'manual' ? `Pinned home — ${OpenPanopticon.coordLabel(h.lat, h.lon)}`
          : h.source === 'geoip-pinned' ? `Pinned from host geolocation — ${OpenPanopticon.coordLabel(h.lat, h.lon)}`
            : h.source === 'fallback' ? 'Host location could not be resolved; showing the default'
              : `Resolved from the host’s network address — ${OpenPanopticon.coordLabel(h.lat, h.lon)}`;
    }

    const cur = $('#he-current');
    if (cur && h) {
      const how = { manual: 'pinned', 'geoip-pinned': 'pinned from host', geoip: 'host geolocation', fallback: 'default' };
      cur.textContent = `${h.label || OpenPanopticon.coordLabel(h.lat, h.lon)} · ${how[h.source] || 'unset'}`;
      cur.classList.toggle('pinned', h.source === 'manual' || h.source === 'geoip-pinned');
    }
    const clear = $('#he-clear');
    if (clear) clear.disabled = !(h?.source === 'manual' || h?.source === 'geoip-pinned');
  }

  /**
   * Pin a home and persist it.
   *
   * Coordinates are validated here rather than trusted, because the failure
   * is silent and ugly: Cartesian3.fromDegrees(NaN, NaN) puts the camera at
   * the centre of the earth and the operator just sees black.
   */
  setHome({ lat, lon, h, label, source = 'manual' }) {
    const la = coordNum(lat);
    const lo = coordNum(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      this.toast('Home needs a numeric latitude and longitude.');
      return false;
    }
    if (la < -90 || la > 90) { this.toast('Latitude must be between -90 and 90.'); return false; }
    if (lo < -180 || lo > 180) { this.toast('Longitude must be between -180 and 180.'); return false; }

    this.home = {
      lat: la,
      lon: lo,
      h: Number.isFinite(Number(h)) ? Number(h) : 4500,
      label: (label || '').trim() || OpenPanopticon.coordLabel(la, lo),
      source,
    };
    this.renderHome();
    this.persist();
    return true;
  }

  /** Pin wherever the camera is now, including how far out it is. */
  setHomeFromView() {
    const c = this.viewer.camera.positionCartographic
      || Cesium.Cartographic.fromCartesian(this.viewer.camera.position);
    if (!c) { this.toast('Could not read the camera position.'); return; }
    const lat = Cesium.Math.toDegrees(c.latitude);
    const lon = Cesium.Math.toDegrees(c.longitude);
    const name = $('#he-name')?.value?.trim();
    if (this.setHome({ lat, lon, h: c.height, label: name, source: 'manual' })) {
      this.syncHomeInputs();
      this.toast(`Home pinned: ${this.home.label}`);
    }
  }

  /** Ask the server where this machine is, and pin the answer. */
  async geolocateHost() {
    const btn = $('#he-geolocate');
    if (btn) { btn.disabled = true; btn.textContent = 'Locating host…'; }
    try {
      // fresh=1: the point of pressing this is to find out where the host is
      // *now*, which a day-old cached answer cannot tell you.
      const g = await api('/api/geoip', { fresh: 1 });
      if (this.setHome({ lat: g.lat, lon: g.lon, h: 4500, label: g.label, source: 'geoip-pinned' })) {
        this.syncHomeInputs();
        this.toast(`Home pinned to host location: ${this.home.label}`);
        this.goHome();
      }
    } catch (e) {
      this.toast(`Host geolocation failed: ${e.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Geolocate host and save as home'; }
    }
  }

  /** Forget the pin and go back to resolving the host each session. */
  async clearHome() {
    this.home = null;
    this.persist();
    const hud = $('#hud-home');
    if (hud) hud.textContent = '…';
    await this.goHome();
    this.syncHomeInputs();
    this.toast('Home cleared — resolving the host again.');
  }

  /** Show the pinned values in the fields, so editing starts from truth. */
  syncHomeInputs() {
    const h = this.home;
    const name = $('#he-name');
    const lat = $('#he-lat');
    const lon = $('#he-lon');
    if (!lat || !lon) return;
    lat.value = h ? h.lat.toFixed(5) : '';
    lon.value = h ? h.lon.toFixed(5) : '';
    // Only a name the operator chose belongs in the name box; a coordinate
    // label or a geoIP city is a description, not a name, and pre-filling it
    // would turn it into one the moment they pressed save.
    if (name) name.value = h?.source === 'manual' && h.label !== OpenPanopticon.coordLabel(h.lat, h.lon)
      ? h.label : '';
  }

  flyTo({ lat, lon, h = 3000 }) {
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-40), roll: 0 },
      duration: 2.0,
    });
  }

  /* ---------------------------------------------------------------- */
  /* Refresh cycle                                                     */
  /* ---------------------------------------------------------------- */

  /** Camera height above the ellipsoid, in metres. */
  altitude() {
    return this.viewer?.camera?.positionCartographic?.height ?? 0;
  }

  /** Too high for a query to be worth making. */
  tooHigh() { return this.altitude() > this.queryCeilingM; }

  /** Step the ceiling up through the presets, wrapping round. */
  cycleQueryCeiling() {
    const i = QUERY_CEILING_STEPS_M.indexOf(this.queryCeilingM);
    this.queryCeilingM = QUERY_CEILING_STEPS_M[(i + 1) % QUERY_CEILING_STEPS_M.length];
    this.persist();
    this.renderHud();
    // Descending past the new ceiling should not wait for the next camera
    // move to notice.
    if (!this.tooHigh()) this.refreshAll().catch(() => {});
    else this.renderLayerStatus();
    this.toast(`Queries now start below ${Math.round(this.queryCeilingM / 1000)} km.`);
  }

  async refreshAll({ force = false } = {}) {
    const bbox = this.currentBbox();
    if (!bbox) return;
    const ctx = { bbox, onStatus: () => this.renderLayerStatus() };
    const high = this.tooHigh();

    if (high) {
      // "Nothing loaded and there were no errors" is the worst way to learn
      // about a deliberate hold, so say it plainly — once per arrival, not
      // on every settle.
      const sig = `${Math.round(this.altitude() / 1000)}`;
      if (this._heldNotice !== sig) {
        this._heldNotice = sig;
        this.toast(`Holding at ${Number(sig).toLocaleString()} km — nothing is queried above `
          + `${Math.round(this.queryCeilingM / 1000)} km. Zoom in, or click FETCH to raise it.`);
      }
    } else this._heldNotice = null;

    await Promise.all(Object.values(this.layers).map((l) => (
      high && l.viewportBound ? l.holdForAltitude() : l.refresh(ctx, { force })
    )));

    // Scenes are per-view: what covers Atlanta does not cover Rotterdam.
    if (this.basemap?.active && !high) this.basemap.search(ctx).catch(() => {});
    // A Shodan fetch that actually reached the network spent a credit; keep
    // the remaining count honest rather than only reading it at boot.
    if (this.layers.shodan.enabled && !this.layers.shodan.fromCache) {
      this.refreshShodanCredits().catch(() => {});
    }
    this.renderLayerStatus();
  }

  async refreshOne(id, { force = false, isRetry = false } = {}) {
    const layer = this.layers[id];
    if (this.tooHigh() && layer.viewportBound) {
      // Includes the live polls: an aircraft position fetched for half a
      // hemisphere is a round trip for something you cannot pick out anyway.
      await layer.holdForAltitude();
      this.renderLayerStatus();
      return;
    }
    const bbox = this.currentBbox();
    await layer.refresh({
      bbox,
      onStatus: () => this.renderLayerStatus(),
      // How a backoff comes back. It re-enters here rather than replaying the
      // context it failed with, so the retry gets the camera's current
      // position and passes the altitude gate again — an hour-long step can
      // easily outlast the view it was scheduled under.
      retry: () => this.refreshOne(id, { isRetry: true }).catch(() => {}),
    }, { force, isRetry });
    this.renderLayerStatus();
  }

  startTimers() {
    // Aircraft move; everything else is effectively static between pans.
    //
    // The interval tracks the feed's own resolution, which the server
    // reports. Polling faster than that only returns the cached answer, so
    // a fixed interval shorter than the feed's would make every other poll a
    // no-op.
    const schedule = () => {
      clearInterval(this.refreshTimer);
      // The server's figure, which is the feed resolution widened to whatever
      // the remaining credit budget can sustain for the rest of the UTC day.
      const f = this.layers.flights;
      this.livePollSec = f.pollSec || (f.resolutionSec || 10) + 1;
      this.refreshTimer = setInterval(() => {
        if (!this.autoRefresh) return;
        // Nobody is looking. A terminal left open in a background tab was
        // spending the whole day's aircraft budget on frames no one saw.
        if (document.visibilityState === 'hidden') return;
        if (this.layers.flights.enabled) {
          this.refreshOne('flights').then(() => {
            // Compare against the interval actually running, not against what
            // the layer reported last time. The first schedule() happens
            // before any answer has arrived, so it guesses from the feed
            // resolution — and comparing report to report meant that first
            // guess was never reconciled with the server's real figure.
            const want = this.layers.flights.pollSec;
            if (want && want !== this.livePollSec) schedule();
          }).catch(() => {});
        }
        // AIS arrives continuously into the server's table; repoll to see it move.
        if (this.layers.vessels.enabled) this.refreshOne('vessels');
      }, this.livePollSec * 1000);
    };
    schedule();
    this.rescheduleLivePoll = schedule;

    // Render health, in the HUD.
    //
    // Worth its few lines: "the planes aren't moving" has two completely
    // different causes — the feed stopped, or the globe stopped being drawn —
    // and they look identical on screen. A browser suspends
    // requestAnimationFrame for a tab that is hidden, occluded or minimised,
    // which freezes every entity on the globe while the layer panel goes on
    // reporting OK, because the polls are timers and keep running. Without a
    // frame counter there is nothing to tell the two apart from the outside.
    this._frames = 0;
    this._lastFrameAt = performance.now();
    this.viewer.scene.postRender.addEventListener(() => {
      this._frames++;
      this._lastFrameAt = performance.now();
    });
    setInterval(() => {
      const cell = $('#hud-fps');
      if (!cell) return;
      const fps = this._frames;
      this._frames = 0;
      const stalledMs = performance.now() - this._lastFrameAt;
      // Two seconds without a frame is not a slow machine, it is a stopped
      // render loop.
      const stalled = stalledMs > 2000;
      cell.textContent = stalled ? `STALLED ${Math.round(stalledMs / 1000)}s` : `${fps} fps`;
      cell.title = stalled
        ? 'The globe is not being redrawn, so nothing on it can appear to move — '
          + 'the data behind it may still be updating. A browser suspends rendering '
          + 'for a tab that is hidden, occluded or minimised; bringing the window to '
          + 'the front resumes it.'
        : `${fps} frames in the last second.`;
      cell.classList.toggle('stalled', stalled);
    }, 1000);


    // Coming back to the tab should show something current, not whatever was
    // on screen when it was hidden.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !this.autoRefresh) return;
      if (this.tooHigh()) return;
      if (this.layers.flights.enabled) this.refreshOne('flights').catch(() => {});
      if (this.layers.vessels.enabled) this.refreshOne('vessels').catch(() => {});
    });

    // Keep the countdowns honest. Cheap: it does nothing at all unless some
    // layer is actually waiting, and a number that never moves reads as an
    // app that has stopped rather than one that is being patient.
    setInterval(() => {
      if (Object.values(this.layers).some((l) => l.enabled && l.retryAt
        && Date.now() < l.retryAt)) this.renderLayerStatus();
    }, 1000);

    // Regional signals change on the order of minutes, not seconds.
    setInterval(() => { if (this.autoRefresh) this.refreshSignals().catch(() => {}); }, 5 * 60_000);

    // Propagate orbits every frame the clock advances.
    this.viewer.clock.onTick.addEventListener((clock) => {
      this.layers.satellites.tick(clock.currentTime);
    });

    // Debounced refetch after the camera settles.
    this.viewer.camera.moveEnd.addEventListener(() => {
      this.renderHud();
      if (!this.autoRefresh) return;
      clearTimeout(this.moveTimer);
      this.moveTimer = setTimeout(() => this.refreshAll(), 700);
    });

    setInterval(() => this.renderHud(), 1000);
  }

  /* ---------------------------------------------------------------- */
  /* Globe interaction                                                 */
  /* ---------------------------------------------------------------- */

  wireGlobe() {
    const handler = new Cesium.ScreenSpaceEventHandler(this.viewer.canvas);

    handler.setInputAction((click) => {
      const picked = this.viewer.scene.pick(click.position);
      const r = this.selectPicked(picked);
      if (r === null) this.closeDetail();
      // A manual pick gets a full interval on screen before cycling moves on.
      else if (r) this.autoCycle?.restart();
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // Track the cursor's ground position for the HUD.
    handler.setInputAction((move) => {
      const cart = this.viewer.camera.pickEllipsoid(move.endPosition);
      if (!cart) return;
      const c = Cesium.Cartographic.fromCartesian(cart);
      this.cursor = {
        lat: Cesium.Math.toDegrees(c.latitude),
        lon: Cesium.Math.toDegrees(c.longitude),
      };
      $('#hud-cursor').textContent =
        `${fmtLat(this.cursor.lat)}  ${fmtLon(this.cursor.lon)}`;
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
  }

  /**
   * Select whatever a scene.pick() returned: open its detail panel and ring
   * it. Shared by mouse clicks and the auto-cycle, which builds pick-shaped
   * objects of its own. Returns null when there was nothing selectable,
   * false when the layer has no detail view, true when it selected.
   */
  selectPicked(picked) {
    if (!Cesium.defined(picked)) return null;

    // Entity pick (billboards/points in a DataSource) vs. PointPrimitive pick.
    let meta = null;
    if (picked.id && picked.id.properties) {
      const p = picked.id.properties;
      meta = { layer: p.layer?.getValue?.() ?? p.layer, record: p.record?.getValue?.() ?? p.record };
    } else if (picked.id && picked.id.layer) {
      meta = picked.id;
    } else if (picked.primitive?.id?.layer) {
      meta = picked.primitive.id;
    }
    if (!meta?.layer) return null;

    const layer = this.layers[meta.layer];
    if (!layer?.detail) return false;
    this.layers?.webcams?.stopLive();
    const detail = layer.detail(meta.record);
    this.openDetail(detail);
    this.markSelected(layer, meta.record, picked, detail.accent);
    this.showInset(detail.accent, layer, meta.record);

    // Layers that need a second round-trip (flight routes, airframes, live
    // camera views) fill their placeholder once the panel is on screen.
    if (layer.enrich) {
      layer.enrich(meta.record, $('#detail-body'))
        .catch((e) => console.warn('enrich failed', e));
    }
    return true;
  }

  /**
   * Ring the thing that was just picked.
   *
   * Which handle to keep depends on how the layer draws: entity-backed
   * layers are re-looked-up by id every frame so a refresh that rebuilds the
   * entity does not orphan the ring, while the collection-backed ones hand
   * back a PointPrimitive whose position is written in place as it moves.
   * The record's own coordinates are the fallback for anything static.
   */
  markSelected(layer, record, picked, accent) {
    const entityId = picked?.id?.id;
    const isEntity = entityId != null
      && !!layer.source?.entities?.getById?.(entityId);
    // Clamp the ring exactly as the pin itself is clamped, read off the
    // picked graphic rather than guessed from the layer id.
    const t = this.viewer.clock.currentTime;
    const gfx = picked?.id?.billboard || picked?.id?.point || picked?.id?.label;
    const href = gfx?.heightReference?.getValue?.(t);
    const clampToGround = href === Cesium.HeightReference.CLAMP_TO_GROUND;

    this.selection?.select({
      layer,
      entityId: isEntity ? entityId : null,
      primitive: !isEntity && picked?.primitive?.position ? picked.primitive : null,
      lat: Number(record?.lat),
      lon: Number(record?.lon),
      height: Number(record?.altitude) || 0,
      clampToGround,
    }, accent);
  }

  openDetail(d) {
    const p = $('#detail');
    p.style.setProperty('--accent', d.accent || '#39ff88');
    $('#detail-kind').textContent = d.kind;
    $('#detail-title').textContent = d.title;
    $('#detail-body').innerHTML = d.html;
    p.classList.add('open');
  }

  /**
   * Close-up map at the top of the detail panel, for every pick.
   *
   * Shown at every altitude, so the same pick always gets the same panel,
   * and because the inset's street labels and aerial view add detail the
   * globe lacks even close in.
   * It reads the selection ring's position, so it follows a moving contact.
   */
  showInset(accent, layer, record) {
    this.inset?.destroy();
    this.inset = null;
    // A layer can say where the map goes with a data-slot="inset" (below a
    // photo or camera view, say); otherwise it leads the panel.
    const body = $('#detail-body');
    let host = body.querySelector('[data-slot="inset"]');
    if (!host) {
      host = document.createElement('div');
      body.prepend(host);
    }
    host.classList.add('detail-inset');
    const locate = () => {
      const p = this.selection?.position();
      if (!p) return null;
      const c = Cesium.Cartographic.fromCartesian(p);
      if (!c) return null;
      return {
        lat: Cesium.Math.toDegrees(c.latitude),
        lon: Cesium.Math.toDegrees(c.longitude),
        height: c.height,
      };
    };
    // Layers that know which way something faces (ALPR cameras) hand the
    // map wedges to draw around the pin.
    let cones = [];
    try { cones = layer?.insetCones?.(record) || []; } catch { cones = []; }
    this.inset = new LocationInset(host, locate, {
      accent,
      cones,
      onActivate: (lat, lon) => this.flyToPoint(lat, lon),
    });
  }

  /** Fly down to look straight at a point, keeping it centred on screen. */
  flyToPoint(lat, lon, range = 3000) {
    this.viewer.camera.flyToBoundingSphere(
      new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat, 0), 50),
      {
        offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-50), range),
        duration: 2.0,
      },
    );
  }

  closeDetail() {
    $('#detail').classList.remove('open');
    this.inset?.destroy();
    this.inset = null;
    this.selection?.clear();
    this.layers?.flights?.clearRoute();
    this.layers?.webcams?.stopLive();
  }

  /* ---------------------------------------------------------------- */
  /* UI construction                                                   */
  /* ---------------------------------------------------------------- */

  buildUI() {
    this.buildOpticsBar();
    this.buildLayerPanel();
    this.buildTargets();
    this.buildSearch();
    this.trackChromeSizes();
    this.buildSidebarToggle();
    this.buildWeatherBar();
    this.buildImageryBar();
    this.buildLabelsBar();
    this.buildLabelsToggle();
    this.buildBasemapMenu();

    $('#detail-close').onclick = () => this.closeDetail();
    this.buildDetailResize();
    this.buildCycleControl();
    $('#hud-gate').onclick = () => this.cycleQueryCeiling();
    $('#auto-toggle').onclick = (e) => {
      this.autoRefresh = !this.autoRefresh;
      e.currentTarget.classList.toggle('active', this.autoRefresh);
      e.currentTarget.querySelector('span').textContent = this.autoRefresh ? 'AUTO' : 'HOLD';
      this.persist();
    };
    // With a 24h retention policy, a refresh that honoured the cache would
    // do nothing visible. SYNC is the manual override.
    $('#refresh-now').onclick = () => {
      if (this.tooHigh()) {
        this.toast(`Nothing to refresh: holding above `
          + `${Math.round(this.queryCeilingM / 1000)} km. Zoom in, or click FETCH to raise it.`);
        return;
      }
      this.weather.forced = true;
      this.refreshAll({ force: true }).finally(() => { this.weather.forced = false; });
      this.toast('Refreshing from source…');
    };
    $('#reset-settings').onclick = () => {
      // From here until the reload nothing may save again — not a pending
      // debounce, and not the beforeunload handler, which would otherwise
      // write back exactly what was just cleared.
      this.resetting = true;
      clearTimeout(this._persistTimer);
      Settings.clear();
      this.toast('Saved settings cleared — reloading with defaults.');
      setTimeout(() => location.reload(), 700);
    };

    $('#flush-cache').onclick = async () => {
      let dropped = 0;
      for (const l of Object.values(this.layers)) {
        dropped += l.cached || 0;
        l.clearCache?.();
      }
      // The server now keeps results for hours, and on disk. Clearing only
      // the browser's copy would refetch straight back out of that.
      let server = null;
      try { server = await api('/api/flush', null, { method: 'POST' }); } catch { /* local flush still counts */ }
      this.toast(`Cache flushed — ${dropped.toLocaleString()} features dropped`
        + (server ? `, ${server.diskEntries} stored responses cleared.` : '.'));
      this.refreshAll({ force: true });
    };

    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      // Derived from the mode table rather than hard-coded, so adding or
      // removing an optic never leaves a shortcut pointing at nothing.
      const modeKeys = Object.keys(OPTICAL_MODES);
      const idx = Number(e.key) - 1;
      if (Number.isInteger(idx) && idx >= 0 && idx < modeKeys.length) this.setMode(modeKeys[idx]);
      if (e.key === 'r') $('#refresh-now').click();
      if (e.key === 'c') $('#cycle-toggle').click();
      if (e.key === 'Escape') this.closeDetail();
      if (e.key === 'h') document.body.classList.toggle('chrome-hidden');
      if (e.key === '[') {
        this.setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
        this.persist();
      }
    });
  }

  /**
   * Drag the detail panel's left edge to widen it. The width lives in a CSS
   * variable so the panel and its handle move together, and is kept in
   * localStorage as a per-browser preference.
   */
  buildDetailResize() {
    const KEY = 'openpanopticon.detailWidth';
    const root = document.documentElement;
    const handle = $('#detail-resize');
    const clamp = (w) => Math.round(Math.max(320, Math.min(w, 960, window.innerWidth * 0.85)));
    const set = (w) => root.style.setProperty('--detail-w', `${clamp(w)}px`);

    try {
      const saved = Number(localStorage.getItem(KEY));
      if (saved) set(saved);
    } catch { /* storage blocked: the default stands */ }

    const save = () => {
      try {
        localStorage.setItem(KEY, String(Math.round($('#detail').getBoundingClientRect().width)));
      } catch { /* not fatal */ }
    };

    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      document.body.classList.add('resizing-detail');
      const move = (ev) => set(window.innerWidth - ev.clientX);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.body.classList.remove('resizing-detail');
        save();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    handle.addEventListener('dblclick', () => {
      root.style.removeProperty('--detail-w');
      try { localStorage.removeItem(KEY); } catch { /* not fatal */ }
    });
  }

  /** CYCLE button plus its 15 / 30 / 60 s interval menu. */
  buildCycleControl() {
    $('#cycle-toggle').onclick = () => {
      this.autoCycle.toggle();
      if (this.autoCycle.on && this.autoCycle.empty) {
        this.toast('Nothing selectable in view yet — enable a layer or zoom in; cycling will keep trying.');
      }
      this.persist();
    };
    document.querySelectorAll('.cycle-step').forEach((b) => {
      b.onclick = () => {
        this.autoCycle.setIntervalS(Number(b.dataset.s));
        this.persist();
      };
    });

    // One checkbox per layer that can open a detail panel.
    const list = $('#cycle-types');
    for (const [id, layer] of Object.entries(this.layers)) {
      if (typeof layer.detail !== 'function') continue;
      const row = el('label', 'cycle-type');
      row.dataset.layer = id;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = this.autoCycle.includes(id);
      cb.onchange = () => { this.autoCycle.setIncluded(id, cb.checked); this.persist(); };
      row.append(cb, el('span', null, layer.label || id), el('em', null, 'layer off'));
      list.appendChild(row);
    }
    const setAll = (on) => {
      for (const id of Object.keys(this.layers)) this.autoCycle.setIncluded(id, on);
      this.persist();
    };
    $('#cycle-all').onclick = () => setAll(true);
    $('#cycle-none').onclick = () => setAll(false);
    // Layer switches happen elsewhere; refresh the greyed-out state on open.
    $('#cycle-wrap').addEventListener('mouseenter', () => this.renderCycle());
    $('#cycle-wrap').addEventListener('focusin', () => this.renderCycle());
    this.renderCycle();
  }

  renderCycle() {
    const c = this.autoCycle;
    const btn = $('#cycle-toggle');
    if (!btn || !c) return;
    btn.classList.toggle('active', c.on);
    btn.querySelector('span').textContent = 'CYCLE';
    const n = $('#cycle-count');
    if (n) n.textContent = c.on ? (c.empty ? '—' : `${c.remaining()}s`) : `${c.intervalS}s`;
    btn.title = c.on
      ? `Auto-selecting a random item in view every ${c.intervalS}s — click to stop`
      : `Auto-select a random item in view every ${c.intervalS}s (hover for interval)`;
    document.querySelectorAll('.cycle-step').forEach((b) =>
      b.classList.toggle('active', Number(b.dataset.s) === c.intervalS));
    document.querySelectorAll('.cycle-type').forEach((row) => {
      const id = row.dataset.layer;
      row.querySelector('input').checked = c.includes(id);
      row.classList.toggle('layer-off', !this.layers[id]?.enabled);
    });
  }

  buildOpticsBar() {
    const bar = $('#optics');
    for (const [key, spec] of Object.entries(OPTICAL_MODES)) {
      const b = el('button', 'optic', spec.label);
      b.dataset.mode = key;
      b.title = spec.caption;
      b.onclick = () => this.setMode(key);
      bar.appendChild(b);
    }
    this.setMode('eo');
  }

  setMode(mode) {
    this.mode = mode;
    this.persist();
    this.optics.set(mode);
    document.querySelectorAll('.optic').forEach((b) =>
      b.classList.toggle('active', b.dataset.mode === mode));
    const spec = OPTICAL_MODES[mode];
    document.documentElement.style.setProperty('--hud', spec.hud);
    $('#hud-mode').textContent = spec.label;
    // The caption no longer has a slot in the top bar; it survives as the
    // optic button's tooltip. Kept optional so either layout works.
    const cap = $('#hud-caption');
    if (cap) cap.textContent = spec.caption;
    document.body.dataset.mode = mode;
  }

  buildLayerPanel() {
    const panel = $('#layers');

    const mk = (id, title, extra) => {
      const box = el('div', 'layer');
      box.dataset.layer = id;
      const head = el('div', 'layer-head');
      const sw = el('button', 'switch');
      sw.setAttribute('aria-label', `toggle ${title}`);
      const name = el('div', 'layer-name', title);
      const cnt = el('div', 'layer-count', '—');
      head.append(sw, name, cnt);
      box.append(head);
      if (extra) box.append(extra);
      panel.append(box);

      const lockMsg = this.locked[id];
      if (lockMsg) {
        box.classList.add('unavailable', 'locked');
        sw.disabled = true;
        sw.title = lockMsg;
        name.title = lockMsg;
        cnt.textContent = this.lockedTag?.[id] || 'NO KEY';
        cnt.title = lockMsg;
        // The layer body only shows when a layer is on, so the reason needs
        // a line of its own under the name.
        box.insertBefore(el('p', 'note layer-lock', lockMsg), head.nextSibling);
      }

      sw.onclick = () => {
        if (this.locked[id]) return;
        const on = !this.layers[id].enabled;
        this.layers[id].setEnabled(on);
        box.classList.toggle('on', on);
        if (on) {
          // Shodan's credit count is otherwise read only at boot and after a
          // full refresh, so switching it on mid-session would show none.
          Promise.resolve(this.refreshOne(id)).then(() => {
            if (id === 'shodan') return this.refreshShodanCredits();
          }).catch(() => {});
        } else this.renderLayerStatus();
        this.persist();
      };
      return box;
    };

    /* --- Shodan --------------------------------------------------- */
    // No type filter and no query box by request: the layer always returns
    // everything Shodan has indexed in view, and the colour mode is how you
    // read it.
    const shodanCtl = el('div', 'layer-body');

    const colorSel = el('select', 'ctl');
    for (const [v, t] of [['category', 'Colour: service type'], ['risk', 'Colour: known CVEs']]) {
      const o = el('option', null, t); o.value = v; colorSel.append(o);
    }
    const legend = el('div', 'legend');
    const note = el('p', 'note', '');
    shodanCtl.append(colorSel, legend, note);

    const renderLegend = () => {
      const l = this.layers.shodan;
      legend.innerHTML = '';
      if (l.colorBy === 'category') {
        for (const { cat, n, color } of l.categoryLegend()) {
          const chip = el('span', 'legend-item');
          const dot = el('span', 'legend-dot');
          dot.style.background = color;
          chip.append(dot, el('span', null, `${cat} ${n}`));
          legend.append(chip);
        }
      } else {
        for (const [label, color, n] of [
          ['known CVEs', '#ff2d55', l.vulnerable],
          ['no known CVEs', '#00e5ff', Math.max(0, l.count - l.vulnerable)],
        ]) {
          const chip = el('span', 'legend-item');
          const dot = el('span', 'legend-dot');
          dot.style.background = color;
          chip.append(dot, el('span', null, `${label} ${n}`));
          legend.append(chip);
        }
      }
      note.textContent = l.total > l.count
        ? `${l.total.toLocaleString()} total matches in view; the first page is drawn.`
        : 'Every host Shodan has indexed in this view.';
    };
    this.renderShodanLegend = renderLegend;

    colorSel.onchange = () => {
      this.layers.shodan.colorBy = colorSel.value;
      this.layers.shodan.redraw();
      this.renderLayerStatus();
      this.persist();
    };
    this.restoreShodanUI = () => { colorSel.value = this.layers.shodan.colorBy; };

    const sBox = mk('shodan', 'Shodan exposure', shodanCtl);
    if (this.health.sources.shodan !== 'configured') {
      sBox.classList.add('unavailable');
      note.textContent = 'Set SHODAN_API_KEY in .env, then restart the server.';
    }

    /* --- Aircraft ------------------------------------------------- */
    const airCtl = el('div', 'layer-body');
    airCtl.append(
      checkbox('Callsign labels', this.layers.flights.showLabels, (v) => {
        this.layers.flights.showLabels = v;
        this.layers.flights.source.entities.values.forEach((e) => { if (e.label) e.label.show = v; });
        this.persist();
      }),
      checkbox('Motion trails', this.layers.flights.showTrails, (v) => {
        this.layers.flights.showTrails = v;
        this.layers.flights.source.entities.values.forEach((e) => { if (e.polyline) e.polyline.show = v; });
        this.persist();
      }),
      el('p', 'note', this.health.sources.opensky === 'authenticated'
        ? 'OpenSky authenticated — 5s resolution, 4,000 credits/day.'
        : 'OpenSky anonymous — 10s resolution, 400 credits/day. Add OPENSKY_CLIENT_ID/SECRET to raise it.'),
    );
    mk('flights', 'Live aircraft', airCtl);

    /* --- Satellites ----------------------------------------------- */
    const satCtl = el('div', 'layer-body');
    const groupSel = el('select', 'ctl');
    for (const [k, v] of Object.entries(this.health.presets.satellites)) {
      const o = el('option', null, v); o.value = k; groupSel.appendChild(o);
    }
    groupSel.value = this.layers.satellites.group;
    const limitWrap = el('label', 'slider');
    const limitIn = el('input');
    limitIn.type = 'range'; limitIn.min = '25'; limitIn.max = '1200'; limitIn.step = '25';
    limitIn.value = String(this.layers.satellites.limit);
    const limitVal = el('span', null, String(this.layers.satellites.limit));
    limitWrap.append(el('span', null, 'Max objects'), limitIn, limitVal);
    satCtl.append(groupSel, limitWrap,
      el('p', 'note', 'SGP4-propagated from CelesTrak elements. Click one for its ground track.'));

    groupSel.onchange = () => {
      this.layers.satellites.group = groupSel.value;
      if (this.layers.satellites.enabled) this.refreshOne('satellites');
      this.persist();
    };
    limitIn.oninput = () => { limitVal.textContent = limitIn.value; };
    limitIn.onchange = () => {
      this.layers.satellites.limit = +limitIn.value;
      if (this.layers.satellites.enabled) this.refreshOne('satellites');
      this.persist();
    };
    mk('satellites', 'Orbital assets', satCtl);

    /* --- Overpass ------------------------------------------------- */
    const opCtl = el('div', 'layer-body');
    const chips = el('div', 'chips');
    for (const [k, v] of Object.entries(this.health.presets.overpass)) {
      const c = el('button', 'chip', v.label);
      c.style.setProperty('--chip', v.color);
      c.classList.toggle('on', this.layers.overpass.presets.has(k));
      c.onclick = () => {
        const set = this.layers.overpass.presets;
        set.has(k) ? set.delete(k) : set.add(k);
        c.classList.toggle('on', set.has(k));
        if (this.layers.overpass.enabled) this.refreshOne('overpass');
        this.persist();
      };
      chips.append(c);
    }
    const opNote = el('p', 'note',
      'One Overpass query covers every selected class. Overpass is a donated '
      + 'service with a small per-IP quota, so requests are queued and spaced.');
    opCtl.append(chips, opNote);
    mk('overpass', 'OSM infrastructure', opCtl);
    this.overpassNote = opNote;

    /* --- ALPR / Flock --------------------------------------------- */
    const alprCtl = el('div', 'layer-body');
    const alprChips = el('div', 'chips');
    for (const v of this.health.presets.alprVendors) {
      const c = el('button', 'chip', v.label);
      c.style.setProperty('--chip', v.color);
      c.classList.toggle('on', this.layers.alpr.vendorFilter.has(v.key));
      c.onclick = () => {
        const set = this.layers.alpr.vendorFilter;
        set.has(v.key) ? set.delete(v.key) : set.add(v.key);
        c.classList.toggle('on', set.has(v.key));
        this.layers.alpr.redraw();
        this.renderLayerStatus();
        this.persist();
      };
      alprChips.append(c);
    }
    const alprStats = el('div', 'srclist');
    const alprNote = el('p', 'note',
      'Crowdsourced by DeFlock and stored in OpenStreetMap. Cones show each '
      + 'camera’s tagged facing. No chip selected means every vendor.');
    alprCtl.append(alprChips,
      checkbox('Field-of-view cones', this.layers.alpr.showCones, (v) => {
        this.layers.alpr.showCones = v;
        this.layers.alpr.redraw();
        this.renderLayerStatus();
      }),
      checkbox('Only cameras with a known facing', this.layers.alpr.onlyWithDirection, (v) => {
        this.layers.alpr.onlyWithDirection = v;
        this.layers.alpr.redraw();
        this.renderLayerStatus();
      }),
      alprStats, alprNote);
    mk('alpr', 'ALPR / Flock', alprCtl);
    this.alprStats = alprStats;

    /* --- Situational awareness ------------------------------------ */
    const evCtl = el('div', 'layer-body');
    const evChips = el('div', 'chips');
    for (const [k, v] of Object.entries(this.health.presets.events)) {
      if (!v.available) this.layers.events.sources.delete(k);
      const c = el('button', 'chip', v.label);
      c.style.setProperty('--chip', v.color);
      c.title = v.note + (v.available ? '' : ' — not configured');
      if (!v.available) { c.classList.add('disabled'); c.disabled = true; }
      c.classList.toggle('on', this.layers.events.sources.has(k) && v.available);
      c.onclick = () => {
        const set = this.layers.events.sources;
        set.has(k) ? set.delete(k) : set.add(k);
        c.classList.toggle('on', set.has(k));
        if (this.layers.events.enabled) this.refreshOne('events');
        this.persist();
      };
      evChips.append(c);
    }

    const sevWrap = el('label', 'slider');
    const sevSel = el('select', 'ctl');
    for (const [v, t] of [['info', 'Everything'], ['green', 'Green and above'],
      ['orange', 'Orange and above'], ['red', 'Red only']]) {
      const o = el('option', null, t); o.value = v; sevSel.append(o);
    }
    sevSel.onchange = () => {
      this.layers.events.minSeverity = sevSel.value;
      if (this.layers.events.enabled) this.refreshOne('events');
      this.persist();
    };
    sevSel.value = this.layers.events.minSeverity;
    sevWrap.append(el('span', null, 'Severity'), sevSel);

    const evNote = el('p', 'note',
      'Disaster and hazard feeds for the current view. Red-level events pulse on the globe.');
    evCtl.append(evChips, sevWrap,
      checkbox('Affected-area polygons', this.layers.events.showPolygons, (v) => {
        this.layers.events.showPolygons = v;
        this.layers.events.redraw();
        this.renderLayerStatus();
      }),
      evNote);
    mk('events', 'Situational awareness', evCtl);
    this.eventNote = evNote;

    /* --- Vessels -------------------------------------------------- */
    const vesCtl = el('div', 'layer-body');
    const vesStatus = el('p', 'note', '');
    vesCtl.append(
      checkbox('Vessel names', this.layers.vessels.showNames, (v) => {
        this.layers.vessels.showNames = v;
        this.layers.vessels.source.entities.values.forEach((e) => { if (e.label) e.label.show = v; });
      }),
      checkbox('Moving only (hide moored)', this.layers.vessels.movingOnly, (v) => {
        this.layers.vessels.movingOnly = v;
        if (this.layers.vessels.enabled) this.refreshOne('vessels');
      }),
      vesStatus);
    const vBox = mk('vessels', 'Vessels (AIS)', vesCtl);
    if (!String(this.health.sources.ais || '').startsWith('configured')) {
      vBox.classList.add('unavailable');
      vesStatus.textContent = 'Set AISSTREAM_API_KEY in .env (free at aisstream.io), then restart.';
    }
    this.vesselStatus = vesStatus;

    /* --- Network infrastructure ----------------------------------- */
    const netCtl = el('div', 'layer-body');
    const netChips = el('div', 'chips');
    for (const [k, v] of Object.entries(this.health.presets.netinfra)) {
      if (!v.available) this.layers.netinfra.sources.delete(k);
      const c = el('button', 'chip', v.label);
      c.style.setProperty('--chip', v.color);
      c.title = v.note + (v.available ? '' : ' — not configured');
      if (!v.available) { c.classList.add('disabled'); c.disabled = true; }
      c.classList.toggle('on', this.layers.netinfra.sources.has(k) && v.available);
      c.onclick = () => {
        const set = this.layers.netinfra.sources;
        set.has(k) ? set.delete(k) : set.add(k);
        c.classList.toggle('on', set.has(k));
        if (this.layers.netinfra.enabled) this.refreshOne('netinfra');
        this.persist();
      };
      netChips.append(c);
    }
    netCtl.append(netChips,
      checkbox('Draw estimated cell ranges', this.layers.netinfra.showRanges, (v) => {
        this.layers.netinfra.showRanges = v;
        this.layers.netinfra.redraw();
        this.renderLayerStatus();
      }),
      el('p', 'note', 'Tor is plotted at country centroids — Onionoo no longer '
        + 'publishes per-relay coordinates.'));
    mk('netinfra', 'Network infrastructure', netCtl);

    /* --- IoT sensors ---------------------------------------------- */
    const iotCtl = el('div', 'layer-body');
    const iotColor = el('select', 'ctl');
    for (const [v, t] of [['air', 'Colour: air quality'], ['noise', 'Colour: noise level'],
      ['model', 'Colour: uniform']]) {
      const o = el('option', null, t); o.value = v; iotColor.append(o);
    }
    iotColor.value = this.layers.iot.colorBy;
    iotColor.onchange = () => {
      this.layers.iot.colorBy = iotColor.value;
      this.layers.iot.redraw();
      this.renderLayerStatus();
      this.persist();
    };
    const iotStats = el('div', 'srclist');
    iotCtl.append(iotColor,
      checkbox('Include indoor sensors', this.layers.iot.includeIndoor, (v) => {
        this.layers.iot.includeIndoor = v;
        this.layers.iot.redraw();
        this.renderLayerStatus();
      }),
      iotStats,
      el('p', 'note', 'Sensor.Community citizen hardware — air quality and noise. '
        + 'Dense across Europe, sparse elsewhere.'));
    mk('iot', 'IoT sensors', iotCtl);
    this.iotStats = iotStats;

    /* --- Traffic -------------------------------------------------- */
    const trfCtl = el('div', 'layer-body');
    const trfNote = el('p', 'note', '');
    trfCtl.append(
      checkbox('Cameras', this.layers.traffic.showCameras, (v) => {
        this.layers.traffic.showCameras = v;
        this.layers.traffic.redraw();
        this.renderLayerStatus();
      }),
      checkbox('Incidents and closures', this.layers.traffic.showIncidents, (v) => {
        this.layers.traffic.showIncidents = v;
        this.layers.traffic.redraw();
        this.renderLayerStatus();
      }),
      trfNote);
    const tBox = mk('traffic', 'Traffic (511)', trfCtl);
    if (String(this.health.sources.fiveEleven || '').startsWith('no states')) {
      tBox.classList.add('unavailable');
      trfNote.textContent = 'Add FIVE_ELEVEN_KEYS to .env as "GA:key,NY:key". '
        + `Known states: ${this.health.presets.fiveElevenHosts.join(', ')}`;
    }
    this.trafficNote = trfNote;

    /* --- Webcams -------------------------------------------------- */
    const camCtl = el('div', 'layer-body');
    const camSources = [
      ['NYC DOT traffic cams', true],
      ['ALERTCalifornia wildfire cams', true],
      ['Windy Webcams', this.health.sources.windy === 'configured'],
      ['OpenWebcamDB', this.health.sources.openwebcamdb === 'configured'],
    ];
    const camList = el('div', 'srclist');
    for (const [name, on] of camSources) {
      const r = el('div', `srcrow${on ? ' on' : ''}`);
      r.append(el('span', 'dot'), el('span', null, name),
        el('em', null, on ? 'live' : 'no key'));
      camList.append(r);
    }
    camCtl.append(camList, el('p', 'note',
      'Cameras their operators publish for public viewing. Add WINDY_API_KEY and '
      + 'OPENWEBCAMDB_API_KEY in .env to widen coverage.'));
    mk('webcams', 'Public cameras', camCtl);
  }

  buildWeatherBar() {
    const w = this.weather;
    const bar = $('#weather');
    const radarBtn = $('#wx-radar');
    const satBtn = $('#wx-sat');
    const playBtn = $('#wx-play');
    const stamp = $('#wx-time');
    const slider = $('#wx-frame');

    w.onUpdate = () => {
      bar.classList.toggle('open', w.radarOn);
      this.syncChrome?.();
      radarBtn.classList.toggle('active', w.radarOn);
      satBtn.classList.toggle('active', w.satOn);
      playBtn.textContent = w.animating ? '❚❚' : '▶';
      const frames = w.frames;
      slider.max = String(Math.max(0, frames.length - 1));
      const idx = w.frameIndex < 0 ? frames.length - 1 : w.frameIndex;
      slider.value = String(Math.max(0, idx));
      const f = w.currentFrame();
      stamp.textContent = f
        ? new Date(f.time * 1000).toISOString().slice(11, 16) + 'Z' + (f.nowcast ? ' · forecast' : '')
        : 'no frames';
    };

    radarBtn.onclick = async () => {
      radarBtn.classList.add('busy');
      try { await w.setRadar(!w.radarOn); this.labels.bringToFront(); this.persist(); }
      catch (e) { this.toast(`Weather radar: ${e.message}`); }
      finally { radarBtn.classList.remove('busy'); }
    };
    satBtn.onclick = async () => {
      satBtn.classList.add('busy');
      try {
        await w.setSatellite(!w.satOn);
        this.labels.bringToFront();
        if (w.satOn && !w.cloudsAvailable) {
          this.toast('No cloud imagery source is reachable right now.');
          await w.setSatellite(false);
        } else if (w.satOn && w.cloudLabel) {
          satBtn.title = `Cloud imagery — ${w.cloudLabel}`;
        }
        this.persist();
      } catch (e) { this.toast(`Cloud imagery: ${e.message}`); }
      finally { satBtn.classList.remove('busy'); }
    };
    playBtn.onclick = () => w.toggleAnimation();
    slider.oninput = () => w.setFrame(Number(slider.value));

    // RainViewer publishes a new radar frame every ~10 minutes.
    setInterval(() => { if (w.radarOn || w.satOn) w.refresh().catch(() => {}); }, 5 * 60_000);
  }

  buildImageryBar() {
    const im = this.imagery;
    const bar = $('#imagery');
    const btn = $('#wx-imagery');
    const sel = $('#im-layer');
    const dateIn = $('#im-date');
    const alpha = $('#im-alpha');

    im.onUpdate = () => {
      bar.classList.toggle('open', im.on);
      this.syncChrome?.();
      btn.classList.toggle('active', im.on);
      if (sel.options.length !== im.layers.length) {
        sel.innerHTML = '';
        for (const l of im.layers) {
          const o = el('option', null, l.label); o.value = l.key; sel.append(o);
        }
      }
      sel.value = im.selected;
      alpha.value = String(Math.round(im.alpha * 100));
      dateIn.value = im.date || '';
      dateIn.max = new Date().toISOString().slice(0, 10);
    };

    btn.onclick = async () => {
      btn.classList.add('busy');
      try { await im.set(!im.on); this.labels.bringToFront(); this.persist(); }
      catch (e) { this.toast(`Imagery: ${e.message}`); }
      finally { btn.classList.remove('busy'); }
    };
    sel.onchange = () => { im.setLayer(sel.value).catch((e) => this.toast(e.message)); this.persist(); };
    dateIn.onchange = () => { im.setDate(dateIn.value).catch((e) => this.toast(e.message)); this.persist(); };
    alpha.oninput = () => { im.setAlpha(Number(alpha.value) / 100); this.persist(); };
    $('#im-prev').onclick = () => im.shiftDate(-1).catch(() => {});
    $('#im-next').onclick = () => im.shiftDate(1).catch(() => {});
  }

  /** Region-scale telemetry that has no sensible point geometry. */
  /** Remaining Shodan credits, for the tooltip and the low-credit warning. */
  async refreshShodanCredits() {
    try {
      const d = await api('/api/shodan/credits');
      this.shodanCredits = Number(d?.query_credits);
      if (Number.isFinite(this.shodanCredits) && this.shodanCredits <= 25) {
        this.toast(`Shodan: ${this.shodanCredits} query credits left.`);
      }
    } catch { /* informational only */ }
    this.renderLayerStatus();
  }

  async refreshSignals() {
    const panel = $('#signals-body');
    if (!panel) return;
    let d;
    try {
      // Regional signals are view-scoped too, so they wait for the descent
      // like everything else.
      if (this.tooHigh()) { panel.innerHTML = ''; return; }
      d = await api('/api/signals', { bbox: this.currentBbox() || undefined });
    } catch (e) {
      panel.innerHTML = '<p class="note"></p>';
      panel.firstChild.textContent = `Signals unavailable: ${e.message}`;
      return;
    }
    this.signals = d;
    panel.innerHTML = '';

    if (d.outages?.length) {
      panel.append(el('h3', 'sig-head', 'Internet outages (24h)'));
      const list = el('div', 'siglist');
      for (const o of d.outages.slice(0, 6)) {
        const row = el('button', 'sigrow');
        row.append(
          el('span', 'sig-name', o.name),
          el('span', 'sig-val', `${o.events} event${o.events > 1 ? 's' : ''}`),
        );
        if (o.lat != null) {
          row.title = 'Fly to country';
          row.onclick = () => this.flyTo({ lat: o.lat, lon: o.lon, h: 2_500_000 });
        } else row.classList.add('static');
        list.append(row);
      }
      panel.append(list);
    }

    if (d.grid?.length) {
      panel.append(el('h3', 'sig-head', 'US grid demand'));
      const list = el('div', 'siglist');
      for (const g of d.grid.slice(0, 5)) {
        const row = el('div', 'sigrow static');
        row.append(el('span', 'sig-name', g.name),
          el('span', 'sig-val', `${Math.round(g.demandMW).toLocaleString()} MW`));
        list.append(row);
      }
      panel.append(list);
    } else if (!d.configured.eia) {
      panel.append(el('p', 'note', 'Add EIA_API_KEY for live US grid demand.'));
    }

    if (d.cloudflare?.length) {
      panel.append(el('h3', 'sig-head', 'Cloudflare Radar outages'));
      const list = el('div', 'siglist');
      for (const c of d.cloudflare.slice(0, 5)) {
        const row = el('div', 'sigrow static');
        row.append(el('span', 'sig-name', (c.locations || []).join(', ') || c.scope || 'outage'),
          el('span', 'sig-val', c.eventType || ''));
        list.append(row);
      }
      panel.append(list);
    }

    if (d.seismographs?.length) {
      panel.append(el('h3', 'sig-head', 'Seismographs in view'));
      panel.append(el('p', 'note',
        `${d.seismographs.length} Raspberry Shake station${d.seismographs.length > 1 ? 's' : ''} `
        + 'reporting in this area.'));
    }

    const probs = Object.entries(d.problems || {}).filter(([, v]) => v);
    if (probs.length) {
      panel.append(el('p', 'note', probs.map(([k, v]) => `${k}: ${v}`).join(' · ')));
    }
    if (!panel.children.length) {
      panel.append(el('p', 'note', 'No regional signals to report right now.'));
    }
  }

  /**
   * Keep --topbar-h / --wxbar-h in step with reality. The header wraps to two
   * or three rows at narrow widths, and anything pinned under it at a fixed
   * offset ends up hidden behind it — which is exactly what happened to the
   * radar and imagery control bars.
   */
  trackChromeSizes() {
    const root = document.documentElement;
    const topbar = $('#topbar');
    const wxbar = $('#weather');
    const hud = $('#hud');

    const sync = () => {
      root.style.setProperty('--topbar-h', `${Math.round(topbar.getBoundingClientRect().height)}px`);
      root.style.setProperty('--hud-h', `${Math.round(hud.getBoundingClientRect().height)}px`);
      // Only offset the imagery bar when the radar bar is actually showing.
      const wxOpen = wxbar.classList.contains('open');
      root.style.setProperty('--wxbar-h',
        wxOpen ? `${Math.round(wxbar.getBoundingClientRect().height)}px` : '0px');
      const imbar = $('#imagery');
      const imOpen = imbar.classList.contains('open');
      root.style.setProperty('--imbar-h',
        imOpen ? `${Math.round(imbar.getBoundingClientRect().height)}px` : '0px');
    };

    sync();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(sync);
      ro.observe(topbar);
      ro.observe(hud);
      ro.observe(wxbar);
      ro.observe($('#imagery'));
    }
    window.addEventListener('resize', sync);
    // Opening or closing the radar bar changes the imagery bar's offset.
    this.syncChrome = sync;
  }

  /** Re-apply everything that isn't plain layer state. */
  async restoreSession() {
    const s = this.saved;
    if (!s) { this.labels.set(true); $('#wx-labels').classList.add('active'); return; }

    if (s.mode && OPTICAL_MODES[s.mode]) this.setMode(s.mode);
    if (QUERY_CEILING_STEPS_M.includes(s.queryCeilingM)) this.queryCeilingM = s.queryCeilingM;

    if (s.autoRefresh === false) {
      this.autoRefresh = false;
      const b = $('#auto-toggle');
      b.classList.remove('active');
      b.querySelector('span').textContent = 'HOLD';
    }
    if (s.sidebarCollapsed) this.setSidebarCollapsed(true);
    if (CYCLE_STEPS_S.includes(s.cycle?.intervalS)) this.autoCycle.setIntervalS(s.cycle.intervalS);
    for (const id of s.cycle?.excluded || []) {
      if (this.layers[id]) this.autoCycle.setIncluded(id, false);
    }

    // Restoring a satellite base map needs a scene search, so it happens
    // after the camera has been placed rather than here.
    if (s.basemap?.provider && s.basemap.provider !== 'osm') {
      this.pendingBasemap = s.basemap.provider;
    }

    // Controls whose value lives in the DOM need pushing back too.
    this.restoreShodanUI?.();
    this.restoreControls?.();

    const o = s.overlays || {};
    // Labels default on — road names are the point — unless explicitly off.
    this.labels.set(o.labels !== false);
    $('#wx-labels').classList.toggle('active', this.labels.on);

    const tryOverlay = async (fn, label) => {
      try { await fn(); } catch (e) { this.toast(`${label}: ${e.message}`); }
    };
    if (o.radar) await tryOverlay(() => this.weather.setRadar(true), 'Radar');
    if (o.clouds) await tryOverlay(() => this.weather.setSatellite(true), 'Cloud imagery');
    if (o.imagery) await tryOverlay(() => this.imagery.set(true), 'Imagery');
    this.labels.bringToFront();
  }

  setSidebarCollapsed(on) {
    document.body.classList.toggle('sidebar-collapsed', on);
    const btn = $('#sidebar-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', String(!on));
      btn.title = on ? 'Show the sensor panel' : 'Collapse the sensor panel';
    }
    // The globe's usable width changed, so let Cesium re-measure.
    setTimeout(() => this.viewer?.resize?.(), 320);
  }

  buildSidebarToggle() {
    const btn = $('#sidebar-toggle');
    btn.onclick = () => {
      this.setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
      this.persist();
    };
  }

  buildLabelsBar() {
    const lb = this.labels;
    const bar = $('#labelbar');
    const styleSel = $('#lb-style');
    const contrast = $('#lb-contrast');
    const boost = $('#lb-boost');

    lb.onUpdate = () => {
      // `available`, not `open`: CSS decides when to show it, on hover or
      // keyboard focus. This only says whether there is anything to show.
      bar.classList.toggle('available', lb.on);
      styleSel.value = lb.style;
      contrast.value = String(Math.round(lb.contrast * 100));
      boost.checked = lb.boost;
      this.syncChrome?.();
    };

    styleSel.onchange = () => { lb.setStyle(styleSel.value); this.persist(); };
    contrast.oninput = () => lb.setContrast(Number(contrast.value) / 100);
    contrast.onchange = () => this.persist();
    boost.onchange = () => { lb.setBoost(boost.checked); this.persist(); };
  }

  buildBasemapMenu() {
    const sel = $('#bm-provider');
    const from = $('#bm-from');
    const to = $('#bm-to');
    const cloud = $('#bm-cloud');
    const cloudVal = $('#bm-cloud-val');
    const scene = $('#bm-scene');
    const note = $('#bm-note');
    const btn = $('#wx-basemap');
    const bm = this.basemap;

    for (const p of this.health?.presets?.basemaps || []) {
      const o = el('option', null, p.label + (p.available ? '' : ' — not configured'));
      o.value = p.key;
      o.disabled = !p.available;
      o.title = p.note;
      sel.append(o);
    }
    sel.value = bm.provider;

    const win = bm.defaultWindow();
    from.value = bm.from || win.from;
    to.value = bm.to || win.to;
    // Sentinel-2 started in 2015; nothing exists before that, and a future
    // date can only ever return nothing.
    from.min = to.min = '2015-06-23';
    from.max = to.max = win.to;
    cloud.value = String(bm.maxCloud);
    cloudVal.textContent = `${bm.maxCloud}%`;

    bm.onUpdate = () => {
      const satellite = bm.provider !== 'osm';
      btn.classList.toggle('active', satellite);
      // Dates and cloud cover only mean something for the scene searches.
      $('#bm-window').style.display = bm.active ? '' : 'none';
      $('#bm-scene-row').style.display = bm.provider === 'sentinel2' ? '' : 'none';

      scene.innerHTML = '';
      for (const sc of bm.scenes) {
        const o = el('option', null,
          `${sc.date}  ·  ${sc.cloud}% cloud${sc.id === bm.meta?.clearest ? '  ★' : ''}`);
        o.value = sc.id;
        scene.append(o);
      }
      if (bm.sceneId) scene.value = bm.sceneId;

      note.classList.toggle('bad', bm.status === 'error' || bm.status === 'empty');
      if (bm.status === 'loading') note.textContent = 'Searching for imagery over this view…';
      else if (bm.error) note.textContent = bm.error;
      else if (satellite && bm.meta?.matched != null) {
        note.textContent = `${bm.meta.returned} of ${bm.meta.matched} scenes in `
          + `${bm.from} – ${bm.to}. ${bm.meta.attribution}.`;
      } else if (satellite && bm.meta?.provider === bm.provider) {
        note.textContent = [bm.meta.note, bm.meta.attribution].filter(Boolean).join(' ');
      } else {
        note.textContent = 'Street map. Switch to Sentinel-2 for recent satellite imagery.';
      }
      this.renderLayerStatus();
    };

    const ctx = () => ({ bbox: this.currentBbox() });

    // Clicking the button is a quick toggle between the street map and the
    // last satellite source used; the menu is for choosing precisely.
    btn.onclick = async () => {
      const last = this.basemapAvailable(this.lastSatSource) ? this.lastSatSource : null;
      // Sentinel-2 by default, else the first imagery source that is available.
      const firstSat = ['sentinel2', ...(this.health?.presets?.basemaps || []).map((b) => b.key)]
        .find((k) => k !== 'osm' && this.basemapAvailable(k) && k !== bm.builtinKey) || 'sentinel2';
      const next = bm.provider === 'osm' ? (last || firstSat) : 'osm';
      if (next !== 'osm') this.lastSatSource = next;
      sel.value = next;
      await bm.setProvider(next, ctx());
      this.persist();
    };

    sel.onchange = async () => {
      if (sel.value !== 'osm') this.lastSatSource = sel.value;
      await bm.setProvider(sel.value, ctx());
      this.persist();
    };
    const reWindow = async () => {
      await bm.setWindow({ from: from.value, to: to.value, maxCloud: Number(cloud.value) }, ctx());
      this.persist();
    };
    from.onchange = reWindow;
    to.onchange = reWindow;
    cloud.oninput = () => { cloudVal.textContent = `${cloud.value}%`; };
    cloud.onchange = reWindow;
    scene.onchange = () => { bm.selectScene(scene.value, ctx()); this.persist(); };
    $('#bm-clearest').onclick = () => {
      if (bm.meta?.clearest) { bm.selectScene(bm.meta.clearest, ctx()); this.persist(); }
    };

    bm.onUpdate();
  }

  buildLabelsToggle() {
    const btn = $('#wx-labels');
    if (!this.labels.available) {
      btn.disabled = true;
      btn.classList.add('nokey');
      btn.classList.remove('active');
      btn.title = 'Place and road labels need CARTO_API_KEY in .env '
        + '(free at carto.com/basemaps/apikey) — add it and restart the server.';
      return;
    }
    btn.onclick = () => {
      this.labels.set(!this.labels.on);
      btn.classList.toggle('active', this.labels.on);
      if (this.labels.on) this.labels.bringToFront();
      this.persist();
    };
    // restoreSession() decides the initial state, so nothing is forced here.
  }

  toast(msg) {
    const bar = $('#alerts');
    const t = el('div', 'alert', msg);
    bar.append(t);
    setTimeout(() => t.remove(), 6000);
  }

  buildTargets() {
    const wrap = $('#targets');
    const home = el('button', 'target home', '⌂ Home');
    home.title = 'Fly to home';
    home.onclick = () => this.goHome();
    wrap.append(home);

    const edit = el('button', 'target home-edit', '⋯');
    edit.title = 'Set home';
    edit.setAttribute('aria-expanded', 'false');
    edit.setAttribute('aria-controls', 'home-editor');
    edit.onclick = () => {
      const panel = $('#home-editor');
      const open = panel.hidden;
      panel.hidden = !open;
      edit.classList.toggle('active', open);
      edit.setAttribute('aria-expanded', String(open));
      if (open) this.syncHomeInputs();
    };
    wrap.append(edit);

    for (const t of TARGETS) {
      const b = el('button', 'target', t.name);
      b.onclick = () => this.flyTo(t);
      wrap.append(b);
    }
    this.buildHomeEditor();
  }

  buildHomeEditor() {
    $('#he-geolocate').onclick = () => this.geolocateHost();
    $('#he-here').onclick = () => this.setHomeFromView();
    $('#he-clear').onclick = () => this.clearHome();

    const save = () => {
      const ok = this.setHome({
        lat: $('#he-lat').value,
        lon: $('#he-lon').value,
        // Keep the height already pinned, so correcting a typo in the
        // coordinates does not silently reset how far out home sits.
        h: this.home?.h,
        label: $('#he-name').value,
        source: 'manual',
      });
      if (ok) { this.syncHomeInputs(); this.toast(`Home set: ${this.home.label}`); this.goHome(); }
    };
    $('#he-save').onclick = save;
    for (const id of ['#he-lat', '#he-lon', '#he-name']) {
      $(id).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } };
    }
  }

  buildSearch() {
    const input = $('#search');
    const results = $('#search-results');
    let timer;

    const run = async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; results.classList.remove('open'); return; }
      try {
        const { results: hits } = await api('/api/geocode', { q });
        results.innerHTML = '';
        for (const h of hits) {
          const b = el('button', 'hit');
          b.append(el('strong', null, h.short), el('small', null, h.name));
          b.onclick = () => {
            results.classList.remove('open');
            input.value = h.short;
            const span = h.bbox ? Math.max(h.bbox[2] - h.bbox[0], h.bbox[3] - h.bbox[1]) : 0.05;
            this.flyTo({ lat: h.lat, lon: h.lon, h: Math.max(1200, span * 160000) });
          };
          results.append(b);
        }
        results.classList.toggle('open', hits.length > 0);
      } catch (e) {
        results.innerHTML = '';
        results.append(el('div', 'hit err', e.message));
        results.classList.add('open');
      }
    };

    input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 380); };
    input.onblur = () => setTimeout(() => results.classList.remove('open'), 180);
  }

  /* ---------------------------------------------------------------- */
  /* HUD                                                               */
  /* ---------------------------------------------------------------- */

  renderLayerStatus() {
    for (const [id, layer] of Object.entries(this.layers)) {
      const box = document.querySelector(`.layer[data-layer="${id}"]`);
      if (!box) continue;
      const cnt = box.querySelector('.layer-count');
      if (this.locked?.[id]) { box.classList.remove('on'); cnt.textContent = this.lockedTag?.[id] || 'NO KEY'; continue; }
      box.classList.toggle('on', layer.enabled);
      box.classList.toggle('loading', layer.status === 'loading');
      box.classList.toggle('failed', layer.status === 'error');
      box.classList.toggle('held', layer.status === 'held');
      if (!layer.enabled) { cnt.textContent = '—'; cnt.title = ''; }
      else if (layer.status === 'held') {
        // Say why nothing is happening. A layer that is simply quiet looks
        // identical to one that is broken.
        cnt.textContent = '↓';
        cnt.title = `Holding above ${Math.round(this.queryCeilingM / 1000)} km — `
          + `currently ${Math.round(this.altitude() / 1000).toLocaleString()} km. `
          + 'Descend to query. Anything already found stays drawn.';
      }
      else if (layer.status === 'loading') cnt.textContent = '···';
      else if (layer.status === 'error') {
        // A scheduled retry is a different state from a dead one, and an
        // hourly one is different again — a layer backing off looks exactly
        // like a layer nobody is coming back to unless it says otherwise.
        const secs = layer.retryAt ? Math.max(0, Math.ceil((layer.retryAt - Date.now()) / 1000)) : 0;
        cnt.textContent = secs ? shortWait(secs) : 'ERR';
        const bits = [layer.error];
        if (secs) {
          bits.push(`Retrying in ${longWait(secs)}`
            + (layer.failures > 1 ? ` (attempt ${layer.failures + 1})` : ''));
          if (layer.retryInSec >= 3600) {
            bits.push('Backed off to hourly after repeated failures. '
              + 'SYNC retries immediately.');
          }
        }
        cnt.title = bits.join('\n');
        box.classList.toggle('waiting', secs > 0);
      }
      else {
        cnt.textContent = layer.count.toLocaleString();
        box.classList.toggle('cached', !!layer.fromCache);
        if (layer.accumulate) {
          const bits = [`${layer.count.toLocaleString()} drawn`];
          if (layer.cached > layer.count) bits.push(`${layer.cached.toLocaleString()} cached`);
          if (layer.skipped) bits.push(`${layer.skipped} fetch${layer.skipped > 1 ? 'es' : ''} saved by cache`);
          if (layer.fromCache) bits.push('this view served from cache');
          cnt.title = bits.join('\n');
        }
        box.classList.remove('waiting');
        // Checked first: under HOLD a live feed's count is true but not
        // current, and saying how old it is matters more than anything else.
        if (!this.autoRefresh && (id === 'flights' || id === 'vessels')) {
          // The count is still true, but it is not *current*, and for a live
          // feed that distinction is the whole point. Show how old it is.
          const anchor = id === 'flights'
            ? [...(layer.dr?.values() || [])].map((a) => a.atMs).sort().pop()
            : layer.lastFetchAt;
          const ageS = anchor ? Math.round((Date.now() - anchor) / 1000) : null;
          cnt.textContent = ageS == null ? 'PAUSED' : `${shortWait(ageS)} old`;
          cnt.title = `${layer.count.toLocaleString()} contacts, last fetched `
            + `${ageS == null ? 'at load' : `${longWait(ageS)} ago`}.\n`
            + 'Auto-refresh is off (AUTO reads HOLD), so this will not update. '
            + 'Press AUTO to resume, or SYNC once.';
          box.classList.add('waiting');
        } else if (id === 'flights') {
          // A map that quietly polls more slowly looks like a map that has
          // stopped working, so the budget is part of the readout.
          const bits = [`${layer.count.toLocaleString()} contacts`];
          bits.push(`feed updates every ${layer.resolutionSec}s`);
          if (layer.dropped) {
            bits.push(`${layer.dropped} dropped — not heard from in over 2 min, `
              + 'so their last position is stale rather than live');
          }
          if (layer.pollSec) bits.push(`Polling every ${layer.pollSec}s`);
          if (layer.credits != null) {
            bits.push(`${layer.credits.toLocaleString()} OpenSky credits left today`
              + (layer.creditFloor ? ` (${layer.creditFloor} held in reserve)` : ''));
          }
          if (layer.pollSec && layer.resolutionSec && layer.pollSec > layer.resolutionSec + 1) {
            bits.push('Slowed to spread the remaining credits over the rest of the '
              + 'UTC day — SYNC still forces an update.');
          }
          cnt.title = bits.join('\n');
        } else if (id === 'satellites' && layer.elementsAt) {
          const age = Date.now() - Date.parse(layer.elementsAt);
          const mins = Number.isFinite(age) ? Math.round(age / 60_000) : null;
          cnt.title = `${layer.count.toLocaleString()} tracked · ${layer.groupLabel || ''}`
            + (layer.stale
              ? `\nElements from the local copy saved ${mins != null ? `${mins} min ago` : 'earlier'}`
                + ' — CelesTrak regenerates a group every 2 hours and declines'
                + ' a download in between, which means these are still current.'
              : '\nElements fetched fresh from CelesTrak.');
        } else if (id === 'shodan') {
          const bits = [layer.total > layer.count
            ? `${layer.total.toLocaleString()} total matches; first page shown`
            : `${layer.count.toLocaleString()} hosts`];
          if (layer.cellDeg) {
            bits.push(`One query covers a ${layer.cellDeg}° cell (~${
              Math.round(layer.cellDeg * 111)}km) and serves every zoom inside it`);
          }
          if (this.shodanCredits != null) {
            bits.push(`${this.shodanCredits.toLocaleString()} query credits left`);
          }
          cnt.title = bits.join('\n');
        } else if (layer.bySource) {
          // Break the count down per upstream, and name any that failed.
          const parts = Object.entries(layer.bySource).map(([s, n]) => `${s}: ${n}`);
          for (const [s, err] of Object.entries(layer.problems || {})) parts.push(`${s}: ${err}`);
          cnt.title = parts.join('\n');
        } else cnt.title = '';
      }
    }

    this.renderShodanLegend?.();

    if (this.overpassNote) {
      const o = this.layers.overpass;
      if (o.enabled && o.status === 'ok' && o.count) {
        const parts = Object.entries(o.byPreset)
          .filter(([, n]) => n > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => `${o.labels[k] || k}: ${n}`);
        // Two different ways an answer can be partial, and they need
        // different advice: `truncated` means more features matched than the
        // cap returns, `trimmed` means the view was wider than Overpass can
        // answer at all and only its middle was queried. Neither is allowed
        // to pass as a complete count.
        this.overpassNote.textContent = parts.join(' · ')
          + (o.truncated ? ' — result cap reached, zoom in for the rest.' : '')
          + (o.trimmed ? ' — view too wide to query in full; this covers the centre.' : '');
      } else if (o.enabled && o.status === 'ok') {
        this.overpassNote.textContent = o.trimmed
          ? 'View too wide to query — nothing of the selected classes near the centre.'
          : 'Nothing of the selected classes is mapped in this view.';
      }
    }

    // AIS is a stream, not a request — say what the socket is actually doing
    // rather than letting an empty map look like a failure.
    if (this.vesselStatus && this.layers.vessels.enabled) {
      const s = this.layers.vessels.stream || {};
      const v = this.layers.vessels;
      this.vesselStatus.textContent = s.status === 'open'
        ? (s.warmingUp
          ? 'Stream connected — waiting for the first reports in this area…'
          : `Stream live · ${v.tracked.toLocaleString()} vessels tracked · `
            + `${(s.messages || 0).toLocaleString()} messages`)
        : s.status === 'connecting' ? 'Connecting to AIS stream…'
        : s.error ? `Stream ${s.status}: ${s.error}`
        : `Stream ${s.status || 'idle'}`;
    }

    if (this.iotStats) {
      const l = this.layers.iot;
      this.iotStats.innerHTML = '';
      if (l.enabled && l.status === 'ok' && l.count) {
        const add = (n, v) => {
          const r = el('div', 'srcrow on');
          r.append(el('span', 'dot'), el('span', null, n), el('em', null, String(v)));
          this.iotStats.append(r);
        };
        add('reporting air quality', l.withAir);
        add('reporting noise', l.withNoise);
        for (const [m, n] of Object.entries(l.byModel).sort((a, b) => b[1] - a[1]).slice(0, 3)) {
          add(m, n);
        }
      }
    }

    if (this.trafficNote && this.layers.traffic.enabled) {
      const t = this.layers.traffic;
      if (t.hint) this.trafficNote.textContent = t.hint;
      else if (t.status === 'ok') {
        const parts = Object.entries(t.byState)
          .map(([s, v]) => `${s}: ${v.cameras} cams, ${v.incidents} incidents`);
        this.trafficNote.textContent = parts.join(' · ') || 'No features in view.';
      }
    }

    // ALPR: who operates the cameras in view is often the interesting part,
    // so surface the operator breakdown when OSM has it tagged.
    if (this.alprStats) {
      const a = this.layers.alpr;
      this.alprStats.innerHTML = '';
      if (a.enabled && a.status === 'ok') {
        const add = (name, val, on = true) => {
          const r = el('div', `srcrow${on ? ' on' : ''}`);
          r.append(el('span', 'dot'), el('span', null, name), el('em', null, String(val)));
          this.alprStats.append(r);
        };
        add('with known facing', `${a.withDirection}/${a.count}`);
        const ops = Object.entries(a.byOperator);
        if (ops.length) {
          for (const [name, n] of ops.slice(0, 4)) add(name, n);
        } else if (a.count) {
          add('no operator tagged', a.count, false);
        }
      }
    }

    // NWS publishes most alerts against forecast zones rather than polygons;
    // say so rather than letting the count look wrong.
    if (this.eventNote) {
      const z = this.layers.events.zoneOnly;
      this.eventNote.textContent = z
        ? `Red-level events pulse on the globe. ${z} NWS alert${z > 1 ? 's' : ''} reference `
          + 'forecast zones with no polygon, so they are not drawn.'
        : 'Disaster and hazard feeds for the current view. Red-level events pulse on the globe.';
    }

    const total = Object.values(this.layers)
      .filter((l) => l.enabled && l.status === 'ok')
      .reduce((n, l) => n + l.count, 0);
    $('#hud-tracks').textContent = total.toLocaleString();

    // Layer errors are redrawn from state each time; toasts share the bar but
    // manage their own lifetime, so only the error rows are replaced.
    const errs = Object.values(this.layers).filter((l) => l.status === 'error');
    const bar = $('#alerts');
    bar.querySelectorAll('.alert.layer-err').forEach((n) => n.remove());
    const first = bar.firstChild;
    for (const l of errs) {
      bar.insertBefore(el('div', 'alert layer-err', `${l.label}: ${l.error}`), first);
    }
  }

  renderHud() {
    const cam = this.viewer.camera;
    const c = cam.positionCartographic;
    $('#hud-eye').textContent =
      `${fmtLat(Cesium.Math.toDegrees(c.latitude))}  ${fmtLon(Cesium.Math.toDegrees(c.longitude))}`;
    const gate = $('#hud-gate');
    if (gate) {
      const high = this.tooHigh();
      const km = Math.round(this.queryCeilingM / 1000);
      // Auto-refresh being off is also a reason nothing is being fetched, so
      // it is shown here too. A cell claiming the terminal is querying when
      // it is not is worse than no cell at all.
      gate.textContent = !this.autoRefresh ? 'PAUSED'
        : high ? `HOLD ▲${km}km` : `ON <${km}km`;
      gate.classList.toggle('holding', high || !this.autoRefresh);
      gate.title = !this.autoRefresh
        ? 'Auto-refresh is off (the AUTO button reads HOLD), so nothing is being '
          + 'fetched — live aircraft and vessels included. Press AUTO to resume, '
          + 'or SYNC for a single update.'
        : high
          ? `Holding: nothing is queried above ${km} km, and you are at `
            + `${Math.round(this.altitude() / 1000).toLocaleString()} km. `
            + 'Descend, or click to raise the ceiling.'
          : `Querying. Nothing is fetched above ${km} km — click to change.`;
    }
    $('#hud-alt').textContent = c.height > 10000
      ? `${(c.height / 1000).toFixed(1)} km`
      : `${Math.round(c.height).toLocaleString()} m`;
    $('#hud-hdg').textContent = `${Math.round(Cesium.Math.toDegrees(cam.heading))
      .toString().padStart(3, '0')}°`;
    $('#hud-time').textContent = new Date().toISOString().slice(11, 19) + 'Z';
  }
}

/* -------------------------------------------------------------------- */

function checkbox(label, initial, onChange) {
  const l = el('label', 'check');
  const i = el('input');
  i.type = 'checkbox'; i.checked = initial;
  i.onchange = () => onChange(i.checked);
  l.append(i, el('span', null, label));
  return l;
}

const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
/**
 * Parse a coordinate typed into a field.
 *
 * Not Number(): `Number('')` and `Number(null)` are both 0, so an empty
 * longitude box would read as a real, valid meridian. Clearing a field and
 * pressing save would pin home to the Gulf of Guinea with no complaint.
 */
const coordNum = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  return t === '' ? NaN : Number(t);
};

const wrapLon = (v) => {
  let x = ((v + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
};

/** A countdown short enough for the layer's count cell. */
const shortWait = (s) => (s >= 3600 ? `${Math.ceil(s / 3600)}h`
  : s >= 90 ? `${Math.ceil(s / 60)}m` : `${s}s`);

/** The same wait, spelled out for the tooltip. */
const longWait = (s) => {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min${s % 60 ? ` ${s % 60}s` : ''}`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
};

const fmtLat = (v) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(4)}°${v >= 0 ? 'E' : 'W'}`;

window.addEventListener('beforeunload', () => {
  // The debounce could still be pending when the tab closes.
  if (window.WV?.layers && !window.WV.restoring && !window.WV.resetting) {
    try { Settings.save(Settings.collect(window.WV)); } catch { /* storage blocked */ }
  }
});

window.addEventListener('DOMContentLoaded', () => {
  window.WV = new OpenPanopticon();
  window.WV.boot().catch((e) => console.error(e));
});

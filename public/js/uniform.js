// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
//
// One detail level for the whole view, chosen at the centre of the screen.
//
// Cesium World Imagery is a mosaic: each zoom level can come from a
// different survey, with its own date, colour and exposure. Cesium picks
// the level per tile from that tile's distance, so a tilted view pulls fine
// levels near the camera and coarse ones towards the horizon, and the map
// becomes a patchwork of surveys with hard seams between them.
//
// The whole view is always drawn from one pinned level, so from one survey,
// in two tiers split at a camera height of 20 km:
//  - Below it, high detail: never coarser than the level that suits the
//    view straight down from 20 km (the "floor"), finer at the centre when
//    lower still.
//  - Above it, low detail: never finer than the level just under the floor,
//    coarser at the centre when higher. Left to itself Cesium would pull the
//    fine survey in close to the camera and the coarse one further out, the
//    patchwork this exists to prevent, so the low tier is pinned as well.
// Crossing 20 km switches the whole screen at once. Near the camera the
// picture is a little softer than Cesium would have chosen, which is the
// price of a picture that agrees with itself.
//
// How:
//  - A stand-in provider made with Object.create() over the real World
//    Imagery provider, so tiles, credits and errors are all the real
//    provider's. Only minimumLevel and maximumLevel are its own: min = max
//    pins the level. It covers the whole globe, so panning never rebuilds it
//    and ground already loaded stays loaded; only a change of level does.
//  - What bounds the cost is the far field: a far-off ground tile is a
//    coarse one, and pinning it to a fine level would mean hundreds of
//    imagery tiles for one patch near the horizon. So the layer is not drawn
//    on ground tiles more than FAR_LEVELS coarser than its own level
//    (minimumTerrainLevel). In practice that is only far towards the
//    horizon of a tilted view, which is drawn dark.
//  - Its layer sits directly above the aerial base layer, which is hidden
//    once the pinned tiles have arrived, so the view never flashes empty.
//  - On a change of level the new layer loads invisibly on top of the old
//    one, which stays on screen until the new one has arrived and then goes.
//  - If the centre of the screen is sky, there is no point to choose a
//    level from, and Cesium's own layer is shown as normal.

const R = 6378137;            // WGS84 equatorial radius, m
const TILE_PX = 256;          // Bing / World Imagery tile width
const FAR_LEVELS = 2;         // drawn on ground tiles at most this much coarser (16 tiles each)
const DARK = '#06090d';       // ground beyond the pinned far field
const SWITCH_M = 20000;       // below this camera height the whole view goes high detail
const HYSTERESIS_M = 500;     // so hovering at the line does not flicker
// Above this, World Imagery's coarse levels are one global mosaic with no
// seams to hide, so pinning buys nothing and Cesium's own layer is used.
// Pinning up there also cost a black screen: the whole disc is on coarse
// ground tiles, which a finer pinned layer will not draw on, and with the
// base hidden nothing at all drew until every tile had loaded.
export const RELEASE_ABOVE_M = 250_000;
const RELEASE_HYSTERESIS_M = 10_000;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Tiles at `level` that a rectangle spans in a tiling scheme. */
export function tileCount(ts, r, level) {
  const a = ts.positionToTileXY(Cesium.Cartographic.fromRadians(r.west, r.north), level);
  const b = ts.positionToTileXY(Cesium.Cartographic.fromRadians(r.east, r.south), level);
  if (!a || !b) return Infinity;
  return (Math.abs(b.x - a.x) + 1) * (Math.abs(b.y - a.y) + 1);
}

/**
 * The level whose texels are about `mpp` metres on the ground, at a latitude,
 * for 256 px Web Mercator tiles.
 */
export function levelFor(mpp, latitude) {
  const ground = 2 * Math.PI * R * Math.max(0.05, Math.cos(latitude));
  return Math.round(Math.log2(ground / (TILE_PX * Math.max(mpp, 1e-3))));
}

export class UniformDetail {
  /**
   * @param viewer  Cesium viewer
   * @param getBase returns the ImageryLayer currently drawing aerial imagery
   *                as the base map, or null when the base map is not aerial
   */
  constructor(viewer, getBase) {
    this.viewer = viewer;
    this.getBase = getBase;
    this.enabled = true;
    this.source = null;        // the real World Imagery provider
    this.loading = null;
    this.layer = null;         // current pinned layer
    this.level = null;
    this.stale = [];           // superseded pinned layers, dropped once loaded
    this.hidden = null;        // the base layer we hid
    this.baseColor = null;     // the globe colour before we darkened it
    this.flushTimer = null;
    this.onUpdate = null;
    this.onLayer = null;       // the visible pinned layer changed (or went)

    const cam = viewer.camera;
    // While the camera moves, only cover ground that comes into view; the
    // level itself is settled when it stops, so a flight does not swap
    // levels over and over on the way.
    cam.moveEnd.addEventListener(() => this.update());
    cam.changed.addEventListener(() => this.update({ moving: true }));
    // Loading settled: finish any swap, and catch a view that settled before
    // there was ground to choose a level from.
    viewer.scene.globe.tileLoadProgressEvent.addEventListener((n) => {
      if (n !== 0) return;
      this.flush();
      this.update();
    });
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (this.enabled) this.update({ force: true }); else this.release();
    this.onUpdate?.();
  }

  /** Whether the view is currently pinned to one level. */
  get active() { return !!this.layer; }

  async ensureSource() {
    if (this.source) return this.source;
    this.loading ||= Cesium.createWorldImageryAsync()
      .then((p) => { this.source = p; return p; })
      .catch((e) => { console.warn('World Imagery unavailable for uniform detail', e); this.loading = null; return null; });
    return this.loading;
  }

  async update({ force = false, moving = false } = {}) {
    const base = this.enabled ? this.getBase() : null;
    if (!base || this.tooHigh()) { this.release(); return; }
    const src = this.source || await this.ensureSource();
    // The basemap may have changed while the provider was loading.
    if (!src || !this.enabled || this.getBase() !== base) return;

    const plan = this.plan(src, this.low() ? 'high' : 'low');
    if (!plan) { this.release(); return; }
    // The tier switch happens straight away, even mid-move: crossing the
    // line is the one change that should be seen as it happens.
    const sameTier = plan.tier === this.tier;
    // The layer covers the globe, so only a new level needs a new layer.
    if (!force && sameTier && this.layer && (moving || plan.level === this.level)) return;
    // Moving into new ground within a tier: keep the current level until the
    // camera stops, so a flight does not swap levels on the way.
    if (moving && sameTier && this.level != null) {
      const kept = Math.min(plan.level, this.level);
      plan.level = plan.tier === 'high' ? Math.max(plan.floor, kept) : Math.min(plan.floor - 1, kept);
    }
    this.build(src, plan, base);
  }

  /** Whether the camera is high enough that Cesium's own layer is better. */
  tooHigh() {
    const h = this.viewer.camera.positionCartographic.height;
    return h > RELEASE_ABOVE_M + (this.layer ? RELEASE_HYSTERESIS_M : -RELEASE_HYSTERESIS_M);
  }

  /** Whether the camera is in the high-detail tier (below 20 km). */
  low() {
    const h = this.viewer.camera.positionCartographic.height;
    // Leaving a tier takes going half a kilometre past the line.
    return h < SWITCH_M + (this.tier === 'high' ? HYSTERESIS_M : -HYSTERESIS_M);
  }

  /** Choose the level from the screen centre, and the area to cover. */
  plan(src, tier) {
    const { scene, camera: cam } = this.viewer;
    const canvas = scene.canvas;
    // Before the canvas has a size (boot, a hidden tab) there are no pixels
    // to choose a level from.
    if (scene.drawingBufferHeight < 50 || !canvas.clientWidth) return null;
    const ray = cam.getPickRay(new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2));
    const centre = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    // The terrain under the centre, or the ellipsoid while no terrain has
    // loaded yet; only sky gives nothing.
    const hit = (ray && scene.globe.pick(ray, scene)) || cam.pickEllipsoid(centre, scene.globe.ellipsoid);
    if (!hit) return null;

    const d = Cesium.Cartesian3.distance(cam.positionWC, hit);
    const c = Cesium.Cartographic.fromCartesian(hit);
    const fovy = cam.frustum.fovy ?? Math.PI / 3;
    const mpp = (d * 2 * Math.tan(fovy / 2)) / Math.max(1, scene.drawingBufferHeight);
    const maxLevel = src.maximumLevel ?? 19;
    // The high-detail floor: what the view straight down from 20 km needs.
    const mppAtSwitch = (SWITCH_M * 2 * Math.tan(fovy / 2)) / Math.max(1, scene.drawingBufferHeight);
    const floor = clamp(levelFor(mppAtSwitch, c.latitude), 2, maxLevel);
    // Hold the current level until the view is clearly into the next one, so
    // a pan along a level boundary does not swap back and forth.
    const exact = Math.log2((2 * Math.PI * R * Math.max(0.05, Math.cos(c.latitude))) / (TILE_PX * Math.max(mpp, 1e-3)));
    const want = this.layer && tier === this.tier && Math.abs(exact - this.level) < 0.8
      ? this.level
      : levelFor(mpp, c.latitude);
    let level = tier === 'high'
      ? clamp(Math.max(want, floor), 1, maxLevel)
      : clamp(Math.min(want, floor - 1), 1, floor - 1);

    return { tier, level, floor };
  }

  build(src, plan, base) {
    const pinned = Object.create(src);
    Object.defineProperties(pinned, {
      minimumLevel: { get: () => plan.level },
      maximumLevel: { get: () => plan.level },
    });
    const minTerrain = Math.max(0, plan.level - FAR_LEVELS);
    const layer = new Cesium.ImageryLayer(pinned, { minimumTerrainLevel: minTerrain });
    layer._opMinTerrain = minTerrain;
    layer._opBase = true;      // the night shade goes above this
    // Loaded invisibly and revealed by flush(), so tiles still arriving are
    // never drawn. What it replaces (the previous level, or Cesium's own
    // layer the first time) stays on screen until then.
    layer.alpha = 0;
    const layers = this.viewer.imageryLayers;
    const below = this.layer && layers.contains(this.layer) ? this.layer : base;
    layers.add(layer, layers.indexOf(below) + 1);
    if (this.layer) this.stale.push(this.layer);
    // What is on screen may not cover the new view: a finer pinned layer
    // does not draw on the coarser ground tiles of a view zoomed out, and
    // the base is hidden. Show the base again while the new level loads, so
    // the ground fills in progressively instead of staying dark until every
    // tile has arrived. flush() hides it again once the new level is in.
    this.unhide();

    this.layer = layer;
    this.level = plan.level;
    this.tier = plan.tier;
    this.builtAt = performance.now();
    clearTimeout(this.flushTimer);
    // Normally the load-progress event finishes the swap; this is the
    // backstop, and it waits for loading too, so the base is never hidden
    // before the pinned tiles are there to replace it (up to 30 s).
    const backstop = (n) => {
      if (this.viewer.scene.globe.tilesLoaded || n >= 6) this.flush();
      else this.flushTimer = setTimeout(() => backstop(n + 1), 5000);
    };
    this.flushTimer = setTimeout(() => backstop(1), 5000);
    this.onUpdate?.();
  }

  /** Once the new level has loaded: drop what it replaced and hide the base. */
  flush() {
    if (!this.layer) return;
    // A load-progress "0" straight after adding the layer predates its
    // tiles being queued at all.
    if (performance.now() - (this.builtAt || 0) < 500) return;
    const revealed = this.layer.alpha !== 1;
    this.layer.alpha = 1;
    this.viewer.scene.requestRender();
    if (revealed) this.onLayer?.();
    const layers = this.viewer.imageryLayers;
    for (const l of this.stale) if (layers.contains(l)) layers.remove(l, true);
    this.stale = [];
    const base = this.getBase();
    if (base && base !== this.layer && base.show) {
      base.show = false;
      this.hidden = base;
      const globe = this.viewer.scene.globe;
      if (!this.baseColor) this.baseColor = Cesium.Color.clone(globe.baseColor);
      globe.baseColor = Cesium.Color.fromCssColorString(DARK);
    }
  }

  /** Back to Cesium's own layer. */
  release() {
    clearTimeout(this.flushTimer);
    const layers = this.viewer.imageryLayers;
    for (const l of [...this.stale, this.layer]) if (l && layers.contains(l)) layers.remove(l, true);
    this.stale = [];
    const had = !!this.layer;
    this.layer = null;
    this.level = null;
    this.tier = null;
    // Re-show the base only if it is still the base. If the operator has
    // switched to another map, the basemap code has already settled what
    // shows, and the old aerial layer must stay hidden under it.
    this.unhide();
    if (had) { this.onUpdate?.(); this.onLayer?.(); }
  }

  /** Show Cesium's own aerial layer again, if it is still the base map. */
  unhide() {
    if (this.hidden && this.hidden === this.getBase()) this.hidden.show = true;
    this.hidden = null;
    if (this.baseColor) {
      this.viewer.scene.globe.baseColor = this.baseColor;
      this.baseColor = null;
    }
  }
}

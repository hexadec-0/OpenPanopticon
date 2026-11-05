// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
//
// Day/night shading: the half of the globe the sun has set on is drawn in
// darkness, following the real terminator as the clock runs.
//
// How: a single black tile laid over the whole globe as an imagery layer
// with dayAlpha 0 and nightAlpha = darkness. Cesium blends between the two
// per pixel from the sun's direction (scene clock, so it tracks real time),
// which gives a soft twilight band at the terminator for free.
//
// Two of Cesium's defaults have to change while it is on:
//  - nightFade{Out,In}Distance switch the night blend off below ~10,000 km
//    of camera altitude, i.e. at every height this terminal actually works
//    at. Pinned near zero so the night side is dark close in too.
//  - Native globe lighting (enableLighting) also darkens the night side, but
//    only from space, and to a fixed depth. Pushed out of reach so the
//    darkness comes from one place and the slider means what it says.
// Both are put back exactly when the shading is switched off.
//
// It sits just above the base map, so radar, cloud, imagery overlays and
// place labels stay readable on top of it.
//
// City lights, on the night side only, scaled by the "City lights" slider:
//  - Structures: the aerial imagery itself, turned into light. Built
//    surfaces photograph as pale and grey (roofs, concrete, car parks,
//    lit streets), vegetation and farmland as dark or coloured, so each
//    aerial tile is re-drawn as warm light where it is bright and
//    unsaturated, softened into a glow, and laid over the darkness. It
//    follows the real street pattern at any zoom. Strongest close in.
//  - Regions: NASA's Black Marble (VIIRS night lights), for the glow of
//    whole cities from high up, where single structures are too small to
//    see. Fades out on the way down, where the structure glow takes over.
//  - 3D buildings: a shader that lights a random share of the windows on
//    their walls warm yellow, and dims what the sun no longer reaches.

const RAD = Math.PI / 180;

// NASA GIBS Black Marble 2016, VIIRS night lights, 500 m.
const BLACK_MARBLE = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_Black_Marble/'
  + 'default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png';

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * How much of the Black Marble glow shows at a camera height, 0..1.
 * At 500 m a pixel, it reads as city glow from high up but swamps the
 * streets close in, so it is faint below 50 km and builds to full at 100 km:
 *   below 20 km  none
 *   20 - 50 km   up to 15%
 *   50 - 100 km  15% rising steadily to 100% (about 32% at 60 km, 49% at
 *                70, 66% at 80, 83% at 90)
 *   100 km up    full
 */
export function marbleStrength(h) {
  if (h <= 20e3) return 0;
  if (h <= 50e3) return 0.15 * (h - 20e3) / 30e3;
  if (h < 100e3) return 0.15 + 0.85 * (h - 50e3) / 50e3;
  return 1;
}

/**
 * An aerial tile re-drawn as night lights: warm where the ground is bright
 * and unsaturated (built surfaces), transparent elsewhere, then blurred and
 * added back so each light carries a halo.
 */
export function glowTile(img) {
  const w = img.width;
  const h = img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, w, h);
  const a = d.data;
  for (let i = 0; i < a.length; i += 4) {
    const r = a[i] / 255; const gr = a[i + 1] / 255; const b = a[i + 2] / 255;
    const mx = Math.max(r, gr, b); const mn = Math.min(r, gr, b);
    const l = (mx + mn) / 2;
    const sat = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
    // Bright, and grey rather than tan or green.
    let lit = clamp01((l - 0.56) / 0.22) * (1 - clamp01((sat - 0.07) / 0.15));
    lit *= lit;
    a[i] = 255; a[i + 1] = 200 + 40 * lit; a[i + 2] = 120 + 70 * lit;
    a[i + 3] = Math.round(255 * lit);
  }
  g.putImageData(d, 0, 0);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const o = out.getContext('2d');
  o.filter = 'blur(4px)';
  o.drawImage(c, 0, 0);
  o.drawImage(c, 0, 0);
  o.filter = 'none';
  o.globalCompositeOperation = 'lighter';
  o.drawImage(c, 0, 0);
  return out;
}

// A small pool of workers that do glowTile()'s work off the main thread
// (see glow-worker.js). Null where workers or OffscreenCanvas are missing,
// and the main-thread version is used instead.
let pool = null;
function glowPool() {
  if (pool !== null) return pool || null;
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    pool = false;
    return null;
  }
  try {
    const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
    const waiting = new Map();
    let next = 0;
    const workers = Array.from({ length: n }, () => {
      const w = new Worker(new URL('./glow-worker.js', import.meta.url));
      w.onmessage = (e) => {
        const job = waiting.get(e.data.id);
        if (!job) return;
        waiting.delete(e.data.id);
        if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.bitmap);
      };
      return w;
    });
    pool = {
      async run(img) {
        const bitmap = await createImageBitmap(img);
        const id = next++;
        return new Promise((resolve, reject) => {
          waiting.set(id, { resolve, reject });
          workers[id % workers.length].postMessage({ id, bitmap }, [bitmap]);
        });
      },
    };
  } catch {
    pool = false;
  }
  return pool || null;
}

/** glowTile(), in a worker when there is one. */
function glowAsync(img) {
  const p = glowPool();
  if (!p) return Promise.resolve(glowTile(img));
  return p.run(img).catch(() => glowTile(img));
}

/** A provider that serves `src`'s tiles as night lights. */
function glowProvider(src) {
  const p = Object.create(src);
  p.requestImage = function (x, y, level, request) {
    const pending = src.requestImage(x, y, level, request);
    if (!pending) return pending;   // throttled: Cesium asks again
    return Promise.resolve(pending).then((img) => (img ? glowAsync(img) : img));
  };
  Object.defineProperty(p, 'hasAlphaChannel', { get: () => true });
  return p;
}

// Lit windows on 3D buildings, and less light from a sun that has set.
const BUILDING_SHADER = `
  void fragmentMain(FragmentInput fsInput, inout czm_modelMaterial material) {
    vec3 up = normalize(fsInput.attributes.positionWC);
    float night = smoothstep(0.05, -0.12, dot(up, normalize(czm_sunDirectionWC)));
    if (night <= 0.0) return;
    material.diffuse *= mix(1.0, 0.06, night * min(1.0, u_dark * 1.25));
    material.specular *= 1.0 - night;
    if (u_glow <= 0.0) return;
    vec3 upEC = normalize((czm_view * vec4(up, 0.0)).xyz);
    float wall = 1.0 - abs(dot(normalize(fsInput.attributes.normalEC), upEC));
    vec3 p = fsInput.attributes.positionMC;
    vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), up));
    vec3 north = cross(up, east);
    // Bays about 3.2 m wide, storeys 3.6 m tall.
    vec2 g = vec2((dot(p, east) + dot(p, north)) / 3.2, dot(p, up) / 3.6);
    vec2 cell = floor(g);
    vec2 f = fract(g);
    float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.78);
    float on = step(0.55, fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453));
    vec3 warm = vec3(1.0, 0.78, 0.45);
    material.emissive += warm * (smoothstep(0.6, 0.9, wall) * win * on * 1.1 + 0.03) * night * u_glow;
  }`;
const DAY_MS = 86400000;
const J1970 = 2440587.5;
const J2000 = 2451545.0;

/**
 * Sunrise and sunset around `date` at a place (the sunrise equation, with
 * the standard -0.833° altitude for refraction and the sun's radius).
 * Good to a minute or two — enough to say when the light goes.
 * Returns { rise, set } as Dates, or { polar: 'day' | 'night' }.
 */
export function sunTimes(date, lat, lon) {
  const jd = date.getTime() / DAY_MS + J1970;
  // The local solar day containing `date` (lon east-positive), then its
  // mean solar noon.
  const n = Math.round(jd - J2000 + lon / 360);
  const jStar = n - lon / 360;
  const M = ((357.5291 + 0.98560028 * jStar) % 360 + 360) % 360;
  const C = 1.9148 * Math.sin(M * RAD) + 0.02 * Math.sin(2 * M * RAD) + 0.0003 * Math.sin(3 * M * RAD);
  const lambda = ((M + C + 180 + 102.9372) % 360 + 360) % 360;
  const transit = J2000 + jStar + 0.0053 * Math.sin(M * RAD) - 0.0069 * Math.sin(2 * lambda * RAD);
  const sinDec = Math.sin(lambda * RAD) * Math.sin(23.4397 * RAD);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosW = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * sinDec) / (Math.cos(lat * RAD) * cosDec);
  if (cosW > 1) return { polar: 'night' };
  if (cosW < -1) return { polar: 'day' };
  const w = Math.acos(cosW) / RAD / 360;
  const toDate = (j) => new Date((j - J1970) * DAY_MS);
  return { rise: toDate(transit - w), set: toDate(transit + w) };
}

/** A 1×1 tile of the night colour, as a data URL. */
function nightTile(css) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d');
  g.fillStyle = css;
  g.fillRect(0, 0, 1, 1);
  return c.toDataURL('image/png');
}

export class NightOverlay {
  constructor(viewer) {
    this.viewer = viewer;
    this.on = false;
    this.darkness = 0.7;          // 0 = no shading, 1 = black
    this.color = '#000308';       // near-black, a touch of the HUD's blue
    this.layer = null;
    this.saved = null;            // Cesium's own fade distances, while on
    this.onUpdate = null;

    this.lights = 0.7;            // city lights, 0 = none
    this.marble = null;           // Black Marble layer
    this.glow = null;             // structure glow layer
    this.glowKey = null;          // the provider it was made from
    this.shader = null;           // building window shader
    this.shaded = null;           // the tileset it is on
    // Set by the app: the 3D buildings tileset, and the aerial provider the
    // structure glow is made from ({ provider, key } or null).
    this.getBuildings = () => null;
    this.getGlowSource = () => null;

    const cam = viewer.camera;
    cam.changed.addEventListener(() => this.fade());
    cam.moveEnd.addEventListener(() => this.fade());
  }

  setLights(v) {
    this.lights = Math.min(1, Math.max(0, Number(v) || 0));
    if (this.on) this.applyLights();
  }

  set(on) {
    this.on = !!on;
    if (this.on) this.apply(); else this.remove();
    this.onUpdate?.();
  }

  setDarkness(v) {
    this.darkness = Math.min(1, Math.max(0, Number(v) || 0));
    if (this.layer) this.layer.nightAlpha = this.darkness;
    if (this.shader) this.shader.setUniform('u_dark', this.darkness);
    this.viewer.scene.requestRender?.();
  }

  apply() {
    const globe = this.viewer.scene.globe;
    if (!this.saved) {
      this.saved = {
        enableLighting: globe.enableLighting,
        nightFadeOutDistance: globe.nightFadeOutDistance,
        nightFadeInDistance: globe.nightFadeInDistance,
        lightingFadeOutDistance: globe.lightingFadeOutDistance,
        lightingFadeInDistance: globe.lightingFadeInDistance,
      };
    }
    // Day/night alpha only runs with lighting on.
    globe.enableLighting = true;
    globe.nightFadeOutDistance = 1;
    globe.nightFadeInDistance = 2;
    globe.lightingFadeOutDistance = 1e12;
    globe.lightingFadeInDistance = 2e12;

    if (!this.layer) {
      const provider = new Cesium.SingleTileImageryProvider({
        url: nightTile(this.color), tileWidth: 1, tileHeight: 1, credit: '',
      });
      this.layer = new Cesium.ImageryLayer(provider, { dayAlpha: 0, nightAlpha: this.darkness });
      // Just above the base map (and any layer standing in for it, such as
      // the pinned aerial level), below every overlay.
      const layers = this.viewer.imageryLayers;
      let at = Math.min(1, layers.length);
      for (let i = 0; i < layers.length; i++) if (layers.get(i)._opBase) at = Math.max(at, i + 1);
      this.layer._opNight = true;
      layers.add(this.layer, at);
    }
    this.applyLights();
    this.viewer.scene.requestRender?.();
  }

  /** Lights layers just above the shade, in order: regions, then structures. */
  addAboveShade(layer, after) {
    const layers = this.viewer.imageryLayers;
    layer._opNight = true;
    layers.add(layer, layers.indexOf(after || this.layer) + 1);
  }

  applyLights() {
    if (!this.on || !this.layer) return;
    const layers = this.viewer.imageryLayers;
    if (this.lights > 0 && !this.marble) {
      const layer = new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
        url: BLACK_MARBLE, maximumLevel: 8, credit: 'NASA Black Marble (VIIRS)',
      }), { dayAlpha: 0, nightAlpha: 0 });
      // The black ocean and dark land go transparent; only light is kept.
      layer.colorToAlpha = new Cesium.Color(0, 0, 0, 1);
      layer.colorToAlphaThreshold = 0.3;
      layer.gamma = 0.32;
      layer.saturation = 1.4;
      this.marble = layer;
      this.addAboveShade(layer);
    } else if (this.lights <= 0 && this.marble) {
      layers.remove(this.marble, true);
      this.marble = null;
    }
    this.refreshGlow();

    // Building windows.
    const bld = this.getBuildings();
    if (bld && !this.shader) {
      this.shader = new Cesium.CustomShader({
        uniforms: {
          u_glow: { type: Cesium.UniformType.FLOAT, value: this.lights },
          u_dark: { type: Cesium.UniformType.FLOAT, value: this.darkness },
        },
        fragmentShaderText: BUILDING_SHADER,
      });
    }
    if (bld && this.shader) {
      this.shader.setUniform('u_glow', this.lights);
      this.shader.setUniform('u_dark', this.darkness);
      if (this.shaded !== bld) {
        this.prevShader = bld.customShader;
        bld.customShader = this.shader;
        this.shaded = bld;
      }
    }
    this.fade();
  }

  /**
   * (Re)build the structure glow from the current aerial provider. Called
   * when the pinned aerial level changes, so the lights come from the same
   * level, and the same survey, as the ground under them.
   */
  refreshGlow() {
    const layers = this.viewer.imageryLayers;
    const src = this.on && this.lights > 0 ? this.getGlowSource() : null;
    if (src && src.key === this.glowKey && this.glow) return;
    if (this.glow) { layers.remove(this.glow, true); this.glow = null; this.glowKey = null; }
    if (!src?.provider) return;
    this.glow = new Cesium.ImageryLayer(glowProvider(src.provider), {
      dayAlpha: 0, nightAlpha: 0,
      // Same far-field limit as the pinned layer it is made from.
      ...(src.minimumTerrainLevel != null ? { minimumTerrainLevel: src.minimumTerrainLevel } : {}),
    });
    this.glowKey = src.key;
    this.addAboveShade(this.glow, this.marble || this.layer);
    this.fade();
  }

  /**
   * Share the lights out by height: single structures close in, whole
   * cities from high up, where a structure is less than a pixel.
   */
  fade() {
    if (!this.on) return;
    const h = this.viewer.camera.positionCartographic.height;
    const near = clamp01((400e3 - h) / 300e3);            // full below 100 km
    if (this.glow) this.glow.nightAlpha = this.lights * near;
    if (this.marble) this.marble.nightAlpha = this.lights * 0.65 * marbleStrength(h);
    this.viewer.scene.requestRender?.();
  }

  removeLights() {
    const layers = this.viewer.imageryLayers;
    for (const l of [this.glow, this.marble]) if (l && layers.contains(l)) layers.remove(l, true);
    this.glow = null; this.glowKey = null; this.marble = null;
    if (this.shaded) {
      this.shaded.customShader = this.prevShader;
      this.shaded = null;
      this.prevShader = undefined;
    }
  }

  remove() {
    this.removeLights();
    if (this.layer) {
      this.viewer.imageryLayers.remove(this.layer, true);
      this.layer = null;
    }
    if (this.saved) {
      Object.assign(this.viewer.scene.globe, this.saved);
      this.saved = null;
    }
    this.viewer.scene.requestRender?.();
  }

  /**
   * One line on the light at the view centre: whether it is day or night
   * there and when that changes, in local and UTC time.
   */
  describe(lat, lon, now = new Date()) {
    const fmt = (d) => {
      const local = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const z = d.toISOString().slice(11, 16);
      return `${local} (${z}Z)`;
    };
    const t = sunTimes(now, lat, lon);
    const where = `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} `
      + `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
    if (t.polar === 'day') return `At ${where}: midnight sun, no sunset today.`;
    if (t.polar === 'night') return `At ${where}: polar night, no sunrise today.`;
    if (now < t.rise) return `At ${where}: night. Sunrise ${fmt(t.rise)}.`;
    if (now < t.set) return `At ${where}: day. Sunset ${fmt(t.set)}.`;
    // After today's sunset: the next sunrise is tomorrow's.
    const next = sunTimes(new Date(now.getTime() + DAY_MS), lat, lon);
    return next.rise
      ? `At ${where}: night. Sunrise ${fmt(next.rise)}.`
      : `At ${where}: night.`;
  }
}

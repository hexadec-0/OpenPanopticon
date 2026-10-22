// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * Just enough of Cesium for the browser modules to run under Node.
 *
 * The unit tests exercise the app's own logic — caching, coverage, backoff,
 * filtering, detail-panel HTML — not Cesium's rendering. So every Cesium type
 * here is a plain record of what it was constructed with, which also makes it
 * easy to assert on ("this entity was drawn at this position, in this colour").
 * The real library is exercised by the Puppeteer suite.
 */

class Cartesian3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }

  static fromDegrees(lon, lat, h = 0) {
    const c = new Cartesian3(lon, lat, h);
    c.lon = lon; c.lat = lat; c.h = h;
    return c;
  }

  static fromDegreesArray(flat) {
    const out = [];
    for (let i = 0; i < flat.length; i += 2) out.push(Cartesian3.fromDegrees(flat[i], flat[i + 1]));
    return out;
  }

  /** Approximate metres between two stub positions (they carry lat/lon). */
  static distance(a, b) {
    const dLat = ((b.lat ?? b.y) - (a.lat ?? a.y)) * 111_320;
    const dLon = ((b.lon ?? b.x) - (a.lon ?? a.x)) * 111_320 * Math.cos(((a.lat ?? 0) * Math.PI) / 180);
    const dH = (b.h ?? b.z) - (a.h ?? a.z);
    return Math.hypot(dLat, dLon, dH);
  }
}
Cartesian3.ZERO = Object.freeze(new Cartesian3(0, 0, 0));

class Color {
  constructor(css, alpha = 1) { this.css = css; this.alpha = alpha; }

  static fromCssColorString(css) { return new Color(css); }

  withAlpha(a) { return new Color(this.css, a); }
}
Color.BLACK = new Color('#000000');
Color.WHITE = new Color('#ffffff');

class Record {
  constructor(...args) { this.args = args; Object.assign(this, typeof args[0] === 'object' ? args[0] : {}); }
}

class CallbackProperty {
  constructor(fn, isConstant) { this.fn = fn; this.isConstant = isConstant; }

  getValue(time) { return this.fn(time); }
}
class CallbackPositionProperty extends CallbackProperty {}

class PropertyBag {
  constructor(values = {}) {
    for (const [k, v] of Object.entries(values)) this[k] = { getValue: () => v, value: v };
  }
}

class EntityCollection {
  constructor() { this._map = new Map(); this._seq = 0; }

  get values() { return [...this._map.values()]; }

  add(opts) {
    const id = opts.id ?? `entity-${++this._seq}`;
    if (this._map.has(id)) throw new Error(`An entity with id ${id} already exists`);
    const e = { ...opts, id, isShowing: true };
    if (e.position && !e.position.getValue) {
      const fixed = e.position;
      e.position = { getValue: () => fixed, value: fixed };
    }
    if (opts.properties && !(opts.properties instanceof PropertyBag)) {
      e.properties = new PropertyBag(opts.properties);
    }
    this._map.set(id, e);
    return e;
  }

  getById(id) { return this._map.get(id); }

  remove(e) { return this._map.delete(e?.id ?? e); }

  removeAll() { this._map.clear(); }
}

class CustomDataSource {
  constructor(name) { this.name = name; this.show = true; this.entities = new EntityCollection(); }
}

class PointPrimitiveCollection {
  constructor() { this._pts = []; this.show = true; }

  add(opts) {
    const p = { ...opts, show: true, isDestroyed: () => false };
    this._pts.push(p);
    return p;
  }

  get(i) { return this._pts[i]; }

  get length() { return this._pts.length; }
}

class ImageryLayer {
  constructor(provider) { this.imageryProvider = provider; this.alpha = 1; this.show = true; }

  static fromWorldImagery() { const l = new ImageryLayer({ worldImagery: true }); return l; }
}

class ImageryLayerCollection {
  constructor() { this._layers = []; }

  get length() { return this._layers.length; }

  add(l) { this._layers.push(l); }

  remove(l) { const i = this._layers.indexOf(l); if (i >= 0) this._layers.splice(i, 1); return i >= 0; }

  get(i) { return this._layers[i]; }

  indexOf(l) { return this._layers.indexOf(l); }

  contains(l) { return this._layers.includes(l); }

  lowerToBottom(l) { if (this.remove(l)) this._layers.unshift(l); }

  raiseToTop(l) { if (this.remove(l)) this._layers.push(l); }
}

class Event {
  constructor() { this.listeners = []; }

  addEventListener(fn) { this.listeners.push(fn); return () => this.removeEventListener(fn); }

  removeEventListener(fn) { this.listeners = this.listeners.filter((f) => f !== fn); }

  raiseEvent(...a) { for (const fn of this.listeners) fn(...a); }
}

const JulianDate = {
  now: () => ({ date: new Date() }),
  toDate: (j) => j?.date ?? new Date(),
  fromDate: (d) => ({ date: d }),
};

const CesiumMath = {
  toRadians: (d) => (d * Math.PI) / 180,
  toDegrees: (r) => (r * 180) / Math.PI,
};

export function makeCesium() {
  return {
    Cartesian3,
    Cartesian2: class Cartesian2 { constructor(x, y) { this.x = x; this.y = y; } },
    Cartographic: {
      fromCartesian: (c) => (c ? { latitude: CesiumMath.toRadians(c.lat ?? 0), longitude: CesiumMath.toRadians(c.lon ?? 0), height: c.h ?? 0 } : undefined),
    },
    Color,
    CustomDataSource,
    EntityCollection,
    PointPrimitiveCollection,
    CallbackProperty,
    CallbackPositionProperty,
    PropertyBag,
    NearFarScalar: Record,
    DistanceDisplayCondition: Record,
    PolygonHierarchy: Record,
    PolylineGlowMaterialProperty: Record,
    HeadingPitchRange: Record,
    BoundingSphere: Record,
    UrlTemplateImageryProvider: Record,
    OpenStreetMapImageryProvider: Record,
    WebMercatorTilingScheme: class { constructor() { this.rectangle = { west: -Math.PI, south: -1.48, east: Math.PI, north: 1.48 }; } },
    Credit: class Credit { constructor(html, onScreen) { this.html = html; this.showOnScreen = onScreen; } },
    PostProcessStage: Record,
    ImageryLayer,
    Event,
    JulianDate,
    Math: CesiumMath,
    HeightReference: { NONE: 0, CLAMP_TO_GROUND: 1, RELATIVE_TO_GROUND: 2 },
    LabelStyle: { FILL: 0, OUTLINE: 1, FILL_AND_OUTLINE: 2 },
    HorizontalOrigin: { CENTER: 0, LEFT: 1, RIGHT: -1 },
    ArcType: { NONE: 0, GEODESIC: 1, RHUMB: 2 },
    ClassificationType: { TERRAIN: 0, CESIUM_3D_TILE: 1, BOTH: 2 },
    SceneMode: { MORPHING: 0, COLUMBUS_VIEW: 1, SCENE2D: 2, SCENE3D: 3 },
    defined: (v) => v !== undefined && v !== null,
    EllipsoidalOccluder: class { isPointVisible() { return true; } },
    SceneTransforms: { worldToWindowCoordinates: (scene, p) => (p ? { x: p.x, y: p.y } : undefined) },
  };
}

/** A viewer with the collections the layers touch, and nothing else. */
export function makeViewer() {
  const dataSources = [];
  const primitives = [];
  const stages = [];
  const viewer = {
    dataSources: { add: (ds) => { dataSources.push(ds); return Promise.resolve(ds); }, _list: dataSources },
    imageryLayers: new ImageryLayerCollection(),
    clock: { currentTime: JulianDate.now() },
    scene: {
      mode: 3,
      primitives: {
        add: (p) => { primitives.push(p); return p; },
        remove: (p) => { const i = primitives.indexOf(p); if (i >= 0) primitives.splice(i, 1); },
        _list: primitives,
      },
      postProcessStages: {
        add: (s) => { stages.push(s); return s; },
        remove: (s) => { const i = stages.indexOf(s); if (i >= 0) stages.splice(i, 1); },
        _list: stages,
      },
      context: { drawingBufferWidth: 800, drawingBufferHeight: 600 },
      canvas: { clientWidth: 800, clientHeight: 600, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      globe: { ellipsoid: {} },
      camera: { positionWC: {} },
    },
  };
  return viewer;
}

/** Put a fresh Cesium stub on globalThis and return it. */
export function installCesium() {
  globalThis.Cesium = makeCesium();
  return globalThis.Cesium;
}

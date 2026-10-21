/**
 * shortbread.js — OpenStreetMap vector tiles drawn into Cesium.
 *
 * Shortbread is a schema, not a service: there is no raster endpoint anywhere
 * to point an ordinary imagery provider at. Cesium only consumes raster, so
 * the tiles are fetched as protobuf, decoded (mvt.js), and drawn to a canvas
 * here — which Cesium then treats as any other image.
 *
 * Doing the drawing ourselves is what makes this worth having rather than
 * just another street map: the palette is the terminal's, so the ground reads
 * as part of the instrument instead of a web map with a HUD on top. It also
 * means no style engine and no second map library.
 *
 * Tiles come from VersaTiles, which serves the Shortbread schema worldwide,
 * unauthenticated, CORS-open, to zoom 14.
 */

import { decodeMvt } from './mvt.js';

/** Only these are drawn. The rest of a city tile is labels, POIs and
 *  addresses — thousands of features that would cost far more to decode than
 *  the map gains from them. */
const DRAWN = new Set([
  'land', 'water_polygons', 'water_lines', 'sites',
  'street_polygons', 'streets', 'bridges', 'buildings', 'boundaries',
]);

/** The one tag that changes how something is drawn. */
const TAGS = new Set(['kind']);

/**
 * Road weights, in tile units at extent 4096, by Shortbread's `kind`.
 * Anything unlisted falls back to the minor-road weight, so an unfamiliar
 * value degrades to a thin line rather than vanishing.
 */
const ROAD_WIDTH = {
  motorway: 9, trunk: 8, primary: 7, secondary: 6, tertiary: 5,
  unclassified: 4, residential: 4, living_street: 3, pedestrian: 3,
  service: 2.5, track: 2, footway: 1.5, path: 1.5, cycleway: 1.5, steps: 1.5,
};
const ROAD_DEFAULT = 3;
const MAJOR = new Set(['motorway', 'trunk', 'primary']);

/**
 * Terminal palette.
 *
 * Muted, because this is the backdrop for the overlays rather than the
 * subject — but not so muted that it stops being a map. The first cut was
 * dark enough that buildings and streets were indistinguishable from the
 * ground, which is a worse failure than being slightly too present.
 */
const PALETTE = {
  background: '#070b0f',
  land: '#101820',
  water: '#0d2b3c',
  waterLine: '#1d4f68',
  site: '#13241c',          // parks and campuses, faintly green
  building: '#1e2831',
  buildingEdge: '#2b3843',
  roadMinor: '#39474f',
  roadMajor: '#5b7080',
  motorway: '#7d95a3',
  boundary: '#43315c',
};

export class ShortbreadImageryProvider {
  constructor({
    url = 'https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}',
    maximumLevel = 14,
    tileSize = 512,
    credit = '© OpenStreetMap contributors · Shortbread via VersaTiles',
  } = {}) {
    this._url = url;
    this._tileSize = tileSize;

    this.defaultAlpha = undefined;
    this.defaultBrightness = undefined;
    this.defaultContrast = undefined;
    this.defaultHue = undefined;
    this.defaultSaturation = undefined;
    this.defaultGamma = undefined;
    this.defaultMinificationFilter = undefined;
    this.defaultMagnificationFilter = undefined;

    this._tilingScheme = new Cesium.WebMercatorTilingScheme();
    this._errorEvent = new Cesium.Event();
    this._credit = new Cesium.Credit(credit, false);
    this._maximumLevel = maximumLevel;
    this._failures = 0;
  }

  /* Cesium's ImageryProvider surface. */
  get ready() { return true; }
  get readyPromise() { return Promise.resolve(true); }
  get rectangle() { return this._tilingScheme.rectangle; }
  get tileWidth() { return this._tileSize; }
  get tileHeight() { return this._tileSize; }
  get maximumLevel() { return this._maximumLevel; }
  get minimumLevel() { return 0; }
  get tilingScheme() { return this._tilingScheme; }
  get tileDiscardPolicy() { return undefined; }
  get errorEvent() { return this._errorEvent; }
  get credit() { return this._credit; }
  get hasAlphaChannel() { return false; }
  get proxy() { return undefined; }
  getTileCredits() { return [this._credit]; }
  pickFeatures() { return undefined; }

  async requestImage(x, y, level) {
    const url = this._url
      .replace('{z}', level).replace('{x}', x).replace('{y}', y);

    let buf;
    try {
      const res = await fetch(url, { mode: 'cors' });
      // 204/404 is how a tile server says "nothing here", which is ordinary
      // over ocean. Draw the empty tile rather than leaving a hole.
      if (res.status === 204 || res.status === 404) return this._blank();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      // Returning undefined makes Cesium retry and eventually surface an
      // error; a blank tile keeps the globe coherent while the rest loads.
      if (++this._failures < 4) console.warn('shortbread tile failed', url, e.message);
      return this._blank();
    }

    try {
      return this._draw(decodeMvt(buf, { layers: DRAWN, tags: TAGS }));
    } catch (e) {
      console.warn('shortbread tile undecodable', url, e.message);
      return this._blank();
    }
  }

  _canvas() {
    const c = document.createElement('canvas');
    c.width = this._tileSize;
    c.height = this._tileSize;
    return c;
  }

  _blank() {
    const c = this._canvas();
    const g = c.getContext('2d');
    g.fillStyle = PALETTE.background;
    g.fillRect(0, 0, c.width, c.height);
    return c;
  }

  _draw(layers) {
    const c = this._canvas();
    const g = c.getContext('2d');
    const size = this._tileSize;

    g.fillStyle = PALETTE.background;
    g.fillRect(0, 0, size, size);
    g.lineCap = 'round';
    g.lineJoin = 'round';

    // One scale for the whole tile: Shortbread uses extent 4096 throughout,
    // but read it per layer rather than assuming.
    const path = (rings, extent) => {
      const k = size / extent;
      g.beginPath();
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i += 2) {
          const px = ring[i] * k;
          const py = ring[i + 1] * k;
          if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
      }
    };

    const fillLayer = (name, colour, close = true) => {
      const layer = layers.get(name);
      if (!layer) return;
      g.fillStyle = colour;
      for (const f of layer.features) {
        if (f.type !== 'polygon' || !f.rings.length) continue;
        path(f.rings, layer.extent);
        if (close) g.closePath();
        g.fill('evenodd');
      }
    };

    const strokeLayer = (name, colour, width) => {
      const layer = layers.get(name);
      if (!layer) return;
      g.strokeStyle = colour;
      g.lineWidth = width * (size / layer.extent);
      for (const f of layer.features) {
        if (!f.rings.length) continue;
        path(f.rings, layer.extent);
        g.stroke();
      }
    };

    // Ground up, so later layers cover earlier ones the way a map expects.
    fillLayer('land', PALETTE.land);
    fillLayer('water_polygons', PALETTE.water);
    fillLayer('sites', PALETTE.site);
    strokeLayer('water_lines', PALETTE.waterLine, 6);
    fillLayer('street_polygons', PALETTE.roadMinor);

    // Roads twice: every minor road first, then the major ones over the top,
    // so junctions read correctly instead of being cut by whatever was drawn
    // last.
    const streets = layers.get('streets');
    if (streets) {
      const k = size / streets.extent;
      for (const pass of [0, 1]) {
        for (const f of streets.features) {
          if (f.type === 'polygon' || !f.rings.length) continue;
          const kind = f.props?.kind;
          const major = MAJOR.has(kind);
          if ((pass === 0) === major) continue;
          g.strokeStyle = kind === 'motorway' ? PALETTE.motorway
            : major ? PALETTE.roadMajor : PALETTE.roadMinor;
          g.lineWidth = (ROAD_WIDTH[kind] ?? ROAD_DEFAULT) * k;
          path(f.rings, streets.extent);
          g.stroke();
        }
      }
    }

    const buildings = layers.get('buildings');
    if (buildings) {
      g.fillStyle = PALETTE.building;
      g.strokeStyle = PALETTE.buildingEdge;
      g.lineWidth = Math.max(0.4, size / 1024);
      for (const f of buildings.features) {
        if (f.type !== 'polygon' || !f.rings.length) continue;
        path(f.rings, buildings.extent);
        g.closePath();
        g.fill('evenodd');
        g.stroke();
      }
    }

    strokeLayer('bridges', PALETTE.roadMajor, 4);
    strokeLayer('boundaries', PALETTE.boundary, 3);
    return c;
  }
}

export { PALETTE as SHORTBREAD_PALETTE, DRAWN as SHORTBREAD_LAYERS };

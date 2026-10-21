/**
 * selection.js — the "this is the one you clicked" ring.
 *
 * Opening the detail panel used to be the only feedback that a pick had
 * landed, which left you hunting the globe for which of several hundred
 * near-identical pins the panel was describing. This draws a large glowing
 * ring around it instead.
 *
 * Two things make it work everywhere rather than only for ground features:
 *
 *  - It is a billboard, so it is sized in screen pixels and always faces the
 *    camera. A ring drawn on the ellipsoid would foreshorten to a sliver at
 *    a shallow camera angle, and an aircraft at 10km or a satellite at 400km
 *    would get a ring the size of a country or none at all.
 *  - Its position is a callback, re-read every frame, so it tracks a moving
 *    contact and survives a layer refresh that replaces the entity under it.
 */

/** One ring texture per accent colour, built once and kept. */
const textures = new Map();

function ringTexture(css) {
  if (textures.has(css)) return textures.get(css);

  const S = 256;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const g = c.getContext?.('2d');
  // No 2D context (a headless DOM, or canvas disabled): fall back to an SVG
  // ring rather than letting the whole pick handler throw.
  if (!g || typeof c.toDataURL !== 'function') {
    const url = svgRing(css);
    textures.set(css, url);
    return url;
  }
  const mid = S / 2;
  const R = S * 0.36;                     // ring radius

  // Every stroke is laid down three times — a dark backing, the accent
  // colour, then a white core — so the ring reads against dark ocean,
  // bright satellite imagery and snow alike, and even when the accent is
  // one of the muted greys a layer uses for "unknown".
  const stroke = (draw, w) => {
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,0.85)';  g.lineWidth = w * 2.1; draw();
    g.strokeStyle = withAlpha(css, 1);   g.lineWidth = w;       draw();
    g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = w * 0.32; draw();
  };

  // Outer halo in the accent colour, fading out before the edge so the
  // billboard's square never shows.
  const halo = g.createRadialGradient(mid, mid, R * 0.80, mid, mid, S * 0.5);
  halo.addColorStop(0.00, 'rgba(0,0,0,0)');
  halo.addColorStop(0.25, withAlpha(css, 0.55));
  halo.addColorStop(0.60, withAlpha(css, 0.18));
  halo.addColorStop(1.00, 'rgba(0,0,0,0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, S, S);

  // A faint darkened disc inside the ring lifts the pin off busy imagery.
  const dim = g.createRadialGradient(mid, mid, 0, mid, mid, R);
  dim.addColorStop(0.00, 'rgba(0,0,0,0)');
  dim.addColorStop(0.70, 'rgba(0,0,0,0.10)');
  dim.addColorStop(1.00, 'rgba(0,0,0,0.28)');
  g.fillStyle = dim;
  g.beginPath(); g.arc(mid, mid, R, 0, Math.PI * 2); g.fill();

  // The ring.
  stroke(() => { g.beginPath(); g.arc(mid, mid, R, 0, Math.PI * 2); g.stroke(); }, S * 0.035);

  // Four crosshair ticks pointing in at the target, outside the ring.
  const r0 = R + S * 0.045, r1 = S * 0.475;
  for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    stroke(() => {
      g.beginPath();
      g.moveTo(mid + Math.cos(a) * r0, mid + Math.sin(a) * r0);
      g.lineTo(mid + Math.cos(a) * r1, mid + Math.sin(a) * r1);
      g.stroke();
    }, S * 0.03);
  }

  const url = c.toDataURL('image/png');
  textures.set(css, url);
  return url;
}

/** Canvas-free ring, for environments where 2D drawing is unavailable. */
function svgRing(css) {
  const ring = (w) => `<circle cx="128" cy="128" r="92" fill="none" stroke-width="${w}"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">`
    + `${ring(19)} stroke="rgba(0,0,0,0.85)"/>`
    + `${ring(9)} stroke="${withAlpha(css, 1)}"/>`
    + `${ring(3)} stroke="rgba(255,255,255,0.95)"/>`
    + `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** #rrggbb / #rgb / rgb() -> rgba() at the given alpha. */
function withAlpha(css, alpha) {
  const s = String(css || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = [...m[1]].map((h) => parseInt(h + h, 16));
    return `rgba(${r},${g},${b},${alpha})`;
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(s);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  return `rgba(57,255,136,${alpha})`;      // the HUD green, as a last resort
}

const DEFAULT_ACCENT = '#39ff88';

export class SelectionMarker {
  constructor(viewer) {
    this.viewer = viewer;
    this.target = null;
    this.source = new Cesium.CustomDataSource('selection');
    viewer.dataSources.add(this.source);

    this.entity = this.source.entities.add({
      id: 'selection-ring',
      position: new Cesium.CallbackProperty(() => this.position(), false),
      billboard: {
        image: ringTexture(DEFAULT_ACCENT),
        width: 132,
        height: 132,
        scale: new Cesium.CallbackProperty(() => this.pulse(), false),
        // Always visible: a marker you have to tilt the camera to find is no
        // better than no marker.
        //
        // No eyeOffset. It is applied in eye space inside the shader, so it
        // shifts the ring along the view ray by a fixed number of metres —
        // which at any oblique angle lands it off the pin and below the
        // terrain, while JS-side position maths still reports a perfect
        // match. Disabling the depth test is what keeps it on top, and it
        // does so without moving the ring anywhere.
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        // Set per selection to match the pin being ringed — see select().
        heightReference: Cesium.HeightReference.NONE,
      },
      show: false,
    });
  }

  /**
   * @param {object} t  Where to draw, in order of preference:
   *   {layer}      the owning layer, so the ring vanishes when it is hidden
   *   {entityId}   re-looked-up each frame, so a refresh does not orphan it
   *   {primitive}  a PointPrimitive, for the collection-backed layers
   *   {lat,lon,height}  static fallback from the record itself
   * @param {string} accent  the detail panel's accent colour
   */
  select(t, accent) {
    this.target = t || null;
    if (!t) { this.entity.show = false; return; }
    this.entity.billboard.image = ringTexture(accent || DEFAULT_ACCENT);
    // Ground pins are clamped to terrain, and their stored position is the
    // unclamped one at height 0. Ringing that position without clamping too
    // would bury the ring inside any hill the pin sits on. Aircraft and
    // satellites must stay unclamped or they would drop to ground level.
    this.entity.billboard.heightReference = t.clampToGround
      ? Cesium.HeightReference.CLAMP_TO_GROUND
      : Cesium.HeightReference.NONE;
    this.entity.show = true;
    this.since = performance.now();
  }

  clear() {
    this.target = null;
    this.entity.show = false;
  }

  /** True while a given layer owns the current selection. */
  owns(layerId) {
    return !!this.target && this.target.layer?.id === layerId;
  }

  position() {
    const t = this.target;
    if (!t) return undefined;
    // A hidden layer should not leave a ring floating over nothing.
    if (t.layer && t.layer.enabled === false) return undefined;

    const time = this.viewer.clock?.currentTime;

    if (t.entityId && t.layer?.source?.entities?.getById) {
      const ent = t.layer.source.entities.getById(t.entityId);
      const p = ent?.position?.getValue?.(time);
      if (p) return p;
    }

    if (t.primitive) {
      // The collection is torn down and rebuilt on reload, which destroys
      // the primitive we are holding; reading it then throws.
      try {
        if (!t.primitive.isDestroyed?.()) {
          const p = t.primitive.position;
          if (p) return p;
        }
      } catch { /* collection replaced under us */ }
    }

    if (Number.isFinite(t.lat) && Number.isFinite(t.lon)) {
      return Cesium.Cartesian3.fromDegrees(t.lon, t.lat, t.height || 0);
    }
    return undefined;
  }

  /** A slow breathe, so the eye catches it without it being a strobe. */
  pulse() {
    const ms = performance.now() - (this.since || 0);
    return 1 + 0.12 * Math.sin(ms / 380);
  }
}

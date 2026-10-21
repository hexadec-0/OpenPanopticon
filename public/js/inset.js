/**
 * inset.js — a close-up map in the detail panel.
 *
 * From high up, a pick tells you *what* something is but not *where*: a
 * camera or a Shodan host is one pixel on a continent. This draws a small
 * street (or aerial) map centred on the pick, built straight from slippy
 * tiles — no second globe and no map library, just a handful of <img>s.
 *
 * Position comes from a callback re-read every couple of seconds, so an
 * aircraft or a ship stays centred as it moves.
 */

const TILE = 256;
// Used only before the frame has been laid out. The real size comes from
// the frame itself, which keeps a fixed aspect ratio in CSS — so widening the
// panel makes the map taller too, not just wider.
const DEFAULT_W = 400;
const DEFAULT_H = 225;
const MIN_Z = 3;
const MAX_Z = 18;

export const INSET_STYLES = {
  streets: {
    label: 'Streets',
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    credit: '© OpenStreetMap contributors',
  },
  aerial: {
    label: 'Aerial',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    credit: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
};

const STYLE_KEY = 'openpanopticon.insetStyle';
function savedStyle() {
  try { const s = localStorage.getItem(STYLE_KEY); return INSET_STYLES[s] ? s : 'streets'; }
  catch { return 'streets'; }
}

/** Offset a lat/lon by a bearing and distance (fine at camera-cone scale). */
function offsetLatLon(lat, lon, bearingDeg, metres) {
  const R = 6378137;
  const br = (bearingDeg * Math.PI) / 180;
  const dLat = (metres * Math.cos(br)) / R;
  const dLon = (metres * Math.sin(br)) / (R * Math.cos((lat * Math.PI) / 180));
  return [lat + (dLat * 180) / Math.PI, lon + (dLon * 180) / Math.PI];
}

/** lon/lat -> global pixel at zoom z (Web Mercator). */
function project(lat, lon, z) {
  const n = TILE * 2 ** z;
  const la = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2) * n,
  };
}

/** Sensible starting zoom for how high the thing itself is. */
export function zoomForHeight(h) {
  if (h > 100_000) return 6;      // satellite: show the region it's over
  if (h > 1_000) return 13;       // aircraft: the town beneath it
  return 17;                      // anything on the ground: the street
}

export class LocationInset {
  /**
   * @param {HTMLElement} host       container to render into (emptied)
   * @param {() => ({lat,lon,height}|null)} locate  current position
   * @param {object} opts  { accent, onActivate(lat, lon) }
   */
  constructor(host, locate, opts = {}) {
    this.host = host;
    this.locate = locate;
    this.accent = opts.accent || '#39ff88';
    this.onActivate = opts.onActivate;
    // [{ bearing, rangeM, halfAngle }] — field-of-view wedges to draw.
    this.cones = Array.isArray(opts.cones) ? opts.cones : [];
    this.style = savedStyle();
    this.tiles = new Map();          // key -> <img>, reused across redraws
    this.pos = locate();
    if (!this.pos) return;
    this.z = zoomForHeight(this.pos.height || 0);
    this.build();
    // Cameras open at the same z17 as everything else on the ground, only
    // backing out if the panel is too small for the whole wedge to fit.
    if (this.cones.length) this.z = this.fitConeZoom();
    this.draw();
    // Follow moving contacts. Cheap: unchanged tiles are reused, not refetched.
    this.timer = setInterval(() => this.follow(), 2000);
    // Re-tile when the panel is resized, so the map always fills it.
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.draw());
      this.ro.observe(this.frame);
    }
  }

  build() {
    const h = this.host;
    h.innerHTML = '';
    h.classList.add('on');
    h.style.setProperty('--accent', this.accent);

    this.frame = document.createElement('div');
    this.frame.className = 'inset-frame';
    this.frame.title = 'Click to fly the globe here';
    this.layer = document.createElement('div');
    this.layer.className = 'inset-tiles';
    const mark = document.createElement('div');
    mark.className = 'inset-mark';
    // Cones sit between the tiles and the marker.
    this.coneSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.coneSvg.setAttribute('class', 'inset-cones');
    this.frame.append(this.layer, this.coneSvg, mark);
    this.frame.classList.toggle('has-cones', this.cones.length > 0);
    this.frame.onclick = () => this.pos && this.onActivate?.(this.pos.lat, this.pos.lon);

    const bar = document.createElement('div');
    bar.className = 'inset-bar';
    this.styleBtns = Object.entries(INSET_STYLES).map(([k, s]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = s.label; b.dataset.k = k;
      b.onclick = (e) => { e.stopPropagation(); this.setStyle(k); };
      return b;
    });
    const zoom = (d) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = d > 0 ? '+' : '−';
      b.title = d > 0 ? 'Zoom in' : 'Zoom out';
      b.onclick = (e) => { e.stopPropagation(); this.setZoom(this.z + d); };
      return b;
    };
    this.coord = document.createElement('span');
    this.coord.className = 'inset-coord';
    bar.append(...this.styleBtns, this.coord, zoom(-1), zoom(+1));

    this.credit = document.createElement('div');
    this.credit.className = 'inset-credit';

    h.append(this.frame, bar, this.credit);
  }

  fitConeZoom() {
    const range = Math.max(...this.cones.map((c) => c.rangeM || 55));
    const h = this.frame.clientHeight || DEFAULT_H;
    const w = this.frame.clientWidth || DEFAULT_W;
    const room = 0.42 * Math.min(w, h);                 // px from centre to edge, with margin
    const mppAtZ0 = 156543.03 * Math.cos((this.pos.lat * Math.PI) / 180);
    const z = Math.floor(Math.log2((room * mppAtZ0) / range));
    return Math.max(15, Math.min(zoomForHeight(0), z));
  }

  setStyle(k) {
    if (!INSET_STYLES[k] || k === this.style) return;
    this.style = k;
    try { localStorage.setItem(STYLE_KEY, k); } catch { /* private window */ }
    this.tiles.forEach((img) => img.remove());
    this.tiles.clear();
    this.draw();
  }

  setZoom(z) {
    z = Math.max(MIN_Z, Math.min(MAX_Z, z));
    if (z === this.z) return;
    this.z = z;
    this.draw();
  }

  follow() {
    if (!this.host.isConnected) { this.destroy(); return; }
    const p = this.locate();
    if (!p) return;
    if (Math.abs(p.lat - this.pos.lat) < 1e-6 && Math.abs(p.lon - this.pos.lon) < 1e-6) return;
    this.pos = p;
    this.draw();
  }

  draw() {
    const { lat, lon } = this.pos;
    const z = this.z;
    const style = INSET_STYLES[this.style];
    // Fill whatever width the panel has, so nothing overflows it.
    const W = this.frame.clientWidth || DEFAULT_W;
    const H = this.frame.clientHeight || DEFAULT_H;
    const c = project(lat, lon, z);
    const left = c.x - W / 2;
    const top = c.y - H / 2;
    const n = 2 ** z;

    const x0 = Math.floor(left / TILE), x1 = Math.floor((left + W) / TILE);
    const y0 = Math.max(0, Math.floor(top / TILE)), y1 = Math.min(n - 1, Math.floor((top + H) / TILE));

    const keep = new Set();
    for (let tx = x0; tx <= x1; tx++) {
      for (let ty = y0; ty <= y1; ty++) {
        const wx = ((tx % n) + n) % n;              // wrap across the antimeridian
        const key = `${z}/${tx}/${ty}`;
        keep.add(key);
        let img = this.tiles.get(key);
        if (!img) {
          img = new Image(TILE, TILE);
          img.decoding = 'async';
          img.referrerPolicy = 'no-referrer-when-downgrade';
          img.alt = '';
          img.src = style.url(z, wx, ty);
          img.onerror = () => img.classList.add('err');
          this.tiles.set(key, img);
          this.layer.appendChild(img);
        }
        img.style.transform = `translate(${Math.round(tx * TILE - left)}px, ${Math.round(ty * TILE - top)}px)`;
      }
    }
    for (const [key, img] of this.tiles) {
      if (!keep.has(key)) { img.remove(); this.tiles.delete(key); }
    }

    this.drawCones(lat, lon, z, left, top, W, H);

    for (const b of this.styleBtns) b.classList.toggle('active', b.dataset.k === this.style);
    this.coord.textContent = `${lat.toFixed(4)}, ${lon.toFixed(4)} · z${z}`;
    this.credit.textContent = style.credit;
  }

  /** Field-of-view wedges, projected exactly like the tiles beneath them. */
  drawCones(lat, lon, z, left, top, W, H) {
    const svg = this.coneSvg;
    if (!svg) return;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    if (!this.cones.length) { svg.innerHTML = ''; return; }
    const px = (la, lo) => {
      const p = project(la, lo, z);
      return `${(p.x - left).toFixed(1)},${(p.y - top).toFixed(1)}`;
    };
    const apex = px(lat, lon);
    const steps = 16;
    svg.innerHTML = this.cones.map(({ bearing, rangeM = 55, halfAngle = 20 }) => {
      const pts = [apex];
      for (let i = 0; i <= steps; i++) {
        const a = bearing - halfAngle + (2 * halfAngle * i) / steps;
        const [la, lo] = offsetLatLon(lat, lon, a, rangeM);
        pts.push(px(la, lo));
      }
      return `<polygon points="${pts.join(' ')}"/>`;
    }).join('');
  }

  destroy() {
    clearInterval(this.timer);
    this.timer = null;
    this.ro?.disconnect();
    this.ro = null;
    if (this.host) {
      this.host.innerHTML = '';
      this.host.classList.remove('on');
    }
  }
}

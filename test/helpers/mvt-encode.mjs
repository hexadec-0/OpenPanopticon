// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * A tiny Mapbox Vector Tile *writer*, for building test tiles with known
 * contents to feed to the app's reader (public/js/mvt.js).
 *
 * Spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */

class Writer {
  constructor() { this.bytes = []; }

  varint(n) {
    let v = n;
    // Multiplication-safe for values beyond 2^31.
    while (v >= 0x80) { this.bytes.push((v % 0x80) | 0x80); v = Math.floor(v / 0x80); }
    this.bytes.push(v);
    return this;
  }

  key(field, wire) { return this.varint(field * 8 + wire); }

  svarint(n) { return this.varint(n < 0 ? -2 * n - 1 : 2 * n); }

  bytesField(field, buf) { this.key(field, 2).varint(buf.length); this.bytes.push(...buf); return this; }

  string(field, s) { return this.bytesField(field, [...new TextEncoder().encode(s)]); }

  packed(field, nums) {
    const w = new Writer();
    for (const n of nums) w.varint(n);
    return this.bytesField(field, w.bytes);
  }

  fixed32(field, f) {
    const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, f, true);
    this.key(field, 5); this.bytes.push(...b); return this;
  }

  fixed64(field, d) {
    const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, d, true);
    this.key(field, 1); this.bytes.push(...b); return this;
  }
}

const TYPE = { unknown: 0, point: 1, line: 2, polygon: 3 };
const cmd = (id, count) => (id & 0x7) | (count << 3);
const zz = (n) => (n < 0 ? -2 * n - 1 : 2 * n);

/** Rings of flat [x, y, x, y...] in tile units -> geometry command stream. */
function geometry(type, rings) {
  const out = [];
  let cx = 0; let cy = 0;
  if (type === 'point') {
    out.push(cmd(1, rings.length));
    for (const r of rings) { out.push(zz(r[0] - cx), zz(r[1] - cy)); cx = r[0]; cy = r[1]; }
    return out;
  }
  for (const r of rings) {
    out.push(cmd(1, 1), zz(r[0] - cx), zz(r[1] - cy));
    cx = r[0]; cy = r[1];
    const n = r.length / 2 - 1;
    if (n > 0) {
      out.push(cmd(2, n));
      for (let i = 2; i < r.length; i += 2) {
        out.push(zz(r[i] - cx), zz(r[i + 1] - cy));
        cx = r[i]; cy = r[i + 1];
      }
    }
    if (type === 'polygon') out.push(cmd(7, 1));
  }
  return out;
}

function value(v) {
  const w = new Writer();
  if (typeof v === 'string') w.string(1, v);
  else if (typeof v === 'boolean') w.key(7, 0).varint(v ? 1 : 0);
  else if (Number.isInteger(v) && v >= 0) w.key(5, 0).varint(v);
  else if (Number.isInteger(v)) w.key(6, 0).svarint(v);
  else if (v && typeof v === 'object' && v.float != null) w.fixed32(2, v.float);
  else w.fixed64(3, v);
  return w.bytes;
}

/**
 * @param {{name: string, extent?: number, version?: number,
 *          features: {type: string, props?: object, rings: number[][]}[]}[]} layers
 * @param {{unknownTileField?: boolean}} [opts]  add an unknown top-level field,
 *   to check the reader skips what it does not understand
 * @returns {Uint8Array}
 */
export function encodeMvt(layers, opts = {}) {
  const tile = new Writer();
  if (opts.unknownTileField) tile.key(9, 0).varint(42);
  for (const l of layers) {
    const keys = []; const values = []; const vIndex = new Map();
    const lw = new Writer();
    if (opts.keysFirst) {
      // Dictionaries before the features: legal, and the reader must cope.
      for (const f of l.features) for (const k of Object.keys(f.props || {})) if (!keys.includes(k)) keys.push(k);
      for (const k of keys) lw.string(3, k);
    }
    lw.string(1, l.name);
    const featureBufs = [];
    for (const f of l.features) {
      const tags = [];
      for (const [k, v] of Object.entries(f.props || {})) {
        if (!keys.includes(k)) keys.push(k);
        const vk = JSON.stringify(v);
        if (!vIndex.has(vk)) { vIndex.set(vk, values.length); values.push(v); }
        tags.push(keys.indexOf(k), vIndex.get(vk));
      }
      const fw = new Writer();
      if (f.id != null) fw.key(1, 0).varint(f.id);
      if (tags.length) fw.packed(2, tags);
      fw.key(3, 0).varint(TYPE[f.type] ?? 0);
      fw.packed(4, geometry(f.type, f.rings));
      featureBufs.push(fw.bytes);
    }
    for (const b of featureBufs) lw.bytesField(2, b);
    if (!opts.keysFirst) for (const k of keys) lw.string(3, k);
    for (const v of values) lw.bytesField(4, value(v));
    lw.key(5, 0).varint(l.extent ?? 4096);
    lw.key(15, 0).varint(l.version ?? 2);
    tile.bytesField(3, lw.bytes);
  }
  return Uint8Array.from(tile.bytes);
}

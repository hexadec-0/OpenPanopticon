// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * mvt.js — a minimal Mapbox Vector Tile reader.
 *
 * Written rather than pulled in. The full decoders (pbf + @mapbox/vector-tile)
 * bring a module system and a general-purpose protobuf runtime to do a job
 * that, for this one well-specified format, is about a hundred lines. This
 * app has no build step and no dependencies, and vendoring two libraries to
 * read four field numbers would be the larger cost.
 *
 * It decodes only what the map needs: layer names, per-feature geometry, and
 * the handful of tags used to pick a colour. Label, POI and address layers
 * are the bulk of a city tile and are skipped by the caller, which is most of
 * why this is fast enough to run per tile.
 *
 * Geometry comes back in tile-local units (0..extent), as flat [x, y, x, y]
 * rings — the form a canvas wants, with no allocation per point.
 *
 * Format: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */

/** Cursor over a protobuf buffer. */
class Reader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  varint() {
    let val = 0;
    let shift = 0;
    let byte;
    do {
      byte = this.buf[this.pos++];
      // Multiplication rather than << : beyond 31 bits the shift operators
      // wrap to 32-bit and silently corrupt large ids and coordinates.
      val += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80 && this.pos < this.end);
    return val;
  }

  /** Zig-zag: protobuf's signed encoding, used for geometry deltas. */
  svarint() {
    const v = this.varint();
    return v % 2 === 1 ? (v + 1) / -2 : v / 2;
  }

  string(len) {
    const s = new TextDecoder('utf-8').decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  double() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return v;
  }

  float() {
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return v;
  }

  /** Step over a field whose contents we do not care about. */
  skip(wireType) {
    if (wireType === 0) this.varint();
    else if (wireType === 2) this.pos += this.varint();
    else if (wireType === 5) this.pos += 4;
    else if (wireType === 1) this.pos += 8;
    else throw new Error(`unsupported wire type ${wireType}`);
  }
}

const GEOM_TYPE = ['unknown', 'point', 'line', 'polygon'];

/**
 * Decode geometry commands into flat rings.
 *
 * The stream is a run of (command, parameters) where the command integer
 * packs an id and a repeat count. MoveTo starts a new ring; ClosePath ends
 * one without consuming parameters.
 */
function readGeometry(r, end) {
  const rings = [];
  let ring = null;
  let x = 0;
  let y = 0;

  while (r.pos < end) {
    const cmdInt = r.varint();
    const cmd = cmdInt & 0x7;
    const count = cmdInt >> 3;

    if (cmd === 1) {                       // MoveTo
      for (let i = 0; i < count; i++) {
        x += r.svarint();
        y += r.svarint();
        ring = [x, y];
        rings.push(ring);
      }
    } else if (cmd === 2) {                // LineTo
      if (!ring) { ring = []; rings.push(ring); }
      for (let i = 0; i < count; i++) {
        x += r.svarint();
        y += r.svarint();
        ring.push(x, y);
      }
    } else if (cmd === 7) {                // ClosePath
      ring = null;
    } else {
      break;                               // malformed; keep what we have
    }
  }
  return rings;
}

function readValue(r, end) {
  let out = null;
  while (r.pos < end) {
    const key = r.varint();
    const field = key >> 3;
    const wt = key & 7;
    if (field === 1 && wt === 2) out = r.string(r.varint());
    else if (field === 2 && wt === 5) out = r.float();
    else if (field === 3 && wt === 1) out = r.double();
    else if (field === 4 && wt === 0) out = r.varint();
    else if (field === 5 && wt === 0) out = r.varint();
    else if (field === 6 && wt === 0) out = r.svarint();
    else if (field === 7 && wt === 0) out = r.varint() !== 0;
    else r.skip(wt);
  }
  return out;
}

function readLayer(r, end, wantTags) {
  const layer = { name: null, extent: 4096, version: 1, features: [] };
  const keys = [];
  const values = [];
  const rawFeatures = [];

  while (r.pos < end) {
    const key = r.varint();
    const field = key >> 3;
    const wt = key & 7;

    if (field === 1 && wt === 2) layer.name = r.string(r.varint());
    else if (field === 2 && wt === 2) {
      // Features are parsed after the key and value dictionaries, which the
      // spec does not require to come first.
      const len = r.varint();
      rawFeatures.push([r.pos, r.pos + len]);
      r.pos += len;
    } else if (field === 3 && wt === 2) keys.push(r.string(r.varint()));
    else if (field === 4 && wt === 2) {
      const len = r.varint();
      values.push(readValue(new Reader(r.buf, r.pos, r.pos + len), r.pos + len));
      r.pos += len;
    } else if (field === 5 && wt === 0) layer.extent = r.varint();
    else if (field === 15 && wt === 0) layer.version = r.varint();
    else r.skip(wt);
  }

  for (const [start, stop] of rawFeatures) {
    const fr = new Reader(r.buf, start, stop);
    const feature = { type: 'unknown', props: null, rings: [] };
    let tagPairs = null;

    while (fr.pos < stop) {
      const key = fr.varint();
      const field = key >> 3;
      const wt = key & 7;
      if (field === 2 && wt === 2) {
        const len = fr.varint();
        const tEnd = fr.pos + len;
        tagPairs = [];
        while (fr.pos < tEnd) tagPairs.push(fr.varint());
      } else if (field === 3 && wt === 0) feature.type = GEOM_TYPE[fr.varint()] || 'unknown';
      else if (field === 4 && wt === 2) {
        const len = fr.varint();
        const gEnd = fr.pos + len;
        feature.rings = readGeometry(fr, gEnd);
        // readGeometry stops early on a malformed command. Resume after the
        // field regardless, so the rest of the feature (and tile) still parses.
        fr.pos = gEnd;
      } else fr.skip(wt);
    }

    // Only the tags the caller asked for: a city tile carries thousands of
    // features and building a full property bag for each is the slowest
    // thing here by a wide margin.
    if (tagPairs && wantTags && wantTags.size) {
      for (let i = 0; i + 1 < tagPairs.length; i += 2) {
        const k = keys[tagPairs[i]];
        if (!wantTags.has(k)) continue;
        (feature.props ||= {})[k] = values[tagPairs[i + 1]];
      }
    }
    layer.features.push(feature);
  }
  return layer;
}

/**
 * @param {Uint8Array} buf         raw tile bytes (already decompressed)
 * @param {object}   [opts]
 * @param {Set<string>} [opts.layers]  only decode these layers
 * @param {Set<string>} [opts.tags]    only decode these tag keys
 * @returns {Map<string, {name, extent, version, features}>}
 */
export function decodeMvt(buf, { layers: want = null, tags = null } = {}) {
  const out = new Map();
  const r = new Reader(buf);

  while (r.pos < r.end) {
    const key = r.varint();
    const field = key >> 3;
    const wt = key & 7;
    if (field === 3 && wt === 2) {
      const len = r.varint();
      const end = r.pos + len;
      if (want) {
        // Peek at the name before committing to parsing the whole layer.
        const peek = new Reader(buf, r.pos, end);
        let name = null;
        while (peek.pos < end && name === null) {
          const k2 = peek.varint();
          if ((k2 >> 3) === 1 && (k2 & 7) === 2) name = peek.string(peek.varint());
          else peek.skip(k2 & 7);
        }
        if (!want.has(name)) { r.pos = end; continue; }
      }
      const layer = readLayer(new Reader(buf, r.pos, end), end, tags);
      if (layer.name) out.set(layer.name, layer);
      r.pos = end;
    } else r.skip(wt);
  }
  return out;
}

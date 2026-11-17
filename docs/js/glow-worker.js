// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
//
// Night lights, off the main thread. Turns an aerial tile into warm light
// where the ground is bright and unsaturated (built surfaces), transparent
// elsewhere, then blurs it and adds it back so each light carries a halo.
// The same work as glowTile() in night.js, which it replaces whenever the
// browser has workers and OffscreenCanvas: done on the main thread it cost a
// few milliseconds a tile, and a pan brings dozens, which was felt as lag.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

self.onmessage = (e) => {
  const { id, bitmap } = e.data;
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const d = g.getImageData(0, 0, w, h);
    const a = d.data;
    for (let i = 0; i < a.length; i += 4) {
      const r = a[i] / 255; const gr = a[i + 1] / 255; const b = a[i + 2] / 255;
      const mx = Math.max(r, gr, b); const mn = Math.min(r, gr, b);
      const l = (mx + mn) / 2;
      const sat = mx === mn ? 0 : (mx - mn) / (1 - Math.abs(2 * l - 1));
      let lit = clamp01((l - 0.56) / 0.22) * (1 - clamp01((sat - 0.07) / 0.15));
      lit *= lit;
      a[i] = 255; a[i + 1] = 200 + 40 * lit; a[i + 2] = 120 + 70 * lit;
      a[i + 3] = Math.round(255 * lit);
    }
    g.putImageData(d, 0, 0);
    const out = new OffscreenCanvas(w, h);
    const o = out.getContext('2d');
    o.filter = 'blur(4px)';
    o.drawImage(c, 0, 0);
    o.drawImage(c, 0, 0);
    o.filter = 'none';
    o.globalCompositeOperation = 'lighter';
    o.drawImage(c, 0, 0);
    const result = out.transferToImageBitmap();
    self.postMessage({ id, bitmap: result }, [result]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};

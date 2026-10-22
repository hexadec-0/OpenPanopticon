// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * autocycle.js — hands-off "show me something" mode.
 *
 * While on, every N seconds it picks a random item that is currently on
 * screen (aircraft, camera, vessel, satellite, event — anything an enabled
 * layer has drawn and that would open a detail panel when clicked) and
 * selects it exactly as a click would: ring, detail panel, enrichment.
 *
 * It deliberately leaves the camera alone. The pick is already in view, and
 * flying about would fire a refetch on every jump and keep changing the set
 * of things it is choosing from.
 */

export const CYCLE_STEPS_S = [15, 30, 60];

/** Keep picks away from the very edge, where they sit under the chrome. */
const EDGE_PX = 48;

export class AutoCycle {
  /**
   * @param {object} app  needs .viewer, .layers and .selectPicked(picked)
   * @param {(state) => void} onChange  repaint hook for the button
   */
  constructor(app, onChange) {
    this.app = app;
    this.onChange = onChange || (() => {});
    this.on = false;
    this.intervalS = CYCLE_STEPS_S[0];
    this.timer = null;
    this.ticker = null;
    this.nextAt = 0;
    this.lastRecord = null;
    this.empty = false;
    // Layer ids left out of the rotation. Stored as exclusions rather than
    // inclusions so a layer added in a later build joins in by default.
    this.excluded = new Set();
  }

  /** Whether a layer's items can be picked by the cycle. */
  includes(layerId) { return !this.excluded.has(layerId); }

  setIncluded(layerId, on) {
    if (on) this.excluded.delete(layerId); else this.excluded.add(layerId);
    // If what's on screen was just ruled out, move on now, not at the timer.
    if (this.on && !on && this.lastLayer === layerId) this.advance();
    this.onChange(this);
  }

  /** Seconds until the next switch, for the button readout. */
  remaining() {
    return this.on ? Math.max(0, Math.ceil((this.nextAt - performance.now()) / 1000)) : 0;
  }

  setEnabled(on) {
    on = !!on;
    if (on === this.on) return;
    this.on = on;
    if (on) {
      // Jump straight away: a toggle that does nothing for a minute reads
      // as broken.
      this.advance();
      this.ticker = setInterval(() => this.onChange(this), 1000);
    } else {
      clearTimeout(this.timer);
      clearInterval(this.ticker);
      this.timer = this.ticker = null;
      this.empty = false;
    }
    this.onChange(this);
  }

  toggle() { this.setEnabled(!this.on); }

  setIntervalS(s) {
    if (!CYCLE_STEPS_S.includes(s)) return;
    this.intervalS = s;
    if (this.on) this.schedule();
    this.onChange(this);
  }

  /**
   * A manual pick resets the countdown, so whatever the operator chose
   * stays up for a full interval instead of being yanked away early.
   */
  restart() { if (this.on) this.schedule(); }

  schedule() {
    clearTimeout(this.timer);
    this.nextAt = performance.now() + this.intervalS * 1000;
    this.timer = setTimeout(() => this.advance(), this.intervalS * 1000);
    this.onChange(this);
  }

  advance() {
    if (!this.on) return;
    let pool = [];
    try { pool = this.candidates(); } catch (e) { console.warn('auto-cycle scan failed', e); }

    // Never land on the same thing twice running when there is a choice.
    if (pool.length > 1) pool = pool.filter((c) => c.record !== this.lastRecord);

    this.empty = pool.length === 0;
    if (!this.empty) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      this.lastRecord = pick.record;
      this.lastLayer = pick.layerId;
      try { this.app.selectPicked(pick.picked); } catch (e) { console.warn('auto-cycle select failed', e); }
    }
    this.schedule();
  }

  /**
   * Left edge of the right-hand detail pane in canvas coordinates, as it
   * sits when open. Infinity if there is no pane to avoid.
   */
  rightPaneLeft() {
    const pane = document.getElementById('detail');
    if (!pane) return Infinity;
    const width = pane.offsetWidth;
    if (!width || getComputedStyle(pane).display === 'none') return Infinity;
    const canvasLeft = this.app.viewer.scene.canvas.getBoundingClientRect().left;
    return (window.innerWidth - width) - canvasLeft;
  }

  /**
   * Everything selectable that is in front of the camera and inside the
   * viewport, shaped like the result of scene.pick() so it can go through
   * the same selection path as a click.
   */
  candidates() {
    const { viewer, layers } = this.app;
    const scene = viewer.scene;
    const time = viewer.clock.currentTime;
    const w = scene.canvas.clientWidth;
    const h = scene.canvas.clientHeight;
    const toWindow = Cesium.SceneTransforms.worldToWindowCoordinates
      || Cesium.SceneTransforms.wgs84ToWindowCoordinates;
    const occluder = scene.mode === Cesium.SceneMode.SCENE3D
      ? new Cesium.EllipsoidalOccluder(scene.globe.ellipsoid, scene.camera.positionWC)
      : null;

    // The detail pane on the right covers part of the globe, and making a
    // pick opens it, so anything under it would be selected out of sight.
    // Use the pane's open footprint (offsetWidth ignores the slide-out
    // transform) so this holds whether it is open yet or not.
    const maxX = Math.min(w - EDGE_PX, this.rightPaneLeft() - EDGE_PX);

    const inView = (p) => {
      if (!p) return false;
      if (occluder && !occluder.isPointVisible(p)) return false;   // far side of the globe
      const win = toWindow(scene, p);
      return !!win && win.x >= EDGE_PX && win.x <= maxX
        && win.y >= EDGE_PX && win.y <= h - EDGE_PX;
    };

    const out = [];
    const seen = new Set();   // one entry per record, however many graphics it has

    for (const [id, layer] of Object.entries(layers)) {
      if (!layer?.enabled || typeof layer.detail !== 'function') continue;
      if (this.excluded.has(id)) continue;

      // Entity-backed layers.
      for (const ent of layer.source?.entities?.values || []) {
        if (!ent.position || !ent.properties?.layer) continue;   // orbits, cones, polygons
        if (ent.isShowing === false) continue;
        const record = ent.properties.record?.getValue?.(time) ?? ent.properties.record;
        if (!record || seen.has(record)) continue;
        let p;
        try { p = ent.position.getValue(time); } catch { continue; }
        if (!inView(p)) continue;
        seen.add(record);
        out.push({ record, layerId: id, picked: { id: ent } });
      }

      // Collection-backed layers (satellites).
      const pts = layer.points;
      if (pts && pts.show !== false && typeof pts.get === 'function') {
        for (let i = 0; i < pts.length; i++) {
          const pt = pts.get(i);
          if (!pt?.show || !pt.id?.layer) continue;
          const record = pt.id.record;
          if (!record || seen.has(record)) continue;
          if (!inView(pt.position)) continue;
          seen.add(record);
          out.push({ record, layerId: id, picked: { primitive: pt, id: pt.id } });
        }
      }
    }
    return out;
  }
}

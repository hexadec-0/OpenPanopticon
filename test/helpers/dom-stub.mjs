// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * The small slice of browser globals the client modules touch outside the
 * DOM proper: localStorage, location, document.body.classList, a canvas that
 * records what was drawn on it, and performance.now.
 *
 * Anything that needs a real DOM (the inset map, the detail panel) is tested
 * in Chromium by the Puppeteer suite instead.
 */

export class MemoryStorage {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); this.throwOnWrite = false; }

  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }

  setItem(k, v) {
    if (this.throwOnWrite) throw new Error('QuotaExceededError');
    this.map.set(k, String(v));
  }

  removeItem(k) { this.map.delete(k); }

  clear() { this.map.clear(); }

  get length() { return this.map.size; }
}

/** A 2D context that logs every call and property set, for drawing assertions. */
export function recordingCanvas() {
  const calls = [];
  const ctx = new Proxy({}, {
    get(_t, prop) {
      if (prop === 'calls') return calls;
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return (...a) => { calls.push([prop, ...a]); return { addColorStop: (...s) => calls.push(['addColorStop', ...s]) }; };
      }
      return (...a) => { calls.push([prop, ...a]); };
    },
    set(_t, prop, value) { calls.push([`set:${String(prop)}`, value]); return true; },
  });
  return {
    width: 0, height: 0, ctx,
    getContext: () => ctx,
    toDataURL: () => 'data:image/png;base64,STUB',
  };
}

/** A bare-bones element: attributes, children, classes, style. */
export class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.attributes = {};
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this._html = '';
    const classes = new Set();
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on ?? !classes.has(c); if (v) classes.add(c); else classes.delete(c); return v; },
    };
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }

  getAttribute(k) { return this.attributes[k] ?? null; }

  append(...nodes) { this.children.push(...nodes); }

  appendChild(n) { this.children.push(n); return n; }

  remove() { this.removed = true; }

  get innerHTML() { return this._html; }

  set innerHTML(v) { this._html = String(v); this.children = []; }

  /** Slots by data-slot name, for code that writes into the detail panel. */
  querySelector(sel) {
    const m = /\[data-slot="([^"]+)"\]/.exec(sel);
    if (!m) return null;
    this._slots ||= {};
    return (this._slots[m[1]] ||= new FakeElement('div'));
  }
}

export function installDom({ storage = new MemoryStorage(), origin = 'http://127.0.0.1:8420/' } = {}) {
  const classes = new Set();
  const created = [];
  globalThis.localStorage = storage;
  globalThis.location = new URL(origin);
  globalThis.document = {
    body: {
      classList: {
        contains: (c) => classes.has(c),
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => { const v = on ?? !classes.has(c); if (v) classes.add(c); else classes.delete(c); return v; },
      },
    },
    createElement(tag) {
      const el = tag === 'canvas' ? recordingCanvas() : new FakeElement(tag);
      created.push(el);
      return el;
    },
    getElementById: () => null,
    _created: created,
  };
  globalThis.window = globalThis.window || globalThis;
  return { storage, classes, created };
}

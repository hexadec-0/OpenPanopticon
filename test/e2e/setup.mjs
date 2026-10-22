// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * Shared setup for the browser suite: one server (in-process, fake
 * upstreams) and one Chrome per test file, torn down afterwards.
 *
 * Without a browser the suite is skipped with the reason, unless
 * E2E_REQUIRED=1 (as in CI), where a missing browser is a failure.
 */
import { describe, before, after } from 'node:test';
import { createRequire } from 'node:module';
import { e2eUnavailable, launchBrowser, openApp } from '../helpers/browser.mjs';

const require = createRequire(import.meta.url);
export const { startServer } = require('../helpers/harness.cjs');
export const { TEST_KEYS, HOME } = require('../helpers/fixtures.cjs');
export const { json, text, status } = require('../helpers/responses.cjs');

const unavailable = e2eUnavailable();
if (unavailable && process.env.E2E_REQUIRED === '1') {
  throw new Error(`E2E_REQUIRED is set but ${unavailable}`);
}

/** describe() that skips cleanly when there is no browser to drive. */
export function e2e(name, fn) {
  return describe(name, { skip: unavailable || false, timeout: 300_000 }, fn);
}

/**
 * Start a server and a browser for this describe block.
 * Returns a holder whose fields are filled in by the before() hook.
 */
export function useStack({ env = { ...TEST_KEYS } } = {}) {
  const ctx = { server: null, browser: null, pages: [] };
  before(async () => {
    ctx.server = await startServer({ env });
    ctx.browser = await launchBrowser();
  });
  after(async () => {
    for (const p of ctx.pages) await p.close().catch(() => {});
    await ctx.browser?.close().catch(() => {});
    await ctx.server?.close();
  });
  /** Open the app in a fresh tab (fresh localStorage unless `keepStorage`). */
  ctx.open = async (opts = {}) => {
    // One tab at a time: earlier tabs keep polling and rendering otherwise.
    if (!opts.keepOthers) {
      for (const p of ctx.pages.splice(0)) await p.close().catch(() => {});
    }
    const app = await openApp(ctx.browser, ctx.server.base, opts);
    ctx.pages.push(app.page);
    return app;
  };
  /** Reset upstream overrides and the server's caches between tests. */
  ctx.reset = async () => {
    ctx.server.mock.reset();
    ctx.server.mod.cache.clear();
    await ctx.server.mod.clearDiskCache();
    Object.assign(ctx.server.mod.openSky, { remaining: null, limit: null, checkedAt: 0, blockedUntil: 0 });
  };
  return ctx;
}

/** Visible text of an element. */
export const text$ = (page, sel) => page.$eval(sel, (n) => n.textContent.trim());

/** Whether an element has a class. */
export const hasClass = (page, sel, cls) => page.$eval(sel, (n, c) => n.classList.contains(c), cls);

/** Wait until an element has (or lacks) a class. */
export function waitClass(page, sel, cls, present = true, timeout = 15_000) {
  return page.waitForFunction((s, c, p) => {
    const n = document.querySelector(s);
    return n && n.classList.contains(c) === p;
  }, { timeout, polling: 100 }, sel, cls, present);
}

/** Wait for a toast containing some text to have been shown. */
export function waitToast(page, re, timeout = 10_000) {
  return page.waitForFunction((src) => (window.__toasts || []).some((t) => new RegExp(src).test(t)),
    { timeout, polling: 100 }, re.source);
}

/** Wait for the debounced settings save to contain something. */
export function waitSaved(page, predSrc, timeout = 5000) {
  return page.waitForFunction((src) => {
    try { return new Function('s', `return (${src})(s)`)(JSON.parse(localStorage.getItem('openpanopticon.settings.v1') || 'null')); }
    catch { return false; }
  }, { timeout, polling: 100 }, predSrc.toString());
}

/** The layer panel row for a layer. */
export const row = (id) => `.layer[data-layer="${id}"]`;

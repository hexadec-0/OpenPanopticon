// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * Puppeteer plumbing for the end-to-end suite.
 *
 * - Finds an installed Chrome, Chromium or Edge (puppeteer-core downloads
 *   nothing). Override with CHROME_PATH.
 * - Runs the page fully offline apart from the server under test. Map tiles,
 *   webcam frames, fonts and photos are answered with tiny stand-ins, and any
 *   other third-party request is refused and recorded, so a test can assert
 *   nothing unexpected (an API key, say) ever left the browser.
 * - Cesium comes from cdnjs, as in production. Set CESIUM_DIR to a local copy
 *   of the npm package's Build/Cesium folder to run with no network at all;
 *   the files are byte-identical, so the page's SRI hashes still match.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PNG_1PX } = require('./responses.cjs');

export const CESIUM_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/cesium/1.145.0/';

const MIME = {
  '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary', '.xml': 'application/xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

/** Locate a Chromium-family browser on this machine. */
export function findChrome() {
  const env = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH;
  if (env) return fs.existsSync(env) ? env : null;

  const candidates = [];
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
      candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    );
  } else {
    for (const dir of (process.env.PATH || '').split(':')) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
        candidates.push(path.join(dir, name));
      }
    }
    // Playwright's bundled Chromium, where one is installed.
    const pw = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    try {
      for (const d of fs.readdirSync(pw).filter((n) => /^chromium-\d+$/.test(n)).sort().reverse()) {
        candidates.push(path.join(pw, d, 'chrome-linux', 'chrome'), path.join(pw, d, 'chrome-linux64', 'chrome'));
      }
    } catch { /* not installed */ }
  }
  return candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/** Why e2e cannot run here, or null when it can. */
export function e2eUnavailable() {
  return findChrome() ? null
    : 'no Chrome, Chromium or Edge found — install one or set CHROME_PATH';
}

/** Serve a local Cesium build over loopback, for the workers and assets. */
function serveCesium(dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
      const file = path.join(dir, rel);
      if (!file.startsWith(dir)) { res.writeHead(403).end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end(); return; }
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
          'Access-Control-Allow-Origin': '*',
        });
        res.end(buf);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

export async function launchBrowser() {
  const puppeteer = (await import('puppeteer-core')).default;
  const executablePath = findChrome();
  if (!executablePath) throw new Error(e2eUnavailable());
  const args = [
    // WebGL without a GPU: SwiftShader software rendering.
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows', '--no-first-run', '--no-default-browser-check',
  ];
  // Chrome refuses its sandbox as root (CI containers); harmless elsewhere to keep it.
  if (process.getuid?.() === 0 || process.env.CI) args.push('--no-sandbox');
  const browser = await puppeteer.launch({
    executablePath,
    headless: process.env.HEADFUL ? false : true,
    args,
    defaultViewport: { width: 1400, height: 900 },
  });

  let cesium = null;
  const dir = process.env.CESIUM_DIR && path.resolve(process.env.CESIUM_DIR);
  if (dir) {
    if (!fs.existsSync(path.join(dir, 'Cesium.js'))) throw new Error(`CESIUM_DIR has no Cesium.js: ${dir}`);
    cesium = { dir, ...(await serveCesium(dir)) };
  }
  const realClose = browser.close.bind(browser);
  browser.close = async () => { cesium?.srv.close(); await realClose(); };
  browser.cesium = cesium;
  return browser;
}

const IMAGE_HOSTS = /(tile\.openstreetmap\.org|arcgisonline\.com|gibs\.earthdata\.nasa\.gov|rainviewer\.com|titiler|basemaps\.cartocdn\.com|images\.|photos\.|img\.|thumbs|webcams|windy|alertcalifornia|nyctmc|openwebcamdb|511ga|earthengine|virtualearth|sentinel)/i;

/**
 * Open the app and wait for boot to finish.
 *
 * @param {object} browser  from launchBrowser()
 * @param {string} base     the server under test, e.g. http://127.0.0.1:1234
 * @param {object} [opts]
 * @param {object} [opts.storage]   localStorage entries to seed before boot
 * @param {boolean} [opts.waitForBoot=true]
 * @param {(req) => boolean|void} [opts.intercept]  return true to say "handled"
 * @param {object} [opts.context]  reuse a browser context (shared localStorage)
 */
export async function openApp(browser, base, { storage = null, waitForBoot = true, intercept = null, context = null } = {}) {
  // Each app gets its own incognito context unless one is passed in, so
  // localStorage (saved settings) never leaks from one test into the next.
  const ctx = context || await browser.createBrowserContext();
  const page = await ctx.newPage();
  if (!context) {
    const close = page.close.bind(page);
    page.close = async (o) => { await close(o).catch(() => {}); await ctx.close().catch(() => {}); };
  }
  const external = [];      // third-party requests the page tried to make
  const errors = [];        // uncaught page errors
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push(e));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.isInterceptResolutionHandled()) return;
    const url = req.url();
    if (intercept && intercept(req) === true) return;
    if (url.startsWith(base) || url.startsWith('data:') || url.startsWith('blob:')) { req.continue(); return; }

    // Cesium itself.
    if (url.startsWith(CESIUM_CDN)) {
      const cz = browser.cesium;
      if (!cz) { req.continue(); return; }
      const rel = url.slice(CESIUM_CDN.length).split(/[?#]/)[0];
      try {
        const body = fs.readFileSync(path.join(cz.dir, rel));
        req.respond({ status: 200, body, headers: { 'Access-Control-Allow-Origin': '*' },
          contentType: MIME[path.extname(rel)] || 'application/octet-stream' });
      } catch { req.respond({ status: 404, body: '' }); }
      return;
    }
    // When Cesium is local, point its workers and assets at the loopback copy.
    if (browser.cesium && url === `${base}/js/cesium-base.js`) {
      req.respond({ status: 200, contentType: 'text/javascript',
        body: `window.CESIUM_BASE_URL = ${JSON.stringify(browser.cesium.base)};` });
      return;
    }

    external.push(url);
    if (/fonts\.googleapis\.com/.test(url)) { req.respond({ status: 200, contentType: 'text/css', body: '' }); return; }
    if (/fonts\.gstatic\.com/.test(url)) { req.respond({ status: 404, body: '' }); return; }
    // Vector tiles: "nothing here", which the Shortbread provider draws as blank.
    if (/versatiles\.org/.test(url)) {
      req.respond({ status: 204, headers: { 'Access-Control-Allow-Origin': '*' }, body: '' });
      return;
    }
    if (req.resourceType() === 'image' || IMAGE_HOSTS.test(url)) {
      req.respond({ status: 200, contentType: 'image/png', body: PNG_1PX, headers: { 'Access-Control-Allow-Origin': '*' } });
      return;
    }
    if (req.resourceType() === 'document' && req.frame() !== page.mainFrame()) {
      // Webcam player iframes.
      req.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>player</title>' });
      return;
    }
    req.respond({ status: 404, body: '' });
  });

  // Record every toast as it appears. The app clears #alerts whenever layer
  // status is redrawn, so a toast can be gone before a poll would see it.
  await page.evaluateOnNewDocument(() => {
    window.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => {
      const bar = document.querySelector('#alerts');
      if (!bar) return;
      new MutationObserver((muts) => {
        for (const m of muts) for (const n of m.addedNodes) if (n.classList?.contains('alert')) window.__toasts.push(n.textContent);
      }).observe(bar, { childList: true });
    });
  });

  if (storage) {
    // Seed once per tab: a reload must see what the app saved, not the seed.
    await page.evaluateOnNewDocument((entries) => {
      if (sessionStorage.getItem('__seeded')) return;
      sessionStorage.setItem('__seeded', '1');
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
    }, storage);
  }

  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  if (waitForBoot) await waitForBooted(page);
  return { page, context: ctx, external, errors, consoleErrors };
}

/** Boot is done when the boot screen has faded and the session is restored. */
export async function waitForBooted(page, timeout = 90_000) {
  await page.waitForFunction(() => {
    const boot = document.querySelector('#boot');
    return window.WV?.layers?.flights && window.WV.restoring === false
      && (!boot || boot.classList.contains('gone'));
  }, { timeout, polling: 200 });
}

/** Wait until a layer has finished a fetch (ok or error). */
export function waitForLayer(page, id, { status = 'ok', timeout = 30_000 } = {}) {
  return page.waitForFunction((lid, want) => {
    const l = window.WV?.layers?.[lid];
    return l && (Array.isArray(want) ? want.includes(l.status) : l.status === want);
  }, { timeout, polling: 100 }, id, status);
}

/**
 * Point the camera straight down over a place and refetch, so the view box is
 * predictable regardless of where boot left it.
 */
export async function lookAt(page, { lat, lon, h = 3000 }) {
  await page.evaluate(({ lat, lon, h }) => {
    // A flyTo still in progress would carry on and override this.
    window.WV.viewer.camera.cancelFlight();
    window.WV.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, h),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
    });
  }, { lat, lon, h });
}

/** Text of an element, or null. */
export function textOf(page, sel) {
  return page.$eval(sel, (n) => n.textContent).catch(() => null);
}

/** Select the first drawn record of a layer exactly as a click would. */
export function pickFirst(page, layerId, pred = null) {
  return page.evaluate((id, predSrc) => {
    const layer = window.WV.layers[id];
    const test = predSrc ? new Function('r', `return (${predSrc})(r)`) : () => true;
    if (layer.points) {
      for (let i = 0; i < layer.points.length; i++) {
        const pt = layer.points.get(i);
        if (pt.id?.record && test(pt.id.record)) return window.WV.selectPicked({ primitive: pt, id: pt.id });
      }
      return 'none';
    }
    const t = window.WV.viewer.clock.currentTime;
    for (const ent of layer.source.entities.values) {
      if (!ent.properties?.layer || !ent.position) continue;
      const rec = ent.properties.record?.getValue?.(t) ?? ent.properties.record;
      if (test(rec)) return window.WV.selectPicked({ id: ent });
    }
    return 'none';
  }, layerId, pred ? pred.toString() : null);
}

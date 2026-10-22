// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * Load server.js in-process, with a clean configuration, fake upstreams and a
 * throwaway data directory, and listen on a free loopback port.
 *
 * Each startServer() call re-requires server.js, so every test file (or every
 * test that wants one) gets a fresh module with its own caches, OpenSky
 * budget, AIS table and access key. Nothing is read from the real .env and
 * nothing is written to the real providers/ cache.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { UpstreamMock } = require('./upstream.cjs');
const { FakeWebSocket } = require('./fake-websocket.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server.js');

/** Every variable server.js reads. Cleared before each load so the shell can't leak in. */
const CONFIG_VARS = [
  'PORT', 'HOST', 'ALLOWED_HOSTS', 'ACCESS_KEY',
  'SHODAN_API_KEY', 'WINDY_API_KEY', 'CESIUM_ION_TOKEN', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET',
  'OPENWEBCAMDB_API_KEY', 'FIRMS_MAP_KEY', 'EDIS_API_URL', 'EDIS_API_KEY', 'AISSTREAM_API_KEY',
  'OPENCELLID_API_KEY', 'WIGLE_API_NAME', 'WIGLE_API_TOKEN', 'GREYNOISE_API_KEY', 'EIA_API_KEY',
  'CLOUDFLARE_API_TOKEN', 'CARTO_API_KEY', 'FIVE_ELEVEN_KEYS',
  'SHODAN_CELL_DEG', 'SHODAN_MAX_DEG', 'SHODAN_CREDIT_FLOOR', 'OPENSKY_CREDIT_FLOOR',
  'SHORTBREAD_URL', 'TITILER_URL', 'GEE_PROJECT', 'GEE_CLIENT_EMAIL', 'GEE_PRIVATE_KEY',
  'OPENPANOPTICON_OPEN_BROWSER', 'OPENPANOPTICON_DATA_DIR', 'OPENPANOPTICON_ENV_FILE', 'OPENPANOPTICON_QUIET',
];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * Load server.js as a module with a controlled environment, without listening.
 * For unit tests of the helpers it exports.
 */
function loadServer({ env = {}, mock = null, dataDir = null } = {}) {
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'op-test-'));
  const saved = {};
  for (const k of CONFIG_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, {
    PORT: '8420',
    HOST: '127.0.0.1',
    OPENPANOPTICON_ENV_FILE: path.join(dir, 'missing.env'),
    OPENPANOPTICON_DATA_DIR: dir,
    OPENPANOPTICON_QUIET: '1',
  }, Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])));

  if (mock) mock.install();
  const realWs = globalThis.WebSocket;
  globalThis.WebSocket = FakeWebSocket;
  FakeWebSocket.reset();

  delete require.cache[SERVER];
  const mod = require(SERVER);

  const restore = () => {
    if (mock) mock.uninstall();
    globalThis.WebSocket = realWs;
    for (const k of CONFIG_VARS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
  return { mod, dataDir: dir, restore };
}

/** Plain HTTP client, so tests can set any Host header and see raw responses. */
function request(port, pathname, { method = 'GET', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    // host === '' sends no Host header at all.
    const hostHeader = host === '' ? {} : { Host: host ?? `127.0.0.1:${port}` };
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { ...hostHeader, ...headers },
      setHost: false,
      agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          buffer: buf,
          text,
          json() { return JSON.parse(text); },
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Start the server on a free port with fake upstreams.
 *
 * @param {object} opts
 * @param {object} [opts.env]   extra environment (API keys, HOST, …)
 * @param {UpstreamMock} [opts.mock]  defaults to a mock with every fixture
 */
async function startServer({ env = {}, mock = new UpstreamMock() } = {}) {
  const port = Number(env.PORT) || await freePort();
  const loaded = loadServer({ env: { ...env, PORT: port }, mock });
  const { mod } = loaded;
  await new Promise((resolve) => mod.server.listen(port, '127.0.0.1', resolve));

  const base = `http://127.0.0.1:${port}`;

  /** GET (or POST) an /api route with the header the app always sends. */
  const api = (pathname, params = {}, opts = {}) => {
    const u = new URL(pathname, base);
    for (const [k, v] of Object.entries(params || {})) if (v != null) u.searchParams.set(k, v);
    return request(port, u.pathname + u.search, {
      ...opts, headers: { 'X-Panopticon': '1', ...(opts.headers || {}) },
    });
  };

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { mod.ais.socket?.close(); } catch { /* fake socket */ }
    clearTimeout(mod.ais.reconnectTimer);
    mod.server.closeAllConnections?.();
    await new Promise((resolve) => mod.server.close(() => resolve()));
    loaded.restore();
    fs.rmSync(loaded.dataDir, { recursive: true, force: true });
  };

  return {
    mod, port, base, mock, dataDir: loaded.dataDir,
    request: (p, o) => request(port, p, o),
    api, close,
  };
}

module.exports = { startServer, loadServer, request, freePort, ROOT, SERVER, CONFIG_VARS };

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
'use strict';
/**
 * Run server.js as the launch scripts do — `node server.js` — and check the
 * process itself: the banner, the port, the /api/health answer, a .env file
 * being honoured, and a prompt exit on SIGTERM.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freePort, request, SERVER, CONFIG_VARS } = require('../helpers/harness.cjs');

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const k of CONFIG_VARS) delete env[k];
  return { ...env, ...extra };
}

async function launch(extraEnv = {}, envFileText = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-start-'));
  const envFile = path.join(dir, '.env');
  if (envFileText != null) fs.writeFileSync(envFile, envFileText);
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: cleanEnv({ PORT: String(port), OPENPANOPTICON_DATA_DIR: dir, OPENPANOPTICON_ENV_FILE: envFile, NO_COLOR: '1', ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (b) => { out += b; });
  child.stderr.on('data', (b) => { out += b; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no banner within 10s:\n${out}`)), 10_000);
    const check = () => { if (/Cesium Ion \.+/.test(out)) { clearTimeout(t); resolve(); } };
    child.stdout.on('data', check);
    child.on('exit', (code) => { clearTimeout(t); reject(new Error(`exited ${code}:\n${out}`)); });
  });
  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    const started = Date.now();
    child.once('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - started }));
    child.kill('SIGTERM');
  });
  return { child, port, dir, out: () => out.replace(/\x1b\[[0-9;]*m/g, ''), stop, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('node server.js', () => {
  test('prints the banner with the URL and no version, and answers /api/health', async () => {
    const p = await launch();
    try {
      const out = p.out();
      assert.match(out, new RegExp(`▸ http://127\\.0\\.0\\.1:${p.port}`));
      assert.doesNotMatch(out, /ver\.\s*\d/);
      assert.match(out, /Shodan \.+ not configured/);
      assert.match(out, /OpenSky \.+ anonymous/);
      assert.doesNotMatch(out, /Censys/);
      const r = await request(p.port, '/api/health', { headers: { 'X-Panopticon': '1' } });
      assert.equal(r.status, 200);
      assert.equal(r.json().ok, true);
    } finally { await p.stop(); p.cleanup(); }
  });

  test('reads its configuration from the .env file', async () => {
    const p = await launch({}, 'SHODAN_API_KEY="from-env-file"\nOPENSKY_CLIENT_ID=id\nOPENSKY_CLIENT_SECRET=secret\n');
    try {
      assert.match(p.out(), /Shodan \.+ ready/);
      assert.match(p.out(), /OpenSky \.+ authenticated/);
    } finally { await p.stop(); p.cleanup(); }
  });

  test('bound beyond loopback, prints the access-key URL and a warning', async () => {
    const p = await launch({ HOST: '127.0.0.1', ACCESS_KEY: 'k' });
    try { assert.doesNotMatch(p.out(), /\?key=/); } finally { await p.stop(); p.cleanup(); }
    const q = await launch({ HOST: '0.0.0.0', ACCESS_KEY: 'printed-key' });
    try {
      assert.match(q.out(), /\?key=printed-key/);
      assert.match(q.out(), /beyond this machine/);
      assert.equal((await request(q.port, '/')).status, 401);
    } finally { await q.stop(); q.cleanup(); }
  });

  test('exits promptly on SIGTERM, even with a keep-alive connection open', async () => {
    const p = await launch();
    try {
      const http = require('node:http');
      const agent = new http.Agent({ keepAlive: true });
      await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port: p.port, path: '/', agent }, (res) => { res.resume(); res.on('end', resolve); });
      });
      const res = await p.stop();
      assert.ok(res.ms < 3500, `took ${res.ms}ms`);
      if (process.platform !== 'win32') assert.match(p.out(), /shutting down \(SIGTERM\)/);
      agent.destroy();
    } finally { p.cleanup(); }
  });

  test('requiring the module does not listen or print anything', () => {
    const r = require('node:child_process').spawnSync(process.execPath,
      ['-e', `const s = require(${JSON.stringify(SERVER)}); process.stdout.write(String(s.server.listening))`],
      { env: cleanEnv({ OPENPANOPTICON_ENV_FILE: path.join(os.tmpdir(), 'nope.env') }), encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.stdout, 'false');
    assert.equal(r.status, 0);
  });
});

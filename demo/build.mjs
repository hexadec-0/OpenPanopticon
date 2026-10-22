#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
/**
 * Build the static GitHub Pages demo next to a captured snapshot.
 *
 *   node demo/build.mjs [--out docs]
 *
 * Copies the app (public/) into --out, adds the demo runtime (demo/site/),
 * and points index.html at it. The snapshot from demo/capture.mjs must
 * already be in --out/data. Runs offline in a few seconds, so it can be
 * re-run after any change to the app without capturing again.
 *
 * Before finishing it scans every output file for the values in your .env
 * and fails, naming the variable, if one appears anywhere.
 *
 * To publish: commit --out (docs/ by default) and, in the repository's
 * Settings → Pages, serve the main branch from the /docs folder.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const o = { out: path.join(ROOT, 'docs'), env: path.join(ROOT, '.env') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') o.out = path.resolve(argv[++i]);
    else if (argv[i] === '--env') o.env = path.resolve(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') o.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return o;
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else if (e.isFile()) fs.copyFileSync(a, b);
  }
}

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

/** Values from .env worth searching for: long enough to be a secret. */
export function secretsFrom(envText) {
  const out = [];
  for (const line of String(envText || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!/(KEY|TOKEN|SECRET|PASSWORD|CLIENT|NAME|EMAIL)/.test(m[1])) continue;
    // FIVE_ELEVEN_KEYS and friends hold several values; check each part too.
    const parts = new Set([v, ...v.split(/[\s,;:=|]+/)]);
    for (const p of parts) if (p.length >= 10) out.push({ name: m[1], value: p });
  }
  return out;
}

/** Files under `dir` containing any of `secrets`. */
export function findSecrets(dir, secrets) {
  const hits = [];
  if (!secrets.length) return hits;
  const needles = secrets.map((s) => ({ ...s, buf: Buffer.from(s.value) }));
  for (const file of walk(dir)) {
    const buf = fs.readFileSync(file);
    for (const n of needles) {
      if (buf.includes(n.buf)) hits.push({ file: path.relative(dir, file), name: n.name });
    }
  }
  return hits;
}

export function demoIndex(html) {
  const head = '<script src="demo/manifest.js"></script>\n<script src="demo/demo.js"></script>\n'
    + '<link rel="stylesheet" href="demo/demo.css">\n';
  if (!html.includes('<script src="js/cesium-base.js"></script>')) {
    throw new Error('index.html no longer loads js/cesium-base.js; update demo/build.mjs');
  }
  return html
    .replace(/<title>([^<]*)<\/title>/, '<title>$1 (demo)</title>')
    .replace('<script src="js/cesium-base.js"></script>', `${head}<script src="js/cesium-base.js"></script>`);
}

export function build({ out, env }, log = console.log) {
  const manifestFile = path.join(out, 'data', 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`No snapshot in ${out}/data. Run "node demo/capture.mjs" first.`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));

  // The app, then the demo runtime beside it.
  copyDir(path.join(ROOT, 'public'), out);
  copyDir(path.join(ROOT, 'demo', 'site'), path.join(out, 'demo'));

  const { steps, ...light } = manifest;
  const summary = { ...light, steps: Object.fromEntries(Object.entries(steps || {}).map(([k, s]) => [k, !!s.ok])) };
  fs.writeFileSync(path.join(out, 'demo', 'manifest.js'),
    '// Written by demo/build.mjs from data/manifest.json.\n'
    + `window.OP_DEMO_MANIFEST = ${JSON.stringify(summary)};\n`);

  const indexFile = path.join(out, 'index.html');
  fs.writeFileSync(indexFile, demoIndex(fs.readFileSync(indexFile, 'utf8')));

  // GitHub Pages runs Jekyll by default, which skips some paths and slows the
  // deploy. This site needs none of it.
  fs.writeFileSync(path.join(out, '.nojekyll'), '');

  let envText = '';
  try { envText = fs.readFileSync(env, 'utf8'); } catch { /* no .env: nothing to scan for */ }
  const hits = findSecrets(out, secretsFrom(envText));
  if (hits.length) {
    const lines = hits.map((h) => `    ${h.file}: contains the value of ${h.name}`).join('\n');
    throw new Error(`Refusing to finish: values from .env are in the output.\n${lines}\n`
      + '  Remove those files (or the whole folder) and capture again.');
  }

  let bytes = 0;
  let count = 0;
  let largest = { file: null, bytes: 0 };
  for (const f of walk(out)) {
    const n = fs.statSync(f).size;
    bytes += n;
    count++;
    if (n > largest.bytes) largest = { file: path.relative(out, f), bytes: n };
  }
  const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
  log(`  Built ${count} files, ${mb(bytes)}, in ${out}`);
  log(`  Snapshot time ${new Date(manifest.capturedAt).toISOString()}`);
  if (largest.bytes > 50e6) log(`  Warning: ${largest.file} is ${mb(largest.bytes)}; GitHub warns above 50 MB and refuses 100 MB.`);
  if (bytes > 900e6) log('  Warning: GitHub Pages sites are limited to 1 GB.');
  return { files: count, bytes, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(3, 19)
        .map((l) => l.replace(/^ \* ?|^\/\*\*|^ \*\//, '')).join('\n'));
      process.exit(0);
    }
    build(opts);
    console.log('\n  To publish: commit the folder and set Settings → Pages to serve it.\n');
  } catch (e) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
}

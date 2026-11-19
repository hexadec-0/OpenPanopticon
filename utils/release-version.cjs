// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 hexadec
//
// Prints the version for a release zip, for utils/release.sh and
// utils/release.bat:
//
//   <X.X.X> <short commit> <commits since> <commit|tag>
//
// Walks back from HEAD to the newest commit that is marked as a release,
// either because its message starts with a version ("v1.3.3", "v1.3.3.",
// "v1.3.3 - notes") or because a vX.X.X tag points at it. Other tags, such
// as "Prod", are ignored. If a commit has more than one version, the highest
// wins. Exits 1 with a message on stderr when nothing is found.
'use strict';

const { execFileSync } = require('node:child_process');

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const VERSION_TAG = /^v?(\d+\.\d+\.\d+)$/i;
// Only at the start of the message, so "Fix the v1.2.0 parser" does not count.
const VERSION_SUBJECT = /^\s*v(\d+\.\d+\.\d+)(?![\d.]*\d)/i;

const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

function fail(msg) {
  process.stderr.write(`  ${msg}\n`);
  process.exit(1);
}

let log, refs;
try {
  log = git('log', '--format=%H%x09%s');
  refs = git('for-each-ref', 'refs/tags', '--format=%(*objectname) %(objectname) %(refname:short)');
} catch {
  fail('Could not read the git history. Run this inside the repo, or pass a version.');
}

// commit hash -> versions from tags pointing at it (annotated tags resolve
// through *objectname, lightweight ones through objectname).
const tagged = new Map();
for (const line of refs.split('\n')) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) continue;
  // "<commit> <tag object> <name>" when annotated, "<commit> <name>" when not.
  const name = parts[parts.length - 1];
  const commit = parts[0];
  const m = VERSION_TAG.exec(name);
  if (!m) continue;
  if (!tagged.has(commit)) tagged.set(commit, []);
  tagged.get(commit).push(m[1]);
}

const commits = log.split('\n').filter(Boolean);
for (let i = 0; i < commits.length; i++) {
  const [hash, subject = ''] = commits[i].split('\t');
  const found = [];
  const s = VERSION_SUBJECT.exec(subject);
  if (s) found.push({ v: s[1], kind: 'commit' });
  for (const v of tagged.get(hash) || []) found.push({ v, kind: 'tag' });
  if (!found.length) continue;
  found.sort((a, b) => cmp(b.v, a.v));
  process.stdout.write(`${found[0].v} ${hash.slice(0, 7)} ${i} ${found[0].kind}\n`);
  process.exit(0);
}

fail('No release found in the git history: no commit message starting with vX.X.X and no vX.X.X tag. Pass a version instead.');

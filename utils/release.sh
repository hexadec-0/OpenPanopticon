#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 hexadec
#
# Builds a release zip: the minimum needed to run OpenPanopticon, plus the
# test suite. No demo, no secrets, no runtime cache. Windows: utils\release.bat
#
#   bash utils/release.sh            # version from the newest release commit
#                                    # ("v1.3.3" message) or vX.X.X tag
#   bash utils/release.sh 1.3.0      # explicit version (with or without the v)
#
# Output: dist/OpenPanopticon -VX.X.X.zip
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."   # project root
ROOT="$(pwd)"

die() { printf '  %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "Node.js is needed to build the release (it rewrites package.json)."

# The newest commit in the history marked as a release: its message starts
# with vX.X.X, or a vX.X.X tag points at it (see release-version.cjs).
VERSION="${1:-}"
if [ -z "$VERSION" ]; then
  command -v git >/dev/null 2>&1 || die "git is needed to read the version (or pass one: bash utils/release.sh 1.3.3)."
  INFO="$(node utils/release-version.cjs)" || exit 1
  read -r VERSION FROM AHEAD KIND <<<"$INFO"
  printf '  Version V%s from %s %s\n' "$VERSION" "$KIND" "$FROM"
  if [ "$AHEAD" != "0" ]; then
    printf '  Note: HEAD is %s commit(s) past it; those changes are in this zip too.\n' "$AHEAD"
  fi
fi
VERSION="${VERSION#[vV]}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Version must look like X.X.X, got: $VERSION"

NAME="OpenPanopticon -V${VERSION}"
DIST="${ROOT}/dist"
STAGE="${DIST}/${NAME}"
ZIP="${DIST}/${NAME}.zip"

# What ships. Everything else stays out.
FILES=(
  server.js
  package.json
  package-lock.json
  START.bat
  start.sh
  utils/chromebook.sh
  .env.example
  README.md
  LICENSE
)
DIRS=(
  public
  test
)
# Demo-only and dev-only parts of the folders above.
EXCLUDE=(
  test/unit/demo
  test/functional/demo.test.mjs
  test/functional/demo-serve.test.mjs
  test/e2e/demo.test.mjs
  test/helpers/static-site.cjs
  test/shodan_probe.py
)

for f in "${FILES[@]}"; do [ -f "$f" ] || die "Missing file: $f"; done
for d in "${DIRS[@]}";  do [ -d "$d" ] || die "Missing folder: $d"; done

printf '  Building %s\n' "$NAME"
rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE/utils"

for f in "${FILES[@]}"; do cp -p "$f" "$STAGE/$f"; done
for d in "${DIRS[@]}";  do cp -Rp "$d" "$STAGE/$d"; done
for x in "${EXCLUDE[@]}"; do rm -rf "${STAGE:?}/$x"; done

# Never ship secrets, caches or editor/OS junk, wherever they turn up.
find "$STAGE" \( -name '.env' -o -name 'node_modules' -o -name '.DS_Store' \
  -o -name 'Thumbs.db' -o -name '*.log' -o -name '*.pid' \) -prune -exec rm -rf {} +

# Drop the demo:* npm scripts from the shipped package.json.
node -e '
  const fs = require("fs"), p = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const k of Object.keys(pkg.scripts || {})) if (k.startsWith("demo")) delete pkg.scripts[k];
  fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$STAGE/package.json"

chmod +x "$STAGE/start.sh" "$STAGE/utils/chromebook.sh" "$STAGE/test/run-tests.sh" 2>/dev/null || true

# Zip with whatever is installed.
(
  cd "$DIST"
  if command -v zip >/dev/null 2>&1; then
    zip -qr -X "$ZIP" "$NAME"
  elif command -v 7z >/dev/null 2>&1; then
    7z a -tzip -bd "$ZIP" "$NAME" >/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -m zipfile -c "$ZIP" "$NAME"
  elif command -v powershell.exe >/dev/null 2>&1; then
    # Git Bash on Windows ships without zip.
    powershell.exe -NoProfile -Command "Compress-Archive -Path '$NAME' -DestinationPath '$NAME.zip' -Force"
  else
    die "No zip tool found. Install zip (e.g. sudo apt install zip)."
  fi
)

rm -rf "$STAGE"

SIZE="$(du -h "$ZIP" | cut -f1)"
printf '  Done: %s (%s)\n' "$ZIP" "$SIZE"

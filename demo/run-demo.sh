#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 hexadec
#
# Build and run the static New York demo locally.
#
#   demo/run-demo.sh [command] [options]
#
# Commands:
#   serve      rebuild the site from the snapshot in docs/ and serve it (default)
#   capture    capture a fresh snapshot (needs .env and internet), build, serve
#   maps       re-fetch only the map tiles into docs/, keeping the layer data,
#              then build and serve
#   quick      build from the test suite's fake data into a temp folder and
#              serve that: seconds, no keys, no tiles (the globe stays dark)
#   build      rebuild docs/ from the snapshot, don't serve
#
# Options:
#   --port N   port to serve on (default 8080)
#   --root     serve at / instead of /OpenPanopticon/ (the GitHub Pages path)
#   --no-open  don't open a browser
#   -h, --help show this help

set -euo pipefail

usage() { sed -n '5,24p' "$0" | sed 's/^# \{0,1\}//'; }

cmd=serve
port=8080
base=/OpenPanopticon/
open=--open
while [ $# -gt 0 ]; do
  case "$1" in
    serve|capture|maps|quick|build) cmd=$1 ;;
    --port)    [ $# -ge 2 ] || { echo "--port needs a number" >&2; exit 2; }; port=$2; shift ;;
    --root)    base=/ ;;
    --no-open) open= ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# Run from the project root, wherever the script was called from.
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node 22 or newer." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$major" -lt 22 ]; then
  echo "Node $(node -v) is too old; the demo tools need Node 22 or newer." >&2
  exit 1
fi

site=docs
case "$cmd" in
  capture)
    node demo/capture.mjs
    node demo/build.mjs
    ;;
  maps)
    node demo/capture.mjs --maps-only
    node demo/build.mjs
    ;;
  quick)
    site="${TMPDIR:-/tmp}/openpanopticon-demo-quick"
    rm -rf "$site"
    node demo/capture.mjs --fixtures --out "$site"
    node demo/build.mjs --out "$site"
    ;;
  serve|build)
    if [ ! -f docs/data/manifest.json ]; then
      echo "No snapshot in docs/ yet." >&2
      echo "  demo/run-demo.sh capture   captures one (needs .env and internet)" >&2
      echo "  demo/run-demo.sh quick     tries the demo on fake data instead" >&2
      exit 1
    fi
    node demo/build.mjs
    ;;
esac

[ "$cmd" = build ] && exit 0
exec node demo/serve.mjs --dir "$site" --port "$port" --base "$base" $open

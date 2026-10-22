#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 hexadec
#
# Run the OpenPanopticon test suite.
#
#   test/run-tests.sh [suite] [options]
#
# Suites:
#   all          syntax check, unit, functional and browser tests (default)
#   quick        unit and functional tests
#   unit         unit tests only
#   functional   functional (API) tests only
#   e2e          browser tests only
#   coverage     unit and functional tests with a coverage report
#
# Options:
#   --chrome PATH   Chrome or Chromium to drive (otherwise found automatically)
#   --cesium DIR    serve Cesium from a local copy instead of the CDN
#   --headful       show the browser while the browser tests run
#   --required      fail, rather than skip, when no browser is found
#   -h, --help      show this help

set -euo pipefail

usage() { sed -n '5,23p' "$0" | sed 's/^# \{0,1\}//'; }

suite=all
while [ $# -gt 0 ]; do
  case "$1" in
    all|quick|unit|functional|e2e|coverage) suite=$1 ;;
    --chrome)   [ $# -ge 2 ] || { echo "--chrome needs a path" >&2; exit 2; }; export CHROME_PATH=$2; shift ;;
    --cesium)   [ $# -ge 2 ] || { echo "--cesium needs a folder" >&2; exit 2; }; export CESIUM_DIR=$2; shift ;;
    --headful)  export HEADFUL=1 ;;
    --required) export E2E_REQUIRED=1 ;;
    -h|--help)  usage; exit 0 ;;
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
  echo "Node $(node -v) is too old; the tests need Node 22 or newer." >&2
  exit 1
fi

# The browser tests need puppeteer-core, the one dev dependency.
needs_browser() { [ "$suite" = all ] || [ "$suite" = e2e ]; }
if needs_browser && [ ! -d node_modules/puppeteer-core ]; then
  echo "Installing test dependencies (puppeteer-core)..."
  npm install --no-audit --no-fund
fi

case "$suite" in
  all)        npm run test:all ;;
  quick)      npm test ;;
  unit)       npm run test:unit ;;
  functional) npm run test:functional ;;
  e2e)        npm run test:e2e ;;
  coverage)   npm run test:coverage ;;
esac

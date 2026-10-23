# Tests

Three suites, all on Node's built-in test runner. None of them touch a real
upstream or need an API key: every external API is answered by canned
fixtures (`helpers/fixtures.cjs`), so the suite runs offline, spends no
credits, and gives the same answer every time.

## Run them

```
npm install            # once: fetches puppeteer-core, the only dev dependency
npm test               # unit + functional, a few seconds
npm run test:e2e       # drives the real UI in Chrome (a few minutes)
npm run test:all       # syntax check, then all of the above
npm run test:coverage  # unit + functional with a coverage table
```

Or use `test/run-tests.sh` (Windows: `test\run-tests.bat`). It checks Node,
installs `puppeteer-core` if the browser tests need it, and takes a suite name:
`all` (the default), `quick`, `unit`, `functional`, `e2e`, or `coverage`.
Its options are `--chrome PATH`, `--cesium DIR`, `--headful`, and
`--required`; `--help` lists them.

## What's where

| Suite | Folder | What it covers |
|---|---|---|
| Unit | `unit/server`, `unit/client`, `unit/demo` | Server helpers: grid snapping, caching, the fetch wrapper, normalisers, the OpenSky budget, AIS, TLE fallback, and the Overpass queue. Browser modules against a Cesium stand-in: settings, the vector-tile decoder, auto-cycle, layers, and overlays. The demo's capture and build helpers. |
| Functional | `functional` | Every `/api` route over real HTTP: the Host, header, and access-key gate, response headers, static files, caching and persistence, error handling, and `node server.js` itself. Also the static demo: capture, build, its local server, and its API stand-in. |
| End-to-end | `e2e` | The app in Chrome with real Cesium: boot, the HUD, every layer and its detail panel, overlays, the base-map menu, search, home, auto-cycle, keyboard shortcuts, saved settings, and that hostile upstream data cannot run script. Also the built demo, served like GitHub Pages. |

`helpers/` holds the shared plumbing:
- `harness.cjs` loads `server.js` in-process with a clean config and a
  throwaway data folder.
- `upstream.cjs` and `fixtures.cjs` are the fake upstreams.
- `browser.mjs` finds and drives Chrome, offline apart from the app.
- The stubs stand in for Cesium and the DOM.

## Browser tests

They use an installed Chrome, Chromium, or Edge instead of downloading one.
These environment variables change how they run:

| Variable | Effect |
|---|---|
| `CHROME_PATH` | Path to the browser, if it is somewhere unusual. |
| `E2E_REQUIRED=1` | A missing browser fails the run instead of skipping it, as in CI. |
| `CESIUM_DIR` | Load Cesium from a local copy instead of cdnjs, for a run with no network. Unpack the `cesium@1.145.0` npm package and point this at its `Build/Cesium` folder. |
| `HEADFUL=1` | Shows the browser while the tests run. |

Under software rendering (no GPU, as in CI) the globe draws at a frame or two
per second. The tests wait on state rather than on fixed delays for that
reason.

## Writing tests

- Keep tests offline. A new upstream gets a fixture in
  `helpers/fixtures.cjs`, registered in `registerDefaults()`.
- To document a known bug, mark its test `{ todo: true }`. It still runs and
  is reported, but does not fail the suite until the bug is fixed.

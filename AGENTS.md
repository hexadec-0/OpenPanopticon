# AGENTS.md

Project rules for AI coding agents (and humans) working on OpenPanopticon.

## What this is

A self-hosted OSINT viewer: `server.js` is a zero-dependency Node 22 server
that serves `public/` and proxies ~25 upstream APIs; the browser renders them
on a Cesium globe. `npm start` runs it on http://127.0.0.1:8420.

## Rules

- No npm dependencies. Node built-ins only. (`puppeteer-core` is a
  devDependency for the browser tests and must never be required by the app.)
- Every credential stays in `server.js` (`CFG`). The browser never gets a key,
  except the Cesium Ion token via `/api/config`, which is browser-side by design.
- Cache keys must use snapped grid cells: `viewCell(b, kind)` with a
  `VIEW_CELL_DEG` entry, never the raw bbox.
- `TTL.static` is for inventories of fixed things; `TTL.hazard` for current
  conditions (alerts, outages, live readings, active C2 lists).
- Anything cached with `cachedPersistent` is stored as JSON: cache arrays or
  plain objects, never `Map`/`Set`, and rebuild them after reading.
- All upstream text rendered in the browser goes through `esc()`. All upstream
  URLs go through `safeUrl()` on the server (`{ httpsOnly: true }` for iframes).
- The page runs under an enforced Content-Security-Policy (`CSP` in
  `server.js`): no inline `<script>`, no `on*=` attributes, and no `eval` in
  app code (`'unsafe-eval'` is allowed only because Cesium needs it). Attach
  handlers with `addEventListener` (hide broken images with
  `data-hide-on-error`). The e2e suite fails on any CSP violation.
- Nothing the operator types (searches, custom queries) is written to disk in
  clear: disk cache records carry only a hash of their key.
- The app carries no version number anywhere: not in `package.json`, the page,
  the startup banner, the API, or the User-Agent.
- Write comments as present-tense rationale, not debugging history.

## Trust boundaries

Changes in these areas need a security review before they count as done:

- **Credential handling**: `CFG`, `grab()`, and any upstream URL that embeds a key.
- **Upstream data rendered in the browser**: the `detail()` and `enrich()`
  methods in `public/js/layers.js`, and anything that sets `innerHTML`,
  `href`, or iframe `src`.
- **Browser policy**: the `CSP` and `SECURITY_HEADERS` in `server.js`.
- **Network exposure**: the `HOST` binding, `ALLOWED_HOSTS`, the access key,
  the `X-Panopticon` header check, and `/api/shodan`.

## Checks

- `npm run check` and `npm test` (unit + functional; offline, seconds).
- `npm run test:e2e` for anything touching `public/` (needs Chrome; set
  `CESIUM_DIR` to run without network).
- Tests never call real upstreams: add a fixture in
  `test/helpers/fixtures.cjs` for a new source, and keep `mock.unmatched` empty.
- `server.js` only listens when run directly; tests `require()` it through
  `test/helpers/harness.cjs`, which isolates `.env` and the data directory.
- Tests marked `todo` document known bugs. Fixing one means removing the
  `todo` option, not deleting the test.

# Contributing

Thanks for wanting to help. A few project rules aren't obvious from the code,
so please read these before opening a PR.

## Ground rules

- **No npm dependencies.** Node built-ins only, on the server and in the
  browser (Cesium and the bundled `public/providers/satellite.min.js` are the
  exceptions). The one devDependency is `puppeteer-core`, for the browser
  tests; nothing the app runs may depend on it.
- **Target Node 22** or newer (global `fetch` and `WebSocket`).
- **Credentials stay in `server.js`.** The browser calls `/api/*`; the server
  attaches keys on the way out. The Cesium Ion token is the one deliberate
  exception.
- **New upstream sources must be keyless, or switched off cleanly when their
  key is missing**, with a line in the startup banner and `/api/health`.
- **Check the scheme of every upstream URL before it is rendered.** Run links
  through `safeUrl()` on the server, with `{ httpsOnly: true }` for anything
  that ends up in an iframe. Escape all upstream text with `esc()`.
- **Cache keys use snapped grid cells** (`viewCell()`), never the raw view box.
- **Use the right TTL**: `TTL.static` for inventories of fixed things,
  `TTL.hazard` for present-tense data such as alerts and live readings.

## Extra review

PRs that add Shodan presets, or layers that map people, devices, or
surveillance hardware, get extra review in line with the README's
*Using this responsibly* section. Explain the legitimate use in the PR.

## Before you open a PR

- `npm test` (unit + functional, seconds) and, for UI changes,
  `npm run test:e2e` (Puppeteer; needs Chrome). See `test/README.md`.
- add tests with the change: a new upstream gets a fixture in
  `test/helpers/fixtures.cjs` and a functional test of its route; a new UI
  control gets an e2e test. Tests never call real APIs.
- run the app, open the layers you touched, and watch the terminal for errors
- write comments as present-tense rationale (why the code is this way), not
  as a history of the debugging that got it there

Security issues go through [SECURITY.md](SECURITY.md), not public issues.

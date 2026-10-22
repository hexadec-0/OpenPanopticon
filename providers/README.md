# Adding a data source

This folder is the server's runtime data (response cache, TLE copies,
diagnostics) and everything in it except this file is gitignored. Data
sources themselves live in code. A source is a server function that fetches
and normalises one upstream, plus a browser layer that draws it. Use
Sensor.Community (`iotSensors()` in `server.js`, `IotLayer` in
`public/js/layers.js`) as the template; it is short and touches every step.

Read the rules in [`AGENTS.md`](../AGENTS.md) and
[`CONTRIBUTING.md`](../CONTRIBUTING.md) first. In short: no npm
dependencies, keys never reach the browser, and a new source must be keyless
or switch itself off cleanly when its key is missing.

## 1. Server (`server.js`)

1. **Key (if any).** Add it to `CFG` (`fooKey: (process.env.FOO_API_KEY || '').trim()`)
   and document it, commented, in `.env.example`. If the key is missing,
   throw an `UpstreamError` that says so. Never crash.
2. **Grid cell.** For a view-scoped source, add an entry to `VIEW_CELL_DEG`
   (and to `VIEW_MAX_DEG` if a wide box would hang or get truncated). Always
   build the query from `viewCell(bbox, 'foo')`, never the raw bbox.
3. **Fetch and cache.** Write `async function foo({ bbox })`:
   - `parseBbox()` the input and return a 400 `UpstreamError` if it is bad.
   - Fetch with `grab(url, opts, { label: 'Foo', timeoutMs })`. It sets the
     User-Agent, applies timeouts and turns failures into `UpstreamError`s.
   - Wrap it in ``cachedPersistent(`foo:${q.key}`, TTL.x, ...)``. Use
     `TTL.static` for where fixed things are, and `TTL.hazard` for anything
     present-tense (alerts, readings, outages). Cache only JSON-safe values
     (no `Map`/`Set`).
   - If the payload is unexpected, throw a 502 `UpstreamError`.
4. **Normalise** to an array of records, each with a stable `id`, `lat` and
   `lon` plus whatever the detail panel needs. Run every upstream URL you
   pass on through `safeUrl()` (`{ httpsOnly: true }` if it ends up in an
   iframe).
5. **Route.** Register it in `ROUTES`:
   `'/api/foo': (q) => foo({ bbox: q.get('bbox') })`.
6. **Visibility.** Add a line to `sources` in `/api/health` and to the
   startup banner, so a missing key shows up as `not configured`.

## 2. Browser (`public/js/layers.js`, `public/js/app.js`)

1. Add `export class FooLayer extends Layer` with:
   - `constructor`: `super(viewer, 'foo', 'Foo')`, then coverage and cache
     settings (`INVENTORY_COVERAGE_MS` for fixed things, `accumulate = true`
     to keep features as you pan).
   - `load({ bbox })`: `this.fetch('/api/foo', { bbox: this.padBbox(bbox) })`,
     then `this.remember(records)` and `this.redraw()`.
   - `draw(records)`: add entities to `this.source` with
     `properties: { layer: 'foo', record }` and return the count.
   - `detail(rec)`: return `{ kind, title, accent, html }`. **Every
     upstream string goes through `esc()`.**
2. In `app.js`, add `foo: new FooLayer(this.viewer)` to `this.layers` and a
   sidebar entry with `mk('foo', 'Foo', controls)`.
3. If the layer has options, persist them in `public/js/settings.js`.

## 3. Tests (`test/`)

- Add a fixture shaped like the real API in `test/helpers/fixtures.cjs` and
  register it with `mock.on(host('api.foo.example', '/path'), fooFixture)`.
  Include the awkward cases (missing coordinates, duplicates, junk values).
- Add a functional test of `/api/foo`, following `test/functional/api-sensors.test.cjs`:
  normalisation, the snapped query URL, and a 502 on a bad payload.
- A new UI control gets an e2e test. Tests never touch real upstreams.
  `mock.unmatched` must stay empty.
- Run `npm run check && npm test`, plus `npm run test:e2e` for UI changes.

## 4. Docs and demo

- Add a row to *What's on the globe* in the main [`README.md`](../README.md),
  and a *Rate limits worth knowing* bullet if the upstream has one.
- If the static demo should show it, add a `'/api/foo'` entry to
  `demo/site/demo.js` (see `demo/README.md`).

> Layers that map people, devices or surveillance hardware get extra review.
> Explain the legitimate use in the PR.

# Static demo

Turns OpenPanopticon into a static site for GitHub Pages: a snapshot of New
York City, captured once and served as plain files, with no server behind it.

## Make it

```
npm run demo:capture     # needs your .env and internet; roughly 15-40 minutes
npm run demo:build       # seconds; re-run after any change to the app
```

The capture runs its own copy of `server.js` on a private port, using your
keys and the `providers/` cache, and writes everything into `docs/`. It
resumes if interrupted; delete `docs/data` for a fresh snapshot.

- **Capture in New York daylight** (08:00 to 17:00 there). The demo's clock
  and the sun lighting are fixed to the moment of capture.
- **Close the app while it runs.** Both use the same keys and address, so a
  running app spends credits and makes Overpass rate-limit the capture.
- **Maps only:** `npm run demo:capture:maps` (or `run-demo maps`) fetches just
  the base maps and labels and leaves the layer data and its capture time
  alone. No Overpass, Shodan or other API queries. Use it to add or refresh
  map tiles without re-capturing everything.

## Try it locally

```
demo/run-demo.sh             # Windows: demo\run-demo.bat
```

This rebuilds the site and opens it at `http://127.0.0.1:8080/OpenPanopticon/`,
the same path GitHub Pages uses. The other commands:

- `capture`: capture first, then build and serve.
- `maps`: fetch the map tiles only, then build and serve.
- `quick`: fake test data, in seconds, with no keys and no map tiles.
- `build`: rebuild only.

Options: `--port N`, `--root`, `--no-open`. Opening `docs/index.html` straight
from disk will not work, because browsers block its scripts there.

## Publish it on GitHub Pages

1. **Check it locally first** with `demo/run-demo.sh` (above). If it works
   there it will work on Pages, since both serve the files the same plain
   way. The build prints the site's size. Pages allows 1 GB per site, and git
   refuses single files over 100 MB; the build warns about both.

2. **Commit and push `docs/`.**

   ```
   git add docs
   git commit -m "Add New York demo snapshot"
   git push
   ```

   `docs/` is not in `.gitignore`. It is thousands of small files, so the
   first push can be slow.
   - If it fails with "RPC failed", run
     `git config http.postBuffer 524288000` and push again.
   - Do not use Git LFS for these files. Pages serves LFS files as pointer
     text, not the files themselves.

3. **Turn on Pages.** In the repository on GitHub, open **Settings → Pages**.
   Under **Build and deployment**:
   - set **Source** to **Deploy from a branch**
   - set **Branch** to `main` and the folder to `/docs`
   - click **Save**

   On a free account the repository must be public for Pages to work.

4. **Wait for the deploy.** The **Actions** tab shows a
   "pages-build-deployment" run, usually a minute or two. The site is then at
   `https://<user>.github.io/<repo>/`, and **Settings → Pages** shows the
   address with a **Visit site** button. Any repository name works, because
   every path in the demo is relative.

Once live, anyone can view it, Shodan hosts included. Read the main README's
*Terms of service* before the first push.

### Updating it

Capture and build again, then commit and push `docs/`. Pages redeploys on
every push to `main`. Delete `docs/data` first for a fully fresh snapshot;
otherwise tiles already on disk are reused, which is quicker.

### If something is wrong

| Symptom | Likely cause |
|---|---|
| 404 | The first deploy can take a few minutes, or the Pages folder is set to `/ (root)` instead of `/docs`. |
| Blank page | A file is missing from `docs/`, for example after a partial push. The browser console names it. Run `npm run demo:build` and push again. |
| Dark globe | The capture ran at night in New York. Capture again in daylight there. |
| Map but no data | A capture step failed. The capture lists "Not captured" steps at the end, and `docs/data/manifest.json` records each one. |

## What's in it

**Captured:** every layer over the five boroughs, including Shodan hosts as
returned. Read the main README's *Terms of service* before publishing. Also:

- one still frame per webcam
- three base maps, picked in the BASEMAP menu: the dark vector map (the
  default), the standard OpenStreetMap street map, and EOX's Sentinel-2
  cloudless satellite mosaic
- labels, radar, clouds and NASA imagery tiles
- OpenStreetMap buildings for Manhattan and the waterfront
- place names, for the search box

**Layers at start:** Shodan, aircraft, OSM infrastructure (every class), ALPR,
webcams, hazards and network infrastructure. Visitors can switch layers off
and on, except Orbital assets, which is not part of the demo.

**Switched off:** FLUSH, SYNC, other imagery dates and other base maps. The
Saved targets section and the "Reset saved settings" button are hidden, and
settings are not kept between visits.

**Base map terms.** The street map comes from OpenStreetMap's donated tile
servers, whose usage policy discourages bulk downloads. The capture keeps it
to about 1,300 tiles, with street-level detail over Manhattan and the
waterfront only, and fetches two at a time. The satellite mosaic is EOX's,
free for non-commercial use with the credit the demo shows on the map.

**Never included:** your location (home is fixed at City Hall) or anything
from `.env`. The build scans every output file for your key values and stops
if one appears.

## Files

| File | What it does |
|---|---|
| `capture.mjs` | records the snapshot |
| `build.mjs` | copies the app into `docs/` beside the snapshot and checks for secrets |
| `serve.mjs` | a plain static server, for local testing |
| `run-demo.sh`, `run-demo.bat` | build and serve in one step |
| `site/demo.js` | answers the page's `/api/*` calls from the snapshot |
| `site/demo.css` | the demo banner and the look of switched-off controls |

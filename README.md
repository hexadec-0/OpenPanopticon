# OPENPANOPTICON

**OSINT Data Fusion (ver. 1.0.1)**

A geospatial intelligence terminal that runs on your own machine. Point it at
anywhere on Earth and it overlays live public data on a 3D globe (internet-exposed
hosts from Shodan, aircraft from ADS-B, satellites propagated from orbital
elements, infrastructure from OpenStreetMap, and public cameras), then renders
the whole thing through emulated sensor optics.


```
  ╔═╗╔═╗╔═╗╔╗╔╔═╗╔═╗╔╗╔╔═╗╔═╗╔╦╗╦╔═╗╔═╗╔╗╔
  ║ ║╠═╝╠╣ ║║║╠═╝╠═╣║║║║ ║╠═╝ ║ ║║  ║ ║║║║
  ╚═╝╩  ╚═╝╝╚╝╩  ╩ ╩╝╚╝╚═╝╩   ╩ ╩╚═╝╚═╝╝╚╝
  OSINT data fusion · ver. 1.0.1
```

---

## Run it

Requires **Node 18 or newer**. There are no dependencies to install.

**Linux / macOS**

```bash
cd openpanopticon
./start.sh
```

**Windows**: double-click `START.bat`.

Either script creates `.env` from the template on first run, checks your Node
version, and opens the browser once the server answers. To run it by hand:

```bash
cp .env.example .env     # copy on Windows
node server.js
```

Open <http://127.0.0.1:8420>. It opens over wherever the machine running it
appears to be, resolved by geoIP; the `⌂ Home` button returns there, and the
HUD shows the resolved city.

The startup banner tells you which sources are live:

```
  Shodan .............. ready
  OpenSky ............. anonymous (400 credits/day)
  CelesTrak ........... open
  Overpass / OSM ...... open
  ALPR / Flock ........ open (DeFlock data via OSM)
  AIS vessels ......... not configured
  RIPE Atlas .......... open
  Tor relays .......... open (country-level)
  Sensor.Community .... open
  NASA GIBS ........... open
  IODA outages ........ open
  Raspberry Shake ..... open
  Flight routes ....... open (adsbdb)
  Weather radar ....... open (RainViewer)
  GDACS / EONET / USGS / NWS .... open
  NASA FIRMS .......... not configured
  Windy webcams ....... not configured
  OpenWebcamDB ........ not configured
  Cesium Ion .......... OSM basemap only
```

Only `SHODAN_API_KEY` needs your key. Everything else works unconfigured, and
each optional key in `.env.example` upgrades one layer.

---

## Sample Images & Demo Video

**Demonstration Video & Tour**

[![ Demonstration Video & Tour ](https://img.youtube.com/vi/AVqyvgPxVO8/0.jpg)](https://www.youtube.com/watch?v=AVqyvgPxVO8)

**Demo Images**
<img width="2351" height="1226" alt="OpenPanopticon Demo1" src="https://github.com/user-attachments/assets/aeedf12d-1f3b-4f8c-87a7-6b51a7cf1ccd" />

<img width="2352" height="1223" alt="OpenPanopticon Demo2" src="https://github.com/user-attachments/assets/4d1f91c8-02f5-46c3-8c2b-8d899ee0df84" />

<img width="2347" height="1183" alt="OpenPanopticon Demo3" src="https://github.com/user-attachments/assets/9ad7bd67-ed1e-4b22-83b3-b437590dbe0e" />

<img width="2345" height="1175" alt="OpenPanopticon Demo4" src="https://github.com/user-attachments/assets/52eb6549-8900-43af-9cd5-71820e843573" />

<img width="2347" height="1188" alt="OpenPanopticon Demo5" src="https://github.com/user-attachments/assets/5cbf4d94-f7f2-4617-b2be-84a1944034a0" />

<img width="2346" height="1186" alt="OpenPanopticon Demo6" src="https://github.com/user-attachments/assets/23d9c10a-8ef3-40e5-ade3-98c5ffe8cc23" />


## What's on the globe

| Layer | Source | Notes |
|---|---|---|
| **Shodan exposure** | Shodan `host/search` | Every host Shodan has indexed in view, with no type filter and no query box. Colour by service category (web, remote, database, ICS, camera, network…) or by known CVEs, with a live legend. |
| **Live aircraft** | OpenSky + adsbdb | Positions, callsigns, altitude, heading, vertical rate, motion trails, emergency squawk flagging (7500/7600/7700). Click one to resolve its **departure and destination airports**, airline and airframe. The two airports are marked on the globe; no line is drawn between them, since a route arc spans half the map and makes a flight's own track indistinguishable from its schedule. Trails are trimmed to the last two minutes. |
| **Weather** | RainViewer | Precipitation radar and infrared cloud imagery as toggleable globe overlays, with a frame scrubber and animation across the last ~2 hours plus nowcast. |
| **Orbital assets** | CelesTrak | 24 catalogue groups. Real SGP4 propagation in the browser via satellite.js. Click a satellite to draw its ground track for one full revolution. |
| **OSM infrastructure** | Overpass API | 10 toggleable feature classes: surveillance cameras, military sites, comms towers, power plants and substations, airfields, ports, government and diplomatic, emergency services, data centres, fuel storage. |
| **ALPR / Flock** | DeFlock via OpenStreetMap | Licence-plate readers, coloured by vendor, each drawn with a field-of-view cone from its tagged bearing. Filter by vendor, or to only cameras whose facing is known. |
| **Situational awareness** | GDACS, NASA EONET, USGS, NWS, NASA FIRMS | Live hazard and disaster events for the current view, normalised into one record shape and colour-graded by severity. Red-level events pulse on the globe; sources that publish an affected area are drawn as polygons. |
| **Public cameras** | NYC DOT + ALERTCalifornia + Windy + OpenWebcamDB | Click one to watch it live in the side panel: an embedded player where the operator provides one, otherwise the still frame refreshed on a timer. ALERTCalifornia adds ~1,290 wildfire-detection PTZ cameras, keyless. |
| **Vessels (AIS)** | AISStream | Live ship positions, heading, speed, navigation status, destination and dimensions. The server holds the websocket; the browser never sees the key. |
| **Network infrastructure** | RIPE Atlas, OpenCelliD, WiGLE, Onionoo | Geolocated network and wireless hardware: measurement probes with ASN, cell towers drawn at their estimated range, WiFi/Bluetooth survey points, and Tor relay capacity by country. |
| **IoT sensors** | Sensor.Community | Citizen-run air-quality and noise hardware with live readings, coloured by WHO PM2.5 bands or measured dB(A). |
| **Traffic (511)** | State DOT 511 feeds | Cameras, incidents, lane closures. Add states to `FIVE_ELEVEN_KEYS`; 24 state hosts are pre-wired. |
| **Satellite imagery** | NASA GIBS | Daily global true-colour, night lights, land-surface temperature and thermal anomalies, scrubbable by date. |
| **Regional signals** | IODA, EIA, Cloudflare Radar, Raspberry Shake | Country- and grid-scale telemetry in the sidebar: internet outages, US electricity demand, Cloudflare outage annotations, citizen seismographs in view. |

### Situational-awareness sources

| Source | Key? | What it adds |
|---|---|---|
| **GDACS** (EU JRC / UN) | no | Global multi-hazard alerts (earthquake, cyclone, flood, volcano, drought, wildfire), graded Green / Orange / Red, 30-day window. |
| **NASA EONET v3** | no | Open natural events: severe storms, wildfires, volcanoes, sea and lake ice. Point *and* polygon geometry. |
| **USGS** | no | Every earthquake reported in the last 24 hours, with depth, felt reports and tsunami flags. Severity from magnitude (≥6 red, ≥4.5 orange). |
| **NWS** | no | US watches, warnings and advisories with affected-area polygons. |
| **NASA FIRMS** | free key | VIIRS active-fire detections from the last 48 hours, graded by detection confidence and fire radiative power. |
| **RSOE EDIS** | enterprise | See below. |

### Correlating devices and activity

Two clicks worth knowing about:

**Click a Shodan host** and it cross-references the IP against GreyNoise (is this
a known mass-scanner, and is it benign or malicious?), the abuse.ch Feodo
tracker (is it a live botnet command-and-control server?), and optionally
Censys for a second scan opinion. Verdicts render inline, colour-coded.

**Click an aircraft** and it resolves the callsign to scheduled origin and
destination airports and the hex to an airframe, then draws the route.

### Settings persistence

Which layers were on, how each was filtered, the optical mode, the overlays,
the label styling and the sidebar's state are saved to `localStorage` and
restored on the next load, across a refresh and across a server restart.

It holds UI state only: no credentials (those never reach the browser), no
query results, no positions. Storage can be unavailable in a private window
or when a browser blocks site data, and a missing store simply means
defaults. **Reset saved settings** at the bottom of the sidebar clears it.

### Labels and terrain

`LABELS` in the top bar overlays place and road names from CARTO's
labels-only tileset (OpenStreetMap data). Since 25 September 2026 CARTO
requires a free key; get one at <https://carto.com/basemaps/apikey> and set
`CARTO_API_KEY` in `.env`; the server proxies the tiles so the key stays out of
the browser. Without a key the button stays off and says so. Its own control bar sets
light or dark lettering, a contrast slider, and a **Bold** option that draws
the glyphs in two stacked passes: CARTO's lettering is understated by design
for a basemap, and over imagery it needs the help. Because it is an ordinary
tile pyramid the detail scales itself: motorways and city names when zoomed
out, arterials next, then residential street names as you come in. It matters
most with a Cesium Ion token, where the basemap is photographic imagery with
no lettering at all. It is on by default.

Every ground feature is clamped to terrain rather than placed at a fixed
height above the ellipsoid. A constant offset works only where the ground
happens to be at sea level; anywhere higher, pins sank beneath the surface and
polygons cut through hillsides.

### Overlay resolution limits

Each overlay is capped at the zoom its source actually has data for, because
these services do not fail cleanly past their limit:

- **RainViewer radar** carries real data to zoom 7. Beyond that it returns a byte-identical "Zoom Level Not Supported" placeholder image rather than a 404 or a transparent tile, so an uncapped layer smears that notice across the globe. Cesium now upsamples zoom 7 instead.
- **NASA GIBS** true-colour products top out at zoom 9 (250 m/pixel native), GOES cloud products at zoom 7. Past that GIBS returns HTTP 400.
- **CLOUD** draws GOES-East GeoColor from GIBS. RainViewer advertises an infrared band but publishes zero frames in practice, so relying on it made the toggle do nothing at all.

These layers are regional instruments. Zoomed into a single city they are
upsampled and soft; they earn their keep at state and continental scale.

### Feature caching

Queries only ever cover the current view, and the view span is capped at 4°.
Redrawing purely from the latest response therefore made everything outside
the new box vanish the moment you panned or zoomed out. Layers instead keep a
client-side cache:

- Features accumulate as you move, so earlier dots stay on the globe until evicted (LRU, 4,000 per layer, 1-hour TTL).
- Views already inside a recent fetch repaint from cache with **no network call**, which is what stops panning around from burning Shodan query credits.
- Fetches ask for a box 30% wider than the view, so small pans stay inside the covered region.
- Changing something that alters the *query* (Shodan preset, Overpass classes, event sources) drops the cache, so results fetched under different criteria can never merge together.
- Changing something **display-only** (colour mode, ALPR vendor chips, indoor sensors, cone rendering) repaints from cache instantly and costs nothing.
- `FLUSH` in the top bar drops every cached feature and refetches.

Hover a layer's count to see how many features are drawn, how many are cached,
and how many fetches the cache has saved.

### A note on resolution and honesty

Several of these sources are coarser than they look, and the UI says so rather
than implying precision it doesn't have:

- **Tor relays** are country-level only. Onionoo used to publish per-relay latitude and longitude; it no longer does, even when those fields are explicitly requested. So relays are aggregated per country and drawn at centroids, labelled as aggregates. Those markers are deliberately *not* bbox-filtered: a country centroid is almost never inside a city-sized view, and filtering them would make the layer look empty exactly when you're zoomed in.
- **Cell towers** are a centroid of crowdsourced observations, not a surveyed mast position. That's why the layer draws OpenCelliD's estimated range as a circle instead of a confident point.
- **IoT sensors** are self-sited by their owners, and some deliberately blur their coordinates. The panel says when a position is marked inexact.
- **AIS** is self-reported. Transponders get switched off and spoofed, so an empty stretch of water is not evidence of an empty stretch of water.
- **Sensor.Community** is dense across Europe (especially Germany) and sparse most other places. An empty map in the US usually means no sensors, not clean air.

### Where the Flock data comes from

[DeFlock](https://deflock.org/) is the crowdsourced project that maps automated
licence-plate readers, and its key design decision is that it stores findings
**in OpenStreetMap** rather than a private database. So OpenPanopticon reads it
straight from Overpass: no key, no scraping, and community edits appear here
as soon as they're accepted upstream.

The OSM tagging is `man_made=surveillance` + `surveillance:type=ALPR`, with
`manufacturer="Flock Safety"` (wikidata `Q108485435`), a `direction` in degrees
clockwise from north, plus `surveillance:zone`, `camera:mount` and
`electricity`. Motorola/Vigilant, Genetec, Leonardo/Elsag, Axis and Neology
units are detected and coloured separately.

Two things worth knowing about the direction data. Roughly 95% of mapped
cameras carry a bearing, which is why the cones are worth drawing at all. And
the tag is messy in the wild: plain degrees (`265`), compass points (`NNE`),
and semicolon-separated multi-values for dual-lens units (`350;170`); the last
of which sometimes contains junk like `350;500`, where `500` isn't a bearing.
OpenPanopticon renders one cone per *valid* member and silently drops the rest; the
detail panel shows the raw tag so you can see what was thrown away.

Coverage is uneven and entirely volunteer-driven. **An empty area means nobody
has mapped it, not that there are no cameras there.**

### A note on RSOE EDIS

[rsoe-edis.org](https://rsoe-edis.org/) is a genuinely good global emergency
feed, but its event data is an enterprise product with no free tier; the
GeoJSON events API is listed at €4,000/year, historical data another €2,000.
There is no public endpoint to point this at.

So the layer ships with the free sources above, which between them cover most
of the same ground: GDACS is the closest equivalent for multi-hazard alerting
and is the same class of feed. If you do license EDIS, set `EDIS_API_URL` and
`EDIS_API_KEY` in `.env` and the `edis` source activates and normalises
alongside the rest. The field mapping is defensive, since EDIS's schema
isn't published.

Search any place by name (Nominatim), or use the saved targets.

---

## Altitude gate

Nothing is queried above **45 km** by default, so panning around from altitude
costs no API calls, Overpass slots or Shodan credits.

Worth knowing how low that is: at 45 km the view spans roughly 40 km, while the
query box itself is capped at 4 degrees (~440 km). A normal "look at the whole
city" view sits *above* the ceiling and holds everything. Click the **FETCH**
cell in the HUD to cycle it through 45 / 100 / 250 / 500 km; the choice sticks.

While held, the FETCH cell reads `HOLD ▲45km` and each layer shows `↓`
with its current altitude. Anything already found stays drawn, and coverage is
kept, so descending does not refetch ground already held. Layers resume on
their own as the camera settles below the ceiling.

Orbital assets are the exception: they are propagated from TLE elements rather
than queried for a view box, and altitude is where you look at them from.

---

## Caching

Retention is held in one table near the top of `server.js`, in memory and on
disk (`vendor/cache/`) so it survives a restart.

Every view-scoped source goes through `viewCell()`, which snaps the camera's
box outward onto a fixed grid and hands back both the box to query and the key
to store it under: one function, so the two cannot describe different ground.
The grid never changes size, which is what makes a key name a **region**
rather than a camera position: reloading or nudging the camera lands on the
same cells instead of minting a new entry each time.

The box is the *minimal* whole-cell cover, and capped per source
(`VIEW_MAX_DEG`). Both matter, because a query far larger than the upstream
can answer does not degrade; it hangs. Ten Overpass preset clauses over
several degrees runs past every mirror's timeout and the layer shows nothing
at all, so a very wide view is answered for its centre and the response says
`trimmed` so the UI can admit it. Cell sizes are per-source: coarse where the
upstream is generous and the features sparse, fine for Overpass (cost scales
with area) and for sources that cap their results, since over-wide queries
would let the cap start truncating real features.

Holding one key across a whole zoom band is the tempting alternative, and it
is a trap: it means querying a box sized for the widest zoom in the band. The
reuse comes from the other end instead: the response reports the cell it
covered, the browser records *that* rather than what it asked for, and every
view inside the cell is then answered locally with no request at all. Closing
in on a city across ten zoom steps costs one Overpass call.

The axis is not importance but how an answer goes wrong as it ages:

| Class | Held | What |
|---|---|---|
| `static` | **72 hours** | Where fixed things are: OSM infrastructure, ALPR and webcam directories, Shodan hosts, cell and WiFi, Tor relays, seismometer stations, geocoding, airframes. |
| `orbit` | 24 hours | Orbital elements. |
| `hazard` | 1 hour | Present-tense claims: active alerts and hazards, traffic incidents, outages, live sensor readings. |
| `schedule` | 30 minutes | Flight schedules (see below). |
| `live` | 4 minutes | Radar frame index. Aircraft and vessels use their feed's own rate. |
| `account` | 1 minute | Credit balances, shown as a number in the UI. |

An inventory of fixed things is still true in three days, so holding it longer
costs nothing and saves every API budget here. A present-tense claim is
different: an alert has an expiry, a fire perimeter moves, an air-quality
reading is about now. Those do not go stale so much as false, and a false
reading presented as current is worse than none.

Orbital elements sit between the two for a reason of their own: an orbit is
perturbed continuously and CelesTrak republishes every two hours, so
propagating three-day-old elements would put a low-orbit object tens of
kilometres from where it is, and the pin would still be drawn, confidently,
in the wrong place.

The browser keeps a matching pair of windows (`INVENTORY_COVERAGE_MS`,
`CURRENT_COVERAGE_MS` in `layers.js`) deciding whether to re-ask at all.
Both halves have to agree: setting only the server side leaves the browser
re-requesting on its own clock and getting a cached reply: harmless, but a
round trip for nothing. One invariant binds them: a layer never holds a
coverage claim over an empty feature store, or it would sit at zero with no
error and never refetch.

Flight schedules are a third exception, and a sharper one. A callsign is a
service on a given day, not a permanent city pair; the same flight number
flies different legs on different days, often the reverse leg the next. Keyed
on the callsign alone and held for a day, the lookup confidently returned
yesterday's route for today's aircraft. Schedules are now keyed by callsign
*and* UTC date, kept for 30 minutes, and **looked up live whenever you click a
flight**: the pick writes through the cache, so it also corrects whatever was
stored. The airframe beside it is keyed by the aircraft's own hex, does not
change, and is still served from cache.

If the aircraft's position contradicts the schedule (descending over New York
on a route ending in San Jose), the panel says so rather than presenting it as
fact.

Two other classes are deliberately excluded, because holding them for a day
would make the map lie rather than merely make it stale:

- **Live positions**: aircraft (the OpenSky feed's own 5s or 10s cadence),
  vessels, radar frames.
- **Warnings and alerts**: NWS, USGS, GDACS, EONET, FIRMS, EDIS, IODA, and
  traffic incidents, at 5 minutes. A tornado warning from yesterday drawn as
  current is worse than the API call it saved.

**SYNC** (or `R`) forces a refresh past every tier, memory and disk. **FLUSH**
additionally empties the browser's feature cache and the server's stored
responses. The retention policy is one table near the top of `server.js`.

---

## When an upstream says no

Every layer backs off on **any** failure (a dead Overpass mirror, an
exhausted credit bucket, an IP ban, a timeout, a malformed response) on a
fixed ladder:

```
30s → 60s → 90s → 120s → 300s → hourly (repeating)
```

The point is not politeness. A layer that failed and then retried on its own
normal schedule asked *most* often precisely when the upstream could least
afford it: the live poll every few seconds, the camera-settle refetch on every
pan. Backing off turns a struggling mirror or a banned address into something
the terminal rides out quietly instead of making worse.

Details that matter:

- **Where the upstream states a wait, it wins if it is longer.** OpenSky
  reports seconds in `X-Rate-Limit-Retry-After-Seconds`; being told 137
  seconds and returning in 30 is not a retry, it is ignoring the answer. Once
  the ladder has grown past the stated wait, the ladder wins.
- **Nothing gets through while it is waiting.** The poll and the pan refetch
  are both gated, and skipped attempts do not advance the ladder; only real
  attempts count.
- **Deliberate acts start over.** SYNC, switching a layer off and on, or
  changing what it asks for all reset to the first step and go out
  immediately. A filter change is a different question and is owed a fresh
  attempt, which is why the settings check runs *before* the backoff gate.
- **A retry refetches rather than replaying.** An hour-long step easily
  outlasts the view it was scheduled under, so the retry re-enters through the
  app: current camera position, altitude gate applied again.
- **Success clears it**, so a later failure starts from 30s rather than
  resuming where it left off.

The layer's count cell shows the wait (`45s`, `5m`, `1h`) and ticks down, and
the tooltip names the attempt and says when it has settled at hourly. A layer
being patient is styled apart from one that is simply dead.

---

## Aircraft and the OpenSky budget

OpenSky's allowance is a daily bucket, not a rate: 400 credits anonymous,
4,000 authenticated, 8,000 for active feeders, refilled at 00:00 UTC. A
`/states/all` call inside 25 square degrees costs one credit. The arithmetic
is unforgiving: a 6-second poll is 600 calls an hour, so a 4,000-credit day
is spent in under seven hours of having the map open, and then the layer is
dead until the next UTC day.

So the poll interval is derived rather than fixed. Every response carries
`X-Rate-Limit-Remaining`, and the server spreads what is left over the time
until the next refill, with the feed's own resolution as the floor (polling
faster than OpenSky publishes only returns the same positions) and five
minutes as the ceiling. A fresh authenticated bucket at the start of a UTC
day works out around 20 seconds; if you have barely used it, the interval
shortens as midnight approaches. The layer's tooltip shows the interval, the
credits left, and says when it has slowed down and why. **SYNC always forces
a lookup**, whatever the budget.

Three other things keep the bill down:

- The queried box is snapped to a 1° grid and capped at 5×5°, exactly the
  edge of the one-credit band. Since OpenSky charges per call and not per
  area, a generous box costs the same as a tight one and returns more, and
  panning around a city reuses one answer instead of spending a credit per
  nudge.
- Polling stops while the browser tab is hidden, and refreshes once on return.
  A terminal left open in a background tab was spending the day's budget on
  frames nobody saw.
- A 429 is honoured. OpenSky reports the wait in
  `X-Rate-Limit-Retry-After-Seconds` (not the standard `Retry-After`), and
  both the server and the browser hold off for it instead of answering "too
  many requests" with more requests.

`OPENSKY_CREDIT_FLOOR` (default 60) is the reserve held back from automatic
polling, so a deliberate look still works after a long day.

---

## Home

Home is where the terminal opens and where the ⌂ button flies. Press **⋯**
next to it in *Saved targets* to set one.

- **Geolocate host and save as home**: asks the server where this machine is
  (ipwho.is, by public address) and pins the answer. Deliberately uncached:
  the point of pressing it is to find out where the host is now.
- **Use current view**: pins wherever the camera is, at the altitude it is
  at. To pin anywhere at all, fly there first (search, or drag the globe) and
  press it. Pinning a city and pinning a rooftop are different pins.
- **Lat / Lon**: type coordinates directly. Name is optional and is what the
  HUD shows; without one it falls back to the coordinates.
- **Clear**: forget the pin and go back to resolving the host each session.

With nothing pinned the behaviour is as it always was: resolve the host on
boot, fall back to Austin if that fails. That resolved location is *not*
saved, which is the distinction worth knowing: a laptop that changes
networks should open over where it is now, not where it was last week.
Pinning is what the geolocate button is for. A pinned home lives in this
browser's local storage and is never sent anywhere.

---

## Base map

The ground layer under everything else. What draws it is always a named choice
in the **BASEMAP** menu, and the source is credited in the bottom-left corner,
including, for Sentinel-2, the date of the scene you are looking at.

- **Streets (OpenStreetMap)**: the default with no Cesium Ion token.
- **Aerial (Cesium World Imagery)**: the default *when* `CESIUM_ION_TOKEN` is
  set, since that is what Cesium draws from an Ion session. High resolution,
  but it is a mosaic of many surveys and a given place can be years out of
  date. If somewhere looks old, this is why; switch to Sentinel-2 to see a
  picture with a date on it.
- **Sentinel-2 (10 m)**: recent Copernicus imagery, dated and selectable.
- **Shortbread (OSM vector)**: OpenStreetMap drawn in the terminal's own
  palette, described below.

Hover **BASEMAP** in the top bar for the controls:

- **Sentinel-2 (10 m)**: recent Copernicus imagery, no credentials required.
  Scenes come from the [Earth Search STAC API](https://element84.com/earth-search/)
  over the [AWS Open Data mirror](https://registry.opendata.aws/sentinel-2-l2a-cogs/)
  and are rendered to tiles by [TiTiler](https://developmentseed.org/titiler/).
  Set a date window and a cloud-cover ceiling; the picker lists what covers the
  current view, newest first, with the least cloudy scene marked ★. These are
  the same scenes a Google Earth Engine viewer shows, reached without Earth
  Engine.
- **Earth Engine composite**: a cloud-masked Sentinel-2 median over the chosen
  window. Optional, and only appears once a Google service account is
  configured; see `.env.example`. Unlike the Sentinel-2 provider this one is
  unverified here, having no credentials to test against.

Scenes are per-view, so the search re-runs when the camera settles somewhere
new. Imagery tiles are fetched by the browser directly rather than proxied:
they are megabytes per screen, and relaying them would add a hop for nothing.

### Shortbread

[Shortbread](https://shortbread-tiles.org/) is Geofabrik's vector tile schema:
a general-purpose OSM extract with a small, stable set of layers. It is a
schema rather than a service, and it is vector-only: there is no raster
endpoint anywhere to point an ordinary imagery provider at.

Cesium consumes raster, so the tiles are fetched as protobuf, decoded, and
drawn to a canvas in the browser (`public/js/mvt.js`, `public/js/shortbread.js`),
which Cesium then treats as any other tile image. Doing the drawing here rather
than deferring to a style engine is the point: the map comes out in the
terminal's palette, so the ground reads as part of the instrument instead of a
web map with a HUD on top. It also avoids a second map library and a build
step: the decoder reads the four protobuf field numbers this needs and skips
the label, POI and address layers, which are most of a city tile.

Tiles come from [VersaTiles](https://versatiles.org/), which serves Shortbread
worldwide, unauthenticated and CORS-open, to zoom 14. Point it elsewhere with:

```
SHORTBREAD_URL=https://your-host/tiles/{z}/{x}/{y}
```

Any server speaking the Shortbread schema over MVT will do, including a local
[versatiles](https://github.com/versatiles-org/versatiles-rs) instance, which
is the offline-capable option. Above zoom 14 Cesium upsamples the last level
rather than fading out, so it stays legible when you keep descending.

---

## Optical modes

Each is a real GLSL post-process pass over the rendered scene, not a CSS filter.
Press `1`–`5`.

- **EO**: unfiltered.
- **FLIR**: thermal ironbow ramp with a crude automatic gain control that stretches local contrast, plus sensor noise and fixed-pattern banding.
- **SAR**: synthetic aperture radar: Sobel-driven backscatter, multiplicative speckle, range lines.
- **CRT**: barrel distortion, misconverged guns, aperture grille, rolling refresh bar.
- **CEL**: posterised and ink-outlined, because surveillance aesthetics don't have to be grim.

`R` re-syncs every layer, `H` hides all chrome for a clean screenshot, `[`
collapses the sensor panel to the left edge, `Esc` closes the detail panel.

---

## How it's put together

```
start.sh           launcher for Linux and macOS
START.bat          launcher for Windows
server.js          zero-dependency Node proxy; holds every credential,
                   normalises ~25 upstream APIs, holds the AIS websocket,
                   TTL cache + in-flight dedupe
public/
  index.html       chrome and HUD
  style.css
  js/app.js        viewer bootstrap, refresh loop, HUD, panel wiring
  js/layers.js     one class per source; each owns a Cesium DataSource
  js/optics.js     the sensor shaders
vendor/            satellite.js, fetched once on first run and cached
```

The browser never holds an API key. Every request goes to `/api/*` on
localhost, and the server attaches credentials on the way out.

Layers refresh from the camera's own view rectangle, debounced 700ms after the
camera settles, and the view span is capped at 4° so a zoomed-out globe doesn't
ask Shodan for the entire planet. Aircraft repoll every 10 seconds; satellites
re-propagate every frame; Overpass and Shodan results cache for 10 and 5
minutes server-side.

### Rate limits worth knowing

- **Shodan**: one query credit per filtered search. Each pan that triggers a refresh is one credit. Turn `AUTO` off to `HOLD` while you explore, then hit `SYNC` when you've framed the shot.
- **NWS**: about 85% of active alerts reference forecast zones instead of carrying a polygon. Resolving each zone would be hundreds of extra requests, so those are counted in the layer note but not drawn. The layer says how many.
- **OpenWebcamDB**: free for non-commercial use only, and the documented list route has no spatial filter, so the whole catalogue (~1,500 cameras) is paged once and cached for six hours, then filtered locally. `GET /api/openwebcamdb/probe` dumps one raw record and its detail response if you need to check the live field names against the normaliser.
- **OpenSky anonymous**: 400 credits/day by IP. A bounding-box request is cheaper than a global one, which is why the view span is capped. Add OAuth credentials for 4,000/day.
- **Overpass**: a donated, shared service with roughly two execution slots per IP. Every selected feature class goes out as **one** unioned query, not one query per class, and all Overpass-backed layers (infrastructure and ALPR) share a single serial queue with a minimum gap between requests. On a 429 the three mirrors rotate, then a cooldown applies and the layer schedules its own retry, and the sidebar shows the countdown rather than just failing.
- **Nominatim**: 1 request/second; searches are debounced and cached for a day.

---

## Adding Google Photorealistic 3D Tiles

The original article used Google's volumetric city meshes. To swap them in,
get a Google Maps Platform key with the Map Tiles API enabled and add to
`initViewer()` in `public/js/app.js`:

```js
const tiles = await Cesium.Cesium3DTileset.fromUrl(
  `https://tile.googleapis.com/v1/3dtiles/root.json?key=${GOOGLE_KEY}`,
  { showCreditsOnScreen: true },
);
scene.primitives.add(tiles);
scene.globe.show = false;
```

Route the key through the server the same way the others go, rather than
putting it in client code. Note it's billed per request past the free monthly
credit, and the FLIR and SAR shaders look considerably better over real
building geometry.

---

## Using this responsibly

Everything here reads public data through documented APIs. That does not make
every use of it legal or wise.

- Mapping ALPR cameras is lawful transparency work: they sit in public, photographing public roads, and organisations from the EFF to local journalists do exactly this. Interfering with one is a different act entirely: damaging or obstructing police equipment is a crime, and this tool exists to document the surveillance layer, not to help anyone attack it.
- The geoIP lookup resolves the location of whatever public IP this machine presents. It's city-level at best, often wrong on mobile and VPN connections, and the server never sends your IP to the browser.
- WiGLE and OpenCelliD are wireless-survey databases. Mapping infrastructure is their purpose and it's ordinary research; using them to work out where a particular person's device has been is a different activity with a different ethical and legal profile.
- Shodan tells you a host answers on a port. It does not authorise you to connect to it. Scanning, logging in, or "just checking if the default password works" against infrastructure you don't own is a crime in most jurisdictions regardless of how the host was found.
- The camera layer shows cameras their operators publish for public viewing: traffic and scenic cams, and OpenWebcamDB's hand-curated directory. It deliberately does not surface unsecured private cameras, and adding that would be both a privacy violation and, in many places, illegal.
- Hazard feeds are for situational awareness, not for life-safety decisions. GDACS and EONET are coordination tools with real latency, and this app caches on top of that. In an actual emergency, follow your local official warning channel.
- OSM feature data is contributed by volunteers and is frequently incomplete or stale. Absence of a marker means nothing.
- Aircraft and satellite positions are hobbyist-grade. Don't navigate with them.

Good uses: mapping your own organisation's external attack surface, security
research and teaching, journalism, understanding what your city already
publishes about itself. Attack-surface work on someone else's network needs
their written authorisation first.

---

## Licence

This code is licensed under the GNU General Public License v3.0 or later
(GPL-3.0-or-later); see `LICENSE`. `vendor/satellite.min.js` is bundled
third-party code and remains under its own MIT licence. Upstream data carries its own terms: Shodan's API terms,
OpenSky's non-commercial licence, OpenStreetMap's ODbL (attribution required
if you republish), CelesTrak's terms, Windy's API terms, OpenWebcamDB's
non-commercial-only terms, and the NASA/USGS/NOAA feeds (US public domain,
attribution appreciated). GDACS data is published by the European Commission
JRC under its own reuse terms.

# Running OpenPanopticon in Docker

The image holds only `server.js` and `public/` on Node 22 Alpine. It runs as
the unprivileged `node` user and keeps its cache on a `/data` volume. Every
setting in [`.env.example`](.env.example) is an ordinary environment variable,
so you can set them with `docker run -e`, a compose file, or Portainer's Env
tab. You don't need a `.env` file.

## Quick start

```sh
docker run -d --name openpanopticon --restart unless-stopped \
  -p 8420:8420 \
  -v openpanopticon-data:/data \
  -e ACCESS_KEY='pick-a-long-random-string' \
  -e ALLOWED_HOSTS='192.168.1.50:8420' \
  -e SHODAN_API_KEY='...' \
  YOUR_DOCKERHUB_USER/openpanopticon:latest
```

Then open `http://192.168.1.50:8420/?key=pick-a-long-random-string` once. The
key is swapped for a cookie, and after that the plain address works in that
browser.

## The two access settings

A container is always reached over the network, so the server's
network-exposure checks are always on:

| Variable | What to put in it |
|---|---|
| `ACCESS_KEY` | Any long random string. If you leave it empty, a new key is generated on every restart and printed in the container log. Set it so the key stays the same. |
| `ALLOWED_HOSTS` | Every address you'll type into the browser, **with the port you browse to**, comma-separated. Example: `192.168.1.50:8420,nas.lan:8420,osint.example.com`. If you publish on a different port (`-p 9000:8420`), list `:9000`. Behind a reverse proxy on 443/80, list the bare host name. |

If the page shows **Misdirected request** (HTTP 421), the container log names
the exact `Host` it refused. Add that value to `ALLOWED_HOSTS`.

## Several users, separate sessions

> [!WARNING]
> **A container lets several people use one server, but each browser is its
> own user.** Anyone with the address and the access key can open it at the same
> time, and nothing on the globe is shared between them. Each browser keeps its
> own layers, filters, optical mode, label style, pinned home, and the features
> it has already fetched (see [Settings persistence](README.md#settings-persistence)
> and [In the browser](README.md#in-the-browser)). Two people looking at the
> "same" map are really two separate sessions: one person's changes never show
> up on the other's screen. To share a view, send the coordinates or a
> screenshot. A link to the server won't carry it over.
>
> These things **are** shared: the API keys and their credit budgets (Shodan,
> OpenSky and the rest are spent by everyone together), the server's response
> cache, and **FLUSH**, which empties that cache for everyone. With no home
> pinned, every user also starts over the *server's* location, not their own.

## Portainer

**As a stack (recommended):** go to *Stacks → Add stack → Web editor* and paste
[`docker-compose.yml`](docker-compose.yml). Under *Environment variables*, add
`IMAGE`, `ACCESS_KEY`, `ALLOWED_HOSTS` and whichever API keys you have. You can
also use *Load variables from .env file* to upload your existing `.env`. To
change a key later, edit the variable and click *Update the stack*.

**As a single container:** go to *Containers → Add container*. Set the image to
`YOUR_DOCKERHUB_USER/openpanopticon:latest`, map port `8420`, add a volume on
`/data`, and enter the settings on the *Env* tab. To change a key later, use
*Duplicate/Edit → Deploy the container*. The `/data` volume keeps the cache.

## All settings

All are optional. Anything unset stays switched off, just like an empty line in
`.env`. See `.env.example` for where to get each key.

| Group | Variables |
|---|---|
| Access | `ACCESS_KEY`, `ALLOWED_HOSTS` |
| Core | `SHODAN_API_KEY`, `CESIUM_ION_TOKEN`, `CARTO_API_KEY` |
| Flights | `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `OPENSKY_CREDIT_FLOOR` |
| Webcams | `WINDY_API_KEY`, `OPENWEBCAMDB_API_KEY`, `FIVE_ELEVEN_KEYS` |
| Hazards | `FIRMS_MAP_KEY`, `EDIS_API_URL`, `EDIS_API_KEY` |
| Vessels and devices | `AISSTREAM_API_KEY`, `OPENCELLID_API_KEY`, `WIGLE_API_NAME`, `WIGLE_API_TOKEN`, `GREYNOISE_API_KEY` |
| Infrastructure | `EIA_API_KEY`, `CLOUDFLARE_API_TOKEN` |
| Base map | `TITILER_URL`, `SHORTBREAD_URL`, `GEE_PROJECT`, `GEE_CLIENT_EMAIL`, `GEE_PRIVATE_KEY` |
| Shodan budget | `SHODAN_CELL_DEG`, `SHODAN_CREDIT_FLOOR` |

`GEE_PRIVATE_KEY` keeps its `\n` escapes on one line, as in `.env`.

These are set by the image and normally left alone: `HOST=0.0.0.0`,
`PORT=8420` (the port inside the container; change the published port
instead), and `OPENPANOPTICON_DATA_DIR=/data`.

**Prefer a file?** Mount it and point the server at it:
`-v /path/to/.env:/config/.env:ro -e OPENPANOPTICON_ENV_FILE=/config/.env`.
Variables set on the container take precedence over the file, even when they
are empty. So use this with `docker run`, not with the compose file, which
sets every variable.

## Health and updates

The image has a built-in health check, so Portainer shows *healthy* once the
server answers. To update, pull `latest` and recreate the container. In
Portainer, use *Recreate → Re-pull image*, or *Update the stack* with
*Re-pull image* switched on. The cache volume carries over.

## Publishing the image (maintainers)

[`.github/workflows/docker.yml`](.github/workflows/docker.yml) builds
`linux/amd64` and `linux/arm64` and pushes `latest` and `sha-<commit>` to
Docker Hub on every push to `main`. Before it can push, add two repository
secrets under *Settings → Secrets and variables → Actions*:

- `DOCKERHUB_USERNAME`: your Docker Hub name
- `DOCKERHUB_TOKEN`: a Docker Hub personal access token with *Read & Write*
  scope

Until those secrets exist, the workflow only builds. You can also push by hand:

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -t YOUR_DOCKERHUB_USER/openpanopticon:latest --push .
```

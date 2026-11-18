#!/usr/bin/env python3
"""
Check what Shodan API calls cost, using your own key.

  1. /shodan/host/{ip}           - does a per-IP lookup spend query credits?
  2. /shodan/host/count + facets - is the count call free, and what does the
                                   "ip" facet return (top IPs, or a distinct count)?
  3. /shodan/host/search/facets  - is "ip" a supported facet at all?

Reads SHODAN_API_KEY from the environment or the project's .env. Never prints it.
Standard library only. Spaced at ~1.2 s per request (Shodan allows 1 req/s).

Usage (from the project folder):
  python test/shodan_probe.py                 # looks up 8.8.8.8 and 1.1.1.1
  python test/shodan_probe.py 1.2.3.4 5.6.7.8 # your own IPs
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.shodan.io"
GAP_S = 1.2
# Raleigh, 10 km: small enough to be cheap to reason about.
COUNT_QUERY = 'geo:"35.7796,-78.6382,10"'


def load_key():
    key = os.environ.get("SHODAN_API_KEY", "").strip()
    if key:
        return key
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip().startswith("SHODAN_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("SHODAN_API_KEY not found in the environment or .env")


KEY = load_key()
_last = 0.0


def get(path, **params):
    global _last
    wait = _last + GAP_S - time.time()
    if wait > 0:
        time.sleep(wait)
    params["key"] = KEY
    url = f"{API}{path}?{urllib.parse.urlencode(params)}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        return {"_error": f"HTTP {e.code}: {body}"}
    except Exception as e:  # network, timeout, bad JSON
        return {"_error": f"{type(e).__name__}: {e}"}
    finally:
        _last = time.time()


def credits(label):
    info = get("/api-info")
    if "_error" in info:
        print(f"  [{label}] api-info failed: {info['_error']}")
        return None
    q = info.get("query_credits")
    print(f"  [{label}] query_credits={q}  scan_credits={info.get('scan_credits')}  plan={info.get('plan')}")
    return q


def delta(before, after, what):
    if before is None or after is None:
        print(f"  => {what}: could not compare (api-info failed)\n")
        return
    used = before - after
    verdict = "FREE (no query credits used)" if used == 0 else f"COSTS {used} query credit(s)"
    print(f"  => {what}: {verdict}\n")


def main():
    ips = sys.argv[1:] or ["8.8.8.8", "1.1.1.1"]

    print("\n1) Per-IP host lookup: /shodan/host/{ip}")
    before = credits("before")
    for ip in ips:
        h = get(f"/shodan/host/{urllib.parse.quote(ip)}")
        if "_error" in h:
            print(f"  {ip}: {h['_error']}")
            continue
        ports = sorted(h.get("ports") or [])
        loc = ", ".join(x for x in (h.get("city"), h.get("country_name")) if x)
        print(f"  {ip}: {len(ports)} ports {ports[:30]}{' ...' if len(ports) > 30 else ''}"
              f"  | {len(h.get('data') or [])} banners | {h.get('org')} | {loc}")
    after = credits("after")
    delta(before, after, f"{len(ips)} host lookup(s)")

    print(f"2) Count with facets: /shodan/host/count  query={COUNT_QUERY}")
    before = after if after is not None else credits("before")
    c = get("/shodan/host/count", query=COUNT_QUERY, facets="ip:10,port:10")
    if "_error" in c:
        print(f"  count failed: {c['_error']}")
    else:
        print(f"  total (services): {c.get('total'):,}")
        f = c.get("facets") or {}
        for name in ("ip", "port"):
            rows = f.get(name)
            if rows is None:
                print(f"  facet '{name}': not returned")
                continue
            print(f"  facet '{name}' ({len(rows)} rows):")
            for row in rows:
                print(f"     {row.get('value')!s:>18}  {row.get('count'):,}")
        if f.get("ip"):
            print("  -> if the 'ip' rows are individual addresses with per-IP service counts,")
            print("     the facet is 'top IPs', not a distinct-host total.")
    after = credits("after")
    delta(before, after, "host/count with facets")

    print("3) Supported facets: /shodan/host/search/facets")
    fl = get("/shodan/host/search/facets")
    if isinstance(fl, dict) and "_error" in fl:
        print(f"  failed: {fl['_error']}")
    else:
        print(f"  {len(fl)} facets; 'ip' supported: {'ip' in fl}")
        print("  " + ", ".join(sorted(fl)))


if __name__ == "__main__":
    main()

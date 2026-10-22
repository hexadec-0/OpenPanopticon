# Security policy

OpenPanopticon runs a local server that holds your API keys and talks to
dozens of upstream services, so security reports are welcome.

## Reporting a vulnerability

Please report privately, through GitHub's private vulnerability reporting:
the **Security** tab of this repository → **Report a vulnerability**.
Do not open a public issue for anything exploitable.

Include what you found, how to reproduce it, and what an attacker gains. You
should get an acknowledgement within a week.

## Supported versions

Only the latest tagged release is supported. Fixes are not backported.

## Scope

In scope:

- the local server (`server.js`): credential handling, the Host / origin /
  access-key checks, request routing, the disk cache
- the frontend (`public/`): rendering of upstream data, URL handling,
  anything that lets a page or upstream run script in the app's origin
- the launch scripts (`start.sh`, `START.bat`, `chromebook.sh`), including
  how they install Node, store the access key and write logs

Out of scope:

- the upstream data sources themselves (Shodan, OpenSky, OSM, and so on);
  report those to their operators
- what the data shows: an exposed host found through the Shodan layer is the
  host owner's issue, not this project's

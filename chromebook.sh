#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 hexadec
#
# OPENPANOPTICON — Chromebook (ChromeOS Linux / Crostini) helper
#
#   bash chromebook.sh          one-time setup: Node, .env, launcher icon
#   bash chromebook.sh open     start in the background (if needed) and open Chrome
#   bash chromebook.sh stop     stop a background server
#   bash chromebook.sh log      follow the background server's log
#
# The launcher icon this adds runs "open", so after setup you can start
# OpenPanopticon from the ChromeOS launcher like any other app.
#
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
HERE="$(pwd)"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'
RED=$'\033[31m'; CYN=$'\033[36m'; RST=$'\033[0m'
say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "${YEL}$*${RST}" >&2; }
die()  { printf '%s\n' "${RED}$*${RST}" >&2; exit 1; }

# server.js refuses to start on anything older, so setup must not settle for less.
NODE_WANT=22

# Runtime files live outside the repo, private to this user: the access key
# opens the server (and with it every API key in .env), and a log or pid file
# in the project folder is one "git add ." away from being published.
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/openpanopticon"
LOG="$STATE/server.log"
PIDFILE="$STATE/server.pid"
KEYFILE="$STATE/access-key"
LEGACY_LOG="$HERE/openpanopticon.log"
LEGACY_PIDFILE="$HERE/.openpanopticon.pid"

# NodeSource's repository signing key, checked before apt is told to trust it.
NODESOURCE_KEY_URL="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
NODESOURCE_FPR="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
NODESOURCE_KEYRING="/etc/apt/keyrings/nodesource.gpg"

is_crostini() { [ -e /dev/.cros_milestone ] || [ -d /opt/google/cros-containers ]; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

port() {
  node -e '
    try {
      const m = /^\s*PORT\s*=\s*(\d+)/m.exec(require("fs").readFileSync(".env","utf8"));
      process.stdout.write(m ? m[1] : "8420");
    } catch { process.stdout.write("8420"); }' 2>/dev/null || echo 8420
}

private_state() {
  ( umask 077; mkdir -p "$STATE" )
  chmod 700 "$STATE"
}

# Older versions of this script wrote the log (which carries the access-key URL
# from the startup banner) and the pid file into the project folder.
clean_legacy() {
  if [ -f "$LEGACY_LOG" ]; then
    rm -f "$LEGACY_LOG"
    warn "  Removed the old $LEGACY_LOG — it could contain the server's access key."
  fi
}

# The key start.sh hands to the server when it listens beyond loopback.
# Kept across launches, so a browser tab that already holds the cookie
# keeps working after a restart.
access_key() {
  private_state
  if [ ! -s "$KEYFILE" ]; then
    ( umask 077
      node -e 'process.stdout.write(require("crypto").randomBytes(18).toString("base64url"))' > "$KEYFILE" )
  fi
  chmod 600 "$KEYFILE"
  cat "$KEYFILE"
}

# HTTP status of /api/health, or 000 when nothing answers. The server refuses
# /api/* without the X-Panopticon header (403), and when it listens beyond
# loopback it also wants the access-key cookie (401). The cookie goes to curl
# on stdin, not the command line, so it never shows up in `ps`.
health_code() {
  local key="${1:-}"
  {
    [ -n "$key" ] && printf 'cookie = "op_access=%s"\n' "$key"
    true
  } | curl -s -o /dev/null -w '%{http_code}' --max-time 2 -K - \
        -H 'X-Panopticon: 1' "http://127.0.0.1:$(port)/api/health" 2>/dev/null || true
}

running() { [ "$(health_code "$(access_key)")" = 200 ]; }

# Something answers on the port, whether or not it accepts our key.
port_answers() { [ "$(health_code)" != 000 ]; }

# The pid is only trusted if it is still a node process serving *this* checkout.
ours() {
  local pid="$1"
  [ -n "$pid" ] && [ -d "/proc/$pid" ] || return 1
  [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$HERE" ] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -Eq '(^|/)node .*server\.js'
}

# --- setup ------------------------------------------------------------------

install_nodesource() {
  say "  Adding NodeSource's apt repository for Node ${NODE_WANT}."
  sudo apt-get install -y ca-certificates curl gnupg

  local tmp; tmp="$(mktemp -d)"
  curl -fsSL --proto '=https' --tlsv1.2 "$NODESOURCE_KEY_URL" -o "$tmp/key.asc"
  local fpr
  fpr="$(gpg --batch --with-colons --show-keys "$tmp/key.asc" 2>/dev/null | awk -F: '/^fpr:/ { print $10; exit }')"
  [ "$fpr" = "$NODESOURCE_FPR" ] || { rm -rf "$tmp"; die "  NodeSource's signing key has an unexpected fingerprint (${fpr:-none}).
  Not installing. Install Node ${NODE_WANT}+ yourself (https://nodejs.org) and run this again."; }
  gpg --batch --dearmor < "$tmp/key.asc" > "$tmp/nodesource.gpg"

  sudo install -d -m 0755 /etc/apt/keyrings
  sudo install -m 0644 "$tmp/nodesource.gpg" "$NODESOURCE_KEYRING"
  rm -rf "$tmp"
  printf 'deb [signed-by=%s] https://deb.nodesource.com/node_%s.x nodistro main\n' \
    "$NODESOURCE_KEYRING" "$NODE_WANT" | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y nodejs
}

ensure_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge "$NODE_WANT" ]; then
    say "  ${GRN}✓${RST} Node $(node -v)"
    return
  fi

  say "  Node ${NODE_WANT}+ is needed. Installing it uses sudo, which ChromeOS Linux"
  say "  allows without a password by default."

  sudo apt-get update -qq

  local cand
  cand="$(apt-cache policy nodejs 2>/dev/null | sed -n 's/^ *Candidate: *\([0-9]*\).*/\1/p' | head -n1)"
  cand="${cand:-0}"; [[ "$cand" =~ ^[0-9]+$ ]] || cand=0

  if [ "$cand" -ge "$NODE_WANT" ]; then
    sudo apt-get install -y nodejs
  else
    say "  Debian's nodejs here is too old (${cand})."
    install_nodesource
  fi

  [ "$(node_major)" -ge "$NODE_WANT" ] \
    || die "  Node install didn't produce ${NODE_WANT}+ (got $(node -v 2>/dev/null || echo none))."
  say "  ${GRN}✓${RST} Node $(node -v)"
}

ensure_tools() {
  local missing=()
  command -v curl     >/dev/null 2>&1 || missing+=(curl)
  command -v xdg-open >/dev/null 2>&1 || missing+=(xdg-utils)
  if [ "${#missing[@]}" -gt 0 ]; then
    say "  Installing ${missing[*]}"
    sudo apt-get install -y "${missing[@]}"
  fi
  say "  ${GRN}✓${RST} curl, xdg-open"
}

ensure_env() {
  if [ -f .env ]; then
    say "  ${GRN}✓${RST} .env present"
  else
    ( umask 077; cp .env.example .env )
    say "  ${GRN}✓${RST} created .env from .env.example — add your Shodan key to it"
  fi
  # It holds every API key; nobody else on this machine needs to read it.
  chmod 600 .env 2>/dev/null || true
  chmod +x start.sh chromebook.sh 2>/dev/null || true
}

install_launcher() {
  local apps="$HOME/.local/share/applications" icons="$HOME/.local/share/icons/hicolor/scalable/apps"
  mkdir -p "$apps" "$icons"

  cat > "$icons/openpanopticon.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0f0d"/><circle cx="16" cy="16" r="11" fill="none" stroke="#39ff88" stroke-width="2"/><path d="M5 16h22M16 5c5 5 5 17 0 22M16 5c-5 5-5 17 0 22" fill="none" stroke="#39ff88" stroke-width="1.5"/></svg>
SVG

  cat > "$apps/openpanopticon.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=OpenPanopticon
Comment=OSINT data fusion globe
Exec=bash "$HERE/chromebook.sh" open
Icon=openpanopticon
Terminal=false
Categories=Network;Utility;
DESK
  say "  ${GRN}✓${RST} added OpenPanopticon to the ChromeOS launcher (Linux apps folder)"
}

setup() {
  is_crostini || warn "  This doesn't look like ChromeOS Linux — continuing anyway."
  say ""
  say "  ${CYN}${BOLD}OpenPanopticon — Chromebook setup${RST}"
  say ""
  case "$HERE" in
    /mnt/chromeos/*)
      warn "  Running from a folder shared from ChromeOS Files. It works, but disk"
      warn "  access through the share is slow; copying the folder into 'Linux files'"
      warn "  is faster. (Re-run this script from the new place if you move it.)" ;;
  esac
  ensure_node
  ensure_tools
  ensure_env
  private_state
  clean_legacy
  install_launcher
  say ""
  say "  Done. Start it from the launcher icon, or here with:"
  say "    ${BOLD}./start.sh${RST}            (in this terminal; ctrl-c stops it)"
  say "    ${BOLD}bash chromebook.sh open${RST}  (in the background)"
  say "  It opens at ${CYN}http://$(hostname).linux.test:$(port)${RST}"
  say ""
}

# --- background run, used by the launcher icon ------------------------------

open_app() {
  local key url
  key="$(access_key)"
  clean_legacy
  url="http://$(hostname).linux.test:$(port)"

  if ! running; then
    if port_answers; then
      die "  Something is already answering on port $(port) but doesn't accept this
  launcher's key — probably OpenPanopticon started from a terminal with ./start.sh.
  Use the URL printed there, or stop it and run this again."
    fi
    # The banner prints the access-key URL; keep it out of the log.
    ( umask 077; : > "$LOG" )
    ACCESS_KEY="$key" OPENPANOPTICON_NO_BROWSER=1 \
      nohup bash "$HERE/start.sh" \
      > >(sed -u 's/\([?&]key=\)[A-Za-z0-9_-]*/\1<redacted>/g' >>"$LOG") 2>&1 </dev/null &
    ( umask 077; echo $! > "$PIDFILE" )
    for _ in $(seq 1 60); do running && break; sleep 0.25; done
    running || { xdg-open "file://$LOG" >/dev/null 2>&1 || true; die "  Server didn't start — see $LOG"; }
  fi

  # Only a server listening beyond loopback asks for the key (401 without it).
  if [ "$(health_code)" = 401 ]; then url="$url/?key=$key"; fi
  xdg-open "$url" >/dev/null 2>&1 || say "  Open $url in Chrome."
}

stop_app() {
  local stopped=0 pid
  for f in "$PIDFILE" "$LEGACY_PIDFILE"; do
    [ -f "$f" ] || continue
    pid="$(cat "$f" 2>/dev/null || true)"
    # start.sh execs node, so this pid is the server itself — but only signal
    # it if it still is, rather than whatever process inherited the number.
    if ours "$pid" && kill "$pid" 2>/dev/null; then stopped=1; fi
    rm -f "$f"
  done
  if [ "$stopped" = 0 ]; then
    for pid in $(pgrep -f 'node .*server\.js' 2>/dev/null || true); do
      if ours "$pid" && kill "$pid" 2>/dev/null; then stopped=1; fi
    done
  fi
  [ "$stopped" = 1 ] && say "  stopped" || say "  not running"
}

case "${1:-setup}" in
  setup) setup ;;
  open)  open_app ;;
  stop)  stop_app ;;
  log)   [ -f "$LOG" ] || die "  No log yet at $LOG"; tail -f "$LOG" ;;
  *)     die "  usage: bash chromebook.sh [setup|open|stop|log]" ;;
esac

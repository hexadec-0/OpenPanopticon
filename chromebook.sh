#!/usr/bin/env bash
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

NODE_WANT=22                       # LTS line installed from NodeSource if needed
LOG="$HERE/openpanopticon.log"
PIDFILE="$HERE/.openpanopticon.pid"

is_crostini() { [ -e /dev/.cros_milestone ] || [ -d /opt/google/cros-containers ]; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

port() {
  node -e '
    try {
      const m = /^\s*PORT\s*=\s*(\d+)/m.exec(require("fs").readFileSync(".env","utf8"));
      process.stdout.write(m ? m[1] : "8420");
    } catch { process.stdout.write("8420"); }' 2>/dev/null || echo 8420
}

running() { curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:$(port)/api/health"; }

# --- setup ------------------------------------------------------------------

ensure_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node_major)" -ge 18 ]; then
    say "  ${GRN}✓${RST} Node $(node -v)"
    return
  fi

  say "  Node 18+ is needed. Installing it needs your Linux password-less sudo,"
  say "  which ChromeOS Linux has by default."

  sudo apt-get update -qq

  # Debian bookworm and newer ship Node 18+; older containers (bullseye) don't.
  local cand
  cand="$(apt-cache policy nodejs 2>/dev/null | sed -n 's/^ *Candidate: *\([0-9]*\).*/\1/p' | head -n1)"
  cand="${cand:-0}"; [[ "$cand" =~ ^[0-9]+$ ]] || cand=0

  if [ "$cand" -ge 18 ]; then
    sudo apt-get install -y nodejs
  else
    say "  Debian's nodejs here is too old (${cand}); adding NodeSource for Node ${NODE_WANT}."
    sudo apt-get install -y ca-certificates curl
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_WANT}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

  [ "$(node_major)" -ge 18 ] || die "  Node install didn't produce 18+ (got $(node -v 2>/dev/null || echo none))."
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
    cp .env.example .env
    say "  ${GRN}✓${RST} created .env from .env.example — add your Shodan key to it"
  fi
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
  local url="http://$(hostname).linux.test:$(port)"
  if ! running; then
    : > "$LOG"
    OPENPANOPTICON_NO_BROWSER=1 nohup bash "$HERE/start.sh" >>"$LOG" 2>&1 </dev/null &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 60); do running && break; sleep 0.25; done
    running || { xdg-open "file://$LOG" >/dev/null 2>&1 || true; die "  Server didn't start — see $LOG"; }
  fi
  xdg-open "$url" >/dev/null 2>&1 || say "  Open $url in Chrome."
}

stop_app() {
  local stopped=0
  if [ -f "$PIDFILE" ]; then
    local pid; pid="$(cat "$PIDFILE")"
    # start.sh execs node, so this pid is the server itself.
    if kill "$pid" 2>/dev/null; then stopped=1; fi
    rm -f "$PIDFILE"
  fi
  if [ "$stopped" = 0 ] && running; then
    pkill -f "node server.js" && stopped=1 || true
  fi
  [ "$stopped" = 1 ] && say "  stopped" || say "  not running"
}

case "${1:-setup}" in
  setup) setup ;;
  open)  open_app ;;
  stop)  stop_app ;;
  log)   tail -f "$LOG" ;;
  *)     die "  usage: bash chromebook.sh [setup|open|stop|log]" ;;
esac

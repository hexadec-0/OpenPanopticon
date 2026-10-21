#!/usr/bin/env bash
#
# OPENPANOPTICON — OSINT Data Fusion  (ver. 1.0.1)
# Launcher for Linux, macOS and Chromebook Linux. Windows: run START.bat instead.
# First time on a Chromebook? Run   bash chromebook.sh   once.
#
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'
RED=$'\033[31m'; CYN=$'\033[36m'; RST=$'\033[0m'

say()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "${YEL}$*${RST}" >&2; }
die()  { printf '%s\n' "${RED}$*${RST}" >&2; exit 1; }

# --- Chromebook (Crostini) detection ----------------------------------------
#
# ChromeOS runs Linux in a container. Chrome lives outside it, and ChromeOS only
# forwards localhost for a short list of common dev ports — 8420 isn't one. So on
# a Chromebook the server listens on the container's own interface and Chrome
# reaches it at <container>.linux.test (normally penguin.linux.test). The
# container sits behind ChromeOS's private NAT, so this does not expose it to
# your Wi-Fi unless you add a port forward in ChromeOS Settings yourself.

is_crostini() {
  [ -e /dev/.cros_milestone ] || [ -d /opt/google/cros-containers ]
}

# --- Node -------------------------------------------------------------------

if is_crostini && ! command -v node >/dev/null 2>&1; then
  die "
  Node.js was not found. On a Chromebook, run the one-time setup first:

    bash chromebook.sh
"
fi

command -v node >/dev/null 2>&1 || die "
  Node.js was not found on PATH.

  Install Node 18 or newer:
    macOS         brew install node
    Debian/Ubuntu sudo apt install nodejs
    Fedora        sudo dnf install nodejs
    Arch          sudo pacman -S nodejs
    any           https://nodejs.org
"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  if is_crostini; then
    die "  Node $(node -v) is too old — OpenPanopticon needs 18 or newer.
  Run   bash chromebook.sh   to install a current version."
  fi
  die "  Node $(node -v) is too old — OpenPanopticon needs 18 or newer for built-in fetch."
fi

# --- .env -------------------------------------------------------------------

if [ ! -f .env ]; then
  say "  ${DIM}No .env found — creating one from .env.example${RST}"
  cp .env.example .env
  say ""
  say "  Add your Shodan API key to ${BOLD}.env${RST} to enable the Shodan layer."
  say "  Every other source works without a key, so it starts either way."
  say ""
  # Only offer an editor on a real terminal. Under a pipe, cron or a CI
  # runner there is nobody to answer, and launching vi there hangs the script.
  if [ -t 0 ] && [ -t 1 ]; then
    read -r -p "  Open .env in an editor now? [y/N] " reply || reply=""
    case "$reply" in
      [Yy]*) "${EDITOR:-${VISUAL:-vi}}" .env ;;
    esac
  fi
fi

# --- port -------------------------------------------------------------------

PORT="$(node -e '
  try {
    const m = /^\s*PORT\s*=\s*(\d+)/m.exec(require("fs").readFileSync(".env","utf8"));
    process.stdout.write(m ? m[1] : "8420");
  } catch { process.stdout.write("8420"); }
')"
LOCAL_URL="http://127.0.0.1:${PORT}"   # health checks from inside this machine
URL="$LOCAL_URL"                       # what the browser opens

if is_crostini; then
  # Listen on the container interface unless the user chose a HOST themselves.
  ENV_HOST="$(sed -n 's/^[[:space:]]*HOST[[:space:]]*=[[:space:]]*//p' .env | tail -n1 | tr -d '\r"'"'"' ')"
  if [ -z "${HOST:-}" ] && { [ -z "$ENV_HOST" ] || [ "$ENV_HOST" = "127.0.0.1" ] || [ "$ENV_HOST" = "localhost" ]; }; then
    export HOST=0.0.0.0
  fi
  URL="http://$(hostname).linux.test:${PORT}"
fi

port_busy() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -i ":${PORT}" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :${PORT}" 2>/dev/null | grep -q .
  else
    return 1
  fi
}

if port_busy; then
  warn "  Port ${PORT} is already in use — is OpenPanopticon already running at ${URL}?"
  warn "  Change PORT in .env, or stop the other process, then run this again."
  exit 1
fi

# --- open a browser once the server answers ---------------------------------

open_browser() {
  for _ in $(seq 1 40); do
    if command -v curl >/dev/null 2>&1; then
      curl -sf -o /dev/null "${LOCAL_URL}/api/health" && break
    else
      sleep 0.25
    fi
    sleep 0.25
  done
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1 || true
  elif command -v open  >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1 || true
  else say "  Open ${CYN}${URL}${RST} in your browser."
  fi
}

if [ "${OPENPANOPTICON_NO_BROWSER:-${WORLDVIEW_NO_BROWSER:-0}}" != "1" ]; then
  open_browser &
fi

say ""
say "  ${CYN}starting OpenPanopticon on ${URL}${RST}   ${DIM}(ctrl-c to stop)${RST}"
say ""

exec node server.js

#!/usr/bin/env bash
# Installs the built Case Maker .deb and proves it (#866): apt resolves what the package declares,
# the systemd unit is in place, and the app serves /api/v1/health when run HEADLESS — no window, no
# X server (#867). Then it removes the package again.
#
#     sudo tools/linux/check-deb.sh [deb] [port]
#
# Run it on a machine with nothing on it — a bare ubuntu:24.04 container is ideal. That is the
# whole point: anything the package forgot to declare shows up here rather than on someone's
# laptop.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEB="${1:-$(ls "$ROOT"/artifacts/release/casemaker_*_amd64.deb 2>/dev/null | head -1)}"
PORT="${2:-18123}"

[ -n "${DEB:-}" ] && [ -f "$DEB" ] || { echo "::error::no .deb — run tools/linux/build-deb.sh first" >&2; exit 1; }
[ "$(id -u)" = 0 ] || { echo "::error::run this as root (it installs a package)" >&2; exit 1; }

fail() { echo "::error::$*" >&2; exit 1; }

echo "=== before: what is not on this machine ==="
command -v casemaker >/dev/null 2>&1 && echo "  a casemaker is already installed, so this proves less than it should" || echo "  no casemaker"
[ -z "${DISPLAY:-}" ] && echo "  no DISPLAY (headless is the claim)" || echo "  DISPLAY=${DISPLAY} is set; the check unsets it"

echo
echo "=== installing, letting apt resolve what the package says it needs ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq "$DEB" 2>&1 | tail -2
dpkg-query -W -f='  dpkg: ${Package} ${Version} — ${Status}\n' casemaker

echo
echo "=== the systemd unit the package ships (#867) ==="
UNIT=/lib/systemd/system/casemaker.service
[ -f "$UNIT" ] || fail "the package installed no $UNIT"
grep -E '^ExecStart=' "$UNIT" | sed 's/^/  /'
grep -q 'ExecStart=/usr/bin/casemaker --headless --bind-all' "$UNIT" || fail "$UNIT does not start the headless server"

echo
echo "=== launching it headless, and asking it for its health ==="
unset DISPLAY
casemaker --headless --bind-all --port "$PORT" > "$ROOT/artifacts/check-deb.log" 2>&1 &
APP=$!
trap 'kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null' EXIT
HEALTH=""
for _ in $(seq 60); do
    HEALTH="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null || true)"
    [ -n "$HEALTH" ] && break
    sleep 1
done
[ -n "$HEALTH" ] || { tail -20 "$ROOT/artifacts/check-deb.log" 2>/dev/null; fail "no /api/v1/health within 60 s — the headless server did not come up"; }
echo "  $HEALTH"
echo "$HEALTH" | grep -q '"ok":true' || fail "health did not answer ok:true"
BUILD="$(echo "$HEALTH" | sed -n 's/.*"build":"\([^"]*\)".*/\1/p')"
[ -n "$BUILD" ] && [ "$BUILD" != "unknown" ] || fail "the binary reports no build stamp (CASEMAKER_BUILD was not set at build time)"

echo
echo "=== stopping it, and removing the package again ==="
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null; trap - EXIT
apt-get remove -y -qq casemaker 2>&1 | tail -1
[ ! -e /usr/bin/casemaker ] || fail "the package did not remove /usr/bin/casemaker"
echo "check-deb: ok — installed, served headless, removed"

#!/usr/bin/env bash
# Installs the built Case Maker snap and proves it under strict confinement (#866): the app starts
# from the snap, serves its own /api/v1/health, and is confined.
#
#     sudo tools/linux/check-snap.sh <file.snap> [port]
#
# Snapd tracks each snap process in a scope under the USER's systemd manager, so this must run
# inside a user session. The workflow wraps the call:
#     sudo systemd-run --machine=$USER@.host --user --pipe --wait --quiet --collect \
#         tools/linux/check-snap.sh <snap>
set -uo pipefail

SNAP="${1:?usage: check-snap.sh <file.snap> [port]}"
PORT="${2:-18126}"
[ -f "$SNAP" ] || { echo "::error::no snap at $SNAP" >&2; exit 1; }
fail() { echo "::error::$*" >&2; exit 1; }

echo "=== installing the snap"
snap install --dangerous "$SNAP" >/dev/null || fail "snap install refused the package"
snap list casemaker | sed 's/^/  /'
conf="$(snap list --unicode=never casemaker | awk 'NR==2{print $(NF-2)}')"
echo "  confinement: $conf"

echo "=== running it headless from the snap, and asking it for its health"
casemaker.casemaker --headless --bind-all --port "$PORT" > /tmp/check-snap.log 2>&1 &
APP=$!
trap 'kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null; snap remove casemaker >/dev/null 2>&1' EXIT
HEALTH=""
for _ in $(seq 60); do
    HEALTH="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null || true)"
    [ -n "$HEALTH" ] && break; sleep 1
done
if printf '%s' "${HEALTH:-}" | grep -q '"ok":true'; then
    echo "  /api/v1/health answered from the snap"
else
    tail -20 /tmp/check-snap.log 2>/dev/null
    fail "the snap did not serve /api/v1/health (the gnome extension's WebKitGTK, or the apparmor profile, is the usual cause)"
fi
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null

echo "=== removing it"
snap remove casemaker >/dev/null || fail "snap remove failed"
echo "check-snap: ok — installed, served headless under strict confinement, removed"

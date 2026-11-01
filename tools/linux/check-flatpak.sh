#!/usr/bin/env bash
# Installs the built Case Maker Flatpak and runs the app inside its sandbox (#866).
#
#     tools/linux/check-flatpak.sh [bundle]
#
# The point is not that a bundle exists — it is that what is inside it starts, serves the app over
# the network it was given, and can read nothing it was not. Every step here is something a package
# can get wrong while still building.
#
# A container is not a desktop session, and flatpak wants three things a desktop has and a
# container has not: XDG_RUNTIME_DIR, a session bus and a system bus. Set up here rather than left
# to be rediscovered.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUNDLE=${1:-$ROOT/artifacts/flathub/ca.electricrv.CaseMaker.flatpak}
APP_ID=ca.electricrv.CaseMaker
PORT=18125

[ -f "$BUNDLE" ] || { echo "::error::no bundle at $BUNDLE — run tools/linux/build-flathub-flatpak.sh first" >&2; exit 1; }

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/casemaker-xdg-runtime}"
mkdir -p "$XDG_RUNTIME_DIR" && chmod 700 "$XDG_RUNTIME_DIR"
if [ ! -S /run/dbus/system_bus_socket ] && command -v dbus-daemon >/dev/null; then
    mkdir -p /run/dbus && dbus-daemon --system --fork 2>/dev/null || true
fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then
    exec dbus-run-session -- "$0" "$@"
fi

failures=0
step()  { echo; echo "=== $* ==="; }
check() { if [ "$1" -eq 0 ]; then echo "  ok"; else echo "  FAIL (exit $1)"; failures=$((failures + 1)); fi; }

step "installing the bundle"
flatpak install -y --noninteractive --user "$BUNDLE" >/dev/null 2>&1 \
    || flatpak install -y --noninteractive --user --reinstall "$BUNDLE" >/dev/null 2>&1
flatpak list --user --columns=application,version,branch

step "what the sandbox actually grants"
# Printed, not asserted: the manifest is the assertion, and seeing the resolved set is what
# catches a finish-arg that did something other than what it looks like. Network IS in it: the
# app's job is to serve the page and drive the machine (#866).
flatpak info --show-permissions "$APP_ID"

step "inside the sandbox: one binary, and the listing files came with it"
flatpak run --user --command=sh "$APP_ID" -c '
    set -e
    test -f /.flatpak-info
    echo "  /.flatpak-info is there, so the app can tell"
    test -x /app/bin/casemaker
    echo "  the binary is at /app/bin/casemaker"
    echo "  metainfo:      $(ls /app/share/metainfo/)"
    echo "  desktop entry: $(ls /app/share/applications/)"
'
check $?

step "the person's home is not readable from inside — which is the point"
MARKER="$HOME/.casemaker-outside-marker"
echo "a file only the real home has" > "$MARKER"
flatpak run --user --command=sh "$APP_ID" -c '
    if cat "'"$MARKER"'" >/dev/null 2>&1; then
        echo "  the real home leaked into the sandbox"
        exit 1
    fi
    echo "  a file in the real home is not readable from inside"
'
check $?
rm -f "$MARKER"

step "the app serves the page from inside the sandbox (--share=network)"
# The sandbox has the host's network namespace because the app exists to serve a LAN and drive a
# machine; this launches it headless and asks its own server.
flatpak run --user "$APP_ID" --headless --bind-all --port "$PORT" >/dev/null 2>&1 &
APP=$!
HEALTH=""
for _ in $(seq 60); do
    HEALTH="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null || true)"
    [ -n "$HEALTH" ] && break; sleep 1
done
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null
if printf '%s' "${HEALTH:-}" | grep -q '"ok":true'; then
    echo "  /api/v1/health answered from inside the sandbox"
else
    echo "  FAIL /api/v1/health did not answer (the runtime may lack webkit2gtk-4.1, or --share=network is missing)"
    failures=$((failures + 1))
fi

echo
if [ "$failures" -eq 0 ]; then echo "flatpak: every check passed"; else echo "flatpak: $failures check(s) failed"; fi
exit "$failures"

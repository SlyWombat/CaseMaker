#!/usr/bin/env bash
# The release tarball a Flathub manifest fetches, and its checksum (#866).
#
#     tools/linux/make-release-tarball.sh [binary-dir] [out-dir]
#
#   binary-dir   where the release binary was built, default casemaker-app/src-tauri/target/release
#   out-dir      default artifacts/release
#
# Output: casemaker-linux-x64-<version>.tar.gz and .sha256.
#
# **One archive, one checksum.** Flathub's manifest lives in its own repository and has to name
# every source with a URL and a hash; a manifest with four of them is four things to get right at
# release time and four things to notice when one is stale. So the tarball carries the packaging
# files too — the launcher, the desktop entry, the metainfo and the install scripts — under
# flatpak/ and bin/, exactly as the build that produced the binary had them in this repository.
#
# The app version is tauri.conf.json's, plus tools/linux/package-version.sh's packaging revision.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/casemaker-app"
BIN_DIR="${1:-$APP/src-tauri/target/release}"
OUT="${2:-$ROOT/artifacts/release}"
SRC="$ROOT/tools/linux"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

VERSION="$(node -p "require('$APP/src-tauri/tauri.conf.json').version")"
PKG_VERSION="$("$SRC/package-version.sh" "$VERSION")"

[ -x "$BIN_DIR/casemaker" ] || {
    echo "::error::no release binary at $BIN_DIR/casemaker — run npx tauri build first" >&2; exit 1; }

TREE="$STAGE/casemaker"
mkdir -p "$TREE/bin" "$TREE/flatpak" "$OUT"
cp "$BIN_DIR/casemaker" "$TREE/bin/casemaker"
chmod 0755 "$TREE/bin/casemaker"
printf '%s\n' "$PKG_VERSION" > "$TREE/VERSION"
cp "$SRC/casemaker.desktop" "$TREE/flatpak/casemaker.desktop"
cp "$SRC/install.sh" "$SRC/uninstall.sh" "$TREE/bin/"
chmod 0755 "$TREE/bin/install.sh" "$TREE/bin/uninstall.sh"
cp "$APP/src-tauri/icons/128x128.png" "$TREE/flatpak/casemaker.png"
cp "$APP/src-tauri/windows/license.txt" "$TREE/LICENCE.txt"
if [ -f "$SRC/flatpak/ca.electricrv.CaseMaker.metainfo.xml" ]; then
    cp "$SRC/flatpak/ca.electricrv.CaseMaker.metainfo.xml" "$TREE/flatpak/"
    # The one thing about a release that is easy to get wrong and impossible to see afterwards:
    # the metainfo's newest <release> must be this version.
    grep -q "version=\"$VERSION\"" "$TREE/flatpak/ca.electricrv.CaseMaker.metainfo.xml" \
        || { echo "::error::the metainfo has no <release version=\"$VERSION\"> — update tools/linux/flatpak/ca.electricrv.CaseMaker.metainfo.xml" >&2; exit 1; }
fi

NAME="casemaker-linux-x64-${PKG_VERSION}.tar.gz"
tar -C "$TREE" --owner=0 --group=0 --numeric-owner -czf "$OUT/$NAME" .
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" && cat "$NAME.sha256")

if [ -z "${SKIP_LAUNCH_CHECK:-}" ]; then
    # The archive is proved by unpacking it somewhere else and launching what it contains.
    CHECK="$(mktemp -d)"
    trap 'rm -rf "$STAGE" "$CHECK"' EXIT
    tar -C "$CHECK" -xzf "$OUT/$NAME"
    PORT=$(( 20000 + RANDOM % 20000 ))
    ( "$CHECK/bin/casemaker" --headless --bind-all --port "$PORT" >"$CHECK/app.log" 2>&1 & echo $! > "$CHECK/pid" )
    ok=0
    for _ in $(seq 60); do
        if curl -fsS -m 2 "http://127.0.0.1:$PORT/api/v1/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
        sleep 1
    done
    kill "$(cat "$CHECK/pid")" 2>/dev/null; wait "$(cat "$CHECK/pid")" 2>/dev/null
    [ "$ok" = 1 ] || { tail -10 "$CHECK/app.log" 2>/dev/null; echo "::error::the tarball's binary did not serve /api/v1/health" >&2; exit 1; }
    echo "  the unpacked tarball serves /api/v1/health"
fi
echo "built $OUT/$NAME"

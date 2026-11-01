#!/usr/bin/env bash
# Builds the ONE Linux .deb (#867: the desktop bundle is also the server) and puts it into a
# release directory under the package's own name and version, with its sha256 (#866).
#
#     tools/linux/build-deb.sh [out-dir]        # default artifacts/release
#
# Tauri bundles the .deb; this script supplies what a release needs around it:
#
#   - the app version is tauri.conf.json's version, the packaging revision is added by
#     tools/linux/package-version.sh, and the .deb's control Version is re-stamped to it (Tauri
#     takes its version from tauri.conf, whose semver cannot carry dpkg's "-<revision>");
#   - CASEMAKER_BUILD stamps the binary with the commit, because a container build has no git
#     (build.rs takes the explicit stamp first, #566);
#   - the artefact is named `casemaker_<version>_amd64.deb` whatever Tauri called the file, so the
#     APT pool, the release and the checks all agree on one name.
#
# Needs: node/npm, rust, dpkg-deb, and the WebKitGTK 4.1 build packages (deployment.md §3).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APP="$ROOT/casemaker-app"
OUT="${1:-$ROOT/artifacts/release}"
ARCH=amd64

for tool in node npm dpkg-deb; do
    command -v "$tool" >/dev/null || { echo "::error::$tool is not installed" >&2; exit 1; }
done
[ -f "$APP/src-tauri/tauri.conf.json" ] || { echo "::error::no app at $APP" >&2; exit 1; }

VERSION="$(node -p "require('$APP/src-tauri/tauri.conf.json').version")"
PKG_VERSION="$("$ROOT/tools/linux/package-version.sh" "$VERSION")"
CASEMAKER_BUILD="${CASEMAKER_BUILD:-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)}"

echo "building casemaker $PKG_VERSION (app $VERSION, build $CASEMAKER_BUILD)"
(cd "$APP" && CASEMAKER_BUILD="$CASEMAKER_BUILD" npx tauri build --bundles deb)

BUILT="$APP/src-tauri/target/release/bundle/deb/Case Maker_${VERSION}_${ARCH}.deb"
[ -s "$BUILT" ] || { echo "::error::Tauri produced no .deb at $BUILT" >&2; exit 1; }

mkdir -p "$OUT"
NAME="casemaker_${PKG_VERSION}_${ARCH}.deb"
if [ "$PKG_VERSION" = "$VERSION" ]; then
    cp "$BUILT" "$OUT/$NAME"
else
    # A packaging revision: dpkg's Version is the one apt orders, and Tauri cannot be given a
    # Debian revision, so it is written into the control file and the package is repacked.
    STAGE="$(mktemp -d)"
    trap 'rm -rf "$STAGE"' EXIT
    dpkg-deb -R "$BUILT" "$STAGE"
    sed -i "s/^Version: .*/Version: $PKG_VERSION/" "$STAGE/DEBIAN/control"
    dpkg-deb -b --root-owner-group "$STAGE" "$OUT/$NAME" >/dev/null
fi
(cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" && cat "$NAME.sha256")

# The package must say what it is, and the systemd unit must be inside it (#867/#866).
PKG="$(dpkg-deb -f "$OUT/$NAME" Package)"
VER="$(dpkg-deb -f "$OUT/$NAME" Version)"
[ "$PKG" = casemaker ] || { echo "::error::$NAME is package '$PKG', not casemaker" >&2; exit 1; }
[ "$VER" = "$PKG_VERSION" ] || { echo "::error::$NAME is version '$VER', not $PKG_VERSION" >&2; exit 1; }
dpkg-deb -c "$OUT/$NAME" | grep -q 'usr/lib/systemd/system/casemaker.service\|lib/systemd/system/casemaker.service' \
    || { echo "::error::$NAME does not carry the systemd unit" >&2; exit 1; }
echo "built $OUT/$NAME ($PKG $VER)"

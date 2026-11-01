#!/usr/bin/env bash
# Builds the Case Maker snap (#866) from a release tarball.
#
#     sudo tools/linux/build-snap.sh <tarball> [out-dir]
#
# Runs as root: `snapcraft pack --destructive-mode` installs the gnome extension's SDK through
# snapd, and the built .snap is then handed back to the caller (review-tools is itself a confined
# snap and cannot read a root-owned file).
#
# Ubuntu 24.04 only: core24 is built from that release. The tarball's binary is built on the same
# Ubuntu, which is what keeps the base and the binary's libraries compatible.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARBALL="${1:?usage: build-snap.sh <tarball> [out-dir]}"
OUT="${2:-$ROOT/artifacts/snap}"
[ -f "$TARBALL" ] || { echo "::error::no tarball at $TARBALL" >&2; exit 1; }
command -v snapcraft >/dev/null || { echo "::error::snapcraft is not installed" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/tree" "$OUT"
tar -C "$WORK/tree" --strip-components=1 -xzf "$TARBALL"
# The dump part reads tree/ as the tarball lays it out: bin/, flatpak/ … flattened for the snap.
mv "$WORK/tree/flatpak/casemaker.desktop" "$WORK/tree/casemaker.desktop"
mv "$WORK/tree/flatpak/ca.electricrv.CaseMaker.metainfo.xml" "$WORK/tree/ca.electricrv.CaseMaker.metainfo.xml"
cp "$WORK/tree/flatpak/casemaker.png" "$WORK/casemaker.png"
VERSION="$(tr -d '[:space:]' < "$WORK/tree/VERSION")"
python3 "$ROOT/tools/linux/snap/make-snapcraft-yaml.py" "$VERSION" "$WORK/snapcraft.yaml"

( cd "$WORK" && snapcraft pack --destructive-mode --output "$OUT/casemaker_${VERSION}_amd64.snap" )
[ -s "$OUT/casemaker_${VERSION}_amd64.snap" ] || { echo "::error::snapcraft produced no snap" >&2; exit 1; }
echo "built $OUT/casemaker_${VERSION}_amd64.snap"

#!/usr/bin/env bash
# Builds the Flatpak the way Flathub would: from the generated Flathub manifest and its release
# tarball, with no build context assembled around it (#866).
#
#     tools/linux/make-release-tarball.sh
#     tools/linux/make-flathub-manifest.sh artifacts/release/casemaker-linux-x64-1.0.0.tar.gz --local
#     tools/linux/build-flathub-flatpak.sh [manifest] [out-dir]
#
#   manifest  default artifacts/release/ca.electricrv.CaseMaker.yml
#   out-dir   default artifacts/flathub
#
# This is the check that matters for a submission: it builds the *manifest Flathub will run*
# from the artefact a tag build published, with the paths inside the tarball rather than the
# paths inside this repository — precisely the kind of difference nobody notices until a
# reviewer runs it.
#
# tools/linux/check-flatpak.sh then drives the bundle this makes, so the result is not
# just "it built".
#
# NOTHING HERE PUBLISHES. It exports to a local ostree repository and makes a bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="${1:-$ROOT/artifacts/release/ca.electricrv.CaseMaker.yml}"
OUT="${2:-$ROOT/artifacts/flathub}"

[ -f "$MANIFEST" ] || {
    echo "::error::no manifest at $MANIFEST — run tools/linux/make-flathub-manifest.sh" >&2
    exit 1; }
APP_ID="$(grep -oE '^app-id: *\S+' "$MANIFEST" | awk '{print $2}')"
[ -n "$APP_ID" ] || { echo "::error::$MANIFEST has no app-id" >&2; exit 1; }

# echo "building $APP_ID from $MANIFEST"
grep -A4 '^ *sources:' "$MANIFEST" | sed 's/^/  /'

rm -rf "$OUT/build" "$OUT/repo" "$OUT/.flatpak-builder"
mkdir -p "$OUT"
flatpak-builder --force-clean --disable-rofiles-fuse \
    --state-dir="$OUT/.flatpak-builder" \
    --repo="$OUT/repo" "$OUT/build" "$MANIFEST"

BUNDLE="$OUT/$APP_ID.flatpak"
rm -f "$BUNDLE"
flatpak build-bundle "$OUT/repo" "$BUNDLE" "$APP_ID"

echo
echo "built: $BUNDLE"
du -h "$BUNDLE" | cut -f1 | sed 's/^/  bundle  /'
du -sh "$OUT/build/files" | cut -f1 | sed 's/^/  files   /'

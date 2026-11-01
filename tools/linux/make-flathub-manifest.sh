#!/usr/bin/env bash
# Fills the Flathub manifest's @SOURCE@ from a release tarball (#866).
#
#     tools/linux/make-flathub-manifest.sh <tarball> [--local] [out-file]
#
# By default the source is the tarball's GitHub release URL, named from its own file name and the
# version it carries — the line a pull request against flathub/flathub would contain. With
# --local it is the file on disk instead, so the same manifest can be built before anything is
# published.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARBALL="${1:?usage: make-flathub-manifest.sh <tarball> [--local] [out-file]}"
LOCAL=0
OUT=""
shift
for arg in "$@"; do
    case "$arg" in
        --local) LOCAL=1 ;;
        *) OUT="$arg" ;;
    esac
done
[ -f "$TARBALL" ] || { echo "::error::no tarball at $TARBALL" >&2; exit 1; }
OUT="${OUT:-$ROOT/artifacts/release/ca.electricrv.CaseMaker.yml}"
NAME="$(basename "$TARBALL")"
SHA="$(sha256sum "$TARBALL" | cut -d' ' -f1)"
VERSION="$(tar -xzOf "$TARBALL" ./VERSION 2>/dev/null || true)"
[ -n "$VERSION" ] || { echo "::error::$TARBALL carries no VERSION file" >&2; exit 1; }

if [ "$LOCAL" = 1 ]; then
    SOURCE="      - type: archive
        path: $(cd "$(dirname "$TARBALL")" && pwd)/$NAME
        sha256: $SHA"
else
    URL="https://github.com/SlyWombat/CaseMaker/releases/download/linux-v${VERSION}/${NAME}"
    SOURCE="      - type: archive
        url: $URL
        sha256: $SHA"
fi

mkdir -p "$(dirname "$OUT")"
python3 - "$ROOT/tools/linux/flatpak/flathub/ca.electricrv.CaseMaker.yml.in" "$OUT" "$SOURCE" <<'PY'
import re
import sys
template, out, source = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(template).read()
# The placeholder is the WHOLE line — the template's comment mentions it too, and replacing
# every occurrence would edit the comment into a YAML block.
filled, n = re.subn(r'^@SOURCE@$', source.replace('\\', '\\\\'), text, flags=re.M)
assert n == 1, 'the template must carry exactly one @SOURCE@ line'
open(out, 'w').write(filled)
PY
echo "wrote $OUT"
grep -A3 '^ *sources:' "$OUT" | sed 's/^/  /'

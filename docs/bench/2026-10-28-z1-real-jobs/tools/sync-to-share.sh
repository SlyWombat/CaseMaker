#!/usr/bin/env bash
# Refresh the share's tool set FROM the repo — CODE ONLY (#1257).
#   sync-to-share.sh [<share tools dir>]      default /mnt/house/casemaker/z1-real-jobs/tools
# Copies exactly the files git tracks in this directory, one by one. It never deletes anything and never
# touches a file the repo does not track, so the vendor-derived data kept off the repo on the share
# (data/references.py, tools/references.py, mk-topclamp.json, set2/, jobs/ref-*.json — see
# DATA-PINS.sha256) is left exactly as it is. A file that would change is listed before it is copied.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
DEST=${1:-/mnt/house/casemaker/z1-real-jobs/tools}
[ -d "$DEST" ] || { echo "sync-to-share: no such folder $DEST" >&2; exit 2; }
cd "$HERE"
n=0
for f in $(git ls-files -- . | grep -v '/' ); do
  if [ ! -f "$DEST/$f" ] || ! cmp -s "$f" "$DEST/$f"; then
    echo "copy $f"
    cp -p "$f" "$DEST/$f"
    n=$((n + 1))
  fi
done
echo "sync-to-share: $n file(s) copied to $DEST; nothing deleted, untracked files untouched"

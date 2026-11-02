#!/usr/bin/env bash
# The gate's one command: rebuild the Z1 Demo Jobs page on a sha.  tools/build.sh <sha> [build.py args]
# The worktree must be checked out at that sha (its HEAD is what the page states).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${CM_REPO:-$HOME/projects/cm-wt/944-demo-page}
PY=${CM_PY:-$HOME/casemaker-manager/venv/bin/python}
SHA=${1:?usage: build.sh <sha> [--only id,id] [--timeout s]}
shift
source "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
nvm use 24 >/dev/null 2>&1 || true
exec "$PY" "$HERE/build.py" --repo "$REPO" --sha "$SHA" "$@"

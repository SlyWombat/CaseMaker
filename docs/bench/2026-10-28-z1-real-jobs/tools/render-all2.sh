#!/usr/bin/env bash
# r <entry-id> <job> [run ...]: renders before/after/after-top into assets/<entry-id>, sweeping each run's main .nc in order.
cd "$(dirname "$0")" || exit 1
V=./venv/bin/python
r() { id=$1; job=$2; shift 2; ncs=(); for n in "$@"; do ncs+=("runs/$n/$n.nc"); done; echo "== $id $($V render.py "jobs/$job.json" "assets/$id" "${ncs[@]}" 2>&1 | tail -1)"; }
"$@"

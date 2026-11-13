#!/usr/bin/env python3
"""Write the per-card reference table from a NAMED baseline folder — the deliberate act (#1257).

    python3 derive_limits.py <baseline-dir> --name <baseline name, e.g. v0.3-B> --out <limits.json>

Each card's reference is its computeSeconds in that folder's saved card.json (demo/runs/**, and the j28/j29 command's
runs). A card with no computeSeconds (an error, or a run that went over) has none and gets the default limit, listed.
build.py reads the file with --limits; a normal run never writes it, so a real slowdown shows as a card climbing toward
its limit instead of the limit following it. Re-deriving is a decision someone makes, and the file says which baseline.
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import limits  # noqa: E402

p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
p.add_argument('baseline_dir')
p.add_argument('--name', required=True, help='the baseline\'s name, stated in the table and on every card')
p.add_argument('--out', required=True)
p.add_argument('--margin', type=float, default=limits.LIMIT_MARGIN)
p.add_argument('--floor', type=float, default=limits.LIMIT_FLOOR_S)
a = p.parse_args()
cards = limits.derive_reference_seconds(a.baseline_dir)
if not cards:
    sys.exit(f'derive_limits: no card with a computeSeconds under {a.baseline_dir}')
doc = limits.write_table(a.out, a.name, a.baseline_dir, cards, a.margin, a.floor)
print(f"derive_limits: {len(cards)} reference times from {a.name} -> {a.out} (margin {a.margin}, floor {a.floor} s)")
for cid, secs in sorted(cards.items(), key=lambda kv: -kv[1])[:5]:
    print(f"  {cid}: {secs} s -> limit {limits.card_limit(secs, a.margin, a.floor)['limitSeconds']} s")

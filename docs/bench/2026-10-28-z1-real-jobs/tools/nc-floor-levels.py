#!/usr/bin/env python3
"""#958 acceptance data: planar floors, the contour, islands and the curved remainder of a part,
read from MAKERA'S OWN NC Z levels plus the goal heightfield — never from our engine's output.

usage: nc-floor-levels.py <goal-prefix> <model-top-offset dz> <makera.nc> [--min-run 20] [--min-area 5]

Method (stated on the issue):
- floor candidates: per tool, the Z of every constant-Z feed move in the vendor's NC, summed by XY
  length; a candidate is a Z carrying >= --min-run mm of it;
- each candidate is measured on the goal heightfield (the app's 0.1 mm sampler over the maker's STEP
  at the vendor's placement; `dz` is how far the model's top sits below the stock top): cells within
  +-0.01 mm of the level, 4-connected; a component must have median local slope <= 5 deg (a slope
  crossing a level gives cells, not a floor); levels within 0.05 mm are merged;
- islands: enclosed components of the same heightfield standing above the level;
- remainder: cells not within 0.05 mm of any floor level and not a wall (slope <= 80 deg).
"""
import json, math, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import goal_check as G          # mkr_moves: the vendor NC's own moves


def runs_label(mask):
    """4-connected components of a boolean mask, with centroid/bbox/mask per component."""
    ny, nx = mask.shape
    parent = []
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[rj] = ri
    prev, rows = [], []
    for j in range(ny):
        row = mask[j]
        if not row.any():
            prev = []
            continue
        idx = np.flatnonzero(np.diff(np.concatenate(([0], row.view(np.int8), [0]))))
        cur = []
        for k in range(0, len(idx), 2):
            s, e = int(idx[k]), int(idx[k + 1])
            rid = len(rows); rows.append((j, s, e)); parent.append(rid)
            for ps, pe, pr in prev:
                if ps < e and s < pe:
                    union(rid, pr)
            cur.append((s, e, rid))
        prev = cur
    groups = {}
    for rid, (j, s, e) in enumerate(rows):
        groups.setdefault(find(rid), []).append((j, s, e))
    out = []
    for g in groups.values():
        cells = sum(e - s for _j, s, e in g)
        mx = sum((s + e - 1) * 0.5 * (e - s) for _j, s, e in g) / cells
        my = sum(j * (e - s) for j, s, e in g) / cells
        xs = [s for _j, s, e in g] + [e - 1 for _j, s, e in g]
        ys = [j for j, _s, _e in g]
        cm = np.zeros((ny, nx), bool)
        for j, s, e in g:
            cm[j, s:e] = True
        out.append({'cells': cells, 'cx': mx, 'cy': my, 'bbox': (min(xs), max(xs), min(ys), max(ys)), 'mask': cm})
    out.sort(key=lambda r: -r['cells'])
    return out


def main():
    args = sys.argv[1:]
    min_run = 20.0
    if '--min-run' in args:
        i = args.index('--min-run'); min_run = float(args[i + 1]); del args[i:i + 2]
    pre, dz, nc = args[0], float(args[1]), args[2]
    gh = json.load(open(pre + '.json'))
    nx, ny, p, x0, y0 = gh['nx'], gh['ny'], gh['pitch'], gh['x0'], gh['y0']
    Gz = np.fromfile(pre + '.bin', np.float32).reshape(ny, nx).astype(float) - dz
    C = np.fromfile(pre + '.cov', np.uint8).reshape(ny, nx) > 0
    a = p * p
    def xy(cx, cy): return (round(x0 + cx * p, 1), round(y0 + cy * p, 1))
    gx = np.zeros_like(Gz); gy = np.zeros_like(Gz)
    gx[:, :-1] = np.abs(np.diff(Gz, axis=1)) / p; gy[:-1, :] = np.abs(np.diff(Gz, axis=0)) / p
    slope = np.degrees(np.arctan(np.maximum(gx, gy))); wall = slope > 80
    print(f'{int(C.sum())} goal cells at {p} mm; model top at {-dz:+.2f} mm')
    for c in [c for c in runs_label(C) if c['cells'] * a >= 5]:
        b = c['bbox']
        print(f'outer contour: {c["cells"] * a:.1f} mm2 centroid {xy(c["cx"], c["cy"])} '
              f'bbox {xy(b[0], b[2])}..{xy(b[1], b[3])} part depth {Gz[C].min():.2f}')
    per = {}
    for tn, aa, bb, rapid in G.mkr_moves(nc):
        if tn is None or rapid or abs(aa[2] - bb[2]) > 1e-6:
            continue
        z = round(aa[2], 2); L = math.hypot(bb[0] - aa[0], bb[1] - aa[1])
        d = per.setdefault(tn, {}); d[z] = d.get(z, 0.0) + L
    floors = []
    for z in sorted({z for d in per.values() for z, L in d.items() if L >= min_run}, reverse=True):
        m = C & (np.abs(Gz - z) <= 0.01)
        if not m.any():
            continue
        comps = [c for c in runs_label(m) if c['cells'] * a >= 5 and np.median(slope[c['mask']]) <= 5]
        if not comps or any(abs(z - f) <= 0.05 for f in floors):
            continue
        floors.append(z)
        tools = [tn for tn, d in per.items() if z in d and d[z] >= min_run]
        print(f'FLOOR Z {z:+.2f} (depth {abs(z + dz):.2f} from the model top; NC tools {tools}): '
              f'{sum(c["cells"] for c in comps) * a:.1f} mm2, {len(comps)} flat component(s)')
        for c in comps:
            b = c['bbox']
            print(f'   {c["cells"] * a:8.1f} mm2 centroid {xy(c["cx"], c["cy"])} bbox {xy(b[0], b[2])}..{xy(b[1], b[3])}')
            for h in runs_label(C & ~c['mask'] & ~m):
                if h['cells'] * a < 1.0:
                    continue
                ys2, xs2 = np.nonzero(h['mask'])
                if ys2.min() <= b[2] or ys2.max() >= b[3] or xs2.min() <= b[0] or xs2.max() >= b[1]:
                    continue
                mh = Gz[h['mask']].mean()
                if mh > z + 0.05:
                    print(f'      island {h["cells"] * a:7.1f} mm2 at {xy(h["cx"], h["cy"])} top {mh:+.2f}')
    near = np.zeros_like(C)
    for z in floors:
        near |= np.abs(Gz - z) <= 0.05
    rem = C & ~near & ~wall
    comps = [c for c in runs_label(rem) if c['cells'] * a >= 20]
    print(f'CURVED REMAINDER: {sum(c["cells"] for c in comps) * a:.1f} mm2 in {len(comps)} component(s) >= 20 mm2')
    for c in comps[:20]:
        print(f'   {c["cells"] * a:8.1f} mm2 at {xy(c["cx"], c["cy"])} z {Gz[c["mask"]].min():.2f}..{Gz[c["mask"]].max():.2f} '
              f'slope median {np.median(slope[c["mask"]]):.0f} deg')


if __name__ == '__main__':
    main()

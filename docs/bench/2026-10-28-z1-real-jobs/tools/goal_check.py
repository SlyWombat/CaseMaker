#!/usr/bin/env python3
"""Goal checker for 3D goal jobs (scratch tooling, not product code).

Stamps every feed move of every program with that program's own cutter (exact cutter shape,
evaluated at each goal cell's own sample point, no rounding of the cutter position to the grid),
over the app's goal heightfield (tools/goal-hf.mts, 0.1 mm pitch, sample point x0 + i*pitch), and
compares the swept stock with the goal at every covered goal cell:

  cut-into  = the cutter reached below the goal by more than 0.01 mm
  leftover  = material left above the goal (reported at 0.1 / 0.3 / 1 mm)

usage: goal_check.py <goal-prefix> <stock-thickness> <out-dir> <a.nc> [b.nc ...]
Writes <out-dir>/goalcheck.json, goalcheck.npy (swept heights on the goal grid), goalcheck.png.
Single setup only (side-1 programs, work Z 0 = stock top).
"""
import json, math, os, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R

CUT_INTO = 0.01


def cutter(tool):
    """(radius, z-offset function of r) for the program's cutter, cutting size as render.tool_kernel."""
    shape = tool.get('shape')
    if shape in ('engraving', 'chamfer', 'v'):
        D = tool.get('diameter') or 3.175
        ang = tool.get('angle') or (2 * tool['halfAngle'] if tool.get('halfAngle') else 30)
        t = math.tan(math.radians(ang / 2))
        tipR = 0.0 if shape == 'chamfer' else (tool.get('tipDiameter') or 0) / 2
        return D / 2, lambda r: np.where(r <= tipR, 0.0, (r - tipR) / t), shape
    D = tool.get('tipDiameter') or tool.get('diameter') or 1.0
    Rr = D / 2
    if shape == 'ball':
        return Rr, lambda r: Rr - np.sqrt(np.maximum(Rr * Rr - r * r, 0)), shape
    if shape == 'drill':
        return Rr, lambda r: r / math.tan(math.radians(59)), shape
    return Rr, lambda r: np.zeros_like(r), shape


def stamp(H, x0, y0, p, nc):
    tool = R.nc_tool(nc)
    Rr, prof, shape = cutter(tool)
    ny, nx = H.shape
    n = int(math.ceil(Rr / p)) + 1
    oi, oj = np.meshgrid(np.arange(-n, n + 1), np.arange(-n, n + 1), indexing='xy')
    oi = oi.ravel(); oj = oj.ravel()
    step = p * 0.5
    pts = []
    def flush():
        if not pts: return
        Q = np.array(pts); pts.clear()
        B = max(1, 2_000_000 // oi.size)
        Hf = H.ravel()
        for b in range(0, len(Q), B):
            q = Q[b:b + B]
            ci = np.rint((q[:, 0] - x0) / p).astype(np.int64)[:, None] + oi[None, :]
            cj = np.rint((q[:, 1] - y0) / p).astype(np.int64)[:, None] + oj[None, :]
            ok = (ci >= 0) & (ci < nx) & (cj >= 0) & (cj < ny)
            r = np.hypot(x0 + ci * p - q[:, 0:1], y0 + cj * p - q[:, 1:2])
            ok &= r <= Rr
            z = q[:, 2:3] + prof(r)
            np.minimum.at(Hf, (cj * nx + ci)[ok], z[ok])
    for start, seg in R.parse_nc(nc):
        a = np.array(start[:3])
        for (px, py, pz, pa, rapid) in seg:
            b = np.array([px, py, pz])
            if min(a[2], b[2]) < 0.05:
                L = math.hypot(b[0] - a[0], b[1] - a[1]) + abs(b[2] - a[2])
                k = max(1, int(math.ceil(L / step)))
                t = np.arange(0, k + 1)[:, None] / k
                q = a + (b - a) * t
                q = q[q[:, 2] < 0.05]
                pts.extend(q.tolist())
                if len(pts) > 400_000: flush()
            a = b
    flush()
    return {'program': os.path.basename(nc), 'cutter': tool.get('name') or tool.get('label') or '', 'shape': shape, 'cuttingDiameter': round(2 * Rr, 3)}


def main():
    gp, T, out = sys.argv[1], float(sys.argv[2]), sys.argv[3]
    ncs = sys.argv[4:]
    os.makedirs(out, exist_ok=True)
    gh = json.load(open(gp + '.json'))
    nx, ny, p, x0, y0 = gh['nx'], gh['ny'], gh['pitch'], gh['x0'], gh['y0']
    G = np.fromfile(gp + '.bin', np.float32).reshape(ny, nx).astype(np.float64)
    C = np.fromfile(gp + '.cov', np.uint8).reshape(ny, nx) > 0
    H = np.zeros((ny, nx))
    progs = [stamp(H, x0, y0, p, nc) for nc in ncs]
    np.save(os.path.join(out, 'goalcheck.npy'), H)
    # The best ANY program's cutter could do: the goal opened by the smallest cutter used (its tip
    # placed as high as the goal allows at every cell, then swept). Leftover beyond that is the
    # plan's; leftover within it is the cutter's size.
    small = min(progs, key=lambda q: q['cuttingDiameter'])
    Rs = small['cuttingDiameter'] / 2
    Gf = np.where(C, np.maximum(G, -T), -T)
    m = int(math.ceil(Rs / p))
    offs = [(di, dj) for dj in range(-m, m + 1) for di in range(-m, m + 1) if math.hypot(di * p, dj * p) <= Rs]
    def kof(di, dj):
        r = math.hypot(di * p, dj * p)
        return Rs - math.sqrt(max(Rs * Rs - r * r, 0)) if small['shape'] == 'ball' else 0.0
    def shifted(A, di, dj, fill):
        Bp = np.full((ny + 2 * m, nx + 2 * m), fill); Bp[m:m + ny, m:m + nx] = A
        return Bp[m + dj:m + dj + ny, m + di:m + di + nx]
    tip = np.full((ny, nx), -np.inf)
    for di, dj in offs: np.maximum(tip, shifted(Gf, di, dj, -T) - kof(di, dj), out=tip)
    ideal = np.full((ny, nx), np.inf)
    for di, dj in offs: np.minimum(ideal, shifted(tip, -di, -dj, np.inf) + kof(di, dj), out=ideal)
    ideal = np.maximum(np.minimum(ideal, 0.0), -T)
    Hc = np.maximum(H, -T); Gc = np.maximum(G, -T)
    d = (Hc - Gc)[C]  # + material left above the goal, - cut below it
    n = max(int(C.sum()), 1); a = p * p
    def pct(m): return round(float(np.sum(m)) / n * 100, 2)
    s = {
        'goalCells': int(C.sum()), 'pitchMm': p, 'goalMinZ': round(float(G[C].min()), 3), 'stockThickness': T,
        'programs': progs,
        'cutIntoPct': pct(d < -CUT_INTO), 'cutIntoAreaMm2': round(float(np.sum(d < -CUT_INTO)) * a, 1),
        'cutInto0p1Pct': pct(d < -0.1), 'cutInto0p5AreaMm2': round(float(np.sum(d < -0.5)) * a, 1),
        'maxCutIntoMm': round(float(max(0.0, -d.min())), 3),
        'cutIntoVolumeMm3': round(float(np.sum(np.clip(-d, 0, None))) * a, 1),
        'leftover0p1Pct': pct(d > 0.1), 'leftover0p3Pct': pct(d > 0.3), 'leftover1Pct': pct(d > 1),
        'maxLeftoverMm': round(float(max(0.0, d.max())), 3),
        'leftoverVolumeMm3': round(float(np.sum(np.clip(d, 0, None))) * a, 1),
        'idealCutter': small['cuttingDiameter'],
        'idealLeftover0p3Pct': pct((np.maximum(ideal, -T) - Gc)[C] > 0.3),
        'beyondReach0p1Pct': pct((Hc - np.maximum(ideal, -T))[C] > 0.1), 'beyondReach0p3Pct': pct((Hc - np.maximum(ideal, -T))[C] > 0.3),
        'beyondReachVolumeMm3': round(float(np.sum(np.clip((Hc - np.maximum(ideal, -T))[C], 0, None))) * a, 1),
        'untouchedPct': pct(H[C] >= 0),
        'medianMm': round(float(np.median(d)), 3),
    }
    json.dump(s, open(os.path.join(out, 'goalcheck.json'), 'w'), indent=1)
    # map, top view, +Y up: green within 0.1, blue leftover (darker = more), red cut-into
    D = np.where(C, Hc - Gc, np.nan)
    rgb = np.full((ny, nx, 3), 240, np.uint8)
    dd = np.nan_to_num(D)
    rgb[C & (np.abs(dd) <= 0.1)] = (120, 190, 120)
    m = C & (dd > 0.1); t = np.clip((dd - 0.1) / 3, 0, 1)
    rgb[m] = np.stack([150 * (1 - t[m]), 170 * (1 - t[m]) + 30, 230 - 60 * t[m]], -1).astype(np.uint8)
    rgb[C & (dd < -CUT_INTO)] = (235, 150, 150)
    rgb[C & (dd < -0.1)] = (215, 30, 30)
    w = min(1000, nx * 2)
    Image.fromarray(np.flipud(rgb)).resize((w, max(1, int(w * ny / nx)))).save(os.path.join(out, 'goalcheck.png'))
    # #945 — the GEOMETRIC floor as a second map, so "what the smallest chosen ball could leave"
    # (idealLeftover) can be read beside "what the posted plan left" (the map above). Same palette:
    # green within 0.1 mm of the goal, blue leftover (darker = more).
    np.save(os.path.join(out, 'ideal.npy'), ideal)
    Di = np.where(C, np.maximum(ideal, -T) - Gc, np.nan)
    rgb2 = np.full((ny, nx, 3), 240, np.uint8)
    di2 = np.nan_to_num(Di)
    rgb2[C & (di2 <= 0.1)] = (120, 190, 120)
    mi = C & (di2 > 0.1); ti = np.clip((di2 - 0.1) / 3, 0, 1)
    rgb2[mi] = np.stack([150 * (1 - ti[mi]), 170 * (1 - ti[mi]) + 30, 230 - 60 * ti[mi]], -1).astype(np.uint8)
    Image.fromarray(np.flipud(rgb2)).resize((w, max(1, int(w * ny / nx)))).save(os.path.join(out, 'ideal.png'))
    print(json.dumps(s))


if __name__ == '__main__':
    main()

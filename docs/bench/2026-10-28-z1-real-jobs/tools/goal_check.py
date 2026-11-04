#!/usr/bin/env python3
"""Goal checker for 3D goal jobs (scratch tooling, not product code).

Stamps every feed move of every program with that program's own cutter (exact cutter shape,
evaluated at each goal cell's own sample point, no rounding of the cutter position to the grid),
over the app's goal heightfield (tools/goal-hf.mts, 0.1 mm pitch, sample point x0 + i*pitch), and
compares the swept stock with the goal at every covered goal cell:

  cut-into  = the cutter reached below the goal by more than 0.01 mm
  leftover  = material left above the goal (reported at 0.1 / 0.3 / 1 mm)

usage: goal_check.py <goal-prefix> <stock-thickness> <out-dir> [--mkr] [--dz <mm>] [--only-tools n,..] <a.nc> [b.nc ...]

--mkr scores a MAKERA STUDIO program: a `;@MKR|TOOL|number=N|…` header gives each tool's geometry and
every `T<N> M6` switches the stamp to that tool (flat / ball / V-cone with tip / drill). Studio's own
cycle estimate is read from `;@MKR|TIME|seconds=` and reported as `vendorSeconds`.
The card rule's EDGE-BREAK ALLOWANCE (#955): a cell cut into by a V-shaped tool (V-bit, engraving,
chamfer), within that bit's reach of a design edge, and no deeper below the goal than the bit's leg — the
cone's own depth at its cutting radius — is reported as `edgeBreak*` and does not count as cut-into.
Every other cell below the goal stays cut-into. A tool number in the NC with no `;@MKR|TOOL` header is
reported (`unmappedToolNumbers`), never silently swept as nothing.
Writes <out-dir>/goalcheck.json, goalcheck.npy (swept heights on the goal grid), goalcheck.png.
Single setup only (side-1 programs, work Z 0 = stock top).
"""
import json, math, os, re, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R

CUT_INTO = 0.01

# #948 — THE PASS LINE comes from the shop's own defaults (`goal.passCoverage`, seeded 0.95), the
# same key the app's goal check reads, so the page's verdict and the app's cannot name different
# rules. A location exported before the seed carries no key: read the seed value as the fallback.
PASS_COVERAGE = float((getattr(R, 'LOC', {}).get('defaults') or {}).get('goal.passCoverage', {}).get('value', 0.95))


def cutter(tool):
    """(radius, z-offset function of r) for the program's cutter, cutting size as render.tool_kernel."""
    shape = tool.get('shape')
    if shape in ('engraving', 'chamfer', 'v'):
        D = tool.get('diameter') or 3.175
        ang = tool.get('angle') or (2 * tool['halfAngle'] if tool.get('halfAngle') else 30)
        t = math.tan(math.radians(ang / 2))
        tipR = 0.0 if shape == 'chamfer' else (tool.get('tipDiameter') or 0) / 2
        # The cone's leg: the deepest the V reaches at its cutting radius (#955's edge break).
        return D / 2, lambda r: np.where(r <= tipR, 0.0, (r - tipR) / t), shape, (D / 2 - tipR) / t
    D = tool.get('tipDiameter') or tool.get('diameter') or 1.0
    Rr = D / 2
    if shape == 'ball':
        return Rr, lambda r: Rr - np.sqrt(np.maximum(Rr * Rr - r * r, 0)), shape, 0.0
    if shape == 'drill':
        return Rr, lambda r: r / math.tan(math.radians(59)), shape, 0.0
    return Rr, lambda r: np.zeros_like(r), shape, 0.0


def put(Hf, Wf, idx, z, tn):
    """The deepest sample wins. `minimum.at`, not fancy assignment: one block can hit a cell several
    times and the last write is not the deepest (#955 — the port's 6 % leftover was exactly this)."""
    np.minimum.at(Hf, idx, z)
    Wf[idx[z <= Hf[idx]]] = tn


def stamp(H, x0, y0, p, nc, who=None):
    tool = R.nc_tool(nc)
    Rr, prof, shape, leg = cutter(tool)
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
            idx = (cj * nx + ci)[ok]; zz = z[ok]
            if who is None:
                np.minimum.at(Hf, idx, zz)
            else:
                put(Hf, who.ravel(), idx, zz, 1)
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
    return {'program': os.path.basename(nc), 'cutter': tool.get('name') or tool.get('label') or '', 'shape': shape, 'cuttingDiameter': round(2 * Rr, 3), 'leg': round(leg, 3)}


def mkr_tools(path):
    """Every `;@MKR|TOOL|number=N` header: the cutting geometry per tool number (#955)."""
    tools = {}
    for line in open(path, errors='replace'):
        if not line.startswith(';@MKR|TOOL|'):
            if line.startswith(('G', 'M', 'T')):
                break
            continue
        f = dict(kv.split('=', 1) for kv in line.strip().split('|')[2:] if '=' in kv)
        n = int(f['number']); typ = f.get('type', '').lower()
        d = float(f.get('diameter') or 0); tip = float(f.get('tipdiameter') or 0)
        ang = float(f.get('angle') or 0) or (float(f.get('halfangle') or 0) * 2)
        dc = tip if (tip > 0 and 'ball' in typ) else d
        if 'ball' in typ:
            shape, Rr, leg = 'ball', dc / 2, 0.0
            prof = lambda r, R=Rr: R - np.sqrt(np.maximum(R * R - r * r, 0))
        elif 'v-bit' in typ or 'engrav' in typ or 'chamfer' in typ or ang > 0:
            shape, Rr = 'v', d / 2
            half = math.radians((ang or 30) / 2); tipR = tip / 2
            leg = (Rr - tipR) / math.tan(half)
            prof = lambda r, t=math.tan(half), t0=tipR: np.where(r <= t0, 0.0, (r - t0) / t)
        elif 'drill' in typ:
            shape, Rr, leg = 'drill', d / 2, 0.0
            prof = lambda r: r / math.tan(math.radians(59))
        else:
            shape, Rr, leg = 'flat', dc / 2, 0.0
            prof = lambda r: np.zeros_like(r)
        tools[n] = {'number': n, 'name': f.get('name', ''), 'shape': shape, 'R': Rr, 'prof': prof,
                    'cuttingDiameter': 2 * Rr, 'leg': leg}
    return tools


def mkr_moves(path):
    """(tool number, start, end) per motion line, absolute mm; `T<n> M6` switches the tool."""
    x = y = 0.0; z = 50.0; absm = True; mode = 0; tool = None
    for raw in open(path, errors='replace'):
        line = raw.split(';')[0].split('(')[0].strip().upper()
        if not line or line.startswith('%'):
            continue
        m = re.search(r'\bT(\d+)\b', line)
        if m and re.search(r'\bM6\b', line):
            # The change happens at a safe height the post does not state, and Studio emits the next
            # XY move before its `G0 Z..`: carrying the old tool's cutting Z would stamp a gouge-line
            # across the part (#955 — the 3 % "sampling artefact" in the first calibration).
            tool = int(m.group(1)); z = 50.0; continue
        if 'G53' in line:
            z = 50.0
            continue
        words = {}
        for k, v in re.findall(r'([A-Z])([-+]?\d*\.?\d+)', line):
            if k == 'G':
                g = int(float(v))
                if g in (0, 1, 2, 3): mode = g
                elif g == 90: absm = True
                elif g == 91: absm = False
            else:
                words[k] = float(v)
        if not any(k in words for k in 'XYZIJ'):
            continue
        nx = words.get('X', x if absm else 0); ny = words.get('Y', y if absm else 0)
        nz = words.get('Z', z if absm else 0)
        if not absm:
            nx += x; ny += y; nz += z
        if mode in (2, 3) and ('I' in words or 'J' in words):
            cx = x + words.get('I', 0); cy = y + words.get('J', 0); r0 = math.hypot(x - cx, y - cy)
            t0 = math.atan2(y - cy, x - cx); t1 = math.atan2(ny - cy, nx - cx)
            if mode == 2:
                while t1 >= t0: t1 -= 2 * math.pi
            else:
                while t1 <= t0: t1 += 2 * math.pi
            steps = max(2, int(abs(t1 - t0) * r0 / 0.05)); px, py, pz = x, y, z
            for s in range(1, steps + 1):
                t = t0 + (t1 - t0) * s / steps
                qx, qy, qz = cx + r0 * math.cos(t), cy + r0 * math.sin(t), z + (nz - z) * s / steps
                yield tool, (px, py, pz), (qx, qy, qz), mode == 0; px, py, pz = qx, qy, qz
        else:
            yield tool, (x, y, z), (nx, ny, nz), mode == 0
        x, y, z = nx, ny, nz


def mkr_time(path):
    """Studio's own estimate, from the NC header (`;@MKR|TIME|seconds=`), else None."""
    for line in open(path, errors='replace'):
        if line.startswith(';@MKR|TIME|'):
            m = re.search(r'seconds=([-+]?\d*\.?\d+)', line)
            return float(m.group(1)) if m else None
    return None


def stamp_mkr(H, who, x0, y0, p, nc, tools, dz, known=None):
    """Stamp a Makera Studio program tool by tool; `who` records the tool that cut each cell deepest."""
    ny, nx = H.shape; Hf = H.ravel(); Wf = who.ravel()
    cache = {}
    def kernel(t):
        if t['number'] not in cache:
            n = int(math.ceil(t['R'] / p)) + 1
            oi, oj = np.meshgrid(np.arange(-n, n + 1), np.arange(-n, n + 1), indexing='xy')
            cache[t['number']] = (oi.ravel(), oj.ravel())
        return cache[t['number']]
    pts = {}; used = {}; step = p * 0.5
    def flush(tn):
        q = pts.get(tn)
        if not q: return
        t = tools[tn]; oi, oj = kernel(t); Q = np.array(q); pts[tn] = []
        B = max(1, 2_000_000 // oi.size)
        for b in range(0, len(Q), B):
            s = Q[b:b + B]
            ci = np.rint((s[:, 0] - x0) / p).astype(np.int64)[:, None] + oi[None, :]
            cj = np.rint((s[:, 1] - y0) / p).astype(np.int64)[:, None] + oj[None, :]
            ok = (ci >= 0) & (ci < nx) & (cj >= 0) & (cj < ny)
            r = np.hypot(x0 + ci * p - s[:, 0:1], y0 + cj * p - s[:, 1:2]); ok &= r <= t['R']
            zz = s[:, 2:3] + t['prof'](r)
            idx = (cj * nx + ci)[ok]; z = zz[ok]
            put(Hf, Wf, idx, z, tn)
    missing = set()
    for tn, a, b, rapid in mkr_moves(nc):
        if tn is None:
            missing.add(None)
            continue
        if tn not in tools:
            if known is None or tn in known:   # a header-less tool number, not a --only-tools exclusion
                missing.add(tn)
            continue
        a = np.array(a); b = np.array(b)
        if min(a[2], b[2]) < 0.05 + dz:
            L = math.hypot(b[0] - a[0], b[1] - a[1]) + abs(b[2] - a[2])
            k = max(1, int(math.ceil(L / step)))
            q = a + (b - a) * (np.arange(0, k + 1)[:, None] / k)
            q = q[q[:, 2] < 0.05 + dz]
            if len(q):
                pts.setdefault(tn, []).extend(q.tolist())
                used[tn] = used.get(tn, 0) + len(q)
                if len(pts[tn]) > 400_000:
                    flush(tn)
    for tn in list(pts):
        flush(tn)
    return {'program': os.path.basename(nc),
            'tools': [{'number': n, 'name': tools[n]['name'], 'shape': tools[n]['shape'],
                       'cuttingDiameter': round(tools[n]['cuttingDiameter'], 3), 'leg': round(tools[n]['leg'], 3),
                       'samples': used.get(n, 0)}
                      for n in sorted(tools) if used.get(n, 0) > 0],
            # A tool number in the NC with no header would be silently swept as nothing: say so.
            'unmappedToolNumbers': sorted(x for x in missing if x is not None),
            'movesBeforeAnyToolChange': None in missing,
            'vendorSeconds': mkr_time(nc)}


def main():
    args = sys.argv[1:]
    mkr = '--mkr' in args
    if mkr: args.remove('--mkr')
    dz = 0.0
    if '--dz' in args:
        i = args.index('--dz'); dz = float(args[i + 1]); del args[i:i + 2]
    only = None
    if '--only-tools' in args:
        i = args.index('--only-tools'); only = {int(t) for t in args[i + 1].split(',')}; del args[i:i + 2]
    gp, T, out = args[0], float(args[1]), args[2]
    ncs = args[3:]
    os.makedirs(out, exist_ok=True)
    gh = json.load(open(gp + '.json'))
    nx, ny, p, x0, y0 = gh['nx'], gh['ny'], gh['pitch'], gh['x0'], gh['y0']
    G = np.fromfile(gp + '.bin', np.float32).reshape(ny, nx).astype(np.float64)
    if mkr:
        G = G - dz  # the goal sits `dz` deeper below the stock top (the header's placement, tested)
    C = np.fromfile(gp + '.cov', np.uint8).reshape(ny, nx) > 0
    H = np.zeros((ny, nx))
    who = np.zeros((ny, nx), np.int16)
    if mkr:
        progs = []
        for nc in ncs:
            allt = mkr_tools(nc)
            tools = allt if only is None else {k: v for k, v in allt.items() if k in only}
            progs.append(stamp_mkr(H, who, x0, y0, p, nc, tools, dz, set(allt)))
    else:
        progs = [stamp(H, x0, y0, p, nc, who) for nc in ncs]
    np.save(os.path.join(out, 'goalcheck.npy'), H)
    # The best ANY program's cutter could do: the goal opened by the smallest cutter used (its tip
    # placed as high as the goal allows at every cell, then swept). Leftover beyond that is the
    # plan's; leftover within it is the cutter's size.
    if mkr:
        small = min((t for q in progs for t in q['tools']), key=lambda t: t['cuttingDiameter'])
    else:
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
    # #955 — THE EDGE-BREAK ALLOWANCE. A V-shaped tool (V-bit, engraving, chamfer) breaking a rim the
    # goal model does not carry is reported as "edge break", not cut-into, when all three hold:
    #   (a) the cell's deepest cutter was a V tool (the `who` map names it; 1 for a one-cutter job);
    #   (b) the cell is within that kind of bit's reach of a DESIGN EDGE — a step > 0.2 mm between
    #       neighbouring goal cells (a wall) or the model's silhouette (covered cell beside an
    #       uncovered one). A V tool gouging a floor away from any edge stays cut-into;
    #   (c) the cell is no deeper below the goal than that bit's LEG — the cone's own depth at its
    #       cutting radius, (R - tip)/tan(half-angle). For the 90 deg chamfer here that is 1.54 mm.
    # The reach is taken as the widest V bit in the program (one band, conservative for smaller bits).
    legs = np.zeros(int(who.max()) + 1)
    reaches = np.zeros(int(who.max()) + 1)
    if mkr:
        for q in progs:
            for t in q['tools']:
                if t['shape'] == 'v':
                    legs[t['number']] = t['leg']
                    reaches[t['number']] = t['cuttingDiameter'] / 2
    elif who.max() >= 1:
        shp = progs[0]['shape']
        legs[1] = progs[0].get('leg', 0.0) if shp == 'v' else 0.0
        reaches[1] = progs[0]['cuttingDiameter'] / 2 if shp == 'v' else 0.0
    raw_cut = C & (Hc - Gc < -CUT_INTO)
    # DESIGN EDGES: a step > 0.2 mm between neighbouring goal cells (a wall), or the model's
    # silhouette (a covered cell beside an uncovered one).
    Gs = np.where(C, Gc, -T)                     # outside the goal coverage: the stock, i.e. a rim
    dy = np.zeros_like(Gs); dx = np.zeros_like(Gs)
    dy[:-1] = np.abs(Gs[1:] - Gs[:-1]); dx[:, :-1] = np.abs(Gs[:, 1:] - Gs[:, :-1])
    wall = (dy > 0.2) | (dx > 0.2)
    wall[1:] |= dy[:-1] > 0.2; wall[:, 1:] |= dx[:, :-1] > 0.2

    def dilate(mask, radius_mm):
        r = int(math.ceil(radius_mm / p)); out = np.zeros_like(mask)
        for dj in range(-r, r + 1):
            for di in range(-r, r + 1):
                if math.hypot(di * p, dj * p) > radius_mm: continue
                out[max(0, dj):ny + min(0, dj), max(0, di):nx + min(0, di)] |= \
                    mask[max(0, -dj):ny + min(0, -dj), max(0, -di):nx + min(0, -di)]
        return out

    edge = np.zeros_like(C)
    if (legs[who] > 0).any():
        band = dilate(wall, float(reaches[legs > 0].max()))
        edge = raw_cut & band & (legs[who] > 0) & (-(Hc - Gc) <= legs[who])
    # TWO CLASSES THE HEIGHTFIELD CANNOT ADJUDICATE (#955). Both are reported, never counted:
    #  * WALL CELLS: a vertical wall between goal cells lands on one side of a cell boundary or the
    #    other; a cutter on the floor beside it cuts the straddling cell, whose own sample reads the
    #    upper surface (the one-cell lines along slot walls in the first calibration).
    #  * WALL SHADOW: a cutter working at a lower level cannot reach material laterally behind a wall,
    #    but a heightfield stamp spreads the cutter's profile over every cell under it. Cells within
    #    the largest cutting tool's radius of a wall step are therefore outside what this sweep can
    #    judge. A gouge away from any wall still fails, and the excluded share is printed.
    Rmax = max((t['cuttingDiameter'] / 2 for q in progs for t in q['tools']), default=0.0) if mkr \
        else progs[0]['cuttingDiameter'] / 2
    shadow = dilate(wall, Rmax) & ~wall
    wall_ns = wall & raw_cut & ~edge             # would have counted, is not scored
    shadow_ns = shadow & raw_cut & ~edge
    cut = raw_cut & ~edge & ~wall & ~shadow
    d = (Hc - Gc)[C]  # + material left above the goal, - cut below it
    n = max(int(C.sum()), 1); a = p * p
    def pct(m): return round(float(np.sum(m)) / n * 100, 2)
    s = {
        'goalCells': int(C.sum()), 'pitchMm': p, 'goalMinZ': round(float(G[C].min()), 3), 'stockThickness': T,
        'passCoveragePct': round(PASS_COVERAGE * 100, 2),
        'programs': progs,
        'cutIntoPct': pct(cut[C]), 'cutIntoAreaMm2': round(float(cut.sum()) * a, 1),
        'wallNotScoredPct': pct(wall_ns[C]), 'wallNotScoredAreaMm2': round(float(wall_ns.sum()) * a, 1),
        'shadowNotScoredPct': pct(shadow_ns[C]), 'shadowNotScoredAreaMm2': round(float(shadow_ns.sum()) * a, 1),
        'edgeBreakPct': pct(edge[C]), 'edgeBreakAreaMm2': round(float(edge.sum()) * a, 1),
        'edgeBreakMaxMm': round(float(max(0.0, (-(Hc - Gc))[edge].max())) if edge.any() else 0.0, 3),
        'cutIntoInclEdgePct': pct(raw_cut[C]),
        'cutInto0p1Pct': pct(C & ((Hc - Gc) < -0.1) & ~edge & ~wall & ~shadow),
        'cutInto0p5AreaMm2': round(float(np.sum(C & (Hc - Gc < -0.5) & ~edge & ~wall & ~shadow)) * a, 1),
        'maxCutIntoMm': round(float(max(0.0, (-(Hc - Gc))[cut].max())) if cut.any() else 0.0, 3),
        'cutIntoVolumeMm3': round(float(cut.sum()) * a, 1),
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
    if mkr:
        s['vendorSeconds'] = round(sum((q.get('vendorSeconds') or 0) for q in progs), 1)
        s['unmappedToolNumbers'] = sorted({n for q in progs for n in q['unmappedToolNumbers']})
        s['movesBeforeAnyToolChange'] = any(q['movesBeforeAnyToolChange'] for q in progs)
    json.dump(s, open(os.path.join(out, 'goalcheck.json'), 'w'), indent=1)
    # map, top view, +Y up: green within 0.1, blue leftover (darker = more), red cut-into
    D = np.where(C, Hc - Gc, np.nan)
    rgb = np.full((ny, nx, 3), 240, np.uint8)
    dd = np.nan_to_num(D)
    rgb[C & (np.abs(dd) <= 0.1)] = (120, 190, 120)
    m = C & (dd > 0.1); t = np.clip((dd - 0.1) / 3, 0, 1)
    rgb[m] = np.stack([150 * (1 - t[m]), 170 * (1 - t[m]) + 30, 230 - 60 * t[m]], -1).astype(np.uint8)
    rgb[C & (dd < -CUT_INTO)] = (235, 150, 150)
    rgb[edge] = (240, 170, 40)
    rgb[C & (dd < -0.1) & ~edge] = (215, 30, 30)
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

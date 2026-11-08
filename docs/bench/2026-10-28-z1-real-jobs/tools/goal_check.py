#!/usr/bin/env python3
"""Goal checker for 3D goal jobs (scratch tooling, not product code).

Stamps every feed move of every program with that program's own cutter (exact cutter shape,
evaluated at each goal cell's own sample point, no rounding of the cutter position to the grid),
over the app's goal heightfield (tools/goal-hf.mts, 0.1 mm pitch, sample point x0 + i*pitch), and
compares the swept stock with the goal at every covered goal cell:

  cut-into  = the cutter reached below the goal by more than 0.01 mm
  leftover  = material left above the goal (reported at 0.1 / 0.3 / 1 mm)

usage: goal_check.py <goal-prefix> <stock-thickness> <out-dir> [--job <job.json>] [--mkr] [--dz <mm>]
                     [--only-tools n,..] <a.nc> [b.nc ...]

--job gives the checker the JOB's own statement (`targetObject.edgeBreak`, or its old name
`chamfer`) so the edge-break allowance is the app's: no stated edge break, no allowance; a stated
one takes the widest usable V bit among its pin and the programs, that bit's own reach and leg, and
the statement's `edges` scope (`silhouette` by default, `all` when the job says so). Without --job
the app-posted path states no edge break — the conservative side, and exactly what the app itself
does for a job that states none.

--mkr scores a MAKERA STUDIO program: a `;@MKR|TOOL|number=N|…` header gives each tool's geometry and
every `T<N> M6` switches the stamp to that tool (flat / ball / V-cone with tip / drill). Studio's own
cycle estimate is read from `;@MKR|TIME|seconds=` and reported as `vendorSeconds`. A tool number in
the NC with no `;@MKR|TOOL` header is reported (`unmappedToolNumbers`), never silently swept as
nothing. The vendor card's own edge class keeps its stated scope: the widest V bit among the
program's tools, the band seeding from wall ∪ border.

THE GATE'S RULE (v5 → v8, #955/#970/#996/#1092) — the app's `checkGoalCutInto`, cell for cell. A
cell cut below the 0.01 mm floor is first EDGE BREAK when a stated V bit's band covers it, that
bit's stamp is the deepest there, and it is no deeper than the bit's leg. Then, in this order, each
class only for the cells still about to be judged:

  * WALL / BORDER — a cell on a > 0.2 mm step between goal cells, or a covered cell on the grid's
    own border (the silhouette where the grid ends at the model). Excused only on the straddling
    proof below, and only when its depth is no more than the goal's own local relief plus 0.005 mm.
    The proof's step test carries that same 0.005 mm (the sampled heightfield step can be a hair
    short of the design floor); the general proof below keeps only its 1e-12. A cell deeper than
    the relief is COUNTED (`wallOverReliefCells` / `borderOverReliefCells`), and a wall/border cell
    is never fed to the shadow class or the general proof.
  * WALL SHADOW — a cell within the largest cutting tool's radius of a wall, excused (v5) when the V
    bit cut it within its leg, or the deepest stamp's CL stayed at least that radius less one cell
    from the wall; then bounded by the relief exactly as the wall class is. A cell whose v5 proof
    passed but whose depth exceeds the relief is counted (`shadowOverReliefCells`) only if it then
    reaches adjudication.
  * STRADDLING PROOF (v6) — any other cell deeper than 0.1 mm is excused only when the step over its
    axial neighbours is at least as tall as the read intrusion, the swept floor is at the design's
    low side (0.005 mm slack), and the step is real (> 0).

THE GOAL'S OWN RELIEF at a cell is max − min of the COVERED goal top within the shadow radius (the
largest cutting tool's radius — the same disc the class is about); a border cell also counts the
stock top as a high side. The excuse is therefore bounded by the geometry the cell sits on, never by
a constant — the #1092 ruling, gate v8.

THE JUDGED FIGURE is the share of covered cells cut below the 0.1 mm floor after those exclusions
(`adjudicatedFraction`, the app receipt's `details.goal.adjudicatedFraction`); the raw figures at
0.01 mm, before any exclusion, stay beside it. tools/goal-check-parity.py compares the two.

Writes <out-dir>/goalcheck.json, goalcheck.npy (swept heights on the goal grid), goalcheck.png.
Single setup only (side-1 programs, work Z 0 = stock top).
"""
import json, math, os, re, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render as R

CUT_INTO = 0.01
# #964 — THE STAMP'S FOOTPRINT EDGE IS STRICT, the app's own line (`sweptPoint.ts`,
# `EDGE_EPS_MM`): a cell is cut only where its centre lies strictly inside the cutter's disc,
# `distance < radius - EDGE_EPS`. `distance <= radius` charged cells centred exactly on the disc
# edge — zero-measure contact — which is what the 134 contour-tangent tray cells were.
EDGE_EPS = 1e-6
# #996/#1092 — the gate's constants, the app's own (`designCheck.ts`): a cut shallower than the
# 0.1 mm floor is never judged; a straddling proof keeps 0.005 mm of slack at the design's low
# side; a > 0.2 mm step between goal cells is a wall (both sides).
ADJUDICATED_FLOOR_MM = 0.1
STRADDLING_SLACK_MM = 0.005
GOAL_EDGE_STEP_MM = 0.2

# #948 — THE PASS LINE comes from the shop's own defaults (`goal.passCoverage`, seeded 0.95), the
# same key the app's goal check reads, so the page's verdict and the app's cannot name different
# rules. A location exported before the seed carries no key: read the seed value as the fallback.
PASS_COVERAGE = float((getattr(R, 'LOC', {}).get('defaults') or {}).get('goal.passCoverage', {}).get('value', 0.95))


def tool_from_record(tool):
    """The stamp geometry of a location tool record — the app's own `stampProfile` (#964: a stated
    tip is the tip, for a chamfer as much as an engraver)."""
    shape = tool.get('shape')
    name = tool.get('name') or tool.get('label') or ''
    if shape in ('engraving', 'chamfer', 'v'):
        D = tool.get('diameter') or 3.175
        # the app's `stampProfile`: `halfAngle` when stated, else the included `angle` (else 30),
        # and the half angle's own absolute value (a sign on the field means nothing here).
        ang = (2 * tool['halfAngle']) if tool.get('halfAngle') else (tool.get('angle') or 30)
        t = math.tan(math.radians(abs(ang) / 2))
        tip = tool.get('tipDiameter') or 0.0
        tipR = tip / 2
        return {'name': name, 'shape': 'v', 'R': D / 2, 'diameter': D, 'tip': tip,
                'prof': lambda r, tt=t, t0=tipR: np.where(r <= t0, 0.0, (r - t0) / tt),
                'leg': (D / 2 - tipR) / t, 'number': tool.get('number') or 0}
    D = tool.get('tipDiameter') or tool.get('diameter') or 1.0
    Rr = D / 2
    if shape == 'ball':
        prof = lambda r, RR=Rr: RR - np.sqrt(np.maximum(RR * RR - r * r, 0))
    elif shape == 'drill':
        prof = lambda r: r / math.tan(math.radians(59))
    else:
        prof = lambda r: np.zeros_like(r)
    return {'name': name, 'shape': shape, 'R': Rr, 'diameter': D, 'tip': D,
            'prof': prof, 'leg': 0.0, 'number': tool.get('number') or 0}


def shadow_radius(t):
    """The cutting radius the app reads for the wall-shadow class (`cuttingRadius`): a V's cone end
    when the record states a body wider than its tip, else its cutting diameter; the stamp radius
    for every other shape (tip first, the app's `unambiguousCuttingDiameter`)."""
    if t['shape'] == 'v':
        return t['R'] if t['diameter'] > t['tip'] else t['tip'] / 2
    return t['R']


def put(Hf, Wf, CLXf, CLYf, idx, z, tn, cx, cy):
    """The deepest sample wins. `minimum.at`, not fancy assignment: one block can hit a cell several
    times and the last write is not the deepest (#955 — the port's 6 % leftover was exactly this).
    The cutter-location point rides the same write: a cell's CL belongs to the stamp that left it
    lowest (#970/v5), and a tie goes to the later sample (the app's `v <= field[k]`)."""
    np.minimum.at(Hf, idx, z)
    sel = z <= Hf[idx]
    sidx = idx[sel]
    Wf[sidx] = tn
    CLXf[sidx] = cx[sel]
    CLYf[sidx] = cy[sel]


def stamp(H, x0, y0, p, nc, who=None, clx=None, cly=None, tn=1, t=None):
    """Stamp one posted program. The cutter is the NC's own `;@MKR|TOOL` header when it has one
    (our posts write it, as Makera's do), so a multi-program run is scored with each program's
    own Tool record — the app's model. `tn` is the number the `who` map records. Returns the
    program report and the number of cell touches (0 = the program cut nothing)."""
    if t is None:
        t = tool_from_record(R.nc_tool(nc))
    Rr, prof, shape = t['R'], t['prof'], t['shape']
    name = t.get('name') or ''
    ny, nx = H.shape
    n = int(math.ceil(Rr / p)) + 1
    oi, oj = np.meshgrid(np.arange(-n, n + 1), np.arange(-n, n + 1), indexing='xy')
    oi = oi.ravel(); oj = oj.ravel()
    step = p * 0.5
    pts = []
    touches = 0
    def flush():
        nonlocal touches, pts
        if not pts: return
        Q = np.array(pts); pts = []
        B = max(1, 2_000_000 // oi.size)
        Hf = H.ravel()
        for b in range(0, len(Q), B):
            q = Q[b:b + B]
            ci = np.rint((q[:, 0] - x0) / p).astype(np.int64)[:, None] + oi[None, :]
            cj = np.rint((q[:, 1] - y0) / p).astype(np.int64)[:, None] + oj[None, :]
            ok = (ci >= 0) & (ci < nx) & (cj >= 0) & (cj < ny)
            r = np.hypot(x0 + ci * p - q[:, 0:1], y0 + cj * p - q[:, 1:2])
            ok &= r < max(Rr - EDGE_EPS, 0.0)
            z = q[:, 2:3] + prof(r)
            idx = (cj * nx + ci)[ok]; zz = z[ok]
            touches += int(idx.size)
            if who is None:
                np.minimum.at(Hf, idx, zz)
            else:
                cx = np.broadcast_to(q[:, 0:1], z.shape)[ok]
                cy = np.broadcast_to(q[:, 1:2], z.shape)[ok]
                put(Hf, who.ravel(), clx.ravel(), cly.ravel(), idx, zz, tn, cx, cy)
    for start, seg in R.parse_nc(nc):
        a = np.array(start[:3])
        for (px, py, pz, pa, rapid) in seg:
            b = np.array([px, py, pz])
            if min(a[2], b[2]) < 0.05:
                L = math.hypot(b[0] - a[0], b[1] - a[1]) + abs(b[2] - a[2])
                k = max(1, int(math.ceil(L / step)))
                tt = np.arange(0, k + 1)[:, None] / k
                q = a + (b - a) * tt
                q = q[q[:, 2] < 0.05]
                pts.extend(q.tolist())
                if len(pts) > 400_000: flush()
            a = b
    flush()
    return {'program': os.path.basename(nc), 'cutter': name, 'shape': shape,
            'cuttingDiameter': round(2 * Rr, 3), 'leg': round(t['leg'], 3),
            'toolNumber': int(tn)}, touches


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
            prof = lambda r, RR=Rr: RR - np.sqrt(np.maximum(RR * RR - r * r, 0))
        elif 'v-bit' in typ or 'engrav' in typ or 'chamfer' in typ or ang > 0:
            shape, Rr = 'v', d / 2
            half = math.radians((ang or 30) / 2); tipR = tip / 2
            leg = (Rr - tipR) / math.tan(half)
            prof = lambda r, tt=math.tan(half), t0=tipR: np.where(r <= t0, 0.0, (r - t0) / tt)
        elif 'drill' in typ:
            shape, Rr, leg = 'drill', d / 2, 0.0
            prof = lambda r: r / math.tan(math.radians(59))
        else:
            shape, Rr, leg = 'flat', dc / 2, 0.0
            prof = lambda r: np.zeros_like(r)
        tools[n] = {'number': n, 'name': f.get('name', ''), 'shape': shape,
                    'R': Rr, 'diameter': d, 'tip': tip, 'prof': prof,
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


def stamp_mkr(H, who, clx, cly, x0, y0, p, nc, tools, dz, known=None):
    """Stamp a Makera Studio program tool by tool; `who` records the tool that cut each cell deepest."""
    ny, nx = H.shape; Hf = H.ravel(); Wf = who.ravel(); Xf = clx.ravel(); Yf = cly.ravel()
    cache = {}
    touches = 0
    def kernel(t):
        if t['number'] not in cache:
            n = int(math.ceil(t['R'] / p)) + 1
            oi, oj = np.meshgrid(np.arange(-n, n + 1), np.arange(-n, n + 1), indexing='xy')
            cache[t['number']] = (oi.ravel(), oj.ravel())
        return cache[t['number']]
    pts = {}; used = {}; step = p * 0.5
    def flush(tn):
        nonlocal touches
        q = pts.get(tn)
        if not q: return
        t = tools[tn]; oi, oj = kernel(t); Q = np.array(q); pts[tn] = []
        B = max(1, 2_000_000 // oi.size)
        for b in range(0, len(Q), B):
            s = Q[b:b + B]
            ci = np.rint((s[:, 0] - x0) / p).astype(np.int64)[:, None] + oi[None, :]
            cj = np.rint((s[:, 1] - y0) / p).astype(np.int64)[:, None] + oj[None, :]
            ok = (ci >= 0) & (ci < nx) & (cj >= 0) & (cj < ny)
            r = np.hypot(x0 + ci * p - s[:, 0:1], y0 + cj * p - s[:, 1:2])
            ok &= r < max(t['R'] - EDGE_EPS, 0.0)
            zz = s[:, 2:3] + t['prof'](r)
            idx = (cj * nx + ci)[ok]; z = zz[ok]
            touches += int(idx.size)
            cx = np.broadcast_to(s[:, 0:1], zz.shape)[ok]
            cy = np.broadcast_to(s[:, 1:2], zz.shape)[ok]
            put(Hf, Wf, Xf, Yf, idx, z, tn, cx, cy)
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
            'vendorSeconds': mkr_time(nc)}, touches


# ---------------------------------------------------------------------------------------------
# THE GATE'S RULE — the app's `checkGoalCutInto`, v8.

def dilate(mask, nx, ny, p, radius_mm, strict=False):
    """Every cell within `radius_mm` of a set cell. `strict` keeps only cells for which a set cell
    is STRICTLY nearer than the radius (the v5 CL rule's `wallDist >= r − one cell`)."""
    r = int(math.ceil(radius_mm / p)) + (1 if strict else 0)
    out = np.zeros_like(mask)
    for dj in range(-r, r + 1):
        for di in range(-r, r + 1):
            d = math.hypot(di * p, dj * p)
            if (d >= radius_mm - 1e-9) if strict else (d > radius_mm + 1e-9):
                continue
            out[max(0, dj):ny + min(0, dj), max(0, di):nx + min(0, di)] |= \
                mask[max(0, -dj):ny + min(0, -dj), max(0, -di):nx + min(0, -di)]
    return out


def design_edges(G, C, p, outside):
    """The app's `designEdgeCells`: a > 0.2 mm step between goal tops, BOTH cells marked; an
    uncovered cell reads `outside` (the stock below the goal), so the silhouette is a step too."""
    ny, nx = G.shape
    at = np.where(C, G, outside)
    wall = np.zeros((ny, nx), bool)
    dh = np.abs(at[:, 1:] - at[:, :-1]) > GOAL_EDGE_STEP_MM
    wall[:, :-1] |= dh
    wall[:, 1:] |= dh
    dv = np.abs(at[1:, :] - at[:-1, :]) > GOAL_EDGE_STEP_MM
    wall[:-1, :] |= dv
    wall[1:, :] |= dv
    return wall


def border_cells(C):
    """The app's `borderCells`: a covered cell on the grid's outermost row or column."""
    border = np.zeros_like(C)
    border[0, :] |= C[0, :]; border[-1, :] |= C[-1, :]
    border[:, 0] |= C[:, 0]; border[:, -1] |= C[:, -1]
    return border


def relief_for(G, C, p, nx, ny, ci, cj, is_border, radius, topZ):
    """The app's `reliefAt`: max − min of the COVERED goal top within `radius` of each cell; a
    border cell adds the stock top as a high side; a disc with no covered cell is 0."""
    if ci.size == 0:
        return np.zeros(0)
    r = int(math.ceil(radius / p))
    offs = [(di, dj) for dj in range(-r, r + 1) for di in range(-r, r + 1)
            if math.hypot(di * p, dj * p) <= radius + 1e-9]
    oi = np.array([o[0] for o in offs]); oj = np.array([o[1] for o in offs])
    out = np.zeros(ci.size)
    CH = max(1, 4_000_000 // max(1, oi.size))
    for s in range(0, ci.size, CH):
        ii = ci[s:s + CH, None] + oi[None, :]
        jj = cj[s:s + CH, None] + oj[None, :]
        inb = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < ny)
        iic = np.clip(ii, 0, nx - 1); jjc = np.clip(jj, 0, ny - 1)
        ok = inb & C[jjc, iic]
        z = G[jjc, iic]
        hi = np.where(ok, z, -np.inf).max(axis=1)
        lo = np.where(ok, z, np.inf).min(axis=1)
        b = is_border[s:s + CH]
        hi = np.where(b & (topZ > hi), topZ, hi)
        out[s:s + CH] = np.where(np.isneginf(hi), 0.0, hi - lo)
    return out


def straddle_proof(G, C, H, nx, ny, ki, kj, depth, step_slack_mm=0.0):
    """The app's `straddleProof`: the step over the cell's AXIAL neighbours (uncovered or off-grid
    neighbours contribute nothing), the swept floor at the cell, and whether the proof holds.
    `step_slack_mm` is the rule's own slack in the step test — the wall/border class passes
    STRADDLING_SLACK_MM (the heightfield's sampled step is up to that much short of the design
    floor — measured 0.0004 mm on the tray's 2.885 mm floor, #1092); the general v6 proof keeps
    0 and its `1e-12` only, unchanged."""
    zc = G[kj, ki]
    hi = zc.copy(); lo = zc.copy()
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        ii = ki + di; jj = kj + dj
        inb = (ii >= 0) & (ii < nx) & (jj >= 0) & (jj < ny)
        iic = np.clip(ii, 0, nx - 1); jjc = np.clip(jj, 0, ny - 1)
        ok = inb & C[jjc, iic]
        z = G[jjc, iic]
        hi = np.where(ok & (z > hi), z, hi)
        lo = np.where(ok & (z < lo), z, lo)
    step = hi - lo
    swept = H[kj, ki]
    good = (np.isfinite(zc) & (step > 0) & (step + step_slack_mm + 1e-12 >= depth)
            & (swept >= lo - STRADDLING_SLACK_MM))
    return good, step


def stated_edge_break(job):
    """The job's own statement (`targetObject.edgeBreak`, or its old name `chamfer`), or None."""
    if not job:
        return None
    t = job.get('targetObject') or (job.get('targetObjects') or [None])[0] or {}
    return t.get('edgeBreak') or t.get('chamfer')


def edge_allowance(eb, tools):
    """The app's `goalEdgeBreakOptions`: the widest usable V bit among the statement's pin and the
    run's tools; that bit's own reach (cone end) and leg (cone height); its number for the `who`
    gate; the statement's `edges` scope (absent = the part's silhouette)."""
    if eb is None:
        return None
    cands = []
    key = eb.get('toolKey')
    if key:
        rec = (getattr(R, 'TOOLS', None) or {}).get(key)
        if rec is not None:
            cands.append(tool_from_record(rec))
    cands.extend(tools)
    best = None
    for t in cands:
        if t.get('shape') != 'v':
            continue
        # vToolAllowance: a stated body wider than the tip, and a positive cone height.
        if not (t['diameter'] > t['tip']) or not (t['leg'] > 0) or not (t['R'] > 0):
            continue
        if best is None or t['R'] > best['reachMm']:
            num = int(t['number'] or 0)
            best = {'reachMm': float(t['R']), 'legMm': float(t['leg']),
                    'toolNumber': (num if num > 0 else None),
                    'edges': (eb.get('edges') or 'silhouette')}
    return best


def judge(G, C, H, who, clx, cly, gh, stock_thickness, *, allowance=None, shadow_radius=0,
          programs=None, ideal_programs=None):
    """The gate's rule over one run's folded stamp. Returns the report dict and the masks the map
    needs."""
    ny, nx = G.shape
    p = float(gh['pitch']); x0 = float(gh['x0']); y0 = float(gh['y0'])
    topZ = float(gh.get('topZ') or 0.0)
    T = float(stock_thickness)
    if 'minZ' in gh:
        minZ = float(gh['minZ'])
    else:
        minZ = float(G[C].min()) if C.any() else topZ
    n = max(int(C.sum()), 1); a = p * p

    # d = swept top − goal top, the app's own sign (+ leftover, − cut below).
    dOf = np.where(C, H - G, 0.0)
    depth = -dOf
    raw = C & (dOf < -CUT_INTO)

    wall = design_edges(G, C, p, minZ - 1.0)
    border = border_cells(C)
    relief_radius = float(shadow_radius) if shadow_radius and shadow_radius > 0 else 0.0
    band = None
    if allowance is not None and allowance['reachMm'] > 0 and allowance['legMm'] > 0:
        seed = border.copy()
        if allowance['edges'] == 'all':
            seed |= wall
        band = dilate(seed, nx, ny, p, float(allowance['reachMm']))
    shadow = (dilate(wall, nx, ny, p, relief_radius) & ~wall) if relief_radius > 0 else None
    far_from_wall = None
    if relief_radius > 0:
        # the v5 CL rule as a dilation: no wall cell is strictly nearer than r − one cell
        far_from_wall = ~dilate(wall, nx, ny, p, max(relief_radius - p, 0.0), strict=True)

    excluded = np.zeros(nx * ny, bool)
    handled = np.zeros(nx * ny, bool)      # a wall/border cell never reaches a later class
    edge_mask = np.zeros(nx * ny, bool)
    edge_cells = wall_cells = shadow_cells = straddling_cells = 0
    straddling_max_step = 0.0
    wall_over = shadow_over = border_over = 0
    over_deepest = None
    def note_over(cls, d, x, y):
        nonlocal wall_over, shadow_over, border_over, over_deepest
        if cls == 'wall': wall_over += 1
        elif cls == 'border': border_over += 1
        else: shadow_over += 1
        if over_deepest is None or d > over_deepest['mm']:
            over_deepest = {'mm': float(d), 'x': float(x), 'y': float(y), 'cls': cls}

    kk = np.flatnonzero(raw.ravel())
    ki = kk % nx; kj = kk // nx
    dd = depth.ravel()[kk]
    xs = x0 + ki * p; ys = y0 + kj * p
    Wf = who.ravel(); Xf = clx.ravel(); Yf = cly.ravel(); Hf = H.ravel()
    wall_f = wall.ravel(); border_f = border.ravel()

    # 1 — EDGE BREAK: a stated V bit's band, its own leg, and its own stamp the deepest there.
    if band is not None and kk.size:
        num = allowance['toolNumber']
        who_ok = np.ones(kk.size, bool) if num is None else (Wf[kk] == int(num))
        hit = band.ravel()[kk] & (dd <= allowance['legMm'] + 1e-9) & who_ok
        excluded[kk[hit]] = True
        edge_mask[kk[hit]] = True
        edge_cells = int(hit.sum())

    # 2 — WALL / BORDER: the straddling proof, bounded by the goal's own relief at the cell.
    if kk.size:
        sel = ~excluded[kk]
        wb = sel & (wall_f[kk] | border_f[kk])
        if wb.any():
            cells = kk[wb]
            handled[cells] = True
            is_wall = wall_f[cells]
            is_border = (~is_wall) & border_f[cells]
            good, _ = straddle_proof(G, C, H, nx, ny, ki[wb], kj[wb], dd[wb],
                                     step_slack_mm=STRADDLING_SLACK_MM)
            rel = relief_for(G, C, p, nx, ny, ki[wb], kj[wb], is_border, relief_radius, topZ)
            ok = good & (dd[wb] <= rel + STRADDLING_SLACK_MM + 1e-12)
            excluded[cells[ok]] = True
            wall_cells = int(ok.sum())
            bad = ~ok
            if bad.any():
                for c, d, x, y, w in zip(cells[bad], dd[wb][bad], xs[wb][bad], ys[wb][bad], is_wall[bad]):
                    note_over('wall' if w else 'border', d, x, y)

    # 3 — WALL SHADOW: the v5 proof (the V within its leg, or the CL at the disc's rim), bounded by
    # the relief. A cell whose v5 proof passes but whose depth exceeds the relief is remembered and
    # counted only if it then reaches adjudication (the app's order).
    pending_shadow_over = None
    if shadow is not None and kk.size:
        sel = ~excluded[kk] & ~handled[kk]
        sh = sel & shadow.ravel()[kk]
        if sh.any():
            cells = kk[sh]
            num = allowance['toolNumber'] if allowance is not None else None
            excused_v = np.zeros(cells.size, bool)
            if num is not None:
                excused_v = (Wf[cells] == int(num)) & (dd[sh] <= allowance['legMm'] + 1e-9)
            ci = np.rint((Xf[cells] - x0) / p).astype(np.int64)
            cj = np.rint((Yf[cells] - y0) / p).astype(np.int64)
            inb = (ci >= 0) & (ci < nx) & (cj >= 0) & (cj < ny) & (Hf[cells] != 0)
            far = np.zeros(cells.size, bool)
            if far_from_wall is not None:
                far[inb] = far_from_wall[cj[inb] * nx + ci[inb]]
            excused = excused_v | far
            rel = relief_for(G, C, p, nx, ny, ki[sh], kj[sh], np.zeros(cells.size, bool),
                             relief_radius, topZ)
            ok = excused & (dd[sh] <= rel + STRADDLING_SLACK_MM + 1e-12)
            excluded[cells[ok]] = True
            shadow_cells = int(ok.sum())
            over = cells[excused & ~ok]
            if over.size:
                pending_shadow_over = over

    # 4 — THE STRADDLING PROOF (v6) for every cell still about to be judged, deeper than the floor.
    if kk.size:
        sel = ~excluded[kk] & ~handled[kk]
        st = sel & (dd > ADJUDICATED_FLOOR_MM)
        if st.any():
            good, step = straddle_proof(G, C, H, nx, ny, ki[st], kj[st], dd[st])
            cells = kk[st]
            excluded[cells[good]] = True
            straddling_cells = int(good.sum())
            if good.any():
                straddling_max_step = float(step[good].max())

    # The shadow cells whose v5 proof passed but whose depth exceeds the relief are counted only
    # now — a cell the straddling proof excused never reaches adjudication.
    if pending_shadow_over is not None:
        left = pending_shadow_over[~excluded[pending_shadow_over]]
        if left.size:
            d = depth.ravel()[left]
            for j in np.argsort(-d, kind='stable'):
                c = int(left[j])
                note_over('shadow', float(d[j]), float(x0 + (c % nx) * p), float(y0 + (c // nx) * p))

    excluded2 = excluded.reshape(ny, nx)
    adj = C & (dOf < -ADJUDICATED_FLOOR_MM) & ~excluded2
    adj_cells = int(adj.sum())
    adj_fraction = adj_cells / n
    adj01 = depth[adj]
    cut = raw & ~excluded2
    d = (H - G)[C]  # + material left above the goal, - cut below it

    def pct(m): return round(float(np.sum(m)) / n * 100, 2)

    s = {
        'goalCells': int(C.sum()), 'pitchMm': p,
        'goalMinZ': round(float(G[C].min()) if C.any() else topZ, 3),
        'stockThickness': T,
        'passCoveragePct': round(PASS_COVERAGE * 100, 2),
        'programs': programs or [],
        # the raw figure, before any exclusion (the app receipt's `cutIntoFraction`)
        'cutIntoInclEdgePct': pct(raw[C]),
        'rawCutIntoFraction': round(float(raw.sum()) / n, 6),
        'rawCutIntoAreaMm2': round(float(raw.sum()) * a, 1),
        'rawMaxCutIntoMm': round(float(depth[raw].max()) if raw.any() else 0.0, 3),
        # the 0.01 mm floor after the exclusions (the old reading, kept beside the gate's own)
        'cutIntoPct': pct(cut[C]), 'cutIntoAreaMm2': round(float(cut.sum()) * a, 1),
        'maxCutIntoMm': round(float(depth[cut].max()) if cut.any() else 0.0, 3),
        'cutIntoVolumeMm3': round(float(np.sum(depth[cut])) * a, 1),
        # the classes, each as the app counts them
        'wallNotScoredCells': int(wall_cells), 'wallNotScoredPct': round(wall_cells / n * 100, 2),
        'wallNotScoredAreaMm2': round(wall_cells * a, 1),
        'shadowNotScoredCells': int(shadow_cells), 'shadowNotScoredPct': round(shadow_cells / n * 100, 2),
        'shadowNotScoredAreaMm2': round(shadow_cells * a, 1),
        'edgeBreakCells': int(edge_cells), 'edgeBreakPct': round(edge_cells / n * 100, 2),
        'edgeBreakAreaMm2': round(edge_cells * a, 1),
        'edgeBreakMaxMm': round(float(depth.ravel()[edge_mask].max()) if edge_mask.any() else 0.0, 3),
        'straddlingNotScoredCells': int(straddling_cells),
        'straddlingNotScoredPct': round(straddling_cells / n * 100, 2),
        'straddlingMaxStepMm': round(straddling_max_step, 3),
        # the gate's judged figure: the 0.1 mm floor after the exclusions (the receipt's
        # `adjudicatedFraction` — the number the page and the app must agree on)
        'cutInto0p1Pct': round(adj_fraction * 100, 2),
        'adjudicatedFraction': round(adj_fraction, 6),
        'adjudicatedCells': adj_cells,
        'adjudicatedAreaMm2': round(adj_cells * a, 1),
        'adjudicatedVolumeMm3': round(float(np.sum(adj01)) * a, 1),
        'adjudicatedMaxMm': round(float(adj01.max()) if adj_cells else 0.0, 3),
        'cutInto0p5AreaMm2': round(float(np.sum(C & (dOf < -0.5) & ~excluded2)) * a, 1),
        # the goal's own relief and the v8 counters (the class that would have excused is counted)
        'reliefRadiusMm': round(relief_radius, 4),
        'wallOverReliefCells': int(wall_over),
        'shadowOverReliefCells': int(shadow_over),
        'borderOverReliefCells': int(border_over),
        'overReliefDeepest': over_deepest,
        # leftover, on the same raw sign
        'leftover0p1Pct': pct(d > 0.1), 'leftover0p3Pct': pct(d > 0.3), 'leftover1Pct': pct(d > 1),
        'maxLeftoverMm': round(float(max(0.0, d.max())) if d.size else 0.0, 3),
        'leftoverVolumeMm3': round(float(np.sum(np.clip(d, 0, None))) * a, 1),
        'untouchedPct': pct(H[C] >= 0),
        'medianMm': round(float(np.median(d)) if d.size else 0.0, 3),
    }
    ideal = None
    if ideal_programs:
        small = min(ideal_programs, key=lambda q: q['cuttingDiameter'])
        Rs = small['cuttingDiameter'] / 2
        Gf = np.where(C, np.maximum(G, -T), -T)
        m = int(math.ceil(Rs / p))
        offs = [(di, dj) for dj in range(-m, m + 1) for di in range(-m, m + 1)
                if math.hypot(di * p, dj * p) <= Rs]
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
        s['idealCutter'] = small['cuttingDiameter']
        s['idealLeftover0p3Pct'] = pct((np.maximum(ideal, -T) - Gc)[C] > 0.3)
        s['beyondReach0p1Pct'] = pct((Hc - np.maximum(ideal, -T))[C] > 0.1)
        s['beyondReach0p3Pct'] = pct((Hc - np.maximum(ideal, -T))[C] > 0.3)
        s['beyondReachVolumeMm3'] = round(float(np.sum(np.clip((Hc - np.maximum(ideal, -T))[C], 0, None))) * a, 1)
    return s, {'excluded': excluded2, 'raw': raw, 'ideal': ideal,
               'edge': edge_mask.reshape(ny, nx)}


def run_check(gp, T, out, ncs, *, job=None, mkr=False, dz=0.0, only=None, write=True):
    """Stamp the programs, apply the gate's rule, and (write=True) write the report, maps and PNG."""
    gh = json.load(open(gp + '.json'))
    nx, ny, p, x0, y0 = gh['nx'], gh['ny'], gh['pitch'], gh['x0'], gh['y0']
    G = np.fromfile(gp + '.bin', np.float32).reshape(ny, nx).astype(np.float64)
    if mkr:
        G = G - dz  # the goal sits `dz` deeper below the stock top (the header's placement, tested)
    C = np.fromfile(gp + '.cov', np.uint8).reshape(ny, nx) > 0
    H = np.zeros((ny, nx))
    who = np.zeros((ny, nx), np.uint8)
    clx = np.zeros((ny, nx))
    cly = np.zeros((ny, nx))
    progs = []
    tools_used = []
    shadow_R = 0.0
    allowance = None

    for nc in ncs:
        if mkr:
            allt = mkr_tools(nc)
            tools = allt if only is None else {k: v for k, v in allt.items() if k in only}
            F = np.zeros((ny, nx)); W = np.zeros((ny, nx), np.uint8)
            X = np.zeros((ny, nx)); Y = np.zeros((ny, nx))
            rep, touched = stamp_mkr(F, W, X, Y, x0, y0, p, nc, tools, dz, set(allt))
            tools_used.extend(tools.values())
        else:
            allt = mkr_tools(nc)
            if allt:
                t = allt[sorted(allt)[0]]
            else:                          # a header-less program: the old flat/ball reader
                rec = R.nc_tool(nc)
                if rec is None:
                    raise SystemExit(
                        f'{nc}: no ;@MKR|TOOL header and no recognisable Makera header — the '
                        'program states no cutter, so it cannot be scored')
                t = tool_from_record(rec)
            tn = max(0, min(255, int(t.get('number') or 0)))
            tools_used.append(t)
            F = np.zeros((ny, nx)); W = np.zeros((ny, nx), np.uint8)
            X = np.zeros((ny, nx)); Y = np.zeros((ny, nx))
            rep, touched = stamp(F, x0, y0, p, nc, W, X, Y, tn=tn, t=t)
        if touched:
            # the app's fold: the first program's field whole, then a strict '<' per cell
            upd = (F < H) if progs else np.ones((ny, nx), bool)
            H[upd] = F[upd]; who[upd] = W[upd]; clx[upd] = X[upd]; cly[upd] = Y[upd]
        progs.append(rep)

    if tools_used:
        shadow_R = max(shadow_radius(t) for t in tools_used)
    if mkr:
        # The vendor card's own stated class: the widest V bit among the program's tools, its band
        # seeding from wall ∪ border (the vendor's rim break is what the page's table states).
        if any(t['shape'] == 'v' and t['leg'] > 0 for t in tools_used):
            allowance = edge_allowance({'edges': 'all'}, tools_used)
        ideal_progs = [{'program': q['program'], 'cutter': t['name'], 'shape': t['shape'],
                        'cuttingDiameter': round(t['cuttingDiameter'], 3), 'leg': round(t['leg'], 3)}
                       for q in progs for t in q['tools']]
    else:
        allowance = edge_allowance(stated_edge_break(job), tools_used)
        ideal_progs = progs

    s, aux = judge(G, C, H, who, clx, cly, gh, T, allowance=allowance,
                   shadow_radius=shadow_R, programs=progs if mkr else ideal_progs,
                   ideal_programs=ideal_progs)
    if mkr:
        s['vendorSeconds'] = round(sum((q.get('vendorSeconds') or 0) for q in progs), 1)
        s['unmappedToolNumbers'] = sorted({n for q in progs for n in q['unmappedToolNumbers']})
        s['movesBeforeAnyToolChange'] = any(q['movesBeforeAnyToolChange'] for q in progs)
    if allowance is not None:
        s['edgeBreakReachMm'] = round(allowance['reachMm'], 4)
        s['edgeBreakLegMm'] = round(allowance['legMm'], 4)
        s['edgeBreakToolNumber'] = allowance['toolNumber']
        s['edgeBreakEdges'] = allowance['edges']
    s['edgeBreakStated'] = bool(allowance is not None)
    s['shadowRadiusMm'] = round(shadow_R, 4)

    if write:
        os.makedirs(out, exist_ok=True)
        json.dump(s, open(os.path.join(out, 'goalcheck.json'), 'w'), indent=1)
        np.save(os.path.join(out, 'goalcheck.npy'), H)
        if aux['ideal'] is not None:
            np.save(os.path.join(out, 'ideal.npy'), aux['ideal'])
        # map, top view, +Y up: green within 0.1, blue leftover (darker = more); red = adjudicated
        # cut-into, pale red = cut below the floor but excused, amber = edge break.
        Hc = np.maximum(H, -T); Gc = np.maximum(G, -T)
        D = np.where(C, Hc - Gc, np.nan)
        rgb = np.full((ny, nx, 3), 240, np.uint8)
        dd = np.nan_to_num(D)
        rgb[C & (np.abs(dd) <= 0.1)] = (120, 190, 120)
        m = C & (dd > 0.1); t = np.clip((dd - 0.1) / 3, 0, 1)
        rgb[m] = np.stack([150 * (1 - t[m]), 170 * (1 - t[m]) + 30, 230 - 60 * t[m]], -1).astype(np.uint8)
        rgb[C & (dd < -CUT_INTO)] = (235, 190, 190)
        rgb[C & (dd < -ADJUDICATED_FLOOR_MM) & ~aux['excluded']] = (215, 30, 30)
        rgb[aux['edge'] & C] = (240, 170, 40)
        w = min(1000, nx * 2)
        Image.fromarray(np.flipud(rgb)).resize((w, max(1, int(w * ny / nx)))).save(os.path.join(out, 'goalcheck.png'))
        print(json.dumps(s))
    return s


def main():
    args = sys.argv[1:]
    mkr = '--mkr' in args
    if mkr: args.remove('--mkr')
    dz = 0.0
    if '--dz' in args:
        i = args.index('--dz'); dz = float(args[i + 1]); del args[i:i + 2]
    job = None
    if '--job' in args:
        i = args.index('--job'); job = json.load(open(args[i + 1])); del args[i:i + 2]
    only = None
    if '--only-tools' in args:
        i = args.index('--only-tools'); only = {int(t) for t in args[i + 1].split(',')}; del args[i:i + 2]
    gp, T, out = args[0], float(args[1]), args[2]
    ncs = args[3:]
    run_check(gp, T, out, ncs, job=job, mkr=mkr, dz=dz, only=only, write=True)


if __name__ == '__main__':
    main()

"""Independent height-field sweep + renderer for the exercise (QA scratch; not product code).

usage: render.py <job.json> <out-dir> [nc-file ...]
  With no nc files: renders BEFORE only. Every nc file given is swept in order onto the same stock
  (so a two-program job's second program sees the first's removal).
Writes before.png, after.png, after-top.png into out-dir.
Method: parse G0/G1/G2/G3 (G90/G91, XY arcs with I/J), sweep the cutter shape from the location's
tool record (flat / ball / V-cone; drill = flat + 118-deg point; thread mill = flat at its diameter)
over a Z grid of the stock at <= 0.1 mm, then splat-render with a z-buffer.
"""
import sys, json, math, re, os
import numpy as np
from PIL import Image

S = os.path.dirname(os.path.abspath(__file__))
LOC = json.load(open(os.path.join(S, 'location.json')))
TOOLS = {'inv:' + i['id']: i['tool'] for i in LOC['inventory']}

COLOURS = {
    'pla': (235, 140, 40), 'petg': (60, 130, 200), 'plastic': (200, 40, 40), 'acrylic': (170, 215, 235),
    'aluminium-6061': (190, 195, 200), 'aluminium-7075': (190, 195, 200), 'brass': (205, 170, 80),
    'abs': (230, 230, 225), 'copper': (200, 120, 80),
}
LIGHT = np.array([-0.45, -0.55, 0.70]); LIGHT /= np.linalg.norm(LIGHT)


def tool_kernel(tool, res):
    shape = tool.get('shape')
    # The CUTTING diameter: for a ball, drill, thread mill or flat the location stores the shank as
    # `diameter` and the cutting size as `tipDiameter` (a 1 mm ball is diameter 3.175, tip 1.0).
    # Only a cone (engraving / chamfer) cuts out to `diameter`. v1 swept every ball at its shank.
    if shape in ('engraving', 'chamfer', 'v'):
        D = tool.get('diameter') or 3.175
    else:
        D = tool.get('tipDiameter') or tool.get('diameter') or 1.0
    R = D / 2
    n = int(math.ceil(R / res))
    ax = np.arange(-n, n + 1) * res
    X, Y = np.meshgrid(ax, ax, indexing='xy')
    r = np.hypot(X, Y)
    K = np.full(r.shape, np.inf)
    if shape in ('engraving', 'chamfer', 'v'):
        ang = tool.get('angle') or (2 * tool['halfAngle'] if tool.get('halfAngle') else 30)
        half = math.radians(ang / 2)
        tipR = (tool.get('tipDiameter') or 0) / 2
        if shape == 'chamfer':
            tipR = 0.0
        m = r <= R
        K[m] = np.where(r[m] <= tipR, 0.0, (r[m] - tipR) / math.tan(half))
    elif shape == 'ball':
        m = r <= R
        K[m] = R - np.sqrt(np.maximum(R * R - r[m] ** 2, 0))
    elif shape == 'drill':
        m = r <= R
        K[m] = (R - r[m]) * 0 + (r[m]) * 0  # tip is the point; body flat beyond
        K[m] = -(R - r[m]) / math.tan(math.radians(59)) + R / math.tan(math.radians(59))
        K[m] = K[m] - K[m].max()  # tip at 0, shoulders higher
        K[m] = -K[m]
        K[m] = (r[m]) / math.tan(math.radians(59))
    else:  # flat, thread
        K[r <= R] = 0.0
    return K, n, D, shape


def parse_nc(path):
    """Yield polyline samples (x, y, z, a, rapid) in absolute coordinates."""
    x = y = 0.0; z = 50.0; a = 0.0; absm = True; mode = 0
    for raw in open(path):
        line = raw.split(';')[0].split('(')[0].strip().upper()
        if not line or line.startswith('%'):
            continue
        if 'G53' in line or re.search(r'\bM6\b', line):
            continue
        words = dict()
        for k, v in re.findall(r'([A-Z])([-+]?\d*\.?\d+)', line):
            if k == 'G':
                g = int(float(v))
                if g in (0, 1, 2, 3): mode = g
                elif g == 90: absm = True
                elif g == 91: absm = False
            else:
                words[k] = float(v)
        if not any(k in words for k in 'XYZA'):
            continue
        nx = words.get('X', 0 if not absm else x); ny = words.get('Y', 0 if not absm else y)
        nz = words.get('Z', 0 if not absm else z); na = words.get('A', 0 if not absm else a)
        if not absm:
            nx += x; ny += y; nz += z; na += a
        if mode in (2, 3) and ('I' in words or 'J' in words):
            cx = x + words.get('I', 0); cy = y + words.get('J', 0)
            r0 = math.hypot(x - cx, y - cy)
            t0 = math.atan2(y - cy, x - cx); t1 = math.atan2(ny - cy, nx - cx)
            if mode == 2:
                while t1 >= t0: t1 -= 2 * math.pi
            else:
                while t1 <= t0: t1 += 2 * math.pi
            steps = max(2, int(abs(t1 - t0) * r0 / 0.05))
            pts = []
            for s in range(1, steps + 1):
                t = t0 + (t1 - t0) * s / steps
                pts.append((cx + r0 * math.cos(t), cy + r0 * math.sin(t), z + (nz - z) * s / steps, na, False))
            yield (x, y, z, a), pts
        else:
            yield (x, y, z, a), [(nx, ny, nz, na, mode == 0)]
        x, y, z, a = nx, ny, nz, na


def nc_tool(path):
    for line in open(path):
        m = re.search(r';@CM\|TOOL\|key=(\S+)', line)
        if m:
            return TOOLS.get(m.group(1).strip())
        m = re.search(r';@MKR\|TOOL\|.*\|type=([^|]+)\|.*\|diameter=([\d.]+)\|tipdiameter=([\d.]+)', line)
        if m:  # a Makera Studio program (the source's own .nc)
            kind = {'Flat End': 'flat', 'Ball End': 'ball'}.get(m.group(1), 'flat')
            return {'shape': kind, 'diameter': float(m.group(2)), 'tipDiameter': float(m.group(3))}
    return None


def sweep_flat(H, res, ncs, stock):
    for nc in ncs:
        tool = nc_tool(nc)
        K, n, D, shape = tool_kernel(tool, res)
        ny_, nx_ = H.shape
        prev = None
        for start, pts in parse_nc(nc):
            p0 = np.array(start[:3])
            for (px, py, pz, pa, rapid) in pts:
                p1 = np.array([px, py, pz])
                if min(p0[2], p1[2]) < 0.05:
                    L = np.linalg.norm(p1[:2] - p0[:2]) + abs(p1[2] - p0[2])
                    k = max(1, int(L / (res * 0.7)))
                    for s in range(1, k + 1):
                        q = p0 + (p1 - p0) * s / k
                        if q[2] >= 0.05: continue
                        ci = int(round(q[0] / res)); cj = int(round(q[1] / res))
                        i0, i1 = ci - n, ci + n + 1; j0, j1 = cj - n, cj + n + 1
                        if i1 <= 0 or j1 <= 0 or i0 >= nx_ or j0 >= ny_: continue
                        ki0 = max(0, -i0); kj0 = max(0, -j0)
                        ki1 = K.shape[1] - max(0, i1 - nx_); kj1 = K.shape[0] - max(0, j1 - ny_)
                        sub = H[max(0, j0):min(ny_, j1), max(0, i0):min(nx_, i1)]
                        np.minimum(sub, q[2] + K[kj0:kj1, ki0:ki1], out=sub)
                p0 = p1
    return H


def sweep_rotary(Rm, res, dth, R0, ncs):
    """Rm[theta_idx, x_idx] = surface radius. Tool tip radius from axis = Z word; tool axis radial."""
    for nc in ncs:
        tool = nc_tool(nc)
        rt = (tool.get('tipDiameter') or tool.get('diameter') or 1) / 2
        nth, nx_ = Rm.shape
        for start, pts in parse_nc(nc):
            p0 = np.array([start[0], start[3], start[2]])  # x, a(deg), z
            for (px, py, pz, pa, rapid) in pts:
                p1 = np.array([px, pa, pz])
                if min(p0[2], p1[2]) < R0:
                    arc = abs(p1[1] - p0[1]) * math.pi / 180 * R0
                    L = abs(p1[0] - p0[0]) + arc + abs(p1[2] - p0[2])
                    k = max(1, int(L / (res * 0.7)))
                    for s in range(1, k + 1):
                        q = p0 + (p1 - p0) * s / k
                        if q[2] >= R0: continue
                        ci = int(round(q[0] / res))
                        th = (q[1] % 360) * math.pi / 180
                        cth = int(round(th / dth))
                        ni = int(math.ceil(rt / res)); nt = int(math.ceil(rt / (R0 * dth)))
                        for di in range(-ni, ni + 1):
                            i = ci + di
                            if i < 0 or i >= nx_: continue
                            w = math.sqrt(max(rt * rt - (di * res) ** 2, 0))
                            span = int(w / (R0 * dth))
                            idx = (np.arange(cth - span, cth + span + 1)) % nth
                            Rm[idx, i] = np.minimum(Rm[idx, i], q[2])
                p0 = p1
    return Rm


def shade(normals, base):
    lam = np.clip(normals @ LIGHT, 0, 1)
    c = np.array(base, float) / 255
    col = c[None, :] * (0.35 + 0.65 * lam[:, None])
    return (np.clip(col, 0, 1) * 255).astype(np.uint8)


def splat(points, colours, view, size=(900, 600), bg=(245, 245, 242), fit=None, pix=1):
    """points Nx3 world; view = rotation matrix (3x3) -> screen (u right, v up, depth toward viewer)."""
    P = points @ view.T
    W, Hh = size
    if fit is None:
        lo = P[:, :2].min(0); hi = P[:, :2].max(0)
    else:
        lo, hi = fit
    sc = min((W - 60) / (hi[0] - lo[0] + 1e-9), (Hh - 60) / (hi[1] - lo[1] + 1e-9))
    u = ((P[:, 0] - lo[0]) * sc + (W - (hi[0] - lo[0]) * sc) / 2).astype(int)
    v = (Hh - ((P[:, 1] - lo[1]) * sc + (Hh - (hi[1] - lo[1]) * sc) / 2)).astype(int)
    d = P[:, 2]
    img = np.zeros((Hh, W, 3), np.uint8); img[:] = bg
    zb = np.full((Hh, W), -np.inf)
    order = np.argsort(d)  # far first, near overwrite
    for du in range(pix):
        for dv in range(pix):
            uu = u[order] + du; vv = v[order] + dv
            ok = (uu >= 0) & (uu < W) & (vv >= 0) & (vv < Hh)
            img[vv[ok], uu[ok]] = colours[order][ok]
    return img, (lo, hi)


def view_matrix(az, el):
    az, el = math.radians(az), math.radians(el)
    Rz = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    # camera looks down at elevation el: screen v gets z*cos(el) + y*sin(el)
    Rx = np.array([[1, 0, 0], [0, math.sin(el), math.cos(el)], [0, -math.cos(el), math.sin(el)]])
    return Rx @ Rz


def heightfield_points(H, res, T, colour):
    ny_, nx_ = H.shape
    xs = np.arange(nx_) * res; ys = np.arange(ny_) * res
    X, Y = np.meshgrid(xs, ys)
    solid = H > -T + 1e-3
    gy, gx = np.gradient(np.where(solid, H, -T), res)
    N = np.stack([-gx, -gy, np.ones_like(H)], -1); N /= np.linalg.norm(N, axis=-1, keepdims=True)
    pts = np.stack([X[solid], Y[solid], H[solid]], -1)
    cols = shade(N[solid], colour)
    # walls: drop from each cell to its lowest 4-neighbour (outside = bed)
    Hp = np.pad(np.where(solid, H, -T - 0.0), 1, constant_values=-T)
    lows = np.minimum.reduce([Hp[:-2, 1:-1], Hp[2:, 1:-1], Hp[1:-1, :-2], Hp[1:-1, 2:]])
    drop = np.where(solid, H - lows, 0)
    wall_pts = []; wall_cols = []
    m = drop > res * 0.8
    if m.any():
        idx = np.argwhere(m)
        dz = drop[m]
        k = np.minimum(np.ceil(dz / (res * 0.8)).astype(int), 400)
        rep = np.repeat(np.arange(len(idx)), k)
        frac = np.concatenate([np.arange(1, kk + 1) / kk for kk in k])
        jj, ii = idx[rep, 0], idx[rep, 1]
        z = H[jj, ii] - frac * dz[rep]
        wall_pts = np.stack([ii * res, jj * res, z], -1)
        # wall normal: toward the lowest neighbour
        nb = np.stack([Hp[:-2, 1:-1], Hp[2:, 1:-1], Hp[1:-1, :-2], Hp[1:-1, 2:]], -1)[m]
        dirs = np.array([[0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]], float)
        wn = dirs[np.argmin(nb, -1)][rep]
        wall_cols = shade(wn, tuple(int(c * 0.9) for c in colour))
        pts = np.concatenate([pts, wall_pts]); cols = np.concatenate([cols, wall_cols])
    return pts, cols


def bed_points(L, W, T, res, margin=8):
    step = res * 1.5
    xs = np.arange(-margin, L + margin, step); ys = np.arange(-margin, W + margin, step)
    X, Y = np.meshgrid(xs, ys)
    pts = np.stack([X.ravel(), Y.ravel(), np.full(X.size, -T - 0.05)], -1)
    chk = ((np.floor(X / 10) + np.floor(Y / 10)) % 2).ravel()
    cols = np.where(chk[:, None] > 0, [120, 120, 125], [100, 100, 105]).astype(np.uint8)
    return pts, cols


def render_flat(job, outdir, ncs):
    st = job['stock']; L, W, T = st['length'], st['width'], st['thickness']
    res = max(0.05, min(0.1, max(L, W) / 1500))
    colour = COLOURS.get(st['material'], (200, 200, 200))
    H0 = np.zeros((int(round(W / res)) + 1, int(round(L / res)) + 1))
    H = sweep_flat(H0.copy(), res, ncs, st) if ncs else H0
    view = view_matrix(-30, 35)
    bp, bc = bed_points(L, W, T, res)
    fit = None
    for tag, field in (('before', H0), ('after', H)):
        if tag == 'after' and not ncs: break
        p, c = heightfield_points(np.maximum(field, -T - 1), res, T, colour)
        P = np.concatenate([bp, p]); C = np.concatenate([bc, c])
        if fit is None:
            Pv = P @ view.T; fit = (Pv[:, :2].min(0), Pv[:, :2].max(0))
        img, _ = splat(P, C, view, fit=fit, pix=2)
        Image.fromarray(img).save(os.path.join(outdir, tag + '.png'))
    if ncs:
        top = view_matrix(0, 90)
        p, c = heightfield_points(np.maximum(H, -T - 1), res, T, colour)
        P = np.concatenate([bp, p]); C = np.concatenate([bc, c])
        img, _ = splat(P, C, top, size=(int(600 * max(1, L / W)) if L >= W else 600, 600) if False else (900, 600), pix=2)
        Image.fromarray(img).save(os.path.join(outdir, 'after-top.png'))
    removed = float(np.sum(H0 - np.maximum(H, -T)) * res * res)
    return {'res': res, 'removedMm3': round(removed, 1)}


def render_rotary(job, outdir, ncs):
    st = job['stock']; L = st['length']; R0 = st['diameter'] / 2
    res = 0.1
    nth = int(2 * math.pi * R0 / res); dth = 2 * math.pi / nth
    nx_ = int(L / res) + 1
    Rm0 = np.full((nth, nx_), R0)
    Rm = sweep_rotary(Rm0.copy(), res, dth, R0, ncs) if ncs else Rm0
    colour = COLOURS.get(st['material'], (200, 200, 200))
    view = view_matrix(-25, 25)
    fit = None
    for tag, field in (('before', Rm0), ('after', Rm)):
        if tag == 'after' and not ncs: break
        th = np.arange(nth) * dth; xs = np.arange(nx_) * res
        TH, X = np.meshgrid(th, xs, indexing='ij')
        Yp = field * np.cos(TH); Zp = field * np.sin(TH)
        P = np.stack([X.ravel(), Yp.ravel(), Zp.ravel()], -1)
        # normals: radial + slope along x and theta
        dRx = np.gradient(field, res, axis=1); dRt = np.gradient(field, dth, axis=0) / np.maximum(field, 1e-3)
        N = np.stack([-dRx, np.cos(TH) - dRt * -np.sin(TH), np.sin(TH) - dRt * np.cos(TH)], -1).reshape(-1, 3)
        N /= np.linalg.norm(N, axis=1, keepdims=True)
        C = shade(N, colour)
        if fit is None:
            Pv = P @ view.T; fit = (Pv[:, :2].min(0) - 2, Pv[:, :2].max(0) + 2)
        img, _ = splat(P, C, view, fit=fit, pix=2)
        Image.fromarray(img).save(os.path.join(outdir, tag + '.png'))
    if ncs:
        depth = R0 - Rm  # unrolled map, x right, arc up
        g = (255 - np.clip(depth / max(depth.max(), 1e-6), 0, 1) * 200).astype(np.uint8)
        img = Image.fromarray(np.flipud(g)).convert('RGB').resize((900, max(200, int(900 * nth / nx_))))
        img.save(os.path.join(outdir, 'after-top.png'))
    return {'res': res, 'note': 'rotary: radius map over (theta, x); after-top is the unrolled surface'}


if __name__ == '__main__':
    job = json.load(open(sys.argv[1])); outdir = sys.argv[2]; ncs = sys.argv[3:]
    os.makedirs(outdir, exist_ok=True)
    if job['stock'].get('shape') == 'cylinder':
        info = render_rotary(job, outdir, ncs)
    else:
        info = render_flat(job, outdir, ncs)
    print(json.dumps(info))

"""Design-vs-CUT check for the demo runs (QA scratch, not product code).

usage: design_check.py <job.json> <run-dir> [nc ...]

Sweeps the run's NC files onto the job's blank with the same independent height field render.py
uses, then compares the cut surface with the job's OWN design: every enabled shape, vector, trace,
drill and cutaway is turned into a mask, and the surface inside it is compared with the floor the
design asks for — where items overlap, the DEEPEST item's floor. A shape a cut-out profiles is the
part's outline, so it is reported but not measured as a pocket. Prints one JSON line per item and a
summary:
  left    fraction of the item's interior that still stands ABOVE its floor (material left)
  deep    fraction cut BELOW the design floor
  through truth for through items: the cut reached the blank's underside
  outside cells far from the design that the cut removed although the design expects stock
Labels (text) are bounded boxes — their glyph geometry needs the app's font engine; their boxes are
excluded from the outside test and the text itself is not measured.
"""

import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import render  # noqa: E402

TOL = 0.05  # mm, depth tolerance
ERODE_MM = 0.3  # the tool cannot hold the design's inner corners; check this far inside
OUTSIDE_MM = 0.15  # a cut this far below the top, away from the design, is overcut
KERF_MARGIN_MM = 3.5  # a cutout's kerf lies within this of the part's outline


def rot(px, py, cx, cy, deg):
    if abs(deg) < 1e-12:
        return px, py
    a = math.radians(deg)
    ca, sa = math.cos(a), math.sin(a)
    dx, dy = px - cx, py - cy
    return cx + dx * ca - dy * sa, cy + dx * sa + dy * ca


class Grid:
    def __init__(self, L, W, res):
        self.L = L
        self.W = W
        self.res = res
        self.nx = int(round(L / res)) + 1
        self.ny = int(round(W / res)) + 1

    def empty(self):
        return np.zeros((self.ny, self.nx), bool)

    def polygon(self, ring):
        img = Image.new('1', (self.nx, self.ny), 0)
        pts = [(x / self.res, y / self.res) for (x, y) in ring]
        ImageDraw.Draw(img).polygon(pts, fill=1)
        return np.array(img, bool)

    def even_odd(self, rings):
        m = self.empty()
        for ring in rings:
            m ^= self.polygon(ring)
        return m

    def circle(self, cx, cy, r):
        ys, xs = np.mgrid[0:self.ny, 0:self.nx]
        return np.hypot(xs * self.res - cx, ys * self.res - cy) <= r

    def capsule(self, cx, cy, length, width, deg):
        # slot: overall length along the item's local X, end radius width/2
        r = width / 2
        half = max(0.0, length / 2 - r)
        a = rot(cx - half, cy, cx, cy, deg)
        b = rot(cx + half, cy, cx, cy, deg)
        ys, xs = np.mgrid[0:self.ny, 0:self.nx]
        px = xs * self.res
        py = ys * self.res
        dx, dy = b[0] - a[0], b[1] - a[1]
        l2 = dx * dx + dy * dy
        t = np.clip(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1) if l2 > 0 else np.zeros_like(px)
        qx = a[0] + t * dx
        qy = a[1] + t * dy
        return np.hypot(px - qx, py - qy) <= r

    def rect(self, cx, cy, w, h, deg):
        pts = []
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x, y = cx + sx * w / 2, cy + sy * h / 2
            pts.append(rot(x, y, cx, cy, deg))
        return self.polygon(pts)

    def round_rect(self, cx, cy, w, h, r, deg=0):
        # A rect with rounded corners, as the app's `cornerRadius` makes it: four circular arcs of
        # radius r centred `w/2 - r` / `h/2 - r` in from the corners, joined by the straight edges.
        # Sampled as a polygon (a quarter arc every 5 degrees) so a rotated item costs nothing
        # extra. #940 — the sample-4 pocket is r 3, and the old square mask called the four corner
        # squares "material left" when the CAM had cut exactly the rounded design.
        r = max(0.0, min(float(r), min(w, h) / 2))
        ax, ay = w / 2 - r, h / 2 - r
        pts = []
        for sx, sy, a0 in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
            ccx, ccy = sx * ax, sy * ay
            for k in range(0, 19):
                a = math.radians(a0 + 90 * k / 18)
                pts.append(rot(cx + ccx + r * math.cos(a), cy + ccy + r * math.sin(a), cx, cy, deg))
        if r <= 0:
            return self.rect(cx, cy, w, h, deg)
        return self.polygon(pts)

    def polyline(self, pts, half):
        # A trace is a centreline: a thin band about it samples the groove's own bottom.
        img = Image.new('1', (self.nx, self.ny), 0)
        d = ImageDraw.Draw(img)
        w = max(1, int(round(2 * half / self.res)))
        xy = [(x / self.res, y / self.res) for (x, y) in pts]
        if len(xy) >= 2:
            d.line(xy, fill=1, width=w, joint='curve')
        elif len(xy) == 1:
            r = max(0.5, w / 2)
            d.ellipse([xy[0][0] - r, xy[0][1] - r, xy[0][0] + r, xy[0][1] + r], fill=1)
        return np.array(img, bool)

    def dilated(self, mask, mm):
        n = int(math.ceil(mm / self.res))
        if n <= 0:
            return mask
        out = mask.copy()
        for dy in range(-n, n + 1):
            for dx in range(-n, n + 1):
                if dx * dx + dy * dy > n * n:
                    continue
                shifted = np.zeros_like(mask)
                ys0, ys1 = max(0, dy), min(mask.shape[0], mask.shape[0] + dy)
                xs0, xs1 = max(0, dx), min(mask.shape[1], mask.shape[1] + dx)
                shifted[ys0:ys1, xs0:xs1] = mask[ys0 - dy:ys1 - dy, xs0 - dx:xs1 - dx]
                out |= shifted
        return out

    def eroded(self, mask, mm):
        return ~self.dilated(~mask, mm)


def shape_mask(g, shape):
    kind = shape.get('kind')
    p = shape.get('position') or {'x': 0, 'y': 0}
    cx, cy = p['x'], p['y']
    deg = shape.get('rotation') or 0
    if kind == 'rect':
        # #940 — a rounded rect is the app's `cornerRadius`, not a square: the CAM cuts the arcs,
        # and the four corner squares are not pocket at all.
        radius = float(shape.get('cornerRadius') or 0)
        if radius > 0:
            return g.round_rect(cx, cy, shape['width'], shape['height'], radius, deg)
        return g.rect(cx, cy, shape['width'], shape['height'], deg)
    if kind == 'circle':
        return g.circle(cx, cy, shape['diameter'] / 2)
    if kind == 'slot':
        return g.capsule(cx, cy, shape['length'], shape['width'], deg)
    if kind == 'polygon':
        pts = [rot(cx + x, cy + y, cx, cy, deg) for (x, y) in shape['points']]
        return g.polygon(pts)
    return g.empty()


def vector_mask(g, vec):
    p = vec.get('position') or {'x': 0, 'y': 0}
    cx, cy = p['x'], p['y']
    deg = vec.get('rotation') or 0
    rings = []
    for contour in vec.get('contours') or []:
        rings.append([rot(cx + x, cy + y, cx, cy, deg) for (x, y) in contour])
    return g.even_odd([r for r in rings if len(r) >= 3])


def label_box(g, label):
    size = float(label.get('size') or 5)
    text = label.get('text') or ''
    width = max(size, size * 0.62 * len(text)) + size
    height = size * 1.8
    p = label.get('position') or {'x': 0, 'y': 0}
    return g.rect(p['x'], p['y'], width, height, label.get('rotation') or 0)


def job_cutter_v(job):
    """The job's own cutter, resolved through the location the checker was handed: (is it a V, its
    half-angle in radians or None). Both scoring rules below read the cutter from here, not from a
    per-item vCarveDepth flag — the SVG import never writes one."""
    tool = render.TOOLS.get((job.get('toolKey') or '').strip())
    is_v = bool(tool) and tool.get('shape') in ('engraving', 'chamfer', 'v')
    half = None
    if is_v:
        ang = tool.get('angle') or (2 * tool.get('halfAngle') if tool.get('halfAngle') else None)
        if ang:
            half = math.radians(float(ang) / 2)
    return is_v, half


def design_items(job, g):
    """Every enabled design region: id, kind, mask, expected floor depth, through flag."""
    # THE CARD'S V-BAND RULE (one line on the page's method note): a painted BAND — an imported
    # vector region — cut by a V cutter is a CONE, so its walls are the design and are not measured
    # as material left. The job's own cutter decides (render.TOOLS): the coasters' bands were scored
    # as flat pockets (8.6-11.4 % "left" on a clean V cut).
    tool_is_v, _half = job_cutter_v(job)
    by_id = {s['id']: s for s in (job.get('shapes') or [])}
    label_by_id = {l['id']: l for l in (job.get('labels') or [])}
    # An inlay half is cut by the pair's V; every region in such a job is a cone-cut region.
    has_inlay = any(
        it.get('inlay') is not None
        for key in ('labels', 'shapes', 'combined', 'vectors')
        for it in (job.get(key) or [])
    )
    items = []
    for s in job.get('shapes') or []:
        if not s.get('enabled'):
            continue
        items.append({'id': s['id'], 'kind': 'shape', 'mask': shape_mask(g, s), 'depth': s['depth'], 'through': s.get('through') is True, 'construction': s.get('construction') is True, 'v': s.get('vCarveDepth') is not None or s.get('inlay') is not None or has_inlay})
    for v in job.get('vectors') or []:
        if not v.get('enabled'):
            continue
        items.append({'id': v['id'], 'kind': 'vector', 'mask': vector_mask(g, v), 'depth': v['depth'], 'through': v.get('through') is True, 'construction': v.get('construction') is True, 'v': v.get('vCarveDepth') is not None or v.get('inlay') is not None or has_inlay or tool_is_v})
    for t in job.get('traces') or []:
        if not t.get('enabled') or t.get('kind') != 'line':
            continue
        p = t.get('position') or {'x': 0, 'y': 0}
        deg = t.get('rotation') or 0
        pts = [rot(p['x'] + x, p['y'] + y, p['x'], p['y'], deg) for (x, y) in t.get('points') or []]
        if t.get('closed') is True and len(pts) >= 3:
            pts = pts + [pts[0]]
        mask = g.polyline(pts, max(0.05, 0.75 * g.res))
        items.append({'id': t['id'], 'kind': 'trace', 'mask': mask, 'depth': t['depth'], 'through': False})
    for c in job.get('combined') or []:
        if not c.get('enabled'):
            continue
        if c.get('kind') == 'cutaway':
            def mask_for(idv):
                if idv is None:
                    return g.empty()
                if idv in by_id:
                    return shape_mask(g, by_id[idv])
                for v in (job.get('vectors') or []):
                    if v.get('id') == idv:
                        return vector_mask(g, v)
                label = label_by_id.get(idv)
                return label_box(g, label) if label is not None else g.empty()

            mask = mask_for(c.get('outer'))
            for island_id in c.get('islands') or []:
                mask &= ~mask_for(island_id)
            items.append({'id': c['id'], 'kind': 'cutaway', 'mask': mask, 'depth': c['depth'], 'through': c.get('through') is True, 'construction': c.get('construction') is True, 'v': c.get('vCarveDepth') is not None or c.get('inlay') is not None or has_inlay})
        else:
            items.append({'id': c['id'], 'kind': f'combined-{c.get("kind")}', 'mask': g.empty(), 'depth': c.get('depth', 0), 'through': False, 'note': 'not modelled'})
    for d in job.get('drills') or []:
        if not d.get('enabled'):
            continue
        p = d.get('position') or {'x': 0, 'y': 0}
        r = float(d.get('diameter') or 1) / 2
        items.append({'id': d['id'], 'kind': 'drill', 'mask': g.circle(p['x'], p['y'], r), 'depth': d.get('depth', 0), 'through': d.get('through') is True})
    for t in job.get('threads') or []:
        if not t.get('enabled'):
            continue
        p = t.get('position') or {'x': 0, 'y': 0}
        size = t.get('size') or 'M3'
        try:
            major = float(str(size).lstrip('Mm'))
        except ValueError:
            major = 3.0
        items.append({'id': t['id'], 'kind': 'thread', 'mask': g.circle(p['x'], p['y'], max(1.6, major * 0.75)), 'depth': t.get('depth', 0), 'through': t.get('through') is True, 'note': 'thread — not measured'})
    labels = [l for l in (job.get('labels') or []) if l.get('enabled')]
    return items, labels


def _edge(m):
    """One-cell boundary of a boolean mask (any neighbour off the mask)."""
    e = m.copy()
    e[1:, :] &= m[:-1, :]; e[:-1, :] &= m[1:, :]
    e[:, 1:] &= m[:, :-1]; e[:, :-1] &= m[:, 1:]
    e[0, :] = False; e[-1, :] = False; e[:, 0] = False; e[:, -1] = False
    return m & ~e


def overlay(path, H, T, items, label_masks, floor_map):
    """Top view of the swept surface with the design drawn on it: outlines green, material still
    above its floor (under-cut) tinted red, cut below its floor (over-cut) tinted blue."""
    g = np.clip(-H / max(float(-H.min()), 0.2), 0, 1)
    base = (250 - 170 * g).astype(np.float64)
    rgb = np.stack([base, base, base], -1)
    measured = floor_map < -1e-3
    for sel, col in ((measured & (H > floor_map + TOL), (255, 120, 90)),
                     (measured & (H < floor_map - TOL), (90, 140, 255))):
        rgb[sel] = rgb[sel] * 0.45 + np.array(col, float) * 0.55
    for m in [it['mask'] for it in items if it.get('mask') is not None] + [m for m in label_masks if m.any()]:
        rgb[_edge(m)] = (20, 90, 40)
    img = Image.fromarray(np.flipud(rgb.astype(np.uint8)))
    w = min(1000, H.shape[1])
    img.resize((w, max(1, int(w * H.shape[0] / H.shape[1])))).save(path)


def main():
    job_path, run_dir = sys.argv[1], sys.argv[2]
    ncs = sys.argv[3:]
    if not ncs:
        ncs = sorted(
            os.path.join(run_dir, f) for f in os.listdir(run_dir) if f.endswith('.nc') and not f.endswith('-frame.nc')
        )
    job = json.load(open(job_path))
    st = job['stock']
    L, W, T = st['length'], st['width'], st['thickness']
    res = max(0.05, min(0.1, max(L, W) / 1500))
    g = Grid(L, W, res)
    H = render.sweep_flat(np.zeros((g.ny, g.nx)), res, ncs, st)
    items, labels = design_items(job, g)
    # A shape a cut-out profiles is the PART's outline, not a pocket: its interior stays at the top
    # face (bar anything else cut into it), so it is reported but not measured as a pocket. A shape
    # a cutaway clears is the cutaway's own field: measured there, once.
    profile_ids = {c.get('of') for c in job.get('cutouts') or [] if c.get('enabled') and c.get('of')}
    cleared_ids = {
        c.get('outer')
        for c in job.get('combined') or []
        if c.get('enabled') and c.get('kind') == 'cutaway' and c.get('outer')
    }
    island_ids = {
        i
        for c in job.get('combined') or []
        if c.get('enabled') and c.get('kind') == 'cutaway'
        for i in c.get('islands') or []
    }
    for it in items:
        if it.get('construction'):
            it['reference'] = True
        if it['id'] in profile_ids:
            it['profile'] = True
        elif it['id'] in cleared_ids:
            it['cleared'] = True
        elif it['id'] in island_ids:
            it['island'] = True
    label_masks = [label_box(g, l) for l in labels]
    label_any = g.empty()
    for m in label_masks:
        label_any |= m
    # Text areas are measured by the app's font engine, not here: no item is judged under a label.
    label_zone = g.dilated(label_any, 0.5) if label_any.any() else label_any
    design_any = g.empty()
    part_any = g.empty()
    for it in items:
        design_any |= it['mask']
        if it.get('profile'):
            part_any |= it['mask']
    has_part = bool(part_any.any())
    # A V-carve owns its own cells: its floor is the design there, not the flat item's.
    v_any = g.empty()
    through_any = g.empty()
    for it in items:
        if it.get('v'):
            v_any |= it['mask']
        if it.get('through'):
            through_any |= it['mask']

    def floor_of(it):
        # A through item's design floor is the underside; the cut passes it by the breakthrough
        # allowance, and an item overlapping it must not read that allowance as a gouge.
        return -(T + 0.4) if it['through'] else -float(it['depth'])

    # THE CARD'S j10 RULE (one line on the page's method note): a cell within the check's own
    # erosion of a DEEPER item's region is THAT item's cut — a V's flank spreads past its region —
    # and does not count against this item's floor. The rays start inside the head pocket's 90° V
    # flank and read as 10.8 % "cut past the floor" while their own NC section is at Z -0.5.
    def scored_item(it):
        return not (it.get('profile') or it.get('cleared') or it.get('note') or it.get('v') or it.get('reference'))

    tool_is_v, tool_half_rad = job_cutter_v(job)

    def neighbour_halo(it):
        # HOW FAR a deeper item's cut can reach past its own region: a V cutter's mouth at the
        # item's depth (depth x tan half-angle) — j10's head pocket is a 90 deg V at 1.5 mm, so its
        # flank runs up to 1.5 mm into the rays that start on it; a flat tool cannot spread beyond
        # its region by more than the checker's own erosion, which is the floor of the rule.
        if not tool_is_v or not tool_half_rad:
            return ERODE_MM
        return max(ERODE_MM, abs(float(it['depth'])) * math.tan(tool_half_rad))

    deeper_exclusion = {}
    for f in sorted({round(floor_of(it), 6) for it in items if scored_item(it)}):
        members = [it for it in items if scored_item(it) and floor_of(it) < f - 1e-9]
        if not members:
            deeper_exclusion[f] = None
            continue
        union = g.empty()
        for it in members:
            union |= it['mask']
        halo = max([ERODE_MM] + [neighbour_halo(it) for it in members])
        deeper_exclusion[f] = g.dilated(union, halo) if union.any() else None

    # The floor every cell should end at, where items overlap: the DEEPEST one asks for it.
    floor_map = np.zeros((g.ny, g.nx))
    for it in items:
        if it.get('profile') or it.get('cleared') or it.get('note') or it.get('v') or it.get('reference'):
            continue
        floor_map[it['mask']] = np.minimum(floor_map[it['mask']], floor_of(it))

    report = {'job': os.path.basename(job_path), 'stock': [L, W, T], 'res': res, 'items': [], 'outside': None}

    # Labels: the glyph geometry is the app's font engine's, but the BOX still says whether the
    # cut reached the label's depth and never passed it. atDepth is the fraction of box cells at
    # depth ±0.05 (mostly empty between glyphs), reachRatio the deepest cell over the depth.
    # A V-inlay job cuts its labels as cones, so a label's box says nothing about the glyph floor.
    has_inlay = any(it.get('inlay') is not None for key in ('labels', 'shapes', 'combined', 'vectors')
                    for it in (job.get(key) or []))
    label_report = []
    for l, m in zip(labels, label_masks):
        d = float(l.get('depth') or 0)
        if has_inlay:
            label_report.append({'id': l['id'], 'kind': 'label', 'inlay': True,
                                 'note': 'V-inlay label — the app’s oracle measures it, not this check'})
            continue
        if not m.any() or d <= 0:
            label_report.append({'id': l['id'], 'kind': 'label', 'note': 'no box or depth'})
            continue
        vals = H[m]
        label_report.append({'id': l['id'], 'kind': 'label', 'depth': d,
                             'reachRatio': round(float(-vals.min()) / d, 3),
                             'atDepth': round(float(np.mean(np.abs(vals + d) <= 0.05)), 4),
                             'deep': round(float(np.mean(vals < -d - TOL)), 4),
                             'maxZ': round(float(vals.max()), 3)})
    report['items'].extend(label_report)

    def local_min(h):
        # A trace's mask is a one-cell band on a centreline; a cell's own sample can sit a hair off
        # the groove's bottom. Its groove is the LOWEST point within one cell of the centreline.
        m = h.copy()
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                m = np.minimum(m, np.roll(np.roll(h, dy, axis=0), dx, axis=1))
        return m

    for it in items:
        mask = it['mask']
        if it.get('profile'):
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'profile': True, 'note': 'part outline (cut-out) — not measured as a pocket'})
            continue
        if it.get('reference'):
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'reference': True, 'note': 'construction/reference — not cut'})
            continue
        if it.get('cleared'):
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'cleared': True, 'note': 'cut field — measured as its cut-away'})
            continue
        if it.get('island'):
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'island': True, 'note': 'stands inside a cut-away — not cut'})
            continue
        if it.get('note'):
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'note': it['note']})
            continue
        if not mask.any():
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'note': it.get('note', 'no mask')})
            continue
        # A part's items are the part's: a rebate drawn past the outline lives mostly in the waste
        # the cut-out removes, so only its part side is measured.
        region = mask & part_any if has_part else mask
        region = region & ~label_zone
        exc = deeper_exclusion.get(round(floor_of(it), 6))
        if exc is not None:
            region = region & ~exc
        if not it.get('v'):
            region = region & ~v_any
        if not it['through']:
            # A through cut owns its cells too: the breakthrough is not this item's floor.
            region = region & ~through_any
        inner = g.eroded(region, ERODE_MM)
        if not inner.any():
            inner = region
        if not inner.any() and exc is not None:
            # A thin item whose whole region the deeper neighbour's cut covers measures nothing;
            # fall back to its own cells OUTSIDE that neighbour, never to the unfiltered mask —
            # otherwise the neighbour's cut is judged against this item's floor again (tuft9_-35).
            inner = mask & ~exc
        if not inner.any():
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'note': 'covered by a deeper item — not measured'})
            continue
        if not inner.any():
            inner = mask
        vals = (local_min(H) if it['kind'] == 'trace' else H)[inner]
        want = floor_map[inner]
        if it.get('v') and not it['through']:
            # A cone-cut region has no flat floor: its walls rise from the boundary to the declared
            # depth at the medial. The honest test is that the cut REACHES the declared depth and
            # never passes it — the walls are the design, not material left.
            reach = float(-vals.min())
            over = float(np.mean(vals < -float(it['depth']) - TOL))
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'depth': it['depth'], 'v': True, 'reach': round(reach, 3), 'over': round(over, 4)})
            continue
        if it['through']:
            left = float(np.mean(vals > -T + TOL))
            deep = float(np.mean(vals < -T - 0.35))  # breakthrough depth is ~T + 0.3
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'through': True, 'left': round(left, 4), 'deepPastBreak': round(deep, 4), 'maxZ': round(float(vals.max()), 3), 'areaMm2': round(float(mask.sum()) * g.res * g.res, 2)})
        else:
            left = float(np.mean(vals > want + TOL))
            deep = float(np.mean(vals < want - TOL))
            report['items'].append({'id': it['id'], 'kind': it['kind'], 'depth': it['depth'], 'left': round(left, 4), 'deep': round(deep, 4), 'p05': round(float(np.percentile(vals - want, 5)), 3), 'maxZ': round(float(vals.max()), 3), 'areaMm2': round(float(mask.sum()) * g.res * g.res, 2)})
    # Outside: material removed where the design expects stock. On a part cut free by a cut-out,
    # the stock AROUND the part is design waste, so the question is a gouge INTO the part, away
    # from every cut it asks for. Without a part, it is any cut away from the design (labels and a
    # cut-out kerf band excused).
    cut_any = g.empty()
    for it in items:
        if it.get('profile') or it.get('reference') or it.get('note'):
            continue
        cut_any |= it['mask']
    # A chamfer's bevel is cut along its target's rim and is wider than the item's own mask; it
    # has no height-field model here, so a band as wide as the bevel is excused from the gouge test.
    mask_by_id = {it['id']: it['mask'] for it in items}
    chamfer_any = g.empty()
    for c in job.get('chamfers') or []:
        if not c.get('enabled') or not c.get('of'):
            continue
        m = mask_by_id.get(c['of'])
        if m is not None and c.get('width'):
            chamfer_any |= g.dilated(m, float(c['width']) + 0.5)
    if has_part:
        # A band along the part's own outline is the cut-out's kerf (the raster samples cell
        # centres, so the through cut can colour the part-side edge); the part's INTERIOR is the
        # question.
        excused = g.dilated(cut_any | label_any, 0.5) | chamfer_any
        outside = g.eroded(part_any, KERF_MARGIN_MM) & (~excused) & (H < -OUTSIDE_MM)
    else:
        excused = g.dilated(design_any | label_any, KERF_MARGIN_MM) | chamfer_any
        outside = (~excused) & (H < -OUTSIDE_MM)
    report['outside'] = {'cells': int(outside.sum()), 'areaMm2': round(float(outside.sum()) * res * res, 1), 'deepestMm': round(float(-H[outside].min()) if outside.any() else 0, 3)}
    overlay(os.path.join(run_dir, 'overlay.png'), H, T, items, label_masks, floor_map)
    print(json.dumps(report))


if __name__ == '__main__':
    main()

"""v2 (2026-10-28): each job models the REAL part from its source photo or file, not a stand-in.
Builds job JSONs into jobs/. One file per cutter where the command line needs one (it cannot post a
second cutter yet). QA scratch, not product code."""
import sys, math, os, re, copy
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lib import *
from meshgen import embed
import numpy as np

BOARD = lambda t=6: {"thickness": t, "overhang": {"left": 0, "right": 0, "front": 0, "back": 0}, "attach": "tape"}


def trace(i, x, y, pts, depth, closed=False):
    return {"id": i, "kind": "line", "position": {"x": x, "y": y}, "rotation": 0, "depth": depth, "enabled": True,
            "points": [[round(a, 3), round(b, 3)] for a, b in pts], "closed": closed}


def slot(i, x, y, length, width, depth, rot=0, **kw):
    d = {"id": i, "kind": "slot", "position": {"x": x, "y": y}, "rotation": rot, "depth": depth, "enabled": True,
         "length": length, "width": width}
    d.update(kw); return d


def bore(i, x, y, dia, depth, through=False):
    return drill(i, x, y, depth, through=through, mode='bore', diameter=dia)


def cutaway(i, outer, islands, depth, **kw):
    d = {"id": i, "kind": "cutaway", "position": {"x": 0, "y": 0}, "rotation": 0, "depth": depth, "enabled": True,
         "outer": outer, "islands": islands}
    d.update(kw); return d


def chamfered_rect(w, h, c):
    x, y = w / 2, h / 2
    return [(-x + c, -y), (x - c, -y), (x, -y + c), (x, y - c), (x - c, y), (-x + c, y), (-x, y - c), (-x, -y + c)]


J = {}
NOTES = {}

# ---------------------------------------------------------------------------------------------------
# j01 Makera Top Clamp. Geometry read from Makera's own TopClamp.nc (the Z1's preloaded first job):
# a 65 x 20 mm clamp with ~3 mm corner chamfers at X 8..73, Y 8..28 on a 100 x 100 x 5 plate; a 52 x 6.1
# through slot; a 2 mm rebate 3.5 mm deep on the front and left edges and 1.0 mm deep on the back and
# right edges; cut out through with 3 tabs. Pockets along an edge are widened OUTSIDE the part (that
# waste is cut away) so a 3.175 cutter fits, as any CAM user would draw them.
def topclamp(name, material, tool):
    j = base(name, 100, 100, 5, material, tool, hold='bracket',
             clamps=[{"edge": "back", "at": 85}, {"edge": "right", "at": 85}])
    j['sacrificial']['under'] = BOARD(6)
    cx, cy = 40.5, 18.0
    j['shapes'] = [poly('clamp', cx, cy, chamfered_rect(65, 20, 3), 5, construction=True),
                   slot('m5slot', 40.55, 18.05, 52.1, 6.1, 5, through=True),
                   rect('rebate-front', cx, 8 + 2 - 2.5, 65 + 8, 5, 3.5),     # Y 5..10
                   rect('rebate-left', 8 + 2 - 2.5, cy, 5, 20 + 8, 3.5),      # X 5..10
                   rect('rebate-back', cx, 28 - 2 + 2.5, 65 + 8, 5, 1.0),     # Y 26..31
                   rect('rebate-right', 73 - 2 + 2.5, cy, 5, 20 + 8, 1.0)]    # X 71..76
    j['cutouts'] = [cutout('profile', of='clamp', side='outside', tabs=(3, 3, 0.8))]
    return j
J['j01-topclamp-alu'] = topclamp('j01-topclamp-alu', 'aluminium-6061', 'inv:kz-o-flute-m-3-175-12')
J['j01-topclamp-pla-proxy'] = topclamp('j01-topclamp-pla-proxy', 'pla', 'inv:kz-o-flute-3-175-25')

# ---------------------------------------------------------------------------------------------------
# j02 CNX review: "CNX" over "Software" left RAISED on a plastic plate; the field around the letters is
# milled 1 mm down inside a ~4 mm rim. 3.175 2-flute flat, 2 x 0.5 mm. Plate ~100 x 90, held in the vise.
j = base('j02-raised-cnx', 100, 90, 10, 'pla', 'inv:kz-o-flute-3-175-25', proud=5)
j['shapes'] = [rect('field', 50, 45, 92, 82, 1.0, r=2, construction=True)]
j['combined'] = [cutaway('clear', 'field', ['cnx', 'software'], 1.0)]
j['labels'] = [label('cnx', 'CNX', 50, 56, 24, 1.0, construction=True),
               label('software', 'Software', 50, 27, 14, 1.0, construction=True)]
J[j['name']] = j

# ---------------------------------------------------------------------------------------------------
# j03 CNX review: one line "CNX Software" sunk ~0.5 mm into a square block in the low-profile vise, near
# its front edge, cap height ~8 mm. ~1 mm flat. Block ~90 x 75 x 12.
j = base('j03-vise-text', 90, 75, 12, 'pla', 'inv:kz-corn-1-7', proud=4)
j['labels'] = [label('t1', 'CNX Software', 38, 12, 8, 0.5)]
J[j['name']] = j

# ---------------------------------------------------------------------------------------------------
# j04 CNX review: a ~30 mm aluminium coin with "CNX" over "Software" left RAISED and a raised rim; the
# field inside the rim is milled ~0.4 mm. ~1 mm flat. A round blank cannot be described, so the blank
# is a 32 x 32 square and the coin's edge is not cut.
def coin(name, material, tool):
    j = base(name, 32, 32, 3, material, tool, proud=1.5)
    j['shapes'] = [circle('field', 16, 16, 26, 0.4, construction=True)]
    j['combined'] = [cutaway('clear', 'field', ['cnx', 'software'], 0.4)]
    j['labels'] = [label('cnx', 'CNX', 16, 19.5, 7, 0.4, construction=True),
                   label('software', 'Software', 16, 11.5, 3.6, 0.4, construction=True)]
    return j
J['j04-coin-alu'] = coin('j04-coin-alu', 'aluminium-6061', 'inv:kz-o-flute-m-1-3')
J['j04-coin-pla-proxy'] = coin('j04-coin-pla-proxy', 'pla', 'inv:kz-corn-1-7')

# ---------------------------------------------------------------------------------------------------
# j05 CNX review: red-over-white sheet; "CNX Software" cut through the red cap so the letters read
# WHITE, along the sheet's length. 3.175 flat. Sheet ~150 x 80 x 1.6 (vacuum bed -> tape).
def sign(name, material, tool):
    j = base(name, 190, 80, 1.6, material, tool, hold='tape')
    if material == 'plastic':
        j['stock']['colour'] = {"kind": "laminate", "capMm": 0.2}
    j['labels'] = [label('t1', 'CNX Software', 95, 40, 20, 0.4)]
    return j
J['j05-sign-laminate'] = sign('j05-sign-laminate', 'plastic', 'inv:kz-o-flute-3-175-25')
J['j05-sign-pla-proxy'] = sign('j05-sign-pla-proxy', 'pla', 'inv:kz-o-flute-3-175-25')

# ---------------------------------------------------------------------------------------------------
# j06 CNX review: a wolf-head relief. Input: "Wolf Relief Sculpture Wall Art" by Triple G Workshop
# (printables.com/model/1261158, CC BY-NC-ND 4.0), scaled to 80 mm wide and flattened to 8 mm deep so
# the 2 mm ball reaches it. Plate 100 x 100 x 12 PLA in the vise.
stl = os.path.join(S, 'dl-wolf', 'wolf-80x8.stl')
data, sha, _ = embed(stl)
for tool, suffix in (('inv:kz-ball-nose-2-12', '2mm-ball'), ('inv:kz-ball-nose-1-4', '1mm-ball')):
    j = base('j06-wolf-' + suffix, 100, 100, 12, 'pla', tool, proud=5)
    zdepth = 8 if suffix == '2mm-ball' else 3.5
    if suffix == '1mm-ball':
        # The 1 mm ball has 4 mm of flute: the same relief flattened to 3.5 mm.
        import struct
        b = open(stl, 'rb').read(); n = struct.unpack('<I', b[80:84])[0]
        a = np.frombuffer(b[84:84 + 50 * n], dtype=np.dtype([('n', '<3f4'), ('v', '<9f4'), ('a', '<u2')])).copy()
        v = a['v'].reshape(-1, 3); v[:, 2] *= 3.5 / 8; a['v'] = v.reshape(-1, 9)
        p2 = os.path.join(S, 'dl-wolf', 'wolf-80x3.5.stl')
        open(p2, 'wb').write(b[:84] + a.tobytes())
        d2, s2, _ = embed(p2)
    else:
        d2, s2 = data, sha
    # The model's file lies ears-down, so the goal is turned 180 degrees to stand upright.
    j['targetObject'] = {"id": "g1", "name": "wolf-relief.stl", "format": "stl", "sha256": s2, "data": d2,
                         "size": {"x": 80, "y": 82.457, "z": zdepth}, "position": {"x": 50, "y": 50, "z": 0},
                         "rotation": 180, "enabled": True, "role": "goal"}
    J[j['name']] = j

# ---------------------------------------------------------------------------------------------------
# j07 Makera blog "photo to 3D relief": a portrait photo becomes a ~3 mm relief ~90 mm tall on a
# 100 x 150 x 10 blank, then is cut out with tabs. The blog's own photo is not published, so the input
# is a real public-domain portrait (Alexander Gardner's 1863 photograph of Abraham Lincoln, Wikimedia
# Commons) — the app reads the picture's brightness as height, exactly what an operator would load.
from PIL import Image
png = os.path.join(S, 'dl-photo', 'lincoln-relief.png')
Image.open(os.path.join(S, 'dl-photo', 'lincoln.jpg')).convert('L').resize((360, 464)).save(png)
data, sha, _ = embed(png)
j = base('j07-photo-relief', 100, 150, 10, 'pla', 'inv:kz-ball-nose-2-12', hold='bracket',
         clamps=[{"edge": "back", "at": 50}, {"edge": "right", "at": 140}])
j['targetObject'] = {"id": "g1", "name": "lincoln.png", "format": "png", "sha256": sha, "data": data,
                     "size": {"x": 70, "y": 90, "z": 3}, "position": {"x": 50, "y": 75, "z": 0}, "rotation": 0,
                     "enabled": True, "role": "goal", "relief": {"maxDepthMm": 3}}
J[j['name']] = j
j = base('j07-photo-relief-b-cutout', 100, 150, 10, 'pla', 'inv:kz-o-flute-3-175-25', hold='bracket',
         clamps=[{"edge": "back", "at": 50}, {"edge": "right", "at": 140}])
j['sacrificial']['under'] = BOARD(6)
j['shapes'] = [rect('outline', 50, 75, 80, 104, 10, r=8, construction=True)]
j['cutouts'] = [cutout('profile', of='outline', side='outside', tabs=(4, 4, 1.5))]
J[j['name']] = j

# ---------------------------------------------------------------------------------------------------
# j10 Carbide 3D forum: V-carved oak plaque, a dandelion and "Ruth" (90-degree V). Plaque ~100 x 62.
# The dandelion is drawn from the photo as V-cut strokes (stem, head, 12 seed rays with tufts, 4 seeds
# blowing away); "Ruth" in a regular sans at the lower right.
def dandelion():
    tr = []
    stem = [(28 + 6 * math.sin(t / 10 * math.pi * 0.9) - 4 * t / 10, 14 + 22 * t / 10) for t in range(11)]
    tr.append(trace('stem', 0, 0, stem, 0.7))
    hx, hy = stem[-1][0] + 2, stem[-1][1] + 4
    for k in range(12):
        a = math.radians(30 * k + 15)
        p0 = (hx + 2.5 * math.cos(a), hy + 2.5 * math.sin(a)); p1 = (hx + 10 * math.cos(a), hy + 10 * math.sin(a))
        tr.append(trace('ray%d' % k, 0, 0, [p0, p1], 0.5))
        for da in (-35, 35):
            b = a + math.radians(da)
            tr.append(trace('tuft%d_%d' % (k, da), 0, 0, [p1, (p1[0] + 2.2 * math.cos(b), p1[1] + 2.2 * math.sin(b))], 0.4))
    for k, (sx, sy) in enumerate([(52, 50), (60, 54), (68, 55), (76, 57)]):
        a = math.radians(25)
        p1 = (sx + 5 * math.cos(a), sy + 5 * math.sin(a))
        tr.append(trace('seed%d' % k, 0, 0, [(sx, sy), p1], 0.4))
        for da in (-35, 35):
            b = a + math.radians(da)
            tr.append(trace('stuft%d_%d' % (k, da), 0, 0, [p1, (p1[0] + 2 * math.cos(b), p1[1] + 2 * math.sin(b))], 0.35))
    return tr, (hx, hy)
def plaque(name, tool):
    j = base(name, 100, 62, 19, 'pla', tool, hold='tape')
    tr, (hx, hy) = dandelion()
    j['traces'] = tr
    j['shapes'] = [circle('head', hx, hy, 4.5, 1.5)]
    j['labels'] = [label('ruth', 'Ruth', 80, 10, 7, 0.8, weight='regular')]
    return j
J['j10-plaque-90v'] = plaque('j10-plaque-90v', 'inv:kz-chamfer-90')
J['j10-plaque-30v'] = plaque('j10-plaque-30v', 'inv:kz-engrave-30-0-5')

# ---------------------------------------------------------------------------------------------------
# j11 Carbide 3D forum: V-carve inlay pockets for band logos in a cherry board. Modelled: the round
# logo's female pocket — a ring 60 mm across, 4 mm wide, around "FF" in a serif — at the guide's
# 5.1 mm pocket depth and 1.3 mm glue gap, then the male plug the app derives from it.
def ffinlay(name, tool):
    j = base(name, 80, 80, 12, 'pla', tool, proud=5)
    j['shapes'] = [circle('ring-outer', 40, 40, 60, 5.1, construction=True),
                   circle('ring-inner', 40, 40, 52, 5.1, construction=True)]
    j['combined'] = [cutaway('ring', 'ring-outer', ['ring-inner'], 5.1, inlay={"role": "female", "glueGapMm": 1.3})]
    j['labels'] = [label('ff', 'FF', 40, 40, 22, 5.1, font='serif-default', weight='bold')]
    return j
J['j11-inlay-female-30v'] = ffinlay('j11-inlay-female-30v', 'inv:kz-engrave-30-0-5')
J['j11-inlay-female-90v'] = ffinlay('j11-inlay-female-90v', 'inv:kz-chamfer-90')

# ---------------------------------------------------------------------------------------------------
# j12 patshead.com: an aluminium plate with a 60 mm round pocket 1.5 mm deep around a wrench left
# standing (the author stopped before the round profile, so the part is the pocket stage). 2 mm flat.
def wrench_pts():
    from shapely.geometry import Point, box
    from shapely import affinity
    handle = box(-17, -3.2, 17, 3.2)
    head_l = Point(-20, 0).buffer(8.5, 32); head_r = Point(20, 0).buffer(8.5, 32)
    jaw_l = box(-32, -3.4, -19, 3.4); jaw_r = box(19, -3.4, 32, 3.4)
    jaw_l = affinity.rotate(jaw_l, 25, origin=(-20, 0)); jaw_r = affinity.rotate(jaw_r, 25, origin=(20, 0))
    w = handle.union(head_l).union(head_r).difference(jaw_l).difference(jaw_r)
    w = affinity.rotate(w, -28, origin=(0, 0)).simplify(0.15)
    return [(round(x, 3), round(y, 3)) for x, y in list(w.exterior.coords)[:-1]]
def medal(name, material, tool):
    j = base(name, 150, 75, 6.35, material, tool, proud=3)
    j['shapes'] = [circle('disc', 70, 37.5, 60, 1.5, construction=True),
                   poly('wrench', 70, 37.5, wrench_pts(), 1.5, construction=True)]
    j['combined'] = [cutaway('pocket', 'disc', ['wrench'], 1.5)]
    return j
J['j12-wrench-alu'] = medal('j12-wrench-alu', 'aluminium-6061', 'inv:kz-o-flute-m-2-8')
J['j12-wrench-pla-proxy'] = medal('j12-wrench-pla-proxy', 'pla', 'inv:kz-o-flute-2-12')

# ---------------------------------------------------------------------------------------------------
# j13 Nomad 3 starter tool tray, laid out from the forum photo (0.4186 mm per photo pixel; tray
# 176 x 194 mm): 23 square bit pockets 16 mm on a 22 mm pitch (5 rows of 4 and a row of 3), 9 holes in
# 3 rows (two 6.7 mm and one 3.3 mm), a 67 x 71 mm pocket with a 30 mm round notch, three holes under it,
# two 155 x 5.9 mm slots, then cut out. Bamboo restated as PLA. 3.175 flat.
PX = 0.4
def mm(px, py, m=5):
    return round((px - 210) * PX + m + 2, 2), round((515 - py) * PX + m, 2)
j = base('j13-tool-tray', 186, 200, 19, 'pla', 'inv:kz-o-flute-3-175-25', hold='tape')
j['sacrificial']['under'] = BOARD(6)
shapes = [rect("outline", 93, 100, 172, 190, 19, r=6, construction=True)]
k = 0
for row, py in enumerate((67, 120, 170, 222, 273, 326)):
    for col, px in enumerate((262, 315, 368, 420)):
        if row == 5 and col == 3: continue
        x, y = mm(px, py); shapes.append(rect('bin%d' % k, x, y, 16, 16, 8, r=1.6)); k += 1
bx, by = mm(535, 280)
shapes.append(rect('big', bx, by, 67, 71, 10, r=1.6, construction=True))
nx, ny = mm(470, 350)
shapes.append(circle('notch', nx, ny, 30, 10, construction=True))
j['combined'] = [cutaway('bigpocket', 'big', [], 10)]
shapes.append(circle('notchpocket', nx, ny, 30, 10))
for py, name in ((422, 'slot1'), (475, 'slot2')):
    x, y = mm(425, py); shapes.append(slot(name, x, y, 155, 5.9, 6))
j['shapes'] = shapes
drills = []
for r, py in enumerate((70, 112, 158)):
    for c, (px, d) in enumerate(((492, 6.7), (538, 6.7), (583, 3.3))):
        x, y = mm(px, py); drills.append(bore('h%d%d' % (r, c), x, y, d, 10))
for c, (px, py, d) in enumerate(((400, 378, 11.7), (545, 385, 5.9), (595, 387, 2.9))):
    x, y = mm(px, py); drills.append(bore('lh%d' % c, x, y, d, 10))
# Holes under 3.175 mm cannot be bored by the 3.175 cutter: they go to a second program with the 2 mm
# corn bit (the command line posts one cutter per job).
small = [d for d in drills if d['diameter'] < 3.5]
j['drills'] = [d for d in drills if d['diameter'] >= 3.5]
j['cutouts'] = [cutout('profile', of='outline', side='outside', tabs=(4, 5, 2))]
J[j['name']] = j
j2 = base('j13-tool-tray-b-small-holes', 186, 200, 19, 'pla', 'inv:kz-corn-2-0-10-5', hold='tape')
j2['sacrificial']['under'] = BOARD(6)
j2['drills'] = small
J[j2['name']] = j2

# ---------------------------------------------------------------------------------------------------
# j15 Easel gallery: a clear acrylic Darth Vader keychain — the helmet engraved (filled black in the
# photo), "WHO'S / YOUR / DADDY?" below, a ring loop on top, cut out around helmet + text panel.
# Helmet artwork: OpenMoji "darth-vader" (CC BY-SA 4.0), not the Easel author's file.
def vader_geometry():
    from svgpathtools import parse_path
    from shapely.geometry import Polygon, Point, box
    from shapely.ops import unary_union
    from shapely import affinity
    svg = open(os.path.join(S, 'dl-vader', 'openmoji.svg')).read()
    ds = re.findall(r'<path fill="#3f3f3f" d="([^"]+)"', svg)
    def polys(d):
        out = []
        p = parse_path(d)
        for sub in p.continuous_subpaths():
            pts = [sub.point(t / 200) for t in range(201)]
            pg = Polygon([(c.real, -c.imag) for c in pts]).buffer(0)
            if pg.area > 1: out.append(pg)
        return out
    first = polys(ds[0])
    helmet = max(first, key=lambda g: g.bounds[3] - 0)  # the dome+mask, not the shoulders
    helmet = [g for g in first if g.bounds[1] > -50][0] if len(first) > 1 else first[0]
    face = unary_union(polys(ds[1]) + polys(ds[2]))
    s = 34 / (helmet.bounds[2] - helmet.bounds[0])
    def place(g):
        g = affinity.scale(g, s, s, origin=(0, 0))
        return g
    helmet = place(helmet); face = place(face)
    cx = (helmet.bounds[0] + helmet.bounds[2]) / 2; top = helmet.bounds[3]
    helmet = affinity.translate(helmet, 25 - cx, 70 - top); face = affinity.translate(face, 25 - cx, 70 - top)
    panel = box(8, 6, 42, helmet.bounds[1] + 3).buffer(3)
    loop = Point(25, 72.5).buffer(5.2)
    outline = unary_union([helmet.buffer(2.5), panel, loop]).buffer(3.5).buffer(-3.5)
    hole = Point(25, 72.5).buffer(1.75)
    sh = lambda g: affinity.translate(g, 5, 7)
    return sh(outline), sh(helmet), sh(face), sh(hole)
def keychain(name, material):
    outline, helmet, face, hole = vader_geometry()
    def pts(g):
        g = g.simplify(0.1)
        return [(round(x, 3), round(y, 3)) for x, y in list(g.exterior.coords)[:-1]]
    j = base(name, 60, 95, 3, material, 'inv:kz-o-flute-3-175-25', hold='tape')
    j['sacrificial']['under'] = BOARD(6)
    j['shapes'] = [poly('tag', 0, 0, pts(outline), 3, construction=True)]
    j['drills'] = [bore('ring', 30, 79.5, 5, 3, through=True)]
    j['cutouts'] = [cutout('profile', of='tag', side='outside', tabs=(3, 3, 0.8))]
    e = base(name + '-b-engrave', 60, 95, 3, material, 'inv:kz-engrave-30-0-3', hold='tape')
    e['sacrificial']['under'] = BOARD(6)
    e['shapes'] = [poly('helmet', 0, 0, pts(helmet), 0.4, construction=True)]
    islands = []
    gs = list(face.geoms) if hasattr(face, 'geoms') else [face]
    for k, g in enumerate(gs):
        e['shapes'].append(poly('face%d' % k, 0, 0, pts(g), 0.4, construction=True)); islands.append('face%d' % k)
    e['combined'] = [cutaway('helmet-black', 'helmet', islands, 0.4)]
    y0 = helmet.bounds[1]
    e['labels'] = [label('l1', "WHO'S", 30, y0 - 7, 6, 0.4), label('l2', 'YOUR', 30, y0 - 15.5, 6, 0.4),
                   label('l3', 'DADDY?', 30, y0 - 24, 6, 0.4)]
    return j, e
for mat, nm in (('acrylic', 'j15-vader-acrylic'), ('pla', 'j15-vader-pla-proxy')):
    a, b = keychain(nm, mat); J[a['name']] = a; J[b['name']] = b

# ---------------------------------------------------------------------------------------------------
# Jobs with no part photo: v1's descriptions stand (chamfered plate, 1590B faceplate, M3 threads,
# dog tag) — re-run on today's main.
def plate(name, tool):
    j = base(name, 70, 50, 6, 'pla', tool, hold='tape')
    j['sacrificial']['under'] = BOARD(6)
    j['shapes'] = [rect('part', 35, 25, 50, 30, 6, r=4, construction=True)]
    return j
j = plate('j16-chamfer-a-bevel', 'inv:kz-chamfer-90')
j['chamfers'] = [{"kind": "chamfer", "id": "bevel", "enabled": True, "of": "part", "side": "outside", "width": 1.0}]
J[j['name']] = j
j = plate('j16-chamfer-b-cutout', 'inv:kz-o-flute-3-175-25')
j['cutouts'] = [cutout('profile', of='part', side='outside', tabs=(2, 4, 1))]
J[j['name']] = j

def faceplate(name, material):
    j = base(name, 112, 61, 3, material, 'inv:kz-o-flute-3-175-25' if material == 'pla' else 'inv:kz-o-flute-m-3-175-12',
             hold='bracket', clamps=[{"edge": "back", "at": 100}, {"edge": "right", "at": 50}])
    j['sacrificial']['under'] = BOARD(6)
    j['drills'] = [bore('pot%d' % k, x, 40, 7.2, 3, through=True) for k, x in enumerate((28, 56, 84))] + \
                  [bore('dc', 56, 12, 8.1, 3, through=True)]
    j['shapes'] = [rect('window', 56, 25, 30, 10, 3, r=1.6, through=True)]
    return j
J['j17-faceplate-alu'] = faceplate('j17-faceplate-alu', 'aluminium-6061')
J['j17-faceplate-pla-proxy'] = faceplate('j17-faceplate-pla-proxy', 'pla')

def thread_jobs(material, sfx):
    a = base('j18-thread-a-bore' + sfx, 40, 30, 8, material, 'inv:kz-corn-2-0-10-5', proud=4)
    a['drills'] = [bore('b%d' % k, x, 15, 2.6, 6) for k, x in enumerate((12, 28))]
    b = base('j18-thread-b-mill' + sfx, 40, 30, 8, material, 'inv:kz-thread-m3-9', proud=4)
    b['threads'] = [{"kind": "thread", "id": "t%d" % k, "position": {"x": x, "y": 15}, "enabled": True, "size": "M3",
                     "standard": "metric", "classFit": "6H", "depth": 5, "through": False} for k, x in enumerate((12, 28))]
    return a, b
for jj in thread_jobs('aluminium-6061', '-alu') + thread_jobs('pla', '-pla-proxy'):
    J[jj['name']] = jj

j = base('j14-dog-tag-alu', 51, 28, 1, 'aluminium-6061', 'inv:kz-engrave-m-60-0-1', hold='tape')
j['minFloor'] = 0.5
j['labels'] = [label('t1', 'REX', 25.5, 18, 7, 0.1), label('t2', '555-0100', 25.5, 8, 4.5, 0.1)]
J[j['name']] = j

if __name__ == '__main__':
    os.makedirs(os.path.join(S, 'jobs'), exist_ok=True)
    only = sys.argv[1:]
    for n, j in J.items():
        if not only or n in only:
            j['name'] = n
            write(j)
    print(' '.join(J.keys()))

# j07 second attempt with the 1 mm ball (4 mm of flute reaches a 3 mm relief).
_j = copy.deepcopy(J['j07-photo-relief']); _j['name'] = 'j07-photo-relief-1mm-ball'; _j['toolKey'] = 'inv:kz-ball-nose-1-4'
J[_j['name']] = _j
if __name__ == '__main__':
    write(_j)

"""Second demo set (2026-10-28): jobs built from REAL inputs where the source publishes them (CutRocket
.c2d design files, a Makerables artwork PNG traced by the app's own raster importer) and from the
source's stated dimensions or a measured photo otherwise. Writes job JSONs into jobs/. QA scratch."""
import sys, os, json, math, copy, subprocess
HERE = os.path.dirname(os.path.abspath(__file__)); R = os.path.dirname(HERE)
sys.path.insert(0, HERE)
from c2dgeom import load, element_polys, bbox, area
V2 = os.path.join(os.path.dirname(R), 'real')
sys.path.insert(0, V2)
from lib import base, setup, label, rect, circle, poly, drill, cutout, NO_SAC

BOARD = lambda t=3: {"thickness": t, "overhang": {"left": 0, "right": 0, "front": 0, "back": 0}, "attach": "tape"}
CLONE = os.path.expanduser('~/projects/CaseMaker-bench/casemaker-app')
J, NOTES = {}, {}

def bore(i, x, y, dia, depth, through=False):
    return drill(i, x, y, depth, through=through, mode='bore', diameter=dia)

def vector(i, rings, depth, name=None, **kw):
    """An imported-outline item from absolute rings (mm): position at the bbox centre, rings relative."""
    x0, y0, x1, y1 = bbox(rings)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    d = {"id": i, "kind": "vector", "position": {"x": round(cx, 3), "y": round(cy, 3)}, "rotation": 0,
         "depth": depth, "enabled": True, "sourceName": name or i,
         "contours": [[[round(x - cx, 3), round(y - cy, 3)] for x, y in r] for r in rings],
         "fillRule": "NonZero", "width": round(x1 - x0, 3), "height": round(y1 - y0, 3)}
    d.update(kw); return d

def trace_line(i, pts, depth, closed=False):
    x0 = min(p[0] for p in pts); y0 = min(p[1] for p in pts); x1 = max(p[0] for p in pts); y1 = max(p[1] for p in pts)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return {"id": i, "kind": "line", "position": {"x": round(cx, 3), "y": round(cy, 3)}, "rotation": 0, "depth": depth,
            "enabled": True, "points": [[round(x - cx, 3), round(y - cy, 3)] for x, y in pts], "closed": closed}

def cutaway(i, outer, islands, depth, **kw):
    d = {"id": i, "kind": "cutaway", "position": {"x": 0, "y": 0}, "rotation": 0, "depth": depth, "enabled": True,
         "outer": outer, "islands": islands}
    d.update(kw); return d

def ccw(r):
    return r if area(r) > 0 else list(reversed(r))

def app_outline(path, *args):
    out = subprocess.run(['npx', 'tsx', '--tsconfig', 'tsconfig.scripts.json', 'scripts/bench-import-outline.mts', path, *map(str, args)],
                         cwd=CLONE, capture_output=True, text=True)
    return json.loads(out.stdout)

def ids(j):
    out = []
    for k in ('labels', 'shapes', 'vectors', 'traces', 'drills', 'combined', 'cutouts', 'chamfers'):
        out += [x['id'] for x in j.get(k, []) if not x.get('construction')]
    return out

O_NM, O_M = 'inv:kz-o-flute-3-175-25', 'inv:kz-o-flute-m-3-175-12'
F15M, F1M, CORN1, CORN06 = 'inv:kz-o-flute-m-1-5-6', 'inv:kz-o-flute-m-1-3', 'inv:kz-corn-1-7', 'inv:kz-corn-0-6-3'
ENG_M02, ENG30_05, CHAMF = 'inv:kz-engrave-m-30-0-2', 'inv:kz-engrave-30-0-5', 'inv:kz-chamfer-90'

# --------------------------------------------------------------------------------------------------
# j19 CNC Accuracy Test Sample (Makerables, Molodos, made for the Z1). Stated: 40 x 70 x 4 mm part from a
# 5 mm aluminium plate at least 86 x 56; >= 1 mm waste board under it; walls 3/2/1.5/1 mm; extruded text;
# floors 0.2..1.2 mm; holes 2/3/4/5 mm; an angled slide 0.2 mm from top to 0.2 mm from bottom; an engraved
# logo; four tools. Placement measured off the maker's annotated photo (5.1 px/mm).
def accuracy():
    T = 4.0
    j = base('j19-accuracy-sample', 86, 56, 5, 'aluminium-6061', O_M, hold='bracket',
             clamps=[{"edge": "back", "at": 70}, {"edge": "right", "at": 40}])
    j['sacrificial']['under'] = BOARD(2)
    ox, oy = 8, 8
    P = lambda x, y: (ox + x, oy + y)
    sh, vec, tr, dr, lab, comb = [], [], [], [], [], []
    # the part, its top 1 mm skimmed off the 5 mm plate (a pocket over the whole part, then the outline cut)
    sh.append(rect('part', ox + 35, oy + 20, 70, 40, 5, r=3, construction=True))
    sh.append(rect('skim', 43, 28, 78, 48, 1.0))  # 5 mm plate -> 4 mm part, skimmed over the part and its cut-out path
    D = lambda d: 1.0 + d                          # depths below the PART's top
    # keyring hole: a through triangle at top-left
    vec.append(vector('keyring', [ccw([P(3, 31), P(12.5, 37.5), P(3, 37.5)])], 5, through=True))
    # thin walls: four slanted through slots, walls 3 / 2 / 1.5 / 1 mm between them
    x = 14.0
    for k, wall in enumerate([3, 2, 1.5, None]):
        vec.append(vector(f'slot{k+1}', [ccw([P(x, 31), P(x + 4.5, 31), P(x + 7.5, 37.5), P(x + 3, 37.5)])], 5, through=True))
        if wall: x += 4.5 + wall
    # extruded text: a 0.6 mm pocket around raised "CNC"
    sh.append(rect('textbox', ox + 55, oy + 34.25, 24, 6.5, D(0.6), r=0.8, construction=True))
    lab.append(label('cnc-raised', 'CNC', ox + 55, oy + 34.25, 4.2, D(0.6), construction=True))
    comb.append(cutaway('textfield', 'textbox', ['cnc-raised'], D(0.6)))
    # floor-thickness hexagon: six triangular pockets leaving 0.2 .. 1.2 mm, a hexagonal through hole in the middle
    cx, cy, R6 = ox + 12.5, oy + 16, 9.5
    V = [(cx + R6 * math.cos(math.radians(30 + 60 * k)), cy + R6 * math.sin(math.radians(30 + 60 * k))) for k in range(6)]
    for k, floor in enumerate([0.2, 0.4, 0.6, 0.8, 1.0, 1.2]):
        a, b = V[k], V[(k + 1) % 6]
        tri = [(cx, cy), a, b]
        gx, gy = sum(p[0] for p in tri) / 3, sum(p[1] for p in tri) / 3
        tri = [(gx + (p[0] - gx) * 0.78, gy + (p[1] - gy) * 0.78) for p in tri]
        vec.append(vector(f'floor{floor}', [ccw(tri)], D(T - floor)))
    vec.append(vector('hexhole', [ccw([(cx + 2.2 * math.cos(math.radians(30 + 60 * k)), cy + 2.2 * math.sin(math.radians(30 + 60 * k))) for k in range(6)])], 5, through=True))
    # round holes 2 / 3 / 4 / 5 mm, through
    for dia, y in [(2, 24), (3, 18.8), (4, 11.7), (5, 6.1)]:
        dr.append(bore(f'hole{dia}', ox + 28.5, oy + y, dia, 5, through=True))
    # angled slide: no sloped-floor operation exists, so a flat pocket at the slide's mid depth stands in
    sh.append(rect('slide', ox + 37, oy + 13.7, 5, 24.3, D(2.0), r=0.8))
    # engraved logo: a rounded-square groove and "CNC" engraved 0.3 mm
    tr.append(trace_line('logo-frame', [P(44, 2), P(66.5, 2), P(66.5, 28.5), P(44, 28.5)], D(0.3), closed=True))
    lab.append(label('logo', 'CNC', ox + 55.25, oy + 15.25, 9, D(0.3)))
    j['shapes'], j['vectors'], j['traces'], j['drills'], j['labels'], j['combined'] = sh, vec, tr, dr, lab, comb
    j['cutouts'] = [cutout('outline', of='part', side='outside', tabs=(4, 3, 0.8))]
    big = ['skim', 'outline']
    small = [i for i in ids(j) if i not in big + ['logo', 'logo-frame']]
    j['setups'] = [setup(big + small + ['logo', 'logo-frame'], [O_M, F15M, ENG_M02], mount='bracket', board=True,
                         tool_items={O_M: big, F15M: small, ENG_M02: ['logo', 'logo-frame']})]
    return j
J['j19-accuracy-sample'] = accuracy()
NOTES['j19-accuracy-sample'] = ("Placement measured off the maker's annotated photo; the stated sizes (40 x 70 x 4 part, walls 3/2/1.5/1, "
    "floors 0.2..1.2, holes 2..5) are the source's. The angled slide is a flat 2 mm pocket here: there is no sloped-floor operation.")

# --------------------------------------------------------------------------------------------------
# j20 Personalized spoon rest (CutRocket, Carbide Create file). Hex 152.4 x 152.4 x 21.3 hardwood; the
# file's 3D component pockets the inside path and leaves the letter raised; the photo's letter is "M".
def spoonrest():
    pr, els, tps = load(os.path.join(R, 'x/4htqf68iz0lle/items.json'))
    seen, hexr, pocket, notch = set(), None, None, None
    for e in els.values():
        ps = element_polys(e)
        if not ps: continue
        key = tuple(round(v, 1) for v in bbox(ps))
        if key in seen: continue
        seen.add(key)
        if e['geometryType'] == 'regular_polygon': hexr = ps
        elif e['geometryType'] == 'path' and abs(area(ps[0])) > 5000: pocket = ps
        elif e['geometryType'] == 'path': notch = ps
    j = base('j20-spoon-rest', 152.4, 152.4, 21.3, 'hardwood', O_NM, hold='bracket',
             clamps=[{"edge": "back", "at": 76}, {"edge": "right", "at": 76}])
    j['sacrificial']['under'] = BOARD(3)
    j['vectors'] = [vector('hex', [ccw(r) for r in hexr], 21.3, construction=True),
                    vector('rest', [ccw(r) for r in pocket], 6.0, construction=True),
                    vector('notch', [ccw(r) for r in notch], 6.0)]
    x0, y0, x1, y1 = bbox(pocket)
    j['labels'] = [label('M', 'M', (x0 + x1) / 2, (y0 + y1) / 2, 48, 6.0, weight='regular', font='serif-default', construction=True)]
    j['combined'] = [cutaway('rest-clear', 'rest', ['M'], 6.0)]
    j['cutouts'] = [cutout('profile', of='hex', side='outside', tabs=(4, 12, 3))]
    return j
J['j20-spoon-rest'] = spoonrest()
NOTES['j20-spoon-rest'] = ("Outline, rest pocket and handle notch from the maker's own Carbide Create file. The file pockets with a "
    "3D component (a sloped floor this run cannot read); here the rest is a flat 6 mm pocket around a raised serif M.")

# --------------------------------------------------------------------------------------------------
# j21 Coaster with epoxy inlay (CutRocket file; the first of its seven coasters). Hardwood 22.8 thick:
# a ⌀93 pocket 10 mm deep, the initial and the script V-carved 4 mm into its floor, a 45° chamfer on the
# pocket rim (2.5 deep) and on the outside (2 deep), cut out at ⌀107 with tabs.
def coaster():
    pr, els, tps = load(os.path.join(R, 'x/qljwa0rs3485g/items.json'))
    by = {t['name']: t for t in tps}
    pick = lambda tp: [element_polys(els[e['uuid']]) for e in by[tp]['elements'] if e['uuid'] in els]
    first = lambda tp: [ps for ps in pick(tp) if ps and bbox(ps)[2] < 130]
    pocket = first('Pocket cut')[0]; outline = first('final cutout')[0]
    carve = [r for ps in first('Edmonds carve') for r in ps if abs(area(r)) > 1.0]
    initial = [r for r in carve if abs(area(r)) > 500]
    script = [r for r in carve if abs(area(r)) <= 500]
    j = base('j21-coaster-inlay', 146, 134, 22.8, 'hardwood', O_NM, hold='bracket',
             clamps=[{"edge": "back", "at": 73}, {"edge": "right", "at": 67}])
    j['sacrificial']['under'] = BOARD(3)
    j['vectors'] = [vector('pocket', [ccw(r) for r in pocket], 10.0),
                    vector('outline', [ccw(r) for r in outline], 22.8, construction=True),
                    vector('initial', initial, 14.0, vCarveDepth='variable'),
                    vector('script', script, 14.0, vCarveDepth='variable')]
    j['chamfers'] = [{"kind": "chamfer", "id": "rim-chamfer", "enabled": True, "of": "pocket", "side": "inside", "width": 2.5},
                     {"kind": "chamfer", "id": "edge-chamfer", "enabled": True, "of": "outline", "side": "outside", "width": 2.0}]
    j['cutouts'] = [cutout('cut', of='outline', side='outside', tabs=(0, 12, 3))]   # tabs on a circle: #736
    j['setups'] = [setup(['pocket', 'initial', 'script', 'rim-chamfer', 'edge-chamfer', 'cut'], [O_NM, ENG30_05, CHAMF],
                         mount='bracket', board=True,
                         tool_items={O_NM: ['pocket', 'cut'], ENG30_05: ['initial', 'script'], CHAMF: ['rim-chamfer', 'edge-chamfer']})]
    return j
J['j21-coaster-inlay'] = coaster()
NOTES['j21-coaster-inlay'] = ("Geometry and depths from the maker's file (the first of seven coasters on a 1225 mm board, "
    "re-staged on a 146 x 134 blank). The maker cut with a 1/4\" end mill, a 1/2\" 45° chamfer bit and a 30° V-bit; "
    "this run uses the house 3.175 O-flute, 3.175 90° chamfer and 30° 0.5 engraver.")

# --------------------------------------------------------------------------------------------------
# j22 Square snack tray (Makerables, MakeHaven, CC0). From the photo: about 140 x 140 x 18 beech, two square
# compartments over one wide one, about 12 deep with large corner radii; cut out with rounded corners.
def tray():
    j = base('j22-snack-tray', 150, 150, 18, 'hardwood', O_NM, hold='bracket',
             clamps=[{"edge": "back", "at": 75}, {"edge": "right", "at": 75}])
    j['sacrificial']['under'] = BOARD(3)
    j['shapes'] = [rect('part', 75, 75, 140, 140, 18, r=10, construction=True),
                   rect('left', 41.5, 103, 57, 54, 12, r=9), rect('right', 108.5, 103, 57, 54, 12, r=9),
                   rect('bottom', 75, 41, 124, 52, 12, r=9)]
    j['cutouts'] = [cutout('profile', of='part', side='outside', tabs=(4, 10, 3))]
    return j
J['j22-snack-tray'] = tray()
NOTES['j22-snack-tray'] = "Sizes estimated from the maker's photo; the rounded compartment floors are flat pockets here."

# --------------------------------------------------------------------------------------------------
# j23 Blue Shell warning sign (Makerables): two-colour laminate, yellow cap over black. The maker's own
# artwork PNG is traced through the app's raster importer: its black lines are milled through the cap, the
# whole sign is cut out with tabs. About 110 mm across corners (scaled against the machine in the photo).
def shell():
    W = 110.0
    ink = app_outline(os.path.join(R, 'trace/bs_ink.rgba'), '900x900', W)['outline']
    body = app_outline(os.path.join(R, 'trace/bs_body.rgba'), '900x900', W)['outline']
    j = base('j23-shell-sign', 130, 130, 1.6, 'plastic', ENG30_05, hold='tape')
    j['stock']['colour'] = {"kind": "laminate", "capMm": 0.2}
    j['sacrificial']['under'] = BOARD(3)
    j['workholding']['tape']['onBoard'] = True
    cx = cy = 65
    def place(o, i, depth, **kw):
        d = {"id": i, "kind": "vector", "position": {"x": cx, "y": cy}, "rotation": 0, "depth": depth, "enabled": True,
             "sourceName": 'blue_shell_sign.png', "contours": o['contours'], "fillRule": o.get('fillRule', 'NonZero'),
             "width": o['width'], "height": o['height']}
        d.update(kw); return d
    # the outline is the OUTER ring of the body trace only
    outer = max(body['contours'], key=lambda r: abs(area([tuple(p) for p in r])))
    body1 = dict(body, contours=[outer])
    j['vectors'] = [place(ink, 'lines', 0.35), place(body1, 'sign', 1.6, construction=True)]
    j['cutouts'] = [cutout('cut', of='sign', side='outside', tabs=(4, 3, 0.6))]
    j['setups'] = [setup(['lines', 'cut'], [ENG30_05, O_NM], mount='tape', board=True,
                         tool_items={ENG30_05: ['lines'], O_NM: ['cut']})]
    return j
J['j23-shell-sign'] = shell()
NOTES['j23-shell-sign'] = ("The maker's artwork PNG traced by the app's own raster importer (threshold 128). The laminate's cap "
    "thickness (0.2 mm) and the sign's size (110 mm across) are assumed.")

# --------------------------------------------------------------------------------------------------
# j24 Bicycle spoke wrench (Makerables, CC0): an aluminium puck cut from plate. From the photos: about ⌀44 x
# 12, a ⌀34 recess 4 deep inside a 5 mm rim, a ⌀14 centre hole, four notches through the rim for the
# 13G/14G/15G/16G nipple flats, each size engraved on the recess floor beside its notch.
def spoke():
    j = base('j24-spoke-wrench', 60, 60, 10, 'aluminium-6061', O_M, hold='bracket',
             clamps=[{"edge": "back", "at": 30}, {"edge": "right", "at": 30}])
    j['sacrificial']['under'] = BOARD(2)
    c = 30
    j['shapes'] = [circle('puck', c, c, 44, 10, construction=True), circle('recess', c, c, 34, 4)]
    j['drills'] = [bore('centre', c, c, 14, 10, through=True)]
    labs, notches = [], []
    for k, (g, w) in enumerate([('13G', 3.9), ('14G', 3.4), ('15G', 3.2), ('16G', 3.0)]):
        a = math.radians(90 * k)
        ux, uy = math.cos(a), math.sin(a)
        mx, my = c + 19.5 * ux, c + 19.5 * uy   # mid-rim
        px, py = -uy, ux
        L = 7
        q = [(mx - ux * L / 2 - px * w / 2, my - uy * L / 2 - py * w / 2), (mx + ux * L / 2 - px * w / 2, my + uy * L / 2 - py * w / 2),
             (mx + ux * L / 2 + px * w / 2, my + uy * L / 2 + py * w / 2), (mx - ux * L / 2 + px * w / 2, my - uy * L / 2 + py * w / 2)]
        notches.append(vector(f'notch-{g}', [ccw(q)], 4.0))
        lx, ly = c + 11.5 * math.cos(a + math.radians(28)), c + 11.5 * math.sin(a + math.radians(28))
        labs.append(label(f'lab-{g}', g, lx, ly, 2.6, 4.25, rot=math.degrees(a + math.radians(28)) - 90))
    j['vectors'], j['labels'] = notches, labs
    j['cutouts'] = [cutout('puck-out', of='puck', side='outside', tabs=(0, 3, 0.8))]   # tabs on a circle: #736
    big = ['recess', 'centre', 'puck-out']; small = [n['id'] for n in notches]; eng = [l['id'] for l in labs]
    j['setups'] = [setup(big + small + eng, [O_M, F15M, ENG_M02], mount='bracket', board=True,
                         tool_items={O_M: big, F15M: small, ENG_M02: eng})]
    return j
J['j24-spoke-wrench'] = spoke()
NOTES['j24-spoke-wrench'] = ("Sizes estimated from the maker's photos; the notch widths are typical nipple flats "
    "(13G 3.9, 14G 3.4, 15G 3.2, 16G 3.0 mm), not the maker's numbers.")

# --------------------------------------------------------------------------------------------------
# j25 Disc-brake truing wrench (Makerables, CC0): a flat aluminium bar, about 150 x 22 x 4, a ⌀8 hanging
# hole, a rotor slot 1.9 wide in the fork end, and three engraved grooves along the handle (from the photos).
def truing():
    j = base('j25-truing-wrench', 170, 40, 4, 'aluminium-6061', O_M, hold='bracket',
             clamps=[{"edge": "back", "at": 85}, {"edge": "right", "at": 20}])
    j['sacrificial']['under'] = BOARD(2)
    y = 20
    outline = [(10, y - 7), (120, y - 9), (158, y - 11), (161, y), (158, y + 11), (120, y + 9), (10, y + 7), (6, y)]
    j['vectors'] = [vector('bar', [ccw(outline)], 4, construction=True),
                    vector('rotor-slot', [ccw([(140, y - 0.95), (162, y - 0.95), (162, y + 0.95), (140, y + 0.95)])], 4, through=True)]
    j['drills'] = [bore('hang', 16, y, 8, 4, through=True)]
    j['traces'] = [trace_line(f'groove{k}', [(26, y + o), (128, y + o * 1.2)], 0.3) for k, o in enumerate([-3.5, 0, 3.5])]
    j['cutouts'] = [cutout('bar-out', of='bar', side='outside', tabs=(4, 3, 0.8))]
    big = ['hang', 'bar-out']; small = ['rotor-slot']; eng = [t['id'] for t in j['traces']]
    j['setups'] = [setup(big + small + eng, [O_M, F15M, ENG_M02], mount='bracket', board=True,
                         tool_items={O_M: big, F15M: small, ENG_M02: eng})]
    return j
J['j25-truing-wrench'] = truing()
NOTES['j25-truing-wrench'] = "Shape and sizes estimated from the maker's photos; the slot width is a typical 1.9 mm rotor gap."

def split(j):
    """One job per cutter, in the setup's cut order: the workaround for a multi-cutter setup whose later
    cutter is handed through items (see the run notes). Construction items are kept wherever named."""
    st = j['setups'][0]; out = []; last = None
    for n, tool in enumerate(st['tools']):
        keep = set(st['toolItems'][tool])
        k = copy.deepcopy(j); k.pop('setups'); k['toolKey'] = tool
        k['name'] = f"{j['name']}-{chr(97 + n)}"
        for key in ('labels', 'shapes', 'vectors', 'traces', 'drills', 'combined', 'cutouts', 'chamfers'):
            if key in k:
                k[key] = [x for x in k[key] if x.get('construction') or x['id'] in keep
                          or (key in ('labels',) and any(c.get('islands') and x['id'] in c['islands'] and c['id'] in keep for c in j.get('combined', [])))
                          or (key in ('shapes', 'vectors') and any(c.get('outer') == x['id'] and c['id'] in keep for c in j.get('combined', [])))]
        refs = {c.get('of') for c in k.get('chamfers', [])}
        for key in ('vectors', 'shapes'):
            for x in j.get(key, []):
                if x['id'] in refs and x['id'] not in [y['id'] for y in k.get(key, [])]:
                    y = copy.deepcopy(x); y['construction'] = True; k.setdefault(key, []).append(y)
        cut = [x for x in k.get('cutouts', []) if x['id'] in keep]
        if cut:   # the release cut goes last, as its own program
            k['cutouts'] = [x for x in k['cutouts'] if x not in cut]
            z = copy.deepcopy(j); z.pop('setups'); z['toolKey'] = tool; z['name'] = f"{j['name']}-z"
            for key in ('labels', 'shapes', 'vectors', 'traces', 'drills', 'combined', 'chamfers'):
                if key in z: z[key] = [x for x in z[key] if x.get('construction')]
            z['cutouts'] = cut
            last = z
        out.append(k)
    return out + ([last] if last else [])

J['j19-accuracy-sample']['minFloor'] = 0.2   # the floor test leaves 0.2 .. 1.2 mm on purpose

if __name__ == '__main__':
    os.makedirs(os.path.join(R, 'jobs'), exist_ok=True)
    for k, j in J.items():
        json.dump(j, open(os.path.join(R, 'jobs', k + '.json'), 'w'), indent=1)
        print('wrote', k)
        if j.get('setups') and len(j['setups'][0]['tools']) > 1:
            for part in split(j):
                json.dump(part, open(os.path.join(R, 'jobs', part['name'] + '.json'), 'w'), indent=1)
                print('  split', part['name'], part['toolKey'])
    json.dump(NOTES, open(os.path.join(R, 'jobs', '_notes.json'), 'w'), indent=1)

"""Two-colour name-badge blank with a magnet pocket, for a Prusa XL multi-tool.

Writes <name>.3mf (one object, two parts, each pre-assigned to an extruder in
PrusaSlicer) plus one STL per part. The back face sits on the bed and carries the
magnet pocket; the colour change happens at --split, so the pocket and its roof
are in the bottom colour and the front face is the top colour.

Dimensions are used exactly as given - the user's magnet sizes already include
clearance. Badge sizes are in inches, everything else in mm.

  python3 make_badge.py --out DIR [--width 3 --height 1.5 --thick 0.15]
      [--radius 0.125] [--magnet 45 13 2.3] [--split 3.0] [--ext 2 3] [--name badge-blank]
  --magnet 0 0 0 gives no pocket.
"""
import math, struct, zipfile, os, argparse
IN = 25.4
ap = argparse.ArgumentParser()
ap.add_argument('--out', required=True)
ap.add_argument('--name', default='badge-blank')
ap.add_argument('--width', type=float, default=3.0, help='inches')
ap.add_argument('--height', type=float, default=1.5, help='inches')
ap.add_argument('--thick', type=float, default=0.15, help='inches')
ap.add_argument('--radius', type=float, default=0.125, help='corner radius, inches')
ap.add_argument('--magnet', type=float, nargs=3, default=[45.0, 13.0, 2.3], help='pocket L W D, mm')
ap.add_argument('--split', type=float, default=3.0, help='colour change height, mm')
ap.add_argument('--ext', type=int, nargs=2, default=[2, 3], help='bottom/top extruder')
A = ap.parse_args()
W, H, T, R = A.width*IN, A.height*IN, A.thick*IN, A.radius*IN
PW, PH, PD = A.magnet
SPLIT = A.split
SEG = 16                # segments per corner
BED = (180.0, 180.0)    # Prusa XL bed centre
assert PD < SPLIT < T, f'need pocket depth {PD} < split {SPLIT} < thickness {T:.3f} mm'
assert PW < W - 2 and PH < H - 2, 'pocket too big for badge'

def outline():
    pts = []
    cx, cy = W/2 - R, H/2 - R
    for (sx, sy, a0) in [(1,1,0),(-1,1,90),(-1,-1,180),(1,-1,270)]:
        for i in range(SEG+1):
            a = math.radians(a0 + 90*i/SEG)
            pts.append((sx*cx + R*math.cos(a), sy*cy + R*math.sin(a)))
    return pts  # CCW

def slab(z0, z1):
    p = outline(); n = len(p)
    v = [(x, y, z0) for x, y in p] + [(x, y, z1) for x, y in p] + [(0,0,z0), (0,0,z1)]
    cb, ct = 2*n, 2*n+1
    t = []
    for i in range(n):
        j = (i+1) % n
        t += [(cb, j, i), (ct, n+i, n+j)]          # bottom (down), top (up)
        t += [(i, j, n+j), (i, n+j, n+i)]          # side (outward, CCW outline)
    return v, t

def ray(poly, ang):
    dx, dy = math.cos(ang), math.sin(ang); best = None
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i], poly[(i+1) % len(poly)]
        ex, ey = x2-x1, y2-y1; den = dx*ey - dy*ex
        if abs(den) < 1e-12: continue
        t = (x1*ey - y1*ex)/den; u = (x1*dy - y1*dx)/den
        if t > 0 and -1e-9 <= u <= 1+1e-9 and (best is None or t < best): best = t
    return (best*dx, best*dy)

def pocket_slab(z1):
    # back face z=0 with a PW x PH pocket PD deep, solid up to z1
    outer = outline()
    rect = [(PW/2, PH/2), (-PW/2, PH/2), (-PW/2, -PH/2), (PW/2, -PH/2)]
    angs = sorted({round(math.atan2(y, x) % (2*math.pi), 12) for x, y in outer + rect})
    O = [ray(outer, a) for a in angs]; I = [ray(rect, a) for a in angs]; n = len(angs)
    v = ([(x, y, 0) for x, y in O] + [(x, y, z1) for x, y in O] +
         [(x, y, 0) for x, y in I] + [(x, y, PD) for x, y in I] + [(0, 0, z1), (0, 0, PD)])
    o0, o1, i0, i1, ct, cp = 0, n, 2*n, 3*n, 4*n, 4*n+1
    t = []
    for a in range(n):
        b = (a+1) % n
        t += [(o0+a, i0+a, i0+b), (o0+a, i0+b, o0+b)]        # back face annulus (down)
        t += [(o0+a, o0+b, o1+b), (o0+a, o1+b, o1+a)]        # outer wall
        t += [(i0+a, i1+b, i0+b), (i0+a, i1+a, i1+b)]        # pocket wall (faces into pocket)
        t += [(cp, i1+b, i1+a)]                              # pocket ceiling (down)
        t += [(ct, o1+a, o1+b)]                              # top (up)
    return v, t

def stl(path, v, t):
    with open(path, 'wb') as f:
        f.write(b'\0'*80 + struct.pack('<I', len(t)))
        for a, b, c in t:
            A, B, C = v[a], v[b], v[c]
            u = [B[k]-A[k] for k in range(3)]; w = [C[k]-A[k] for k in range(3)]
            nx, ny, nz = u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]
            L = math.sqrt(nx*nx+ny*ny+nz*nz) or 1
            f.write(struct.pack('<12fH', nx/L, ny/L, nz/L, *A, *B, *C, 0))

out = A.out; os.makedirs(out, exist_ok=True)
E2, E3 = A.ext
bottom = pocket_slab(SPLIT) if PD > 0 else slab(0, SPLIT)
parts = [(f'T{E2} bottom', E2, *bottom), (f'T{E3} top', E3, *slab(SPLIT, T))]
stl(f'{out}/{A.name}-T{E2}-bottom.stl', parts[0][2], parts[0][3])
stl(f'{out}/{A.name}-T{E3}-top.stl', parts[1][2], parts[1][3])

verts, tris, vols = [], [], []
for name, ext, v, t in parts:
    off, first = len(verts), len(tris)
    verts += v; tris += [(a+off, b+off, c+off) for a, b, c in t]
    vols.append((name, ext, first, len(tris)-1))

model = ['<?xml version="1.0" encoding="UTF-8"?>',
 '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" '
 'xmlns:slic3rpe="http://schemas.slic3r.org/3mf/2017/06">',
 ' <metadata name="slic3rpe:Version3mf">1</metadata>',
 ' <resources>', '  <object id="1" type="model">', '   <mesh>', '    <vertices>']
model += [f'     <vertex x="{x:.5f}" y="{y:.5f}" z="{z:.5f}"/>' for x, y, z in verts]
model += ['    </vertices>', '    <triangles>']
model += [f'     <triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in tris]
model += ['    </triangles>', '   </mesh>', '  </object>', ' </resources>',
 f' <build>', f'  <item objectid="1" transform="1 0 0 0 1 0 0 0 1 {BED[0]} {BED[1]} 0" printable="1"/>',
 ' </build>', '</model>']

cfg = ['<?xml version="1.0" encoding="UTF-8"?>', '<config>', ' <object id="1" instances_count="1">',
 f'  <metadata type="object" key="name" value="{A.name}"/>',
 f'  <metadata type="object" key="extruder" value="{E2}"/>']
for name, ext, a, b in vols:
    cfg += [f'  <volume firstid="{a}" lastid="{b}">',
            f'   <metadata type="volume" key="name" value="{name}"/>',
            '   <metadata type="volume" key="volume_type" value="ModelPart"/>',
            '   <metadata type="volume" key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
            f'   <metadata type="volume" key="extruder" value="{ext}"/>',
            '  </volume>']
cfg += [' </object>', '</config>']

ct = ('<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
rels = ('<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/3dmodel"/></Relationships>')
with zipfile.ZipFile(f'{out}/{A.name}-T{E2}-T{E3}.3mf', 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', ct); z.writestr('_rels/.rels', rels)
    z.writestr('3D/3dmodel.model', '\n'.join(model))
    z.writestr('Metadata/Slic3r_PE_model.config', '\n'.join(cfg))
print(f'{A.name}: pocket {PW} x {PH} x {PD} mm; {W:.2f} x {H:.2f} x {T:.3f} mm, split at z={SPLIT:.3f} mm, {len(tris)} tris')

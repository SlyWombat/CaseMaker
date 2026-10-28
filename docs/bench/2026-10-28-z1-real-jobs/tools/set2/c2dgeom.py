"""Turn Carbide Create .c2d elements (from c2d.py's items.json) into polygons in mm.
A path's segment i (p[i-1] -> p[i]) is a cubic when point_type[i] == 3, with controls cp1[i], cp2[i];
otherwise a line. Regular polygons and circles are generated from their centre/radius."""
import json, math

def cubic(p0, c1, c2, p1, n=12):
    out = []
    for k in range(1, n + 1):
        t = k / n; u = 1 - t
        out.append((u**3*p0[0] + 3*u*u*t*c1[0] + 3*u*t*t*c2[0] + t**3*p1[0],
                    u**3*p0[1] + 3*u*u*t*c1[1] + 3*u*t*t*c2[1] + t**3*p1[1]))
    return out

def element_polys(d):
    g = d.get('geometryType')
    if g in ('path', 'regular_polygon', 'rectangle', 'circle') and d.get('points'):
        P, T = d['points'], d.get('point_type', [])
        c1s, c2s = d.get('cp1', P), d.get('cp2', P)
        polys, cur = [], []
        off = d.get('position') or [0, 0]
        if g == 'regular_polygon' and d.get('center'):
            off = d['center']
        for i, p in enumerate(P):
            t = T[i] if i < len(T) else 1
            if t == 0 or i == 0:
                if len(cur) > 2: polys.append(cur)
                cur = [tuple(p)]
            elif t == 3:
                cur += cubic(cur[-1], c1s[i], c2s[i], p)
            else:
                cur.append(tuple(p))
        if len(cur) > 2: polys.append(cur)
        res = []
        for poly in polys:
            q = [(x + off[0], y + off[1]) for x, y in poly] if g == 'regular_polygon' else poly
            # drop a closing duplicate
            while len(q) > 1 and abs(q[0][0]-q[-1][0]) < 1e-6 and abs(q[0][1]-q[-1][1]) < 1e-6: q = q[:-1]
            q = [p for k, p in enumerate(q) if k == 0 or abs(p[0]-q[k-1][0]) > 1e-6 or abs(p[1]-q[k-1][1]) > 1e-6]
            res.append(q)
        return res
    if g == 'text' and d.get('rendered'):
        return [[tuple(p) for p in ring] for ring in d['rendered']]
    return []

def load(path):
    d = json.load(open(path))
    els = {}
    for it in d['items']:
        if it['type'] == 'element' and isinstance(it['data'], dict):
            els[it['data'].get('id') or it['uuid']] = it['data']
    tps = [it['data'] for it in d['items'] if it['type'] == 'toolpath']
    return d['params'], els, tps

def area(poly):
    # standard shoelace: positive for a counter-clockwise ring (Y up)
    return 0.5 * sum(poly[i-1][0]*poly[i][1] - poly[i][0]*poly[i-1][1] for i in range(len(poly)))

def bbox(polys):
    xs = [p[0] for q in polys for p in q]; ys = [p[1] for q in polys for p in q]
    return min(xs), min(ys), max(xs), max(ys)

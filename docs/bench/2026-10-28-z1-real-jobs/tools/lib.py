import json, os, copy
S = '/tmp/claude-1000/-mnt-c-projects-Case-Maker/1f3de4db-a6fc-40f6-b616-3bca2af6697a/scratchpad/real'

VISE_DEFAULT = {"stockProud": 2.0, "fixedJawThickness": 10, "movingJawThickness": 10, "jawLength": 100,
                "jawStartY": -10, "source": "default", "uncertainty": 0.5}
TAPE_DEFAULT = {"width": 25, "thickness": 0.1, "inset": 2, "where": None, "squareTo": "front", "source": "default"}
NO_SAC = {"under": None, "sides": {"left": None, "right": None, "front": None, "back": None}, "source": "default"}
IDENT = {f: f for f in ["top", "bottom", "left", "right", "front", "back"]}


def base(name, L, W, T, material, tool, hold='vise', **kw):
    j = {"schemaVersion": 3, "name": name, "machineId": "Z1",
         "stock": {"length": L, "width": W, "thickness": T, "material": material},
         "labels": [], "toolKey": tool, "minFloor": 1, "edgeMargin": 1, "customFonts": [],
         "sacrificial": copy.deepcopy(NO_SAC), "breakthrough": 0.3, "jawClearance": 1, "shapes": []}
    if hold == 'vise':
        v = dict(VISE_DEFAULT)
        v['stockProud'] = kw.pop('proud', min(4, T / 2))
        j['workholding'] = {"kind": "vise", "vise": v}
    elif hold == 'tape':
        j['workholding'] = {"kind": "tape", "tape": dict(TAPE_DEFAULT)}
    elif hold == 'bracket':
        j['workholding'] = {"kind": "bracket", "bracket": {"anchor": 1, "variant": "thin",
                            "clamps": kw.pop('clamps', [{"edge": "back", "at": L / 2}, {"edge": "right", "at": W / 2}]),
                            "source": "default"}}
    else:
        j['workholding'] = hold
    j.update(kw)
    return j


def setup(item_ids, tools, mount='vise', tool_items=None, board=None, sid='s1'):
    m = {"kind": mount}
    if board is not None:
        m['board'] = board
    s = {"id": sid, "orientation": dict(IDENT), "mount": m, "itemIds": item_ids, "tools": tools}
    if tool_items:
        s['toolItems'] = tool_items
    return s


def label(i, text, x, y, size, depth, rot=0, weight='bold', font='sans-default', construction=False):
    d = {"id": i, "text": text, "font": font, "weight": weight, "size": size,
            "position": {"x": x, "y": y}, "rotation": rot, "depth": depth, "enabled": True}
    if construction: d["construction"] = True
    return d


def rect(i, x, y, w, h, depth, r=0, **kw):
    d = {"id": i, "kind": "rect", "position": {"x": x, "y": y}, "rotation": 0, "depth": depth, "enabled": True,
         "width": w, "height": h, "cornerRadius": r}
    d.update(kw); return d


def circle(i, x, y, dia, depth, **kw):
    d = {"id": i, "kind": "circle", "position": {"x": x, "y": y}, "rotation": 0, "depth": depth, "enabled": True,
         "diameter": dia}
    d.update(kw); return d


def poly(i, x, y, pts, depth, **kw):
    d = {"id": i, "kind": "polygon", "position": {"x": x, "y": y}, "rotation": 0, "depth": depth, "enabled": True,
         "points": [[p[0], p[1]] for p in pts]}
    d.update(kw); return d


def drill(i, x, y, depth, through=False, **kw):
    d = {"id": i, "kind": "drill", "position": {"x": x, "y": y}, "rotation": 0, "depth": depth, "enabled": True,
         "through": through}
    d.update(kw); return d


def cutout(i, of='stock-inset', side='outside', inset=0, tabs=(0, 0, 0)):
    return {"kind": "cutout", "id": i, "enabled": True, "of": of, "side": side, "inset": inset,
            "tabs": {"count": tabs[0], "width": tabs[1], "height": tabs[2]}}


def write(j):
    p = os.path.join(S, 'jobs', j['name'] + '.json')
    json.dump(j, open(p, 'w'), indent=1)
    return p

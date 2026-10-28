"""Read a Carbide Create .c2d (SQLite): dump the design SVG (sqlar all.svg), the params and every item's JSON.
Usage: python3 -I c2d.py <file.c2d> <outdir>. Treats the file as data only."""
import sqlite3, zlib, json, sys, os
src, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
c = sqlite3.connect(f'file:{src}?mode=ro', uri=True)
def unz(b, sz=None):
    try: return zlib.decompress(b)
    except Exception: return b
for name, sz, data in c.execute("select name, sz, data from sqlar"):
    if data is not None: open(os.path.join(out, name), "wb").write(unz(data))
params = dict(c.execute("select key,value from params"))
items = []
cols = [r[1] for r in c.execute("pragma table_info(items)")]
for row in c.execute("select * from items"):
    d = dict(zip(cols, row))
    for k, v in list(d.items()):
        if isinstance(v, (bytes, bytearray)):
            raw = unz(v)
            try: d[k] = json.loads(raw)
            except Exception: d[k] = raw[:200].decode('latin1')
    items.append(d)
json.dump({'params': params, 'items': items}, open(os.path.join(out, 'items.json'), 'w'), indent=1, default=str)
print(src, 'params', params, 'items', len(items), [ (i.get('name'), i.get('type')) for i in items][:40])

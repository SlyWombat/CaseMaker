"""Generate goal inputs for relief jobs: a binary STL heightfield solid and a greyscale PNG."""
import struct, math, zlib, hashlib, base64, sys, os

def heightfield_stl(path, w, h, base, fn, n=60):
    """Closed solid: bottom at z=0, top surface z = base + fn(x,y) over [0,w]x[0,h]."""
    tris = []
    xs = [w * i / n for i in range(n + 1)]
    ys = [h * j / n for j in range(n + 1)]
    Z = [[base + fn(x, y) for x in xs] for y in ys]
    def P(i, j, top=True):
        return (xs[i], ys[j], Z[j][i] if top else 0.0)
    for j in range(n):
        for i in range(n):
            a, b, c, d = P(i, j), P(i + 1, j), P(i + 1, j + 1), P(i, j + 1)
            tris += [(a, b, c), (a, c, d)]
            a, b, c, d = P(i, j, False), P(i + 1, j, False), P(i + 1, j + 1, False), P(i, j + 1, False)
            tris += [(a, c, b), (a, d, c)]
    # walls
    for i in range(n):
        # front y=0
        a, b = P(i, 0), P(i + 1, 0); a0, b0 = P(i, 0, False), P(i + 1, 0, False)
        tris += [(a0, b0, b), (a0, b, a)]
        a, b = P(i, n), P(i + 1, n); a0, b0 = P(i, n, False), P(i + 1, n, False)
        tris += [(a0, b, b0), (a0, a, b)]
    for j in range(n):
        a, b = P(0, j), P(0, j + 1); a0, b0 = P(0, j, False), P(0, j + 1, False)
        tris += [(a0, b, b0), (a0, a, b)]
        a, b = P(n, j), P(n, j + 1); a0, b0 = P(n, j, False), P(n, j + 1, False)
        tris += [(a0, b0, b), (a0, b, a)]
    with open(path, 'wb') as f:
        f.write(b'heightfield'.ljust(80, b' '))
        f.write(struct.pack('<I', len(tris)))
        for t in tris:
            f.write(struct.pack('<3f', 0, 0, 0))
            for v in t:
                f.write(struct.pack('<3f', *v))
            f.write(b'\0\0')

def png_grey(path, W, H, fn):
    raw = b''.join(b'\0' + bytes(max(0, min(255, int(fn(x, y)))) for x in range(W)) for y in range(H))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 0, 0, 0, 0)) \
        + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)

def embed(path):
    b = open(path, 'rb').read()
    return base64.b64encode(b).decode(), hashlib.sha256(b).hexdigest(), len(b)

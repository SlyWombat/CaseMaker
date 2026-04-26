import { describe, it, expect } from 'vitest';
import { buildBinaryStl } from '@/workers/export/stlBinary';

function tetrahedron(): { positions: Float32Array; indices: Uint32Array } {
  // 4 verts forming a tetrahedron, 4 triangular faces.
  const positions = new Float32Array([
    0, 0, 0,
    10, 0, 0,
    0, 10, 0,
    0, 0, 10,
  ]);
  const indices = new Uint32Array([
    0, 2, 1,
    0, 1, 3,
    0, 3, 2,
    1, 2, 3,
  ]);
  return { positions, indices };
}

function parseBinaryStl(buf: ArrayBuffer): { triCount: number; bbox: { min: number[]; max: number[] } } {
  const dv = new DataView(buf);
  const triCount = dv.getUint32(80, true);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let off = 84;
  for (let i = 0; i < triCount; i++) {
    off += 12;
    for (let v = 0; v < 3; v++) {
      const x = dv.getFloat32(off, true);
      const y = dv.getFloat32(off + 4, true);
      const z = dv.getFloat32(off + 8, true);
      if (x < min[0]!) min[0] = x;
      if (y < min[1]!) min[1] = y;
      if (z < min[2]!) min[2] = z;
      if (x > max[0]!) max[0] = x;
      if (y > max[1]!) max[1] = y;
      if (z > max[2]!) max[2] = z;
      off += 12;
    }
    off += 2;
  }
  return { triCount, bbox: { min, max } };
}

describe('binary STL writer', () => {
  it('produces a valid header and triangle count', () => {
    const tet = tetrahedron();
    const buf = buildBinaryStl([tet]);
    expect(buf.byteLength).toBe(80 + 4 + 4 * 50);
    const parsed = parseBinaryStl(buf);
    expect(parsed.triCount).toBe(4);
  });

  it('round-trips bbox from input mesh', () => {
    const tet = tetrahedron();
    const buf = buildBinaryStl([tet]);
    const parsed = parseBinaryStl(buf);
    expect(parsed.bbox.min).toEqual([0, 0, 0]);
    expect(parsed.bbox.max).toEqual([10, 10, 10]);
  });

  it('concatenates multiple meshes correctly', () => {
    const tet = tetrahedron();
    const buf = buildBinaryStl([tet, tet]);
    const parsed = parseBinaryStl(buf);
    expect(parsed.triCount).toBe(8);
  });
});

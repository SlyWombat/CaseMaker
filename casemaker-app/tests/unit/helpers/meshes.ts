/**
 * #1180 S2 — THE SUITE'S SHARED MESH BUILDERS.
 *
 * The same encoders and goal shapes were copied into dozens of specs: a base64 STL encoder in 21
 * files, its `stlBase64` twin in 8, an ArrayBuffer STL encoder in 9, the notched plate in 5, and
 * the sphere in 2. The copies were the same code (they had drifted only in comments and parameter
 * types), so they live here once. The byte output is unchanged — program and mesh hash pins depend
 * on it.
 *
 * `stl` and `stlBase64` write the SAME bytes: zero facet normals and zero attribute byte counts,
 * which are already zero in a fresh ArrayBuffer. Both names survive because the specs named the
 * copy by their own habit.
 */

export type MeshPoint = readonly [number, number, number];
export type MeshTri = readonly [MeshPoint, MeshPoint, MeshPoint];

/** A binary STL as base64 text: zero facet normals, zero attribute byte counts. */
export function stl(tris: readonly MeshTri[]): string {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return Buffer.from(new Uint8Array(buf)).toString('base64');
}

/** The same bytes as {@link stl}; the name the goal specs used for their copy. */
export const stlBase64: (tris: readonly MeshTri[]) => string = stl;

/** A binary STL as base64 text — the string form five specs' copies returned. */
export function binaryStlBase64(tris: readonly MeshTri[]): string {
  return Buffer.from(new Uint8Array(binaryStl(tris))).toString('base64');
}

/** A binary STL as an ArrayBuffer (zero facet normals and attribute byte counts). */
export function binaryStl(tris: readonly MeshTri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const t of tris) {
    off += 12;
    for (const v of t) {
      dv.setFloat32(off, v[0], true);
      dv.setFloat32(off + 4, v[1], true);
      dv.setFloat32(off + 8, v[2], true);
      off += 12;
    }
    off += 2;
  }
  return buf;
}

type Pt2 = [number, number];
type Tri2 = readonly [Pt2, Pt2, Pt2];
type Pt3 = readonly [number, number, number];

/**
 * A 20 × 10 × 5 plate with a 6 mm-wide V notch along Y, 4.5 mm deep, its mouth flush with the
 * plate's top face (#1023's goal, shared by the notched-plate five). A ⌀6 ball cannot enter the V:
 * it rides on the walls and on the shoulders, so the notch's floor stands above the goal —
 * material only a smaller ball takes.
 */
export function notchedPlate(): string {
  const A: Pt2 = [0, 0];
  const B: Pt2 = [20, 0];
  const C: Pt2 = [20, 5];
  const D: Pt2 = [13, 5];
  const E: Pt2 = [10, 0.5];
  const F: Pt2 = [7, 5];
  const G: Pt2 = [0, 5];
  const section = [A, B, C, D, E, F, G];
  const depth = 10;
  const capTris: readonly Tri2[] = [
    [C, D, E],
    [B, C, E],
    [A, B, E],
    [G, A, E],
    [E, F, G],
  ];
  const cap = (y: number): readonly (readonly [Pt3, Pt3, Pt3])[] =>
    capTris.map(([a, b, c]) =>
      y === 0
        ? [[a[0], y, a[1]], [b[0], y, b[1]], [c[0], y, c[1]]]
        : [[a[0], y, a[1]], [c[0], y, c[1]], [b[0], y, b[1]]],
    );
  const sideTris: (readonly [Pt3, Pt3, Pt3])[] = [];
  for (let i = 0; i < section.length; i++) {
    const a = section[i]!;
    const b = section[(i + 1) % section.length]!;
    const a0: Pt3 = [a[0], 0, a[1]];
    const b0: Pt3 = [b[0], 0, b[1]];
    const a1: Pt3 = [a[0], depth, a[1]];
    const b1: Pt3 = [b[0], depth, b[1]];
    sideTris.push([a0, a1, b1], [a0, b1, b0]);
  }
  return stlBase64([...cap(0), ...cap(depth), ...sideTris]);
}

/**
 * A sphere of radius `r` centred at (r, r, r), outward-wound (the STL/Manifold convention), as a
 * flat positions array — the #965/#967 fixture. Each spec keeps its own mesh adapter (`meshOf`).
 */
export function spherePositions(r: number, rings = 24, segs = 48): number[] {
  const p: number[] = [];
  const at = (i: number, j: number): [number, number, number] => {
    const phi = (i / rings) * Math.PI;
    const theta = (j / segs) * 2 * Math.PI;
    return [r + r * Math.sin(phi) * Math.cos(theta), r + r * Math.sin(phi) * Math.sin(theta), r - r * Math.cos(phi)];
  };
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
      p.push(...a, ...c, ...b, ...a, ...d, ...c);
    }
  }
  return p;
}

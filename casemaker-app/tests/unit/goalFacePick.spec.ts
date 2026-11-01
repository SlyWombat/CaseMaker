/**
 * #876 — PLACE ON FACE: the near-flat regions of a goal mesh.
 *
 * A CAD box gives one region per exact face. An organic surface has no exact faces at all, so the
 * same rule is exercised on a bent strip: quads hinged 3° apart are grouped while their normals
 * stay within the seed's few degrees, and a new region starts when one turns too far. Regions are
 * ranked by area, so a picker can offer the large ones first, and a degenerate triangle is left
 * out rather than growing from a normal it does not have.
 */
import { describe, expect, it } from 'vitest';

import { goalFaceRegions, REGION_NORMAL_DEG } from '@/components/viewport/goalFacePick';

type V = [number, number, number];
type Tri = [V, V, V];

function mesh(tris: Tri[]): Float32Array {
  const out: number[] = [];
  for (const t of tris) for (const v of t) out.push(v[0], v[1], v[2]);
  return new Float32Array(out);
}

/** Two triangles for a quad, in the winding that makes its normal the quad's. */
function quad(a: V, b: V, c: V, d: V): Tri[] {
  return [[a, b, c], [a, c, d]];
}

/** A 10 mm cube, each quad as its own triangles with fresh vertices (an STL's shape). */
function cube(): Float32Array {
  return mesh([
    ...quad([0, 0, 0], [0, 10, 0], [10, 10, 0], [10, 0, 0]), // −Z
    ...quad([0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]), // +Z
    ...quad([0, 0, 0], [0, 0, 10], [0, 10, 10], [0, 10, 0]), // −X
    ...quad([10, 0, 0], [10, 10, 0], [10, 10, 10], [10, 0, 10]), // +X
    ...quad([0, 0, 0], [10, 0, 0], [10, 0, 10], [0, 0, 10]), // −Y
    ...quad([0, 10, 0], [0, 10, 10], [10, 10, 10], [10, 10, 0]), // +Y
  ]);
}

/** Two quads sharing the edge y = 10, the second hinged `deg` about X. */
function hinge(deg: number): Float32Array {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return mesh([
    ...quad([0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]),
    ...quad([0, 10, 0], [10, 10, 0], [10, 10 + 10 * c, 10 * s], [0, 10 + 10 * c, 10 * s]),
  ]);
}

describe('#876 — the goal’s near-flat regions', () => {
  it('an STL-style unindexed box gives one region per face, each with the face’s exact normal', () => {
    const map = goalFaceRegions(cube());
    expect(map.regions).toHaveLength(6);
    const normals = map.regions.map((r) => `${r.normal.x.toFixed(6)},${r.normal.y.toFixed(6)},${r.normal.z.toFixed(6)}`);
    expect(new Set(normals)).toEqual(
      new Set(['1.000000,0.000000,0.000000', '-1.000000,0.000000,0.000000', '0.000000,1.000000,0.000000', '0.000000,-1.000000,0.000000', '0.000000,0.000000,1.000000', '0.000000,0.000000,-1.000000']),
    );
    // Every face is 10 × 10, and the welding gave the two triangles of each face one region.
    for (const r of map.regions) expect(r.areaMm2).toBeCloseTo(100, 6);
    expect(Array.from(map.regionOf)).toHaveLength(12);
    expect(new Set(Array.from(map.regionOf)).size).toBe(6);
  });

  it('a hinged neighbour within a few degrees joins the region; a steeper one starts its own', () => {
    expect(REGION_NORMAL_DEG).toBe(8);
    // 5°: the hinged face is still the same near-flat side, so all four triangles are one region.
    expect(goalFaceRegions(hinge(5)).regions).toHaveLength(1);
    // 20°: a genuinely different side, and it does not merge.
    expect(goalFaceRegions(hinge(20)).regions).toHaveLength(2);
  });

  it('an organic strip groups into the few large patches a hand would see, not per-triangle slivers', () => {
    // Six 10 × 10 quads along +Y, each segment turned 3° from the last.
    const pts: V[] = [[0, 0, 0]];
    for (let k = 0; k < 6; k++) {
      const a = (k * 3 * Math.PI) / 180;
      const p = pts[k]!;
      pts.push([0, p[1] + 10 * Math.cos(a), p[2] + 10 * Math.sin(a)]);
    }
    const tris: Tri[] = [];
    for (let k = 0; k < 6; k++) {
      const a0 = pts[k]!;
      const a1 = pts[k + 1]!;
      tris.push([[0, a0[1], a0[2]], [10, a0[1], a0[2]], [10, a1[1], a1[2]]]);
      tris.push([[0, a0[1], a0[2]], [10, a1[1], a1[2]], [0, a1[1], a1[2]]]);
    }
    const map = goalFaceRegions(mesh(tris));
    // Seeds at 0° and 9°: three quads (six triangles) each, the fourth 9° from the seed.
    expect(map.regions).toHaveLength(2);
    for (const r of map.regions) expect(r.triangles).toHaveLength(6);
    // The region means sit between their members' 0/3/6° and 9/12/15° normals.
    const zs = map.regions.map((r) => r.normal.z);
    expect(Math.min(...zs)).toBeLessThan(0.999); // not a single flat face
    expect(map.ranked).toHaveLength(2);
  });

  it('ranks regions by area, largest first', () => {
    const small = quad([20, 0, 0], [21, 0, 0], [21, 1, 0], [20, 1, 0]);
    const map = goalFaceRegions(mesh([...quad([0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]), ...small]));
    expect(map.regions).toHaveLength(2);
    expect(map.regions[map.ranked[0]!]!.areaMm2).toBeCloseTo(100, 6);
    expect(map.regions[map.ranked[1]!]!.areaMm2).toBeCloseTo(1, 6);
  });

  it('leaves a degenerate triangle out: it has no normal to grow from', () => {
    const degenerate: Tri = [[3, 3, 3], [3, 3, 3], [3, 3, 3]];
    const map = goalFaceRegions(mesh([...quad([0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]), degenerate]));
    expect(map.regionOf[2]).toBe(-1);
    expect(map.regions).toHaveLength(1);
    expect(map.regions[0]!.triangles).toEqual([0, 1]);
  });
});

/**
 * #958 §3.1–3.2: planar patches from a mesh, and their classification.
 *
 * The solids are built in Manifold, so the expected numbers are the solid's own dimensions,
 * written by hand here, not read back from the code under test.
 */
import { describe, expect, it } from 'vitest';

import { tl as toplevel, type ManifoldInstance } from './helpers/manifoldExec';
import {
  DEFAULT_FEATURE_TOLERANCES as TOL,
  classifyPatches,
  patchesFromMesh,
  remainderSurfaces,
  triangleAdjacency,
  type FrameMesh,
  type Patch,
} from '@/engine/cnc/cam/model/features/patches';

function meshOf(build: (tl: typeof toplevel) => ManifoldInstance): FrameMesh {
  const solid = build(toplevel);
  const m = solid.getMesh();
  const positions = new Float64Array((m.vertProperties.length / m.numProp) * 3);
  for (let v = 0; v < positions.length / 3; v++) {
    positions[3 * v] = m.vertProperties[v * m.numProp]!;
    positions[3 * v + 1] = m.vertProperties[v * m.numProp + 1]!;
    positions[3 * v + 2] = m.vertProperties[v * m.numProp + 2]!;
  }
  solid.delete();
  return { positions, indices: Uint32Array.from(m.triVerts) };
}

const byKind = (patches: Patch[], kind: Patch['kind']): Patch[] => patches.filter((p) => p.kind === kind);
const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

describe('#958 patches from a mesh', () => {
  it('a 40 × 30 × 10 block with a 10 × 10 × 4 pocket holding a 4 × 4 island 2 mm tall', async () => {
    const mesh = meshOf((tl) => {
      const block = tl.Manifold.cube([40, 30, 10]);
      const pocket = tl.Manifold.cube([10, 10, 4]).translate([5, 5, 6]);
      const island = tl.Manifold.cube([4, 4, 2]).translate([8, 8, 6]);
      return block.subtract(pocket).add(island);
    });
    const patches = patchesFromMesh(mesh, TOL);
    classifyPatches(mesh, patches, 0, TOL);

    const floors = byKind(patches, 'floor').sort((a, b) => b.zMax - a.zMax);
    // Top land at z 10: 1200 − 100. Island top at z 8: 16. Pocket floor at z 6: 100 − 16.
    expect(floors.map((f) => [Number(f.zMax.toFixed(6)), Number(f.area.toFixed(6))])).toEqual([
      [10, 1100],
      [8, 16],
      [6, 84],
    ]);
    // Walls: 4 outer, 4 pocket, 4 island. All planar and vertical.
    const walls = byKind(patches, 'wall');
    expect(walls).toHaveLength(12);
    expect(walls.every((w) => w.planar)).toBe(true);
    // The bottom is the stock side.
    const bottom = byKind(patches, 'bottom');
    expect(bottom).toHaveLength(1);
    expect(near(bottom[0]!.area, 1200)).toBe(true);
    expect(byKind(patches, 'remainder')).toHaveLength(0);
    expect(byKind(patches, 'undercut')).toHaveLength(0);
  });

  it('a spherical dish is one curved remainder SURFACE (D1), and no floor but the top land', async () => {
    const mesh = meshOf((tl) => {
      const block = tl.Manifold.cube([40, 40, 10]);
      // Sphere R 20 centred 18 above the top: a dish 2 mm deep, rim radius √(20² − 18²) ≈ 8.72.
      const sphere = tl.Manifold.sphere(20, 256).translate([20, 20, 28]);
      return block.subtract(sphere);
    });
    const patches = patchesFromMesh(mesh, TOL);
    classifyPatches(mesh, patches, 0, TOL);

    // §3.1 leaves a tessellated curve as many small inclined patches; D1 joins them in 3D.
    const { surfaces } = remainderSurfaces(mesh, patches, triangleAdjacency(mesh, TOL.weldMm), TOL, 'mesh');
    expect(surfaces).toHaveLength(1);
    let zMin = Infinity;
    let zMax = -Infinity;
    for (const t of surfaces[0]!) {
      for (let k = 0; k < 3; k++) {
        const z = mesh.positions[mesh.indices[3 * t + k]! * 3 + 2]!;
        zMin = Math.min(zMin, z);
        zMax = Math.max(zMax, z);
      }
    }
    expect(near(zMin, 8, 0.01)).toBe(true);
    expect(near(zMax, 10, 1e-6)).toBe(true);
    // The only floor is the top land: the dish's bottom cap is either curved or a demoted
    // tangent cap (D2), never a floor level of its own.
    const floors = byKind(patches, 'floor');
    expect(floors).toHaveLength(1);
    expect(near(floors[0]!.zMax, 10)).toBe(true);
  });

  it('a filleted (cylindrical) corner is a wall, not remainder (D1)', async () => {
    const mesh = meshOf((tl) => {
      // A 20 × 20 × 5 block whose +x+y corner is rounded with R 3: the square corner removed, a
      // quarter cylinder put back.
      const block = tl.Manifold.cube([20, 20, 5]);
      const corner = tl.Manifold.cube([3, 3, 5]).translate([17, 17, 0]);
      const round = tl.Manifold.cylinder(5, 3, 3, 128).translate([17, 17, 0]);
      const quarter = round.intersect(tl.Manifold.cube([3, 3, 5]).translate([17, 17, 0]));
      return block.subtract(corner).add(quarter);
    });
    const patches = patchesFromMesh(mesh, TOL);
    classifyPatches(mesh, patches, 0, TOL);
    // The quarter cylinder's facets are vertical: walls (planar facets or not), never remainder.
    expect(byKind(patches, 'remainder')).toHaveLength(0);
    expect(byKind(patches, 'wall').length).toBeGreaterThan(4);
  });

  it('an overhang facing down above the part bottom is an undercut', async () => {
    const mesh = meshOf((tl) => {
      // A T: a 30 × 10 × 4 bar on top of a 10 × 10 × 6 stem. The bar's underside faces down at z 6.
      const stem = tl.Manifold.cube([10, 10, 6]).translate([10, 0, 0]);
      const bar = tl.Manifold.cube([30, 10, 4]).translate([0, 0, 6]);
      return stem.add(bar);
    });
    const patches = patchesFromMesh(mesh, TOL);
    classifyPatches(mesh, patches, 0, TOL);
    // The bar's underside, either side of the stem: two 10 × 10 faces at z 6.
    const undercut = byKind(patches, 'undercut');
    expect(undercut).toHaveLength(2);
    expect(near(undercut[0]!.area + undercut[1]!.area, 200)).toBe(true);
  });
});

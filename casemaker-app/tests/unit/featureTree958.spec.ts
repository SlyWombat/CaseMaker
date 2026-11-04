/**
 * #958 §3.3–3.4 and D1/D2: the feature tree from Manifold-built solids.
 *
 * Every expected number is written from the solid's own dimensions here, not read back from the
 * code under test.
 */
import { describe, expect, it } from 'vitest';

import { tl, type ManifoldInstance } from './helpers/manifoldExec';
import { recogniseFeatures, regionRefs, type FeatureTree, type PocketNode } from '@/engine/cnc/cam/model/features';
import type { ParsedMesh } from '@/engine/import/stlParser';

function parsed(solid: ManifoldInstance): ParsedMesh {
  const m = solid.getMesh();
  const n = m.vertProperties.length / m.numProp;
  const positions = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) positions[3 * v + k] = m.vertProperties[v * m.numProp + k]!;
  solid.delete();
  const b = { min: [Infinity, Infinity, Infinity] as [number, number, number], max: [-Infinity, -Infinity, -Infinity] as [number, number, number] };
  for (let i = 0; i < positions.length; i++) {
    const k = i % 3;
    b.min[k] = Math.min(b.min[k]!, positions[i]!);
    b.max[k] = Math.max(b.max[k]!, positions[i]!);
  }
  return { positions, indices: Uint32Array.from(m.triVerts), triangleCount: m.triVerts.length / 3, bbox: b };
}

const all = (nodes: PocketNode[]): PocketNode[] => nodes.flatMap((n) => [n, ...all(n.children)]);
const close = (a: number, b: number, eps: number): void => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(eps);

describe('#958 the feature tree', () => {
  // A 60 × 40 × 10 block, top at z 10:
  //   pocket A  20 × 20 × 4 deep at (5..25, 5..25), floor z 6, holding a 6 × 6 island whose top is z 8
  //   pocket B  10 × 10 × 2 deep at (35..45, 5..15), floor z 8, with a 4 × 4 × 2 sub-pocket (floor z 6)
  //   a ⌀4 through hole at (50, 30)
  function block(): FeatureTree {
    const s = tl.Manifold.cube([60, 40, 10])
      .subtract(tl.Manifold.cube([20, 20, 4]).translate([5, 5, 6]))
      .add(tl.Manifold.cube([6, 6, 2]).translate([12, 12, 6]))
      .subtract(tl.Manifold.cube([10, 10, 2]).translate([35, 5, 8]))
      .subtract(tl.Manifold.cube([4, 4, 2]).translate([38, 8, 6]))
      .subtract(tl.Manifold.cylinder(12, 2, 2, 64).translate([50, 30, -1]));
    return recogniseFeatures({ triangles: parsed(s) }, { up: [0, 0, 1], stockTop: 10, stockBottom: 0 }, tl);
  }

  it('levels are the floor heights, top first', () => {
    const tree = block();
    expect(tree.levels.map((z) => Number(z.toFixed(6)))).toEqual([10, 8, 6]);
    close(tree.frame.partTop, 10, 1e-6);
    close(tree.frame.partBottom, 0, 1e-6);
  });

  it('the top land is every floor at the top, and the contour is the outer silhouette', () => {
    const tree = block();
    // 2400 − 400 (A) − 100 (B) − π·2² (hole, 64-gon).
    const hole = 64 * 0.5 * 4 * Math.sin((2 * Math.PI) / 64);
    close(tree.top.area, 2400 - 400 - 100 - hole, 1e-3);
    close(tree.contour.area, 2400, 1e-6);
    expect(tree.contour.frees).toBe(true);
    close(tree.contour.zTo, 0, 1e-6);
  });

  it('pockets, islands, children and the through hole', () => {
    const tree = block();
    const nodes = all(tree.pockets);
    const at = (z: number): PocketNode[] => nodes.filter((n) => !n.through && Math.abs(n.floorZ - z) < 1e-6);

    // Level 8: pocket A cleared to the island's top (region 400, floor = the island top 36), and
    // pocket B (region 100, floor 100 − 16).
    const l8 = at(8).sort((a, b) => a.floors[0]!.area - b.floors[0]!.area);
    expect(l8).toHaveLength(2);
    close(l8[0]!.floors[0]!.area, 36, 1e-6);
    close(l8[1]!.floors[0]!.area, 84, 1e-6);

    // Level 6: pocket A's floor around the island (400 − 36), the island as a hole rising to 8;
    // B's sub-pocket (16), a child of B.
    const l6 = at(6).sort((a, b) => a.floors[0]!.area - b.floors[0]!.area);
    expect(l6).toHaveLength(2);
    close(l6[0]!.floors[0]!.area, 16, 1e-6);
    close(l6[1]!.floors[0]!.area, 364, 1e-6);
    expect(l6[1]!.islands).toHaveLength(1);
    close(l6[1]!.islands[0]!.topZ, 8, 1e-6);
    close(l6[1]!.mouthZ, 8, 1e-6);
    // B's sub-pocket is B's child.
    const b = l8[1]!;
    expect(b.children.map((c) => c.id)).toContain(l6[0]!.id);
    // Narrowest = the largest cutter that enters: 4 for the 4 × 4 sub-pocket (bisection to 0.005).
    close(l6[0]!.narrowest, 4, 0.01);

    // The ⌀4 hole is a through node.
    const through = nodes.filter((n) => n.through);
    expect(through).toHaveLength(1);
    close(through[0]!.floorZ, 0, 1e-6);
    expect(through[0]!.floors).toEqual([]);
    expect(tree.remainder).toHaveLength(0);
    expect(tree.unreachable).toHaveLength(0);
  });

  it('a dish is one remainder region and never a floor level (D1, D2)', () => {
    const s = tl.Manifold.cube([40, 40, 10]).subtract(tl.Manifold.sphere(20, 256).translate([20, 20, 28]));
    const tree = recogniseFeatures({ triangles: parsed(s) }, { up: [0, 0, 1], stockTop: 10 }, tl);
    expect(tree.levels.map((z) => Number(z.toFixed(6)))).toEqual([10]);
    expect(all(tree.pockets)).toHaveLength(0);
    expect(tree.remainder).toHaveLength(1);
    const r = tree.remainder[0]!;
    // Rim radius √(20² − 18²) = √76; the footprint is the rim disc (256-gon, so a hair under π·76).
    close(r.area, Math.PI * 76, 0.05 * Math.PI * 76);
    close(r.zTop, 10, 1e-6);
    close(r.zBottom, 8, 0.01);
    expect(r.in).toBe('top');
  });

  it('a slope crossing a level is not a pocket, and a sliver floor is listed, not a level (D2)', () => {
    // A 40 × 20 × 10 block with a ramp cut from z 10 down to z 4 along x 10..30 (a wedge removed),
    // and a 3 × 3 pocket floor at z 7 elsewhere giving the level 7 that the ramp crosses.
    const wedge = tl.Manifold.extrude(
      [
        [10, 10],
        [30, 4],
        [30, 10.5],
        [10, 10.5],
      ],
      20,
    )
      .rotate([90, 0, 0])
      .translate([0, 20, 0]);
    const s = tl.Manifold.cube([40, 20, 10])
      .subtract(wedge)
      .subtract(tl.Manifold.cube([3, 3, 3]).translate([34, 2, 7]));
    const tree = recogniseFeatures({ triangles: parsed(s) }, { up: [0, 0, 1], stockTop: 10 }, tl);
    const nodes = all(tree.pockets);
    // One pocket: the 3 × 3 at z 7. The ramp gives no node at 7 (no floor patch there), and the
    // ramp's own foot at z 4 is a wall/edge, not a floor.
    expect(nodes).toHaveLength(1);
    close(nodes[0]!.floorZ, 7, 1e-6);
    close(nodes[0]!.floors[0]!.area, 9, 1e-6);
    expect(tree.remainder).toHaveLength(1);
  });

  it('regionRefs names every node, remainder and the contour', () => {
    const tree = block();
    const refs = regionRefs(tree);
    expect(refs.filter((r) => r.kind === 'pocket')).toHaveLength(all(tree.pockets).length);
    expect(refs.find((r) => r.id === 'contour')?.bounds).toEqual({ min: [0, 0], max: [60, 40] });
  });

  it('a flipped setup (up = −Z) reads the underside', () => {
    // A 30 × 20 × 5 block with a 10 × 10 × 2 pocket cut into its UNDERSIDE, read from below.
    const s = tl.Manifold.cube([30, 20, 5]).subtract(tl.Manifold.cube([10, 10, 2]).translate([5, 5, 0]));
    const tree = recogniseFeatures({ triangles: parsed(s) }, { up: [0, 0, -1], stockTop: 0 }, tl);
    // Flipped: z' = −z, so the part spans z' −5..0 and the underside pocket's floor (z 2) is z' −2.
    expect(tree.levels.map((z) => Number(z.toFixed(6)))).toEqual([0, -2]);
    const nodes = all(tree.pockets);
    expect(nodes).toHaveLength(1);
    close(nodes[0]!.floors[0]!.area, 100, 1e-6);
  });
});

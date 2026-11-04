/**
 * #964 — SEEDED RANDOM PARTS FOR THE CUTTING OPS' PROPERTY TESTS (#959/#960).
 *
 * Rectilinear and filleted plates built with the production Manifold kernel: pockets, an island,
 * a shoulder open to the edge, and a through hole. Each part is meshed and run through the app's
 * own feature recognition, so the plan is exercised on real geometry, not a hand-built tree.
 *
 * The work frame is the post's: the part's TOP is Z = 0, its bottom −thickness, centred in XY.
 * The same `ParsedMesh` feeds recognition and (as a binary STL target) the goal heightfield, so
 * the design the property tests measure against is the geometry the planner saw.
 */

import { createHash } from 'node:crypto';

import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { FeatureTree } from '@/engine/cnc/cam/model/features';
import { recogniseFeatures } from '@/engine/cnc/cam/model/features';
import { buildBinaryStl } from '@/workers/export/stlBinary';
import type { EngraveTargetObject } from '@/types/engraveJob';

export type PartKind = 'rectilinear' | 'filleted';

type Solid = InstanceType<ManifoldToplevel['Manifold']>;

export interface RandomPart {
  seed: number;
  kind: PartKind;
  /** Part extents; the plan's stock is these three numbers. */
  stock: { length: number; width: number; thickness: number };
  mesh: ParsedMesh;
  tree: FeatureTree;
  /** The goal's own door (the mesh bytes are generated, not local), for `sampleGoalHeightfield`. */
  target: EngraveTargetObject;
}

/** Deterministic PRNG (mulberry32) — a seed reproduces a part exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A box with its TOP at z = 0, centred at (cx, cy). */
const topBox = (tl: ManifoldToplevel, w: number, d: number, h: number, cx: number, cy: number) =>
  tl.Manifold.cube([w, d, h], true).translate([cx, cy, -h / 2]);

/** A rounded-rectangle solid, top at 0, centred at (cx, cy). */
function roundedBox(
  tl: ManifoldToplevel,
  w: number,
  d: number,
  h: number,
  radius: number,
  cx: number,
  cy: number,
): Solid {
  const r = Math.max(0.1, Math.min(radius, Math.min(w, d) / 2 - 0.1));
  let solid = topBox(tl, Math.max(0.1, w - 2 * r), d, h, cx, cy).add(topBox(tl, w, Math.max(0.1, d - 2 * r), h, cx, cy));
  for (const [sx, sy] of [
    [1, 1],
    [1, -1],
    [-1, 1],
    [-1, -1],
  ] as const) {
    const cyl = tl.Manifold.cylinder(h, r, r, 32, true).translate([cx + sx * (w / 2 - r), cy + sy * (d / 2 - r), -h / 2]);
    solid = solid.add(cyl);
  }
  return solid;
}

const bboxOf = (positions: Float32Array): ParsedMesh['bbox'] => {
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
};

/**
 * Build one part. The seed chooses the pocket layout, sizes, depths and fillet radii; the kind
 * chooses square corners (rectilinear) or rounded pockets (filleted). The layout is deliberately
 * generous in spacing so every pocket is a real, reachable feature; the property tests are about
 * the plan's cuts, not about recognition's edge cases (A's own suite covers those).
 */
export function buildRandomPart(seed: number, kind: PartKind, tl: ManifoldToplevel): RandomPart {
  const rand = rng(seed);
  const length = 40;
  const width = 40;
  const thickness = 10;
  let solid = topBox(tl, length, width, thickness, 0, 0);

  // Three pockets across the plate, spaced so no two overlap.
  const cells: [number, number][] = [
    [-10, -10],
    [10, -10],
    [0, 10],
  ];
  for (const [cx, cy] of cells) {
    const w = 6 + rand() * 6;
    const d = 6 + rand() * 6;
    const depth = 1.5 + rand() * 3;
    const pocket =
      kind === 'filleted' ? roundedBox(tl, w, d, depth + 1, 1 + rand() * 1.5, cx, cy) : topBox(tl, w, d, depth + 1, cx, cy);
    solid = solid.subtract(pocket);
    // One island in the first pocket, standing from the floor to the stock top.
    if (cx === -10 && cy === -10) {
      solid = solid.add(topBox(tl, 2.5, 2.5, depth, cx, cy));
    }
  }

  // A shoulder open to the +X edge: the cut runs off the part's side.
  solid = solid.subtract(topBox(tl, 10, 8, 3, length / 2, 0));

  // A through hole in the fourth quadrant.
  solid = solid.subtract(tl.Manifold.cylinder(thickness + 2, 2.5, 2.5, 32, true).translate([-12, 12, 0]));

  const m = solid.getMesh();
  const numProp = m.numProp;
  const positions = new Float32Array(m.vertProperties);
  const indices = new Uint32Array(m.triVerts);
  const mesh: ParsedMesh = {
    positions: numProp === 3 ? positions : new Float32Array(0),
    indices,
    triangleCount: indices.length / 3,
    bbox: bboxOf(numProp === 3 ? positions : new Float32Array(0)),
  };
  if (numProp !== 3) throw new Error(`#964 random part: unexpected vertex property count ${numProp}`);
  const tree = recogniseFeatures({ triangles: mesh }, { up: [0, 0, 1], stockTop: 0 }, tl);
  const stl = buildBinaryStl([{ positions: mesh.positions, indices: mesh.indices }]);
  const sha256 = createHash('sha256').update(Buffer.from(stl)).digest('hex');
  const target: EngraveTargetObject = {
    id: sha256.slice(0, 16),
    name: `random-${kind}-${seed}`,
    format: 'stl',
    sha256,
    data: Buffer.from(stl).toString('base64'),
    size: { x: length, y: width, z: thickness },
    position: { x: 0, y: 0, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
  };
  return { seed, kind, stock: { length, width, thickness }, mesh, tree, target };
}

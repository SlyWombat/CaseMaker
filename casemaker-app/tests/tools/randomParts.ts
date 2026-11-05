/**
 * #964 — SEEDED RANDOM PARTS FOR THE CUTTING OPS' PROPERTY TESTS (#959/#960).
 *
 * Rectilinear and filleted plates built with the production Manifold kernel: pockets, an island,
 * a shoulder open to the edge, and a through hole. Each part is meshed and run through the app's
 * own feature recognition, so the plan is exercised on real geometry, not a hand-built tree.
 *
 * The plate kinds are the first wave (the cutting ops' property test, #959). The widened kinds are
 * for the curved pipeline (#956/#960) and are deliberately built so a 3-axis machine can reach
 * every exposed surface from +Z:
 *
 *   - `sloped`        one pocket whose floor is a plane, shallower towards −x;
 *   - `filletedFloor` one pocket whose wall meets its flat floor through a quarter-round fillet;
 *   - `scooped`       one spherical bowl — the concave case the finish pass exists for;
 *   - `figure`        an undercut-free stand-in for the demo figures: a solid of revolution whose
 *                     radius never increases with height, so every exposed surface is reachable
 *                     from +Z (one clean curved mesh — no boolean joints to leave artefacts).
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

export type PartKind = 'rectilinear' | 'filleted' | 'sloped' | 'filletedFloor' | 'scooped' | 'figure';

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
  /**
   * Kind-specific design facts the validation/property specs may check against. `centreZ` is the
   * design height at the part centre (0, 0) — the pocket floor, scoop bottom, or figure apex.
   */
  expects?: { centreZ?: number };
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

/**
 * The void of a pocket whose floor is the plane z = −depthCentre − m·(x − cx): deepest at the +x
 * wall, shallowest at the −x wall. The void is the pocket box minus the wedge under the plane.
 */
function slopedPocketVoid(
  tl: ManifoldToplevel,
  w: number,
  d: number,
  depthCentre: number,
  m: number,
  cx: number,
  cy: number,
): Solid {
  const deepest = depthCentre + (m * w) / 2;
  const h = deepest + 4; // the box reaches 2 mm under the deepest floor and 2 mm over the top
  const box = tl.Manifold.cube([w, d, h]).translate([cx - w / 2, cy - d / 2, -(h - 2)]);

  // A large cube whose top face is the plane: rotate the top face's normal onto (m, 0, 1), then
  // put the face's centre on the plane point above (cx, cy). The solid is everything below it.
  const theta = Math.atan(m);
  const big = Math.max(w, d) + 60;
  const half = 20; // the wedge reaches 20 mm below its top face — past any pocket floor
  const wedge = tl.Manifold.cube([big, big, half * 2], true)
    .rotate([0, (theta * 180) / Math.PI, 0])
    .translate([cx - half * Math.sin(theta), cy, -depthCentre - half * Math.cos(theta)]);
  return box.subtract(wedge.intersect(box));
}

/**
 * The void of a flat-floored pocket whose wall meets the floor through a quarter-round fillet of
 * radius `r`: the rounded-box construction — core slab to the floor, band slab for the walls, and
 * edge cylinders plus corner spheres of radius r at the floor's perimeter.
 */
function filletFloorVoid(
  tl: ManifoldToplevel,
  w: number,
  d: number,
  depth: number,
  r: number,
  cx: number,
  cy: number,
): Solid {
  const hw = w / 2 - r;
  const hd = d / 2 - r;
  const zAxis = -(depth - r); // the fillet arc's centre height: tangent to the floor and the wall
  let solid = topBox(tl, w, d, depth - r, cx, cy).add(topBox(tl, 2 * hw, 2 * hd, depth, cx, cy));
  for (const sy of [-1, 1]) {
    solid = solid.add(
      tl.Manifold.cylinder(2 * hw, r, r, 48, true)
        .rotate([0, 90, 0])
        .translate([cx, cy + sy * hd, zAxis]),
    );
  }
  for (const sx of [-1, 1]) {
    solid = solid.add(
      tl.Manifold.cylinder(2 * hd, r, r, 48, true)
        .rotate([90, 0, 0])
        .translate([cx + sx * hw, cy, zAxis]),
    );
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      solid = solid.add(tl.Manifold.sphere(r, 48).translate([cx + sx * hw, cy + sy * hd, zAxis]));
    }
  }
  return solid;
}

/**
 * The void of a spherical bowl: the sphere whose lowest point is `depth` under the top and whose
 * waterline at z = 0 is a circle of radius `footprint`.
 */
function scoopVoid(tl: ManifoldToplevel, footprint: number, depth: number, cx: number, cy: number): Solid {
  const r = (footprint * footprint + depth * depth) / (2 * depth);
  return tl.Manifold.sphere(r, 96).translate([cx, cy, r - depth]);
}

/**
 * An undercut-free figure: a solid of revolution — a smooth loaf with a flat top. The profile's
 * radius never increases with height, so a vertical ray from any exposed point meets no material
 * above it. It is ONE mesh, not a union: every union of primitives I tried left either a
 * down-facing sliver (coincident discs) or a flat ledge (a level recognition reads as a pocket),
 * and both are worse probes of the curved pipeline than the clean curved surface itself.
 */
function figureSolid(tl: ManifoldToplevel, rand: () => number): Solid {
  const radius = 10.5 + rand() * 2.5; // the widest radius, at the stock bottom
  const height = 10.4 + rand() * 2.6; // the ellipsoid's semi-axis: > 10, so the top is a small disc
  const phiMax = Math.asin(10 / height); // the profile stops at the stock top
  const profile: [number, number][] = [
    [0, -10],
    [radius, -10],
  ];
  // The profile (x = radius, y = height) of a quarter ellipse: r = R·cos φ, z = −10 + H·sin φ.
  for (let i = 1; i <= 36; i++) {
    const phi = (phiMax * i) / 36;
    profile.push([radius * Math.cos(phi), -10 + height * Math.sin(phi)]);
  }
  profile.push([0, 0], [0, -10]);
  const crossSection = tl.CrossSection.ofPolygons([profile], 'EvenOdd');
  const solid = tl.Manifold.revolve(crossSection, 64);
  crossSection.delete();
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

export function buildRandomPart(seed: number, kind: PartKind, tl: ManifoldToplevel): RandomPart {
  const rand = rng(seed);
  const length = 40;
  const width = 40;
  const thickness = 10;
  let solid: Solid;
  let expects: RandomPart['expects'];

  if (kind === 'figure') {
    // The whole part is the figure; the stock is the blank it is freed from.
    solid = figureSolid(tl, rand);
    expects = { centreZ: 0 };
  } else {
    solid = topBox(tl, length, width, thickness, 0, 0);

    if (kind === 'rectilinear' || kind === 'filleted') {
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
        // One island in the first pocket, standing from the floor to the stock top. Its box is
        // `depth + 1` tall — the pocket void is cut `depth + 1` deep, so that reaches the floor —
        // plus a 0.5 mm embed below it: a bottom flush with the floor would be a coincident face
        // in the boolean and left a down-facing sliver the recognition reads as an undercut
        // (#969). The embed is inside the plate's material and never exposed.
        if (cx === -10 && cy === -10) {
          solid = solid.add(topBox(tl, 2.5, 2.5, depth + 1 + 0.5, cx, cy));
        }
      }
      expects = { centreZ: 0 }; // (0, 0) is flat top on both plate kinds
    } else if (kind === 'sloped') {
      const m = 0.1 + rand() * 0.15;
      const half = 8.5 + rand() * 0.5;
      const depthCentre = m * half + 1.2 + rand();
      solid = solid.subtract(slopedPocketVoid(tl, 2 * half, 2 * half, depthCentre, m, 0, 0));
      expects = { centreZ: -depthCentre };
    } else if (kind === 'filletedFloor') {
      const r = 1.5 + rand() * 1;
      const half = 8.5 + rand() * 0.5;
      const depth = r + 1.5 + rand() * 1.5;
      solid = solid.subtract(filletFloorVoid(tl, 2 * half, 2 * half, depth, r, 0, 0));
      expects = { centreZ: -depth };
    } else {
      const footprint = 7 + rand() * 1.5;
      const depth = 2 + rand() * 1.5;
      solid = solid.subtract(scoopVoid(tl, footprint, depth, 0, 0));
      expects = { centreZ: -depth };
    }

    // A shoulder open to the +X edge: the cut runs off the part's side.
    solid = solid.subtract(topBox(tl, 10, 8, 3, length / 2, 0));

    // A through hole in the fourth quadrant.
    solid = solid.subtract(tl.Manifold.cylinder(thickness + 2, 2.5, 2.5, 32, true).translate([-12, 12, 0]));
  }

  const m = solid.getMesh();
  const numProp = m.numProp;
  const positions = new Float32Array(m.vertProperties);
  const indices = new Uint32Array(m.triVerts);
  if (numProp !== 3) throw new Error(`#964 random part: unexpected vertex property count ${numProp}`);
  const mesh: ParsedMesh = {
    positions,
    indices,
    triangleCount: indices.length / 3,
    bbox: bboxOf(positions),
  };
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
  return { seed, kind, stock: { length, width, thickness }, mesh, tree, target, ...(expects === undefined ? {} : { expects }) };
}

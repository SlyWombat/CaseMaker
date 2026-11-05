/**
 * #966 — THE DATUM-BEARING TWO-SETUP FIXTURE, shared by `goalEngineEndState966.spec.ts`'s part 2
 * and `multiSetupVerify966.spec.ts`.
 *
 * The Manager's ruling (#966, following `966-goal-setups`'s real `buildSetupSpecs`/
 * `registerSetupOrigin` wiring into `buildModelPlanInputForGoal`): a bare sphere correctly
 * REFUSES a vise-flip registration (no two holes, no usable edge — `registerSetupOrigin`'s own
 * by-design correctness, `cam/model/setups.ts`), so it can never prove "a goal needing two setups
 * posts both, never refused." That claim needs a shape that BOTH (a) genuinely needs two setups —
 * `buildSetupSpecs`'s own reach-aware top+bottom decision, driven by `goalFlipPlan`'s geometry-only
 * visibility target (95 % of the mesh's own surface area, `FLIP_TARGET_FRACTION`) — AND (b) carries
 * a real locating datum `registerSetupOrigin` finds in BOTH setups' own recognised `FeatureTree`s.
 *
 * THE SHAPE: a sphere (radius `SPHERE_R`), curved all the way round like the sphere fixture it
 * replaces (so the top setup alone never reaches the 95 % target — its own blind hemisphere is
 * exactly the fraction the bottom flip is needed for, proven below), with ONE rectangular tab
 * welded onto its equator, sticking out in +Y only. The tab is NEVER mirrored or duplicated — a
 * plain lying cylinder's two parallel long edges are each other's exact twin under the half-turn
 * `toSetupFrame`/`documentXY` apply (`(y, z) -> (-y, -z)` about the mesh's own origin), which is
 * worthless as a datum: `tryEdge`'s matching can pair either edge with either, invisibly, and
 * still pass its own internal consistency check (confirmed empirically while building this
 * fixture — a symmetric cylinder returns a self-consistent but PHYSICALLY WRONG non-zero offset,
 * silently). A single, un-mirrored tab has no twin to be confused with: its outer edge is
 * `TAB_LENGTH_MM` long (clears `MIN_EDGE_LENGTH_MM = 10`'s own hole-pair threshold is not this
 * strategy's; the EDGE threshold is 15 mm, `setups.ts`'s `MIN_EDGE_LENGTH_MM`), and because it sits
 * at the sphere's own equatorial plane (z = 0 in the UNPLACED mesh, the same axis the half-turn
 * pivots on), the real geometric registration offset comes out exactly `[0, 0]` — confirmed by
 * running `buildSetupSpecs` + `recogniseFeatures` + `registerSetupOrigin` directly on this mesh
 * (no `generateGoalProgram`, no post, no verify) before it was ever wired into the full pipeline:
 * `setups.length === 2`, `plan.sides` is `['top', 'bottom']`, `plan.stopped === 'target-reached'`,
 * and `registerSetupOrigin(tree0, tree1)` returns `{ datum: { basis: 'edge', lengthMm: 20 }, offsetMm: [0, 0] }`
 * — never throwing. Only after that isolated check passed was this fed through
 * `buildModelPlanInputForGoal` -> `planModelCam` -> `generateGoalProgram`, where it posts 3
 * programs per setup (6 total) with zero verifier findings of ANY severity, not only zero errors.
 *
 * BUILT WITH MANIFOLD ITSELF (`tl.Manifold.sphere` union `tl.Manifold.cube`), not a hand-rolled
 * triangle list: `features/tree.ts`'s own `solidOf` needs a genuinely closed, watertight mesh
 * (`new tl.Manifold(mesh)` builds a real solid from it, "the mesh must close"), which a UV-sphere
 * parametrisation can get subtly wrong at the poles; the kernel's own primitives and boolean union
 * are guaranteed manifold.
 */

import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import type { FeatureSource } from '@/engine/cnc/cam/model/features';
import type { ParsedMesh } from '@/engine/import/stlParser';
import type { EngraveTargetObject } from '@/types/engraveJob';

/** The sphere's radius, mm — curved all the way round, same role the bare-sphere fixture plays. */
export const SPHERE_R = 15;
/** The tab's own length (its outer edge — the registration datum), mm. */
export const TAB_LENGTH_MM = 20;
/** How far the tab sticks out past the sphere's own equator, mm. */
export const TAB_OUT_MM = 10;
/** The tab's thickness (its own short axis, mm) — thin, just enough to be a real 3D solid. */
export const TAB_THICKNESS_MM = 4;

export interface DatumMesh {
  triangles: ParsedMesh;
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * The raw, UNPLACED mesh: a sphere centred on the origin with one rectangular tab welded onto its
 * equator (the sphere's own z = 0 plane), sticking out in +Y only — never mirrored, see this
 * file's header on why that would defeat the datum. `tl` is the caller's own Manifold kernel
 * (`getToplevel()`), shared rather than reloaded per call.
 */
export function buildDatumMesh(tl: ManifoldToplevel): DatumMesh {
  const sphere = tl.Manifold.sphere(SPHERE_R, 64);
  const tab = tl.Manifold
    .cube([TAB_LENGTH_MM, SPHERE_R + TAB_OUT_MM, TAB_THICKNESS_MM], true)
    .translate([0, (SPHERE_R + TAB_OUT_MM) / 2, 0]);
  const solid = sphere.add(tab);
  const mesh = solid.getMesh();
  sphere.delete();
  tab.delete();
  solid.delete();

  const positions = Float32Array.from(mesh.vertProperties);
  const indices = Uint32Array.from(mesh.triVerts);
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const triangles: ParsedMesh = {
    positions,
    indices,
    triangleCount: indices.length / 3,
    bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] },
  };
  return { triangles, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

/** The mesh as a `FeatureSource`, for the isolated `buildSetupSpecs`/`registerSetupOrigin` check
 *  (this file's header) — loads its own kernel when the caller has none in hand yet. */
export async function datumFeatureSource(): Promise<{ geometry: FeatureSource; bbox: DatumMesh['bbox'] }> {
  const tl = await getToplevel();
  const { triangles, bbox } = buildDatumMesh(tl);
  return { geometry: { triangles }, bbox };
}

/**
 * The same mesh as a full goal job: an `EngraveTargetObject` (STL-encoded, the `stl()` trick
 * `goalEngineEndState966.spec.ts`'s own dome/sphere fixtures use — no Manifold runtime needed to
 * READ it back) plus the stock size that exactly fits its placed bounding box, the same
 * exact-fit convention `sphereGoal`'s own job uses. `underside: { kind: 'flipped-tabs' }` is what
 * offers `bottom` to `buildSetupSpecs` at all (#898's rule) — the sphere fixture's own choice,
 * kept here for the same reason.
 */
export async function buildDatumGoal(): Promise<{
  goal: EngraveTargetObject;
  stock: { length: number; width: number; thickness: number };
}> {
  const tl = await getToplevel();
  const { triangles, bbox } = buildDatumMesh(tl);
  const sizeX = bbox.max[0] - bbox.min[0];
  const sizeY = bbox.max[1] - bbox.min[1];
  const sizeZ = bbox.max[2] - bbox.min[2];

  const buf = new ArrayBuffer(84 + triangles.triangleCount * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, triangles.triangleCount, true);
  let off = 84;
  for (let t = 0; t < triangles.triangleCount; t++) {
    off += 12; // normal — left zero, nothing reads it
    for (let k = 0; k < 3; k++) {
      const v = triangles.indices[t * 3 + k]!;
      dv.setFloat32(off, triangles.positions[v * 3]!, true);
      dv.setFloat32(off + 4, triangles.positions[v * 3 + 1]!, true);
      dv.setFloat32(off + 8, triangles.positions[v * 3 + 2]!, true);
      off += 12;
    }
    off += 2;
  }
  const data = Buffer.from(new Uint8Array(buf)).toString('base64');

  const goal: EngraveTargetObject = {
    id: 'goal-datum-966',
    name: 'datum-966.stl',
    format: 'stl',
    sha256: 'd'.repeat(64),
    data,
    size: { x: sizeX, y: sizeY, z: sizeZ },
    // Centred in X/Y, top at the work frame's z = 0 — the same placement convention
    // `sphereGoal`'s own job uses, so the stock below exactly fits the placed mesh.
    position: { x: sizeX / 2, y: sizeY / 2, z: 0 },
    rotation: 0,
    enabled: true,
    role: 'goal',
    underside: { kind: 'flipped-tabs' },
  };

  return { goal, stock: { length: sizeX, width: sizeY, thickness: sizeZ } };
}

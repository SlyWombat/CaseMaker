/**
 * #966 — THE TABLE, pinned RED-FIRST as `it.fails` (this commit) and fixed in the next one
 * (flipped to plain `it`, `shadowMesh` wired in): a synthetic "table" — a tabletop slab held up on
 * four legs over a baseplate, open air BETWEEN the legs at floor level, SOLID slab material
 * directly above that same open air higher up — built through the REAL Manifold kernel
 * (`tl.Manifold.cube`/`.add`, the same primitives `pocketRedFirst959.spec.ts`/`966-figure-coverage`'s
 * own synthetic fixtures use), not hand-triangulated, for a guaranteed-watertight mesh.
 *
 * THE BUG (Session E's elephant finding, #965/#966 issue comments): a `PocketNode`'s own `region`
 * is only ever "cleared area AT floorZ" (`features.ts`'s own doc) — `pocket()` reuses that ONE
 * static footprint, unmodified, at EVERY Z level from `mouthZ` down to `floorZ`. `tree.ts`'s own
 * `mouthZ` correction only fires when a SIBLING floor-patch node sits directly above (the parent-
 * finding loop in `buildTree`) — never for a plain planar cap with no floor patch of its own, which
 * is exactly what a tabletop's own underside is. So the inter-leg gap, correctly recognised as air
 * AT its own floor (the baseplate's top), gets pocketed from the SLAB's own top straight down to
 * that floor — ~15 mm of solid slab included — because nothing ever told this one node that the
 * slab closes back over the same XY footprint above it.
 *
 * THE SOLID (local mm, before any placement): a 40 x 40 mm baseplate (Z 0–5), four 6 x 6 mm legs at
 * the four corners, inset 2 mm from each edge (Z 5–20), and a 40 x 40 mm slab (Z 20–25) — the SAME
 * footprint as the baseplate, so it covers the inter-leg gap entirely. The only recognised floor
 * patches are the baseplate's own top (Z 5, minus the four leg footprints) and the slab's own top
 * (Z 25, the part's `topZ`) — the legs' own tops at Z 20 are fused into the slab's underside by the
 * union (no floor patch there, the leg being inset means this is also an OPEN shoulder at its own
 * outer edge, same as any other root pocket whose footprint reaches the part's own outline).
 */
import { DEFAULT_RELEASE_TABS } from '@/engine/cnc/cam/model/plan';
import { describe, expect, it } from 'vitest';

import { tl, type ManifoldInstance } from './helpers/manifoldExec';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { recogniseFeatures, type FeatureTree } from '@/engine/cnc/cam/model/features';
import { planPocketsForTree, type PlanPocketsOptions, type PlanPocketsResult } from '@/engine/cnc/cam/model/plan';
import { shiftToStockTop } from '@/engine/cnc/cam/model/setups';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { ParsedMesh } from '@/engine/import/stlParser';

// ───────────────────────────────────────────────────────────────────────────────────────────
// THE MESH — same extraction helper `pocketRedFirst959.spec.ts` already uses (vertProperties by
// `numProp`, never assuming 3 floats/vertex), built through the real Manifold kernel.
// ───────────────────────────────────────────────────────────────────────────────────────────

function parsed(solid: ManifoldInstance): ParsedMesh {
  const m = solid.getMesh();
  const n = m.vertProperties.length / m.numProp;
  const positions = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) positions[3 * v + k] = m.vertProperties[v * m.numProp + k]!;
  solid.delete();
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  return { positions, indices: Uint32Array.from(m.triVerts), triangleCount: m.triVerts.length / 3, bbox: { min, max } };
}

const BASE_Z = 5;
const LEG_TOP_Z = 20;
const SLAB_TOP_Z = 25;
const LEG = 6; // leg cross-section, mm
const FOOT = 40; // baseplate/slab footprint, mm
const INSET = 2; // leg inset from the footprint's own edge, mm

function buildTableSolid(): ManifoldInstance {
  const baseplate = tl.Manifold.cube([FOOT, FOOT, BASE_Z], false);
  const slab = tl.Manifold.cube([FOOT, FOOT, SLAB_TOP_Z - LEG_TOP_Z], false).translate([0, 0, LEG_TOP_Z]);
  const legAt = (x: number, y: number): ManifoldInstance => tl.Manifold.cube([LEG, LEG, LEG_TOP_Z - BASE_Z], false).translate([x, y, BASE_Z]);
  const legs = [
    legAt(INSET, INSET),
    legAt(FOOT - INSET - LEG, INSET),
    legAt(INSET, FOOT - INSET - LEG),
    legAt(FOOT - INSET - LEG, FOOT - INSET - LEG),
  ];
  return legs.reduce((acc, leg) => acc.add(leg), baseplate.add(slab));
}

function flat(d: number, number: number): Tool {
  return {
    number, id: `flat-${d}`, name: `⌀${d} flat`, typeText: 'flat', shape: 'flat',
    handleDiameter: d, tipDiameter: null, diameter: d, cornerRadius: null,
    // #1195 — a STATED flute that reaches this fixture's 25 mm profile (it was 20).
    angle: null, halfAngle: null, fluteLength: 30, shoulderLength: null,
    stickout: null, centreCutting: true,
  };
}

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const offset = makeClipperOffset(tl);
const boolean = { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) };

// #1018 — every real caller shifts the mesh to this setup's own `stockTop` at the door
// (`shiftToStockTop`, `plan.ts`'s own setup loop) before `planPocketsForTree`/its `shadowMesh`
// ever see it; this unit test, calling `planPocketsForTree` directly below that loop, does the
// same shift itself. `doorGeometry` is shared so a tree AND the shadow mesh passed alongside it
// agree on the one datum.
function doorGeometry(mesh: ParsedMesh, stockTop: number): ParsedMesh {
  return shiftToStockTop({ triangles: mesh }, { up: [0, 0, 1], stockTop, stockBottom: 0 }).geometry.triangles;
}
function treeOf(mesh: ParsedMesh, stockTop: number): FeatureTree {
  const shifted = shiftToStockTop({ triangles: mesh }, { up: [0, 0, 1], stockTop, stockBottom: 0 });
  return recogniseFeatures(shifted.geometry, shifted.frame, tl);
}

function basePlanOptions(houseFlats: Tool[]): Omit<PlanPocketsOptions, 'shadowMesh'> {
  return {
    tabs: DEFAULT_RELEASE_TABS,
    offset,
    houseFlats,
    stepDownMm: 2,
    feeds: { feedMmPerMin: 1000, plungeFeedMmPerMin: 300 },
    rapid,
    toolChangeSeconds: 60,
    spindleRpm: 12000,
    air: true,
    maxCutters: houseFlats.length + 1,
    boolean,
  };
}

/**
 * Every FEED move's own absolute Z (undoing the door's own `-stockTop` shift, #1018 — `stockTop`
 * here is the shift THIS test applied building its tree, not `tree.frame.stockTop`, which reads
 * 0 once the tree is built through the door) that lies strictly inside the slab's own band
 * (`LEG_TOP_Z`, `SLAB_TOP_Z`) is a move cutting straight through solid slab material — #966's
 * exact finding. `HOP_Z`/`safeZ` retracts sit well above `SLAB_TOP_Z` already and are never
 * flagged by this (they are rapids, never `feed`, and this only inspects `feed` kind moves).
 */
function feedsThroughSlab(result: PlanPocketsResult, stockTop: number): string[] {
  const bad: string[] = [];
  for (const op of result.ops) {
    if (op.kind !== 'pocket') continue;
    for (const operation of op.outcome.ir.operations) {
      for (const m of operation.moves) {
        if (m.kind !== 'feed') continue;
        const absZ = m.z + stockTop;
        // ONLY flag a move actually over the slab's own real footprint (X/Y within [0, FOOT]) — a
        // move past that, however high its Z, is the pocket op's own documented open-edge
        // overshoot band (`pocket.ts`'s own header: "the overshoot past the true edge is air,
        // removed by the contour op regardless"), never real material in this fixture.
        const overSlab = m.x > -1e-6 && m.x < FOOT + 1e-6 && m.y > -1e-6 && m.y < FOOT + 1e-6;
        if (overSlab && absZ > LEG_TOP_Z + 1e-6 && absZ < SLAB_TOP_Z - 1e-6) {
          bad.push(`${op.region.id}: feed at (${m.x.toFixed(2)}, ${m.y.toFixed(2)}, abs z ${absZ.toFixed(3)}) — inside the slab's own band (${LEG_TOP_Z}, ${SLAB_TOP_Z})`);
        }
      }
    }
  }
  return bad;
}

describe('#966 the table — a pocket under an overhang the node itself never saw', () => {
  it('sanity: recogniseFeatures finds exactly the one inter-leg pocket, floor at the baseplate top', () => {
    const tree = treeOf(parsed(buildTableSolid()), SLAB_TOP_Z);
    expect(tree.pockets).toHaveLength(1);
    const node = tree.pockets[0]!;
    expect(node.floorZ).toBeCloseTo(BASE_Z - SLAB_TOP_Z, 3);
    expect(node.through).toBe(false);
    // `mouthZ` is the part's own top (the slab's) — never corrected down to the slab's own
    // underside, because that underside has no floor patch of its own (`tree.ts`'s own parent-
    // finding loop only ever fires for a sibling floor-patch node) — this IS the root cause,
    // confirmed directly off the recognised tree rather than assumed from the issue's description.
    expect(node.mouthZ).toBeCloseTo(0, 3);
  });

  it.fails('red-first (pre-#966 call shape, no shadow check): plans a cut straight through the slab', () => {
    const tree = treeOf(parsed(buildTableSolid()), SLAB_TOP_Z);
    const result = planPocketsForTree(tree, basePlanOptions([flat(4, 1)]));
    const bad = feedsThroughSlab(result, SLAB_TOP_Z);
    // THE RED ASSERTION — what #966 actually requires — fails today: at least one feed move
    // exists inside the slab's own band, because `node.region`'s one static footprint is pocketed
    // unmodified from the slab's own top straight down to the baseplate's floor.
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('fixed: with shadowMesh wired (the real planModelCam call shape), no move cuts into the slab', () => {
    const mesh = parsed(buildTableSolid());
    const tree = treeOf(mesh, SLAB_TOP_Z);
    const result = planPocketsForTree(tree, { ...basePlanOptions([flat(4, 1)]), shadowMesh: doorGeometry(mesh, SLAB_TOP_Z) });
    const bad = feedsThroughSlab(result, SLAB_TOP_Z);
    // THE GREEN ASSERTION: not one feed move lies over the slab's own real footprint at a Z
    // inside the slab's own band — the whole node's true interior sits under the slab everywhere
    // (the slab's own footprint matches the baseplate's, by this fixture's own construction), so
    // every level of this one pocket node is correctly excluded there; `pocket()`'s own pre-#966
    // open-edge overshoot band (past the TRUE footprint, air regardless) is explicitly allowed by
    // `feedsThroughSlab`'s own XY check — this test is about the slab, not that pre-existing,
    // unrelated mechanism.
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('a genuinely OPEN gap (no slab overhead) is still fully pocketed — the fix is not a blanket refusal', () => {
    // The SAME table, minus the slab: now the inter-leg gap is open air all the way to its own
    // mouth (the baseplate's own top is also the part's `topZ`), so the #966 shadow check must be
    // a no-op here — proof this isn't just "shadowMesh means never cut," it only ever restricts a
    // column that is REALLY obstructed.
    const baseplate = tl.Manifold.cube([FOOT, FOOT, BASE_Z], false);
    const legAt = (x: number, y: number): ManifoldInstance => tl.Manifold.cube([LEG, LEG, LEG_TOP_Z - BASE_Z], false).translate([x, y, BASE_Z]);
    const legs = [legAt(INSET, INSET), legAt(FOOT - INSET - LEG, INSET), legAt(INSET, FOOT - INSET - LEG), legAt(FOOT - INSET - LEG, FOOT - INSET - LEG)];
    const openSolid = legs.reduce((acc, leg) => acc.add(leg), baseplate);
    const openMesh = parsed(openSolid);
    const tree = treeOf(openMesh, LEG_TOP_Z);
    expect(tree.pockets).toHaveLength(1);
    const result = planPocketsForTree(tree, { ...basePlanOptions([flat(4, 1)]), shadowMesh: doorGeometry(openMesh, LEG_TOP_Z) });
    const pocketOps = result.ops.filter((op) => op.kind === 'pocket');
    const totalMoves = pocketOps.reduce((n, op) => n + op.outcome.ir.operations.reduce((m, o) => m + o.moves.length, 0), 0);
    expect(totalMoves).toBeGreaterThan(0);
  });

  it('#970 over-clip, FIXED: the SAME open gap is pocketed all the way to its own true floor, not left one step shy', () => {
    // The identical fixture as the test above (an isolated floor with NO overhang anywhere above
    // it — the honest case `aboveMaterial` must treat as a complete no-op). `ceilingMaskAt`'s own
    // grid probes THIS SAME floor back off the mesh (there is nothing else along that vertical
    // line to find), so `ceiling === floorZ` exactly at every interior point. Before this fix, the
    // predicate demanded `ceiling + marginMm < levelZ` — at the node's own LAST level (`levelZ ===
    // floorZ` exactly, `depthPasses`' own guarantee), that read `floorZ + marginMm < floorZ`,
    // false for any positive margin, so the deepest pass was masked out EVERYWHERE, leaving the
    // floor's own entire interior standing — the mechanism behind #970's own reported "0.6 mm
    // short at x = -12" finding. Fixed in `ops/pocket.ts`'s own predicate (margin given back to
    // the level, not taken from the ceiling).
    const baseplate = tl.Manifold.cube([FOOT, FOOT, BASE_Z], false);
    const legAt = (x: number, y: number): ManifoldInstance => tl.Manifold.cube([LEG, LEG, LEG_TOP_Z - BASE_Z], false).translate([x, y, BASE_Z]);
    const legs = [legAt(INSET, INSET), legAt(FOOT - INSET - LEG, INSET), legAt(INSET, FOOT - INSET - LEG), legAt(FOOT - INSET - LEG, FOOT - INSET - LEG)];
    const openSolid = legs.reduce((acc, leg) => acc.add(leg), baseplate);
    const openMesh = parsed(openSolid);
    const tree = treeOf(openMesh, LEG_TOP_Z);
    const result = planPocketsForTree(tree, { ...basePlanOptions([flat(4, 1)]), shadowMesh: doorGeometry(openMesh, LEG_TOP_Z) });
    const pocketOps = result.ops.filter((op) => op.kind === 'pocket');
    // The dead centre of the gap (local (20, 20) — equidistant from all four legs, no leg there at
    // any height) must be swept at the TRUE floor Z, not merely reached SOMEWHERE on the boundary:
    // the actual bug (confirmed by tracing) leaves a thin boundary-artefact ring cut at the final
    // level while the floor's own true INTERIOR is excluded, so a bare "some move reaches floor Z"
    // check passes by accident. The nearest floor-level feed move to (20, 20) must stay inside the
    // tool's own reach of it (`toolRadius + stepOverMm`, generously), or the centre itself was
    // never really cut down to depth.
    const toolRadius = (cuttingDiameter(flat(4, 1)) ?? 0) / 2;
    let nearestAtFloor = Infinity;
    for (const op of pocketOps) {
      for (const operation of op.outcome.ir.operations) {
        for (const m of operation.moves) {
          if (m.kind !== 'feed') continue;
          const absZ = m.z + LEG_TOP_Z;
          if (Math.abs(absZ - BASE_Z) > 1e-3) continue;
          const d = Math.hypot(m.x - 20, m.y - 20);
          nearestAtFloor = Math.min(nearestAtFloor, d);
        }
      }
    }
    expect(nearestAtFloor).toBeLessThan(toolRadius + 1);
  });

  it('#970 a drafted wall stays unclipped: never falsely read as a ceiling, the floor is reachable everywhere', () => {
    // A single pocket, floor 10 x 10 (half-width 5) at Z 5 widening to 12 x 12 (half-width 6) at
    // the mouth, Z 20 — an ordinary ~3.8° mould-release draft, no overhang anywhere. Built as the
    // CONVEX HULL of the eight floor/mouth corners (`tl.Manifold.hull`), not `extrude`'s own
    // `scaleTop`: that path's own triangulation, probed directly, fans each floor corner out to
    // TWO mouth-edge midpoints rather than the simple floor-corner-to-mouth-corner trapezoid, and
    // those fan triangles' own footprint can cross directly over the floor's own dead centre — a
    // triangulation artefact, not a property of the real drafted wall, that a hand-built hull
    // avoids while keeping the same drafted geometry.
    const floorHalf = 5;
    const mouthHalf = 6;
    const cx = 20, cy = 20;
    const corner = (hw: number, sx: 1 | -1, sy: 1 | -1, z: number): [number, number, number] => [cx + sx * hw, cy + sy * hw, z];
    const points: [number, number, number][] = [
      corner(floorHalf, -1, -1, BASE_Z), corner(floorHalf, 1, -1, BASE_Z), corner(floorHalf, 1, 1, BASE_Z), corner(floorHalf, -1, 1, BASE_Z),
      corner(mouthHalf, -1, -1, SLAB_TOP_Z), corner(mouthHalf, 1, -1, SLAB_TOP_Z), corner(mouthHalf, 1, 1, SLAB_TOP_Z), corner(mouthHalf, -1, 1, SLAB_TOP_Z),
    ];
    const block = tl.Manifold.cube([FOOT, FOOT, SLAB_TOP_Z], false);
    const cavity = tl.Manifold.hull(points);
    const solid = block.subtract(cavity);
    const mesh = parsed(solid);
    const tree = treeOf(mesh, SLAB_TOP_Z);
    expect(tree.pockets).toHaveLength(1);
    const node = tree.pockets[0]!;
    expect(node.floorZ).toBeCloseTo(BASE_Z - SLAB_TOP_Z, 3);
    const result = planPocketsForTree(tree, { ...basePlanOptions([flat(4, 1)]), shadowMesh: doorGeometry(mesh, SLAB_TOP_Z) });
    const pocketOps = result.ops.filter((op) => op.kind === 'pocket');
    const toolRadius = (cuttingDiameter(flat(4, 1)) ?? 0) / 2;
    let nearestAtFloor = Infinity;
    for (const op of pocketOps) {
      for (const operation of op.outcome.ir.operations) {
        for (const m of operation.moves) {
          if (m.kind !== 'feed') continue;
          const absZ = m.z + SLAB_TOP_Z;
          if (Math.abs(absZ - BASE_Z) > 1e-3) continue;
          nearestAtFloor = Math.min(nearestAtFloor, Math.hypot(m.x - cx, m.y - cy));
        }
      }
    }
    // The drafted wall must never read as a ceiling: the dead centre of the floor, same as the
    // #970 over-clip case above, must be swept at the true floor Z, not stop one step shy.
    expect(nearestAtFloor).toBeLessThan(toolRadius + 1);
  });
});

/**
 * #970's own second named case: a NESTED parent/child floor-patch pair (the shape
 * `filletedFloor`'s own two-level pocket takes, minus the fillet — a plain flat shelf with a
 * smaller, deeper well inside it). Neither level has any real overhang above it; `aboveMaterial`
 * must be a complete no-op for both. The bug (shared root cause with `pocketShadow966.spec.ts`'s
 * own "#970 over-clip" case): a node's own `dropCutterHeight` probe, read back off the FINISHED
 * design mesh at a point genuinely inside that node's own floor, returns the floor's OWN height —
 * there is nothing else along that vertical line to find — and the per-level predicate (before
 * this fix) wrongly treats "the ceiling equals my own floor" as an obstruction AT that floor's own
 * depth, excluding the whole node from its own LAST (deepest) pass. Both the parent's own ring
 * floor and the child's own deeper floor hit this independently (`plan.ts`'s `allPockets` plans
 * every `PocketNode`, including every child, as its own separate `pocket()` call).
 */
import { describe, expect, it } from 'vitest';

import { tl, type ManifoldInstance } from './helpers/manifoldExec';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { recogniseFeatures, type FeatureTree } from '@/engine/cnc/cam/model/features';
import { planPocketsForTree, type PlanPocketsOptions } from '@/engine/cnc/cam/model/plan';
import { shiftToStockTop } from '@/engine/cnc/cam/model/setups';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';
import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import type { ParsedMesh } from '@/engine/import/stlParser';

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

const FOOT = 40;
const BLOCK_H = 10;
const TOP_Z = BLOCK_H; // the part's own top
const SHELF_Z = 7; // the parent's own floor (shelf ring)
const WELL_Z = 4; // the child's own floor (the deeper well)

function buildNestedSolid(): ManifoldInstance {
  const block = tl.Manifold.cube([FOOT, FOOT, BLOCK_H], false);
  const shelfPocket = tl.Manifold.cube([20, 20, TOP_Z - SHELF_Z + 0.001], false).translate([10, 10, SHELF_Z]);
  const wellPocket = tl.Manifold.cube([10, 10, TOP_Z - WELL_Z + 0.001], false).translate([15, 15, WELL_Z]);
  return block.subtract(shelfPocket).subtract(wellPocket);
}

function flat(d: number, number: number): Tool {
  return {
    number, id: `flat-${d}`, name: `⌀${d} flat`, typeText: 'flat', shape: 'flat',
    handleDiameter: d, tipDiameter: null, diameter: d, cornerRadius: null,
    angle: null, halfAngle: null, fluteLength: 20, shoulderLength: null,
    stickout: null, centreCutting: true,
  };
}

const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const offset = makeClipperOffset(tl);
const boolean = { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) };

// #1018 — every real caller shifts the mesh to this setup's own `stockTop` at the door
// (`shiftToStockTop`, `plan.ts`'s own setup loop) before `planPocketsForTree`/its `shadowMesh`
// ever see it; this unit test, calling `planPocketsForTree` directly below that loop, does the
// same shift itself. `doorGeometry` is shared so the tree AND the shadow mesh passed to
// `planPocketsForTree` agree on the one datum.
function doorGeometry(mesh: ParsedMesh): ParsedMesh {
  return shiftToStockTop({ triangles: mesh }, { up: [0, 0, 1], stockTop: TOP_Z, stockBottom: 0 }).geometry.triangles;
}
function treeOf(mesh: ParsedMesh): FeatureTree {
  const shifted = shiftToStockTop({ triangles: mesh }, { up: [0, 0, 1], stockTop: TOP_Z, stockBottom: 0 });
  return recogniseFeatures(shifted.geometry, shifted.frame, tl);
}

function basePlanOptions(houseFlats: Tool[]): Omit<PlanPocketsOptions, 'shadowMesh'> {
  return {
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

/** The nearest FEED move, at stock-top-relative Z within 1e-3 of `targetZ`, to `(x, y)` — `Infinity` when none exists at that Z at all. */
function nearestFeedAt(result: ReturnType<typeof planPocketsForTree>, targetZ: number, x: number, y: number): number {
  let best = Infinity;
  for (const op of result.ops) {
    if (op.kind !== 'pocket') continue;
    for (const operation of op.outcome.ir.operations) {
      for (const m of operation.moves) {
        if (m.kind !== 'feed') continue;
        if (Math.abs(m.z - targetZ) > 1e-3) continue;
        best = Math.min(best, Math.hypot(m.x - x, m.y - y));
      }
    }
  }
  return best;
}

describe('#970 the nested shelf — a parent floor and its own deeper child, neither an overhang', () => {
  it('sanity: recogniseFeatures finds the parent ring and its one child well', () => {
    const mesh = parsed(buildNestedSolid());
    const tree = treeOf(mesh);
    expect(tree.pockets).toHaveLength(1);
    const parent = tree.pockets[0]!;
    expect(parent.floorZ).toBeCloseTo(SHELF_Z - TOP_Z, 2);
    expect(parent.children).toHaveLength(1);
    expect(parent.children[0]!.floorZ).toBeCloseTo(WELL_Z - TOP_Z, 2);
  });

  it('#970 over-clip, FIXED: both the shelf ring and the well are cut to their own true floor', () => {
    const mesh = parsed(buildNestedSolid());
    const tree = treeOf(mesh);
    const result = planPocketsForTree(tree, { ...basePlanOptions([flat(4, 1)]), shadowMesh: doorGeometry(mesh) });
    // The shelf ring's own floor, well clear of the well (e.g. (12, 12), inside the 20x20 shelf,
    // outside the 10x10 well).
    const ringReach = nearestFeedAt(result, SHELF_Z - TOP_Z, 12, 12);
    // The well's own floor, its own centre.
    const wellReach = nearestFeedAt(result, WELL_Z - TOP_Z, 20, 20);
    const toolRadius = (cuttingDiameter(flat(4, 1)) ?? 0) / 2;
    expect(ringReach, `shelf ring floor (${SHELF_Z}) nearest feed to (12,12) = ${ringReach}`).toBeLessThan(toolRadius + 1);
    expect(wellReach, `well floor (${WELL_Z}) nearest feed to (20,20) = ${wellReach}`).toBeLessThan(toolRadius + 1);
  });
});

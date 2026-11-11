/**
 * #965/#898 part 2 — THE FREEING CONTOUR, RE-PLANNED OVER THE OPPOSITE SETUP'S CL SURFACE.
 *
 * `held/914-flip-plan`'s setup work (`965-setups`, sha 2063583c) left the LAST setup's freeing
 * contour a flat-Z pass to its own `tree.contour.zTo`, stated as NOT YET DONE on that branch — #965's
 * own core ask. This spec is RED-FIRST for the fix: `ops/contour.ts`'s new `oppositeSafeDepthMm`
 * parameter (the per-point clamp) and `cam/model/plan.ts`'s new `oppositeSurfaceSafeDepthMm` (the
 * frame-flip algebra that turns a non-first setup's own local (x, y) into a query against the
 * OPPOSITE setup's already-finished surface).
 *
 * THREE LAYERS, each hand-computable on its own:
 *   A. `contour()` itself — does the op actually clamp its depth to the MINIMUM safe value found
 *      along its own tool-centre path, and leave it untouched when there is no tighter constraint
 *      (the single-setup/first-of-two regression case, #959/#960)?
 *   B. `oppositeSurfaceSafeDepthMm` — the frame-flip arithmetic in total isolation from feature
 *      recognition's own uncertainties: a tiny, hand-built flat "mesh" at a KNOWN world Z stands in
 *      for "the opposite setup's finished surface," and the expected safe depth is computed by
 *      hand from the SAME formula this spec's own header derives (`d <= surfaceWorldZ - margin +
 *      stockTop`).
 *   C. `planModelCam`, end to end, on a plain two-setup box with NO feature near the freeing
 *      contour's own path — the wiring (the callback actually built, threaded through
 *      `PlanPocketsOptions` into `contourOp`, and reported in `SetupPlan.notes`) must run without
 *      throwing and must NOT over-clamp a cut that has nothing real to avoid: the posted depth
 *      stays the full nominal thickness, unchanged, which is also the sign-error canary — a
 *      backwards formula would clamp this case down to near zero instead of leaving it alone.
 */

import { describe, expect, it } from 'vitest';

import { contour } from '../../src/engine/cnc/cam/model/ops/contour';
import type { FeatureTree, SetupFrame } from '../../src/engine/cnc/cam/model/features';
import { oppositeSurfaceSafeDepthMm, planModelCam, type ModelPlanInput } from '../../src/engine/cnc/cam/model/plan';
import type { RegionRef } from '../../src/engine/cnc/cam/model/plan';
import type { Polygons, OffsetFn } from '../../src/engine/cnc/cam/pocket';
import type { CutParams } from '../../src/engine/cnc/feeds';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import { profileOf, type DropCutterMesh } from '../../src/engine/cnc/cam/model/dropcutter';
import { ARC_CHORD_TOLERANCE_MM } from '../../src/engine/compiler/arcResolution';
import type { ParsedMesh } from '../../src/engine/import/stlParser';

// ---------------------------------------------------------------------------------------------
// A. contour() — the per-point clamp, exercised directly (the SAME fake rectangle offset
//    `contourOp959.spec.ts` already uses).
// ---------------------------------------------------------------------------------------------

function rect(w: number, h: number): Polygons {
  return [[[0, 0], [w, 0], [w, h], [0, h]]];
}

const fakeRectOffset: OffsetFn = (region, delta) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of region) for (const [x, y] of c) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const w = maxX - minX - 2 * delta;
  const h = maxY - minY - 2 * delta;
  if (w <= 0 || h <= 0) return [];
  return [[[minX - delta, minY - delta], [maxX + delta, minY - delta], [maxX + delta, maxY + delta], [minX - delta, maxY + delta]]];
};

const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 });
const rapid: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const params: CutParams = { rpm: 12000, feed: 1000, plungeFeed: 300, stepDown: 2.5, stepOver: 3, peck: 0, air: true };

function region(): RegionRef {
  return { id: 'contour', kind: 'contour', bounds: { min: [0, 0], max: [20, 10] }, topZ: 0, bottomZ: -6, obstacles: [], regionClearanceZ: 5 };
}

function contourShape(): FeatureTree['contour'] {
  return { outline: rect(20, 10), area: 200, zTo: -6, frees: true, shoulders: [] };
}

// The path (tool radius 3 + the 0.005 mm offset guard, exactly `contourOp959.spec.ts`'s own
// measured corners): (-3.005, -3.005), (23.005, -3.005), (23.005, 13.005), (-3.005, 13.005).

describe('#965 contour() — the opposite-surface clamp', () => {
  it('clamps to the MINIMUM safe depth found on the path when a constraint sits at one of its corners', () => {
    // A stand-in for "the opposite setup already finished a surface 2 mm down" at BOTH corners
    // the path puts at x = 23.005 (x > 20); everywhere else states no constraint (`null`).
    const out = contour({
      cutter: flat6, contour: contourShape(), region: region(),
      depthMm: 6, tabs: { count: 0, width: 0, height: 0 },
      offset: fakeRectOffset, params, rapid,
      oppositeSafeDepthMm: (x) => (x > 20 ? 2 : null),
    });
    const op = out.ir.operations[0]!;
    // zPasses(2, 2.5): ceil(2/2.5) = 1 pass, at -min(2.5, 2) = -2 — not the nominal 6 mm's 3 passes.
    expect(op.depthPasses).toBe(1);
    const deepest = Math.min(...op.moves.map((m) => m.z));
    expect(deepest).toBeCloseTo(-2, 9);
    // ZERO CUT-INTO: no move goes past the clamped depth.
    for (const m of op.moves) expect(m.z).toBeGreaterThanOrEqual(-2 - 1e-9);
  });

  it('a constraint LOOSER than the nominal depth never makes the cut go deeper (the clamp only ever reduces)', () => {
    const out = contour({
      cutter: flat6, contour: contourShape(), region: region(),
      depthMm: 6, tabs: { count: 0, width: 0, height: 0 },
      offset: fakeRectOffset, params, rapid,
      oppositeSafeDepthMm: () => 100,
    });
    const deepest = Math.min(...out.ir.operations[0]!.moves.map((m) => m.z));
    expect(deepest).toBeCloseTo(-6, 9);
  });

  it('`null` everywhere states no constraint — the nominal depth is untouched', () => {
    const out = contour({
      cutter: flat6, contour: contourShape(), region: region(),
      depthMm: 6, tabs: { count: 0, width: 0, height: 0 },
      offset: fakeRectOffset, params, rapid,
      oppositeSafeDepthMm: () => null,
    });
    const deepest = Math.min(...out.ir.operations[0]!.moves.map((m) => m.z));
    expect(deepest).toBeCloseTo(-6, 9);
  });

  it('REGRESSION (#959/#960): omitting `oppositeSafeDepthMm` entirely behaves exactly as the pre-#965 op', () => {
    const withParam = contour({
      cutter: flat6, contour: contourShape(), region: region(),
      depthMm: 6, tabs: { count: 0, width: 0, height: 0 },
      offset: fakeRectOffset, params, rapid,
    });
    const op = withParam.ir.operations[0]!;
    expect(op.depthPasses).toBe(3); // ceil(6 / 2.5) — the original contourOp959.spec.ts assertion.
    const deepest = Math.min(...op.moves.map((m) => m.z));
    expect(deepest).toBeCloseTo(-6, 9);
  });
});

// ---------------------------------------------------------------------------------------------
// B. oppositeSurfaceSafeDepthMm — the frame-flip algebra, hand-computed against a tiny flat
//    "opposite surface" mesh standing in for "a known-height step on one face."
// ---------------------------------------------------------------------------------------------

function flatPlaneMesh(z: number, xRange: [number, number], yRange: [number, number]): DropCutterMesh {
  const [x0, x1] = xRange;
  const [y0, y1] = yRange;
  const positions = new Float32Array([
    x0, y0, z, x1, y0, z, x1, y1, z,
    x0, y0, z, x1, y1, z, x0, y1, z,
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
  return { positions, indices, triangleCount: 2 };
}

const probeFlat: Tool = flatEndMill(6, { number: 2, id: 'probe-flat-6', name: 'probe-flat-6', fluteLength: 30 });
const flatProfile = profileOf(probeFlat)!;

describe('#965 oppositeSurfaceSafeDepthMm — the flipped block, hand-computed', () => {
  // A 20 mm thick block, `stockTopZ = 0`: the TOP setup's own frame is {up:[0,0,1], stockTop:0,
  // stockBottom:-20} (frameForFace's own formula) — the opposite setup's surface sits at world Z.
  // The BOTTOM (flip, non-first) setup's own frame is {up:[0,0,-1], stockTop:20, stockBottom:0}
  // (frameForFace: stockTop = thickness - stockTopZ = 20 - 0).
  const bottomFrame: SetupFrame = { up: [0, 0, -1], stockTop: 20, stockBottom: 0 };

  it('the opposite setup already cut its own surface down to world Z = −5 at this point: setup 2 may cut 14.995 mm, not the nominal 20', () => {
    const mesh = flatPlaneMesh(-5, [-50, 50], [-50, 50]);
    const safe = oppositeSurfaceSafeDepthMm(bottomFrame, flatProfile, mesh, 0, 0);
    expect(safe).not.toBeNull();
    // By hand: worldZ(d) = d - stockTop; safe while worldZ(d) <= surfaceWorldZ - margin, i.e.
    // d <= surfaceWorldZ - margin + stockTop = -5 - ARC_CHORD_TOLERANCE_MM + 20 = 14.995.
    expect(safe!).toBeCloseTo(-5 + 20 - ARC_CHORD_TOLERANCE_MM, 9);
    expect(safe!).toBeCloseTo(14.995, 9);
    // At exactly that depth, the cut reaches world Z = -5.005 mm — 0.005 mm short of the opposite
    // surface, never past it (the margin's own purpose).
    const worldZAtSafeDepth = safe! - bottomFrame.stockTop;
    expect(worldZAtSafeDepth).toBeLessThan(-5);
  });

  it('no triangle at all under that point — states no constraint (`null`), not a guessed number', () => {
    const mesh = flatPlaneMesh(-5, [-5, 5], [-5, 5]);
    const safe = oppositeSurfaceSafeDepthMm(bottomFrame, flatProfile, mesh, 100, 100);
    expect(safe).toBeNull();
  });

  it("documentXY's own Y-mirror for the bottom flip: a LOCAL (x, -10) reads the opposite mesh at WORLD (x, 10), not (x, -10)", () => {
    // The plane covers world Y in [0, 50] only — asymmetric on purpose.
    const mesh = flatPlaneMesh(-3, [-50, 50], [0, 50]);
    const hitsAtLocalMinus10 = oppositeSurfaceSafeDepthMm(bottomFrame, flatProfile, mesh, 0, -10);
    const missesAtLocalPlus10 = oppositeSurfaceSafeDepthMm(bottomFrame, flatProfile, mesh, 0, 10);
    expect(hitsAtLocalMinus10).not.toBeNull();
    expect(missesAtLocalPlus10).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// C. planModelCam, end to end: the wiring on a plain box with no feature near the freeing
//    contour's own path — must run, must report the check in `notes`, and must NOT over-clamp.
// ---------------------------------------------------------------------------------------------

function quad(out: number[], a: [number, number, number], b: [number, number, number], c: [number, number, number], d: [number, number, number]): void {
  out.push(...a, ...b, ...c, ...a, ...c, ...d);
}

function meshOf(p: number[]): ParsedMesh {
  const positions = new Float32Array(p);
  const indices = new Uint32Array(positions.length / 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]!); maxX = Math.max(maxX, positions[i]!);
    minY = Math.min(minY, positions[i + 1]!); maxY = Math.max(maxY, positions[i + 1]!);
    minZ = Math.min(minZ, positions[i + 2]!); maxZ = Math.max(maxZ, positions[i + 2]!);
  }
  return { positions, indices, triangleCount: indices.length / 3, bbox: { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] } };
}

/** A closed box `w × d × h`, min corner at the origin (`setups965.spec.ts`'s own `box` helper). */
function box(w: number, d: number, h: number): ParsedMesh {
  const p: number[] = [];
  const [x0, x1, y0, y1, z0, z1] = [0, w, 0, d, 0, h];
  quad(p, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
  quad(p, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]);
  quad(p, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
  quad(p, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]);
  quad(p, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]);
  quad(p, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]);
  return meshOf(p);
}

const HOUSE: Tool[] = [
  flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6', fluteLength: 30 }),
  { ...flatEndMill(3, { number: 2, id: 'ball-3', name: 'ball-3', fluteLength: 30 }), typeText: 'Ball Nose', shape: 'ball' },
];

describe('#965 planModelCam — a plain two-setup box, the freeing contour wiring', () => {
  it("runs, states the check in setup 1's notes, and does NOT over-clamp when nothing opposes it", async () => {
    const thickness = 20;
    const mesh = box(40, 30, thickness);
    const input: ModelPlanInput = {
      geometry: { triangles: mesh },
      setups: [
        { frame: { up: [0, 0, 1], stockTop: thickness, stockBottom: 0 }, underside: 'flippedTabs' },
        { frame: { up: [0, 0, -1], stockTop: 0, stockBottom: -thickness }, underside: 'flippedTabs' },
      ],
      stock: { length: 40, width: 30, thickness, material: 'hardwood' },
      fixture: { mount: 'tape', envelope: null },
      cutters: { house: HOUSE, catalogue: [] },
      tolerances: { finishMm: 0.01 },
      edgeBreak: { legMm: 0 },
    };
    const output = await planModelCam(input);
    expect(output.perSetup).toHaveLength(2);

    const lastSetup = output.perSetup[1]!;
    expect(lastSetup.notes.some((n) => n.includes('bounded') && n.includes("setup 0's own finished surface"))).toBe(true);

    const contourOp = lastSetup.ops.find((o) => o.kind === 'contour');
    expect(contourOp).toBeDefined();
    const zs = contourOp!.outcome.ir.operations.flatMap((op) => op.moves.map((m) => m.z));
    const deepest = Math.min(...zs);
    // The box's own footprint has nothing standing closer than the full thickness anywhere near
    // the freeing contour's own (outward-offset, off-the-part) path, so the clamp must be a
    // no-op here: the full nominal depth (the thickness) is still what gets cut. A backwards
    // sign in the frame-flip formula would instead clamp this down to near 0.
    expect(deepest).toBeCloseTo(-thickness, 1);
  });
});

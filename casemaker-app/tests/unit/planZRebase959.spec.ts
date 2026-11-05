/**
 * #959 review item (3) — THE CURVED STAGES' Z DATUM, RED-FIRST AT stockTop = 10.
 *
 * `planPocketsForTree` rebases every Z it hands an op by `-stockTop` (one datum: IR Z 0 is the
 * STOCK top, which the post's `probed-top-face` convention and `safeZ`/`hopZ` all assume). The
 * curved half did not: `regionRefOf` and the ops took the tree's mesh-absolute Z values straight
 * through, so on any part recognised at a non-zero stockTop every curved move posts that far off
 * the stock — silently, since the IR itself is consistent.
 *
 * The reviewer's finding (plan.ts:1033, rough.ts:241, finish.ts:164, chamfer.ts:86): red-first
 * here with a ramp whose surface runs from z = 10 down to z = 2, a tree at stockTop = 10, and the
 * assertion that NOTHING feeds above Z 0 in the rebased datum, the rim's bevel at −0.5.
 */

import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const STOCK_TOP = 10;
const X0 = 2;
const X1 = 42;
const Y0 = -12;
const Y1 = 12;
const Z_LOW = 2;

const flat: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };
const vbit: Tool = flatEndMill(3.175, { number: 3, id: 'v90', name: '90 chamfer', shape: 'chamfer', typeText: 'Chamfer', angle: 90, halfAngle: 45, tipDiameter: 0.1 });

/** A ramp from z = STOCK_TOP at x = X0 down to z = Z_LOW at x = X1, and the tree that recognises it. */
function rampAtStockTop(): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  // The MESH runs well past the region's footprint (the grown finish region needs surface to the
  // drop-cutter's own reach outside it — the same margin the existing ramp fixture carries).
  const MX0 = -10, MX1 = 50, MY0 = -20, MY1 = 20;
  const zAt = (x: number): number => STOCK_TOP + ((x - X0) / (X1 - X0)) * (Z_LOW - STOCK_TOP);
  const footprint: Polygons = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
  const geometry = {
    triangles: {
      positions: Float32Array.from([
        MX0, MY0, zAt(MX0), MX1, MY0, zAt(MX1), MX1, MY1, zAt(MX1),
        MX0, MY0, zAt(MX0), MX1, MY1, zAt(MX1), MX0, MY1, zAt(MX0),
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5]),
      triangleCount: 2,
      bbox: {
        min: [MX0, MY0, Math.min(zAt(MX0), zAt(MX1))] as [number, number, number],
        max: [MX1, MY1, Math.max(zAt(MX0), zAt(MX1))] as [number, number, number],
      },
    },
  };
  const rim = {
    id: 'rim-0',
    polyline: [[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1], [X0, Y0]] as [number, number][],
    z: STOCK_TOP,
    of: 'contour' as const,
    kind: 'sharp' as const,
  };
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: STOCK_TOP, partTop: STOCK_TOP, partBottom: Z_LOW },
    levels: [Z_LOW],
    top: { z: STOCK_TOP, floors: [], area: 0 },
    contour: { outline: footprint, area: (X1 - X0) * (Y1 - Y0), zTo: Z_LOW, frees: true, shoulders: [] },
    pockets: [],
    rims: [rim],
    remainder: [{
      id: 'ramp', footprint, area: (X1 - X0) * (Y1 - Y0), zTop: STOCK_TOP, zBottom: Z_LOW,
      triangles: new Uint32Array(), slopeDeg: [0, 12], slopeMedianDeg: 11, in: 'top',
    }],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: (X1 - X0) * (Y1 - Y0), remainderArea: (X1 - X0) * (Y1 - Y0), tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, geometry };
}

describe('#959 review — the curved stages speak the STOCK-top datum', () => {
  it('with stockTop = 10, no curved or rim move posts above the clearance plane, and the rim bevel sits at −0.5', () => {
    const { tree, geometry } = rampAtStockTop();
    const result = planCurvedForTree(tree, {
      geometry,
      offset: makeClipperOffset(tl),
      flat,
      ball,
      vbit,
      stepDownMm: 1.5,
      bandMm: 0.3,
      feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: RAPID,
      spindleRpm: 12000,
      air: true,
      safeZMm: 5,
      hopZMm: 1,
      edgeBreak: { legMm: 0.5 },
      toolNumberFor: (t) => t.number ?? 1,
    });
    const moves = result.ops.flatMap((op) => op.outcome.ir.operations.flatMap((o) => o.moves));
    expect(moves.length).toBeGreaterThan(0);
    const feeds = moves.filter((m) => m.kind === 'feed');
    // The CEILING is the plan's own clearance plane (the rough's link feeds travel at
    // `regionClearanceZ` = 5 above the stock top — air, by construction). A mesh-absolute Z leaks
    // above it immediately: the unrebased plan posted feeds at 15, the half-fixed one at 10.66, and
    // the ball's own CL can stand at most its radius above the surface.
    const highest = Math.max(...feeds.map((m) => m.z));
    expect(highest, `highest feed z is ${highest} — the curved stages were not rebased to stockTop`).toBeLessThanOrEqual(5 + 1e-6);
    // The rim sits at the stock top by the tree's own (mesh-absolute) statement; its bevel is the
    // job's 0.5 mm leg BELOW that — the assertion that catches an unrebased rim.
    const chamfer = result.ops.find((op) => op.kind === 'chamfer');
    expect(chamfer, `ops: ${result.ops.map((o) => o.kind).join(', ')}`).toBeDefined();
    const chamferFeeds = chamfer!.outcome.ir.operations[0]!.moves.filter((m) => m.kind === 'feed');
    expect(Math.min(...chamferFeeds.map((m) => m.z))).toBeCloseTo(-0.5, 6);
  }, 120_000);
});

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

/**
 * A ramp from z = STOCK_TOP at x = X0 down to z = Z_LOW at x = X1, and the tree that recognises
 * it. The margin beyond the footprint is a LOW FLAT FLOOR, not a continuation of the ramp's own
 * slope — the covered-rim filter (`rimExposedFromAbove`, #959/9d8f5ef8) found the ramp's own
 * original margin design: continuing the slope past x = X0 means the mesh keeps RISING beyond
 * the shallow edge (z increases as x decreases past the ramp's own low end), so every sample the
 * filter takes there reads as covered — correctly, for a mesh that genuinely has no edge there.
 * That design tested the Z-rebase (this file's own point) on a rim that is not what a real
 * recognised part would ever produce: a single rim covering all four sides of the footprint at
 * ONE z, when only the shallow edge's OWN height happens to match it. A low floor is what an
 * actual blank's edge looks like — the rim is genuinely exposed on every side, which is also
 * what the ball's own grown-footprint query should see reaching past a real edge.
 */
function rampAtStockTop(): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  // The MESH runs well past the region's footprint (the grown finish region needs surface to the
  // drop-cutter's own reach outside it — the same margin the existing ramp fixture carries).
  const MX0 = -10, MX1 = 50, MY0 = -20, MY1 = 20;
  const FLOOR = -10; // well below Z_LOW (2) and below every rim.z - stepMm (9.8): a genuine drop.
  const zAt = (x: number): number => STOCK_TOP + ((x - X0) / (X1 - X0)) * (Z_LOW - STOCK_TOP);
  const footprint: Polygons = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
  const geometry = {
    triangles: {
      positions: Float32Array.from([
        // The ramp itself, over the footprint only.
        X0, Y0, zAt(X0), X1, Y0, zAt(X1), X1, Y1, zAt(X1),
        X0, Y0, zAt(X0), X1, Y1, zAt(X1), X0, Y1, zAt(X0),
        // The low floor, covering the WHOLE margin (including under the ramp — `topSurfaceAt`'s
        // own max-over-triangles means the ramp's own higher surface still wins there).
        MX0, MY0, FLOOR, MX1, MY0, FLOOR, MX1, MY1, FLOOR,
        MX0, MY0, FLOOR, MX1, MY1, FLOOR, MX0, MY1, FLOOR,
      ]),
      indices: Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      triangleCount: 4,
      bbox: {
        min: [MX0, MY0, FLOOR] as [number, number, number],
        max: [MX1, MY1, STOCK_TOP] as [number, number, number],
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

/**
 * A groove 6 mm wide, 0.8 mm deep in a plane at stockTop: the ⌀6 flat bridges it (its CL stays at
 * the land) while the ⌀3.175 rest flat descends into it — the one geometry where a rest pass has
 * real work, needed to prove the REST stage's datum (the ramp cannot: its mask stripe is narrower
 * than the rest cutter, the op's own stated limitation).
 */
function grooveAtStockTop(): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  const MX0 = 0, MX1 = 42, MY0 = -12, MY1 = 12;
  // A 4 mm groove: the ⌀6 flat BRIDGES it (4 < its 6 mm width, so its CL stays at the land) while
  // a ⌀1 rest flat descends — the strip it can reach, 4 - 1 = 3 mm, fits that cutter, so
  // `pocketLoops` finds loops. Wider grooves let the ⌀6 in (no rest work at all), and a 3.175 mm
  // rest leaves a strip narrower than itself (the op's stated narrow-mask limitation).
  const GX0 = 19, GX1 = 23;
  const TOP = STOCK_TOP;
  const BOTTOM = STOCK_TOP - 0.8;
  const footprint: Polygons = [[[2, -12], [42, -12], [42, 12], [2, 12]]];
  const positions: number[] = [];
  const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number): void => {
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
  };
  quad(MX0, MY0, TOP, GX0, MY0, TOP, GX0, MY1, TOP, MX0, MY1, TOP);
  quad(GX1, MY0, TOP, MX1, MY0, TOP, MX1, MY1, TOP, GX1, MY1, TOP);
  quad(GX0, MY0, BOTTOM, GX1, MY0, BOTTOM, GX1, MY1, BOTTOM, GX0, MY1, BOTTOM);
  quad(GX0, MY0, TOP, GX0, MY0, BOTTOM, GX0, MY1, BOTTOM, GX0, MY1, TOP);
  quad(GX1, MY0, BOTTOM, GX1, MY0, TOP, GX1, MY1, TOP, GX1, MY1, BOTTOM);
  const arr = Float32Array.from(positions);
  const geometry = {
    triangles: {
      positions: arr,
      indices: Uint32Array.from({ length: arr.length / 3 }, (_, i) => i),
      triangleCount: arr.length / 9,
      bbox: { min: [MX0, MY0, BOTTOM] as [number, number, number], max: [MX1, MY1, TOP] as [number, number, number] },
    },
  };
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: STOCK_TOP, partTop: STOCK_TOP, partBottom: BOTTOM },
    levels: [BOTTOM],
    top: { z: STOCK_TOP, floors: [], area: 0 },
    contour: { outline: footprint, area: 800, zTo: BOTTOM, frees: true, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [{
      id: 'groove', footprint, area: 800, zTop: TOP, zBottom: BOTTOM,
      triangles: new Uint32Array(), slopeDeg: [0, 90], slopeMedianDeg: 45, in: 'top',
    }],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 800, remainderArea: 800, tolerances: {} as never, slivers: [], notes: [] },
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
    // THE COVERED-RIM RULE (#959, 9d8f5ef8): this fixture's mesh is margin-extended past the
    // footprint for the finish region's own reach — the SAME reason `opsAcceptance959`'s ramp rim
    // is skipped. The rim sits at the stock top by the tree's own (mesh-absolute) statement; its
    // bevel would be the job's 0.5 mm leg BELOW that — the assertion that catches an unrebased
    // rim — but only when the rim is actually broken. A real edge (the tray/organizer cases) is
    // where the chamfer-Z assertion lives now; here it is conditional, same as its sibling.
    const chamfer = result.ops.find((op) => op.kind === 'chamfer');
    expect(chamfer, `ops: ${result.ops.map((o) => o.kind).join(', ')}; notes: ${result.notes.join('; ')}`).toBeDefined();
    const chamferFeeds = chamfer!.outcome.ir.operations[0]!.moves.filter((m) => m.kind === 'feed');
    expect(Math.min(...chamferFeeds.map((m) => m.z))).toBeCloseTo(-0.5, 6);
  }, 120_000);

  it('the REST stage too: stockTop = 10 with a rest flat, its mask and its feeds on one datum', () => {
    const { tree, geometry } = grooveAtStockTop();
    const small = flatEndMill(1, { number: 4, id: 'flat-1', name: 'flat-1' });
    const result = planCurvedForTree(tree, {
      geometry,
      offset: makeClipperOffset(tl),
      flat,
      ball,
      vbit,
      restFlat: small,
      // The rest cuts where a Z LEVEL falls inside its CL-difference band; 0.3 mm steps put one
      // (9.7, rebased -0.3) inside the groove's band on this fixture.
      stepDownMm: 0.3,
      bandMm: 0.3,
      feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: RAPID,
      spindleRpm: 12000,
      air: true,
      safeZMm: 5,
      hopZMm: 1,
      edgeBreak: { legMm: 0 },
      toolNumberFor: (t) => t.number ?? 1,
    });
    const restOp = result.ops.find((op) => op.kind === 'rest');
    expect(restOp, `ops: ${result.ops.map((o) => o.kind).join(', ')}; notes: ${result.notes.join('; ')}`).toBeDefined();
    const restFeeds = restOp!.outcome.ir.operations.flatMap((o) => o.moves).filter((m) => m.kind === 'feed');
    expect(restFeeds.length).toBeGreaterThan(0);
    const highest = Math.max(...restFeeds.map((m) => m.z));
    expect(highest, `the rest posted feeds at z = ${highest} — the rest stage is not on the stock-top datum`).toBeLessThanOrEqual(5 + 1e-6);
  }, 120_000);
});

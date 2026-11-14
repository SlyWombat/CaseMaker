// #965 — THE REST BALL, RED-FIRST (the review session's ruling, item 3.1).
//
// The figures' leftover is the ⌀2 ball's own fillet and the slots its radius cannot enter. A
// smaller ball whose STATED reach covers the region removes it — the vendor's long ⌀1
// (6*1*30.5mm Ball Nose Engraving) — by running the finish's machinery a second time over the
// cells where the ⌀2's own CL still stands above the design by more than the band.
//
// The fixture is a flat plate with a 1.2 mm-wide, 2 mm-deep slot: a ⌀2 ball bridges the slot (its
// CL stops 0.3 mm above the plate, 1.8 mm above the slot's floor), a ⌀1 enters it (its CL reaches
// the floor). Red at `ea8f8510`: the plan runs one ball and the slot's floor is never cut. Green
// with the rest ball: a rest op with the ⌀1 feeds at the slot's floor.
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '../../src/engine/cnc/cam/engraveJob';
import { planCurvedForTree } from '../../src/engine/cnc/cam/model/plan';
import type { FeatureTree } from '../../src/engine/cnc/cam/model/features';
import type { RapidEstimate } from '../../src/engine/cnc/cam/ir';
import type { Polygons } from '../../src/engine/cnc/cam/pocket';
import { flatEndMill, type Tool } from '../../src/engine/cnc/tool';

const RAPID: RapidEstimate = { xyMmPerMin: 1200, zMmPerMin: 600, accelMmPerS2: 150, source: 'test fixture' };
const PLATE = -0.5;
const SLOT_FLOOR = -2.5;
const SLOT_X0 = 9.4;
const SLOT_X1 = 10.6;
const FOOT: Polygons = [[[0, -5], [20, -5], [20, 5], [0, 5]]];

const flat6 = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball2: Tool = { ...flatEndMill(2, { number: 2, id: 'ball-2', name: 'ball-2' }), shape: 'ball', typeText: 'Ball Nose' };
/** The catalogue's long ⌀1 (161032105031): a 1 mm ball on a 6 mm shank with a 30.5 mm flute. */
const ball1: Tool = { ...flatEndMill(1, { number: 3, id: '161032105031', name: '6*1*30.5mm Ball Nose Engraving' }), shape: 'ball', typeText: 'Ball Nose Engraving', handleDiameter: 6, fluteLength: 30.5, shoulderLength: 30.5 };

/** A heightfield plate with the slot running along y — the plan's own mesh, fine enough for 1.2 mm. */
function plateWithSlot(): { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } {
  const STEP = 0.2;
  const X0 = -10, X1 = 30, Y0 = -10, Y1 = 10;
  const nx = Math.round((X1 - X0) / STEP) + 1;
  const ny = Math.round((Y1 - Y0) / STEP) + 1;
  const positions: number[] = [];
  const indices: number[] = [];
  const zAt = (x: number): number => (x >= SLOT_X0 && x <= SLOT_X1 ? SLOT_FLOOR : PLATE);
  const vert = (x: number, y: number): number => {
    positions.push(x, y, zAt(x));
    return positions.length / 3 - 1;
  };
  // Vertices on a lattice; each cell two triangles with correct up-facing winding.
  const grid: number[][] = [];
  for (let j = 0; j < ny; j++) {
    grid.push([]);
    for (let i = 0; i < nx; i++) grid[j]!.push(vert(X0 + i * STEP, Y0 + j * STEP));
  }
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = grid[j]![i]!, b = grid[j]![i + 1]!, c = grid[j + 1]![i + 1]!, d = grid[j + 1]![i]!;
      indices.push(a, b, c, a, c, d);
    }
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleCount: indices.length / 3,
    bbox: { min: [X0, Y0, SLOT_FLOOR], max: [X1, Y1, PLATE] },
  };
}

function tree(): FeatureTree {
  return {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: SLOT_FLOOR },
    levels: [SLOT_FLOOR],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: FOOT, area: 100, zTo: SLOT_FLOOR, frees: true, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [{
      id: 'slot-region', footprint: FOOT, area: 100, zTop: PLATE, zBottom: SLOT_FLOOR,
      triangles: new Uint32Array(), slopeDeg: [0, 45], slopeMedianDeg: 20, in: 'top',
    }],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 100, remainderArea: 100, tolerances: {} as never, slivers: [], notes: [] },
  };
}

function plan(withRestBall: boolean) {
  return planCurvedForTree(tree(), {
    geometry: { triangles: plateWithSlot() },
    offset: makeClipperOffset(tl),
    flat: flat6,
    ball: ball2,
    ...(withRestBall ? { restBalls: [ball1] } : {}),
    stepDownMm: 1.5,
    bandMm: 0.3,
    feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
    rapid: RAPID,
    spindleRpm: 12000,
    air: true,
    safeZMm: 5,
    hopZMm: 1,
    edgeBreak: { legMm: 0 },
    toolNumberFor: (t: Tool) => t.number ?? 1,
  } as never);
}

/** The deepest feed the plan puts INSIDE the slot's span — the number the ⌀2 cannot reach. */
function deepestFeedInSlot(result: ReturnType<typeof plan>): number {
  let deepest = Infinity;
  for (const op of result.ops) {
    for (const ir of op.outcome.ir.operations) {
      for (const m of ir.moves) {
        if (m.kind !== 'feed') continue;
        if (m.x < SLOT_X0 + 0.05 || m.x > SLOT_X1 - 0.05) continue;
        if (m.z < deepest) deepest = m.z;
      }
    }
  }
  return deepest;
}

describe('#965 the rest ball — a slot only a ⌀1 enters', () => {
  it('without the rest ball the slot stays uncut; the ⌀1 rest reaches its floor', () => {
    const withoutRest = plan(false);
    const deepestBallOnly = deepestFeedInSlot(withoutRest);
    // The ⌀2 bridges the 1.2 mm slot: its CL stops at PLATE + sqrt(2^2/4 - 0.6^2) - 1 ≈ -0.7.
    expect(deepestBallOnly).toBeGreaterThan(SLOT_FLOOR + 1.0);

    const withRest = plan(true);
    const restOps = withRest.ops.filter((op) => op.kind === 'rest');
    expect(restOps.length, 'the rest ball was not planned').toBeGreaterThan(0);
    expect(restOps.some((op) => op.outcome.cutter === '161032105031')).toBe(true);
    const deepest = deepestFeedInSlot(withRest);
    // The plan's CL surface samples on its own grid, so the last increment can stand a fraction
    // above the exact floor; the class is 'entered the slot the ⌀2 could not', not a depth promise.
    expect(deepest, 'the rest pass never reached the slot floor').toBeLessThanOrEqual(SLOT_FLOOR + 0.25);
  }, 180_000);
});

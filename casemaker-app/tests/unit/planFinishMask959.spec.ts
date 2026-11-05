/**
 * #959 review item (4a) — THE FINISH MASKS TO THE FLAT'S LEFTOVER. RED-FIRST.
 *
 * The manager's ruling and its formula (the handover's correction): leftover(cell) =
 * flatSwept(cell) − design(cell), flatSwept from the flat's swept passes over their real
 * footprint, design from the goal/mesh top; the ball's finish cuts ONLY where that leftover is
 * above the band, plus one ball footprint of margin. Today the finish rasters the whole region —
 * shallow ground where the flat already stands within the band included.
 *
 * Fixture: a plane with two halves. In x < 22 it falls at slope 0.02, so a ⌀6 flat's own CL stands
 * slope × radius = 0.06 above the design — under the 0.3 band, nothing for the ball to finish. In
 * x > 22 it falls at slope 0.2, so the flat's CL stands 0.6 above — over the band, the ball's
 * work. Red here: finish feeds reach x ≈ 2. Green: they stay on the steep half, allowing the ball
 * one footprint of margin.
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
const X0 = 2;
const X1 = 42;
const Y0 = -12;
const Y1 = 12;
const KNEE = 22;
const BAND = 0.3;

const flat: Tool = flatEndMill(6, { number: 1, id: 'flat-6', name: 'flat-6' });
const ball: Tool = { ...flatEndMill(6, { number: 2, id: 'ball-6', name: 'ball-6' }), shape: 'ball', typeText: 'Ball Nose' };

/** A plane that falls gently to the knee and steeply after it — continuous at the knee. */
function zAt(x: number): number {
  const shallow = -0.02 * (x - X0);
  const atKnee = -0.02 * (KNEE - X0);
  return x <= KNEE ? shallow : atKnee - 0.2 * (x - KNEE);
}

function twoZone(): { tree: FeatureTree; geometry: { triangles: { positions: Float32Array; indices: Uint32Array; triangleCount: number; bbox: { min: [number, number, number]; max: [number, number, number] } } } } {
  const MX0 = -10, MX1 = 50, MY0 = -20, MY1 = 20;
  const footprint: Polygons = [[[X0, Y0], [X1, Y0], [X1, Y1], [X0, Y1]]];
  const positions: number[] = [];
  const quad = (ax: number, bx: number): void => {
    positions.push(ax, MY0, zAt(ax), bx, MY0, zAt(bx), bx, MY1, zAt(bx), ax, MY0, zAt(ax), bx, MY1, zAt(bx), ax, MY1, zAt(ax));
  };
  quad(MX0, KNEE);
  quad(KNEE, MX1);
  const arr = Float32Array.from(positions);
  const geometry = {
    triangles: {
      positions: arr,
      indices: Uint32Array.from({ length: arr.length / 3 }, (_, i) => i),
      triangleCount: arr.length / 9,
      bbox: {
        min: [MX0, MY0, zAt(MX1)] as [number, number, number],
        max: [MX1, MY1, zAt(MX0)] as [number, number, number],
      },
    },
  };
  const tree: FeatureTree = {
    frame: { up: [0, 0, 1], stockTop: 0, partTop: 0, partBottom: zAt(X1) },
    levels: [zAt(X1)],
    top: { z: 0, floors: [], area: 0 },
    contour: { outline: footprint, area: (X1 - X0) * (Y1 - Y0), zTo: zAt(X1), frees: true, shoulders: [] },
    pockets: [],
    rims: [],
    remainder: [{
      id: 'twins', footprint, area: (X1 - X0) * (Y1 - Y0), zTop: 0, zBottom: zAt(X1),
      triangles: new Uint32Array(), slopeDeg: [1, 12], slopeMedianDeg: 6, in: 'top',
    }],
    unreachable: [],
    report: { source: 'mesh', patches: 1, planarArea: 960, remainderArea: 960, tolerances: {} as never, slivers: [], notes: [] },
  };
  return { tree, geometry };
}

describe('#959 review — the finish masks to the flat’s leftover', () => {
  it('a shallow half the flat already holds is not finished; the steep half is', () => {
    const { tree, geometry } = twoZone();
    const result = planCurvedForTree(tree, {
      geometry,
      offset: makeClipperOffset(tl),
      flat,
      ball,
      stepDownMm: 1.5,
      bandMm: BAND,
      feeds: { feedMmPerMin: 900, plungeFeedMmPerMin: 250 },
      rapid: RAPID,
      spindleRpm: 12000,
      air: true,
      safeZMm: 5,
      hopZMm: 1,
      edgeBreak: { legMm: 0 },
      toolNumberFor: (t) => t.number ?? 1,
    });
    const finishOp = result.ops.find((op) => op.kind === 'finish');
    expect(finishOp, `ops: ${result.ops.map((o) => o.kind).join(', ')}; notes: ${result.notes.join('; ')}`).toBeDefined();
    const all = finishOp!.outcome.ir.operations.flatMap((o) => o.moves);
    // Lateral FEEDS only (links and plunges are vertical or travel; the question is where it cuts).
    const cutXs: number[] = [];
    let prev: (typeof all)[number] | null = null;
    for (const m of all) {
      const lateral = prev !== null && Math.hypot(m.x - prev.x, m.y - prev.y) > 1e-6;
      if (m.kind === 'feed' && lateral) cutXs.push(m.x);
      prev = m;
    }
    expect(cutXs.length, 'the finish cut nothing at all').toBeGreaterThan(10);
    // The steep half must be finished: some cut at x > KNEE.
    expect(Math.max(...cutXs)).toBeGreaterThan(KNEE + 2);
    // The shallow half must not be: one ball footprint of margin allowed (⌀6 ball: 3 mm radius,
    // plus the raster's own step-over at the steepest slope).
    const margin = 4;
    const shallowCuts = cutXs.filter((x) => x < KNEE - margin);
    expect(
      shallowCuts.length,
      `the finish cut ${shallowCuts.length} feed points on the shallow half (x as low as ${Math.min(...cutXs).toFixed(1)}) — the flat already stands within the band there`,
    ).toBe(0);
  }, 120_000);
});

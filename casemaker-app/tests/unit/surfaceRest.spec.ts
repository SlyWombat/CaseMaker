// #847 — THE REST PASS OVER WHAT A FINISH LEFT. The rest program is the SAME finishing raster run
// with a smaller ball over the finish's residual (dilated by the ball's radius), and the pick
// compares candidate balls by the residual their own tip field leaves, then by time.
import { describe, expect, it } from 'vitest';
import {
  finishTipField,
  planSurfaceRest,
  restResidualVisible,
  suggestedRestRadiusMm,
  surfaceResidual,
  type GoalHeightfield,
  type SurfaceFeeds,
} from '@/engine/cnc/cam/surface3d';
import type { RapidEstimate } from '@/engine/cnc/cam/ir';

/** The same V-valley as the residual spec: 1 mm of rise per 0.5 mm of X either side of centre. */
function valley(): GoalHeightfield {
  const nx = 41;
  const ny = 9;
  const pitch = 0.5;
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      z[j * nx + i] = Math.min(4, Math.abs(i - 20) * 1);
    }
  }
  const covered = new Uint8Array(nx * ny);
  let coveredCount = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (i >= 2 && i < nx - 2 && j >= 2 && j < ny - 2) {
        covered[j * nx + i] = 1;
        coveredCount += 1;
      }
    }
  }
  return {
    nx,
    ny,
    x0: 0,
    y0: 0,
    pitch,
    // The goal's plate IS the stock top (a V cut into it): beyond the footprint is the same 4 mm
    // face, so the ball only rides up in the valley, not at the grid's edge.
    topZ: 4,
    minZ: 0,
    z,
    covered,
    coveredCount,
    resolutionNote: 'test grid',
  };
}

const FEEDS: SurfaceFeeds = {
  feed: 800,
  plungeFeed: 300,
  stepDown: 1,
  roughStepOver: 1,
  finishStepOver: 0.5,
};
const RAPID: RapidEstimate = { xyMmPerMin: 5000, zMmPerMin: 1000, accelMmPerS2: 400, source: 'test' };

describe('#847 planSurfaceRest', () => {
  it('cuts only the tight concavity, and a smaller ball leaves less than the finish did', () => {
    const hf = valley();
    const finishResidual = surfaceResidual(hf, finishTipField(hf, { ball: true, radius: 3 }), 0, 1e-6);
    const plan = planSurfaceRest({
      heightfield: hf,
      residual: finishResidual,
      tool: { ball: true, radius: 1 },
      feeds: FEEDS,
      rapid: RAPID,
      stockToLeaveMm: 0,
      toleranceMm: 1e-6,
    });

    // The rest pass lowers what the finish left: the material still above the goal drops.
    expect(plan.residual.volumeMm3).toBeLessThan(finishResidual.volumeMm3);
    expect(plan.residual.deepestMm).toBeLessThan(finishResidual.deepestMm);

    // It cuts the valley's root and nothing else: the fixture's plate spans X 0–20, the V spans
    // X 8–12, and the region can reach one ball radius (1 mm) past the residual's own cells.
    expect(plan.moves.length).toBeGreaterThan(0);
    const xs = plan.moves.map((m) => m.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(7);
    expect(Math.max(...xs)).toBeLessThanOrEqual(13);
    expect(plan.estimatedSeconds).toBeGreaterThan(0);
    expect(plan.dilationMm).toBe(1);
  });

  it('a rest pass that lowers nothing is recognisably no better: a ball as big as the finish', () => {
    const hf = valley();
    const finishTip = finishTipField(hf, { ball: true, radius: 3 });
    const finishResidual = surfaceResidual(hf, finishTip, 0, 1e-6);
    // The SAME radius: its tip field is the finish's own, so the residual cannot drop. (The goal
    // path never offers such a candidate; this pins the comparison the pick makes.)
    const plan = planSurfaceRest({
      heightfield: hf,
      residual: finishResidual,
      tool: { ball: true, radius: 3 },
      feeds: FEEDS,
      rapid: RAPID,
      stockToLeaveMm: 0,
      toleranceMm: 1e-6,
    });
    expect(plan.residual.volumeMm3).toBeCloseTo(finishResidual.volumeMm3, 9);
  });
});

describe('#847 restResidualVisible', () => {
  it('the leftover is visible past the depth the shop states, or past its stated share', () => {
    const hf = valley();
    const res = surfaceResidual(hf, finishTipField(hf, { ball: true, radius: 3 }), 0, 1e-6);
    // The valley leaves material 1.5 mm up: past a 0.1 mm depth, under a 10 mm one.
    expect(res.removedMm3).toBeGreaterThan(0);
    expect(restResidualVisible(res, 0.1, 1).visible).toBe(true);
    expect(restResidualVisible(res, 10, 1).visible).toBe(false);
    // The share clause alone: a 10 mm depth that hides any ridge, a 0 % share that any leftover beats.
    expect(restResidualVisible(res, 10, 0).visible).toBe(true);
    expect(restResidualVisible(res, 10, 1).share).toBeGreaterThan(0);
  });
});

describe('#847 suggestedRestRadiusMm', () => {
  it('names a smaller ball that would reach what the finish left', () => {
    const hf = valley();
    const finishTool = { ball: true, radius: 3 };
    const finishResidual = surfaceResidual(hf, finishTipField(hf, finishTool), 0, 1e-6);
    const radius = suggestedRestRadiusMm(hf, finishResidual, finishTool, 0, 1e-6);
    expect(radius).not.toBeNull();
    expect(radius as number).toBeLessThan(3);
    expect(radius as number).toBeGreaterThan(0);
  });

  it('there is nothing to suggest when the finish already reached the goal', () => {
    const hf = valley();
    const finishTool = { ball: true, radius: 0.5 };
    const finishResidual = surfaceResidual(hf, finishTipField(hf, finishTool), 0, 1);
    expect(finishResidual.cells).toBe(0);
    expect(suggestedRestRadiusMm(hf, finishResidual, finishTool, 0, 1)).toBeNull();
  });
});

// #847 — WHAT A 3D FINISH LEFT. The finish's gouge-safe tip field is the surface its program
// cuts; where a concavity is tighter than the ball, the tip rests above the goal and that rise is
// the material the big ball cannot take. The rest pass is planned from this measurement.
import { describe, expect, it } from 'vitest';
import { surfaceResidual } from '@/engine/cnc/cam/surface3d';
import { finishTipField } from '@/engine/cnc/cam/surfaceFinishTipField';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

/** A V-valley 1 mm wide per side on a flat plate: walls rise 1 mm per 0.5 mm of X away from centre. */
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
  // Only the inner cells are covered: a goal's sampler leaves a border, and the tip field treats
  // off-grid neighbours as uncut stock (topZ) — a covered border cell would ride on the phantom top.
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
    topZ: 10,
    minZ: 0,
    z,
    covered,
    coveredCount,
    resolutionNote: 'test grid',
  };
}

describe('#847 surfaceResidual', () => {
  it('a ball wider than the valley cannot reach its floor, and the rise is measured with its volume', () => {
    const hf = valley();
    const big = finishTipField(hf, { ball: true, radius: 3 }, 1e9);
    const res = surfaceResidual(hf, big, 0, 1e-6);
    expect(res.cells).toBeGreaterThan(0);
    expect(res.volumeMm3).toBeGreaterThan(0);
    // The valley floor stands below the walls by 4 mm; the ball rests a good way up it.
    expect(res.deepestMm).toBeGreaterThan(0.5);
    // The residual sits at the valley's floor cells, not on the flat plate.
    expect(res.mask[4 * hf.nx + 20]).toBe(1);
  });

  it('a ball that fits the valley leaves no residual, and the stock-to-leave is not residual', () => {
    const hf = valley();
    const small = finishTipField(hf, { ball: true, radius: 0.5 }, 1e9);
    // The small ball's rise at this V is half a cell of wall (0.5 mm); under a 1 mm tolerance the
    // finish has reached everything the job means to cut — the mask is empty, not the volume zero.
    expect(surfaceResidual(hf, small, 0, 1).cells).toBe(0);
    const big = finishTipField(hf, { ball: true, radius: 3 }, 1e9);
    // An allowance above every rise counts as intended material, not residual.
    expect(surfaceResidual(hf, big, 10, 1e-6).cells).toBe(0);
  });
});

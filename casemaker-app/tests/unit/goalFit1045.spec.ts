// #1045 — ONE "FITS THE BLANK" TOLERANCE. The panel's overhang row reads the document's stored size
// (three decimals); the CAM seam re-measures the mesh's own vertices. On j28 those two readings
// differ by 1.59 µm (stored 66.404 against the mesh's true 66.4040059 at scale 36/66.404), the seam's
// old 1e-6 tolerance refused the app's own fit, and its one-decimal sentence printed "0.0 mm".
//
// These are the panel-side cases of the shared tolerance and its sentence; the seam's own end-to-end
// cases (a real generate on both readings) live in goalCorpus873.spec.ts.

import { describe, it, expect } from 'vitest';
import { GOAL_FIT_TOLERANCE_MM, goalStockOverhang } from '@/engine/cnc/engrave/goalPlacement';

const RECT = { xMin: 0, xMax: 36, yMin: 0, yMax: 100 };

/** A goal whose placed X extent is `widthMm`, centred at `positionX` on the 36 x 100 blank's top. */
function target(widthMm: number, positionX = 18) {
  return {
    format: 'stl' as const,
    scale: { x: 1, y: 1, z: 1 },
    size: { x: widthMm, y: 20, z: 10 },
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    position: { x: positionX, y: 50, z: 0 },
    name: 'goal.stl',
  };
}

describe('#1045 the goal-fit tolerance', () => {
  it('is 0.01 mm — two orders above float32 noise at a 66 mm goal, far below a cutter’s notice', () => {
    expect(GOAL_FIT_TOLERANCE_MM).toBe(0.01);
  });

  it('absorbs an overhang below the tolerance and still refuses a real miss, in two decimals', () => {
    // The j28 class: the two readings of one goal differ by ~0.0016 mm (1.59 µm lives inside it).
    const noise = goalStockOverhang(target(36.0016), RECT);
    expect(noise.fits).toBe(true);
    expect(noise.sentence).toBe('');

    // A real miss is refused, and 0.05 mm never prints as "0.0 mm past".
    const miss = goalStockOverhang(target(36, 18 - 0.05), RECT);
    expect(miss.fits).toBe(false);
    expect(miss.sides).toEqual([{ side: 'left', mm: expect.closeTo(0.05, 6) }]);
    expect(miss.sentence).toContain('0.05 mm past the left edge');
  });

  it('a caller can still ask for an exact reading by passing its own tolerance', () => {
    const exact = goalStockOverhang(target(36.0016), RECT, 1e-6);
    expect(exact.fits).toBe(false);
  });
});

/**
 * #965 — `cam/model/wholeSurface.ts`'s `unionWholeSurface`, ported from
 * `held/948-whole-surface-v2`'s `goalWholeSurface.ts` (`703fa730`). The port is close to
 * verbatim (plain grid/mask data, no old-engine dependency), so these cases are the same shapes
 * that module's own behaviour implies: a single top setup reads as its own whole-surface number,
 * a second setup's mask (through its own affine) adds coverage, and a named exclusion shrinks the
 * denominator rather than the numerator.
 */
import { describe, expect, it } from 'vitest';

import { unionWholeSurface, type GoalSetupSurface, type GoalSurfaceGrid } from '@/engine/cnc/cam/model/wholeSurface';

const GRID: GoalSurfaceGrid = { nx: 4, ny: 1, x0: 0, y0: 0, pitch: 1 };

function mask(bits: number[]): Uint8Array {
  return Uint8Array.from(bits);
}

describe('#965 unionWholeSurface', () => {
  it('a single top setup, no affine: its own mask is the whole-surface read', () => {
    const top: GoalSetupSurface = { grid: GRID, covered: mask([1, 1, 1, 1]), reached: mask([1, 1, 0, 0]) };
    const result = unionWholeSurface(GRID, [top]);
    expect(result?.fraction).toBeCloseTo(0.5, 9);
    expect(result?.coveredCells).toBe(4);
    expect(result?.reachedCells).toBe(2);
    expect(result?.setups).toBe(1);
  });

  it('a second setup adds the cells the first did not reach', () => {
    const top: GoalSetupSurface = { grid: GRID, covered: mask([1, 1, 0, 0]), reached: mask([1, 1, 0, 0]) };
    const bottom: GoalSetupSurface = { grid: GRID, covered: mask([0, 0, 1, 1]), reached: mask([0, 0, 1, 1]) };
    const result = unionWholeSurface(GRID, [top, bottom]);
    expect(result?.fraction).toBeCloseTo(1, 9);
    expect(result?.coveredCells).toBe(4);
    expect(result?.setups).toBe(2);
  });

  it("a Y-mirror affine (the vise flip's own document map) remaps a flipped setup's grid before the union", () => {
    // The flipped setup's own local grid runs 0..3 too, but its cell i's REACHED bit belongs at
    // document cell (3 - i) under a mirror — expressed here as the affine `documentXY` itself
    // would produce for a 1-D stand-in (flip around the grid's own centre).
    const top: GoalSetupSurface = { grid: GRID, covered: mask([1, 1, 0, 0]), reached: mask([1, 1, 0, 0]) };
    const flipped: GoalSetupSurface = {
      grid: GRID,
      covered: mask([0, 0, 1, 1]),
      reached: mask([0, 0, 1, 1]),
      toDocument: [-1, 0, 3, 0, 1, 0],
    };
    const result = unionWholeSurface(GRID, [top, flipped]);
    // flipped's covered cells (i=2,3) map to document i = 3-2=1, 3-3=0 — both already covered by
    // `top`, so the union's coverage is unchanged (4 total minus the un-covered i=2,3 slots, which
    // nothing now maps TO) rather than growing — the affine is exercised, not merely the identity.
    expect(result?.coveredCells).toBe(2);
    expect(result?.reachedCells).toBe(2);
    expect(result?.fraction).toBeCloseTo(1, 9);
  });

  it('a named exclusion shrinks the denominator, not the numerator', () => {
    const top: GoalSetupSurface = {
      grid: GRID,
      covered: mask([1, 1, 1, 1]),
      reached: mask([1, 1, 0, 0]),
      excluded: { reason: 'stock-bottom', areaMm2: 2, face: 'the 36 × 100 face on the stock bottom' },
    };
    const result = unionWholeSurface(GRID, [top]);
    expect(result?.coveredCells).toBe(4);
    expect(result?.excludedCells).toBe(2);
    expect(result?.cells).toBe(2);
    expect(result?.reachedCells).toBe(2);
    expect(result?.fraction).toBeCloseTo(1, 9);
    expect(result?.excludedFace).toBe('the 36 × 100 face on the stock bottom');
  });

  it('null when no setup covers any goal cell', () => {
    const empty: GoalSetupSurface = { grid: GRID, covered: mask([0, 0, 0, 0]), reached: mask([0, 0, 0, 0]) };
    expect(unionWholeSurface(GRID, [empty])).toBeNull();
  });
});

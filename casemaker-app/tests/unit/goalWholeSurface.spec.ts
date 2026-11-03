/**
 * #948 review §4.1 — THE WHOLE-SURFACE PASS LINE.
 *
 * The pass line is the share of the goal's WHOLE surface reproduced within the leftover band
 * after every setup the app proposes — not the top-surface band. These tests pin the red-first
 * case the decision asks for: a two-setup synthetic goal whose top setup reads 60 % while the
 * union over both setups reads 100 %, so the run passes only on the whole-surface metric; the
 * single top setup's identity (its top number IS its whole-surface reach, stated); and the
 * excluded underside as a NAMED job fact, never a silent subtraction.
 */

import { describe, expect, it } from 'vitest';

import { checkGoalCutInto } from '@/engine/cnc/engrave/designCheck';
import {
  unionWholeSurface,
  type GoalSetupSurface,
  type GoalSurfaceGrid,
} from '@/engine/cnc/engrave/goalWholeSurface';
import type { GoalHeightfield } from '@/engine/cnc/cam/surface3d';

const GRID: GoalSurfaceGrid = { nx: 10, ny: 10, x0: 0, y0: 0, pitch: 1 };

/** A mask on `grid`: covered on every cell, reached on the rows `[from, to)`. */
function rowsMask(
  grid: GoalSurfaceGrid,
  from: number,
  to: number,
  overrides: Partial<GoalSetupSurface> = {},
): GoalSetupSurface {
  const covered = new Uint8Array(grid.nx * grid.ny).fill(1);
  const reached = new Uint8Array(grid.nx * grid.ny);
  for (let j = from; j < to; j++) for (let i = 0; i < grid.nx; i++) reached[j * grid.nx + i] = 1;
  return { grid, covered, reached, ...overrides };
}

/** The goal: flat at 0 on every cell, covered. */
function flatGoal(): GoalHeightfield {
  return {
    nx: GRID.nx,
    ny: GRID.ny,
    x0: GRID.x0,
    y0: GRID.y0,
    pitch: GRID.pitch,
    z: new Float32Array(GRID.nx * GRID.ny),
    covered: new Uint8Array(GRID.nx * GRID.ny).fill(1),
  } as GoalHeightfield;
}

describe('#948 whole-surface reach — the union over the proposed setups', () => {
  it('a single top setup is its own number: the top-surface read, unchanged', () => {
    const union = unionWholeSurface(GRID, [rowsMask(GRID, 0, 6)]);
    expect(union).not.toBeNull();
    expect(union?.setups).toBe(1);
    expect(union?.cells).toBe(100);
    expect(union?.reachedCells).toBe(60);
    expect(union?.fraction).toBeCloseTo(0.6, 12);
  });

  it('two setups union to the whole surface: top 60 %, bottom the remaining 40 % → 100 %', () => {
    // The bottom setup's mask lives on ITS grid (the top four document rows) and maps back to the
    // document's last four rows — the affine the flip plan will hand (#945's interface shape).
    const bottomGrid: GoalSurfaceGrid = { nx: 10, ny: 4, x0: 0, y0: 0, pitch: 1 };
    const bottom = rowsMask(bottomGrid, 0, 4, { toDocument: [1, 0, 0, 0, 1, 6] });
    const union = unionWholeSurface(GRID, [rowsMask(GRID, 0, 6), bottom]);
    expect(union?.setups).toBe(2);
    expect(union?.reachedCells).toBe(100);
    expect(union?.fraction).toBeCloseTo(1, 12);
  });

  it('the excluded underside is named, not silently subtracted', () => {
    const union = unionWholeSurface(GRID, [
      rowsMask(GRID, 0, 8, {
        excluded: { reason: 'stock-bottom', areaMm2: 20, face: 'the 10 × 2 face on the stock bottom' },
      }),
    ]);
    expect(union?.excludedCells).toBe(20);
    expect(union?.cells).toBe(80);
    expect(union?.excludedFace).toBe('the 10 × 2 face on the stock bottom');
    // 80 of the remaining 80 cells are reached.
    expect(union?.fraction).toBeCloseTo(1, 12);
  });
});

describe('#948 the pass fold judges the whole-surface reach', () => {
  it('red-first: top setup 60 % fails, whole-surface 100 % passes', () => {
    const goal = flatGoal();
    // The top setup's own stamp: a 1 mm leftover on the last four rows → 60 % top coverage.
    const top = (_x: number, y: number): number => (y >= 6 ? 1 : 0);
    const whole = unionWholeSurface(GRID, [
      rowsMask(GRID, 0, 6),
      rowsMask({ nx: 10, ny: 4, x0: 0, y0: 0, pitch: 1 }, 0, 4, { toDocument: [1, 0, 0, 0, 1, 6] }),
    ]);
    // WITHOUT the whole-surface field: the top-surface coverage (60 %) is the pass line → fails.
    const topOnly = checkGoalCutInto(goal, top, { leftoverTop: top, passCoverage: 0.95 });
    expect(topOnly.passCoverage).toBe(0.95);
    expect(topOnly.wholeSurface).toBeUndefined();
    expect(topOnly.ok).toBe(false);
    expect(topOnly.sentence).toContain('coverage');
    expect(topOnly.sentence).toContain('95');
    // WITH it: the union (100 %) is what the pass line judges → passes, and the sentence states
    // both the metric and how many setups formed it.
    const wholeRead = checkGoalCutInto(goal, top, { leftoverTop: top, passCoverage: 0.95, wholeSurface: whole });
    expect(wholeRead.ok).toBe(true);
    expect(wholeRead.wholeSurface?.fraction).toBeCloseTo(1, 12);
    expect(wholeRead.sentence).toContain('whole-surface coverage 100');
    expect(wholeRead.sentence).toContain('2 setups formed it');
  });

  it('a single top setup reads its top-surface number as its whole-surface reach, stated', () => {
    const goal = flatGoal();
    const top = (_x: number, y: number): number => (y >= 6 ? 1 : 0);
    const whole = unionWholeSurface(GRID, [rowsMask(GRID, 0, 6)]);
    const report = checkGoalCutInto(goal, top, { leftoverTop: top, passCoverage: 0.95, wholeSurface: whole });
    expect(report.wholeSurface?.fraction).toBeCloseTo(0.6, 12);
    expect(report.ok).toBe(false);
    // The failing sentence names the whole surface and states the single-setup identity.
    expect(report.sentence).toContain("the goal's whole surface");
    expect(report.sentence).toContain('one top setup');
  });

  it('the named underside appears in the sentence with its share', () => {
    const goal = flatGoal();
    const top = (_x: number, y: number): number => (y >= 6 ? 1 : 0);
    const whole = unionWholeSurface(GRID, [
      rowsMask(GRID, 0, 6, {
        excluded: { reason: 'stock-bottom', areaMm2: 20, face: 'the 10 × 2 face on the stock bottom' },
      }),
    ]);
    const report = checkGoalCutInto(goal, top, { leftoverTop: top, passCoverage: 0.95, wholeSurface: whole });
    expect(report.sentence).toContain('the 10 × 2 face on the stock bottom');
    expect(report.sentence).toContain('20 % of the surface');
    expect(report.sentence).toContain('excluded by design');
  });
});

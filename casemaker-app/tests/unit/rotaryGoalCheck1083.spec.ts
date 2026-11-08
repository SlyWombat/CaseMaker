/**
 * #1083 — THE GOAL CHECK ON THE ROTARY MAP. A rotary relief's material is a column grid in the
 * map frame (X, θ → radius) and the goal is the relief's own radial field; the flat heightfield
 * check cannot read either, which is why every rotary goal reported "not run" (#1059's readiness
 * run: the receipt's goal block `ran: false`, "cut-into 0, not a pass").
 *
 * These cases pin the comparison's arithmetic on a synthetic rod: a ⌀20 rod, a 2 mm groove over a
 * band of the map, and a column grid built to simulate the sweep. Red at the base: the module does
 * not exist, so the import fails; with it, every case below is green.
 */

import { describe, expect, it } from 'vitest';

import type { GoalRadialField } from '@/engine/cnc/cam/rotaryRelief';
import type { ColumnGrid } from '@/workers/geometry/columnEngine';
import { checkGoalCutIntoRotary } from '@/workers/sim/goalCheckRotary';

const R = 10;
const PITCH = 0.2;
const NX = 50;
const NY = 315; // ceil(2π·10 / 0.2) — one full turn at the pitch
const GROOVE_ROWS = [60, 90] as const;
const GROOVE_DEPTH = 2;

/** The goal: the rod's own surface everywhere, a 2 mm groove over rows 60–90. */
function goalField(): GoalRadialField {
  const z = new Float32Array(NX * NY);
  const covered = new Uint8Array(NX * NY).fill(1);
  for (let j = GROOVE_ROWS[0]; j < GROOVE_ROWS[1]; j++) {
    for (let i = 0; i < NX; i++) z[j * NX + i] = -GROOVE_DEPTH;
  }
  return { nx: NX, ny: NY, x0: 0, y0: 0, pitch: PITCH, radius: R, minRadius: R - GROOVE_DEPTH, maxRadius: R, z, covered, coveredCount: NX * NY, resolutionNote: 'synthetic' };
}

/** The sweep's grid, its columns set where the program cut. */
function grid(set: (i: number, j: number) => number | null): ColumnGrid {
  const h = new Float32Array(NX * NY).fill(R);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const v = set(i, j);
      if (v !== null) h[j * NX + i] = v;
    }
  }
  return { kind: 'rotary', nu: NX, nv: NY, u0: 0, du: PITCH, v0: 0, dv: 360 / NY, initial: R, base: 0, h };
}

const goalRadiusAt = (_i: number, j: number): number => {
  const inGroove = j >= GROOVE_ROWS[0] && j < GROOVE_ROWS[1];
  return R - (inGroove ? GROOVE_DEPTH : 0);
};

describe('#1083 the rotary goal check', () => {
  it('a smooth field cut exactly reads full coverage and no cut-into', () => {
    // No groove: the goal is the rod's own surface everywhere and the columns sit on it exactly.
    const smooth: GoalRadialField = { ...goalField(), z: new Float32Array(NX * NY), covered: new Uint8Array(NX * NY).fill(1) };
    const report = checkGoalCutIntoRotary(smooth, grid(() => R), null);
    expect(report.ran).toBe(true);
    expect(report.reason).toBeNull();
    expect(report.coverageFraction).toBe(1);
    expect(report.cutIntoFraction).toBe(0);
    expect(report.maxCutIntoMm).toBe(0);
    expect(report.goalCells).toBe(NX * NY);
    expect(report.sentence).toContain('goal check on the rotary map');
    expect(report.sentence).toContain('coverage 100.00 %');
  });

  it('a grooved field cut exactly reads full coverage but for the two step rows the conservative read brackets', () => {
    // The map reads each cell as the highest of its four bracketing columns (the flat check's own
    // one-column-lenient rule), so a STEP in the synthetic groove costs its two edge rows; the
    // real relief is a smooth mesh, where the bracket is exact.
    const report = checkGoalCutIntoRotary(goalField(), grid((i, j) => goalRadiusAt(i, j)), null);
    expect(report.coverageFraction).toBeGreaterThan(0.99);
    expect(report.coverageFraction).toBeLessThanOrEqual(1);
    expect(report.cutIntoFraction).toBe(0);
    expect(report.leftoverFractions[0]).toBeLessThan(0.01);
  });

  it('an over-deep cut is stated with its depth', () => {
    // Three columns by three rows: wider than the conservative read's bracket, so the gouge is
    // seen (a gouge narrower than a cell is the read's documented blind spot, as on the flat side).
    const report = checkGoalCutIntoRotary(
      goalField(),
      grid((i, j) => (i >= 10 && i <= 12 && j >= 69 && j <= 71 ? goalRadiusAt(i, j) - 0.5 : goalRadiusAt(i, j))),
      null,
    );
    expect(report.cutIntoFraction).toBeGreaterThan(0);
    expect(report.maxCutIntoMm).toBeCloseTo(0.5, 6);
    expect(report.sentence).toContain('is cut into the goal');
  });

  it('a relief that stops short leaves its groove standing, counted as leftover', () => {
    // The groove cells never cut: the columns keep the stock's radius (R), 2 mm above the goal.
    const report = checkGoalCutIntoRotary(
      goalField(),
      grid((i, j) => (j >= GROOVE_ROWS[0] && j < GROOVE_ROWS[1] ? null : goalRadiusAt(i, j))),
      null,
    );
    expect(report.coverageFraction).toBeLessThan(1);
    const grooveShare = (GROOVE_ROWS[1] - GROOVE_ROWS[0]) / NY;
    expect(report.leftoverFractions[0]).toBeGreaterThanOrEqual(grooveShare * 0.99);
    expect(report.maxLeftoverMm).toBeCloseTo(GROOVE_DEPTH, 6);
    expect(report.sentence).toContain('stands more than');
  });

  it("the run's own map tolerance is not cut-into: a facet-sized under-read passes, a real gouge counts", () => {
    // The column model cannot resolve better than its grid: half a cell plus the cutter's facet
    // rise. The same tolerance the prediction oracle judges by is the check's floor here.
    const allowance = { cellMm: 0.1, facetAt: (): number => 0.3 };
    const mild = checkGoalCutIntoRotary(goalField(), grid((_i, j) => goalRadiusAt(0, j) - 0.2), null, {}, allowance);
    expect(mild.cutIntoFraction).toBe(0);
    const deep = checkGoalCutIntoRotary(goalField(), grid((_i, j) => goalRadiusAt(0, j) - 0.7), null, {}, allowance);
    expect(deep.cutIntoFraction).toBeGreaterThan(0);
    expect(deep.maxCutIntoMm).toBeCloseTo(0.7, 6);
  });

  it('a goal cell outside the swept map is not compared and never counted as a pass', () => {
    const narrow: ColumnGrid = { ...grid((i, j) => goalRadiusAt(i, j)), nu: 25, nv: NY };
    // Rebuild the narrower grid's h at its own nu: only the first 25 X columns were swept.
    const h = new Float32Array(25 * NY);
    for (let j = 0; j < NY; j++) for (let i = 0; i < 25; i++) h[j * 25 + i] = goalRadiusAt(i, j);
    const report = checkGoalCutIntoRotary(goalField(), { ...narrow, h }, null);
    expect(report.goalCells).toBe(25 * NY);
  });
});

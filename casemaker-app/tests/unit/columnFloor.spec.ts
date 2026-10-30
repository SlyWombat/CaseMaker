/**
 * #723 P2-2b — the column engine's per-column FLOOR.
 *
 * A carried flip seeds each column's underside, so the material in a column is the interval
 * [floor, top] instead of the blank's [base, top]. The manager's boundary pin is here: side 2 cuts
 * EXACTLY to side 1's floor in one column (a break-through) and 0.05 mm short in its neighbour (a
 * 0.05 mm wall) — the two must be told apart by the measurement, not by a rounding rule. Where no
 * floor is seeded, the old arithmetic must be bit-for-bit the same.
 */
import { describe, expect, it } from 'vitest';

import { FLAT, type ColumnCutter, type ColumnGrid, type CutMove } from '@/workers/geometry/columnEngine';

const CUTTER: ColumnCutter = { radius: 0, tanHalf: null };
const RES = { dx: 1, dThetaDeg: 1 };

/** Two columns side by side: A at u = 0.5, B at u = 1.5, both on v = 0.5. */
function twoColumnGrid(floors: number[] | null): ColumnGrid {
  const h = new Float32Array([0, 0]);
  return {
    kind: 'flat',
    nu: 2,
    nv: 1,
    u0: 0.5,
    du: 1,
    v0: 0.5,
    dv: 1,
    initial: 0,
    base: -26,
    h,
    ...(floors === null ? {} : { columnFloor: new Float32Array(floors) }),
  };
}

function point(u: number, z: number): CutMove {
  return { step: 1, line: 1, u0: u, u1: u, v0: 0.5, v1: 0.5, z };
}

describe('#723 P2-2b — the column floor', () => {
  it('the manager’s pin: cut exactly to the floor is a break-through, 0.05 short is a 0.05 wall', () => {
    const grid = twoColumnGrid([-10, -10]);
    FLAT.applyMove(grid, point(0.5, -10), CUTTER); // A: exactly the floor
    FLAT.applyMove(grid, point(1.5, -9.95), CUTTER); // B: 0.05 above it
    expect(grid.h[0]).toBe(-10);
    expect(grid.h[1]).toBeCloseTo(-9.95, 6); // float32 grid: a 1e-7 quantisation, not a rounding rule
    expect(grid.h[0]! - (grid.columnFloor![0] as number)).toBe(0);
    expect(grid.h[1]! - (grid.columnFloor![1] as number)).toBeCloseTo(0.05, 6);
  });

  it('the volume reads the interval: A loses all its material, B leaves the 0.05 wall', () => {
    const grid = twoColumnGrid([-10, -10]);
    FLAT.applyMove(grid, point(0.5, -10), CUTTER);
    FLAT.applyMove(grid, point(1.5, -9.95), CUTTER);
    const v = FLAT.volume(grid);
    // Two columns, 10 mm of carried material each; A removes 10, B removes 9.95.
    expect(v.stock).toBeCloseTo(20, 6);
    expect(v.removed).toBeCloseTo(19.95, 6);
    expect(v.sacrificialRemoved).toBe(0);
  });

  it('a cutter sent below the floor stops AT the floor — the material is not there to remove', () => {
    const grid = twoColumnGrid([-10, -10]);
    FLAT.applyMove(grid, point(0.5, -12), CUTTER);
    expect(grid.h[0]).toBe(-10);
    const v = FLAT.volume(grid);
    expect(v.removed).toBeCloseTo(10, 6); // A's whole 10 mm; nothing from B
    expect(v.sacrificialRemoved).toBe(0); // never below the blank's bottom
  });

  it('without a floor the old arithmetic is unchanged: the blank is [base, initial]', () => {
    const grid = twoColumnGrid(null);
    FLAT.applyMove(grid, point(0.5, -10), CUTTER);
    const v = FLAT.volume(grid);
    // A removed 10 from 26, B removed nothing; stock is two 26 mm columns.
    expect(v.removed).toBeCloseTo(10, 6);
    expect(v.stock).toBeCloseTo(52, 6);
    expect(v.sacrificialRemoved).toBe(0);
  });

  it('the drawn stock uses each column’s floor: the carried underside, not the blank bottom', () => {
    const grid = twoColumnGrid([-10, -10]);
    FLAT.applyMove(grid, point(0.5, -10), CUTTER);
    FLAT.applyMove(grid, point(1.5, -9.95), CUTTER);
    const mesh = FLAT.mesh(grid, RES);
    expect(mesh.bbox.min[2]).toBeCloseTo(-10, 6); // the common floor
    expect(mesh.bbox.max[2]).toBeCloseTo(-9.95, 6); // B's 0.05 wall, the only material left
  });
});

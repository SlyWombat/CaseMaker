/**
 * #723 P2-2b-ii-2b — the carried stock as a FIELD, sampled into a flat grid.
 *
 * The source is the other side's final top field: a column's top is its remaining material's top
 * in the source work frame, and a top at the source stock's bottom is a column that side cut
 * through. The target's material is then [floor, top], the floor coming from the source top
 * through the flip's vertical map (floor2 = −top1 − T for an X flip on a T-thick stock).
 */
import { describe, expect, it } from 'vitest';

import { applyCarriedField, carriedTopAt, type CarriedField } from '@/workers/geometry/carriedField';
import { FLAT, type ColumnCutter, type ColumnGrid, type CutMove } from '@/workers/geometry/columnEngine';

const CUTTER: ColumnCutter = { radius: 0, tanHalf: null };
const T = 26;

/** Two target columns on v = 0.5: A at u = 0.5, B at u = 1.5. */
function targetGrid(): ColumnGrid {
  return {
    kind: 'flat',
    nu: 2,
    nv: 1,
    u0: 0.5,
    du: 1,
    v0: 0.5,
    dv: 1,
    initial: 0,
    base: -T,
    h: new Float32Array([0, 0]),
  };
}

/** The other side: A's top at −10 (16 mm of material), B cut through (top = base). */
function sourceField(map: CarriedField['map'] = [1, 0, 0, 0, 1, 0]): CarriedField {
  return {
    u0: 0.5,
    v0: 0.5,
    du: 1,
    dv: 1,
    nu: 2,
    nv: 1,
    top: new Float32Array([-10, -T]),
    base: -T,
    map,
    z: [-1, -T],
  };
}

function point(u: number, z: number): CutMove {
  return { step: 1, line: 1, u0: u, u1: u, v0: 0.5, v1: 0.5, z };
}

describe('#723 P2-2b-ii-2b — the carried field', () => {
  it('seeds each column’s floor from the other side’s top, and the cut-through column is empty', () => {
    const grid = targetGrid();
    applyCarriedField(grid, sourceField());
    expect(Array.from(grid.h)).toEqual([0, 0]); // the target stock's own top
    expect(grid.columnFloor![0]).toBeCloseTo(-16, 6); // −(−10) − 26
    expect(grid.columnFloor![1]).toBe(0); // source top at base: nothing to stand on
  });

  it('a cut to the carried floor at one column is a break-through; 0.05 short is a wall', () => {
    const grid = targetGrid();
    applyCarriedField(grid, sourceField());
    FLAT.applyMove(grid, point(0.5, -16), CUTTER); // exactly the floor
    FLAT.applyMove(grid, point(1.5, -14), CUTTER); // the empty column: nothing to cut
    const v = FLAT.volume(grid);
    // A's 16 mm of carried material is gone; B had none.
    expect(v.stock).toBeCloseTo(16, 6);
    expect(v.removed).toBeCloseTo(16, 6);
    expect(v.sacrificialRemoved).toBe(0);

    const wall = targetGrid();
    applyCarriedField(wall, sourceField());
    FLAT.applyMove(wall, point(0.5, -15.95), CUTTER); // 0.05 above the floor
    expect(wall.h[0]! - (wall.columnFloor![0] as number)).toBeCloseTo(0.05, 6);
    expect(FLAT.volume(wall).removed).toBeCloseTo(15.95, 6);
  });

  it('the map mirrors which source column a target column reads', () => {
    const grid = targetGrid();
    // x₁ = 2 − x: target A (0.5) reads source B (1.5), target B reads source A.
    applyCarriedField(grid, sourceField([-1, 0, 2, 0, 1, 0]));
    expect(grid.columnFloor![0]).toBe(0); // reads the cut-through source column
    expect(grid.columnFloor![1]).toBeCloseTo(-16, 6);
  });

  it('carriedTopAt samples the nearest source column, clamped at the edges', () => {
    const f = sourceField();
    expect(carriedTopAt(f, 0.5, 0.5)).toBe(-10);
    expect(carriedTopAt(f, 1.5, 0.5)).toBe(-T);
    expect(carriedTopAt(f, -50, 0.5)).toBe(-10); // clamped to the first column
    expect(carriedTopAt(f, 50, 0.5)).toBe(-T);
  });
});

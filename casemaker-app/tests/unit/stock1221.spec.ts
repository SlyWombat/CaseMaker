/**
 * #1221 (planner v3 B2) — ONE STOCK, CUT FROM EVERY POSE. The shared description: a blank box plus
 * one height map per pose that has cut; `isMaterial` and `startSurface` answer from any pose's frame.
 * Expected values are the issue's, checked against its prototype — never edited.
 */
import { describe, expect, it } from 'vitest';
import {
  isMaterial,
  rotate,
  startSurface,
  unrotate,
  type Blank,
  type Mat3,
  type PoseCut,
} from '@/engine/cnc/cam/fields/stock';
import type { FieldGrid } from '@/engine/cnc/cam/fields/boundedField';

const TOP: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const BOTTOM: Mat3 = [[1, 0, 0], [0, -1, 0], [0, 0, -1]];
const BACK_UP: Mat3 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]];
// A blank 20 long (X), 10 wide (Y), 5 thick; its top is at z = 0.
const BLANK: Blank = { min: [0, 0, -5], max: [20, 10, 0] };
const TOP_GRID: FieldGrid = { nx: 21, ny: 11, x0: 0, y0: 0, pitch: 1 };     // x 0..20, y 0..10
const BOTTOM_GRID: FieldGrid = { nx: 21, ny: 11, x0: 0, y0: -10, pitch: 1 }; // x 0..20, y' = -y: -10..0
const BACK_GRID: FieldGrid = { nx: 21, ny: 6, x0: 0, y0: 0, pitch: 1 };      // x 0..20, y' = -z: 0..5
const STEP = 0.05;

/** A top-pose cut: `depth` (a negative z) over cells with xa <= x <= xb and ya <= y <= yb, +Infinity elsewhere. */
function topCut(xa: number, xb: number, ya: number, yb: number, depth: number): PoseCut {
  const floor = new Float64Array(TOP_GRID.nx * TOP_GRID.ny).fill(Infinity);
  for (let j = 0; j < TOP_GRID.ny; j++) for (let i = 0; i < TOP_GRID.nx; i++) {
    if (i >= xa && i <= xb && j >= ya && j <= yb) floor[j * TOP_GRID.nx + i] = depth;
  }
  return { rotation: TOP, grid: TOP_GRID, floor };
}
const at = (grid: FieldGrid, field: Float64Array, i: number, j: number): number => field[j * grid.nx + i]!;
const near = (value: number, expected: number): void => expect(Math.abs(value - expected)).toBeLessThanOrEqual(STEP + 1e-9);

describe('#1221 — rotate/unrotate', () => {
  it('rotate and unrotate are inverses', () => {
    for (const R of [TOP, BOTTOM, BACK_UP]) {
      const q = rotate(R, [3, 4, -2]);
      const p = unrotate(R, q);
      for (let k = 0; k < 3; k++) expect(Math.abs(p[k]! - [3, 4, -2][k]!)).toBeLessThanOrEqual(1e-12);
    }
    expect(rotate(BOTTOM, [3, 4, -2])).toEqual([3, -4, 2]);
    expect(rotate(BACK_UP, [3, 4, -2])).toEqual([3, 2, 4]);
  });
});

describe('#1221 — startSurface from an uncut blank', () => {
  it('an uncut blank', () => {
    const stock = { blank: BLANK, cuts: [] as PoseCut[] };
    const top = startSurface(stock, TOP, TOP_GRID, STEP);
    for (let j = 0; j < TOP_GRID.ny; j++) for (let i = 0; i < TOP_GRID.nx; i++) near(at(TOP_GRID, top, i, j), 0);
    const bottom = startSurface(stock, BOTTOM, BOTTOM_GRID, STEP);
    for (let j = 0; j < BOTTOM_GRID.ny; j++) for (let i = 0; i < BOTTOM_GRID.nx; i++) near(at(BOTTOM_GRID, bottom, i, j), 5);
    const back = startSurface(stock, BACK_UP, BACK_GRID, STEP);
    for (let j = 0; j < BACK_GRID.ny; j++) for (let i = 0; i < BACK_GRID.nx; i++) near(at(BACK_GRID, back, i, j), 10);
  });

  it('a cell outside the blank has no material', () => {
    const stock = { blank: BLANK, cuts: [] as PoseCut[] };
    expect(startSurface(stock, TOP, { nx: 1, ny: 1, x0: 30, y0: 5, pitch: 1 }, STEP)[0]).toBe(-Infinity);
  });
});

describe('#1221 — a pocket, seen from both poses', () => {
  it('a pocket cut from the top, seen from the top', () => {
    const stock = { blank: BLANK, cuts: [topCut(5, 10, 2, 8, -2)] };
    const top = startSurface(stock, TOP, TOP_GRID, STEP);
    near(at(TOP_GRID, top, 7, 5), -2);
    near(at(TOP_GRID, top, 2, 5), 0);
    near(at(TOP_GRID, top, 7, 1), 0);
  });

  it('the same pocket, seen from the bottom', () => {
    const stock = { blank: BLANK, cuts: [topCut(5, 10, 2, 8, -2)] };
    const bottom = startSurface(stock, BOTTOM, BOTTOM_GRID, STEP);
    for (let j = 0; j < BOTTOM_GRID.ny; j++) for (let i = 0; i < BOTTOM_GRID.nx; i++) near(at(BOTTOM_GRID, bottom, i, j), 5);
  });

  it('a cut right through', () => {
    const stock = { blank: BLANK, cuts: [topCut(5, 10, 2, 8, -6)] };
    const bottom = startSurface(stock, BOTTOM, BOTTOM_GRID, STEP);
    expect(at(BOTTOM_GRID, bottom, 7, 5)).toBe(-Infinity);
    near(at(BOTTOM_GRID, bottom, 2, 5), 5);
  });

  it('a closed pocket leaves the side wall whole', () => {
    const stock = { blank: BLANK, cuts: [topCut(5, 10, 2, 8, -2)] };
    const back = startSurface(stock, BACK_UP, BACK_GRID, STEP);
    for (let j = 0; j < BACK_GRID.ny; j++) for (let i = 0; i < BACK_GRID.nx; i++) near(at(BACK_GRID, back, i, j), 10);
  });

  it('an open pocket is seen from the side', () => {
    const stock = { blank: BLANK, cuts: [topCut(5, 10, 2, 10, -2)] };
    const back = startSurface(stock, BACK_UP, BACK_GRID, STEP);
    near(at(BACK_GRID, back, 7, 1), 1.5);
    near(at(BACK_GRID, back, 7, 3), 10);
    near(at(BACK_GRID, back, 2, 1), 10);
  });
});

describe('#1221 — isMaterial', () => {
  it('inside the pocket, below it, beside it, below the blank, outside it', () => {
    const stock = { blank: BLANK, cuts: [topCut(5, 10, 2, 8, -2)] };
    expect(isMaterial(stock, [7, 5, -1])).toBe(false);
    expect(isMaterial(stock, [7, 5, -3])).toBe(true);
    expect(isMaterial(stock, [2, 5, -1])).toBe(true);
    expect(isMaterial(stock, [7, 5, -6])).toBe(false);
    expect(isMaterial(stock, [25, 5, -1])).toBe(false);
  });

  it('two poses both cut', () => {
    const floor = new Float64Array(BOTTOM_GRID.nx * BOTTOM_GRID.ny).fill(Infinity);
    for (let j = 0; j < BOTTOM_GRID.ny; j++) for (let i = 12; i <= 15; i++) floor[j * BOTTOM_GRID.nx + i] = 3;
    const stock = {
      blank: BLANK,
      cuts: [topCut(5, 10, 2, 8, -2), { rotation: BOTTOM, grid: BOTTOM_GRID, floor }],
    };
    expect(isMaterial(stock, [13, 5, -4.5])).toBe(false);
    expect(isMaterial(stock, [13, 5, -2.5])).toBe(true);
    const top = startSurface(stock, TOP, TOP_GRID, STEP);
    near(at(TOP_GRID, top, 13, 5), 0);
  });
});

describe('#1221 — a bad step', () => {
  it('a bad step', () => {
    const stock = { blank: BLANK, cuts: [] as PoseCut[] };
    expect(() => startSurface(stock, TOP, TOP_GRID, 0)).toThrow('cam/fields: stepMm must be above 0');
  });
});

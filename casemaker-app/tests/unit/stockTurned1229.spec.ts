/**
 * #1229 (planner v3 B2b) — THE STOCK KNOWS A ROD AND WHAT TURNING REMOVED. Two optional fields and
 * one recording function; nothing calls the stock. The expected numbers are the issue's prototype
 * numbers — a disagreement is reported, not edited.
 */
import { describe, expect, it } from 'vitest';

import { isMaterial, recordTurning, startSurface, type Mat3, type Stock, type TurnedCut } from '@/engine/cnc/cam/fields/stock';
import { turningRoughMoves, type TurningInput } from '@/engine/cnc/cam/turning';

const BASE = {
  x0: 0,
  dx: 0.5,
  stockRadiusMm: 10,
  cutterRadiusMm: 1.5,
  stepDownMm: 2,
  pitchMmPerTurn: 1.5,
  allowanceMm: 0,
  clearanceMm: 3,
  floorRadiusMm: 1,
  xFrom: 3,
  xTo: 27,
  degPerMove: 30,
  feedMmPerMin: 600,
  plungeFeedMmPerMin: 200,
};
const CYLINDER: TurningInput = { ...BASE, profile: new Array(61).fill(5) }; // leave a radius of 5 everywhere
const STEPPED: TurningInput = {
  ...BASE,
  profile: Array.from({ length: 61 }, (_, i) => (i * 0.5 < 15 ? 8 : 4)),
};

const blank = { min: [0, -10, -10], max: [30, 10, 10], rod: { axisY: 0, axisZ: 0, radiusMm: 10 } } as const;
const freshTurned = (): TurnedCut => ({ axisY: 0, axisZ: 0, x0: 0, dx: 0.5, radius: new Float64Array(61).fill(Infinity) });
const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const QUARTER: Mat3 = [[1, 0, 0], [0, 0, -1], [0, 1, 0]]; // the rod turned a quarter turn about x

const box = { min: [0, -10, -10], max: [30, 10, 10] } as const;

describe('#1229 — the stock knows a rod', () => {
  it('a rod is round', () => {
    const stock: Stock = { blank, cuts: [] };
    expect(isMaterial(stock, [15, 0, 9.9])).toBe(true);
    expect(isMaterial(stock, [15, 7.5, 7.5])).toBe(false); // inside the box, 10.6 from the axis
    expect(isMaterial(stock, [15, 0, 10.5])).toBe(false); // outside the box
  });

  it('a box blank is unchanged', () => {
    const stock: Stock = { blank: box, cuts: [] };
    expect(isMaterial(stock, [15, 7.5, 7.5])).toBe(true);
  });
});

describe('#1229 — recording a turning pass', () => {
  it('recording a plain cylinder', () => {
    const t = freshTurned();
    recordTurning(t, turningRoughMoves(CYLINDER), 1.5);
    for (const i of [0, 1, 2, 58, 59, 60]) expect(t.radius[i]).toBe(Infinity);
    for (let i = 3; i <= 57; i++) expect(t.radius[i]).toBe(5);
  });

  it('recording a stepped shaft', () => {
    const t = freshTurned();
    recordTurning(t, turningRoughMoves(STEPPED), 1.5);
    for (const i of [0, 1, 2, 58, 59, 60]) expect(t.radius[i]).toBe(Infinity);
    for (let i = 3; i <= 29; i++) expect(t.radius[i]).toBe(8);
    for (let i = 30; i <= 57; i++) expect(t.radius[i]).toBe(4);
  });

  it('the record is never below the profile', () => {
    for (const input of [CYLINDER, STEPPED]) {
      const t = freshTurned();
      recordTurning(t, turningRoughMoves(input), 1.5);
      for (let i = 0; i < t.radius.length; i++) expect(t.radius[i]!).toBeGreaterThanOrEqual(input.profile[i]! - 1e-9);
    }
  });

  it('rapids remove nothing', () => {
    const t = freshTurned();
    recordTurning(t, [{ kind: 'rapid', x: 15, y: 0, z: 2, a: 0 }], 1.5);
    for (let i = 0; i < t.radius.length; i++) expect(t.radius[i]).toBe(Infinity);
  });
});

describe('#1229 — what turning left, seen from every pose', () => {
  const t = (() => {
    const made = freshTurned();
    recordTurning(made, turningRoughMoves(CYLINDER), 1.5);
    return made;
  })();
  const stock: Stock = { blank, cuts: [], turned: t };

  it('turned material is gone all the way round', () => {
    expect(isMaterial(stock, [15, 0, 5.1])).toBe(false);
    expect(isMaterial(stock, [15, 0, 4.9])).toBe(true);
    expect(isMaterial(stock, [15, 3, 4])).toBe(true); // exactly 5 from the axis
    expect(isMaterial(stock, [15, 3.1, 4])).toBe(false);
    expect(isMaterial(stock, [15, 0, -5.1])).toBe(false); // the far side
    expect(isMaterial(stock, [15, 0, -4.9])).toBe(true);
  });

  it('the ends that were not turned are still rod', () => {
    expect(isMaterial(stock, [1.0, 0, 9])).toBe(true); // cell 2
    expect(isMaterial(stock, [1.5, 0, 9])).toBe(false); // cell 3
    expect(isMaterial(stock, [29.5, 0, 9])).toBe(true); // cell 59
  });

  it('a flat pose starts from what turning left', () => {
    const grid = { x0: 15, y0: 0, pitch: 3, nx: 1, ny: 3 }; // v = 0, 3, 6
    expect([...startSurface(stock, IDENTITY, grid, 0.5)]).toEqual([5, 4, -Infinity]);
  });

  it('and from any side', () => {
    const grid = { x0: 15, y0: 0, pitch: 3, nx: 1, ny: 3 };
    expect([...startSurface(stock, QUARTER, grid, 0.5)]).toEqual([5, 4, -Infinity]);
  });

  it('an unturned end from above', () => {
    const grid = { x0: 0.5, y0: 0, pitch: 6, nx: 1, ny: 2 }; // v = 0, 6
    expect([...startSurface(stock, IDENTITY, grid, 0.5)]).toEqual([10, 8]);
  });
});

/**
 * #1215 (planner v3, slice 2) — FLAT REACH BY DIAMETER, on the real Clipper offset.
 *
 * The opening `fullyReachable` clears what a round cutter can actually reach; these tests pin the
 * areas the issue states, on a rectangle and on a dumbbell whose neck admits a 1 mm cutter but not
 * a 3 mm one.
 */
import { describe, expect, it } from 'vitest';

import { tl } from './helpers/manifoldExec';
import { makeClipperOffset } from '@/engine/cnc/cam/engraveJob';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { flatReach, polygonsArea, polygonsPerimeter } from '@/engine/cnc/cam/fields/flatReach';

const offset = makeClipperOffset(tl);

const RECT: Polygons = [
  [
    [0, 0],
    [20, 0],
    [20, 10],
    [0, 10],
  ],
];
// Two 10 × 10 squares joined by a neck 2 mm wide and 6 mm long.
const DUMBBELL: Polygons = [
  [
    [0, 0],
    [10, 0],
    [10, 4],
    [16, 4],
    [16, 0],
    [26, 0],
    [26, 10],
    [16, 10],
    [16, 6],
    [10, 6],
    [10, 10],
    [0, 10],
  ],
];

describe('#1215 — flat reach', () => {
  it('area of a rectangle', () => {
    expect(polygonsArea(RECT)).toBeCloseTo(200, 9);
    expect(polygonsArea(DUMBBELL)).toBeCloseTo(212, 9);
    expect(polygonsArea([])).toBe(0);
  });

  it('a 4 mm cutter in a 20 × 10 rectangle loses only the four corners', () => {
    const area = flatReach(RECT, [4], offset)[0]!.areaMm2;
    expect(Math.abs(area - 196.5664)).toBeLessThan(0.05);
  });

  it('a cutter wider than the rectangle reaches nothing', () => {
    expect(flatReach(RECT, [12], offset)[0]!.areaMm2).toBe(0);
  });

  it('a 3 mm cutter cannot pass a 2 mm neck', () => {
    const area = flatReach(DUMBBELL, [3], offset)[0]!.areaMm2;
    expect(area).toBeGreaterThan(196.0);
    expect(area).toBeLessThan(198.0);
  });

  it('a 1 mm cutter passes the neck', () => {
    const area = flatReach(DUMBBELL, [1], offset)[0]!.areaMm2;
    expect(Math.abs(area - 211.5708)).toBeLessThan(0.05);
  });

  it('sorted largest first, duplicates and bad values dropped', () => {
    expect(flatReach(RECT, [2, 6, 2, -1, Number.NaN, 4], offset).map((s) => s.diameterMm)).toEqual([6, 4, 2]);
  });

  it('areas never decrease as the cutter gets smaller, and the increments add up', () => {
    const steps = flatReach(DUMBBELL, [8, 6, 4, 3, 2, 1, 0.5], offset);
    for (let k = 1; k < steps.length; k++) {
      expect(steps[k]!.areaMm2).toBeGreaterThanOrEqual(steps[k - 1]!.areaMm2);
    }
    for (const step of steps) expect(step.addedAreaMm2).toBeGreaterThanOrEqual(0);
    const sum = steps.reduce((n, s) => n + s.addedAreaMm2, 0);
    expect(Math.abs(sum - steps[steps.length - 1]!.areaMm2)).toBeLessThan(1e-6);
    expect(steps[steps.length - 1]!.areaMm2).toBeLessThanOrEqual(212 + 1e-3);
  });

  it('an empty region', () => {
    const steps = flatReach([], [6, 3], offset);
    expect(steps).toHaveLength(2);
    for (const step of steps) {
      expect(step.areaMm2).toBe(0);
      expect(step.reach).toEqual([]);
    }
  });
});

describe('#1225 polygonsPerimeter', () => {
  it('an outline’s own length', () => {
    expect(polygonsPerimeter(RECT)).toBe(60);
    expect(polygonsPerimeter(DUMBBELL)).toBe(88);
    expect(polygonsPerimeter([])).toBe(0);
  });
});

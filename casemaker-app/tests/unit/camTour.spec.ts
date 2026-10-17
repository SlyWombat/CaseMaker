// #487 — the tour the loop ordering is built on. Pure geometry, no CAM: the point is that the
// nearest-neighbour + 2-opt step is correct and deterministic on its own, before `engraveJob.ts`
// wraps it in rings, entries and moves.

import { describe, expect, it } from 'vitest';
import {
  nearestNeighbourOrder,
  pathLength,
  tourNearest,
  twoOptOrder,
  type TourPoint,
} from '@/engine/cnc/cam/tour';

function inOrder(points: readonly TourPoint[], order: readonly number[]): TourPoint[] {
  return order.map((i) => points[i]!);
}

describe('pathLength (#487)', () => {
  it('sums the hops in order and is zero for fewer than two points', () => {
    expect(pathLength([])).toBe(0);
    expect(pathLength([[4, 7]])).toBe(0);
    expect(pathLength([[0, 0], [3, 4], [3, 0]])).toBe(9);
  });
});

describe('nearestNeighbourOrder (#487)', () => {
  it('visits each point once, walking from the nearest to the previous', () => {
    const points: TourPoint[] = [[8, 0], [3, 0], [10, 0]];
    expect(nearestNeighbourOrder(points, [0, 0])).toEqual([1, 0, 2]);
  });

  it('breaks a tie to the LOWER INDEX, so equidistant points are not a coin toss', () => {
    const points: TourPoint[] = [[1, 0], [-1, 0]];
    expect(nearestNeighbourOrder(points, [0, 0])).toEqual([0, 1]);
    // The order the caller passed them in is the stable tiebreak, whichever way round it is.
    expect(nearestNeighbourOrder([[-1, 0], [1, 0]], [0, 0])).toEqual([0, 1]);
  });

  it('returns an empty order for no points and the only index for one', () => {
    expect(nearestNeighbourOrder([], [0, 0])).toEqual([]);
    expect(nearestNeighbourOrder([[5, 5]], [100, 100])).toEqual([0]);
  });
});

describe('twoOptOrder (#487)', () => {
  it('uncrosses a crossing and leaves the FIRST point where it was', () => {
    // The corners of a 10 x 10 square, visited across both diagonals: 38.28 mm.
    const points: TourPoint[] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const crossed = [0, 2, 1, 3];
    expect(pathLength(inOrder(points, crossed))).toBeCloseTo(38.284, 3);

    const improved = twoOptOrder(points, crossed);
    expect(improved[0]).toBe(0);
    expect(improved).toEqual([0, 1, 2, 3]);
    expect(pathLength(inOrder(points, improved))).toBeCloseTo(30, 9);
  });

  it('never lengthens a path, and leaves a tour of fewer than three points alone', () => {
    const points: TourPoint[] = [[0, 0], [8, 1], [2, 5], [9, 7], [1, 9], [5, 4]];
    const order = nearestNeighbourOrder(points, [0, 0]);
    const improved = twoOptOrder(points, order);
    expect(pathLength(inOrder(points, improved))).toBeLessThanOrEqual(
      pathLength(inOrder(points, order)) + 1e-9,
    );
    expect([...improved].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);

    expect(twoOptOrder(points, [])).toEqual([]);
    expect(twoOptOrder(points, [2])).toEqual([2]);
    expect(twoOptOrder(points, [3, 1])).toEqual([3, 1]);
  });

  it('is deterministic: the same points in the same order give the same tour', () => {
    const points: TourPoint[] = [[0, 0], [8, 1], [2, 5], [9, 7], [1, 9], [5, 4]];
    expect(tourNearest(points, [0, 0])).toEqual(tourNearest(points, [0, 0]));
  });
});

describe('tourNearest (#487)', () => {
  it('starts from the point nearest `from` and is no longer than nearest neighbour alone', () => {
    const points: TourPoint[] = [[0, 0], [8, 1], [2, 5], [9, 7], [1, 9], [5, 4]];
    const from: TourPoint = [4.5, 4.5];
    const tour = tourNearest(points, from);
    const nn = nearestNeighbourOrder(points, from);
    const nearest = points
      .map((p, i) => ({ i, d: Math.hypot(p[0] - from[0], p[1] - from[1]) }))
      .sort((a, b) => a.d - b.d)[0]!.i;
    expect(tour[0]).toBe(nearest);
    expect(pathLength(inOrder(points, tour))).toBeLessThanOrEqual(
      pathLength(inOrder(points, nn)) + 1e-9,
    );
  });
});

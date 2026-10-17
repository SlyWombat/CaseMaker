// §5.7 — the lost layer's hatch spans. Plain XY maths, no canvas: the lost region's contours can
// be many thin slivers, and the one property that matters is that every span lies inside the
// region — a hatch that leaks outside it would paint stock that was never in the design.
//
// The square and the square-with-a-counter are the two closed forms: the first pins the line
// phase and pairing, the second pins the EVEN-ODD rule (a counter is a separate ring, and its
// interior must stay unhatched).

import { describe, it, expect } from 'vitest';
import { hatchSegments } from '@/components/viewport/engraveHatch';

/** A square ring, counter-clockwise. */
function square(minX: number, minY: number, size: number): [number, number][] {
  return [
    [minX, minY],
    [minX + size, minY],
    [minX + size, minY + size],
    [minX, minY + size],
  ];
}

describe('hatchSegments — §5.7 lost-layer hatching', () => {
  it('answers no spans for no contours, a non-positive pitch, or a non-finite angle', () => {
    expect(hatchSegments([], 1)).toEqual([]);
    expect(hatchSegments([square(0, 0, 4)], 0)).toEqual([]);
    expect(hatchSegments([square(0, 0, 4)], -1)).toEqual([]);
    expect(hatchSegments([square(0, 0, 4)], Number.NaN)).toEqual([]);
    expect(hatchSegments([square(0, 0, 4)], 1, Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('spans a square at the requested pitch, every endpoint inside it', () => {
    const spans = hatchSegments([square(0, 0, 4)], 1, 0);
    // The line on y = 0 lies along the boundary and is not an interior span; rows y = 1…4 are.
    expect(spans).toHaveLength(4);
    for (const [[ax, ay], [bx, by]] of spans) {
      expect(ay).toBeCloseTo(by, 9); // angle 0: horizontal
      expect(Math.min(ax, bx)).toBeCloseTo(0, 9);
      expect(Math.max(ax, bx)).toBeCloseTo(4, 9);
      expect(ay).toBeGreaterThanOrEqual(0);
      expect(ay).toBeLessThanOrEqual(4);
    }
    // Uniform spacing, anchored at the origin rather than at the region's own bbox.
    expect(spans.map(([, b]) => b[1])).toEqual([1, 2, 3, 4]);
  });

  it('uses even-odd fill: a counter is a hole, not part of the span', () => {
    // Outer 6 × 6, counter 2 × 2 centred: y = 3 crosses x = 0, 2, 4, 6 → two spans, not one.
    const spans = hatchSegments([square(0, 0, 6), square(2, 2, 2)], 1, 0);
    const rowY3 = spans.filter(([, b]) => Math.abs(b[1] - 3) < 1e-9);
    expect(rowY3).toHaveLength(2);
    const byX = rowY3.map(([[ax], [bx]]) => [Math.min(ax, bx), Math.max(ax, bx)]).sort((a, b) => a[0]! - b[0]!);
    expect(byX[0]![0]).toBeCloseTo(0, 9);
    expect(byX[0]![1]).toBeCloseTo(2, 9);
    expect(byX[1]![0]).toBeCloseTo(4, 9);
    expect(byX[1]![1]).toBeCloseTo(6, 9);
  });

  it('keeps a diagonal hatch inside its region', () => {
    const spans = hatchSegments([square(0, 0, 4)], 0.8, 45);
    expect(spans.length).toBeGreaterThan(0);
    for (const [[ax, ay], [bx, by]] of spans) {
      for (const [x, y] of [
        [ax, ay],
        [bx, by],
      ] as const) {
        // Inside the closed square, with a hair of tolerance for the endpoint interpolation.
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(x).toBeLessThanOrEqual(4 + 1e-9);
        expect(y).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(4 + 1e-9);
      }
    }
  });
});

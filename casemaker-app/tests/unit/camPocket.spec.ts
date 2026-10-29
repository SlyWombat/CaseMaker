// The contour-parallel pocketing core (#172). NO wasm here: the offset is injected, so this
// spec drives `pocketLoops` with a trivial axis-aligned-rectangle offset and asserts against
// CLOSED FORMS computed by hand, never against another run of the code.

import { describe, it, expect } from 'vitest';
import {
  DENSE_CONTOUR_VERTICES,
  pocketLoops,
  simplifyContour,
  StepOverTooLargeError,
  type Polygons,
} from '@/engine/cnc/cam/pocket';

/** A CCW rectangle with its front-left at the origin. */
function rect(w: number, h: number): Polygons {
  return [
    [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ],
  ];
}

function bbox(region: Polygons): { w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of region) {
    for (const [x, y] of c) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { w: maxX - minX, h: maxY - minY };
}

// A rectangle shrinks by |delta| on EVERY side (delta < 0), and vanishes once a side reaches
// zero. This is the exact behaviour Clipper2 gives an axis-aligned rectangle, and it is what
// the hand-computed ring count below assumes.
function fakeRectOffset(region: Polygons, delta: number): Polygons {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of region) {
    for (const [x, y] of c) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const s = Math.abs(delta);
  const w = maxX - minX - 2 * s;
  const h = maxY - minY - 2 * s;
  if (w <= 0 || h <= 0) return [];
  return [
    [
      [minX + s, minY + s],
      [maxX - s, minY + s],
      [maxX - s, maxY - s],
      [minX + s, maxY - s],
    ],
  ];
}

/** A traced-looking circle: `n` points, radius `r`, a small radial wobble. */
function tracedCircle(n: number, r: number, wobble = 0): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    const rr = r + wobble * Math.sin(13 * a);
    return [rr * Math.cos(a), rr * Math.sin(a)] as [number, number];
  });
}

/** Distance from `p` to the nearest edge of the closed polygon, mm. */
function distanceToRing(p: [number, number], ring: readonly [number, number][]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (len * len)));
    const q: [number, number] = [a[0] + t * dx, a[1] + t * dy];
    best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1]));
  }
  return best;
}

describe('#751 dense traced contours are simplified before pocketing', () => {
  it('a 6,048-point traced circle loses its redundant vertices, none moving past the chord tolerance', () => {
    const dense = tracedCircle(6048, 46.5, 0.009);
    const simple = simplifyContour(dense);
    expect(simple.length).toBeLessThan(DENSE_CONTOUR_VERTICES);
    expect(simple.length).toBeGreaterThan(100);
    // Every original point is within ARC_CHORD_TOLERANCE_MM of a simplified edge.
    for (const p of dense) expect(distanceToRing(p, simple)).toBeLessThanOrEqual(0.005 + 1e-9);
  });

  it('a contour at or below the threshold is returned byte-identical', () => {
    const small = tracedCircle(DENSE_CONTOUR_VERTICES, 20, 0);
    expect(simplifyContour(small)).toEqual(small);
  });

  it('pocketLoops rings the simplified contour, so the rings stay bounded', () => {
    const dense = tracedCircle(6048, 20, 0.009);
    const rings = pocketLoops([dense], 0.5, 0.4, (region, delta) => {
      // A crude offset for this test only: scale about the origin, keeping the same points.
      if (20 + delta <= 0) return [];
      const k = (20 + delta) / 20;
      return [region[0]!.map(([x, y]) => [x * k, y * k] as [number, number])];
    });
    expect(rings.length).toBeGreaterThan(1);
    for (const ring of rings) for (const contour of ring) expect(contour.length).toBeLessThan(DENSE_CONTOUR_VERTICES);
  });
});

describe('pocketLoops (#172)', () => {
  it('rings a 10 x 5 rectangle at r = 0.5, step-over 0.4 in exactly five rings', () => {
    // Hand computation. The first ring is the region eroded by r: (10 - 1) x (5 - 1) = 9 x 4.
    // Each further ring erodes BOTH sides by step-over, so its short side shrinks 0.8 per step:
    //   ring k short side = 4 - 0.8k  ->  k = 0..4 gives 4.0, 3.2, 2.4, 1.6, 0.8 (> 0),
    //   k = 5 gives 0 -> empty. Five rings, outermost first.
    const rings = pocketLoops(rect(10, 5), 0.5, 0.4, fakeRectOffset);
    expect(rings.length).toBe(5);
    const first = bbox(rings[0]!);
    expect(first.w).toBeCloseTo(9, 9);
    expect(first.h).toBeCloseTo(4, 9);
    const shortSides = rings.map((r) => bbox(r).h);
    expect(shortSides.map((v) => Number(v.toFixed(6)))).toEqual([4, 3.2, 2.4, 1.6, 0.8]);
  });

  it('refuses step-over larger than the tool radius with the typed error', () => {
    expect(() => pocketLoops(rect(10, 5), 0.5, 0.6, fakeRectOffset)).toThrow(StepOverTooLargeError);
    // Exactly at the radius is allowed (#191: the spine is left uncut only ABOVE the radius).
    expect(() => pocketLoops(rect(10, 5), 0.5, 0.5, fakeRectOffset)).not.toThrow();
  });

  it('lets a V-bit floor use its TIP WIDTH, and refuses one pitch past it (#221)', () => {
    // The floor is cleared by the 0.15 mm tip disc, so a 0.24 mm pitch leaves no spine even though
    // it is past the radius. The bound is the tip WIDTH, 0.3 mm; past it the disc passes separate.
    const rings = pocketLoops(rect(10, 5), 0.15, 0.24, fakeRectOffset, 0.3);
    expect(rings.length).toBeGreaterThan(0);
    const refusal = (() => {
      try {
        pocketLoops(rect(10, 5), 0.15, 0.31, fakeRectOffset, 0.3);
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(refusal).toBeInstanceOf(StepOverTooLargeError);
    expect((refusal as StepOverTooLargeError).limit).toBe(0.3);
    expect((refusal as StepOverTooLargeError).message).toContain('0.3 mm cutter width');
  });

  it('refuses a non-positive maxStepOver rather than treating it as no limit', () => {
    expect(() => pocketLoops(rect(10, 5), 0.5, 0.4, fakeRectOffset, 0)).toThrow(/maxStepOver/);
    expect(() => pocketLoops(rect(10, 5), 0.5, 0.4, fakeRectOffset, -1)).toThrow(/maxStepOver/);
  });

  it('a region of empty polygons produces no rings', () => {
    expect(pocketLoops([], 0.5, 0.4, fakeRectOffset)).toEqual([]);
  });

  it('throws after the iteration guard when the offset never empties', () => {
    const neverShrinks = (region: Polygons): Polygons => region;
    expect(() => pocketLoops(rect(10, 5), 0.5, 0.4, neverShrinks)).toThrow(/did not empty/i);
  });
});

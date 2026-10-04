// The contour-parallel pocketing core (#172). NO wasm here: the offset is injected, so this
// spec drives `pocketLoops` with a trivial axis-aligned-rectangle offset and asserts against
// CLOSED FORMS computed by hand, never against another run of the code.

import { describe, it, expect } from 'vitest';
import { pocketLoops, StepOverTooLargeError, type Polygons } from '@/engine/cnc/cam/pocket';

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

  it('a region of empty polygons produces no rings', () => {
    expect(pocketLoops([], 0.5, 0.4, fakeRectOffset)).toEqual([]);
  });

  it('throws after the iteration guard when the offset never empties', () => {
    const neverShrinks = (region: Polygons): Polygons => region;
    expect(() => pocketLoops(rect(10, 5), 0.5, 0.4, neverShrinks)).toThrow(/did not empty/i);
  });
});

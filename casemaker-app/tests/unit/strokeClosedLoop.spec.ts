// A Hershey closed loop is a RING (#409 low item): the font writes it as a path whose last point
// repeats its first. `offsetPolyline` used to take that repeated point for two OPEN ends, so every
// bold pass of an 'O', '0', 'o', 'Q' or a dot had a flat cap at each side of the seam instead of
// one joined vertex — a small gap in the pass there, and an open copy where the ring should close.
//
// The assertions are measured off real glyph data and off a square whose right-angle miter is
// exact, so they fail on the old open-ended treatment rather than restating the implementation.

import { describe, it, expect } from 'vitest';

import { HERSHEY_SIMPLEX } from '@/engine/fonts/stroke/hersheySimplex';
import { boldStrokePasses, offsetPolyline, strokeGlyphPaths } from '@/engine/fonts/stroke/strokeFont';

type Pt = [number, number];

/** The bench job's cutter at its 1.0 mm depth: 0.3 + 2·tan 15° = 0.8359 mm. */
const GROOVE = 0.3 + 2 * Math.tan((15 * Math.PI) / 180);
/** The outer/inner pass offset for a 1.5 mm bold stroke, the width #409 was asked for. */
const D = (1.5 - GROOVE) / 2;

/** The signed area of a ring by the shoelace sum (positive = counter-clockwise). */
function signedArea(ring: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i]!;
    const [x1, y1] = ring[i + 1]!;
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** The miter point at `vertex` between the incoming and outgoing segment directions, `d` out. */
function miterAt(prev: Pt, vertex: Pt, next: Pt, d: number): Pt {
  const normal = (a: Pt, b: Pt): Pt => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    return [-dy / len, dx / len];
  };
  const n1 = normal(prev, vertex);
  const n2 = normal(vertex, next);
  const mx = n1[0] + n2[0];
  const my = n1[1] + n2[1];
  const ml = Math.hypot(mx, my);
  const cos = (mx / ml) * n1[0] + (my / ml) * n1[1];
  return [vertex[0] + (mx / ml) * (d / cos), vertex[1] + (my / ml) * (d / cos)];
}

describe('a Hershey closed loop is a ring, not an open path (#409 low item)', () => {
  it('is written with its first point repeated last — the defect’s own evidence', () => {
    // The 'O' bowl and the 'i' dot. Their coordinates are the font's, stated here so the seam
    // under test is the seam the data has.
    const o = HERSHEY_SIMPLEX['O']![2][0]!;
    expect(o[0]).toEqual([-2, -12]);
    expect(o[o.length - 1]).toEqual(o[0]); // 21 points, the last repeats the first

    const dot = HERSHEY_SIMPLEX['i']![2][0]!;
    expect(dot[0]).toEqual([-1, -12]);
    expect(dot[dot.length - 1]).toEqual(dot[0]); // the diamond dot, 5 points
  });

  it('joins the seam with a miter, and closes the copy, instead of capping it twice', () => {
    // A CCW square: the left of travel is inward, so d = +1 gives an inner square at 1 mm —
    // and the seam (0,0) is a right angle whose miter is exactly (1,1).
    const square: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
    const out = offsetPolyline(square, 1);

    // The old code gave [0,1] at the first end and [1,0] at the last: two flat caps 1.414 mm
    // apart, and no closing segment.
    expect(out[0]![0]).toBeCloseTo(1, 12);
    expect(out[0]![1]).toBeCloseTo(1, 12);
    expect(out[out.length - 1]).toEqual(out[0]); // the ring closes on the joined seam
    expect(out).toHaveLength(square.length); // a miter keeps one vertex per corner
  });

  it('joins the seam of a real glyph pass, where the old copy left a 0.15 mm gap', () => {
    const loop = strokeGlyphPaths('O', 'hershey-simplex', 8)[0]!;
    const seam = loop[0]!;
    const out = offsetPolyline(loop, D);

    // Closed: the pass returns to its seam. The old output's ends were [-0.6134, 4.2745] and
    // [-0.7619, 4.2394] — 0.1526 mm apart, with neither point at the corner.
    expect(out[out.length - 1]).toEqual(out[0]);
    expect(out).toHaveLength(loop.length);

    // Joined: the seam point is the intersection of the two adjacent offset lines (a miter), not
    // either flat cap. It sits `D / cos(θ/2)` from the source vertex, so farther than `D`.
    const expected = miterAt(loop[loop.length - 2]!, seam, loop[1]!, D);
    expect(out[0]![0]).toBeCloseTo(expected[0], 9);
    expect(out[0]![1]).toBeCloseTo(expected[1], 9);
    expect(Math.hypot(out[0]![0] - seam[0], out[0]![1] - seam[1])).toBeGreaterThan(D);
  });

  it('keeps the inward copy of a dot as a ring with the same winding', () => {
    // The 'i' dot is 0.58 mm across at 8.6 mm — smaller than the pass offset — so each miter
    // passes through the centre and the copy is a small diamond on its far side. With the seam
    // joined it is still counter-clockwise: the OLD open path shoelaced NEGATIVE (inside out),
    // which was the open seam's two flat caps making a phantom edge, not the offset itself.
    // The copy must stay: the outer pass's band reaches only 0.086 mm inside the diamond, so
    // without it the dot's centre would be uncut.
    const dot = strokeGlyphPaths('i', 'hershey-simplex', 8.6)[0]!;
    const inward = offsetPolyline(dot, D);
    expect(signedArea(dot)).toBeGreaterThan(0);
    expect(signedArea(inward)).toBeGreaterThan(0); // same winding — not inside out
    expect(Math.abs(signedArea(inward))).toBeLessThan(Math.abs(signedArea(dot))); // inside the dot
    expect(inward[inward.length - 1]).toEqual(inward[0]); // and closed
    expect(inward).toHaveLength(dot.length);

    // Both of the dot's bold passes survive, and both are rings.
    const passes = boldStrokePasses([dot], GROOVE, 1.5);
    expect(passes).toHaveLength(2);
    for (const pass of passes) {
      expect(pass.length).toBeGreaterThan(2);
      expect(pass[pass.length - 1]).toEqual(pass[0]);
    }
  });
});

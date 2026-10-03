// Arc resolution for 2D profile ops (#190).
//
// Manifold's default circular-segment count collapses at small radii because
// its minCircularEdgeLength is 1 mm: getCircularSegments(0.5) is 4, so a "round"
// offset at r = 0.5 is a SQUARE (CrossSection.circle(0.5) has area 0.500 against
// an exact 0.785). It threw no error and produced a valid CrossSection.
//
// Every assertion below is against a CLOSED FORM, not against another run of the
// same code. That is the point: a test that compares the fix with itself would
// have passed on the bug.

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';
import ManifoldModule from 'manifold-3d';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import {
  ARC_CHORD_TOLERANCE_MM,
  segmentsForRadius,
  chordError,
} from '@/engine/compiler/arcResolution';
import { circleProfile, pOffset, pTranslate, rectProfile, roundedRect } from '@/engine/compiler/profile';

type TL = Awaited<ReturnType<typeof ManifoldModule>>;
let tl: TL;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  tl = await ManifoldModule({ locateFile: () => require.resolve('manifold-3d/manifold.wasm') });
  tl.setup();
});

const area = (p: Parameters<typeof executeProfile>[1]) => {
  const cs = executeProfile(tl, p);
  const a = cs.area();
  cs.delete();
  return a;
};

describe('segmentsForRadius', () => {
  const radii = [0.05, 0.1, 0.2, 0.5, 1, 1.5875, 3.175, 5, 10, 25, 100];

  it.each(radii)('r = %s meets the chord-error tolerance', (r) => {
    const n = segmentsForRadius(r);
    expect(chordError(r, n)).toBeLessThanOrEqual(ARC_CHORD_TOLERANCE_MM + 1e-12);
  });

  it.each(radii)('r = %s is a multiple of 4, so the quadrant extremes are vertices', (r) => {
    expect(segmentsForRadius(r) % 4).toBe(0);
  });

  it('is monotone: a larger radius never gets fewer segments', () => {
    let prev = 0;
    for (const r of radii) {
      const n = segmentsForRadius(r);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('is bounded, so a huge or degenerate radius cannot ask for millions of vertices', () => {
    expect(segmentsForRadius(1e6)).toBeLessThanOrEqual(512);
    expect(segmentsForRadius(0)).toBeGreaterThanOrEqual(8);
    expect(segmentsForRadius(NaN)).toBeGreaterThanOrEqual(8);
  });
});

describe('the defect, pinned', () => {
  it("Manifold's own default at r = 0.5 really is 4 segments (the premise of #190)", () => {
    // If this ever stops being true the bug is gone upstream and this whole file
    // can be reconsidered; until then it documents WHY the code below exists.
    expect(tl.getCircularSegments(0.5)).toBe(4);
    expect(tl.CrossSection.circle(0.5, 0).area()).toBeCloseTo(0.5, 6);
  });
});

describe('p-circle with no segments given', () => {
  // The inscribed n-gon has area (n/2) r^2 sin(2π/n); compare the real area to the
  // true circle and require the shortfall to be tiny.
  it.each([0.2, 0.5, 1, 3.175])('r = %s is a circle, not the default polygon', (r) => {
    const exact = Math.PI * r * r;
    const got = area(circleProfile(r));
    // The sliver between a circle and its inscribed polygon is bounded by
    // perimeter x sagitta, and the sagitta is capped at the chord tolerance. That
    // bound is ABSOLUTE, so it is the right claim at every radius — a relative
    // threshold fails at small r, where 0.005 mm is a large fraction of the arc.
    // The bug's shortfall at r = 0.5 is 0.285 mm2; this bound is 0.016 mm2.
    expect(exact - got).toBeLessThanOrEqual(2 * Math.PI * r * ARC_CHORD_TOLERANCE_MM);
    expect(got).toBeLessThanOrEqual(exact);
  });
});

describe('p-offset with a round join and no segments given', () => {
  it('a round offset of a point-ish square is a disc-cornered square, not a larger square', () => {
    // Offsetting a w x h rectangle by r (round) has the exact area
    //   w*h + 2*r*(w+h) + π r²
    const w = 20;
    const h = 10;
    const r = 0.5;
    const exact = w * h + 2 * r * (w + h) + Math.PI * r * r;
    const got = area(pOffset(rectProfile(w, h), r, 'round'));
    // The default (4 segments) gives w*h + 2r(w+h) + 2r² — short by ~0.29 mm² here.
    expect(exact - got).toBeLessThan(0.02);
    expect(got).toBeLessThanOrEqual(exact + 1e-9);
  });

  it('SECOND CLOSED FORM: the opening of a straight stroke is the stroke', () => {
    // §4.0's capsule gate would not have caught #190 — it exercises the sweep, not
    // the offset. A morphological opening offset(offset(G,-r),+r) of a rectangle at
    // least 2r wide and long is the rectangle itself (a rounded-corner rectangle
    // loses only the corner slivers, at most (4 - π) r² in total).
    const L = 20;
    const W = 1.6;
    const r = 0.5;
    const stroke = rectProfile(L, W);
    const opened = pOffset(pOffset(stroke, -r, 'round'), r, 'round');
    const exact = L * W;
    const lost = exact - area(opened);
    expect(lost).toBeGreaterThanOrEqual(-1e-9);
    // Corner slivers: 4 corners, each (1 - π/4) r². With coarse arcs it was 0.5.
    expect(lost).toBeLessThan((4 - Math.PI) * r * r + 0.02);
  });

  it('roundedRect hits its closed-form area at a fillet radius the default mangled', () => {
    const w = 40;
    const h = 20;
    const r = 0.5;
    const exact = w * h - (4 - Math.PI) * r * r;
    expect(Math.abs(area(roundedRect(w, h, r)) - exact)).toBeLessThan(0.01);
  });

  it('an explicit segment count is still honoured, not overridden', () => {
    const coarse = area(circleProfile(0.5, 4));
    expect(coarse).toBeCloseTo(0.5, 6);
  });

  it('miter joins are untouched', () => {
    const got = area(pOffset(rectProfile(10, 10), 1, 'miter'));
    expect(got).toBeCloseTo(144, 9);
  });

  it('translation is irrelevant to the result', () => {
    const a = area(pOffset(rectProfile(10, 10), 0.5, 'round'));
    const b = area(pTranslate([123.4, -56.7], pOffset(rectProfile(10, 10), 0.5, 'round')));
    expect(b).toBeCloseTo(a, 6);
  });
});

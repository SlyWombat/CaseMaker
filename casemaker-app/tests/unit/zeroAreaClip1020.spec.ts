/**
 * #1020 — A TOUCH IS NOT AN OVERLAP, AND NEAR-VERTICAL IS "NO CEILING" ONLY FOR THE POCKET'S OWN
 * BOUND — NEVER FOR THE SHARED FACET CLASSIFICATION `dropcutter.ts` ALSO READS.
 *
 * The organizer's exact per-cell ceiling bound (#1003: `clippedTriangleToSquare` +
 * `planeMaxOverPolygon`/`planeMaxOverSquare`) closed cell [26.25, 26.50] × [89.50, 89.75] on
 * facets that never really covered it: a vertical step-wall facet (40850/40851) and a shelf
 * facet (40284/40320) that only TOUCH the cell's own edge at x = 26.500 — their clip to the
 * square is a degenerate, zero-area sliver, but `clippedTriangleToSquare` returned it as a real
 * polygon (non-empty, `poly.length > 0`), and the plane's max over that sliver closed the cell at
 * a height nothing above it actually has.
 *
 * FIX 1 (kept as first proposed): `clippedTriangleToSquare` now rejects a degenerate clip — the
 * shoelace area is the exact test, a vertex count alone cannot tell a touch from a real overlap.
 *
 * FIX 2 (C's review corrected this): the FIRST attempt folded a near-vertical skip into
 * `buildTriangleBins`' own `planeA` classification — shared with `dropcutter.ts:425`'s facet
 * contact, which needs a near-vertical (87-89.9°) facet's REAL contact (a flat's rim touching a
 * steep drafted wall in its interior, away from any edge). That fed a false-negative into every
 * op's CL, not just the pocket's own bound — a possible gouge, worse than the 0.2 mm lip this
 * issue started from. The corrected fix: `planeA` stays the EXACT-degenerate test only
 * (`|nz| < 1e-9`), and the near-vertical question (`isNearVertical`, `|nz| / |n| < 0.05`) is
 * answered only where the POCKET's own per-cell bound reads it (`ops/pocket.ts`'s `cellBound`
 * loop) — never applied to the shared plane itself.
 */
import { describe, expect, it } from 'vitest';

import { buildTriangleBins, clippedTriangleToSquare, isNearVertical } from '@/engine/cnc/cam/model/triangleBins';
import { dropCutterHeight, profileOf, type DropCutterMesh } from '@/engine/cnc/cam/model/dropcutter';
import { flatEndMill } from '@/engine/cnc/tool';

function meshOf(tris: readonly [number, number, number][][]): DropCutterMesh {
  const positions = new Float32Array(tris.length * 9);
  let k = 0;
  for (const t of tris) for (const v of t) { positions[k++] = v[0]; positions[k++] = v[1]; positions[k++] = v[2]; }
  const indices = new Uint32Array(tris.length * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices, triangleCount: tris.length };
}

// Far-away filler so a one/two-facet mesh still has real XY extent (`buildTriangleBins`' own
// requirement), without ever overlapping the cell/probe under test.
const FILLER: [number, number, number][] = [[-50, -50, 0], [-49, -50, 0], [-50, -49, 0]];

/** Perpendicular distance from `(px, py)` to the segment `(x0,y0)-(x1,y1)`, in XY. */
function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  const ex = x0 + t * dx - px, ey = y0 + t * dy - py;
  return Math.hypot(ex, ey);
}

describe('#1020 — the exact per-cell bound rejects a touch, never the shared facet classification', () => {
  it('a vertical wall facet exactly along the cell edge x = 26.5 clips to null, not a degenerate sliver', () => {
    // The organizer's own cell: [26.25, 26.50] × [89.50, 89.75]. A vertical wall in the XZ plane
    // at x = 26.5 (the cell's own right edge), spanning past the cell's Y range — it never enters
    // the cell's interior, only touches its boundary.
    const mesh = meshOf([
      [[26.5, 89, 0], [26.5, 90.25, 0], [26.5, 90.25, 20]],
      [[26.5, 89, 0], [26.5, 90.25, 20], [26.5, 89, 20]],
      FILLER,
    ]);
    const bins = buildTriangleBins(mesh);
    const poly = clippedTriangleToSquare(bins, 0, 26.25, 89.5, 26.5, 89.75);
    expect(poly, 'a vertical facet touching only the cell edge must clip to null — it covers no real area of the cell').toBeNull();
  });

  it('a shelf facet that only touches the cell edge clips to null the same way', () => {
    // A near-horizontal shelf facet whose own footprint sits just outside [26.25,26.50]x[89.50,89.75],
    // touching it only along x = 26.5.
    const mesh = meshOf([
      [[26.5, 89.5, 5], [27.5, 89.5, 5], [27.5, 90.25, 5]],
      FILLER,
    ]);
    const bins = buildTriangleBins(mesh);
    const poly = clippedTriangleToSquare(bins, 0, 26.25, 89.5, 26.5, 89.75);
    expect(poly, 'a shelf facet touching only the cell edge must clip to null').toBeNull();
  });

  it('a genuinely overlapping, moderately-sloped facet still clips and bounds the cell (not a blanket refusal)', () => {
    const mesh = meshOf([
      [[26, 89.4, 1], [27, 89.4, 1], [26, 90, 2]],
      FILLER,
    ]);
    const bins = buildTriangleBins(mesh);
    const poly = clippedTriangleToSquare(bins, 0, 26.25, 89.5, 26.5, 89.75);
    expect(poly, 'a facet that genuinely covers the cell must still clip to a real polygon').not.toBeNull();
    expect(isNearVertical(bins, 0), 'this facet is nowhere near vertical').toBe(false);
  });

  it('isNearVertical: exactly vertical, near-vertical (2°) and clearly-sloped facets classify correctly', () => {
    // Exactly vertical (XZ plane) + a clearly-sloped facet (45°-ish) + filler.
    const mesh = meshOf([
      [[0, 0, 0], [0, 1, 0], [0, 1, 1]], // exactly vertical
      [[10, 10, 0], [11, 10, 0], [10, 11, 1]], // ~45 degrees, clearly not near-vertical
      FILLER,
    ]);
    const bins = buildTriangleBins(mesh);
    expect(isNearVertical(bins, 0), 'an exactly vertical facet is near-vertical').toBe(true);
    expect(isNearVertical(bins, 1), 'a ~45° facet is not near-vertical').toBe(false);
  });

  it('#1020 red-first (C\'s review): a drop-cutter facet contact at 88° from horizontal, in the facet\'s own interior, survives — never folded into the shared planeA classification', () => {
    // A wall tilted 2° from vertical (88° from horizontal) about the Y axis: a point at slant
    // parameter h, row s sits at (h·sin2°, s, h·cos2°) — exactly the organizer's own near-vertical
    // step-wall class (facets 40850/40851), built large enough that its incentre sits comfortably
    // (> the flat's own radius) from every one of its 3 edges, so only the FACET — never an edge —
    // can answer a probe there.
    const deg2 = (2 * Math.PI) / 180;
    const s2 = Math.sin(deg2), c2 = Math.cos(deg2);
    const H = 60, W = 60; // slant extent, row extent
    const P00: [number, number, number] = [0, 0, 0];
    const P10: [number, number, number] = [H * s2, 0, H * c2];
    const P11: [number, number, number] = [H * s2, W, H * c2];
    const mesh = meshOf([[P00, P10, P11], FILLER]);
    const bins = buildTriangleBins(mesh);
    expect(isNearVertical(bins, 0), 'a 2°-from-vertical facet IS near-vertical, by the pocket bound\'s own 0.05 cosine rule').toBe(true);

    // The incentre of [P00, P10, P11] — the point farthest (in XY) from all three edges.
    const aLen = Math.hypot(P11[0] - P10[0], P11[1] - P10[1]);
    const bLen = Math.hypot(P11[0] - P00[0], P11[1] - P00[1]);
    const cLen = Math.hypot(P10[0] - P00[0], P10[1] - P00[1]);
    const wSum = aLen + bLen + cLen;
    const px = (aLen * P00[0] + bLen * P10[0] + cLen * P11[0]) / wSum;
    const py = (aLen * P00[1] + bLen * P10[1] + cLen * P11[1]) / wSum;
    const inradius = Math.min(
      distToSegment(px, py, P00[0], P00[1], P10[0], P10[1]),
      distToSegment(px, py, P10[0], P10[1], P11[0], P11[1]),
      distToSegment(px, py, P00[0], P00[1], P11[0], P11[1]),
    );
    const R = 0.2;
    expect(inradius, 'the probe must sit well clear of every edge, or an edge could answer instead of the facet').toBeGreaterThan(R * 2);

    const profile = profileOf(flatEndMill(2 * R, { number: 1, id: 'flat', name: 'flat' }));
    expect(profile).not.toBeNull();
    const z = dropCutterHeight(profile!, mesh, px, py);
    // Pre-fix (the facet wrongly folded into `planeA`'s own NaN), this near-vertical facet's
    // interior contact is skipped entirely and no edge is in reach — `dropCutterHeight` would
    // return `null`. Post-fix, the facet answers: a real, finite height on the wall.
    expect(z, 'the facet contact must survive: a near-vertical facet, probed in its own interior, must not read null').not.toBeNull();
    expect(Number.isFinite(z), 'the returned height must be finite').toBe(true);
  });
});

/**
 * #1020 — A TOUCH IS NOT AN OVERLAP, AND NEAR-VERTICAL IS AS GOOD AS VERTICAL.
 *
 * The organizer's exact per-cell ceiling bound (#1003: `clippedTriangleToSquare` +
 * `planeMaxOverPolygon`/`planeMaxOverSquare`) closed cell [26.25, 26.50] × [89.50, 89.75] on
 * facets that never really covered it: a vertical step-wall facet (40850/40851) and a shelf
 * facet (40284/40320) that only TOUCH the cell's own edge at x = 26.500 — their clip to the
 * square is a degenerate, zero-area sliver, but `clippedTriangleToSquare` returned it as a real
 * polygon (non-empty, `poly.length > 0`), and the plane's max over that sliver closed the cell at
 * a height nothing above it actually has.
 *
 * Two independent fixes, each with its own red-first case here:
 *
 *   1. `clippedTriangleToSquare` now rejects a degenerate clip (the shoelace area is the exact
 *      test — a vertex count alone cannot tell a touch from a real overlap).
 *   2. The per-triangle plane classification (`buildTriangleBins`) used to test `|nz| < 1e-9` —
 *      scale-DEPENDENT (`nz` is a raw cross-product component, so it grows with the triangle's
 *      own area) and therefore only ever caught an EXACTLY vertical facet. A near-vertical one's
 *      plane (`a = -nx/nz`, `b = -ny/nz`) blows up as `nz` shrinks, reporting an unstable, often
 *      enormous Z over a cell it barely grazes. The scale-free question is the angle between the
 *      facet's own normal and up — `|nz| / |n|` is exactly that angle's cosine — and under 0.05
 *      (within ~3°of vertical) now gets the same "no real ceiling here" treatment (`planeA`
 *      reads `NaN`) the exactly-vertical case already had.
 */
import { describe, expect, it } from 'vitest';

import { buildTriangleBins, clippedTriangleToSquare, planeMaxOverPolygon } from '@/engine/cnc/cam/model/triangleBins';
import type { DropCutterMesh } from '@/engine/cnc/cam/model/dropcutter';

function meshOf(tris: readonly [number, number, number][][]): DropCutterMesh {
  const positions = new Float32Array(tris.length * 9);
  let k = 0;
  for (const t of tris) for (const v of t) { positions[k++] = v[0]; positions[k++] = v[1]; positions[k++] = v[2]; }
  const indices = new Uint32Array(tris.length * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices, triangleCount: tris.length };
}

// Far-away filler so a one-facet mesh still has real XY extent (`buildTriangleBins`' own
// requirement), without ever overlapping the cell under test.
const FILLER: [number, number, number][] = [[-50, -50, 0], [-49, -50, 0], [-50, -49, 0]];

describe('#1020 — the exact per-cell bound rejects a touch, and a near-vertical facet', () => {
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

  it('a shelf facet that only touches the cell corner/edge clips to null the same way', () => {
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

  it('a near-vertical facet (2° off vertical, |nz|/|n| ≈ 0.0499 < 0.05) reads no ceiling, not an unstable plane', () => {
    const mesh = meshOf([
      [[0, 0, 0], [1, 0, 0.001], [0, 1, 20]],
      FILLER,
    ]);
    const bins = buildTriangleBins(mesh);
    const z = planeMaxOverPolygon(bins, 0, new Float64Array([0, 0, 1, 0, 0, 1]));
    expect(z, 'a near-vertical facet must read -Infinity (no real ceiling), never a huge unstable Z').toBe(Number.NEGATIVE_INFINITY);
  });

  it('a genuinely overlapping, moderately-sloped facet still bounds the cell (the fix is not a blanket refusal)', () => {
    // A facet at 30° from horizontal (well past the 0.05 ratio, |nz|/|n| = cos(60°) = 0.5), whose
    // footprint genuinely covers the cell's own square.
    const mesh = meshOf([
      [[26, 89.4, 1], [27, 89.4, 1], [26, 90, 2]],
      FILLER,
    ]);
    const bins = buildTriangleBins(mesh);
    const poly = clippedTriangleToSquare(bins, 0, 26.25, 89.5, 26.5, 89.75);
    expect(poly, 'a facet that genuinely covers the cell must still clip to a real polygon').not.toBeNull();
    const z = planeMaxOverPolygon(bins, 0, poly);
    expect(z, 'and its own plane height must still bound the cell').toBeGreaterThan(-Infinity);
  });
});

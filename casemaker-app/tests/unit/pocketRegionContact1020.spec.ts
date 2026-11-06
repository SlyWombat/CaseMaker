/**
 * #1020 (the second half) — A TOUCH IS NOT AN AREA, AGAINST THE REGION BOUNDARY. The region clip
 * admitted a facet whose only contact with the pocket was a single vertex 65 nm inside the wall
 * line (Float32 placement rounds 26.5 to 26.499935 on the organizer): the cell closed, the floor
 * ring bowed 0.25 mm and twelve fins of 0.6–2.3 mm stood (149 cells). RED-FIRST at the parent: the
 * point-strict test says the 1e-7 vertex IS inside, so the first case closes a cell it must not.
 */
import { describe, expect, it } from 'vitest';

import { polygonOverlapsRegion } from '@/engine/cnc/cam/model/ops/pocket';

/** A square pocket region, 10 mm on a side, wall at x = 10. */
const REGION: [number, number][][] = [[[0, 0], [10, 0], [10, 10], [0, 10]]];

function poly(points: number[]): Float64Array {
  return Float64Array.from(points);
}

describe('#1020 — the region clip decides by positive area', () => {
  it('a facet whose only contact is a vertex 65 nm inside the wall does not close the cell — THE RED CASE', () => {
    // 65 nm = 6.5e-5 mm: INSIDE the old point test's 1e-6 boundary epsilon, i.e. the parent reads
    // it as "strictly in" and closes the cell. The area it really covers is ~3e-6 mm².
    const facet = poly([10 - 6.5e-5, 5, 11, 4, 11, 6]);
    expect(polygonOverlapsRegion(facet, REGION)).toBe(false);
  });

  it('a vertex a nanometre inside is contact too', () => {
    const facet = poly([10 - 1e-7, 5, 11, 4, 11, 6]);
    expect(polygonOverlapsRegion(facet, REGION)).toBe(false);
  });

  it('a facet genuinely 0.05 mm inside the wall does close it', () => {
    const facet = poly([10 - 0.05, 5, 11, 4, 11, 6]);
    expect(polygonOverlapsRegion(facet, REGION)).toBe(true);
  });

  it('an edge lying exactly on the wall is contact, not area', () => {
    const facet = poly([10, 3, 10, 7, 11, 5]);
    expect(polygonOverlapsRegion(facet, REGION)).toBe(false);
  });

  it('a facet crossing the region with every vertex outside still overlaps — #1003 stays closed', () => {
    const facet = poly([-1, 5, 11, 3, 11, 7]);
    expect(polygonOverlapsRegion(facet, REGION)).toBe(true);
  });
});

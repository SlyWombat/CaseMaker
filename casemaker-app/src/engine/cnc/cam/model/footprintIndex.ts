/**
 * #1134 — THE FOOTPRINT TEST, INDEXED.
 *
 * `clSurface.dropCutter` guards every query with `pointInPolygons(footprint)` and an
 * `onBoundary(footprint)` distance test, and the FINISH mask asks the CL at the cell's own point
 * plus its eight footprint-ring points: 18 guarded queries per mask cell, thousands of cells per
 * sequence the price ranks. The #1134 profile of the ideal half put `pointInPolygons` at 40.2 %
 * SELF under `maskCellsExact` (69.5 % inclusive) — the guard scanned every edge of every ring on
 * every query (and `onBoundary` rebuilt the footprint's bbox from scratch each time).
 *
 * This module answers the SAME two predicates over the same rings, with a spatial index: the
 * edges are bucketed by the footprint rows their y-range covers, and a query tests only the edges
 * that can cross its own row (even-odd, `pointInPolygons`' exact comparison) or lie within `eps`
 * of it (the distance rule `onBoundary` used). Nothing about the predicates moves:
 *
 *   - contains: `(y1 > y) !== (y2 > y) && x < ((x2 − x1)·(y − y1))/(y2 − y1) + x1`, toggled;
 *   - within:   `dist(point, segment) ≤ eps`, the closest point clamped to the segment.
 *
 * An edge not in the query's row CANNOT satisfy either predicate: a crossing needs the point's y
 * strictly between the edge's endpoints' y (half-open: equal to the lower endpoint crosses, equal
 * to the upper does not), and a distance ≤ eps needs y within eps of the edge's y-range. Every
 * edge is bucketed over its CLOSED y-interval, expanded by eps for the distance rule, so both
 * tests see every edge the raw scan would have accepted — different work, identical answers. The
 * unit test proves it point for point against `pointInPolygons` and the original boundary rule.
 */

import type { Polygons } from '@/engine/cnc/cam/pocket';

export interface FootprintBBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface FootprintIndex {
  readonly bbox: FootprintBBox;
  /** `pointInPolygons(footprint, x, y)`, answered from the row index. */
  contains(x: number, y: number): boolean;
  /** The boundary rule (`dist ≤ eps` on any edge), answered from the row index. */
  within(x: number, y: number, eps?: number): boolean;
}

/** How many rows the index buckets the footprint into — thin enough that a row holds few edges. */
const ROW_TARGET = 256;

/** The default boundary tolerance, the one `clSurface`'s old `onBoundary` used. */
export const FOOTPRINT_BOUNDARY_EPS = 1e-9;

export function footprintIndex(footprint: Polygons): FootprintIndex {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of footprint) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const bbox: FootprintBBox = { minX, minY, maxX, maxY };
  const empty = !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY);
  const height = empty ? 0 : maxY - minY;
  // One row for a degenerate (zero-height or empty) footprint; `rowH` is never zero.
  const rows = empty || !(height > 0) ? 1 : ROW_TARGET;
  const rowH = empty || !(height > 0) ? 1 : height / rows;
  const bucketEdges: { x1: number; y1: number; x2: number; y2: number }[][] = Array.from({ length: rows }, () => []);
  if (!empty) {
    const rowOf = (y: number): number => {
      const at = Math.floor((y - minY) / rowH);
      return at < 0 ? 0 : at >= rows ? rows - 1 : at;
    };
    for (const ring of footprint) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [x1, y1] = ring[j]!;
        const [x2, y2] = ring[i]!;
        // The CLOSED y-interval, expanded by the boundary tolerance: a point level with the lower
        // endpoint is a crossing (the raw comparison is `>` on both ends, so the interval is
        // half-open), and a point within eps of either end is a boundary hit.
        const low = Math.min(y1, y2) - FOOTPRINT_BOUNDARY_EPS;
        const high = Math.max(y1, y2) + FOOTPRINT_BOUNDARY_EPS;
        const first = rowOf(low);
        const last = rowOf(high);
        const edge = { x1, y1, x2, y2 };
        for (let row = first; row <= last; row++) bucketEdges[row]!.push(edge);
      }
    }
  }
  const rowOf = (y: number): number => {
    const at = Math.floor((y - minY) / rowH);
    return at < 0 ? 0 : at >= rows ? rows - 1 : at;
  };
  return {
    bbox,
    contains(x: number, y: number): boolean {
      // Outside the bbox no edge can cross: a crossing needs the intersection's x inside the
      // footprint, and the point's y inside the footprint's y-range. Same answer as the raw scan.
      if (empty || y < minY || y > maxY || x < minX || x > maxX) return false;
      let inside = false;
      for (const edge of bucketEdges[rowOf(y)]!) {
        const { x1, y1, x2, y2 } = edge;
        if (y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) inside = !inside;
      }
      return inside;
    },
    within(x: number, y: number, eps: number = FOOTPRINT_BOUNDARY_EPS): boolean {
      if (empty || x < minX - eps || x > maxX + eps || y < minY - eps || y > maxY + eps) return false;
      for (const edge of bucketEdges[rowOf(y)]!) {
        const { x1, y1, x2, y2 } = edge;
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2)) : 0;
        if (Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= eps) return true;
      }
      return false;
    },
  };
}

/**
 * The spatial through-cut mask (#218), built from the geometry the CAM actually cut.
 *
 * `verify.ts` asks one question at an XY: how deep may the cutter go here? This module answers
 * it from the paths and regions generation produced — not from the document, so the check and
 * the toolpath cannot drift apart:
 *
 *   - inside a THROUGH REGION's opened polygons → `thickness + breakthrough` (plus the region's
 *     `extraDepth`, which a drill's point needs below the full diameter);
 *   - inside a THROUGH DRILL's cutter disc       → `thickness + breakthrough`;
 *   - inside a cut-out KERF (within the cutter radius of the centre path):
 *       across a TAB SPAN                        → `thickness − tabs.height` (the tab's top);
 *       anywhere else                            → `thickness + breakthrough`;
 *   - everywhere else                             → `null` (the ordinary floor rule stands).
 *
 * Pure arithmetic, no wasm: point-in-polygon is even-odd, a kerf is a distance to a segment,
 * and a tab span is an interval in the contour's own arc length. That is what lets the verifier
 * stay cheap enough to run on the whole file.
 */

import type { ThroughMask } from '../verify';
import type { Polygons } from '../cam/pocket';
import type { ProfileSpan } from '../cam/profile';

/** A cut-out's kerf, as the CAM laid it: the centre path, its tab spans and the cutter radius. */
export interface MaskCutout {
  path: Polygons;
  /** One span list per contour of `path`, in the same order. */
  spans: ProfileSpan[][];
  toolRadius: number;
  tabHeight: number;
}

/**
 * One through region's opened polygons. `extraDepth` is how much deeper than the board allowance
 * the cut legitimately reaches: a through DRILL's point adds its own length below the full
 * diameter, and the file's deepest move is the tip. Absent (0) for every other through region.
 */
export interface MaskRegion {
  polygons: Polygons;
  extraDepth?: number;
}

export interface MaskGeometry {
  /** The part's thickness, mm — the tab top is measured down from this. */
  thickness: number;
  breakthrough: number;
  /** Opened polygons of every through REGION (shape pocket, drill disc). */
  regions?: MaskRegion[];
  /** Every through DRILL: hole centres and the cutter radius. */
  drills?: { holes: readonly [number, number][]; radius: number }[];
  cutouts?: MaskCutout[];
}

/** Even-odd point-in-polygon over a set of closed contours (outers and holes alike). */
export function pointInPolygons(polygons: Polygons, x: number, y: number): boolean {
  let inside = false;
  for (const contour of polygons) {
    for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
      const [xi, yi] = contour[i]!;
      const [xj, yj] = contour[j]!;
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The closest point on segment `a-b` to `(x, y)`, with the segment's parameter t and distance. */
function closestOnSegment(
  x: number,
  y: number,
  a: readonly [number, number],
  b: readonly [number, number],
): { distance: number; t: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
  return { distance: Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy)), t };
}

/**
 * The post writes coordinates to 0.001 mm (`post/z1.ts` rounds each axis). A tab span's end is
 * where the cutter plunges back to the through depth, and that same point in the IR can round to
 * a thousandth on either side of the interval. Comparing the arc with this resolution keeps the
 * file's own rounded plunge from being refused as a cut through the tab: a point within one post
 * step of a span's end is treated as the through side. That is at most 0.001 mm of extra material
 * at the tab's root — far below the machine's own positioning.
 */
const SPAN_END_TOLERANCE_MM = 0.001;

/**
 * Is arc `s` inside one of the span intervals, clear of both ends? A span may wrap past the
 * perimeter when it crosses the contour's first vertex (#736); `perimeter` puts the two on the
 * same turn of the circle.
 */
function inTabSpan(spans: readonly ProfileSpan[], s: number, perimeter: number): boolean {
  for (const span of spans) {
    if (perimeter > 0 && span.endArc > perimeter) {
      // The span covers [startArc, perimeter) and [0, endArc - perimeter).
      const end = span.endArc - perimeter;
      if (s > span.startArc + SPAN_END_TOLERANCE_MM && s <= perimeter) return true;
      if (s < end - SPAN_END_TOLERANCE_MM) return true;
    } else if (s > span.startArc + SPAN_END_TOLERANCE_MM && s < span.endArc - SPAN_END_TOLERANCE_MM) {
      return true;
    }
  }
  return false;
}

/** The contour's closed length, mm. */
function perimeterOf(contour: Polygons[number]): number {
  let perimeter = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    perimeter += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return perimeter;
}

/**
 * The mask for a job's through work, or `null` when the job has none — `null` keeps
 * `jobDepthLimit` exactly as it was for every job before #218.
 */
export function buildThroughMask(geometry: MaskGeometry): ThroughMask | null {
  const regions = geometry.regions ?? [];
  const drills = geometry.drills ?? [];
  const cutouts = geometry.cutouts ?? [];
  if (regions.length === 0 && drills.length === 0 && cutouts.length === 0) return null;
  const throughLimit = geometry.thickness + geometry.breakthrough;

  return (x: number, y: number): number | null => {
    // The kerf first, because its tab spans must LOWER the limit inside the band.
    for (const cutout of cutouts) {
      for (let c = 0; c < cutout.path.length; c++) {
        const contour = cutout.path[c]!;
        const spans = cutout.spans[c] ?? [];
        const perimeter = perimeterOf(contour);
        // The arc is the one at the NEAREST point on the path, not the first segment within the
        // cutter radius. On a polygonised arc a span end is a fraction of a millimetre from the
        // previous vertex; returning that earlier segment's arc read the plunge at the span's end
        // as inside the tab (it is 0.3 mm back from the end) and refused the through cut as too
        // deep. The nearest point to a span end is the end itself, at distance 0.
        let arc = 0;
        let bestDistance = Infinity;
        let bestArc = 0;
        for (let i = 0; i < contour.length; i++) {
          const a = contour[i]!;
          const b = contour[(i + 1) % contour.length]!;
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const hit = closestOnSegment(x, y, a, b);
          if (hit.distance <= cutout.toolRadius + 1e-6 && hit.distance < bestDistance) {
            bestDistance = hit.distance;
            bestArc = arc + hit.t * length;
          }
          arc += length;
        }
        if (bestDistance <= cutout.toolRadius + 1e-6) {
          return inTabSpan(spans, bestArc, perimeter)
            ? geometry.thickness - cutout.tabHeight
            : throughLimit;
        }
      }
    }
    for (const region of regions) {
      if (pointInPolygons(region.polygons, x, y)) {
        return throughLimit + (region.extraDepth ?? 0);
      }
    }
    for (const drill of drills) {
      for (const [hx, hy] of drill.holes) {
        if (Math.hypot(x - hx, y - hy) <= drill.radius + 1e-6) return throughLimit;
      }
    }
    return null;
  };
}

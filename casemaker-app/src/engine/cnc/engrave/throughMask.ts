/**
 * The spatial through-cut mask (#218), built from the geometry the CAM actually cut.
 *
 * `verify.ts` asks one question at an XY: how deep may the cutter go here? This module answers
 * it from the paths and regions generation produced — not from the document, so the check and
 * the toolpath cannot drift apart:
 *
 *   - inside a THROUGH REGION's opened polygons → `thickness + breakthrough`;
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

export interface MaskGeometry {
  /** The part's thickness, mm — the tab top is measured down from this. */
  thickness: number;
  breakthrough: number;
  /** Opened polygons of every through REGION (shape pocket). */
  regions?: Polygons[];
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

/** Is arc `s` strictly inside one of the (non-wrapping) span intervals? */
function inTabSpan(spans: readonly ProfileSpan[], s: number): boolean {
  for (const span of spans) {
    if (s > span.startArc + 1e-9 && s < span.endArc - 1e-9) return true;
  }
  return false;
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
        let arc = 0;
        for (let i = 0; i < contour.length; i++) {
          const a = contour[i]!;
          const b = contour[(i + 1) % contour.length]!;
          const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const hit = closestOnSegment(x, y, a, b);
          if (hit.distance <= cutout.toolRadius + 1e-6) {
            return inTabSpan(spans, arc + hit.t * length)
              ? geometry.thickness - cutout.tabHeight
              : throughLimit;
          }
          arc += length;
        }
      }
    }
    for (const polygons of regions) {
      if (pointInPolygons(polygons, x, y)) return throughLimit;
    }
    for (const drill of drills) {
      for (const [hx, hy] of drill.holes) {
        if (Math.hypot(x - hx, y - hy) <= drill.radius + 1e-6) return throughLimit;
      }
    }
    return null;
  };
}

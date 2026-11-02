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
 * and a tab span is an interval in the contour's own arc length.
 *
 * #912 — A MASK THAT ANSWERS IN CONSTANT WORK. The verifier consults the mask at every cutting
 * move, tens of thousands of times on a real file. The first cut answered each query by walking
 * EVERY segment of every kerf and recomputing each contour's perimeter: on the demo's coaster
 * (j21) that was 28.5 minutes of the run, 93 % of it inside this file. The geometry is now
 * prepared once — segments with their arcs, edges bucketed by row, both in a uniform grid — so a
 * query costs the few segments near the point. The answers are unchanged, segment for segment:
 * a segment within the cutter's radius of the point necessarily shares its grid cell or one
 * beside it, and an even-odd ray crosses only edges whose y range contains the point's row.
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

/** One contour's segments with their cumulative arc, prepared once (#912). */
interface PreparedContour {
  /** Flat: ax, ay, bx, by, len, arcStart per segment. */
  segs: number[];
  perimeter: number;
  /** Segment indices by grid cell (key from {@link cellKey}). */
  cells: Map<number, number[]>;
}

/** A through region's edges, bucketed by the rows of cells they cross (#912). */
interface PreparedRegion {
  /** Flat: x1, y1, x2, y2 per edge. */
  edges: number[];
  /** Edge indices by row band (key from {@link cellKey}). */
  bands: Map<number, number[]>;
  extraDepth: number;
}

/** One grid cell, as a number. The sizes here are far below 2^26 in each axis. */
function cellKey(cx: number, cy: number): number {
  return (cx + 4096) * 8192 + (cy + 4096);
}

/**
 * The grid cell size a prepared geometry uses: strictly wider than the cutter's acceptance
 * radius (`toolRadius + 1e-6`), so any segment within it shares the point's cell or one beside
 * it; never under 2 mm.
 */
function cellSizeFor(toolRadius: number): number {
  return Math.max(2, toolRadius + 0.001);
}

/** Prepare one cut-out contour: segments, arcs, and the cell buckets its segments cross. */
function prepareContour(contour: Polygons[number], cell: number): PreparedContour {
  const segs: number[] = [];
  const cells = new Map<number, number[]>();
  let arc = 0;
  for (let i = 0; i < contour.length; i++) {
    const a = contour[i]!;
    const b = contour[(i + 1) % contour.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const id = segs.length / 6;
    segs.push(a[0], a[1], b[0], b[1], len, arc);
    // Every cell the segment's bounding box crosses. A point ON the segment shares one of them.
    const x0 = Math.floor(Math.min(a[0], b[0]) / cell);
    const x1 = Math.floor(Math.max(a[0], b[0]) / cell);
    const y0 = Math.floor(Math.min(a[1], b[1]) / cell);
    const y1 = Math.floor(Math.max(a[1], b[1]) / cell);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(cx, cy);
        const list = cells.get(key);
        if (list === undefined) cells.set(key, [id]);
        else list.push(id);
      }
    }
    arc += len;
  }
  return { segs, perimeter: arc, cells };
}

/** Prepare one through region for even-odd tests: edges bucketed by the row bands they span. */
function prepareRegion(region: MaskRegion, cell: number): PreparedRegion {
  const edges: number[] = [];
  const bands = new Map<number, number[]>();
  for (const contour of region.polygons) {
    for (let i = 0, j = contour.length - 1; i < contour.length; j = i++) {
      const [xi, yi] = contour[i]!;
      const [xj, yj] = contour[j]!;
      const id = edges.length / 4;
      edges.push(xi, yi, xj, yj);
      const y0 = Math.floor(Math.min(yi, yj) / cell);
      const y1 = Math.floor(Math.max(yi, yj) / cell);
      for (let cy = y0; cy <= y1; cy++) {
        const key = cellKey(0, cy);
        const list = bands.get(key);
        if (list === undefined) bands.set(key, [id]);
        else list.push(id);
      }
    }
  }
  return { edges, bands, extraDepth: region.extraDepth ?? 0 };
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

  // #912 — prepare once, answer cheap. A kerf's cell size is its cutter's radius (2 mm at
  // least): a segment within that radius of a point necessarily crosses the point's cell or one
  // beside it, so a query reads the 3×3 block and finds every candidate. Nothing about the
  // ANSWERS changes: the candidates are then measured with the same closest-point arithmetic and
  // in the same segment order, so an equal-distance tie still resolves to the first segment.
  const preparedCutouts = cutouts.map((cutout) => {
    const cell = cellSizeFor(cutout.toolRadius);
    return {
      cutout,
      cell,
      contours: cutout.path.map((contour) => prepareContour(contour, cell)),
      // Scratch for candidate ids and their de-duplication, reused across queries.
      stamp: new Int32Array(0),
      seen: new Int32Array(0),
      counter: 0,
    };
  });
  const preparedRegions = regions.map((region) => {
    const cell = 2;
    return { cell, prepared: prepareRegion(region, cell) };
  });

  return (x: number, y: number): number | null => {
    // The kerf first, because its tab spans must LOWER the limit inside the band.
    for (const prepared of preparedCutouts) {
      const { cutout, cell } = prepared;
      const qx = Math.floor(x / cell);
      const qy = Math.floor(y / cell);
      for (let c = 0; c < prepared.contours.length; c++) {
        const contour = prepared.contours[c]!;
        const spans = cutout.spans[c] ?? [];
        const limit = cutout.toolRadius + 1e-6;
        // Candidates in the 3×3 block, deduplicated by a stamp so a segment registered in several
        // cells is measured once; ordered by segment index (the first equal-distance one wins, as
        // the one-pass version did).
        if (prepared.stamp.length < contour.segs.length / 6) {
          prepared.stamp = new Int32Array(contour.segs.length / 6);
          prepared.seen = new Int32Array(contour.segs.length / 6);
        }
        prepared.counter++;
        let count = 0;
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const list = contour.cells.get(cellKey(qx + dx, qy + dy));
            if (list === undefined) continue;
            for (const id of list) {
              if (prepared.seen[id] === prepared.counter) continue;
              prepared.seen[id] = prepared.counter;
              prepared.stamp[count++] = id;
            }
          }
        }
        if (count === 0) continue;
        const ids = prepared.stamp.subarray(0, count);
        ids.sort();
        let bestDistance = Infinity;
        let bestArc = 0;
        for (const id of ids) {
          const base = id * 6;
          const ax = contour.segs[base]!;
          const ay = contour.segs[base + 1]!;
          const bx = contour.segs[base + 2]!;
          const by = contour.segs[base + 3]!;
          const len = contour.segs[base + 4]!;
          const arcStart = contour.segs[base + 5]!;
          const hit = closestOnSegment(x, y, [ax, ay], [bx, by]);
          if (hit.distance <= limit && hit.distance < bestDistance) {
            bestDistance = hit.distance;
            bestArc = arcStart + hit.t * len;
          }
        }
        if (bestDistance <= limit) {
          return inTabSpan(spans, bestArc, contour.perimeter)
            ? geometry.thickness - cutout.tabHeight
            : throughLimit;
        }
      }
    }
    for (const { cell, prepared } of preparedRegions) {
      const key = cellKey(0, Math.floor(y / cell));
      const list = prepared.bands.get(key);
      let inside = false;
      if (list !== undefined) {
        for (const id of list) {
          const base = id * 4;
          const xi = prepared.edges[base]!;
          const yi = prepared.edges[base + 1]!;
          const xj = prepared.edges[base + 2]!;
          const yj = prepared.edges[base + 3]!;
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
        }
      }
      if (inside) return throughLimit + prepared.extraDepth;
    }
    for (const drill of drills) {
      for (const [hx, hy] of drill.holes) {
        if (Math.hypot(x - hx, y - hy) <= drill.radius + 1e-6) return throughLimit;
      }
    }
    return null;
  };
}

/**
 * Contour-parallel pocketing rings (#172).
 *
 * The pure core: `(region, toolRadius, stepOver, offset) → rings`. It contains NO geometry
 * kernel — the offset is INJECTED — so it is tested in node with a trivial rectangle-offset
 * fake and never touches Manifold. The real offset (`CrossSection.offset`, Clipper2) is built
 * once in `engraveJob.ts` and passed in here. Do NOT write polygon offsetting by hand.
 *
 * `Polygons` is the work-frame shape `CrossSection.toPolygons()` returns: outer contours CCW,
 * holes CW (positive winding is material). One region is a list of closed contours.
 */

import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';

export type Polygons = [number, number][][];

/** Offsets a region by `delta` (delta < 0 shrinks). Injected so this file stays kernel-free. */
export type OffsetFn = (region: Polygons, delta: number) => Polygons;

/** #751 — the vertex count above which a contour is treated as a trace, not a design. */
export const DENSE_CONTOUR_VERTICES = 1024;

/** Perpendicular distance from `p` to the segment `a`→`b`, mm. */
function pointSegmentDistance(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / len;
}

/**
 * Ramer–Douglas–Peucker on one open chain, endpoints kept. ITERATIVE: a traced contour can be
 * arbitrarily long, and a recursive split on a zigzag is as deep as the chain (a stack overflow
 * on input the app does not control is worse than a slow simplification).
 */
function simplifyChain(
  points: readonly (readonly [number, number])[],
  tolerance: number,
): [number, number][] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop() as [number, number];
    const first = points[lo] as readonly [number, number];
    const last = points[hi] as readonly [number, number];
    let worst = -1;
    let at = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = pointSegmentDistance(points[i] as readonly [number, number], first, last);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at > lo) {
      keep[at] = 1;
      stack.push([lo, at], [at, hi]);
    }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i] === 1) {
      const p = points[i] as readonly [number, number];
      out.push([p[0], p[1]]);
    }
  }
  return out;
}

/**
 * #751 — SIMPLIFY A CLOSED CONTOUR BEFORE POCKETING.
 *
 * A raster- or CAD-traced contour can carry thousands of vertices, with segments down to
 * 0.004 mm — far below what the machine, the 0.1 mm simulation grid or the design's own
 * `ARC_CHORD_TOLERANCE_MM` can resolve. Pocketing offsets that contour ONCE PER RING and posts a
 * move per vertex, so a 6,048-point circle at 35 rings × 10 depths becomes two million moves:
 * the exact sweep then holds 350 checkpoint solids and exhausts the 4 GiB wasm heap (#751).
 *
 * The contour is simplified with Ramer–Douglas–Peucker at `ARC_CHORD_TOLERANCE_MM` — the same
 * chord tolerance every arc in the app is discretised at — so every kept vertex is needed and no
 * point moves by more than a tolerance the design already accepts. The ring is split at its first
 * vertex and the vertex farthest from it, so the closing edge is simplified like the rest of the
 * ring; a contour at or below {@link DENSE_CONTOUR_VERTICES} is returned unchanged.
 */
export function simplifyContour(
  contour: readonly (readonly [number, number])[],
  tolerance: number = ARC_CHORD_TOLERANCE_MM,
): [number, number][] {
  const points = contour.map(([x, y]) => [x, y] as [number, number]);
  // A contour the app itself tessellated (a glyph, an arc, a drawn shape) is left byte-identical:
  // simplifying it would move a wall by up to the tolerance and break the CAM's own "inside the
  // region shrunk by r" contract at its 0.001 mm margin. Only a traced/imported contour with more
  // than 1,024 vertices — where the vertex itself is far below what the machine or the 0.1 mm
  // simulation grid can resolve — is simplified.
  if (points.length <= DENSE_CONTOUR_VERTICES || !(tolerance > 0)) return points;
  const start = points[0] as [number, number];
  let far = 0;
  let best = -1;
  for (let i = 1; i < points.length; i++) {
    const p = points[i] as [number, number];
    const d = (p[0] - start[0]) ** 2 + (p[1] - start[1]) ** 2;
    if (d > best) {
      best = d;
      far = i;
    }
  }
  if (far === 0) return points;
  const first = simplifyChain([...points.slice(0, far + 1)], tolerance);
  // The second chain closes the ring: far … n−1, then back to the start point.
  const second = simplifyChain([...points.slice(far), start], tolerance);
  const out = [...first.slice(0, -1), ...second.slice(0, -1)];
  return out.length >= 3 ? out : points;
}

/** Simplify every contour of a region at the same tolerance; holes stay holes. */
export function simplifyRegion(
  region: Polygons,
  tolerance: number = ARC_CHORD_TOLERANCE_MM,
): Polygons {
  return region.map((contour) => simplifyContour(contour, tolerance));
}

/**
 * #191: a contour-parallel step-over larger than the tool radius leaves an uncut spine down
 * the middle of a stroke. This is the BACKSTOP — `feedsFor` (#202) is where the user's number
 * is checked and refused; this error exists so a caller that bypasses that gate cannot
 * silently produce a wall of uncut material. Never clamp here.
 */
export class StepOverTooLargeError extends Error {
  readonly stepOver: number;
  readonly toolRadius: number;
  /** The largest pitch this cut allows: the tool radius, or a V-bit's tip width. */
  readonly limit: number;
  constructor(stepOver: number, toolRadius: number, limit: number = toolRadius) {
    super(
      limit === toolRadius
        ? `step-over ${stepOver} mm exceeds the ${toolRadius} mm tool radius: contour-parallel ` +
            `loops would leave an uncut spine`
        : `step-over ${stepOver} mm exceeds the ${limit} mm cutter width: contour-parallel ` +
            `loops would leave an uncut spine`,
    );
    this.name = 'StepOverTooLargeError';
    this.stepOver = stepOver;
    this.toolRadius = toolRadius;
    this.limit = limit;
  }
}

/** A region with no contour, or with no contour long enough to bound an area. */
function isEmptyRegion(region: Polygons): boolean {
  return region.length === 0 || region.every((c) => c.length < 3);
}

/** Bounding-box diagonal of the region, mm. A safe upper bound on how far a shrinking chain runs. */
function maxExtent(region: Polygons): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of region) {
    for (const [x, y] of contour) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (minX === Infinity) return 0;
  return Math.hypot(maxX - minX, maxY - minY);
}

/**
 * Concentric pocketing rings for one region: ring k is the ORIGINAL region eroded by
 * `toolRadius + k × stepOver`, until the offset comes back empty.
 *
 * Each ring is offset from the ORIGINAL region, not from the previous ring. Both give the same
 * concentric geometry, but a chained offset re-runs Clipper on the previous ring's output, and
 * the round joins at every reflex corner add vertices that the next offset doubles again:
 * #734 measured a real glyph outline (555 vertices) growing 713 → 1053 → 1605 → 3101 → 6104 …
 * to 342 494 vertices by its tenth ring, so a 22-ring V-carve pocket never finished. Offsetting
 * the original every time keeps each ring's vertex count bounded by the input's.
 *
 * Returns the rings OUTERMOST FIRST — ring 0 is the one nearest the wall. A ring is a set of
 * closed contours, because a shrinking region can split into several islands (and a ring
 * around a hole carries the hole contour too); every contour is kept.
 *
 * `maxStepOver` is the pitch this CUT allows, and defaults to the tool radius — the #191 bound
 * for a flat end mill's contour-parallel loops. A floor cut by a V-bit's flat tip is the same
 * disc sweep with a smaller cutter, so its adjacent passes still meet while their pitch is up to
 * the TIP WIDTH (`2 × toolRadius`); `generateEngrave` passes that width. Never raise it above
 * twice the tool radius: beyond that the disc sweep leaves an uncut spine between passes.
 *
 * The loop is guarded: at most `ceil(maxExtent / stepOver) + 4` rings are produced before
 * throwing. An offset that never empties is a bug, not a long job, and a pocket that runs
 * forever is worse than one that refuses.
 */
export function pocketLoops(
  region: Polygons,
  toolRadius: number,
  stepOver: number,
  offset: OffsetFn,
  maxStepOver: number = toolRadius,
): Polygons[] {
  if (!(toolRadius > 0)) {
    throw new Error(`pocketLoops: toolRadius must be > 0, got ${toolRadius} mm`);
  }
  if (!(stepOver > 0)) {
    throw new Error(`pocketLoops: stepOver must be > 0, got ${stepOver} mm`);
  }
  if (!(maxStepOver > 0)) {
    throw new Error(`pocketLoops: maxStepOver must be > 0, got ${maxStepOver} mm`);
  }
  if (stepOver > maxStepOver) {
    throw new StepOverTooLargeError(stepOver, toolRadius, maxStepOver);
  }

  // #751 — the rings are offsets of this one region, so simplifying it once bounds EVERY ring's
  // vertex count. Without it a traced contour's 6,000 points become 2,000,000 posted moves.
  const simple = simplifyRegion(region);
  const rings: Polygons[] = [];
  const maxRings = Math.ceil(maxExtent(simple) / stepOver) + 4;
  let ring = 0;
  let current = offset(simple, -toolRadius);
  while (!isEmptyRegion(current)) {
    rings.push(current);
    if (rings.length > maxRings) {
      throw new Error(
        `pocketLoops: offset did not empty after ${maxRings} rings — the offset function is ` +
          `not shrinking the region (a bug, not a long job)`,
      );
    }
    ring += 1;
    current = offset(simple, -(toolRadius + ring * stepOver));
  }
  return rings;
}

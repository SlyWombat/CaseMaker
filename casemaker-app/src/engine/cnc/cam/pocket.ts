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

export type Polygons = [number, number][][];

/** Offsets a region by `delta` (delta < 0 shrinks). Injected so this file stays kernel-free. */
export type OffsetFn = (region: Polygons, delta: number) => Polygons;

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
 * Concentric pocketing rings for one region: the first ring is the region eroded by
 * `toolRadius`, then each subsequent ring erodes the previous by `stepOver`, until the
 * offset comes back empty.
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

  const rings: Polygons[] = [];
  const maxRings = Math.ceil(maxExtent(region) / stepOver) + 4;
  let current = offset(region, -toolRadius);
  while (!isEmptyRegion(current)) {
    rings.push(current);
    if (rings.length > maxRings) {
      throw new Error(
        `pocketLoops: offset did not empty after ${maxRings} rings — the offset function is ` +
          `not shrinking the region (a bug, not a long job)`,
      );
    }
    current = offset(current, -stepOver);
  }
  return rings;
}

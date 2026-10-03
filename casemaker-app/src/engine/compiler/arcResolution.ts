/**
 * Arc resolution for 2D profile ops (#190).
 *
 * Manifold picks a circular-segment count from the radius when you pass 0, and
 * that default COLLAPSES at small radii because its minCircularEdgeLength is
 * 1 mm: getCircularSegments(0.5) is 4. A "round" offset at r = 0.5 is therefore a
 * square — `CrossSection.circle(0.5)` has area 0.500 against an exact 0.785 —
 * with no error and a perfectly valid result.
 *
 * It does not touch anything that ships today (every circleProfile call passes
 * its own segment count, every pOffset call uses a miter join, and roundedRect
 * has no callers). It is latent: it bites the first caller that rounds a small
 * radius, which is exactly what the CAM work does — tool-radius opening for the
 * engravability check, and offset loops for pocketing.
 *
 * So the resolution is chosen from a chord-error TARGET rather than a segment
 * count, which makes it radius-independent: the same 0.005 mm of sagitta at a
 * 0.5 mm tool radius and a 25 mm fillet.
 */

/**
 * Maximum sagitta (chord-to-arc distance) a profile arc may have, in mm.
 *
 * This is deliberately one named constant. The CAM design had four unrelated
 * tolerances for one job — the sweep's caps, the default offset, simplify's
 * epsilon, and glyph flattening — and the oracle band has to be DERIVED from
 * them rather than hand-set (/Simulation.md §7). Whatever consumes arcs imports
 * this, so the band can be computed instead of guessed.
 */
export const ARC_CHORD_TOLERANCE_MM = 0.005;

/**
 * Vertex-removal tolerance applied to 2D regions in the sweep (`CrossSection.simplify`),
 * at every level of the union tree. Kept HERE, beside the chord tolerance, because the
 * oracle band in /Simulation.md §7 is derived from the two of them and must move when
 * either does: band >= levels x SWEEP_SIMPLIFY_EPS_MM + 2 x ARC_CHORD_TOLERANCE_MM.
 *
 * Verified safe for a flat-end sweep (review #191): deliberately uncut walls of 0.05, 0.01
 * and 0.003 mm all survive it with unchanged contour counts.
 */
export const SWEEP_SIMPLIFY_EPS_MM = 0.002;

const MIN_SEGMENTS = 8;
const MAX_SEGMENTS = 512;

/** Sagitta of an inscribed regular n-gon on a circle of radius r. */
export function chordError(radius: number, segments: number): number {
  return radius * (1 - Math.cos(Math.PI / segments));
}

/**
 * Segments per full circle so an inscribed polygon stays within `tolerance` of
 * the true arc.
 *
 * Rounded UP to a multiple of 4 so that the points at 0°, 90°, 180° and 270° are
 * vertices: an inscribed polygon then has exactly the circle's bounding box, so
 * an axis-aligned extent never shrinks by a chord error.
 *
 * Bounded both ways. A degenerate radius gets MIN_SEGMENTS rather than the 4 that
 * caused #190, and a huge one cannot ask for millions of vertices.
 */
export function segmentsForRadius(
  radius: number,
  tolerance: number = ARC_CHORD_TOLERANCE_MM,
): number {
  if (!Number.isFinite(radius) || radius <= 0 || !(tolerance > 0)) return MIN_SEGMENTS;
  // chord error e = r(1 - cos(π/n)) <= tol  =>  n >= π / acos(1 - tol/r).
  // When tol >= r the arc is smaller than the tolerance; the minimum applies.
  if (tolerance >= radius) return MIN_SEGMENTS;
  const n = Math.ceil(Math.PI / Math.acos(1 - tolerance / radius));
  const up4 = Math.ceil(n / 4) * 4;
  return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, up4));
}

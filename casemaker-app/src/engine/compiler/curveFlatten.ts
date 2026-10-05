import type { Vec2 } from '@/types';

/**
 * Curve subdivision shared by every place that flattens a quadratic or cubic Bezier to a
 * chord polyline (#217). Extracted verbatim from `glyphs.ts`, which had the only copy: the
 * SVG outline importer needs the SAME subdivision counts so a traced logo flattens the way
 * a glyph does, and "extract rather than duplicate" is the issue's instruction.
 *
 * The error model is the same the glyph rasteriser used: a quadratic's maximum deviation
 * from its chord is |p0 − 2p1 + p2| / 4 and the polyline error shrinks as 1/n²; a cubic's
 * second derivative is bounded by 6·max(|p0 − 2p1 + p2|, |p1 − 2p2 + p3|) and its error is
 * bounded by max|B''| / (8n²). Both round the segment count UP, never below 1.
 *
 * The TOLERANCE is NOT here: it is `GLYPH_CHORD_TOLERANCE_MM` in `glyphs.ts`, kept there
 * because /Fabrication.md and the glyph pipeline name it, and a caller in a different
 * coordinate space divides it by that space's scale before passing it in.
 */

/** Subdivisions needed so a quadratic stays within `tol` of its chord polyline. */
export function quadSegments(p0: Vec2, p1: Vec2, p2: Vec2, tol: number): number {
  const dev = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]) / 4;
  return Math.max(1, Math.ceil(Math.sqrt(dev / tol)));
}

/** Same idea for a cubic: |B''| <= 6 * max(|p0-2p1+p2|, |p1-2p2+p3|), error <= max|B''| / (8 n^2). */
export function cubicSegments(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol: number): number {
  const d1 = Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]);
  const d2 = Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]);
  const dev = (3 / 4) * Math.max(d1, d2);
  return Math.max(1, Math.ceil(Math.sqrt(dev / tol)));
}

/**
 * The points along a quadratic from `p0` to `p2`, EXCLUDING `p0` and INCLUDING `p2`,
 * flattened within `tol` of the true curve. This is the loop `glyphs.ts` used inline.
 */
export function flattenQuadratic(p0: Vec2, p1: Vec2, p2: Vec2, tol: number): Vec2[] {
  const n = quadSegments(p0, p1, p2, tol);
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const a = (1 - t) * (1 - t);
    const b = 2 * (1 - t) * t;
    const d = t * t;
    out.push([a * p0[0] + b * p1[0] + d * p2[0], a * p0[1] + b * p1[1] + d * p2[1]]);
  }
  return out;
}

/** The points along a cubic from `p0` to `p3`, EXCLUDING `p0` and INCLUDING `p3`, within `tol`. */
export function flattenCubic(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tol: number): Vec2[] {
  const n = cubicSegments(p0, p1, p2, p3, tol);
  const out: Vec2[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const d = 3 * u * t * t;
    const e = t * t * t;
    out.push([
      a * p0[0] + b * p1[0] + d * p2[0] + e * p3[0],
      a * p0[1] + b * p1[1] + d * p2[1] + e * p3[1],
    ]);
  }
  return out;
}

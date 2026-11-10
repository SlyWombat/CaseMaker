/**
 * #1087 — THE BALL'S ROW-STEP / CUSP RULE, ONE HOME OUTSIDE `cam/`.
 *
 * The model plan's ball finish and the rotary relief's finish both hold the same cusp promise, so
 * the rule must serve both engines rather than being copied. It lives here, at `engine/cnc/`, and
 * NOT under `engine/cnc/cam/`: the gate's independence rule (`gateImports.spec.ts`, #964/#966 R1)
 * forbids `cam/model/**` from importing anything under `cam/`, and the model finish is one of the
 * two callers. A neutral module keeps one rule without the model reaching into the old-engine CAM.
 *
 * Keep this module free of imports: it is pure arithmetic and both sides of that boundary read it.
 */

/**
 * Ball-at-constant-scallop step-over, corrected for the region's own slope — derived from the
 * sphere-centre geometry, not the flat-span sagitta bound a first attempt scaled by `cos(theta)`
 * and got both the size and the sign wrong (`surface3d.ts`'s old `finishStepOverForCusp`, `#945
 * a1`: measured 8x the stated band on the tray's own 18° slope). A SECOND attempt replaced the
 * formula with a binary search over a densely-scanned "worst cusp between two adjacent rows"
 * measurement — also wrong, not in the formula but in the measurement's own assumption that the
 * row cleaning any given point is always one of its two immediate neighbours; near a row's own
 * axis, the point is actually cleaned by the NEXT row over (advisor's review, after that attempt
 * still measured 2.5x over band at a step-over of 2.25mm against a 3mm ball on 18°): the ball
 * centres riding a slope of angle theta lie on a line parallel to the surface, at normal distance
 * R; two centres `stepOverMm` apart horizontally are `stepOverMm * cos(theta)` apart ALONG that
 * line; the normal-direction cusp between them is the sagitta `R - sqrt(R^2 - (d/2)^2)` for their
 * half-spacing `d = stepOverMm * cos(theta)`, and the VERTICAL cusp (what `bandMm` states) is that
 * normal cusp divided by a cosine again. #1080 (6b's ruling): THE TWO COSINES ARE DIFFERENT
 * ANGLES — the vertical band is converted to the normal cusp by the gradient MAGNITUDE (the
 * surface's own tilt), while the row pitch is converted to pitch along the surface by the
 * CROSS-ROW component (the direction the rows advance). With one angle doing both jobs a wall
 * along the rows read its magnitude and lost the rows it never needed; with the split, the closed
 * form is `stepOver = cos(alpha) * 2 * sqrt(2R*h_n - h_n^2)` at `h_n = band * cos(theta_mag)`.
 * Measured red-first (`finishOp960.spec.ts`) against an ALL-rows cusp scan (not just the
 * bracketing pair) on the tray's own 18° ramp: 1.4254mm step-over for a 3mm-radius ball and a
 * 0.1mm band, cusp 0.1000mm — confirmed, not assumed.
 *
 * #1087 — THE RELIEF PASSES ZERO SLOPES: its rows step around the stock and the surface between
 * two adjacent rows of a turned part is flat in that direction, so the flat sagitta is the
 * promise there.
 */
export function ballScallopStepOver(radiusMm: number, bandMm: number, crossDeg: number, magDeg: number): number {
  if (!(radiusMm > 0) || !(bandMm > 0) || bandMm >= radiusMm) return Math.max(radiusMm, 0.1);
  // #1080 (6b's ruling) — THE TWO COSINES DO DIFFERENT JOBS. The band is a VERTICAL cusp: on a
  // surface at the gradient magnitude theta, a vertical band of `bandMm` is only `bandMm*cos(theta)`
  // along the normal. The cross-row angle alpha then converts the row pitch into pitch along the
  // surface (a row advances horizontally by `pitch`). One angle cannot do both. 6b's naming, which
  // the unit governs: a plane tilted ALONG the rows (its slope along y, alpha ~ 0) moves 1.54 ->
  // 1.09; a plane tilted ACROSS the rows (alpha = theta_mag) is unchanged from the first slice.
  const cosCross = Math.cos((crossDeg * Math.PI) / 180);
  const bandPrime = bandMm * Math.cos((magDeg * Math.PI) / 180);
  const spacing = cosCross * 2 * Math.sqrt(Math.max(0, 2 * radiusMm * bandPrime - bandPrime * bandPrime));
  // THE PROPERTY SEEDS FOUND THIS: as the steepest slope approaches vertical the closed form
  // collapses to ZERO — and `finish()`'s raster advances `x += stepOverMm`, so the op never
  // returns. A vertical face is not finished by spending raster rows on it at all (the wall is the
  // rough's and the contour's cut, and the band the ball promises is undefined there), so the
  // spacing is floored at a tenth of the ball's own radius: fine enough that every slope the
  // formula is defined on still meets its cusp, coarse enough that the raster is bounded. The
  // 90° wall in the sloped seed is what exposed it.
  return Math.max(spacing, radiusMm / 10);
}

/**
 * #1087 — THE CUSP A BALL'S ROW STEP LEAVES ON A FLAT, mm: `R − √(R² − (s/2)²)`, the flat-slope
 * inverse of {@link ballScallopStepOver}. It is what the run sheet states beside the scallop the
 * job asks for, so the promise and the number the program actually leaves are read from one rule.
 */
export function ballScallopCusp(radiusMm: number, stepOverMm: number): number {
  if (!(radiusMm > 0) || !(stepOverMm > 0)) return 0;
  const half = Math.min(stepOverMm, 2 * radiusMm) / 2;
  return radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - half * half));
}

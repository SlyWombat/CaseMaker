import type { HingeFeature, Latch } from '@/types';

/** Compile-time auto-scaling for latch + hinge dimensions.
 *
 *  The user's stored values are TARGETS. The compiler clamps them based
 *  on (a) what physically fits on the case wall, and (b) what's
 *  practically printable on a typical FDM machine. Resizing the case
 *  smaller than the stored hardware would call for re-scales the
 *  hardware automatically, with hard floors so nothing shrinks below
 *  print-reliable feature sizes.
 */

// ------------------------ printability minimums ----------------------------
//
// Below these sizes, FDM extrusion artifacts (elephant foot, layer slip)
// dominate and the part either fails to print or breaks on first use.
export const MIN_LATCH_WIDTH = 8;        // mm — narrower arms can't engage the striker reliably
export const MIN_LATCH_HEIGHT = 14;      // mm — shorter arms can't reach over the rim+lid
export const MIN_LATCH_THROW = 0.8;      // mm — under this, the cam doesn't latch
export const MIN_KNUCKLE_OD = 5;         // mm — outer diameter; below ≈4 the knuckle splits
export const MIN_PIN_DIAMETER = 2.0;     // mm — below ≈1.6 the pin shears
export const MIN_HINGE_LEN = 25;         // mm — minimum total hinge run

// ------------------------ wall-fit ratios ----------------------------------
//
// Hardware can't take more than this fraction of the available wall.
const MAX_LATCH_WIDTH_FRACTION = 0.4;     // single latch ≤ 40% of wall tangent length
const MAX_LATCH_HEIGHT_FRACTION = 0.7;    // arm height ≤ 70% of case outerZ
const MAX_HINGE_LEN_FRACTION = 0.85;      // hinge run ≤ 85% of wall tangent length

/** Clamp a latch's stored dimensions to fit the case + stay printable.
 *  Also clamps uPosition so the latch (plus its protective ribs) stays
 *  inside the wall — otherwise a small case with a uPosition stored from
 *  a larger-case template would put the latch hardware OUTSIDE the case
 *  envelope and leave it as a loose component. */
export function clampLatch(
  latch: Latch,
  dims: { outerX: number; outerY: number; outerZ: number },
): Latch {
  const tangentMax =
    latch.wall === '+x' || latch.wall === '-x' ? dims.outerY : dims.outerX;
  const fitWidth = Math.min(latch.width, tangentMax * MAX_LATCH_WIDTH_FRACTION);
  const fitHeight = Math.min(latch.height, dims.outerZ * MAX_LATCH_HEIGHT_FRACTION);
  const width = Math.max(MIN_LATCH_WIDTH, fitWidth);
  // uPosition must leave room for the latch half-width + protective rib
  // gap (2 mm) + protective rib width (3 mm) + 1 mm safety margin on each
  // side. Clamp into [minU, maxU].
  const safeMargin = width / 2 + 2 + 3 / 2 + 1;
  const minU = safeMargin;
  const maxU = Math.max(safeMargin, tangentMax - safeMargin);
  return {
    ...latch,
    uPosition: Math.max(minU, Math.min(maxU, latch.uPosition)),
    width,
    height: Math.max(MIN_LATCH_HEIGHT, fitHeight),
    throw:  Math.max(MIN_LATCH_THROW,  latch.throw),
  };
}

/** Clamp a hinge's stored dimensions to fit the case + stay printable. */
export function clampHinge(
  hinge: HingeFeature,
  dims: { outerX: number; outerY: number; outerZ: number },
): HingeFeature {
  const tangentMax =
    hinge.face === '+x' || hinge.face === '-x' ? dims.outerY : dims.outerX;
  const fitLen = Math.min(hinge.hingeLength, tangentMax * MAX_HINGE_LEN_FRACTION);
  // Knuckle OD also scales with available wall — the run holds N knuckles +
  // (N - 1) clearance gaps, so each knuckle gets ≤ hingeLen / N. Cap the
  // user's stored OD at 90% of that per-knuckle slice.
  const numK = Math.max(3, hinge.numKnuckles);
  const perKnuckleSlice = (fitLen - (numK - 1) * hinge.knuckleClearance) / numK;
  const fitOD = Math.min(hinge.knuckleOuterDiameter, perKnuckleSlice * 0.9);
  // Pin must be smaller than the knuckle bore (knuckleOD - 2*wall ≈
  // knuckleOD * 0.6 for a reasonable knuckle wall thickness).
  const fitPin = Math.min(hinge.pinDiameter, fitOD * 0.55);
  return {
    ...hinge,
    hingeLength:           Math.max(MIN_HINGE_LEN,    fitLen),
    knuckleOuterDiameter:  Math.max(MIN_KNUCKLE_OD,   fitOD),
    pinDiameter:           Math.max(MIN_PIN_DIAMETER, fitPin),
  };
}

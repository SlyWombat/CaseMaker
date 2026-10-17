/**
 * The V-carve offset ladder, as pure geometry (#221).
 *
 * A V-carve is one region cut by a cone whose depth follows the region's width. The CAM does not
 * need a medial-axis skeleton to say that: it can walk a LADDER of inward offsets. At depth `d`
 * the cone's flat is `tipRadius + d·tanHalf` from the tip's centre line, so the tip may travel on
 * the region offset inward by exactly that radius without either flank leaving the region. Trace
 * that contour at `Z = -d`, for every depth up to the cap, and the union of the cones fills the
 * region. The identity used by the oracle is the same one:
 *
 *     a point at distance ρ from the boundary is cut to (ρ − tipRadius) / tanHalf,
 *     clamped at the cap.
 *
 * THE CAP is the item's stated depth, bounded by the blank's own floor (`thickness − minFloor`).
 * The cap is where the floor goes flat; depth-follows-width applies below it, never past it.
 *
 * THE CORE is what the deepest contour cannot reach. At the cap the tip's flat covers a band of
 * `tipRadius` inside the cap contour, so the untouched region is the inward offset by
 * `capWallRadius + tipRadius` (`coreOffsetRadius`). Program 1's 2 mm pass clears it where it
 * reaches; the V's own flat tip clears the rest at the cap, in parallel passes stepped by
 * `tipClearStepover`. This module owns the numbers; the Clipper offsets and the moves are the
 * CAM's (slice 2).
 *
 * NO FLAT: every function here takes a `VCone`. There is no flat-radius fallback, and the core
 * clearing uses the tool's real tip flat, not a cone treated as a flat end mill.
 */

import { flankHeightAboveTip, type VCone } from './vProfile';

/** One rung: the contour offset `radius`, traced at `depth` below the tip plane. */
export interface VCarveLevel {
  /** Positive depth below the tip plane, mm. The last level is exactly the cap. */
  depth: number;
  /** The inward offset of the region at this depth, mm: `tipRadius + depth·tanHalf`. */
  radius: number;
}

/**
 * The shipped core-clearing stepover, as a FRACTION of the tip's flat diameter: 0.6 × 0.3 mm =
 * 0.18 mm on the 30° × 0.3 bit. It is a seed for the shop setting `vcarve.coreStepoverRatio`
 * (the setting itself is slice 2's), kept here so the CAM and its tests cannot disagree.
 */
export const DEFAULT_CORE_STEPOVER_RATIO = 0.6;

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}`);
  }
}

function nonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number, got ${value}`);
  }
}

/**
 * The ladder for one region: depths `pitch, 2·pitch, …` up to `cap`, with the cap itself always
 * the last rung. A cap below one pitch is a single rung at the cap.
 *
 * The depth pitch is the CAM's; the RADIAL step between rungs is `pitch·tanHalf`
 * ({@link vCarveRadialStep}), which is the number the scallop and the oracle's band care about.
 */
export function vCarveLevels(cone: VCone, cap: number, pitch: number): VCarveLevel[] {
  positive('cap', cap);
  positive('pitch', pitch);

  // `ceil(cap / pitch)` with a small tolerance: 0.4 / 0.1 is 4 in exact arithmetic but can land a
  // hair above it in binary, and a spurious extra rung would trace the cap contour twice.
  const count = Math.max(1, Math.ceil(cap / pitch - 1e-9));
  const levels: VCarveLevel[] = [];
  for (let k = 1; k <= count; k++) {
    const depth = Math.min(k * pitch, cap);
    const previous = levels[levels.length - 1];
    if (previous !== undefined && depth - previous.depth <= 1e-9) continue;
    levels.push({ depth, radius: cone.tipRadius + depth * cone.tanHalf });
  }
  return levels;
}

/**
 * The cap for one item: its STATED depth, lowered only by the blank's hard floor. `null` when
 * either the item states no depth or the blank has no room left under `minFloor`.
 *
 * This is deliberately not a film-plus-margin calculation. The two-colour reveal is a consequence
 * of the item's depth, not a reason to choose a different one; `minFloor` is the job's own
 * material that must remain (1.0 mm by default, `depthBounds.ts`).
 */
export function vCarveCap(itemDepth: number, thickness: number, minFloor: number): number | null {
  const ceiling = thickness - minFloor;
  if (!Number.isFinite(itemDepth) || itemDepth <= 0) return null;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
  return Math.min(itemDepth, ceiling);
}

/** The inward offset of the V's wall at the cap: the contour the deepest rung traces, mm. */
export function capWallRadius(cone: VCone, cap: number): number {
  nonNegative('cap', cap);
  return cone.tipRadius + cap * cone.tanHalf;
}

/**
 * The inward offset of the region the deepest rung's own tip cannot reach, mm. The first cutter
 * (or the tip's clearing passes) must clear `offset(region, -coreOffsetRadius)` at the cap.
 */
export function coreOffsetRadius(cone: VCone, cap: number): number {
  return capWallRadius(cone, cap) + cone.tipRadius;
}

/** The radial distance between adjacent rungs, mm: `pitch·tanHalf`. */
export function vCarveRadialStep(cone: VCone, pitch: number): number {
  positive('pitch', pitch);
  return pitch * cone.tanHalf;
}

/**
 * The depth a point at radial distance `rho` from the region's boundary is cut to, clamped at the
 * cap. This is the ladder's analytic model; the oracle compares the simulated floor against it.
 */
export function cutDepthAtDistance(cone: VCone, rho: number, cap: number): number {
  nonNegative('cap', cap);
  return Math.min(flankHeightAboveTip(cone, rho), cap);
}

/**
 * The parallel-pass stepover for clearing a cap core with the V's own flat tip, mm:
 * `tip flat diameter × ratio`. `null` for a sharp point, which has no flat to clear with — the
 * CAM must then leave the core to the first cutter or refuse.
 */
export function tipClearStepover(cone: VCone, ratio: number = DEFAULT_CORE_STEPOVER_RATIO): number | null {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new RangeError(`stepover ratio must be in (0, 1], got ${ratio}`);
  }
  if (!(cone.tipRadius > 0)) return null;
  return cone.tipRadius * 2 * ratio;
}

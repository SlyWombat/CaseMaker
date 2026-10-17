/**
 * V-carve arithmetic, as pure geometry (#221).
 *
 * THE SHIPPED MODEL is a constant-depth pocket cut by the V-bit alone, with the DESIGN CORRECT AT
 * THE COLOUR PLANE. With film thickness `f` (the blank's colour boundary, `colourBoundaryDepthFor`)
 * and item depth `D` below the top face, the cutter tip goes to `D` and the colour plane sits
 * `e = D − f` above it. The groove's half-width at that plane is
 *
 *     rPlane = tipRadius + e·tanHalf
 *
 * and the toolpath is the design offset INWARD by `rPlane`, cleared at depth `D`. The cone then
 * gives the two other outlines for free: the FLOOR (depth `D`) is `e·tanHalf` narrower per side
 * than the design, and the SURFACE opening is `f·tanHalf` wider per side. Floor to surface is the
 * full `D·tanHalf`, which is the look the maintainer accepted.
 *
 * `D` is the item's stated depth, bounded by the blank's own floor (`thickness − minFloor`) by the
 * depth checks every item already goes through. A blank with NO FILM has the plane at the floor
 * (`f = 0`, `rPlane = tipRadius`): a pointed bit draws a line `2·D·tanHalf` wide at the surface and
 * nothing at the bottom, which the run sheet says in words.
 *
 * THE STEPOVER is `ratio × 2·rPlane` — of the groove's width AT THE PLANE, never of the tip flat
 * ({@link vCarvePlaneStepover}, seed {@link DEFAULT_V_CARVE_STEPOVER_RATIO}).
 *
 * THE OFFSET LADDER is a LATER OPTION, kept here as pure arithmetic and not built on by the CAM.
 * It sits on the same cone identity used by the oracle:
 *
 *     a point at distance ρ from the boundary is cut to (ρ − tipRadius) / tanHalf,
 *     clamped at the cap.
 *
 * NO FLAT: every function here takes a `VCone`. There is no flat-radius fallback, and the plane
 * stepover uses the plane groove's real width, not a cone treated as a flat end mill.
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
 * The shipped V-carve stepover, as a FRACTION of the groove's width at the colour plane
 * (`2·rPlane`): 0.6. On the thin blank that is 0.6 × 0.40396 = 0.242 mm; on the badge
 * 0.6 × 0.39378 = 0.236 mm. It is the seed for the shop setting `vcarve.stepoverRatio` (the
 * setting itself is a later slice), kept here so the feeds rows and the CAM cannot disagree.
 */
export const DEFAULT_V_CARVE_STEPOVER_RATIO = 0.6;

/** The machine's minimum X/Y step must be beaten by this many groove widths (#221). */
export const V_CARVE_STEP_MARGIN = 2;

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
 * This is the ladder's cap and is not the shipped model's depth: the shipped colour-plane model
 * takes the item's depth `D` directly, and the every-item depth checks already hold it under
 * `thickness − minFloor` (1.0 mm by default, `depthBounds.ts`).
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
 * The three outlines one V-carve region has, and the numbers that place them (#221).
 *
 * All lengths are mm. `planeRadius` is the number the toolpath actually offsets the design by;
 * the floor and the surface are consequences of the cone, not separate offsets the CAM applies.
 */
export interface VCarvePlane {
  /** The item's depth below the top face, mm. The tip plane. */
  depth: number;
  /** The colour boundary's depth below the top face, mm; 0 when the blank states no film. */
  film: number;
  /** `depth − film`, floored at 0: how far the floor is below the colour plane, mm. */
  belowPlane: number;
  /** Half-width of the groove AT THE COLOUR PLANE: `tipRadius + belowPlane·tanHalf`, mm. */
  planeRadius: number;
  /** Full groove width at the colour plane, `2·planeRadius`, mm. */
  grooveWidth: number;
  /** How much narrower the floor is than the design, per side, mm (`belowPlane·tanHalf`). */
  floorInset: number;
  /** How much wider the surface opening is than the design, per side, mm. */
  surfaceOutset: number;
  /** Floor-to-surface widening per side, mm — the whole cone's `depth·tanHalf` span. */
  wallOffset: number;
}

/**
 * The colour-plane geometry for one item. `film` is the colour boundary's depth below the top
 * face (0/null for a blank with no print): the plane then IS the floor and `rPlane` is the tip
 * radius, which is the "a pointed bit draws a line" case the run sheet describes.
 *
 * A cut SHALLOWER than the film has no colour plane at all; it is modelled with the plane at the
 * floor (`belowPlane = 0`) so the arithmetic stays finite. The depth bounds that stop such a cut
 * hiding the second colour belong to the item's own depth intent (`item-depth-bound`), not here.
 */
export function vCarvePlane(cone: VCone, depth: number, film: number | null): VCarvePlane {
  positive('depth', depth);
  const f = film === null || !Number.isFinite(film) || film <= 0 ? 0 : film;
  // The plane is the colour boundary when the cut reaches it. With no film it is the floor; with a
  // film the cut does not reach, there is no plane below the floor either, so the floor stands in.
  const belowPlane = f > 0 ? Math.max(0, depth - f) : 0;
  const planeRadius = cone.tipRadius + belowPlane * cone.tanHalf;
  return {
    depth,
    film: f,
    belowPlane,
    planeRadius,
    grooveWidth: planeRadius * 2,
    floorInset: belowPlane * cone.tanHalf,
    // From the plane to the top face. No film puts the plane at the floor, so the cone's whole
    // depth widens the surface; a film wider than the cut stops at the cut's own depth.
    surfaceOutset: (f > 0 ? Math.min(depth, f) : depth) * cone.tanHalf,
    wallOffset: depth * cone.tanHalf,
  };
}

/**
 * The parallel-pass stepover for a V-carve at this plane, mm: `ratio × grooveWidth`. The groove
 * width is measured AT THE COLOUR PLANE — not the tip flat — because that is the width whose
 * adjacent passes must meet for the second colour's area to be the design.
 */
export function vCarvePlaneStepover(
  plane: VCarvePlane,
  ratio: number = DEFAULT_V_CARVE_STEPOVER_RATIO,
): number {
  checkStepoverRatio(ratio);
  return plane.grooveWidth * ratio;
}

function checkStepoverRatio(ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new RangeError(`stepover ratio must be in (0, 1], got ${ratio}`);
  }
}

/**
 * The two numbers a V-carve pass spacing has: what the feeds row ASKED for at the colour plane,
 * and what the floor allows the CAM to run (#221).
 *
 * `requested` is `ratio × 2·planeRadius` — {@link vCarvePlaneStepover}; `effective` is that
 * request clamped to the cone's `tipRadius`, which is {@link vCarvePassPitch}. They are returned
 * together, from one function, so the panel, the run sheet and the CAM can never print different
 * pitches: `clamped` is true exactly when the floor, not the seed, set the number.
 */
export interface VCarveStepover {
  /** The plane step-over the feeds row asks for, mm — `ratio × grooveWidth`. */
  requested: number;
  /** The pass pitch the CAM runs, mm — `requested` clamped to the tip radius. */
  effective: number;
  /** True when the clamp, not the request, set `effective`. */
  clamped: boolean;
}

/**
 * The pass spacing the FLOOR allows: the plane's step-over, clamped to the TIP RADIUS (#221).
 *
 * `vCarvePlaneStepover` is the engagement the feeds row asks for at the colour plane, but the
 * floor at depth `D` is cleared by the TIP disc alone. Along a wall, two passes a pitch `p`
 * apart leave the material between them (up to `p/2` from either centre) to whichever disc
 * reaches furthest — the tip disc, whose reach is `tipRadius`, not the plane's `rPlane`. And a
 * stroke's CENTRELINE is worse: the level sets `rPlane + k·pitch` stop existing where the stroke
 * is narrower than `2·(rPlane + k·pitch)`, so the deepest point of the stroke can be up to a
 * whole pitch from the last pass that exists. A pitch above `tipRadius` therefore leaves a ridge
 * of the top colour across every stroke narrower than `2·(rPlane + pitch)` — material the floor
 * prediction says was removed, which the oracle reads as an under-cut. So the flat rule #191
 * applies to the tip unchanged; the tip WIDTH is only the limit between two passes that both
 * exist, and the centreline is where it fails.
 *
 * This CLAMPS rather than refuses. A wider request only looks faster; a smaller pitch never
 * leaves material behind, and the feeds validation already refuses an operator OVERRIDE past the
 * tip width — a different question, about what was asked for rather than what the floor allows.
 */
export function vCarveStepover(
  planeRadius: number,
  cone: VCone,
  ratio: number = DEFAULT_V_CARVE_STEPOVER_RATIO,
): VCarveStepover {
  positive('planeRadius', planeRadius);
  positive('tipRadius', cone.tipRadius);
  checkStepoverRatio(ratio);
  const requested = 2 * planeRadius * ratio;
  const effective = Math.min(requested, cone.tipRadius);
  return { requested, effective, clamped: effective < requested - 1e-12 };
}

/** The CAM's pass pitch: {@link vCarveStepover}'s `effective`, mm. */
export function vCarvePassPitch(
  planeRadius: number,
  cone: VCone,
  ratio: number = DEFAULT_V_CARVE_STEPOVER_RATIO,
): number {
  return vCarveStepover(planeRadius, cone, ratio).effective;
}

/**
 * The clamp in the words the `vcarve-stepover-clamped` finding uses. One function so the panel,
 * the run sheet and the finding cannot paraphrase the same fact differently, and so the panel does
 * not have to re-derive a sentence the CAM already states. `name` is the item's display name.
 *
 * Only meaningful when {@link VCarveStepover.clamped} is true; the caller decides whether to show
 * it. No severity is implied here — the finding's severity is the caller's, and it is a NOTE.
 */
export function vCarveStepoverClampNote(name: string, stepover: VCarveStepover, tipRadius: number): string {
  const mm = (v: number): string => String(Math.round(v * 1000) / 1000);
  return (
    `${name}: pitch ${mm(stepover.effective)} mm, clamped to the cutter's ${mm(tipRadius)} mm tip ` +
    `radius from the requested ${mm(stepover.requested)} mm — a wider pitch would leave a ridge of ` +
    'the top colour down strokes narrower than two passes apart.'
  );
}

/**
 * Why a plane's groove is too narrow to machine, or null when it is fine (#221).
 *
 * The controller moves in whole X/Y steps, so a groove narrower than a few of them cannot be
 * resolved into the two walls the design asks for — the maintainer's "it has to be at least
 * larger than the minimum x or y step". `machineStepMm` is that step, read from the MACHINE
 * RECORD's steps-per-mm (`MillProfile.axisSteps`), never a shop tunable. The refusal is by name and
 * says which way out: go deeper (widening the groove at the plane) or widen the stroke.
 */
export function vCarveGrooveRefusal(
  plane: VCarvePlane,
  machineStepMm: number,
  margin: number = V_CARVE_STEP_MARGIN,
): string | null {
  if (!(machineStepMm > 0) || !Number.isFinite(machineStepMm)) {
    throw new RangeError(`machineStepMm must be > 0 and finite, got ${machineStepMm}`);
  }
  const minimum = machineStepMm * margin;
  if (plane.grooveWidth >= minimum) return null;
  const microns = (v: number): string => {
    const rounded = Math.round(v * 1e6) / 1e3;
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  };
  return (
    `the groove at the colour plane would be ${microns(plane.grooveWidth)} µm, under the ` +
    `machine's ${microns(minimum)} µm step: go deeper or widen the stroke`
  );
}

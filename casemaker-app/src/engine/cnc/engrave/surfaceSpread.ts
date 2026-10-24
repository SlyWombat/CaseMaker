/**
 * #475 — Z0 on a bowed blank is a SPREAD, not a point.
 *
 * The maintainer's observation of 2026-10-17 settled what the blank is: on a printed two-colour
 * badge the colour line is a PLANE and the dome is extra top material on a flat back (see the
 * bench record and the issue's second comment). A single touch at the cut's centre therefore says
 * nothing about the floor at the cut's ends, and a floor placed from that one touch can sit above
 * the colour line at one end of a line and through the pocket's ceiling at the other.
 *
 * The rule here:
 *
 *   1. plan `surfaceTouchCount` touches at the CUT REGIONS' EXTENTS (the union box of every
 *      engrave, trace, drill and thread), after the registration-point touch;
 *   2. work out the depth band each region leaves from the SAME planes the depth checker uses:
 *      the colour split plus the boundary margin below, and the void (pocket) limit or the
 *      blank's underside above (`depthBounds`/`partPlan`, never a second arithmetic);
 *   3. measure: min, max and spread, each carrying the reading's provenance;
 *   4. fit a plane to the touches (#608): a top that TILTS fits the plane (small residual) and is
 *      FOLLOWED — Z0 stays the LOWEST touch ({@link Z0_REFERENCE}) and the program is posted against
 *      the fitted surface per XY. Only a bow the tilt cannot explain — the RESIDUAL wider than the
 *      band — refuses with `blank-bowed`.
 *
 * WHY THE LOWEST TOUCH. The programmed floor depth `D` is measured from Z0. At a touch whose top
 * is `z` above the lowest one, the local floor is `D + z` deep. Referencing Z0 to the lowest touch
 * means the SHALLOWEST floor is `D` (at the low point) and the deepest is `D + spread` (at the
 * high point). The band then has a single, checkable answer: `D` must be at least the colour
 * line + margin, and `D + spread` at most the pocket limit. Referencing the ridge (or the mean)
 * would hide the low side's floor, which is exactly where the colour line is nearest on a
 * flat-back dome.
 *
 * The next badge cut is the experiment that confirms or overturns this. Overturning it is the one
 * line below: `Z0_REFERENCE`.
 *
 * Pure: a job and readings in, numbers out. No store, no machine, no wasm — the run sheet and the
 * panel can both carry the same plan.
 */

import { aabbOfProfile } from '@/engine/compiler/profile';
import { ceilingName, splitDepthOf, type DepthBoundSource } from '@/engine/cnc/engrave/depthBounds';
import { fitSurfacePlane, isFlatPlane, type SurfacePlane, type SurfacePlaneFit } from '@/engine/cnc/engrave/surfacePlane';
import {
  toPartPlan,
  voidLimitForFootprint,
  type ItemFootprint,
} from '@/engine/cnc/engrave/partPlan';
import type { JobFinding } from '@/engine/cnc/engrave/jobSetup';
import type { EngraveJob } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/**
 * #475 — where Z0 is referenced among the measured touches.
 *
 * LOWEST is the rule, with its reason in this module's header. `highest` and `midpoint` exist so
 * that the experiment's result can be applied by changing {@link Z0_REFERENCE} alone; nothing
 * else in the app branches on this value.
 */
export type SurfaceReference = 'lowest' | 'highest' | 'midpoint';

/** The one-line rule. Change this to overturn #475's reference, and nothing else. */
export const Z0_REFERENCE: SurfaceReference = 'lowest';

/** The labelled no-service fallback for `registration.surfaceTouchCount` (#475). */
export const DEFAULT_SURFACE_TOUCH_COUNT = 5;

/** Where a touch reading came from — decision 28's provenance rule, applied to a reading. */
export type SurfaceReadingSource =
  /** A `G38.2`/touch-off on the wired probe, recorded by the operator or the executor. */
  | 'probe'
  /** The cutter was touched off on the top by hand. */
  | 'touch-off'
  /** Typed in from a dial or another instrument, not taken by the machine. */
  | 'stated';

/** One planned touch, in the stock frame (front-left at the origin). */
export interface SurfaceTouchPoint {
  id: string;
  x: Mm;
  y: Mm;
  /** The point in physical words, for the sheet. */
  at: string;
}

/** One reading, in the order the plan prints the touches. */
export interface SurfaceReading {
  z: Mm;
  source: SurfaceReadingSource;
}

/** A measured touch: the plan's point plus its reading and provenance. */
export interface SurfaceTouchReading extends SurfaceTouchPoint {
  z: Mm;
  source: SurfaceReadingSource;
}

/** One plane a region's floor must stay clear of, and the floor limit it implies. */
export interface BandPlane {
  /** The floor limit, mm below the face: `at − margin` for an upper plane, `at + margin` below. */
  depth: Mm;
  /** The plane in words: "the colour split", "the magnet pocket's ceiling". */
  name: string;
  source: DepthBoundSource;
  /** The margin this plane keeps, mm. */
  margin: Mm;
}

/** The depth band one cut region leaves, from the planes under it. */
export interface RegionBand {
  id: string;
  name: string;
  /** The region's cut extent in the stock frame. */
  extent: { minX: Mm; minY: Mm; maxX: Mm; maxY: Mm };
  /** The shallowest floor the region may have, or null when the blank has no colour line. */
  lower: BandPlane | null;
  /** The deepest floor the region may have. */
  upper: BandPlane;
  /** `upper − lower` (0 when the planes leave no room), mm. */
  width: Mm;
}

/** The whole job's band: the intersection of every region's, so the tightest region wins. */
export interface DepthBand {
  lower: BandPlane | null;
  upper: BandPlane;
  /** `upper − lower` (0 when the planes leave no room), mm. */
  width: Mm;
}

/** The planned touches and the band, before any reading is taken. */
export interface SurfaceSpreadPlan {
  touches: SurfaceTouchPoint[];
  regions: RegionBand[];
  band: DepthBand;
}

/** One end of the measured spread, with the reading it came from. */
export interface SurfaceExtremum {
  z: Mm;
  touchId: string;
  x: Mm;
  y: Mm;
  at: string;
  source: SurfaceReadingSource;
}

/** The refusal's finding, exactly the shape the job's other errors take. */
export interface BlankBowedFinding extends JobFinding {
  severity: 'error';
  code: 'blank-bowed';
}

/** The measured spread and what it permits. */
export interface SurfaceSpreadAssessment {
  plan: SurfaceSpreadPlan;
  touches: SurfaceTouchReading[];
  min: SurfaceExtremum;
  max: SurfaceExtremum;
  /** `max − min`, mm. */
  spread: Mm;
  /**
   * The centre-to-edge drop on each stock axis (#496): `xMm` along the stock's `length` (X),
   * `yMm` across its `width` (Y). These are the pair the registration writes into the job's
   * `stock.flatness` — computed from the readings rather than guessed from the stock's aspect, and
   * per axis because the direction words this module used to expose were read in opposite senses
   * by different consumers (#496).
   */
  drops: { xMm: Mm; yMm: Mm };
  /** The Z0 the job is cut from, and the touch it came from (null for a midpoint). */
  z0: { z: Mm; touchId: string | null; rule: SurfaceReference };
  /**
   * #608 — the least-squares plane the touches fit, and how far they still miss it (`residual`).
   * The verdict is the RESIDUAL against the band, not the raw spread: a tilted top fits a plane and
   * is followed; only a top whose bow outlasts the plane — residual wider than the band — refuses.
   * Null when fewer than three touches were taken (a plane needs three).
   */
  fit: SurfacePlaneFit | null;
  /**
   * #608 — the fitted top's drop across the measured extents on each stock axis, mm, positive toward
   * +X / +Y. These are the words the run sheet prints ("surface tilted … toward +X/+Y, followed").
   */
  tilt: { xMm: Mm; yMm: Mm };
  /**
   * The range of programmed floor depths, below Z0, that keeps EVERY region inside its band once
   * the spread is applied — `[lower, upper − spread]`. Null when no depth can: the refusal case.
   * #608 — when a plane is fitted, the spread that matters is the RESIDUAL (the tilt is followed),
   * so the range reads `[lower, upper − residual]`.
   */
  landing: { lower: Mm; upper: Mm } | null;
  ok: boolean;
  /** The `blank-bowed` refusal, or null when the spread fits. */
  refusal: BlankBowedFinding | null;
}

const r3 = (n: number): Mm => Math.round(n * 1000) / 1000;

/**
 * #608 — the fitted plane's coefficients travel on the registration record and are re-posted from
 * forever, so they are carried at micrometer resolution: a slope rounded to 0.001 mm/mm is a
 * 0.015 mm lift error 30 mm out, and the record keeps whatever rounding it was given. The verdict's
 * residual is a READ-OUT (r3); the coefficients are inputs to a later post.
 */
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** A number as the sheet prints it: three decimals at most, no trailing zeros. */
const num = (n: number): string => String(r3(n));

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The box that contains every cut region the job will make — the union of the engraves' profile
 * boxes, the traces' paths, the drills' holes and the threads' axes. Null when there is no cut.
 */
function cutExtents(job: EngraveJob): {
  minX: Mm;
  minY: Mm;
  maxX: Mm;
  maxY: Mm;
  regions: { id: string; name: string; extent: { minX: Mm; minY: Mm; maxX: Mm; maxY: Mm } }[];
} | null {
  const plan = toPartPlan(job);
  const regions: { id: string; name: string; extent: { minX: Mm; minY: Mm; maxX: Mm; maxY: Mm } }[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (id: string, name: string, xs: readonly number[], ys: readonly number[]): void => {
    if (xs.length === 0 || ys.length === 0) return;
    const extent = {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    };
    regions.push({ id, name, extent });
    minX = Math.min(minX, extent.minX);
    minY = Math.min(minY, extent.minY);
    maxX = Math.max(maxX, extent.maxX);
    maxY = Math.max(maxY, extent.maxY);
  };

  for (const item of plan.engraves) {
    const box = aabbOfProfile(item.profile);
    if (box === null) continue;
    add(item.id, item.name, [box.min[0], box.max[0]], [box.min[1], box.max[1]]);
  }
  for (const trace of plan.traces) {
    const points = trace.paths.flat();
    add(
      trace.id,
      trace.name,
      points.map((p) => p[0]),
      points.map((p) => p[1]),
    );
  }
  for (const drill of plan.drills) {
    add(
      drill.id,
      drill.name,
      drill.holes.map((p) => p[0]),
      drill.holes.map((p) => p[1]),
    );
  }
  for (const thread of plan.threads) {
    add(thread.id, thread.name, [thread.position[0]], [thread.position[1]]);
  }

  if (regions.length === 0) return null;
  return { minX, minY, maxX, maxY, regions };
}

/**
 * The planned touches: the cut area's centre first, then its four extents, then its corners, as
 * many as the shop default asks for (5–9). That order is the 3×3 grid of the cut's bounding box,
 * so the seed's five are the centre and both extents on each axis — the smallest set that can see
 * a bow in either direction.
 *
 * Points are pulled inside the stock by 1 mm: a cut region may sit at the edge margin, and a
 * touch exactly on the roll-off would read low and be taken for a miss.
 */
function touchPoints(
  extents: { minX: Mm; minY: Mm; maxX: Mm; maxY: Mm },
  stock: { length: Mm; width: Mm },
  count: number,
): SurfaceTouchPoint[] {
  const cx = (extents.minX + extents.maxX) / 2;
  const cy = (extents.minY + extents.maxY) / 2;
  const xLo = clamp(extents.minX, 1, stock.length - 1);
  const xHi = clamp(extents.maxX, 1, stock.length - 1);
  const yLo = clamp(extents.minY, 1, stock.width - 1);
  const yHi = clamp(extents.maxY, 1, stock.width - 1);
  const xMid = clamp(cx, 1, stock.length - 1);
  const yMid = clamp(cy, 1, stock.width - 1);
  const all = [
    { x: xMid, y: yMid, at: "the cut area's centre" },
    { x: xLo, y: yMid, at: "the cut area's left extent" },
    { x: xHi, y: yMid, at: "the cut area's right extent" },
    { x: xMid, y: yLo, at: "the cut area's front extent" },
    { x: xMid, y: yHi, at: "the cut area's back extent" },
    { x: xLo, y: yLo, at: "the cut area's front-left corner" },
    { x: xHi, y: yHi, at: "the cut area's back-right corner" },
    { x: xHi, y: yLo, at: "the cut area's front-right corner" },
    { x: xLo, y: yHi, at: "the cut area's back-left corner" },
  ];
  return all.slice(0, Math.max(1, count)).map((p, i) => ({ id: `surface-${i + 1}`, ...p }));
}

/** The footprint of one region's extent, for the void overlap test. */
function footprintOf(extent: { minX: Mm; minY: Mm; maxX: Mm; maxY: Mm }): ItemFootprint {
  return {
    x: (extent.minX + extent.maxX) / 2,
    y: (extent.minY + extent.maxY) / 2,
    halfWidth: (extent.maxX - extent.minX) / 2,
    halfHeight: (extent.maxY - extent.minY) / 2,
    rotation: 0,
  };
}

/**
 * The depth band the job's cuts leave, per region then intersected.
 *
 * The planes are the checker's own: `splitDepthOf` is the colour line on the printer's layer grid,
 * and `voidLimitForFootprint` is `keepOutLimit`'s answer for the region's extent — the same
 * `voidMargin`, the same layer-aligned ceiling, the same stock-floor minimum. There is no second
 * arithmetic here on purpose; a band that disagreed with the checker would refuse blanks the job
 * itself would happily cut, or pass one it refuses.
 */
export function surfaceSpreadPlan(
  job: EngraveJob,
  options: { touchCount?: number; margin?: Mm } = {},
): SurfaceSpreadPlan | null {
  const extents = cutExtents(job);
  if (extents === null) return null;

  const margin = options.margin ?? job.margins?.boundaryMargin ?? 0.2;
  const count = Math.max(1, Math.floor(options.touchCount ?? DEFAULT_SURFACE_TOUCH_COUNT));
  const split = splitDepthOf(job);
  const lower: BandPlane | null =
    split === null
      ? null
      : { depth: r3(split + margin), name: 'the colour split', source: 'split', margin };
  const stockFloor = r3(job.stock.thickness - job.minFloor);

  const regions: RegionBand[] = extents.regions.map((region) => {
    const voidLimit = voidLimitForFootprint(job, footprintOf(region.extent), margin);
    let upper: BandPlane;
    if (voidLimit === null || stockFloor < voidLimit.limit - 1e-9) {
      upper = { depth: stockFloor, name: "the blank's underside", source: 'underside', margin: job.minFloor };
    } else {
      upper = { depth: r3(voidLimit.limit), name: ceilingName(voidLimit.name), source: 'void', margin };
    }
    return {
      ...region,
      lower,
      upper,
      width: Math.max(0, r3(upper.depth - (lower?.depth ?? 0))),
    };
  });

  // The tightest region wins: the highest lower plane and the lowest upper plane, so a floor that
  // satisfies the band satisfies every region rather than an average of them.
  const lowerDepth = regions.reduce((m, r) => Math.max(m, r.lower?.depth ?? 0), 0);
  const upperDepth = regions.reduce((m, r) => Math.min(m, r.upper.depth), Infinity);
  const bandLower =
    lower === null ? null : regions.find((r) => r.lower?.depth === lowerDepth)?.lower ?? lower;
  const bandUpper = regions.find((r) => r.upper.depth === upperDepth)!.upper;
  const band: DepthBand = {
    lower: bandLower,
    upper: bandUpper,
    width: Math.max(0, r3(upperDepth - lowerDepth)),
  };

  return {
    touches: touchPoints(extents, { length: job.stock.length, width: job.stock.width }, count),
    regions,
    band,
  };
}

/**
 * Z0 among the measured touches, by the one rule above. `lowest` and `highest` name the touch
 * they read; `midpoint` is the mean of all readings and names none.
 */
function z0Of(touches: readonly SurfaceTouchReading[]): SurfaceSpreadAssessment['z0'] {
  if (Z0_REFERENCE === 'midpoint') {
    const mean = touches.reduce((sum, t) => sum + t.z, 0) / touches.length;
    return { z: r3(mean), touchId: null, rule: Z0_REFERENCE };
  }
  const wanted = Z0_REFERENCE === 'lowest' ? Math.min(...touches.map((t) => t.z)) : Math.max(...touches.map((t) => t.z));
  const touch = touches.find((t) => t.z === wanted)!;
  return { z: r3(touch.z), touchId: touch.id, rule: Z0_REFERENCE };
}

/**
 * The centre-to-edge drop on each stock axis, mm. The first planned touch is the cut area's centre
 * (the plan's own order), so the comparison is against it. A flat top ties at 0 on both axes.
 *
 * Both figures are kept (#496): the badge blank's measured bow is not symmetric (0.33 mm along one
 * span, 0.1 mm along the other), and the material scan's face model needs the pair. The executor
 * writes the pair into `stock.flatness`; the facing default takes the larger of the two, because a
 * skim must clear the high point whichever side of the blank it is on.
 */
function dropsOf(touches: readonly SurfaceTouchReading[]): { xMm: Mm; yMm: Mm } {
  const centre = touches[0];
  if (centre === undefined) return { xMm: 0, yMm: 0 };
  let xMm = 0;
  let yMm = 0;
  for (const t of touches.slice(1)) {
    const dz = Math.abs(t.z - centre.z);
    if (Math.abs(t.x - centre.x) > 1e-9) xMm = Math.max(xMm, dz);
    if (Math.abs(t.y - centre.y) > 1e-9) yMm = Math.max(yMm, dz);
  }
  return { xMm: r3(xMm), yMm: r3(yMm) };
}

/**
 * #608 — the run sheet's "surface tilted … toward +X/+Y, followed" sentence, or null when the fitted
 * plane is flat (both axis drops within rounding of zero). Each axis that actually drops is named
 * with its direction, so a tilt along one axis alone says that and no more.
 */
export function surfaceTiltWords(tilt: { xMm: Mm; yMm: Mm }): string | null {
  const parts: string[] = [];
  if (Math.abs(tilt.xMm) > 1e-9) parts.push(`${num(tilt.xMm)} mm toward ${tilt.xMm > 0 ? '+X' : '-X'}`);
  if (Math.abs(tilt.yMm) > 1e-9) parts.push(`${num(tilt.yMm)} mm toward ${tilt.yMm > 0 ? '+Y' : '-Y'}`);
  return parts.length === 0 ? null : parts.join(' and ');
}

/** The post payload for a registration that measured a TILT: the fitted plane and its reference Z0. */
export interface SurfacePostFit {
  plane: SurfacePlane;
  /** The reference reading the origin was written from — the LOWEST touch. */
  z0: number;
}

/**
 * #608 — what a registration hands the Cut step to re-post against, or null. A top that fits a
 * plane with any tilt returns `{plane, z0}` (the coefficients at r6, the reference Z0); a FLAT top
 * — both slopes zero within rounding — returns null, because posting against it changes nothing and
 * the package must stay byte-identical, not re-freeze.
 */
export function surfaceFitForPost(
  assessment: Pick<SurfaceSpreadAssessment, 'fit' | 'z0' | 'ok'>,
): SurfacePostFit | null {
  if (!assessment.ok || assessment.fit === null) return null;
  if (isFlatPlane(assessment.fit)) return null;
  return { plane: assessment.fit, z0: assessment.z0.z };
}

/**
 * Measure the blank from the planned touches.
 *
 * `readings` are in the plan's order (the sheet prints that order). Every reading carries its own
 * provenance; the min and max carry it too, so a spread built from a typed number cannot read as
 * one the probe took.
 *
 * A spread exactly equal to the band is a PASS: the landing range collapses to one depth, and
 * that depth is a floor the band admits at every touch.
 */
export function assessSurfaceSpread(
  job: EngraveJob,
  readings: readonly SurfaceReading[],
  options: { touchCount?: number; margin?: Mm } = {},
): SurfaceSpreadAssessment {
  const plan = surfaceSpreadPlan(job, options);
  if (plan === null) throw new Error('this job has no cut regions to measure the surface over');
  return assessSurfaceReadings(plan, readings);
}

/**
 * The same verdict from a plan that is already built — the executor's form (#475): it measured the
 * plan's touches over the console and gets min/max/spread, Z0, the landing range and the refusal
 * without needing the job again. `assessSurfaceSpread` is this plus the planning step, so the two
 * cannot disagree about the arithmetic.
 */
export function assessSurfaceReadings(
  plan: SurfaceSpreadPlan,
  readings: readonly SurfaceReading[],
): SurfaceSpreadAssessment {
  if (readings.length !== plan.touches.length) {
    throw new Error(
      `the surface spread needs ${plan.touches.length} readings, one per planned touch; got ${readings.length}`,
    );
  }
  const touches: SurfaceTouchReading[] = plan.touches.map((t, i) => ({
    ...t,
    z: readings[i]!.z,
    source: readings[i]!.source,
  }));

  const minTouch = touches.reduce((a, b) => (b.z < a.z ? b : a));
  const maxTouch = touches.reduce((a, b) => (b.z > a.z ? b : a));
  const min: SurfaceExtremum = {
    z: r3(minTouch.z),
    touchId: minTouch.id,
    x: minTouch.x,
    y: minTouch.y,
    at: minTouch.at,
    source: minTouch.source,
  };
  const max: SurfaceExtremum = {
    z: r3(maxTouch.z),
    touchId: maxTouch.id,
    x: maxTouch.x,
    y: maxTouch.y,
    at: maxTouch.at,
    source: maxTouch.source,
  };
  const spread = r3(max.z - min.z);

  // #608 — fit a plane through the touches. A tilt fits the plane (small residual) and is followed;
  // only the leftover — the bow the tilt cannot explain — is judged against the band. Fewer than
  // three touches cannot fit a plane, and the old spread rule stands for them.
  const fit = fitSurfacePlane(touches);
  const fitAmount = fit?.residual ?? spread;
  const xs = touches.map((t) => t.x);
  const ys = touches.map((t) => t.y);
  const tilt = {
    // The drop toward +X/+Y: −slope × span, because a reading frame's Z falls (more negative) as the
    // surface drops, so a negative slope on an axis IS a drop toward that axis's + end.
    xMm: r3(fit === null ? 0 : -fit.slopeX * (Math.max(...xs) - Math.min(...xs))),
    yMm: r3(fit === null ? 0 : -fit.slopeY * (Math.max(...ys) - Math.min(...ys))),
  };
  const ok = fitAmount <= plan.band.width + 1e-9;
  const landing = ok
    ? { lower: plan.band.lower?.depth ?? 0, upper: r3(plan.band.upper.depth - fitAmount) }
    : null;
  const refusal: BlankBowedFinding | null = ok
    ? null
    : {
        severity: 'error',
        code: 'blank-bowed',
        message:
          `this blank's top is not one plane: the touches miss the fitted plane by ${num(fitAmount)} mm, ` +
          'wider than the band — the floors cannot stay past the colour line and clear of the pocket',
      };

  return {
    plan,
    touches,
    min,
    max,
    spread,
    fit: fit === null ? null : { ...fit, offset: r6(fit.offset), slopeX: r6(fit.slopeX), slopeY: r6(fit.slopeY), residual: r3(fit.residual) },
    tilt,
    drops: dropsOf(touches),
    z0: z0Of(touches),
    landing,
    ok,
    refusal,
  };
}

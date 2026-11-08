/**
 * cam/model/ops/finish.ts — §3.4 of `docs/design/cam-model-engine.md`.
 *
 * Finishing by slope: a flat-following raster where the local slope is under the flat cutter's
 * admissible angle (Studio's method on the tray's scoop), a ball at constant scallop elsewhere —
 * step-over from the ball's own radius and the leftover band, the already-landed fix on
 * `held/945-scallop` (re-derived here without its own pitch-rounding — this engine has no global
 * grid, #966 — not yet moved out of `surface3d.ts` itself). The finish's own cusp on a wall is
 * the step-over's sagitta and does not close by pitch alone (Session C's finding) — carried in
 * the step-over formula here, not patched after.
 *
 * Z-STEPPED, never one pass straight to depth (advisor's review): nothing else cuts the curved
 * remainder before this op runs, so the whole standing leftover is real, uncut material — a
 * single drop-cutter pass would put the cutter into all of it at once, a tool-load problem, not
 * only a slower one. Steps down from the region's own top in `stepDownMm` increments, each level
 * cutting `max(trueCL, levelZ)` — never deeper than the level's own target, whatever the true
 * surface asks for — so only the LAST level (the region's own floor) reaches the true CL exactly.
 *
 * LINKING between rows (and between levels) goes through #962's `link()` (the review's item 6):
 * the same material-aware stay-down-or-retract call every other op uses, against a field honest
 * about only the level just FINISHED — a row's own first feed is still a plunge when `link()`
 * itself has to retract (its vertical legs are at `plungeFeed`, never the cutting feed), but two
 * rows close enough and already at or below the finished level's own target link as one cutting
 * feed instead of the three-rapid retract every row used to pay for unconditionally.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { memTrace } from '@/engine/cnc/memTrace';
import { estimateCycleSeconds, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { RemainderRegion, FeatureSource } from '../features';
import type { ClSurface } from '../clsurface';
import { profileOf } from '../dropcutter';
import { DEFAULT_SHORT_HOP_DIAMETERS, link, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
import { followCutSurface, followShortJoin } from '../rideTest';
import { dropRow, type DroppedPoint } from '../rowDropper';
import { cutterKeyOf } from '../sequence';
import { FLAT_SURFACE_MAX_SLOPE_DEG } from '../settings';
import type { OpOutcome, PassRef, RegionAtZ, RegionRef } from '../plan';

export type FinishKind = 'flat-raster' | 'ball-scallop';

// A hair off the footprint's own boundary (see `footprintColumnIntervals`'s own call site below) —
// smaller than any real raster step-over, so it costs nothing real, but keeps every `dropRow`
// endpoint safely INSIDE the footprint, never exactly on an edge.
const FOOTPRINT_EDGE_INSET_MM = 1e-4;

/**
 * #960 — THE SCALLOP HEIGHT THE BALL'S STEP-OVER HOLDS, mm. 0.027 comes from the vendor's own
 * program, not a preference: Makera's ⌀6 ball raster runs at 0.8 mm step-over, and
 * R − √(R² − (0.8/2)²) = 3 − √(9 − 0.16) = 0.0268 mm on that ball — the same cusp on the same
 * cutter. (The old engine's band was the rough's 0.3 mm stock-to-leave, a different quantity.)
 */
export const DEFAULT_FINISH_SCALLOP_MM = 0.027;

/**
 * #960 — the flat/ball threshold is the SHARED constant (`cam/model/settings.ts`'s
 * `FLAT_SURFACE_MAX_SLOPE_DEG`, also read by C's #959 skin pass), re-exported here so the finish's
 * callers name it from one place. Its value is a parameter at every call site; the manager ruled
 * 1.93° on 2026-11-05 (the equal-cusp derivation, not the vendor-like 7.1°).
 */
export { FLAT_SURFACE_MAX_SLOPE_DEG };

/** The share of a region's AREA that must lie under the threshold for the flat to take it. */
export const FLAT_FINISH_AREA_SHARE = 0.9;

/**
 * #1052 — THE FINISH'S MOVE CAP. One finish op's IR holds every level's moves; on j27 (the ⌀0.5
 * ball, a 50 mm region at the r/10 floor) that is ~874k moves per 0.2 mm level — an OOM by
 * construction at ~250 levels. Above this cap the op refuses BY NAME (the candidate leaves the
 * rank with its number, the plan continues), never an OOM. The §8.9 rule in code.
 */
export const FINISH_MOVE_CAP = 5_000_000;

/** Thrown when a finish op's moves pass the cap; the rank drops the candidate. */
export class PlanFinishTooManyMoves extends Error {
  readonly moves: number;
  readonly region: string;
  readonly cap: number;
  /** True when `moves` is the pre-build estimate, not a count of moves already built. */
  readonly estimated: boolean;
  constructor(moves: number, region: string, cap = FINISH_MOVE_CAP, estimated = false) {
    super(
      `the finish of "${region}" ${estimated ? 'would build about' : 'passed'} ${moves.toLocaleString('en-US')} moves (the cap is ${cap.toLocaleString('en-US')} per op) — a finer scallop or a smaller region, or a larger cutter's band`,
    );
    this.name = 'PlanFinishTooManyMoves';
    this.moves = moves;
    this.region = region;
    this.cap = cap;
    this.estimated = estimated;
  }
}
/** A raster row steeper than this is a wall: not finishable by raster, skipped with a note. */
const WALL_SKIP_DEG = 80;

/**
 * #1080 (6b's ruling) — THE CROSS-ROW TRIANGLE SLOPE: |∂z/∂x|, the direction the raster rows
 * ADVANCE (rows run along y, `x += stepOverMm`). The cusp a row spacing creates is across the
 * rows only; a wall running ALONG the rows has no cusp between them, and reading its gradient
 * magnitude pinned every band at the wall's own angle (the bottom job's 60° wall: 46 rings' worth
 * of rows where the gentle spacing was due).
 */
function crossRowSlopeDeg(positions: Float32Array, a: number, b: number, c: number): number {
  const ux = positions[b]! - positions[a]!;
  const uy = positions[b + 1]! - positions[a + 1]!;
  const uz = positions[b + 2]! - positions[a + 2]!;
  const vx = positions[c]! - positions[a]!;
  const vy = positions[c + 1]! - positions[a + 1]!;
  const vz = positions[c + 2]! - positions[a + 2]!;
  const nx = uy * vz - uz * vy;
  const nz = ux * vy - uy * vx;
  if (!(Math.hypot(nx, nz) > 0)) return 0;
  return (Math.atan(Math.abs(nx) / Math.abs(nz)) * 180) / Math.PI;
}

/** Triangle slope from its normal: the angle between the normal and +Z, degrees. */
function triangleSlopeDeg(positions: Float32Array, a: number, b: number, c: number): number {
  const ux = positions[b]! - positions[a]!;
  const uy = positions[b + 1]! - positions[a + 1]!;
  const uz = positions[b + 2]! - positions[a + 2]!;
  const vx = positions[c]! - positions[a]!;
  const vy = positions[c + 1]! - positions[a + 1]!;
  const vz = positions[c + 2]! - positions[a + 2]!;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 0)) return 0;
  return (Math.acos(Math.min(1, Math.abs(nz) / len)) * 180) / Math.PI;
}

/**
 * #960 — THE FLAT-OR-BALL DECISION from the region's own slope, not the sequence slot: the share
 * of the region's AREA whose triangle slope is at or under `maxFlatSlopeDeg`; flat when that
 * share is at least {@link FLAT_FINISH_AREA_SHARE}, otherwise the ball. The threshold is a
 * parameter (the shared constant with C's #959 skin pass).
 */
export function finishKindFor(region: RemainderRegion, mesh: FeatureSource['triangles'], maxFlatSlopeDeg: number): FinishKind {
  if (region.triangles.length === 0) return 'ball-scallop';
  const { positions, indices } = mesh;
  let area = 0;
  let under = 0;
  for (const t of region.triangles) {
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const c = indices[t * 3 + 2]! * 3;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    const triArea = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    area += triArea;
    if (triangleSlopeDeg(positions, a, b, c) <= maxFlatSlopeDeg) under += triArea;
  }
  return area > 0 && under / area >= FLAT_FINISH_AREA_SHARE ? 'flat-raster' : 'ball-scallop';
}

export interface FinishOpOptions {
  cutter: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  clSurface: ClSurface;
  /** The flat-vs-ball slope classification (C's per-slice minimum) — the admissible angle test that picks `kind`. */
  kind: FinishKind;
  /**
   * #960 — the mesh the region's triangle ids index, for the per-band slope. ABSENT falls back
   * to the region's stated steepest slope for every band (a caller that has no mesh — the op's
   * own unit fixtures), which is the pre-#960 read but still per-band.
   */
  mesh?: FeatureSource['triangles'];
  scallopMm: number;
  /**
   * #982 (the review session's ruling) — NO BALL IN THE SET: the flat finishes the whole curved
   * remainder, and its step-over is the flat's own cusp rule `cusp / tan(thetaMax)` clamped to
   * [R/10, R]. Absent -> the ordinary flat-raster rule.
   */
  flatFallback?: boolean;
  stepDownMm: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  safeZMm: number;
  hopZMm: number;
  toolNumber: number;
  spindleRpm: number;
  air: boolean;
  rapid: RapidEstimate;
  /**
   * ITEM 4a — WHERE THIS FINISH MAY CUT. The plan hands the cells where the flat's passes left
   * more than the band standing (`leftover = flatSwept − design > band`, dilated by the ball's own
   * footprint). Absent → the whole region, exactly as before. A row is split into the contiguous
   * runs this mask admits; the gaps between runs are `link()`'s job, the same rule as the
   * footprint's own notches.
   */
  maskCells?: (x: number, y: number) => boolean;
  /**
   * #962 — THE DESIGN'S TOP AT (x, y), in this op's datum, for the material field where the CL
   * surface has no answer (past the region's own footprint). The field feeds `link()`'s tests and
   * the disc-aware down-leg floor, which reach up to the cutter's radius past the region's edge;
   * the region's own `zTop` is NOT an upper bound there — a wall or land beside a low region can
   * stand higher, and a rapid floored at zTop would run into it. The plan states the goal/mesh
   * top (the honest bound at that XY); where even that is silent, `stockTopZMm` is the only bound
   * left. Absent → the field states nothing past the footprint, exactly as before.
   */
  materialTopAt?: (x: number, y: number) => number | null;
  /** The stock top in this op's datum — the last-resort bound past the footprint (see above). */
  stockTopZMm?: number;
  /**
   * #1052 — the move cap for THIS op, default {@link FINISH_MOVE_CAP}. Tests inject a small one
   * to pin the refusal without building millions of moves; production never passes it.
   */
  moveCap?: number;
}

/**
 * THE OP'S MATERIAL FIELD (#962; exported for the red-first that pins the bound past the
 * footprint). Inside the region's reach it is the level just finished, else the CL; past the
 * footprint it is the DESIGN's top there (`materialTopAt`), the stock top where the design is
 * silent — never the region's own `zTop`, which a neighbouring wall can out-top.
 */
export function finishMaterial(
  opts: Pick<FinishOpOptions, 'clSurface' | 'materialTopAt' | 'stockTopZMm'>,
  levelZ: number,
): MaterialField {
  return {
    topAt: (x, y) => {
      const cl = opts.clSurface.dropCutter(x, y);
      if (cl !== null) return Math.max(levelZ, cl);
      const design = opts.materialTopAt?.(x, y);
      if (design !== null && design !== undefined) return design;
      return opts.stockTopZMm ?? Number.POSITIVE_INFINITY;
    },
  };
}

/**
 * The Y-intervals of `footprint` crossed by the vertical line `x = atX`, even-odd rule (the same
 * edge-crossing convention `pointInPolygons` uses for one point, here for a whole scan line) —
 * sorted ascending, paired as `[enter, exit]`. A raster row at this `x` is cut only inside these
 * intervals; the manager's ruling on footprint vs links names the gaps between them (and between
 * rows) as `link()`'s own job, not this function's to paper over with a straight chord.
 */
function footprintColumnIntervals(footprint: Polygons, atX: number): [number, number][] {
  const ys: number[] = [];
  for (const ring of footprint) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]!;
      const [xj, yj] = ring[j]!;
      if ((xi <= atX && xj > atX) || (xj <= atX && xi > atX)) {
        const t = (atX - xi) / (xj - xi);
        ys.push(yi + t * (yj - yi));
      }
    }
  }
  ys.sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < ys.length; i += 2) out.push([ys[i]!, ys[i + 1]!]);
  return out;
}

/**
 * The depth levels from `zTop` down to `zBottom`, `stepDownMm` apart, the last landing exactly on
 * `zBottom` (never longer than `stepDownMm`, possibly shorter) — the same `depthPasses` pattern
 * `ops/pocket.ts` uses for a flat floor, here for a free-form one: only the LAST level is the
 * true CL surface, every earlier one is capped at its own (shallower) target.
 */
function depthLevels(zTop: number, zBottom: number, stepDownMm: number): number[] {
  const total = zTop - zBottom;
  if (!(total > 0)) return [zBottom];
  const count = Math.ceil(total / stepDownMm);
  const levels: number[] = [];
  for (let i = 1; i <= count; i++) levels.push(i === count ? zBottom : zTop - i * stepDownMm);
  return levels;
}

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
 * normal cusp divided by `cos(theta)` again. Solving `bandMm = (R - sqrt(R^2 - (stepOverMm *
 * cos(theta) / 2)^2)) / cos(theta)` for `stepOverMm` gives the closed form below. Measured
 * red-first (`finishOp960.spec.ts`) against an ALL-rows cusp scan (not just the bracketing pair)
 * on the tray's own 18° ramp: 1.4254mm step-over for a 3mm-radius ball and a 0.1mm band, cusp
 * 0.1000mm — confirmed, not assumed.
 */
function ballScallopStepOver(radiusMm: number, bandMm: number, steepestSlopeDeg: number): number {
  if (!(radiusMm > 0) || !(bandMm > 0) || bandMm >= radiusMm) return Math.max(radiusMm, 0.1);
  const cosTheta = Math.cos((steepestSlopeDeg * Math.PI) / 180);
  const bandPrime = bandMm * cosTheta;
  const spacing = cosTheta * 2 * Math.sqrt(Math.max(0, 2 * radiusMm * bandPrime - bandPrime * bandPrime));
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
 * Flat-following raster step-over: a flat's own cusp on a slope is `stepOver * tan(slope)`
 * (advisor's review) — `stepOver = band / tan(slope)`, the derived bound that holds the SAME
 * leftover band the ball's cusp rule targets. Sized to the region's own STEEPEST slope
 * (`slopeDeg[1]`) so the band holds everywhere in it, not only at the median; a near-flat region
 * has no real cusp at all, so its own step-over is capped at the cutter's diameter instead of
 * diverging.
 */
/** #982 — the flat's cusp rule with no ball in the set: `s = cusp / tan(thetaMax)`, clamp [R/10, R]. */
function flatFallbackStepOver(radiusMm: number, bandMm: number, steepestSlopeDeg: number): number {
  const slopeRad = (steepestSlopeDeg * Math.PI) / 180;
  const raw = slopeRad > 1e-6 ? bandMm / Math.tan(slopeRad) : radiusMm;
  return Math.min(radiusMm, Math.max(radiusMm / 10, raw));
}

function flatRasterStepOver(radiusMm: number, bandMm: number, steepestSlopeDeg: number): number {
  const cap = 2 * radiusMm;
  const slopeRad = (steepestSlopeDeg * Math.PI) / 180;
  if (!(slopeRad > 1e-6)) return cap;
  return Math.min(cap, bandMm / Math.tan(slopeRad));
}

/**
 * #962 — THE WHOLE-PROFILE STAY-DOWN TEST. A ball is not a point, and it is not a flat disc
 * either: `link()`'s material test is the FLAT rule (material at or below the link's own z at
 * every disc offset), exact for a flat end mill's bottom but not the geometry of a ball, whose own
 * surface stands `heightAt(profile, d)` above its tip at horizontal offset d.
 *
 * The test a shaped cutter needs is exactly the drop-cutter definition read backwards. At (x, y)
 * the CL surface IS the cutter's whole profile dropped onto the design —
 * `z_tip = max over the disc of (design − heightAt(ρ))` — so a link that rides AT OR ABOVE the CL
 * surface at every point along its path clears every point of the design under the cutter there:
 * the footprint and the flank, not just the centre point. A link that would dip below the CL cuts
 * into the design and must retract.
 *
 * The comparison tolerates the CL surface's own sampling tolerance: the link's z and the CL are
 * read from the same surface, and the row-dropper only promises the chord between its own points
 * within that tolerance.
 *
 * WHY THIS IS NOT JUST `link()`: `linkIsClear` compares the material FIELD at the disc's own
 * offsets against the link's z, and the field is the CL of the ground UNDER EACH OFFSET — higher
 * than the link's own z wherever the ground rises beside the path. Every sloped link is refused
 * for that reason (the organizer's ball: 71.6 % air), though the cutter's flank would clear the
 * rise by construction. The shape-aware disc test belongs in the shared linker and is proposed on
 * #962 for B; until it lands, the op makes this one decision itself and leaves every other route
 * (retracts, vertical legs, hop clearance) to `link()`.
 */
/**
 * #1030 — exported for its unit pin: the ride test's sampling step is the thing that decides
 * whether a short join's interior is ever looked at (the organizer's 0.33 mm plunge-rate joins had
 * no interior sample and crossed CL creases 0.011–0.014 mm under the exact CL).
 */
export function ridesTheCl(from: LinkPoint, to: LinkPoint, clSurface: ClSurface, stepMm: number): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const step = stepMm > 0 ? stepMm : 0.5;
  // #1030 — AT LEAST TWO INTERVALS. A join shorter than the step used to get ONE interval: t = 0
  // and t = 1, both run endpoints that sit on the CL by construction, so the chord between them was
  // never examined — the organizer's 0.33 mm plunge-rate joins crossed CL creases 0.011–0.014 mm
  // under the exact CL that way. Two intervals sample the midpoint whatever the length; the caller
  // floors the step at 0.05 mm so a longer join's creases are sampled too.
  const steps = Math.max(2, Math.ceil(length / step));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    // #1033 (lever b) — A SAMPLE THE CLIPPED SURFACE DOES NOT OWN IS STILL PROVABLE. The clip is
    // the ROWS' reach rule: where the footprint is holed or non-convex (an island, a pocket mouth)
    // the clipped query answers null although the physical CL there is well defined. Ask the same
    // mesh unclipped and hold the chord to it — it may ride ATOP the neighbouring surface, never
    // below it. Only a null there (off the part entirely, or no unclipped query at all) is no proof.
    const cl = clSurface.dropCutter(x, y) ?? clSurface.dropCutterUnclipped?.(x, y) ?? null;
    if (cl === null) return false; // the surface cannot prove the path: a retract is always safe
    const z = from.z + (to.z - from.z) * t;
    if (z < cl - clSurface.toleranceMm) return false;
  }
  return true;
}


export function finish(opts: FinishOpOptions): OpOutcome {
  const toolRadius = (cuttingDiameter(opts.cutter) ?? 0) / 2;
  if (!(toolRadius > 0)) {
    throw new Error(`cam/model/ops/finish: ${opts.cutter.name || opts.cutter.shape} states no cutting diameter`);
  }
  const profile = profileOf(opts.cutter);
  if (profile === null) {
    throw new Error(`cam/model/ops/finish: ${opts.cutter.name || opts.cutter.shape} has no drop-cutter profile for a finish pass`);
  }
  const levels = depthLevels(opts.region.zTop, opts.region.zBottom, opts.stepDownMm);
  const { min, max } = opts.regionRef.bounds;

  // #960 — THE BALL'S STEP-OVER PER BAND, not once per region. The old read took the region's
  // single steepest cell, so one near-vertical facet floored the WHOLE region's spacing (⌀6 ball →
  // the radius/10 floor = 0.3 mm, against the vendor's 0.8 mm). The slope is binned along X from
  // the region's own triangles; each raster band's spacing comes from its own slope. A band
  // steeper than `WALL_SKIP_DEG` is a wall: it is CUT at the cutter's own floor, never skipped —
  // skipping lost the organizer 10 points.
  const BIN_MM = 0.25;
  const binCount = Math.max(1, Math.ceil((max[0] - min[0]) / BIN_MM));
  // #1080 (6b's straight-strip gate) — BOTH triangle reads per bin: the cross-row component and
  // the gradient magnitude. Which one sizes the band is the CL block's call, per bin.
  const binCrossSlope = new Float64Array(binCount).fill(Number.NaN);
  const binMagSlope = new Float64Array(binCount).fill(Number.NaN);
  if (opts.mesh === undefined) {
    binCrossSlope.fill(opts.region.slopeDeg[1]);
    binMagSlope.fill(opts.region.slopeDeg[1]);
  } else {
    const { positions, indices } = opts.mesh;
    for (const t of opts.region.triangles) {
      const a = indices[t * 3]! * 3;
      const b = indices[t * 3 + 1]! * 3;
      const c = indices[t * 3 + 2]! * 3;
      const xs = [positions[a]!, positions[b]!, positions[c]!];
      const cross = crossRowSlopeDeg(positions, a, b, c);
      const mag = triangleSlopeDeg(positions, a, b, c);
      const lo = Math.max(min[0], Math.min(...xs));
      const hi = Math.min(max[0], Math.max(...xs));
      const first = Math.floor((lo - min[0]) / BIN_MM);
      const last = Math.floor((hi - min[0]) / BIN_MM);
      for (let k = Math.max(0, first); k <= Math.min(binCount - 1, last); k++) {
        if (!(binCrossSlope[k]! >= cross)) binCrossSlope[k] = cross;
        if (!(binMagSlope[k]! >= mag)) binMagSlope[k] = mag;
      }
    }
  }
  const binSlope = new Float64Array(binCount);
  // #960 — AND THE CL SURFACE'S OWN SLOPE per bin, sampled from the surface the rows actually
  // follow: the ball's CL is what turns a cliff into a shoulder over the cutter's radius, so a
  // bin's triangle slopes alone under-read it. Both reads are kept, the steeper wins.
  {
    const h = 0.1;
    const ys = 5;
    const radius = profile.radiusMm;
    for (let k = 0; k < binCount; k++) {
      const xc = min[0] + (k + 0.5) * BIN_MM;
      let cross = Number.isNaN(binCrossSlope[k]!) ? 0 : binCrossSlope[k]!;
      let mag = Number.isNaN(binMagSlope[k]!) ? 0 : binMagSlope[k]!;
      // #1080 (6b's straight-strip gate) — the cross-row component is right only where the CL is
      // a STRAIGHT ramp in x across the strip. The test is the second difference over the row
      // sampling, |z(xc+h) − 2·z(xc) + z(xc−h)|, at each of the strip's y samples: over the
      // scallop, the bin crosses a ridge or a valley, the ball rides the kink, and the bin keeps
      // the gradient magnitude (the pre-#1080 read, so every card's leftover is what it was).
      let straight = true;
      let mouth = false;
      for (let s = 0; s < ys; s++) {
        const y = min[1] + ((s + 0.5) / ys) * (max[1] - min[1]);
        const z0 = opts.clSurface.dropCutter(xc, y);
        const zx = opts.clSurface.dropCutter(xc + h, y);
        const zy = opts.clSurface.dropCutter(xc, y + h);
        const zm = opts.clSurface.dropCutter(xc - h, y);
        // #960 — A POCKET MOUTH inside the cutter's own reach: the ball rides the shoulders across
        // the opening, so any row over it leaves the mouth's depth standing and the rows' phase
        // decides how much. Those bands keep the old dense floor so nothing is lost.
        const zl = opts.clSurface.dropCutter(xc - radius, y);
        const zr = opts.clSurface.dropCutter(xc + radius, y);
        // A ball bridging a gap sits HIGHER than its neighbours (the CL is a local ridge over the
        // mouth); that ridge is the signature, not a left-right difference across the opening.
        if (zl !== null && zr !== null && z0 !== null && z0 - Math.max(zl, zr) > opts.scallopMm) mouth = true;
        if (z0 === null || zx === null || zm === null) straight = false;
        else if (Math.abs(zx - 2 * z0 + zm) > opts.scallopMm) straight = false;
        if (z0 === null || zx === null || zy === null) continue;
        const crossSlope = (Math.atan(Math.abs((zx - z0) / h)) * 180) / Math.PI;
        const magSlope = (Math.atan(Math.hypot((zx - z0) / h, (zy - z0) / h)) * 180) / Math.PI;
        if (crossSlope > cross) cross = crossSlope;
        if (magSlope > mag) mag = magSlope;
      }
      binSlope[k] = mouth ? 90 : straight ? cross : mag;
    }
  }
  // #960 — the band's slope is the STEEPEST within a small window: a cliff's cell lies in the next
  // bin along, and a row just off it meets the shoulder too. Without the window 2,411 tray cells
  // (0.17 %) read 0.10–0.17 mm of leftover they did not have at the old dense spacing.
  // #960 — THE WINDOW IS THE CUTTER'S REACH, not a fixed ±0.75 mm: a ball cuts with its flank
  // R·sinθ from its axis (≈2.1 mm at 45° on ⌀6), so a row 1.5–2.5 mm inboard of a steep wall must
  // read that wall's slope. A ±3-bin window is narrower than the ball's reach and let the lever
  // space such rows at the gentle-band step (the review's finding on the organizer's 8 cells).
  const WINDOW_BINS = Math.max(3, Math.ceil(profile.radiusMm / BIN_MM));
  const bandSlopeAt = (x: number): number => {
    const k = Math.min(binCount - 1, Math.max(0, Math.floor((x - min[0]) / BIN_MM)));
    let best = 0;
    for (let d = -WINDOW_BINS; d <= WINDOW_BINS; d++) {
      const kk = k + d;
      if (kk < 0 || kk >= binCount) continue;
      const v = binSlope[kk]!;
      if (!Number.isNaN(v) && v > best) best = v;
    }
    return best;
  };
  // #960 — THE MANAGER'S PRICED LEVER (2026-11-05): each band's spacing is ITS OWN scallop step —
  // ~0.8 mm on the gentle floor (the vendor's ⌀6 ball at a 0.027 mm cusp), tightening on the
  // steeper bands and floored at the cutter's radius/10 on a wall. Every row is phased from the
  // OLD raster's own origin, and the row AT that origin is cut (the #960 rewrite had dropped it,
  // which is what cost the tray's 2,411 slot cells — not a phase shift).
  const flatRowStepMm = opts.flatFallback === true
    ? flatFallbackStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1])
    : flatRasterStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1]);
  const regionStepOverMm =
    opts.kind === 'ball-scallop'
      ? ballScallopStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1])
      : flatRowStepMm;
  const bandStepOverAt = (x: number): number =>
    opts.kind === 'ball-scallop'
      ? ballScallopStepOver(profile.radiusMm, opts.scallopMm, bandSlopeAt(x))
      : flatRowStepMm;
  let wallBandsCut = 0;

  // #960 — THE ROW GUARD (the manager's rule: no cell newly above the band). The scallop step holds
  // the band only where the CL surface is STRAIGHT across the gap. At a slot wall or a bridged
  // mouth it is not — and a row grid on a new phase can leave a knife-edge cell that the OLD
  // raster's row lapped (the organizer's 243 cells, all on walls at the 0.30 mm floor). There the
  // advance snaps to the next OLD-grid row instead (`origin + k·regionStepOverMm`), so the base
  // raster's rows stay in place; on straight stretches the vendor step stands.
  const X_NUDGE_MM = 1e-4;
  const originX = min[0] + X_NUDGE_MM;
  const oldGridNext = (x: number): number =>
    originX + (Math.floor((x - originX) / regionStepOverMm + 1e-9) + 1) * regionStepOverMm;
  const clSafeAcross = (x0: number, x1: number): boolean => {
    const intervals = footprintColumnIntervals(opts.region.footprint, (x0 + x1) / 2);
    if (intervals.length === 0) return true; // nothing is cut between the two rows
    // A KINK test, not a chord test: sample the CL densely across the gap and compare the slope
    // of its first quarter with its last. A plane answers the same slope (any steepness) and is
    // safe by the scallop formula; a rim, a slot wall or a bridged mouth changes slope sharply,
    // and there a new row phase can lose the cell the old row lapped.
    const SLOPE_JUMP = 0.5; // mm/mm (~26.6°) across one gap — a rim's kink, not surface noise
    const SAMPLES = 16;
    for (const [y0, y1] of intervals) {
      for (const tY of [0.1, 0.3, 0.5, 0.7, 0.9]) {
        const y = y0 + (y1 - y0) * tY;
        const pts: [number, number][] = [];
        for (let k = 1; k < SAMPLES; k++) {
          const x = x0 + ((x1 - x0) * k) / SAMPLES;
          const z = opts.clSurface.dropCutter(x, y);
          if (z !== null) pts.push([x, z]);
        }
        if (pts.length < 4) continue; // too few samples to judge: keep the band's own step
        const q = Math.floor(pts.length / 4);
        const a = pts[0]!;
        const b = pts[q]!;
        const c = pts[pts.length - 1 - q]!;
        const d = pts[pts.length - 1]!;
        const s1 = (b[1] - a[1]) / Math.max(1e-9, b[0] - a[0]);
        const s2 = (d[1] - c[1]) / Math.max(1e-9, d[0] - c[0]);
        if (Math.abs(s2 - s1) > SLOPE_JUMP) return false;
      }
    }
    return true;
  };

  // The field is honest about only the level just FINISHED (rough.ts's own reasoning): capped at
  // that level's own Z, never the level about to start, so a link is never approved through a
  // deeper target this op has not actually reached yet. Outside the footprint the field states
  // nothing (`+Infinity`), so a link endpoint off the region's own edge always retracts.
  const materialFor = (levelZ: number): MaterialField => finishMaterial(opts, levelZ);
  const linkOptionsFor = (levelZ: number): LinkOptions => ({
    material: materialFor(levelZ),
    clearanceZ: opts.regionRef.regionClearanceZ,
    tool: { radiusMm: toolRadius },
    feeds: { feed: opts.feeds.feedMmPerMin, plungeFeed: opts.feeds.plungeFeedMmPerMin },
    hopClearanceMm: opts.hopZMm,
  });

  // #962 — the row-to-row (and run-to-run) join. A stay-down link is decided by the whole-profile
  // test above: within Kiri:Moto's short hop, the same cap `link()` applies, and riding the CL
  // surface for the whole segment. Everything else — the retract, its vertical legs and the hop
  // clearance — is `link()`'s own, untouched.
  const linkSampleStep = Math.min(0.5, Math.max(0.1, toolRadius / 2));
  // #1030 — THE RIDE TEST'S STEP IS FLOORED, the long-ride step kept: `linkSampleStep` is sized for
  // the stay-down rides of #962, but the short joins are 0.3–0.7 mm and must be sampled finely
  // enough to catch a CL crease between their endpoints — the same 0.05 mm `rough.ts`'s skim joins
  // already prove at, and never coarser than the CL surface's own spacing.
  const rideStep = Math.min(linkSampleStep, opts.clSurface.maxSpacingMm, 0.05);
  // #1030 (the manager's ruling) — the band above which a CL rise is a WALL to retract over, not a
  // crease to follow: the plan's own 0.1 mm leftover band. Under it, a short refused join is fed
  // along the sampled CL (a few 0.05 mm steps) instead of paying a retract/hop.
  const SHORT_JOIN_CLIMB_BAND_MM = 0.1;
  // #1033 (§6) — THE JOIN AUDIT, per op: which branch decided each run-to-run join, so a card can
  // show where its cycle goes. `ride` = the chord proven by the ride test (clipped or, since lever
  // b, against the neighbouring surface); `follow` = the short CL follow or the dip-following link;
  // `routed` = a join routed inside the footprint (lever a); `retract` = the last resort.
  const joinCounts = { ride: 0, follow: 0, routed: 0, retract: 0 };
  const joinMoves = (from: LinkPoint, to: LinkPoint, levelZ: number): ToolpathIR['operations'][number]['moves'] => {
    const direct = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const shortHop = DEFAULT_SHORT_HOP_DIAMETERS * 2 * toolRadius;
    if (direct <= shortHop + 1e-9 && ridesTheCl(from, to, opts.clSurface, rideStep)) {
      joinCounts.ride++;
      // A DESCENDING LINK IS A CUT INTO LOWER GROUND: it runs at the plunge rate, the same rule
      // the op's own first feed follows (9e976f0b's finding — never a descent at the cutting rate).
      const f = to.z < from.z - 1e-9 ? opts.feeds.plungeFeedMmPerMin : opts.feeds.feedMmPerMin;
      return [{ kind: 'feed', x: to.x, y: to.y, z: to.z, f }];
    }
    // #1030 (the manager's ruling) — A SHORT JOIN REFUSED ONLY BY THE CREASE IS FOLLOWED, not
    // retracted: the sampled CL polyline at feed, a few points over the join's own length. The
    // climb/interrupt cases return null here and keep the old path below.
    if (direct <= shortHop + 1e-9) {
      const shortFollow = followShortJoin(
        from,
        to,
        (x, y) => opts.clSurface.dropCutter(x, y),
        rideStep,
        levelZ,
        opts.feeds,
        SHORT_JOIN_CLIMB_BAND_MM,
      );
      if (shortFollow !== null) {
        joinCounts.follow++;
        return shortFollow;
      }
    }
    // #962 — THE DIP-FOLLOWING LINK: the chord dipped below the CL (concave ground). FOLLOW the CL
    // instead — the ball cuts the bulge exactly as the passes either side of it do, so nothing is
    // gouged below the design — but only when the path is provably clear all the way and the
    // follow is FASTER than the retract it replaces (the time guard; the earlier pricing showed a
    // stay-down feed only wins inside ~25-30 mm, and this branch's joins are far shorter).
    const follow = followCutSurface(from, to, (x, y) => opts.clSurface.dropCutter(x, y), linkSampleStep, levelZ, opts.feeds, opts.rapid, opts.regionRef.regionClearanceZ);
    if (follow !== null) {
      joinCounts.follow++;
      return follow;
    }
    // #966 — NO `landingCut`: a row's start is not proven cut at the row's own z. The finish's rows
    // run at the CL surface, and on a steep flank the row before can sit above the landing's z, so
    // the retract descends only to the stock top plus the hop and feeds the rest.
    joinCounts.retract++;
    return link(from, to, linkOptionsFor(levelZ));
  };

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];
  let prevExit: DroppedPoint | null = null;
  let prevLevelZ: number | null = null;
  const cap = opts.moveCap ?? FINISH_MOVE_CAP;

  // #1052 — THE ESTIMATE BEFORE THE BUILD, from the bins and pitches (not from moves already
  // built): above the cap the op refuses by name and the rank drops the candidate with its
  // number. Each bin's row pitch is the pitch its own slope earns, so a large shallow region is
  // not priced at a wall's spacing.
  {
    const pointPitch = Math.max(0.005, opts.clSurface.maxSpacingMm);
    const avgY = opts.region.area / Math.max(1e-9, max[0] - min[0]);
    let estimated = 0;
    for (let k = 0; k < binCount; k++) {
      const binX = min[0] + (k + 0.5) * BIN_MM;
      const pitchMm = opts.kind === 'ball-scallop'
        ? (bandSlopeAt(binX) >= WALL_SKIP_DEG ? profile.radiusMm / 10 : bandStepOverAt(binX))
        : flatRowStepMm;
      estimated += (BIN_MM * avgY) / (Math.max(1e-6, pitchMm) * pointPitch);
    }
    estimated = Math.ceil(estimated * 1.2);
    if (estimated > cap) throw new PlanFinishTooManyMoves(estimated, opts.region.id, cap, true);
  }

  // #1052 — EACH CELL ONCE. The level loop's real job was the top-down order, not the cut: a
  // cell is always cut at its own CL the first time a level passes below it, and the old code
  // re-rasted the whole span at every level, repeating every cell's cut at its CL for the rest of
  // the levels (j27: 874k moves/level × 250 levels). The rows are sampled once here and each
  // point is bucketed into the level whose band holds its CL (`finishMaterial`'s own band),
  // then each level's runs are toured and emitted in order. The final surface is unchanged —
  // the band a cell joins IS the level whose pass first reached its CL.
  const rasterRuns: DroppedPoint[][][] = levels.map(() => []);
  const rasterCleared: Polygons[] = levels.map(() => []);
  const levelIndexOf = (z: number): number => {
    const k = Math.ceil((opts.region.zTop - z) / opts.stepDownMm - 1e-9) - 1;
    return Math.min(levels.length - 1, Math.max(0, k));
  };

  // A raster row COLLINEAR with a polygon edge is the even-odd tracer's own blind spot: a vertical
  // edge at exactly x contributes no crossing by the half-open rule, so a hole on that line becomes
  // invisible and the row's interval spans straight across it — `dropRow` then refuses the null
  // midpoint between two valid ends ('a footprint notch'). The organizer's grown finish region hits
  // it on the real part: its offset lands vertical edges on exactly the raster's round x values.
  // The rows start a tenth of a micron off, far below the CL tolerance (0.005 mm), and the blind
  // spot is gone.
  // #1052 — the raster's own progress, every 32 rows: the 10-minute j27 run sits inside ONE
  // finish() call, so these are the only rows that show the heap's slope.
  let finishRows = 0;
  let finishRowTick = 0;
  // #960 — THE ROWS ARE PHASED FROM THE OLD RASTER'S OWN ORIGIN, and the row AT that origin is
  // cut (the #960 rewrite dropped it — 24 moves per level, and the tray's 2,411 slot cells).
  // Each row then advances by its OWN band's scallop step, unless the row guard finds the
  // stretch not straight — then it snaps to the old grid's next row.
  for (let x = originX; x <= max[0] + 1e-9; ) {
    const wallBand = opts.kind === 'ball-scallop' && bandSlopeAt(x) >= WALL_SKIP_DEG;
    if (wallBand) wallBandsCut++;
    let stepOverMm = wallBand ? profile.radiusMm / 10 : bandStepOverAt(x);
    // A region whose OLD step is already the ball's radius/10 floor has no finer grid to offer:
    // its base raster is the densest the formula allows, so a band at or under it stays ON the
    // old grid (the organizer's rim cells live exactly there). Everywhere else a finer band may
    // ride its own phase, and a kinked gap falls back to the old grid.
    const flooredBase = regionStepOverMm <= profile.radiusMm / 10 + 1e-9;
    if (flooredBase && stepOverMm <= regionStepOverMm + 1e-9) {
      const nextOld = oldGridNext(x);
      if (nextOld > x + 1e-6) stepOverMm = Math.min(stepOverMm, nextOld - x);
    } else if (stepOverMm > 1e-6 && !clSafeAcross(x, x + stepOverMm)) {
      const nextOld = oldGridNext(x);
      if (nextOld > x + 1e-6) stepOverMm = nextOld - x;
    }
    const intervals = footprintColumnIntervals(opts.region.footprint, x);
    for (const interval of intervals) {
      const [rawY0, rawY1] = interval;
      // Inset off the footprint's own boundary, a hair, toward the interval's own centre: an
      // endpoint landing EXACTLY on the polygon edge is where `pointInPolygons`' ray-casting is
      // ambiguous by convention (`clSurface`'s own gate), not a real gap — advisor's review.
      const insetY0 = rawY0 + Math.sign(rawY1 - rawY0) * FOOTPRINT_EDGE_INSET_MM;
      const insetY1 = rawY1 - Math.sign(rawY1 - rawY0) * FOOTPRINT_EDGE_INSET_MM;
      if (Math.abs(insetY1 - insetY0) <= 1e-9 || (insetY1 - insetY0) * (rawY1 - rawY0) < 0) continue; // the interval is narrower than the inset: nothing to cut
      const row = dropRow(opts.clSurface, [x, insetY0], [x, insetY1]);

      // ITEM 4a — the row's points are cut only where the plan's mask admits them; each
      // contiguous admitted run is its own cut, and the gaps between runs are links.
      const runs: DroppedPoint[][] = [];
      if (opts.maskCells === undefined) {
        runs.push(row);
      } else {
        let current: DroppedPoint[] = [];
        for (const p of row) {
          if (opts.maskCells(p.x, p.y)) current.push(p);
          else if (current.length > 0) { runs.push(current); current = []; }
        }
        if (current.length > 0) runs.push(current);
      }
      for (const admitted of runs) {
        if (admitted.length < 2) continue;
        // #1052 — split the admitted run by level: a row crossing several bands gives each level
        // its own sub-run, cut at that level's pass.
        let segStart = 0;
        for (let i = 1; i <= admitted.length; i++) {
          const boundary = i === admitted.length || levelIndexOf(admitted[i]!.z) !== levelIndexOf(admitted[segStart]!.z);
          if (!boundary) continue;
          const segment = admitted.slice(segStart, i);
          if (segment.length >= 2) {
            const k = levelIndexOf(admitted[segStart]!.z);
            // #1052 — THE LEVEL'S OWN FLOOR IS STILL A FLOOR: the band a cell joins is the level
            // whose pass first reached its CL, and its cut is `max(CL, level floor)` exactly as the
            // per-level clamp stated it. A CL BELOW the region's zBottom (an open mesh's repair
            // skirt under the sheet) is held at zBottom, never followed under it.
            const floorZ = levels[k]!;
            const clamped = segment.some((p) => p.z < floorZ)
              ? segment.map((p) => (p.z < floorZ ? { ...p, z: floorZ } : p))
              : segment;
            rasterRuns[k]!.push(clamped);
            rasterCleared[k]!.push([[x, Math.min(rawY0, rawY1)], [x, Math.max(rawY0, rawY1)]]);
          }
          segStart = i;
        }
      }
    }
    if (!(stepOverMm > 1e-6)) break;
    finishRows++;
    if (++finishRowTick % 32 === 0) {
      memTrace('finish:row', { rows: finishRows, x: Number(x.toFixed(2)), moves: moves.length });
    }
    x += stepOverMm;
  }

  // 2. ORDER a level's runs so consecutive passes are neighbours, WITH A CONNECTIVITY CONSTRAINT
  //    (#962): a tour edge must stay inside the CL surface's own reach. The finish's region (the
  //    scoop ring and the skirt, grown by the ball) is non-convex, and the unconstrained tour
  //    connected runs whose straight path crossed a bay of the region — where `dropCutter`
  //    answers nothing, the ride test must refuse, and every such join paid a retract. Measured
  //    on the organizer: 62 of the ball finish's 87 refusals were exactly these, 71 % of its
  //    remaining rapids. The edge test is the ride test's own null check, applied to the XY path.
  const reaches = (ax: number, ay: number, bx: number, by: number): boolean => {
    const length = Math.hypot(bx - ax, by - ay);
    const steps = Math.max(1, Math.ceil(length / linkSampleStep));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (opts.clSurface.dropCutter(ax + (bx - ax) * t, ay + (by - ay) * t) === null) return false;
    }
    return true;
  };

  // 3. EMIT one level's runs in tour order, each run entered at the end the tour chose.
  const emitLevelRuns = (levelZ: number, levelRuns: DroppedPoint[][]): void => {
    if (levelRuns.length === 0) return;
    const fromXY: [number, number] = prevExit === null ? [min[0], min[1]] : [prevExit.x, prevExit.y];
    const remainingRuns = levelRuns.map((_, k) => k);
    const order: number[] = [];
    const reversedOf: boolean[] = [];
    let px = fromXY[0];
    let py = fromXY[1];
    while (remainingRuns.length > 0) {
      // The nearest run whose nearer end is REACHABLE; the plain nearest only when none of the
      // candidates tried is (a region ringed by unreachable ground still has to be cut). The
      // candidates are sorted by distance FIRST and the reach test — a CL sampling run, not free —
      // is spent in that order, at most REACH_CANDIDATES times: testing every run against the
      // surface at every step is O(n^2) CL queries and took the organizer's plan from minutes to
      // tens of minutes.
      const candidates = remainingRuns.map((index, k) => {
        const run = levelRuns[index]!;
        const a = run[0]!;
        const b = run[run.length - 1]!;
        const da = Math.hypot(a.x - px, a.y - py);
        const db = Math.hypot(b.x - px, b.y - py);
        return { k, index, reversed: db < da, d: Math.min(da, db) };
      });
      candidates.sort((c1, c2) => c1.d - c2.d || c1.index - c2.index);
      const REACH_CANDIDATES = 8;
      let pick = candidates[0]!.k;
      let pickReversed = candidates[0]!.reversed;
      let tried = 0;
      for (const c of candidates) {
        if (tried++ >= REACH_CANDIDATES) break;
        const run = levelRuns[c.index]!;
        const end = c.reversed ? run[0]! : run[run.length - 1]!;
        if (reaches(px, py, end.x, end.y)) {
          pick = c.k;
          pickReversed = c.reversed;
          break;
        }
      }
      const index = remainingRuns.splice(pick, 1)[0]!;
      order.push(index);
      reversedOf.push(pickReversed);
      const run = levelRuns[index]!;
      const end = pickReversed ? run[0]! : run[run.length - 1]!;
      px = end.x;
      py = end.y;
    }
    for (let k = 0; k < order.length; k++) {
      let points = levelRuns[order[k]!]!;
      if (reversedOf[k]) points = [...points].reverse();
      const entryPoint: LinkPoint = { x: points[0]!.x, y: points[0]!.y, z: points[0]!.z };
      if (prevExit === null) {
        // The run's own FIRST feed is a PLUNGE (straight down from the hop height into material),
        // never at the cutting feed — the same bug 9e976f0b fixed in `ops/pocket.ts`.
        moves.push({ kind: 'rapid', x: entryPoint.x, y: entryPoint.y, z: opts.hopZMm });
        moves.push({ kind: 'feed', x: entryPoint.x, y: entryPoint.y, z: entryPoint.z, f: opts.feeds.plungeFeedMmPerMin });
      } else {
        const from: LinkPoint = { x: prevExit.x, y: prevExit.y, z: prevExit.z };
        moves.push(...joinMoves(from, entryPoint, prevLevelZ ?? prevExit.z));
      }
      for (let i = 1; i < points.length; i++) {
        moves.push({ kind: 'feed', x: points[i]!.x, y: points[i]!.y, z: points[i]!.z, f: opts.feeds.feedMmPerMin });
      }
      const entry: [number, number, number] = [points[0]!.x, points[0]!.y, points[0]!.z];
      const exitPoint = points[points.length - 1]!;
      const exit: [number, number, number] = [exitPoint.x, exitPoint.y, exitPoint.z];
      passes.push({
        z: levelZ,
        boundary: [points.map((p) => [p.x, p.y] as [number, number])],
        cleared: { z: levelZ, boundary: [[entry.slice(0, 2) as [number, number], exit.slice(0, 2) as [number, number]]] },
        entry,
        exit,
      });
      prevExit = exitPoint;
      prevLevelZ = levelZ;
    }
    // #1052 — THE CAP, checked per LEVEL so the heap never holds more than one level past it. The
    // rank drops this candidate with the number; the plan continues (never an OOM).
    if (moves.length > cap) {
      throw new PlanFinishTooManyMoves(moves.length, opts.region.id, cap);
    }
  };

  for (let k = 0; k < levels.length; k++) {
    emitLevelRuns(levels[k]!, rasterRuns[k]!);
    cleared.push({ z: levels[k]!, boundary: rasterCleared[k]! });
  }

  if (moves.length > 0) {
    const last = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: last.x, y: last.y, z: opts.safeZMm });
  }

  const depth = opts.region.zTop - opts.region.zBottom;
  const ir: ToolpathIR = {
    frame: 'flat',
    tool: opts.cutter,
    toolNumber: opts.toolNumber,
    spindleRpm: opts.spindleRpm,
    air: opts.air,
    safeZ: opts.safeZMm,
    hopZ: opts.hopZMm,
    operations: [
      {
        number: 1,
        name: `[T${opts.toolNumber}] Finish "${opts.region.id}" (${opts.kind})`,
        labelId: opts.region.id,
        depth,
        depthPasses: levels.length,
        passStepMm: opts.stepDownMm,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, opts.rapid),
      },
    ],
  };

  const notes: string[] = [];
  if (wallBandsCut > 0) {
    notes.push(
      `${wallBandsCut} raster row(s) over walls steeper than ${WALL_SKIP_DEG}° ride at or below the cutter's own ${(opts.kind === 'flat-raster' ? 'flat' : 'ball')} floor (radius/10) rather than the scallop spacing — they are cut, not skipped`,
    );
  }
  // #1033 (§6) — THE JOIN AUDIT: only where a join costs a retract (or a route) is the count worth
  // the line; an op whose joins all ride states nothing new.
  const joinTotal = joinCounts.ride + joinCounts.follow + joinCounts.routed + joinCounts.retract;
  if (joinCounts.retract > 0 || joinCounts.routed > 0) {
    notes.push(
      `${joinTotal} run-to-run join(s): ${joinCounts.ride} ride the CL, ${joinCounts.follow} follow it, ${joinCounts.routed} routed inside the footprint, ${joinCounts.retract} retract`,
    );
  }
  return {
    ir,
    cutter: cutterKeyOf(opts.cutter),
    passes,
    cleared,
    ...(notes.length === 0 ? {} : { notes }),
  };
}

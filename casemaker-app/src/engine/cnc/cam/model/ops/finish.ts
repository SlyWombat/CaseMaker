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
import { tourNearest } from '@/engine/cnc/cam/tour';
import { estimateCycleSeconds, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { RemainderRegion, FeatureSource } from '../features';
import type { ClSurface } from '../clsurface';
import { profileOf } from '../dropcutter';
import { DEFAULT_SHORT_HOP_DIAMETERS, link, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
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
 * callers name it from one place. Its value is a parameter at every call site and is pending the
 * manager's ruling on the picture (equal-cusp 1.93° vs vendor-like 7.1°).
 */
export { FLAT_SURFACE_MAX_SLOPE_DEG };

/** The share of a region's AREA that must lie under the threshold for the flat to take it. */
export const FLAT_FINISH_AREA_SHARE = 0.9;

/** A raster row steeper than this is a wall: not finishable by raster, skipped with a note. */
const WALL_SKIP_DEG = 80;

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
function ridesTheCl(from: LinkPoint, to: LinkPoint, clSurface: ClSurface, stepMm: number): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  const step = stepMm > 0 ? stepMm : 0.5;
  const steps = Math.max(1, Math.ceil(length / step));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    const cl = clSurface.dropCutter(x, y);
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
  const binSlope = new Float64Array(binCount).fill(Number.NaN);
  if (opts.mesh === undefined) {
    binSlope.fill(opts.region.slopeDeg[1]);
  } else {
    const { positions, indices } = opts.mesh;
    for (const t of opts.region.triangles) {
      const a = indices[t * 3]! * 3;
      const b = indices[t * 3 + 1]! * 3;
      const c = indices[t * 3 + 2]! * 3;
      const xs = [positions[a]!, positions[b]!, positions[c]!];
      const slope = triangleSlopeDeg(positions, a, b, c);
      const lo = Math.max(min[0], Math.min(...xs));
      const hi = Math.min(max[0], Math.max(...xs));
      const first = Math.floor((lo - min[0]) / BIN_MM);
      const last = Math.floor((hi - min[0]) / BIN_MM);
      for (let k = Math.max(0, first); k <= Math.min(binCount - 1, last); k++) {
        if (!(binSlope[k]! >= slope)) binSlope[k] = slope;
      }
    }
  }
  // #960 — AND THE CL SURFACE'S OWN SLOPE per bin, sampled from the surface the rows actually
  // follow: the ball's CL is what turns a cliff into a shoulder over the cutter's radius, so a
  // bin's triangle slopes alone under-read it. Both reads are kept, the steeper wins.
  {
    const h = 0.1;
    const ys = 5;
    const radius = profile.radiusMm;
    for (let k = 0; k < binCount; k++) {
      const xc = min[0] + (k + 0.5) * BIN_MM;
      let steepest = Number.isNaN(binSlope[k]!) ? 0 : binSlope[k]!;
      for (let s = 0; s < ys; s++) {
        const y = min[1] + ((s + 0.5) / ys) * (max[1] - min[1]);
        const z0 = opts.clSurface.dropCutter(xc, y);
        const zx = opts.clSurface.dropCutter(xc + h, y);
        const zy = opts.clSurface.dropCutter(xc, y + h);
        // #960 — A POCKET MOUTH inside the cutter's own reach: the ball rides the shoulders across
        // the opening, so any row over it leaves the mouth's depth standing and the rows' phase
        // decides how much. Those bands keep the old dense floor so nothing is lost.
        const zl = opts.clSurface.dropCutter(xc - radius, y);
        const zr = opts.clSurface.dropCutter(xc + radius, y);
        // A ball bridging a gap sits HIGHER than its neighbours (the CL is a local ridge over the
        // mouth); that ridge is the signature, not a left-right difference across the opening.
        if (zl !== null && zr !== null && z0 !== null && z0 - Math.max(zl, zr) > opts.scallopMm) steepest = 90;
        if (z0 === null || zx === null || zy === null) continue;
        const slope = (Math.atan(Math.hypot((zx - z0) / h, (zy - z0) / h)) * 180) / Math.PI;
        if (slope > steepest) steepest = slope;
      }
      binSlope[k] = steepest;
    }
  }
  // #960 — the band's slope is the STEEPEST within a small window: a cliff's cell lies in the next
  // bin along, and a row just off it meets the shoulder too. Without the window 2,411 tray cells
  // (0.17 %) read 0.10–0.17 mm of leftover they did not have at the old dense spacing.
  const WINDOW_BINS = 3;
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
  const flatRowStepMm = flatRasterStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1]);
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
  const joinMoves = (from: LinkPoint, to: LinkPoint, levelZ: number): ToolpathIR['operations'][number]['moves'] => {
    const direct = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const shortHop = DEFAULT_SHORT_HOP_DIAMETERS * 2 * toolRadius;
    if (direct <= shortHop + 1e-9 && ridesTheCl(from, to, opts.clSurface, linkSampleStep)) {
      // A DESCENDING LINK IS A CUT INTO LOWER GROUND: it runs at the plunge rate, the same rule
      // the op's own first feed follows (9e976f0b's finding — never a descent at the cutting rate).
      const f = to.z < from.z - 1e-9 ? opts.feeds.plungeFeedMmPerMin : opts.feeds.feedMmPerMin;
      return [{ kind: 'feed', x: to.x, y: to.y, z: to.z, f }];
    }
    return link(from, to, linkOptionsFor(levelZ));
  };

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];
  let prevExit: DroppedPoint | null = null;
  let prevLevelZ: number | null = null;

  // A raster row COLLINEAR with a polygon edge is the even-odd tracer's own blind spot: a vertical
  // edge at exactly x contributes no crossing by the half-open rule, so a hole on that line becomes
  // invisible and the row's interval spans straight across it — `dropRow` then refuses the null
  // midpoint between two valid ends ('a footprint notch'). The organizer's grown finish region hits
  // it on the real part: its offset lands vertical edges on exactly the raster's round x values.
  // The rows start a tenth of a micron off, far below the CL tolerance (0.005 mm), and the blind
  // spot is gone.
  for (const levelZ of levels) {
    // 1. COLLECT this level's admitted runs before the first move is posted. The raster's own
    //    order (row by row, run by run) is NOT the order the runs are cut in: where the mask
    //    admits sparse strips — the organizer's scoop rims and skirt — consecutive runs of one
    //    row can be a hundred millimetres apart, and the raster's order pays a full retract
    //    across the land between them (984 of them, 9,463 s, measured on #962).
    const levelRuns: DroppedPoint[][] = [];
    const levelCleared: Polygons = [];
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
        const clampedAll = row.map((p) => ({ ...p, z: Math.max(p.z, levelZ) }));

        // ITEM 4a — the row's points are cut only where the plan's mask admits them; each
        // contiguous admitted run is its own cut, and the gaps between runs are links.
        const runs: (typeof clampedAll)[] = [];
        if (opts.maskCells === undefined) {
          runs.push(clampedAll);
        } else {
          let current: typeof clampedAll = [];
          for (const p of clampedAll) {
            if (opts.maskCells(p.x, p.y)) current.push(p);
            else if (current.length > 0) { runs.push(current); current = []; }
          }
          if (current.length > 0) runs.push(current);
        }
        for (const clamped of runs) {
          if (clamped.length < 2) continue;
          levelRuns.push(clamped);
          levelCleared.push([[x, Math.min(rawY0, rawY1)], [x, Math.max(rawY0, rawY1)]]);
        }
      }
      if (!(stepOverMm > 1e-6)) break;
      x += stepOverMm;
    }
    cleared.push({ z: levelZ, boundary: levelCleared });

    // 2. ORDER the runs so consecutive passes are neighbours: nearest neighbour + 2-opt over the
    //    runs' midpoints, started from where the tool already is (#487's tour, the same primitive
    //    the pocket contours use). The raster's row parity used to alternate direction to make the
    //    turnarounds short; a tour subsumes that — and unlike the raster it can leave a row for
    //    the neighbouring strip on the next row and come back, which is where the crossings go.
    const midpoint = (run: DroppedPoint[]): [number, number] => {
      const a = run[0]!;
      const b = run[run.length - 1]!;
      return [(a.x + b.x) / 2, (a.y + b.y) / 2];
    };
    const fromXY: [number, number] = prevExit === null ? [min[0], min[1]] : [prevExit.x, prevExit.y];
    const order = tourNearest(levelRuns.map(midpoint), fromXY);

    // 3. EMIT in tour order; each run is entered at whichever of its ends is nearer the tool.
    for (const index of order) {
      let points = levelRuns[index]!;
      if (prevExit !== null) {
        const first = points[0]!;
        const last = points[points.length - 1]!;
        if (Math.hypot(last.x - prevExit.x, last.y - prevExit.y) < Math.hypot(first.x - prevExit.x, first.y - prevExit.y)) {
          points = [...points].reverse();
        }
      }
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

  return {
    ir,
    cutter: cutterKeyOf(opts.cutter),
    passes,
    cleared,
    ...(wallBandsCut === 0
      ? {}
      : {
          notes: [
            `${wallBandsCut} raster row(s) over walls steeper than ${WALL_SKIP_DEG}° ride at or below the cutter's own ${(opts.kind === 'flat-raster' ? 'flat' : 'ball')} floor (radius/10) rather than the scallop spacing — they are cut, not skipped`,
          ],
        }),
  };
}

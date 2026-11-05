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
import { estimateCycleSeconds, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import type { RemainderRegion, FeatureSource } from '../features';
import type { ClSurface } from '../clsurface';
import { profileOf } from '../dropcutter';
import { link, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
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
  // the region's own triangles; each raster row advances by the step its own band's slope asks
  // for. A band steeper than `WALL_SKIP_DEG` is a wall, not a raster target: it is skipped and
  // counted, never allowed to shrink every other band's step.
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
  const bandSlopeAt = (x: number): number => {
    const k = Math.min(binCount - 1, Math.max(0, Math.floor((x - min[0]) / BIN_MM)));
    const v = binSlope[k]!;
    return Number.isNaN(v) ? 0 : v;
  };
  const stepOverAt = (x: number): number =>
    opts.kind === 'ball-scallop'
      ? ballScallopStepOver(profile.radiusMm, opts.scallopMm, bandSlopeAt(x))
      : flatRasterStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1]);
  let wallBandsSkipped = 0;

  // The field is honest about only the level just FINISHED (rough.ts's own reasoning): capped at
  // that level's own Z, never the level about to start, so a link is never approved through a
  // deeper target this op has not actually reached yet. Outside the footprint the field states
  // nothing (`+Infinity`), so a link endpoint off the region's own edge always retracts.
  const materialFor = (levelZ: number): MaterialField => ({
    topAt: (x, y) => {
      if (!pointInPolygons(opts.region.footprint, x, y)) return Number.POSITIVE_INFINITY;
      const cl = opts.clSurface.dropCutter(x, y);
      if (cl === null) return Number.POSITIVE_INFINITY;
      return Math.max(levelZ, cl);
    },
  });
  const linkOptionsFor = (levelZ: number): LinkOptions => ({
    material: materialFor(levelZ),
    clearanceZ: opts.regionRef.regionClearanceZ,
    tool: { radiusMm: toolRadius },
    feeds: { feed: opts.feeds.feedMmPerMin, plungeFeed: opts.feeds.plungeFeedMmPerMin },
  });

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];
  let prevExit: DroppedPoint | null = null;
  let prevLevelZ: number | null = null;
  let rowParity = 0;

  // A raster row COLLINEAR with a polygon edge is the even-odd tracer's own blind spot: a vertical
  // edge at exactly x contributes no crossing by the half-open rule, so a hole on that line becomes
  // invisible and the row's interval spans straight across it — `dropRow` then refuses the null
  // midpoint between two valid ends ('a footprint notch'). The organizer's grown finish region hits
  // it on the real part: its offset lands vertical edges on exactly the raster's round x values.
  // The rows start a tenth of a micron off, far below the CL tolerance (0.005 mm), and the blind
  // spot is gone.
  const X_NUDGE_MM = 1e-4;
  for (const levelZ of levels) {
    const levelCleared: Polygons = [];
    for (let x = min[0] + X_NUDGE_MM; x <= max[0]; ) {
      // #960 — A WALL BAND STILL GETS CUT. Skipping it lost coverage (the organizer fell 10 points):
      // a raster row there is dense rather than absent, at the same radius/10 floor the old read
      // applied to the WHOLE region. Only the bands that are not walls gain the vendor spacing.
      const stepOverMm = opts.kind === 'ball-scallop' && bandSlopeAt(x) >= WALL_SKIP_DEG ? profile.radiusMm / 10 : stepOverAt(x);
      x += stepOverMm;
      if (stepOverMm <= 1e-6) break;
      const intervals = footprintColumnIntervals(opts.region.footprint, x);
      const ordered = rowParity % 2 === 0 ? intervals : [...intervals].reverse();
      for (const interval of ordered) {
        const [rawY0, rawY1] = rowParity % 2 === 0 ? interval : [interval[1], interval[0]];
        // Inset off the footprint's own boundary, a hair, toward the interval's own centre: an
        // endpoint landing EXACTLY on the polygon edge is where `pointInPolygons`' ray-casting is
        // ambiguous by convention (`clSurface`'s own gate), not a real gap — advisor's review.
        const insetY0 = rawY0 + Math.sign(rawY1 - rawY0) * FOOTPRINT_EDGE_INSET_MM;
        const insetY1 = rawY1 - Math.sign(rawY1 - rawY0) * FOOTPRINT_EDGE_INSET_MM;
        if (Math.abs(insetY1 - insetY0) <= 1e-9 || (insetY1 - insetY0) * (rawY1 - rawY0) < 0) continue; // the interval is narrower than the inset: nothing to cut
        const row = dropRow(opts.clSurface, [x, insetY0], [x, insetY1]);
        const clamped = row.map((p) => ({ ...p, z: Math.max(p.z, levelZ) }));

        const entryPoint: LinkPoint = { x: clamped[0]!.x, y: clamped[0]!.y, z: clamped[0]!.z };
        if (prevExit === null) {
          // The row's own FIRST feed is a PLUNGE (straight down from the hop height into
          // material), never at the cutting feed — the same bug 9e976f0b fixed in `ops/pocket.ts`.
          moves.push({ kind: 'rapid', x: entryPoint.x, y: entryPoint.y, z: opts.hopZMm });
          moves.push({ kind: 'feed', x: entryPoint.x, y: entryPoint.y, z: entryPoint.z, f: opts.feeds.plungeFeedMmPerMin });
        } else {
          const from: LinkPoint = { x: prevExit.x, y: prevExit.y, z: prevExit.z };
          moves.push(...link(from, entryPoint, linkOptionsFor(prevLevelZ ?? prevExit.z)));
        }
        for (let i = 1; i < clamped.length; i++) {
          moves.push({ kind: 'feed', x: clamped[i]!.x, y: clamped[i]!.y, z: clamped[i]!.z, f: opts.feeds.feedMmPerMin });
        }
        const entry: [number, number, number] = [clamped[0]!.x, clamped[0]!.y, clamped[0]!.z];
        const exitPoint = clamped[clamped.length - 1]!;
        const exit: [number, number, number] = [exitPoint.x, exitPoint.y, exitPoint.z];
        passes.push({
          z: levelZ,
          boundary: [clamped.map((p) => [p.x, p.y] as [number, number])],
          cleared: { z: levelZ, boundary: [[entry.slice(0, 2) as [number, number], exit.slice(0, 2) as [number, number]]] },
          entry,
          exit,
        });
        levelCleared.push([[x, Math.min(rawY0, rawY1)], [x, Math.max(rawY0, rawY1)]]);
        prevExit = exitPoint;
        prevLevelZ = levelZ;
        rowParity++;
      }
    }
    cleared.push({ z: levelZ, boundary: levelCleared });
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
    ...(wallBandsSkipped === 0
      ? {}
      : {
          notes: [
            `${wallBandsSkipped} raster band(s) over walls steeper than ${WALL_SKIP_DEG}° ride at the cutter's own ${(opts.kind === 'flat-raster' ? 'flat' : 'ball')} floor (radius/10) rather than the scallop spacing — they are cut, not skipped`,
          ],
        }),
  };
}

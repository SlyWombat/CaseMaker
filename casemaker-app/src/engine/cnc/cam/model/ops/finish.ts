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
import type { RemainderRegion } from '../features';
import type { ClSurface } from '../clsurface';
import { profileOf } from '../dropcutter';
import { DEFAULT_SHORT_HOP_DIAMETERS, link, type LinkOptions, type LinkPoint, type MaterialField } from '../linking';
import { followCutSurface } from '../rideTest';
import { dropRow, type DroppedPoint } from '../rowDropper';
import { cutterKeyOf } from '../sequence';
import type { OpOutcome, PassRef, RegionAtZ, RegionRef } from '../plan';

export type FinishKind = 'flat-raster' | 'ball-scallop';

// A hair off the footprint's own boundary (see `footprintColumnIntervals`'s own call site below) —
// smaller than any real raster step-over, so it costs nothing real, but keeps every `dropRow`
// endpoint safely INSIDE the footprint, never exactly on an edge.
const FOOTPRINT_EDGE_INSET_MM = 1e-4;

export interface FinishOpOptions {
  cutter: Tool;
  region: RemainderRegion;
  regionRef: RegionRef;
  clSurface: ClSurface;
  /** The flat-vs-ball slope classification (C's per-slice minimum) — the admissible angle test that picks `kind`. */
  kind: FinishKind;
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
  const stepOverMm =
    opts.kind === 'ball-scallop'
      ? ballScallopStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1])
      : flatRasterStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1]);

  const levels = depthLevels(opts.region.zTop, opts.region.zBottom, opts.stepDownMm);
  const { min, max } = opts.regionRef.bounds;

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
    // #962 — THE DIP-FOLLOWING LINK: the chord dipped below the CL (concave ground). FOLLOW the CL
    // instead — the ball cuts the bulge exactly as the passes either side of it do, so nothing is
    // gouged below the design — but only when the path is provably clear all the way and the
    // follow is FASTER than the retract it replaces (the time guard; the earlier pricing showed a
    // stay-down feed only wins inside ~25-30 mm, and this branch's joins are far shorter).
    const follow = followCutSurface(from, to, (x, y) => opts.clSurface.dropCutter(x, y), linkSampleStep, levelZ, opts.feeds, opts.rapid, opts.regionRef.regionClearanceZ);
    if (follow !== null) return follow;
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
  const X_NUDGE_MM = 1e-4;
  for (const levelZ of levels) {
    // 1. COLLECT this level's admitted runs before the first move is posted. The raster's own
    //    order (row by row, run by run) is NOT the order the runs are cut in: where the mask
    //    admits sparse strips — the organizer's scoop rims and skirt — consecutive runs of one
    //    row can be a hundred millimetres apart, and the raster's order pays a full retract
    //    across the land between them (984 of them, 9,463 s, measured on #962).
    const levelRuns: DroppedPoint[][] = [];
    const levelCleared: Polygons = [];
    for (let x = min[0] + X_NUDGE_MM; x <= max[0] + stepOverMm * 1e-6; x += stepOverMm) {
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
    }
    cleared.push({ z: levelZ, boundary: levelCleared });

    // 2. ORDER the runs so consecutive passes are neighbours, WITH A CONNECTIVITY CONSTRAINT
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

    // 3. EMIT in tour order, each run entered at the end the tour chose.
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

  return { ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}

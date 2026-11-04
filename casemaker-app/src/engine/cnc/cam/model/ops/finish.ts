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
 * LINKING is the plain retract/rapid/plunge every op used before `link()` was wired in (#962's own
 * stay-down integration is named, not assumed, here — the manager's ruling on footprint vs links
 * is #960's own next wiring step, read `rowDropper.ts`'s own header first): correct, never a
 * cutting move across unplanned ground, but not yet stay-down between rows or footprint intervals.
 */

import { cuttingDiameter, type Tool } from '@/engine/cnc/tool';
import { estimateCycleSeconds, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import type { RemainderRegion } from '../features';
import type { ClSurface } from '../clsurface';
import { profileOf } from '../dropcutter';
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
  return cosTheta * 2 * Math.sqrt(Math.max(0, 2 * radiusMm * bandPrime - bandPrime * bandPrime));
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
  const stepOverMm =
    opts.kind === 'ball-scallop'
      ? ballScallopStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1])
      : flatRasterStepOver(profile.radiusMm, opts.scallopMm, opts.region.slopeDeg[1]);

  const levels = depthLevels(opts.region.zTop, opts.region.zBottom, opts.stepDownMm);
  const { min, max } = opts.regionRef.bounds;

  const moves: ToolpathIR['operations'][number]['moves'] = [];
  const passes: PassRef[] = [];
  const cleared: RegionAtZ[] = [];
  let prevExit: DroppedPoint | null = null;
  let rowParity = 0;

  for (const levelZ of levels) {
    const levelCleared: Polygons = [];
    for (let x = min[0]; x <= max[0] + stepOverMm * 1e-6; x += stepOverMm) {
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

        if (prevExit === null) {
          moves.push({ kind: 'rapid', x: clamped[0]!.x, y: clamped[0]!.y, z: opts.hopZMm });
        } else {
          // Retract to the REGION's own clearance plane, not a bare `hopZMm` — C's point 3
          // ruling (`RegionRef.regionClearanceZ`'s own doc) is the height that clears every
          // obstacle THIS region's own fixture reaches, same convention `ops/pocket.ts` uses.
          // Retract to the REGION's own clearance plane, not a bare `hopZMm` — C's point 3
          // ruling (`RegionRef.regionClearanceZ`'s own doc) is the height that clears every
          // obstacle THIS region's own fixture reaches, same convention `ops/pocket.ts` uses.
          moves.push({ kind: 'rapid', x: prevExit.x, y: prevExit.y, z: opts.regionRef.regionClearanceZ });
          moves.push({ kind: 'rapid', x: clamped[0]!.x, y: clamped[0]!.y, z: opts.regionRef.regionClearanceZ });
          moves.push({ kind: 'rapid', x: clamped[0]!.x, y: clamped[0]!.y, z: opts.hopZMm });
        }
        // The row's own FIRST feed is a PLUNGE (straight down from the hop height into material),
        // never at the cutting feed — the same bug 9e976f0b fixed in `ops/pocket.ts`; every move
        // after it is lateral, at the ordinary cutting feed.
        moves.push({ kind: 'feed', x: clamped[0]!.x, y: clamped[0]!.y, z: clamped[0]!.z, f: opts.feeds.plungeFeedMmPerMin });
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

  return { ir, cutter: cutterKeyOf(opts.cutter), passes, cleared };
}

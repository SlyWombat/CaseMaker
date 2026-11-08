/**
 * cam/surfaceFinishTipField.ts — the gouge-safe ball/flat finishing tip-field and its boustrophedon
 * raster, extracted from `surface3d.ts` (#966) as a PURE MOVE: same code, same behaviour, no
 * tolerance or constant changed.
 *
 * This is NOT part of the old heightfield engine's own PLANNING (`generateSurface3dIR`/
 * `generateSurface3dForGoal`, both retired by #966) — it is shared, general-purpose drop-cutter
 * machinery that `rotaryRelief.ts`'s own CAM-over-the-field stage (R-2) still depends on directly
 * (`finishTipField`, `finishingMoves`, `DEFAULT_MAX_FINISH_TIP_OPS`, `DEFAULT_STOCK_TO_LEAVE_MM`,
 * `SurfaceTool`, `SurfaceFeeds`) — rotary relief is its own goal class, explicitly out of #966's
 * scope (design note §8), so this module has to survive the old engine's removal intact.
 *
 * `cam/model/**` never imports this module — it has its own CL-surface/dropcutter machinery
 * (`cam/model/dropcutter.ts`, `cam/model/clsurface.ts`); `tests/unit/gateImports.spec.ts` pins
 * that boundary the same way it already pins every other independence rule in this tree.
 */

import { MoveStore } from './moveStore';
import type { CamMove } from './ir';
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

/** The roughing allowance when the caller states none, mm — labelled, not measured (slice F). */
export const DEFAULT_STOCK_TO_LEAVE_MM = 0.3;

/**
 * The finishing tip-field compute budget (#540): the ball drop is O(covered cells × disc-stencil
 * cells), so a large ball on a fine grid is billions of inner-loop ops with no cutoff — enough to
 * hang the worker. Above this cap {@link finishTipField} REFUSES honestly (it states the op count
 * and the fix), mirroring the exact sweep's `sweep-budget-exceeded` rather than running to a hang.
 * 300 M evaluations is comfortably past any real small-ball/coarse-grid job yet well under the
 * ~2.8 billion a 3 mm ball at 0.1 mm over a near-cap grid would cost.
 */
export const DEFAULT_MAX_FINISH_TIP_OPS = 300_000_000;

export interface SurfaceTool {
  /** Cutting radius at the tip, mm. */
  radius: number;
  /**
   * A hemispherical tip of {@link radius} (a ball nose). The finishing drop is gouge-safe for it;
   * a flat tool (`false`) drops onto the highest point under its disc, which cannot enter a
   * concavity — a flat finish of a 3D surface is a fallback the notes flag.
   */
  ball: boolean;
}

/**
 * The feeds a surfacing program runs at — the job's ordinary 2.5D feeds, HANDED IN unchanged.
 * NONE of these is tuned for 3D engagement (slice F, #536); the module labels them and never
 * invents one.
 */
export interface SurfaceFeeds {
  /** XY cutting feed, mm/min. */
  feed: number;
  /** Z plunge feed, mm/min. */
  plungeFeed: number;
  /** Roughing step-down per Z layer, mm. */
  stepDown: number;
  /** Roughing raster pitch between scan lines, mm. */
  roughStepOver: number;
  /** Finishing raster pitch between scan lines, mm. */
  finishStepOver: number;
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
 * #1087 — THE RULE'S ONE HOME. The model plan's finish and the rotary relief's finish both hold a
 * cusp promise, so the helper moved here (from `cam/model/ops/finish`) rather than being copied:
 * one rule, two engines. The relief passes zero slopes — its rows step around the stock and the
 * surface between two adjacent rows of a turned part is flat in that direction, so the flat
 * sagitta is the promise there.
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

/**
 * #909 — THE DISTANCE FROM A POINT TO A GRID CELL'S SQUARE. A cell is a `pitch`-wide square
 * centred on its sample; the cutter reaches the cell when its disc reaches any part of that
 * square, so the distance measured is to the square's NEAREST point (0 inside it). Measuring to the
 * centre instead put a knife edge at the disc's rim, where the ball's flank is steepest.
 */
function cellSquareDistance(dx: number, dy: number, pitch: number): number {
  const ex = Math.max(0, Math.abs(dx) - pitch / 2);
  const ey = Math.max(0, Math.abs(dy) - pitch / 2);
  return Math.hypot(ex, ey);
}

/** The height a ball of `radius` rises above its tip at radial distance `d` (0 for a flat tool). */
function ballRise(ball: boolean, radius: number, d: number): number {
  if (!ball || radius <= 0) return 0;
  if (d >= radius) return radius;
  return radius - Math.sqrt(radius * radius - d * d);
}

function coveredRuns(hf: GoalHeightfield, j: number, only?: Uint8Array | null): [number, number][] {
  const { nx, covered } = hf;
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < nx; i++) {
    const on = covered[j * nx + i] === 1 && (only === undefined || only === null || only[j * nx + i] === 1);
    if (on && start === -1) start = i;
    else if (!on && start !== -1) {
      runs.push([start, i - 1]);
      start = -1;
    }
  }
  if (start !== -1) runs.push([start, nx - 1]);
  return runs;
}

/** Rows to raster, from j = 0 upward, spaced by `stepOver` (at least every row). */
function rasterRows(hf: GoalHeightfield, stepOver: number): number[] {
  const stride = Math.max(1, Math.round(stepOver / hf.pitch));
  const rows: number[] = [];
  for (let j = 0; j < hf.ny; j += stride) rows.push(j);
  if (rows.length > 0 && rows[rows.length - 1] !== hf.ny - 1) rows.push(hf.ny - 1);
  return rows;
}

/** X sample columns across a run, spaced by `alongStep` (always including both ends). */
function alongColumns(
  hf: GoalHeightfield,
  iStart: number,
  iEnd: number,
  alongStep: number,
  only?: Uint8Array | null,
  j?: number,
): number[] {
  const stride = Math.max(1, Math.round(alongStep / hf.pitch));
  const cols: number[] = [];
  for (let i = iStart; i <= iEnd; i += stride) {
    if (only !== undefined && only !== null && j !== undefined && only[j * hf.nx + i] !== 1) continue;
    cols.push(i);
  }
  if (only === undefined || only === null) {
    if (cols.length === 0 || cols[cols.length - 1] !== iEnd) cols.push(iEnd);
  } else if (j !== undefined) {
    // A masked run's ends are its own mask's ends; add them when the stride skipped them.
    if (only[j * hf.nx + iStart] === 1 && !cols.includes(iStart)) cols.unshift(iStart);
    if (only[j * hf.nx + iEnd] === 1 && !cols.includes(iEnd)) cols.push(iEnd);
  }
  return cols;
}

/**
 * The gouge-safe tip field: the tool dropped onto the heightfield until it just touches.
 *
 * #723 — `wrapRows` reads the field's ROW axis as a cylinder's circumference (the rotary map):
 * the stencil wraps modulo `ny` instead of treating the off-grid neighbours as uncut stock, so a
 * pass on the first (or last) row is not lifted to the stock's surface by the seam. The COLUMN
 * axis keeps the flat rule — beyond the sampled X range the stock really does continue.
 */
export function finishTipField(
  hf: GoalHeightfield,
  tool: SurfaceTool,
  maxOps: number,
  opts: { wrapRows?: boolean } = {},
): Float32Array {
  const { nx, ny, z, covered, pitch, topZ } = hf;
  const tip = new Float32Array(nx * ny);
  tip.fill(topZ);
  const span = Math.max(0, Math.ceil(tool.radius / pitch));
  // Precompute the disc stencil: every CELL the tool's disc reaches, and the ball rise at the
  // cell's NEAREST POINT (#909). A cell is a square, not a point: measuring to its centre made the
  // knife edge at the rim — a wall cell one radius away flipped in and out on float noise, and on a
  // ball's flank that is several millimetres of either clamp or gouge.
  const stencil: { di: number; dj: number; rise: number }[] = [];
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const d = cellSquareDistance(di * pitch, dj * pitch, pitch);
      if (d > tool.radius) continue;
      stencil.push({ di, dj, rise: ballRise(tool.ball, tool.radius, d) });
    }
  }
  if (stencil.length === 0) stencil.push({ di: 0, dj: 0, rise: 0 });
  // #540 — the inner drop runs the stencil at every covered cell. Bound that work BEFORE the loop:
  // a large ball on a fine grid is billions of ops that would hang the worker. Over budget, refuse
  // honestly (stating the op count and the way out), as the exact sweep raises sweep-budget-exceeded.
  const ops = hf.coveredCount * stencil.length;
  if (ops > maxOps) {
    throw new Error(
      `3D finishing would need ${ops} tip evaluations (${hf.coveredCount} covered cells × ` +
        `${stencil.length} stencil cells for a ${(tool.radius * 2).toFixed(2)} mm cutter at a ` +
        `${pitch.toFixed(4)} mm grid), over the ${maxOps} budget. Use a coarser grid (a larger flat ` +
        `pitch) or a smaller ball so the finishing pass fits the budget.`,
    );
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      if (covered[idx] === 0) continue;
      // The lowest tip that keeps every point of the tool at or above the surface under it:
      // max over the disc of (surface height - the ball's rise there).
      let best = -Infinity;
      for (const s of stencil) {
        const ii = i + s.di;
        const rawJ = j + s.dj;
        if (ii < 0 || ii >= nx) {
          // Off the grid in X is uncut stock at the top face — the tool rides on it.
          best = Math.max(best, topZ - s.rise);
          continue;
        }
        if (opts.wrapRows === true) {
          const jj = ((rawJ % ny) + ny) % ny;
          best = Math.max(best, (z[jj * nx + ii] as number) - s.rise);
          continue;
        }
        if (rawJ < 0 || rawJ >= ny) {
          best = Math.max(best, topZ - s.rise);
          continue;
        }
        best = Math.max(best, (z[rawJ * nx + ii] as number) - s.rise);
      }
      tip[idx] = best;
    }
  }
  return tip;
}

/**
 * #889 — the level leg between two points whose Z gap is steeper than their lateral travel (a
 * straight diagonal there is NOT drop-cutter-safe along the way: the sim only checks the two
 * endpoints, and the straight line between them can pass under a surface either point's own XY
 * footprint never saw — a crevice between a figure's legs, a contour crossing a step's edge, a
 * crease running down one). Each point's OWN z is already its own drop-cutter-safe value for its
 * footprint, so a corner at the HIGHER of the two — level first at that z, then straight down to
 * the lower point (or straight up at the current xy, then level) — never goes below either
 * point's own verified-safe height along the way; the level leg's own clearance error is the
 * chord sagitta, step²/(8·r), negligible against the cutter. Below slope 1 the single diagonal
 * stays (its interpolation error is smaller still, inside the overcut guard's own skin
 * tolerance). Null below slope 1 or when the two points coincide in XY (a pure plunge/retract,
 * already vertical).
 */
function staircaseCorner(
  prevX: number,
  prevY: number,
  prevZ: number,
  x: number,
  y: number,
  z: number,
): { x: number; y: number; z: number } | null {
  const lateral = Math.hypot(x - prevX, y - prevY);
  if (!(lateral > 0) || Math.abs(z - prevZ) <= lateral) return null;
  return z <= prevZ ? { x, y, z: prevZ } : { x: prevX, y: prevY, z };
}

/**
 * BALL-NOSE FINISHING raster (stage 2b). The tool follows the gouge-safe tip field in boustrophedon
 * scan lines spaced by the finishing step-over, sampled along each line at `alongStep` so the dexel
 * sim of the result tracks the goal within the step-over and the grid pitch.
 */
export function finishingMoves(
  hf: GoalHeightfield,
  tip: Float32Array,
  feeds: SurfaceFeeds,
  alongStep: number,
  safeZ: number,
  hopZ: number,
  /** #785 — called once per scan line, before it is cut (`done` counts from 1). */
  onRow?: (done: number, total: number) => void,
  /**
   * #847 — cut ONLY where this mask says (a rest pass over the finish's residual), dilated by the
   * rest ball's radius before it is handed in. Absent: every covered cell, as the finish does.
   */
  only?: Uint8Array | null,
  /**
   * #889 — merge collinear feeds within this distance, mm (see `MoveStore`). Absent: 0, every
   * sample its own move — the rotary relief's reading, which wraps the moves after.
   */
  mergeToleranceMm = 0,
): CamMove[] {
  // #889 — packed, as the roughing is.
  const moves = new MoveStore({ mergeToleranceMm });
  if (hf.coveredCount === 0) return moves.view();
  const { pitch, x0, y0 } = hf;
  const rows = rasterRows(hf, feeds.finishStepOver).filter(
    (j) => only === undefined || only === null || only.subarray(j * hf.nx, (j + 1) * hf.nx).some((v) => v === 1),
  );
  let flip = false;
  for (const [index, j] of rows.entries()) {
    onRow?.(index + 1, rows.length);
    const y = y0 + j * pitch;
    for (const [iS, iE] of coveredRuns(hf, j, only)) {
      const cols = alongColumns(hf, iS, iE, alongStep, only, j);
      const ordered = flip ? [...cols].reverse() : cols;
      let open = false;
      let prevX = 0;
      let prevY = 0;
      let prevZ = 0;
      for (const i of ordered) {
        const x = x0 + i * pitch;
        const z = tip[j * hf.nx + i] as number;
        if (!open) {
          moves.rapid(x, y, hopZ);
          moves.feed(x, y, z, feeds.plungeFeed);
          open = true;
        } else {
          const corner = staircaseCorner(prevX, prevY, prevZ, x, y, z);
          if (corner !== null) moves.feed(corner.x, corner.y, corner.z, feeds.feed);
          moves.feed(x, y, z, feeds.feed);
        }
        prevX = x;
        prevY = y;
        prevZ = z;
      }
      if (open) moves.rapid(moves.lastX(), moves.lastY(), hopZ);
    }
    flip = !flip;
  }
  if (moves.length > 0) moves.rapid(moves.lastX(), moves.lastY(), safeZ);
  return moves.view();
}

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
import { isPlunge } from './printedZ';

// #1092 (0f's land14 ruling) — the drop-cutter tip primitive now lives in the neutral
// `cam/dropTip.ts`; this module keeps its name and public surface and re-exports it. The fast
// flat dilation's own unit and row count travel with it, so the plan's budget statement and the
// field's check read one definition.
export {
  finishTipField,
  DEFAULT_MAX_FINISH_TIP_OPS,
  DEFAULT_MAX_FINISH_TIP_ROW_OPS,
  discRowCountFor,
  maxTipOpsFor,
  stencilCellsFor,
  tipFieldOpsFor,
} from './dropTip';
export type { SurfaceTool } from './dropTip';

/** The roughing allowance when the caller states none, mm — labelled, not measured (slice F). */
export const DEFAULT_STOCK_TO_LEAVE_MM = 0.3;



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
  // #1214's ruling (b) — the descent test is the posted-grid one: a Z change that alters no
  // printed digit is not a descent. Both branches post the same corner Z there; the corner
  // squared is the only difference.
  return isPlunge(prevZ, z) ? { x, y, z: prevZ } : { x: prevX, y: prevY, z };
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

/**
 * cam/dropTip.ts — THE DROP-CUTTER TIP FIELD, a neutral primitive (#1092, 0f's ruling on land14).
 *
 * Extracted from `surfaceFinishTipField.ts` as a PURE MOVE: the stencil build
 * (`cellSquareDistance` + `ballRise`), the per-cell max over the disc, the `wrapRows` option and
 * the op budget. It imports nothing from `cam/model/**` and nothing from the gate's own modules —
 * only the `GoalHeightfield` TYPE (erased at compile time) — so `cam/model/plan.ts` may use it
 * without crossing `gateImports.spec`'s boundary: the rest rule must read the goal's own
 * drop-surface, and the old-engine-era raster module is not the place that primitive lives.
 *
 * `surfaceFinishTipField.ts` keeps its name and its public exports, re-exporting these.
 */

import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

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
 * #909 — THE DISTANCE FROM A POINT TO A GRID CELL'S SQUARE. A cell is a `pitch`-wide square
 * centred on its sample; the cutter reaches the cell when its disc reaches any part of that
 * square, so the distance measured is to the square's NEAREST point (0 inside it). Measuring to the
 * centre instead put a knife edge at the disc's rim, where the ball's flank is steepest.
 */
/** The number of grid cells a cutter of `radius` reaches from one position: the stencil's length,
 *  which is what makes the tip field O(covered cells × this). Exported for #1092's per-region
 *  budget estimate, so the plan and the field cannot disagree about the count. */
export function stencilCellsFor(radius: number, pitch: number): number {
  const span = Math.max(0, Math.ceil(radius / pitch));
  let n = 0;
  for (let dj = -span; dj <= span; dj++) {
    for (let di = -span; di <= span; di++) {
      const ex = Math.max(0, Math.abs(di * pitch) - pitch / 2);
      const ey = Math.max(0, Math.abs(dj * pitch) - pitch / 2);
      if (Math.hypot(ex, ey) <= radius) n++;
    }
  }
  return Math.max(1, n);
}

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

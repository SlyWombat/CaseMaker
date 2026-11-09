/**
 * cam/dropTip.ts — THE DROP-CUTTER TIP FIELD, a neutral primitive (#1092, 0f's rulings on land14
 * and on the budget).
 *
 * Extracted from `surfaceFinishTipField.ts` as a PURE MOVE: the stencil build
 * (`cellSquareDistance` + `ballRise`), the per-cell max over the disc, the `wrapRows` option and
 * the op budget. It imports nothing from `cam/model/**` and nothing from the gate's own modules —
 * only the `GoalHeightfield` TYPE (erased at compile time) — so `cam/model/plan.ts` may use it
 * without crossing `gateImports.spec`'s boundary: the rest rule must read the goal's own
 * drop-surface, and the old-engine-era raster module is not the place that primitive lives.
 *
 * `surfaceFinishTipField.ts` keeps its name and its public exports, re-exporting these.
 *
 * #1092 (0f's ruling, 2026-11-09) — THE FLAT DILATION IS EXACT AND ROW-SEPARABLE. The tip field is
 * a grey-scale dilation: each cell's tip is the max of the surface minus the tool's rise over the
 * disc. For a FLAT tool the rise is zero and, for one disc row offset `dj`, the reach along the
 * row is a single contiguous interval of `di` (the cell-square distance grows monotonically with
 * |di|). That makes each row a SLIDING-WINDOW MAXIMUM — van Herk / Gil-Werman, O(1) amortised per
 * cell per row — so the flat field costs O(grid cells × rows in the disc), 33 rows for a ⌀3.175
 * flat at 0.1 mm instead of the 853-cell stencil, and is BIT-identical: max is order-independent
 * and both paths take the max of the same finite set of float32 values. The BALL keeps the stencil
 * path until 0f asks for its (concave-kernel) fast form; its budget unit is unchanged.
 */

import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

/**
 * The finishing tip-field compute budget (#540): the field's own work, counted in the unit its
 * algorithm uses. For a BALL it is COVERED CELLS × DISC-STENCIL CELLS (the brute drop); for a FLAT
 * it is GRID CELLS × ROWS IN THE DISC (the exact dilation). The two numbers are calibrated to the
 * SAME wall-clock ceiling: the measured cost is ~5 ns per ball stencil evaluation and ~11.5 ns per
 * flat cell-row, so 300 M stencil units and 150 M row units are both about 1.5 s — "billions of
 * inner-loop ops with no cutoff" remains the thing being prevented, whichever unit counts it.
 * Above the cap {@link finishTipField} REFUSES honestly (it states the op count and the fix),
 * mirroring the exact sweep's `sweep-budget-exceeded` rather than running to a hang.
 */
export const DEFAULT_MAX_FINISH_TIP_OPS = 300_000_000;

/** #1092 — the FLAT dilation's ceiling, in its own unit (grid cells × rows in the disc). */
export const DEFAULT_MAX_FINISH_TIP_ROW_OPS = 150_000_000;

/** The budget a tool's unit is measured against — one place, so callers cannot pair a unit with
 *  the other path's number. */
export function maxTipOpsFor(tool: SurfaceTool): number {
  return tool.ball ? DEFAULT_MAX_FINISH_TIP_OPS : DEFAULT_MAX_FINISH_TIP_ROW_OPS;
}

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
 *  which is what makes the BALL tip field O(covered cells × this). Exported for #1092's budget
 *  estimate, so the plan and the field cannot disagree about the count. */
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

/**
 * #1092 (0f's ruling) — THE NUMBER OF DISC ROWS with a non-empty reach at this pitch: the flat
 * dilation's cost per grid cell (its unit). Rows are counted with the SAME cell-square predicate
 * the stencil uses, so the plan's budget estimate and the field's own loop cannot disagree; a
 * ⌀3.175 flat at 0.1 mm is 33 rows (against the 853-cell stencil).
 */
export function discRowCountFor(radius: number, pitch: number): number {
  const { half } = discHalfWidths(radius, pitch);
  let rows = 0;
  for (let k = 0; k < half.length; k++) if (half[k]! >= 0) rows++;
  return Math.max(1, rows);
}

/**
 * #1092 — THE FIELD'S OWN WORK IN ITS ALGORITHM'S UNIT, shared by the plan's budget statement and
 * {@link finishTipField}'s check so the two can never disagree: a flat field is GRID CELLS × ROWS
 * IN THE DISC (exact dilation), a ball field is COVERED CELLS × STENCIL CELLS (the brute drop).
 */
export function tipFieldOpsFor(
  tool: SurfaceTool,
  nx: number,
  ny: number,
  coveredCount: number,
  pitch: number,
): number {
  if (tool.ball) return coveredCount * stencilCellsFor(tool.radius, pitch);
  return nx * ny * discRowCountFor(tool.radius, pitch);
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
 * The per-row half-widths of the disc: for disc row offset `dj`, the reach is the symmetric
 * interval [−w, w] of column offsets with a non-empty cell-square distance, −1 when the row is
 * not reached at all. Computed by REPLAYING the stencil's own predicate (never a closed form), so
 * the flat dilation's set is bit-for-bit the stencil's set.
 */
function discHalfWidths(radius: number, pitch: number): { span: number; half: Int32Array } {
  const span = Math.max(0, Math.ceil(radius / pitch));
  const half = new Int32Array(2 * span + 1).fill(-1);
  for (let dj = -span; dj <= span; dj++) {
    let w = -1;
    for (let di = 0; di <= span; di++) {
      if (cellSquareDistance(di * pitch, dj * pitch, pitch) <= radius) w = di;
    }
    half[dj + span] = w;
  }
  return { span, half };
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
  return tool.ball ? finishTipFieldStencil(hf, tool, maxOps, opts) : finishTipFieldFlat(hf, tool, maxOps, opts);
}

/** The disc-stencil drop (the ball's, and the reference the flat dilation is pinned against). */
function finishTipFieldStencil(
  hf: GoalHeightfield,
  tool: SurfaceTool,
  maxOps: number,
  opts: { wrapRows?: boolean },
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
  const ops = tipFieldOpsFor(tool, nx, ny, hf.coveredCount, pitch);
  if (ops > maxOps) {
    throw new Error(
      `3D finishing would need ${ops} tip evaluations (${hf.coveredCount} covered cells × ` +
        `${stencil.length} stencil cells for a ${(tool.radius * 2).toFixed(2)} mm ball at a ` +
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
 * #1092 (0f's ruling) — THE EXACT FLAT DILATION. For each disc row `dj`, a sliding-window maximum
 * of half-width `w` (van Herk / Gil-Werman: block prefix/suffix maxima, O(1) per cell) gives the
 * row's best over its interval; the tip is the max over rows. Out-of-grid X and rows are the stock
 * top, exactly as the stencil treats them; uncovered cells keep `topZ`, never touched.
 */
function finishTipFieldFlat(
  hf: GoalHeightfield,
  tool: SurfaceTool,
  maxOps: number,
  opts: { wrapRows?: boolean },
): Float32Array {
  const { nx, ny, z, covered, pitch, topZ } = hf;
  const { span, half } = discHalfWidths(tool.radius, pitch);
  let rows = 0;
  let maxW = 0;
  for (let k = 0; k < half.length; k++) {
    const w = half[k]!;
    if (w >= 0) {
      rows++;
      if (w > maxW) maxW = w;
    }
  }
  const ops = nx * ny * rows;
  if (ops > maxOps) {
    throw new Error(
      `The flat rest's drop-tip field would need ${ops} tip evaluations (${nx * ny} grid cells × ` +
        `${rows} rows in the disc for a ${(tool.radius * 2).toFixed(2)} mm flat at a ` +
        `${pitch.toFixed(4)} mm grid), over the ${maxOps} budget. Coarsen the goal grid, narrow the ` +
        `region, or use a larger rest cutter so the rest fits the budget.`,
    );
  }
  const tip = new Float32Array(nx * ny);
  tip.fill(topZ);
  // The accumulator starts BELOW every surface reading: the tip is the max over the disc's own
  // set, never lifted by the uncovered-cell default. Uncovered cells stay at topZ.
  const acc = new Float32Array(nx * ny);
  acc.fill(-Infinity);
  // van Herk / Gil-Werman: block prefix and suffix maxima of the padded row, then the window max
  // is the max of a suffix and a prefix — O(1) per cell per disc row. Reused between rows.
  const padded = new Float32Array(nx + 2 * maxW);
  const prefix = new Float32Array(nx + 2 * maxW);
  const suffix = new Float32Array(nx + 2 * maxW);
  const wrap = opts.wrapRows === true;

  /**
   * The sliding-window maximum of the padded source row over [i, i + 2w], merged straight into
   * the destination row's accumulator. The padded cell at t reads source column t − w; the pad
   * bands are the stock top, exactly as the stencil's out-of-grid columns.
   */
  const slideMerge = (srcRow: number, dstRow: number, w: number): void => {
    const srcBase = srcRow * nx;
    const dstBase = dstRow * nx;
    const n = nx + 2 * w;
    for (let t = 0; t < w; t++) padded[t] = topZ;
    for (let i = 0; i < nx; i++) padded[w + i] = z[srcBase + i]!;
    for (let t = w + nx; t < n; t++) padded[t] = topZ;
    const k = 2 * w + 1;
    for (let start = 0; start < n; start += k) {
      const end = Math.min(n, start + k) - 1;
      let accP = padded[start]!;
      for (let t = start; t <= end; t++) {
        const v = padded[t]!;
        if (v > accP) accP = v;
        prefix[t] = accP;
      }
      let accS = padded[end]!;
      for (let t = end; t >= start; t--) {
        const v = padded[t]!;
        if (v > accS) accS = v;
        suffix[t] = accS;
      }
    }
    for (let i = 0; i < nx; i++) {
      const a = suffix[i]!;
      const b = prefix[i + k - 1]!;
      const m = b > a ? b : a;
      const c = dstBase + i;
      if (covered[c] === 1 && m > acc[c]!) acc[c] = m;
    }
  };
  // A row a disc row overhangs (no wrap) reads the stock top: it dominates the accumulator.
  const topRow = (j: number): void => {
    const base = j * nx;
    for (let i = 0; i < nx; i++) if (covered[base + i] === 1) acc[base + i] = topZ;
  };

  for (let dj = -span; dj <= span; dj++) {
    const w = half[dj + span]!;
    if (w < 0) continue;
    if (wrap) {
      for (let j = 0; j < ny; j++) {
        const src = ((j + dj) % ny + ny) % ny;
        slideMerge(src, j, w);
      }
    } else {
      const j0 = Math.max(0, -dj);
      const j1 = Math.min(ny, ny - dj);
      for (let j = 0; j < j0; j++) topRow(j);
      for (let j = j1; j < ny; j++) topRow(j);
      for (let j = j0; j < j1; j++) slideMerge(j + dj, j, w);
    }
  }
  for (let k = 0; k < nx * ny; k++) if (covered[k] === 1) tip[k] = acc[k]!;
  return tip;
}

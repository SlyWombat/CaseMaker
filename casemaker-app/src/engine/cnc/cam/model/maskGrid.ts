/**
 * #970 — THE FINISH MASK'S LEFTOVER GRID AND ITS READS.
 *
 * `cd5ec056` gave the finish mask a grid built once (`gridPitchFor`'s pitch) instead of the exact
 * per-point `dropCutter` queries, and read it with `Math.round` of the point's continuous
 * coordinate. On the 2.5D parts that was invisible; on the panther's 74–89° flanks it dropped the
 * finish over whole areas (coverage 73.17 → 49.09 %), because a point between samples was judged by
 * ONE cell and `Math.round`'s tie-break is directional — a point exactly between two samples lands
 * on the upper one, so a leftover recorded on the lower one is never seen.
 *
 * THE READ IS NOW CONSERVATIVE: a point counts as leftover when ANY cell its own coordinates touch
 * — the floor/ceil pair in x and in y — says leftover. The same integer-index idea as
 * `6b35d6e9`'s `skinTargetGrid` 3×3 read: no rounding of a continuous coordinate at all. The mask
 * may over-include (the ball cuts a cell the exact rule would skip); it must never drop a point
 * the exact per-point rule keeps.
 */

export interface LeftoverGrid {
  nx: number;
  ny: number;
  /** The grid's own origin, mm. */
  min: [number, number];
  pitch: number;
  /** Row-major `j*nx+i`: 1 where the flat's CL stands above the design by more than the band. */
  cells: Uint8Array;
}

const cellIsLeftover = (grid: LeftoverGrid, i: number, j: number): boolean =>
  i >= 0 && j >= 0 && i < grid.nx && j < grid.ny && grid.cells[j * grid.nx + i] === 1;

/**
 * THE CONSERVATIVE READ (the fix): the four cells the point's own coordinate lands among — its
 * floor and ceil in each axis. TRUE when any of them is leftover.
 */
export function leftoverNear(grid: LeftoverGrid, x: number, y: number): boolean {
  const fx = (x - grid.min[0]) / grid.pitch;
  const fy = (y - grid.min[1]) / grid.pitch;
  const i0 = Math.floor(fx);
  const j0 = Math.floor(fy);
  const i1 = Math.ceil(fx);
  const j1 = Math.ceil(fy);
  return cellIsLeftover(grid, i0, j0) || cellIsLeftover(grid, i1, j0) || cellIsLeftover(grid, i0, j1) || cellIsLeftover(grid, i1, j1);
}

/**
 * THE OLD READ, kept for the red-first spec and for the equivalence instrumentation: one
 * `Math.round` cell. It is NOT the mask's rule any more; a spec that needs the pre-fix behaviour
 * calls this.
 */
export function leftoverRounded(grid: LeftoverGrid, x: number, y: number): boolean {
  const i = Math.round((x - grid.min[0]) / grid.pitch);
  const j = Math.round((y - grid.min[1]) / grid.pitch);
  return cellIsLeftover(grid, i, j);
}

/** The mask: the point or any ball-footprint ring point near a leftover cell (the conservative read). */
export function maskCellsConservative(grid: LeftoverGrid, ring: readonly [number, number][], x: number, y: number): boolean {
  if (leftoverNear(grid, x, y)) return true;
  for (const [ox, oy] of ring) if (leftoverNear(grid, x + ox, y + oy)) return true;
  return false;
}

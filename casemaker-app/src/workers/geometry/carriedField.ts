/**
 * #723 P2-2b-ii-2b — the carried stock as a FIELD, sampled into a flat grid.
 *
 * The exact sweeper carries the remaining solid as meshes; a ball-finished side 2 cannot use it
 * (the exact sweeper refuses a ball and a dense program), so the flat column engine carries the
 * other side as its top field instead: two top-down sides bound each column exactly
 * [floor, top] — the earlier side sets the floor, the later one lowers the top.
 *
 * The field arrives with the affine maps that take a TARGET column centre back to the source work
 * frame, so this module needs no knowledge of matrices or job setups:
 *
 *   source (x₁, y₁)  = (a·x + b·y + c,  d·x + e·y + f)     — the target's XY in the source frame
 *   target floor Z   = g·(source top) + h                   — the carried interval's underside
 *
 * A 180° flip's XY map is z-independent (the side-setup class, where it is not, is the stated
 * limitation). A source column at or below the source stock's bottom was cut through, so the
 * target column has no material at all: its floor equals its top and it reads as empty.
 */
import type { ColumnGrid } from './columnEngine';

/** The carried field as plain data: it crosses a worker boundary, so no functions and no classes. */
export interface CarriedField {
  /** The source grid: column (0,0)'s centre, its pitches, and `top[j*nu + i]` (source work Z). */
  u0: number;
  v0: number;
  du: number;
  dv: number;
  nu: number;
  nv: number;
  top: Float32Array;
  /** The source stock's bottom-face work Z: a top at or below it is a cut-through column. */
  base: number;
  /** target (x, y) → source (x₁, y₁), as above. */
  map: readonly [number, number, number, number, number, number];
  /** target floor Z = `z[0] * sourceTop + z[1]`. */
  z: readonly [number, number];
}

/** A source column's top at a work point, nearest column (the grid's own quantisation). */
export function carriedTopAt(field: CarriedField, x: number, y: number): number {
  const i = Math.min(field.nu - 1, Math.max(0, Math.round((x - field.u0) / field.du)));
  const j = Math.min(field.nv - 1, Math.max(0, Math.round((y - field.v0) / field.dv)));
  return field.top[j * field.nu + i] as number;
}

/**
 * Seed `grid` (a FLAT grid just built, its columns at `initial`) with the carried field. Every
 * column gets its floor; its top stays the target stock's own top. A source column that was cut
 * through seeds an empty target column. Pure grid mutation, no allocation per column.
 */
export function applyCarriedField(grid: ColumnGrid, field: CarriedField): void {
  const { nu, nv, u0, v0, du, dv, initial, base, h } = grid;
  const [a, b, c, d, e, f] = field.map;
  const [g, k] = field.z;
  const floors = new Float32Array(nu * nv);
  for (let j = 0; j < nv; j++) {
    const y = v0 + j * dv;
    for (let i = 0; i < nu; i++) {
      const x = u0 + i * du;
      const sx = a * x + b * y + c;
      const sy = d * x + e * y + f;
      const srcTop = carriedTopAt(field, sx, sy);
      const idx = j * nu + i;
      h[idx] = initial;
      if (srcTop <= field.base + 1e-9) {
        // The earlier side removed the whole column: there is nothing to stand on.
        floors[idx] = initial;
        continue;
      }
      const floor = g * srcTop + k;
      floors[idx] = floor > initial ? initial : floor < base ? base : floor;
    }
  }
  // The grid's `columnFloor` is read by applyMove/volume/mesh; write it through the same object so
  // every reader sees it without another parameter.
  (grid as { columnFloor?: Float32Array }).columnFloor = floors;
}

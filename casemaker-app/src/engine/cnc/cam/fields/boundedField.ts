/**
 * #1215 (planner v3, slice 2) — GUARANTEED TIP BOUNDS ON A GRID.
 *
 * For a triangle mesh and a cutter profile: per cell of a grid, a guaranteed lowest and highest
 * value for the cutter's tip height. "Guaranteed" is the contract — the exact drop-cutter value
 * must always lie inside [lo, hi]. The surface is first reduced to two numbers per cell (the exact
 * height over the centre, and a value no surface point in the cell is above), and the cutter's
 * shape is then applied cell by cell: a real point under the cutter gives a lower bound, and every
 * point being in some cell (no higher than that cell's `hi`, no nearer than the cell's nearest
 * point) gives the upper bound.
 *
 * Nothing here posts a coordinate: this module is a decision aid for the selector (slice 3), and
 * nothing calls it yet.
 */
import { heightAt, type CutterProfile, type DropCutterMesh } from '../model/dropcutter';

/** A grid of square cells. Cell (i, j) is centred at (x0 + i * pitch, y0 + j * pitch); its index is j * nx + i. */
export interface FieldGrid {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  pitch: number;
}

/** Grid covering [minX, maxX] × [minY, maxY] grown by `marginMm` on every side. */
export function gridOver(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  pitch: number,
  marginMm: number,
): FieldGrid {
  if (!(pitch > 0)) throw new Error('cam/fields: pitch must be above 0');
  const nx = Math.floor((maxX - minX + 2 * marginMm) / pitch) + 1;
  const ny = Math.floor((maxY - minY + 2 * marginMm) / pitch) + 1;
  return { nx, ny, x0: minX - marginMm, y0: minY - marginMm, pitch };
}

/** The model's top surface on a grid, as two numbers per cell. */
export interface SurfaceBounds {
  grid: FieldGrid;
  /** The exact height of the top surface at the cell's CENTRE; -Infinity where no triangle is over the centre. */
  lo: Float64Array;
  /** A value no point of the surface inside the cell is above; -Infinity where no triangle comes near the cell. */
  hi: Float64Array;
}

export function surfaceBounds(mesh: DropCutterMesh, grid: FieldGrid): SurfaceBounds {
  const { nx, ny, x0, y0, pitch } = grid;
  const lo = new Float64Array(nx * ny).fill(-Infinity);
  const hi = new Float64Array(nx * ny).fill(-Infinity);
  const half = pitch / 2;
  const e = pitch * Math.SQRT1_2;
  const p = mesh.positions;
  const idx = mesh.indices;
  for (let k = 0; k < mesh.triangleCount; k++) {
    const ai = idx[3 * k]!;
    const bi = idx[3 * k + 1]!;
    const ci = idx[3 * k + 2]!;
    const ax = p[3 * ai]!;
    const ay = p[3 * ai + 1]!;
    const az = p[3 * ai + 2]!;
    const bx = p[3 * bi]!;
    const by = p[3 * bi + 1]!;
    const bz = p[3 * bi + 2]!;
    const cx = p[3 * ci]!;
    const cy = p[3 * ci + 1]!;
    const cz = p[3 * ci + 2]!;
    const triMaxZ = Math.max(az, bz, cz);
    const minTriX = Math.min(ax, bx, cx);
    const maxTriX = Math.max(ax, bx, cx);
    const minTriY = Math.min(ay, by, cy);
    const maxTriY = Math.max(ay, by, cy);
    const i0 = Math.max(0, Math.floor((minTriX - e - x0) / pitch));
    const i1 = Math.min(nx - 1, Math.ceil((maxTriX + e - x0) / pitch));
    const j0 = Math.max(0, Math.floor((minTriY - e - y0) / pitch));
    const j1 = Math.min(ny - 1, Math.ceil((maxTriY + e - y0) / pitch));
    if (i1 < i0 || j1 < j0) continue;
    const area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area2) < 1e-12) {
      // Vertical (or no area seen from above): its top corner is all it can contribute.
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const at = j * nx + i;
          hi[at] = Math.max(hi[at]!, triMaxZ);
        }
      }
      continue;
    }
    const a = ((by - ay) * (cz - az) - (cy - ay) * (bz - az)) / -area2;
    const b = ((cx - ax) * (bz - az) - (bx - ax) * (cz - az)) / -area2;
    const c = az - a * ax - b * ay;
    const sign = Math.sign(area2);
    const abLen = Math.hypot(bx - ax, by - ay);
    const bcLen = Math.hypot(cx - bx, cy - by);
    const caLen = Math.hypot(ax - cx, ay - cy);
    for (let j = j0; j <= j1; j++) {
      const py = y0 + j * pitch;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + i * pitch;
        let minDist = Infinity;
        if (abLen > 0) {
          const dist = (((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / abLen) * sign;
          if (dist < minDist) minDist = dist;
        }
        if (bcLen > 0) {
          const dist = (((cx - bx) * (py - by) - (cy - by) * (px - bx)) / bcLen) * sign;
          if (dist < minDist) minDist = dist;
        }
        if (caLen > 0) {
          const dist = (((ax - cx) * (py - cy) - (ay - cy) * (px - cx)) / caLen) * sign;
          if (dist < minDist) minDist = dist;
        }
        if (minDist < -e) continue;
        const zc = a * px + b * py + c;
        const at = j * nx + i;
        const top = Math.min(triMaxZ, zc + (Math.abs(a) + Math.abs(b)) * half);
        if (top > hi[at]!) hi[at] = top;
        if (minDist >= 0 && zc > lo[at]!) lo[at] = zc;
      }
    }
  }
  return { grid, lo, hi };
}

/** Per cell: the exact tip height at the cell's centre lies in [lo, hi]. */
export interface TipBounds {
  grid: FieldGrid;
  lo: Float64Array;
  hi: Float64Array;
}

export function tipBounds(surface: SurfaceBounds, profile: CutterProfile): TipBounds {
  const { nx, ny, pitch } = surface.grid;
  const lo = new Float64Array(nx * ny).fill(-Infinity);
  const hi = new Float64Array(nx * ny).fill(-Infinity);
  const R = profile.radiusMm;
  const half = pitch / 2;
  const K = Math.ceil((R + pitch) / pitch);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const at = j * nx + i;
      let lower = -Infinity;
      let upper = -Infinity;
      for (let dj = -K; dj <= K; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        const dy = dj * pitch;
        for (let di = -K; di <= K; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          const dx = di * pitch;
          const n = jj * nx + ii;
          const surfaceLo = surface.lo[n]!;
          if (Number.isFinite(surfaceLo)) {
            const D = Math.hypot(dx, dy);
            if (D <= R) {
              const value = surfaceLo - heightAt(profile, D);
              if (value > lower) lower = value;
            }
          }
          const surfaceHi = surface.hi[n]!;
          if (Number.isFinite(surfaceHi)) {
            const dmin = Math.hypot(Math.max(0, Math.abs(dx) - half), Math.max(0, Math.abs(dy) - half));
            if (dmin <= R) {
              const value = surfaceHi - heightAt(profile, dmin);
              if (value > upper) upper = value;
            }
          }
        }
      }
      lo[at] = lower;
      hi[at] = upper;
    }
  }
  return { grid: surface.grid, lo, hi };
}

/** The share of cells (0..1) with a finite `lo` whose (hi - lo) is above `widthMm`. 0 when no cell has a finite `lo`. */
export function ambiguousShare(bounds: TipBounds, widthMm: number): number {
  let finite = 0;
  let wide = 0;
  for (let k = 0; k < bounds.lo.length; k++) {
    const l = bounds.lo[k]!;
    if (!Number.isFinite(l)) continue;
    finite += 1;
    if (bounds.hi[k]! - l > widthMm) wide += 1;
  }
  return finite === 0 ? 0 : wide / finite;
}

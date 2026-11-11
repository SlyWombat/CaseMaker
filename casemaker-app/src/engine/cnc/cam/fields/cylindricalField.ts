/**
 * #1220 — THE CYLINDRICAL CHART (planner v3, step B1).
 *
 * #1215's chart is the part seen from straight above. A rod held in the 4th axis is seen
 * differently: the rod's axis is X (Y = 0, Z = 0), the tool always points at the axis, and at an
 * angle θ (measured from +Z toward +Y, degrees) it looks along u = (0, sin θ, cos θ). The HEIGHT
 * at (x, θ) is how far along u the highest surface point lies, on the line through (x, 0, 0) —
 * SIGNED, so a thin off-centre part reads below zero (Makera's own finishing program takes the
 * tool 5 mm below the axis on such a part).
 *
 * The whole chart is built by turning the mesh about X so that u becomes +Z and reading #1215's
 * planar top surface along y′ = 0: for a point (x, y, z), y′ = y·cos θ − z·sin θ and
 * z′ = y·sin θ + z·cos θ, and the point h·u = (x, h·sin θ, h·cos θ) becomes (x, 0, h).
 *
 * NOTHING CALLS THIS YET. It gives a guaranteed LOWER tip value (a floor the exact drop-cutter can
 * never go below) and the exact value for the tests; a guaranteed UPPER value on a wedge cell is
 * its own issue, written when the rotary planner needs it.
 */
import { surfaceBounds } from './boundedField';
import { heightAt, dropCutterHeight, type CutterProfile, type DropCutterMesh } from '../model/dropcutter';

/** A grid over a rod: `nx` cells along X, `nTheta` cells around. Cell (i, j) is at x = x0 + i * dx and θ = j * dTheta degrees; its index is j * nx + i. */
export interface CylGrid {
  nx: number;
  nTheta: number;
  x0: number;
  dx: number;
  dThetaDeg: number;
}

/** nTheta = Math.round(360 / dThetaDeg), at least 4; dThetaDeg is then 360 / nTheta. nx as in gridOver. */
export function cylGridOver(minX: number, maxX: number, dx: number, dThetaDeg: number): CylGrid {
  if (!(dx > 0) || !(dThetaDeg > 0)) throw new Error('cam/fields: dx and dThetaDeg must be above 0');
  const nTheta = Math.max(4, Math.round(360 / dThetaDeg));
  return { nx: Math.floor((maxX - minX) / dx) + 1, nTheta, x0: minX, dx, dThetaDeg: 360 / nTheta };
}

/** A copy of the mesh turned about X so that the direction at `thetaDeg` becomes +Z. */
export function turnedAboutX(mesh: DropCutterMesh, thetaDeg: number): DropCutterMesh {
  const t = (thetaDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const positions: number[] = new Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i]!;
    const y = mesh.positions[i + 1]!;
    const z = mesh.positions[i + 2]!;
    positions[i] = x;
    positions[i + 1] = y * c - z * s;
    positions[i + 2] = y * s + z * c;
  }
  return { positions, indices: mesh.indices, triangleCount: mesh.triangleCount };
}

/** The signed height at every (x, θ) cell centre; -Infinity where the line misses the part. */
export interface CylSurface {
  grid: CylGrid;
  height: Float64Array;
}

export function cylSurface(mesh: DropCutterMesh, grid: CylGrid): CylSurface {
  const { nx, nTheta, x0, dx, dThetaDeg } = grid;
  const height = new Float64Array(nx * nTheta);
  for (let j = 0; j < nTheta; j++) {
    const turned = turnedAboutX(mesh, j * dThetaDeg);
    const row = surfaceBounds(turned, { nx, ny: 1, x0, y0: 0, pitch: dx }).lo;
    for (let i = 0; i < nx; i++) height[j * nx + i] = row[i]!;
  }
  return { grid, height };
}

/** Per cell: a value the exact tip height at that (x, θ) is never below. -Infinity where nothing is in reach. */
export function cylTipLower(surface: CylSurface, profile: CutterProfile): Float64Array {
  const { grid, height } = surface;
  const { nx, nTheta, dx, dThetaDeg } = grid;
  const R = profile.radiusMm;
  const K = Math.ceil(R / dx);
  const out = new Float64Array(nx * nTheta).fill(-Infinity);
  for (let j = 0; j < nTheta; j++) {
    for (let i = 0; i < nx; i++) {
      const at = j * nx + i;
      for (let di = -K; di <= K; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nx) continue;
        for (let dj = -(nTheta >> 1); dj <= (nTheta >> 1); dj++) {
          const m = (((j + dj) % nTheta) + nTheta) % nTheta;
          const h = height[m * nx + ii]!;
          if (!Number.isFinite(h)) continue;
          // Every finite height is a real surface point at h·u(θm). Seen by a tool at θj it sits
          // h·sin Δ to the side and h·cos Δ along; the tip can never be lower than that point's
          // height along the tool minus the cutter's shape at that sideways distance.
          const delta = (dj * dThetaDeg * Math.PI) / 180;
          const side = h * Math.sin(delta);
          const along = h * Math.cos(delta);
          const rho = Math.hypot(di * dx, side);
          if (rho > R) continue;
          const value = along - heightAt(profile, rho);
          if (value > out[at]!) out[at] = value;
        }
      }
    }
  }
  return out;
}

/** The exact tip height with the tool at (x, θ): the truth the tests compare with. */
export function cylTipExact(mesh: DropCutterMesh, profile: CutterProfile, x: number, thetaDeg: number): number | null {
  return dropCutterHeight(profile, turnedAboutX(mesh, thetaDeg), x, 0);
}

/** The turning profile: for each x cell, the largest height over all θ (-Infinity where the rod is empty). */
export function turningProfile(surface: CylSurface): Float64Array {
  const { grid, height } = surface;
  const { nx, nTheta } = grid;
  const out = new Float64Array(nx).fill(-Infinity);
  for (let j = 0; j < nTheta; j++) {
    for (let i = 0; i < nx; i++) {
      const value = height[j * nx + i]!;
      if (value > out[i]!) out[i] = value;
    }
  }
  return out;
}

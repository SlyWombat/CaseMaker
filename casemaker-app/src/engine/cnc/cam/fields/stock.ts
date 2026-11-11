/**
 * #1221 (planner v3 B2) — ONE STOCK, CUT FROM EVERY POSE.
 *
 * The blank is a box; every pose that has cut keeps ONE height map over its own grid (the pose-frame
 * height it has cut down to, +Infinity where it has not cut). A part-frame point is still material
 * when it is inside the blank and, for every pose, at or below that pose's map at that spot. A cut
 * only ever lowers its own pose's map, so the description is exact for planar charts (the tool
 * comes straight down in the pose's own frame); the rod turning under the tool is a later issue.
 *
 * Nothing calls this yet. No registry value: the stepping is an argument.
 */
import type { FieldGrid } from './boundedField';
import type { CamMove } from '../ir';

export type Vec3 = readonly [number, number, number];
/** Three rows. Pose coordinates = rotation · part coordinates. */
export type Mat3 = readonly [Vec3, Vec3, Vec3];

/** q = R · p */
export function rotate(R: Mat3, p: Vec3): [number, number, number] {
  return [
    R[0][0] * p[0] + R[0][1] * p[1] + R[0][2] * p[2],
    R[1][0] * p[0] + R[1][1] * p[1] + R[1][2] * p[2],
    R[2][0] * p[0] + R[2][1] * p[1] + R[2][2] * p[2],
  ];
}

/** p = Rᵀ · q (the inverse of a rotation is its transpose) */
export function unrotate(R: Mat3, q: Vec3): [number, number, number] {
  return [
    R[0][0] * q[0] + R[1][0] * q[1] + R[2][0] * q[2],
    R[0][1] * q[0] + R[1][1] * q[1] + R[2][1] * q[2],
    R[0][2] * q[0] + R[1][2] * q[1] + R[2][2] * q[2],
  ];
}

/** What one pose has cut: for each cell of its grid, the pose-frame height it has cut down to. +Infinity where it has not cut. */
export interface PoseCut {
  rotation: Mat3;
  grid: FieldGrid;
  floor: Float64Array;
}

/** A rod: material only within `radiusMm` of the line along x at (axisY, axisZ). */
export interface RodShape {
  axisY: number;
  axisZ: number;
  radiusMm: number;
}

/** The blank, a box in part coordinates — or a rod inside that box. */
export interface Blank {
  min: Vec3;
  max: Vec3;
  /** #1229 — a rod blank: material only within its radius of the axis line. Absent: the box. */
  rod?: RodShape;
}

/** What turning has removed: at each cell along the rod, the radius it has been cut down to. +Infinity where it has not been turned. Cell i is at x0 + i * dx. */
export interface TurnedCut {
  axisY: number;
  axisZ: number;
  x0: number;
  dx: number;
  radius: Float64Array;
}

export interface Stock {
  blank: Blank;
  cuts: readonly PoseCut[];
  /** #1229 — the rod's turned record, when a turning pass has cut it. Absent: no turning. */
  turned?: TurnedCut;
}

const EPS = 1e-9;

/** Is the part-frame point `p` still material? */
export function isMaterial(stock: Stock, p: Vec3): boolean {
  // 1. Inside the blank.
  for (let k = 0; k < 3; k++) {
    if (p[k]! < stock.blank.min[k]! - EPS) return false;
    if (p[k]! > stock.blank.max[k]! + EPS) return false;
  }
  // 1b. Inside the rod, when the blank is one.
  const rod = stock.blank.rod;
  if (rod !== undefined) {
    if (Math.hypot(p[1] - rod.axisY, p[2] - rod.axisZ) > rod.radiusMm + EPS) return false;
  }
  // 1c. Not turned away. A position along the rod outside the turned span says nothing.
  const turned = stock.turned;
  if (turned !== undefined) {
    const i = Math.round((p[0] - turned.x0) / turned.dx);
    if (i >= 0 && i < turned.radius.length) {
      if (Math.hypot(p[1] - turned.axisY, p[2] - turned.axisZ) > turned.radius[i]! + EPS) return false;
    }
  }
  // 2. At or below every pose's map that covers the point. A cell outside a pose's grid says
  // nothing about the point; only a covered cell above the map removes material.
  for (const cut of stock.cuts) {
    const q = rotate(cut.rotation, p);
    const i = Math.round((q[0] - cut.grid.x0) / cut.grid.pitch);
    const j = Math.round((q[1] - cut.grid.y0) / cut.grid.pitch);
    if (i < 0 || i >= cut.grid.nx || j < 0 || j >= cut.grid.ny) continue;
    if (q[2] > cut.floor[j * cut.grid.nx + i]! + EPS) return false;
  }
  return true;
}

/**
 * Seen from the pose with `rotation`, over `grid`: for each cell, the highest pose-frame height at
 * which there is material. -Infinity where the column holds no material. Found by stepping down in
 * steps of `stepMm`, so the answer is within one step below the true top.
 */
export function startSurface(stock: Stock, rotation: Mat3, grid: FieldGrid, stepMm: number): Float64Array {
  if (!(stepMm > 0)) throw new Error('cam/fields: stepMm must be above 0');
  // 1. The blank's eight corners in the pose frame: the column's top and bottom.
  let top = -Infinity;
  let bottom = Infinity;
  for (const x of [stock.blank.min[0], stock.blank.max[0]]) {
    for (const y of [stock.blank.min[1], stock.blank.max[1]]) {
      for (const z of [stock.blank.min[2], stock.blank.max[2]]) {
        const q = rotate(rotation, [x, y, z]);
        top = Math.max(top, q[2]);
        bottom = Math.min(bottom, q[2]);
      }
    }
  }
  const out = new Float64Array(grid.nx * grid.ny).fill(-Infinity);
  // 2. Step each column down from the blank's top until material is found.
  for (let j = 0; j < grid.ny; j++) {
    for (let i = 0; i < grid.nx; i++) {
      const u = grid.x0 + i * grid.pitch;
      const v = grid.y0 + j * grid.pitch;
      for (let n = 0; (top - n * stepMm) >= bottom - 1e-9; n++) {
        const w = top - n * stepMm;
        if (isMaterial(stock, unrotate(rotation, [u, v, w]))) {
          out[j * grid.nx + i] = w;
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Lower `turned.radius` by what these turning moves cut. Each FEED move's end point is a tool tip at
 * radius `z` and position `x`; the cutter reaches `cutterRadiusMm` along the rod either side. Rapids
 * are ignored. Only end points are counted, so the record never claims more removed than was.
 */
export function recordTurning(turned: TurnedCut, moves: readonly CamMove[], cutterRadiusMm: number): void {
  for (const m of moves) {
    if (m.kind !== 'feed') continue;
    for (let i = 0; i < turned.radius.length; i++) {
      const xc = turned.x0 + i * turned.dx;
      if (Math.abs(xc - m.x) <= cutterRadiusMm + turned.dx / 2 + 1e-9 && m.z < turned.radius[i]!) {
        turned.radius[i] = m.z;
      }
    }
  }
}

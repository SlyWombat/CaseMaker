/**
 * How the stock sits for a setup, as a PROPER ROTATION (#428 review: det = +1 for every one — a turn a
 * person can make by hand, never a mirror image).
 *
 * FRAMES. The stock frame is X left→right, Y front→back, Z bottom→top (`types.ts`). The machine frame
 * is the same words as the operator stands at the machine: X to the right, Y away from them, Z up; on
 * the vise the FIXED jaw is on the left (machine −X), the moving jaw on the right. A rotation `R` takes
 * a direction in the stock frame to the machine frame: `machine = R · stock`.
 *
 * THE TURNS, by face up and mount (§5.4 step 3):
 *   - top up: none.
 *   - bottom up, VISE: a half turn about machine X (left ↔ left: the same edges stay on the same jaws;
 *     the front edge goes to the back).
 *   - bottom up, BRACKET / TAPE: a half turn about machine Y (sideways: the left edge goes to the right;
 *     the front edge stays at the front).
 *   - left up, VISE: a quarter turn about Y, the left edge coming UP — the top then faces the MOVING
 *     jaw (right). Right up: the other way — the top faces the FIXED jaw.
 *   - front up, VISE: a quarter turn about X, the front edge coming UP — the top then faces the back.
 *     Back up: the other way — the top faces the front.
 *   - a side up on the bracket or tape: unholdable.
 *
 * SIGN CONVENTION for `rotate.degrees`: positive is counter-clockwise looking from the positive end
 * of the axis back toward the origin (the right-hand rule). The operator never reads it — the remount
 * words say the same turn in landmarks (`remount.ts`).
 */

import type { Box, Face, MountSpec, Orientation } from './types';

export type Vec = [number, number, number];
export type Mat = [Vec, Vec, Vec];

export const FACE_VEC: Record<Face, Vec> = {
  right: [1, 0, 0],
  left: [-1, 0, 0],
  back: [0, 1, 0],
  front: [0, -1, 0],
  top: [0, 0, 1],
  bottom: [0, 0, -1],
};

const I: Mat = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];
/** About machine X, 180°: y → −y, z → −z. */
const RX180: Mat = [
  [1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
];
/** About machine Y, 180°: x → −x, z → −z. */
const RY180: Mat = [
  [-1, 0, 0],
  [0, 1, 0],
  [0, 0, -1],
];
/** About Y, +90° (right-hand: +Z turns toward +X): the stock's left (−X) comes up, its top goes to +X. */
const RY_LEFT_UP: Mat = [
  [0, 0, 1],
  [0, 1, 0],
  [-1, 0, 0],
];
/** About Y, −90°: the stock's right (+X) comes up, its top goes to −X. */
const RY_RIGHT_UP: Mat = [
  [0, 0, -1],
  [0, 1, 0],
  [1, 0, 0],
];
/** About X, −90° (right-hand: +Y turns toward +Z is positive): the stock's front (−Y) comes up, its top goes to +Y. */
const RX_FRONT_UP: Mat = [
  [1, 0, 0],
  [0, 0, 1],
  [0, -1, 0],
];
/** About X, +90°: the stock's back (+Y) comes up, its top goes to −Y. */
const RX_BACK_UP: Mat = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
];

export function apply(m: Mat, v: Vec): Vec {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export function det(m: Mat): number {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

export function vecToFace(v: Vec): Face {
  const hit = (Object.entries(FACE_VEC) as [Face, Vec][]).find(([, f]) => f[0] === v[0] && f[1] === v[1] && f[2] === v[2]);
  if (!hit) throw new Error(`not an axis direction: ${v.join(',')}`);
  return hit[0];
}

/** Which STOCK face sits at each MACHINE face under `m`. */
export function orientationOf(m: Mat): Orientation {
  const o = {} as Orientation;
  for (const s of Object.keys(FACE_VEC) as Face[]) o[vecToFace(apply(m, FACE_VEC[s]))] = s;
  return o;
}

export type OrientResult =
  | { ok: true; matrix: Mat; orientation: Orientation; rotate: { about: 'x' | 'y'; degrees: 90 | -90 | 180 } | null }
  | { ok: false; reason: string };

function result(m: Mat, rotate: { about: 'x' | 'y'; degrees: 90 | -90 | 180 } | null): OrientResult {
  // A turn, never a mirror: anything else is a bug here, not an input to refuse.
  if (det(m) !== 1) throw new Error('an orientation that is not a proper rotation');
  return { ok: true, matrix: m, orientation: orientationOf(m), rotate };
}

/** The rotation for `up`, for this mount — or why the mount cannot hold it. */
export function orient(up: Face, mount: MountSpec, size: { x: number; y: number; z: number }): OrientResult {
  if (up === 'top') return result(I, null);
  if (up === 'bottom') return mount.kind === 'vise' ? result(RX180, { about: 'x', degrees: 180 }) : result(RY180, { about: 'y', degrees: 180 });
  if (mount.kind !== 'vise') {
    return { ok: false, reason: `the ${up} face up means standing the stock on an edge, which the ${mount.kind === 'tape' ? 'tape' : 'bracket'} cannot hold` };
  }
  const m = up === 'left' ? RY_LEFT_UP : up === 'right' ? RY_RIGHT_UP : up === 'front' ? RX_FRONT_UP : RX_BACK_UP;
  const across = Math.abs(apply(m, [size.x, size.y, size.z])[0]);
  if (mount.viseOpeningMm !== undefined && across > mount.viseOpeningMm) {
    return { ok: false, reason: `standing it this way puts ${across} mm across the jaws, more than their ${mount.viseOpeningMm} mm opening` };
  }
  const rotate =
    up === 'left'
      ? ({ about: 'y', degrees: 90 } as const)
      : up === 'right'
        ? ({ about: 'y', degrees: -90 } as const)
        : up === 'front'
          ? ({ about: 'x', degrees: -90 } as const)
          : ({ about: 'x', degrees: 90 } as const);
  return result(m, rotate);
}

/** The axis (0 X, 1 Y, 2 Z) and side of a face. */
export function faceAxis(f: Face): { axis: 0 | 1 | 2; high: boolean } {
  const v = FACE_VEC[f];
  const axis = (v[0] !== 0 ? 0 : v[1] !== 0 ? 1 : 2) as 0 | 1 | 2;
  return { axis, high: v[axis]! > 0 };
}

export function opposite(f: Face): Face {
  return ({ top: 'bottom', bottom: 'top', left: 'right', right: 'left', front: 'back', back: 'front' } as const)[f];
}

/** The stock's extent along the machine's X, Y and Z, for its current bounds. */
export function machineSize(m: Mat, bounds: Box): { x: number; y: number; z: number } {
  const d = apply(m, [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]]);
  return { x: Math.abs(d[0]), y: Math.abs(d[1]), z: Math.abs(d[2]) };
}

/** A stock-frame point in the mounted stock's own work XYZ (origin at its min corner as mounted). */
export function toMachine(m: Mat, bounds: Box, p: Vec): Vec {
  const corners: Vec[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) for (const z of [bounds.min[2], bounds.max[2]]) corners.push(apply(m, [x, y, z]));
  const min: Vec = [0, 1, 2].map((i) => Math.min(...corners.map((c) => c[i]!))) as Vec;
  const q = apply(m, p);
  return [q[0] - min[0], q[1] - min[1], q[2] - min[2]];
}

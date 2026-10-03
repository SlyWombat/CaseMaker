/**
 * The three coordinate frames and the ONE place that converts between them (#182,
 * `/Simulation.md` §2).
 *
 *   part     the model's own authored frame. z = 0 is the back face; the engraved face is at
 *            z = thickness. No flip: printing is the flip, handled on export.
 *   work     what the `.nc` says. G54 translates it to the machine; there is no rotation.
 *   machine  the controller's frame. `G53` moves and the envelope check live here.
 *
 *   machine = work + wcs.origin
 *   machine = Rz(placement.rotationZ) * part + placement.origin
 *
 * The post-processor and the emulator must import THESE and nothing else. This repo's own
 * history is the argument: the Z reference was reversed twice, a Y-down KiCad board went
 * in on the wrong axis, and the round-trip test `sweep(ir) == sweep(parse(post(ir)))`
 * cannot catch a frame error precisely BECAUSE both sides share the function. So the frame
 * is tested separately, with golden numbers worked out by hand from a part's dimensions
 * (`tests/unit/cncFrames.spec.ts`), and never with a symmetric part: a centred badge is
 * unchanged by exactly the mirrors and sign flips most likely to be wrong.
 *
 * Positions with an unknown axis (`null`) stay unknown through `workPosToMachine` and
 * `machinePosToWork`; nothing is invented.
 */

import type { Pos } from './gcode/types';
import type { Setup } from './setup';
import type { Vec3 } from '@/types/units';

/** cos/sin in degrees, EXACT at the quadrant angles so golden tests carry no 1e-16 noise. */
export function cosSinDeg(deg: number): [number, number] {
  const a = ((deg % 360) + 360) % 360;
  if (a === 0) return [1, 0];
  if (a === 90) return [0, 1];
  if (a === 180) return [-1, 0];
  if (a === 270) return [0, -1];
  const r = (a * Math.PI) / 180;
  return [Math.cos(r), Math.sin(r)];
}

export function partToMachine(setup: Setup, p: Vec3): Vec3 {
  const [c, s] = cosSinDeg(setup.placement.rotationZ);
  const o = setup.placement.origin;
  return [c * p[0] - s * p[1] + o[0], s * p[0] + c * p[1] + o[1], p[2] + o[2]];
}

export function machineToPart(setup: Setup, m: Vec3): Vec3 {
  const [c, s] = cosSinDeg(setup.placement.rotationZ);
  const o = setup.placement.origin;
  const x = m[0] - o[0];
  const y = m[1] - o[1];
  // The inverse of a rotation is its transpose.
  return [c * x + s * y, -s * x + c * y, m[2] - o[2]];
}

export function workToMachine(setup: Setup, w: Vec3): Vec3 {
  const o = setup.wcs.origin;
  return [w[0] + o[0], w[1] + o[1], w[2] + o[2]];
}

export function machineToWork(setup: Setup, m: Vec3): Vec3 {
  const o = setup.wcs.origin;
  return [m[0] - o[0], m[1] - o[1], m[2] - o[2]];
}

export function partToWork(setup: Setup, p: Vec3): Vec3 {
  return machineToWork(setup, partToMachine(setup, p));
}

export function workToPart(setup: Setup, w: Vec3): Vec3 {
  return machineToPart(setup, workToMachine(setup, w));
}

/**
 * Work → machine for a possibly partial position. A work offset is a pure translation, so
 * each axis converts independently by its own offset and an unknown axis stays unknown.
 * (A ROTATION would not be this simple: it mixes X and Y, so one unknown would make both
 * unknown. Nothing here rotates a partial position, and nothing should without handling that.)
 */
export function workPosToMachine(setup: Setup, p: Pos): Pos {
  const o = setup.wcs.origin;
  return [
    p[0] === null ? null : p[0] + o[0],
    p[1] === null ? null : p[1] + o[1],
    p[2] === null ? null : p[2] + o[2],
  ];
}

/** Machine → work for a possibly partial position. */
export function machinePosToWork(setup: Setup, p: Pos): Pos {
  const o = setup.wcs.origin;
  return [
    p[0] === null ? null : p[0] - o[0],
    p[1] === null ? null : p[1] - o[1],
    p[2] === null ? null : p[2] - o[2],
  ];
}

/**
 * Where, in the WORK frame, the part's engraved (top) face is: a cut to depth d is at work
 * Z = faceZ − d. For a stub registered on the engraved face this is 0, which is the point
 * of anchoring there. Returns null for a part with no defined top face.
 */
export function engravedFaceWorkZ(setup: Setup): number | null {
  const part = setup.part;
  if (part.kind !== 'prism') return null;
  return partToWork(setup, [0, 0, part.thickness])[2];
}

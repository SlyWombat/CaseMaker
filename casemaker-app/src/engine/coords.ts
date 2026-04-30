import * as THREE from 'three';
import type { BoardProfile, CaseParameters, CaseFace, Facing } from '@/types';

let initialized = false;

export function ensureZUp(): void {
  if (initialized) return;
  THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
  initialized = true;
}

export function isZUp(): boolean {
  return (
    THREE.Object3D.DEFAULT_UP.x === 0 &&
    THREE.Object3D.DEFAULT_UP.y === 0 &&
    THREE.Object3D.DEFAULT_UP.z === 1
  );
}

/**
 * World-frame Z of the host PCB top, given the floor and standoff parameters.
 * Single source of truth so every compiler agrees (issues #28, #43, #44).
 *
 *   Z = floor + standoff + pcb.z
 *
 * Use this instead of repeating the formula inline.
 */
export function pcbTopZ(board: BoardProfile, params: CaseParameters): number {
  return params.floorThickness + board.defaultStandoffHeight + board.pcb.size.z;
}

/** World-frame Z of the host PCB bottom (top of the standoffs). */
export function pcbBottomZ(board: BoardProfile, params: CaseParameters): number {
  return params.floorThickness + board.defaultStandoffHeight;
}

/** World-frame X / Y of the cavity origin (PCB lower-left corner in world coords). */
export function cavityOriginXY(params: CaseParameters): { x: number; y: number } {
  const off = params.wallThickness + params.internalClearance;
  return { x: off, y: off };
}

// =============================================================================
// Face-frame math (issue #50).
//
// Every compiler that places features on a face of the case used to ship its
// own `faceFrame()` helper. They were equivalent but drifted on which fields
// they exposed (signed vector vs axis-letter + sign). The helpers below are
// the single source of truth — `mountingFeatures.ts`, `textLabels.ts`, and
// `fans.ts` all call into this module.
// =============================================================================

export type Vec3 = readonly [number, number, number];
export type AxisLetter = 'x' | 'y' | 'z';
export type Sign = -1 | 1;

export interface FaceFrame {
  /** World-coord origin: the corner where (u=0, v=0) of the face's local 2D frame lives. */
  origin: Vec3;
  /** Unit vector along the local +u direction. */
  uAxis: Vec3;
  /** Unit vector along the local +v direction. */
  vAxis: Vec3;
  /**
   * Unit vector pointing OUT of the case from this face. uAxis × vAxis is
   * NOT guaranteed to equal outwardAxis — the (u, v) pair is chosen for
   * intuitive layout (right = +u, up = +v), not handedness consistency.
   */
  outwardAxis: Vec3;
  /** Which world axis the outward direction lies on. */
  outwardLetter: AxisLetter;
  /** Outward direction sign on its axis. */
  outwardSign: Sign;
}

/**
 * Build the local frame for one face of an axis-aligned case with outer
 * dimensions `outerX × outerY × outerZ`. The case sits in the first octant
 * (corner at the origin), so e.g. the `-z` face is the bottom plane (z = 0)
 * and the `+z` face is the top plane (z = outerZ).
 */
export function faceFrame(
  face: CaseFace,
  outerX: number,
  outerY: number,
  outerZ: number,
): FaceFrame {
  switch (face) {
    case '-z':
      return {
        origin: [0, 0, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
        outwardAxis: [0, 0, -1],
        outwardLetter: 'z',
        outwardSign: -1,
      };
    case '+z':
      return {
        origin: [0, 0, outerZ],
        uAxis: [1, 0, 0],
        vAxis: [0, 1, 0],
        outwardAxis: [0, 0, 1],
        outwardLetter: 'z',
        outwardSign: 1,
      };
    case '-y':
      return {
        origin: [0, 0, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 0, 1],
        outwardAxis: [0, -1, 0],
        outwardLetter: 'y',
        outwardSign: -1,
      };
    case '+y':
      return {
        origin: [0, outerY, 0],
        uAxis: [1, 0, 0],
        vAxis: [0, 0, 1],
        outwardAxis: [0, 1, 0],
        outwardLetter: 'y',
        outwardSign: 1,
      };
    case '-x':
      return {
        origin: [0, 0, 0],
        uAxis: [0, 1, 0],
        vAxis: [0, 0, 1],
        outwardAxis: [-1, 0, 0],
        outwardLetter: 'x',
        outwardSign: -1,
      };
    case '+x':
      return {
        origin: [outerX, 0, 0],
        uAxis: [0, 1, 0],
        vAxis: [0, 0, 1],
        outwardAxis: [1, 0, 0],
        outwardLetter: 'x',
        outwardSign: 1,
      };
  }
}

/**
 * Map a face-local (u, v) coordinate to world-space, optionally offset along
 * the face's outward normal. Replaces the inline
 * `[origin[0] + uAxis[0]*u + vAxis[0]*v, ...]` triplet that was duplicated in
 * every feature compiler.
 */
export function placeOnFace(
  frame: FaceFrame,
  u: number,
  v: number,
  outwardOffset = 0,
): [number, number, number] {
  return [
    frame.origin[0] + frame.uAxis[0] * u + frame.vAxis[0] * v + frame.outwardAxis[0] * outwardOffset,
    frame.origin[1] + frame.uAxis[1] * u + frame.vAxis[1] * v + frame.outwardAxis[1] * outwardOffset,
    frame.origin[2] + frame.uAxis[2] * u + frame.vAxis[2] * v + frame.outwardAxis[2] * outwardOffset,
  ];
}

/**
 * Convert a `CaseFace` to the narrower `Facing` type used by axis-aligned
 * cylinder helpers. `Facing` excludes `-z` (the cylinder primitive is already
 * Z-axis), so callers must handle that case separately.
 */
export function caseFaceToFacing(face: CaseFace): Facing | '-z' {
  return face;
}

import * as THREE from 'three';
import type { BoardProfile, CaseParameters } from '@/types';

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

import * as THREE from 'three';
import { placedSize } from '@/engine/cnc/engrave/targetScale';
import type { EngraveTargetObject } from '@/types/engraveJob';

/** #831 — the goal compass's frame, colours and snaps, and the e2e probe (see GoalTransformHandles). */
export type Axis = 'x' | 'y' | 'z';

export const MOVE_SNAP_MM = 1;

/**
 * #876 — THE RING'S GRADUATED SCALE AND ZONE SNAP (the maintainer's PrusaSlicer model). Round each
 * ring: a tick every {@link ROTATE_TICK_DEG}, a longer one every 15°, and long radial lines at
 * every {@link ROTATE_MAJOR_DEG}. While dragging, the pointer's SCREEN distance from the centre
 * chooses the behaviour: inside the scale band the angle tracks the ticks, within
 * {@link ROTATE_MAJOR_LOCK_DEG} of a major line it locks to that line exactly, and outside the band
 * it is free (no modifier key). The band is at least {@link BAND_PX_COARSE} deep on a coarse
 * pointer, because a finger cannot aim a 24 px annulus.
 */
export const ROTATE_TICK_DEG = 5;
export const ROTATE_MAJOR_DEG = 45;
export const ROTATE_MAJOR_LOCK_DEG = 3;
export const BAND_PX_FINE = 24;
export const BAND_PX_COARSE = 44;

/** The scale band's depth in screen pixels for this pointer. */
export function bandPx(coarse: boolean): number {
  return coarse ? BAND_PX_COARSE : BAND_PX_FINE;
}

/** Whether a pointer `pointerPx` from the projected centre is inside the ring's scale band. */
export function inScaleBand(pointerPx: number, ringPx: number, band: number): boolean {
  return Math.abs(pointerPx - ringPx) <= band / 2;
}

/**
 * #876 — THE ANGLE A RING DRAG WRITES. In the band: the nearest 5° tick, or the exact 45° major
 * line when the raw angle is within {@link ROTATE_MAJOR_LOCK_DEG} of one. Outside: free, rounded to
 * 0.1° (the precision the document already holds).
 */
export function snapRingAngle(rawDeg: number, inBand: boolean): number {
  if (!inBand) return Math.round(rawDeg * 10) / 10;
  const major = Math.round(rawDeg / ROTATE_MAJOR_DEG) * ROTATE_MAJOR_DEG;
  if (Math.abs(rawDeg - major) <= ROTATE_MAJOR_LOCK_DEG) return major;
  return Math.round(rawDeg / ROTATE_TICK_DEG) * ROTATE_TICK_DEG;
}

/** Whether the device's primary pointer is coarse (a finger). False when unknown. */
export function coarsePointer(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true;
  } catch {
    return false;
  }
}

/**
 * #876 — A HANDLE IS BEING DRAGGED. `AutoFrame` reframes when the scene's diagonal changes by more
 * than 35 %, and turning a tall goal changes it by more than that: the camera would jump out from
 * under the held pointer mid-drag, and every probe pixel computed before the jump points at
 * nothing. While this is set, AutoFrame leaves the camera alone.
 */
let handleDragActive = false;
export function setGoalHandleDragActive(active: boolean): void {
  handleDragActive = active;
}
export function isGoalHandleDragActive(): boolean {
  return handleDragActive;
}

export const AXIS_COLOUR: Record<Axis, string> = { x: '#e5533d', y: '#4caf50', z: '#3d7be5' };
export const ACTIVE_COLOUR = '#ffd267';
export const RENDER_ORDER = 20;

export const UNIT: Record<Axis, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};
/** The ring's in-plane basis: e1 → e2 is a positive (right-handed) turn about the axis. */
export const BASIS: Record<Axis, [THREE.Vector3, THREE.Vector3]> = {
  x: [UNIT.y, UNIT.z],
  y: [UNIT.z, UNIT.x],
  z: [UNIT.x, UNIT.y],
};
/** A torus lies in its local XY plane; these turn it so its axis is the named one. */
export const RING_ROTATION: Record<Axis, [number, number, number]> = {
  x: [0, Math.PI / 2, 0],
  y: [Math.PI / 2, 0, 0],
  z: [0, 0, 0],
};

/** The compass's centre (the placed bbox centre) and ring radius, work frame mm. */
export function handleFrame(
  target: EngraveTargetObject,
  mold: boolean,
): { centre: THREE.Vector3; radius: number } {
  const ext = placedSize(target);
  const z = mold ? -ext.z / 2 : target.position.z - ext.z / 2;
  return {
    centre: new THREE.Vector3(target.position.x, target.position.y, z),
    radius: Math.max(6, 0.5 * Math.max(ext.x, ext.y, ext.z) + 4),
  };
}

/** The point on a handle, local to the compass centre: a ring at `value` degrees, an arrow at `value` mm. */
export function handleOffset(kind: 'ring' | 'arrow', axis: Axis, value: number, radius: number): THREE.Vector3 {
  if (kind === 'arrow') return UNIT[axis].clone().multiplyScalar(value);
  const [e1, e2] = BASIS[axis];
  const a = (value * Math.PI) / 180;
  return e1.clone().multiplyScalar(Math.cos(a) * radius).add(e2.clone().multiplyScalar(Math.sin(a) * radius));
}

export type Probe = (kind: 'ring' | 'arrow', axis: Axis, value: number) => { x: number; y: number } | null;
let probe: Probe | null = null;
export function setGoalHandleProbe(next: Probe | null): void {
  probe = next;
}
/**
 * Testing surface (#831 e2e): the CLIENT pixel of a point on a handle, so a spec can drag a ring
 * along its own circle. Null while no handles are drawn.
 */
export function goalHandleClientPoint(kind: 'ring' | 'arrow', axis: Axis, value: number): { x: number; y: number } | null {
  return probe === null ? null : probe(kind, axis, value);
}

/**
 * #876 — the compass CENTRE's client pixel. The scale band is measured from it, so a spec proving
 * in-band/out-of-band snapping needs it to move the pointer radially.
 */
let centreProbe: (() => { x: number; y: number } | null) | null = null;
export function setGoalHandleCentreProbe(next: (() => { x: number; y: number } | null) | null): void {
  centreProbe = next;
}
export function goalHandleCentreClientPoint(): { x: number; y: number } | null {
  return centreProbe === null ? null : centreProbe();
}


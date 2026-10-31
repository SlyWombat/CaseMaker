import * as THREE from 'three';
import { placedSize } from '@/engine/cnc/engrave/targetScale';
import type { EngraveTargetObject } from '@/types/engraveJob';

/** #831 — the goal compass's frame, colours and snaps, and the e2e probe (see GoalTransformHandles). */
export type Axis = 'x' | 'y' | 'z';

export const ROTATE_SNAP_DEG = 15;
export const MOVE_SNAP_MM = 1;

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


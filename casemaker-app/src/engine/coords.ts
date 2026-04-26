import * as THREE from 'three';

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

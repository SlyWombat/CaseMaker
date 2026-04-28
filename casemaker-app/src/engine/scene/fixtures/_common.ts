import * as THREE from 'three';

export interface FixtureSize {
  x: number;
  y: number;
  z: number;
}

/**
 * Build a fixture group whose bounding box exactly fills the requested size,
 * anchored at the lower corner of that box (so callers can position it the
 * same way as the plain placeholder block).
 */
export function fixtureGroup(name: string): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  return g;
}

export function box(
  size: FixtureSize,
  color: string,
  opts: { metalness?: number; roughness?: number; opacity?: number } = {},
): THREE.Mesh {
  const geom = new THREE.BoxGeometry(size.x, size.y, size.z);
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: opts.metalness ?? 0.4,
    roughness: opts.roughness ?? 0.5,
    transparent: opts.opacity !== undefined && opts.opacity < 1,
    opacity: opts.opacity ?? 1,
  });
  return new THREE.Mesh(geom, mat);
}

export function placeAt(
  mesh: THREE.Object3D,
  cx: number,
  cy: number,
  cz: number,
): THREE.Object3D {
  mesh.position.set(cx, cy, cz);
  return mesh;
}

export function cylinder(
  radius: number,
  height: number,
  color: string,
  opts: { metalness?: number; roughness?: number; segments?: number } = {},
): THREE.Mesh {
  const geom = new THREE.CylinderGeometry(
    radius,
    radius,
    height,
    opts.segments ?? 24,
  );
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: opts.metalness ?? 0.5,
    roughness: opts.roughness ?? 0.4,
  });
  return new THREE.Mesh(geom, mat);
}

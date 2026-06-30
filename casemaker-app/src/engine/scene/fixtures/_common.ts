import * as THREE from 'three';
import type { Facing } from '@/types/board';

export interface FixtureSize {
  x: number;
  y: number;
  z: number;
}

/**
 * Issue #99 — connector orientation. Several fixtures (XLR-3, audio jack,
 * barrel jack, USB-A, RJ45, etc.) have asymmetric features along the
 * connector's BODY/DEPTH axis: the body cylinder runs along that axis, and
 * the receptacle / latch / pin pattern lives at the FRONT face. The depth
 * axis is determined by the component's `facing` field — for `-x` or `+x`
 * components depth runs along world X; for `±y` it runs along world Y;
 * for `+z` it runs vertically.
 *
 * This helper centralizes the per-facing math so every asymmetric fixture
 * orients itself the same way.
 */
export interface DepthAxis {
  /** Which world axis the body extends along. */
  axis: 'x' | 'y' | 'z';
  /** Length of the body along that axis (matches the corresponding `size` field). */
  length: number;
  /** True = body extends in the positive direction; false = negative. */
  positive: boolean;
  /** Half-extents perpendicular to the depth axis (for radial sizing). */
  perpSize: { wide: number; tall: number };
}

export function depthAxisForFacing(facing: Facing, size: FixtureSize): DepthAxis {
  switch (facing) {
    case '+x':
      return { axis: 'x', length: size.x, positive: true, perpSize: { wide: size.y, tall: size.z } };
    case '-x':
      return { axis: 'x', length: size.x, positive: false, perpSize: { wide: size.y, tall: size.z } };
    case '+y':
      return { axis: 'y', length: size.y, positive: true, perpSize: { wide: size.x, tall: size.z } };
    case '-y':
      return { axis: 'y', length: size.y, positive: false, perpSize: { wide: size.x, tall: size.z } };
    case '+z':
      return { axis: 'z', length: size.z, positive: true, perpSize: { wide: size.x, tall: size.y } };
    case '-z':
      return { axis: 'z', length: size.z, positive: false, perpSize: { wide: size.x, tall: size.y } };
  }
}

/** Bbox center in fixture-local coords (the corner is (0,0,0)). */
export function bboxCenter(size: FixtureSize): [number, number, number] {
  return [size.x / 2, size.y / 2, size.z / 2];
}

/**
 * Orient a Three.js cylinder (built along +Y) so its axis matches `depth.axis`.
 * Three.js CylinderGeometry runs along +Y by default; we rotate to align the
 * body axis with the chosen world axis.
 */
export function alignCylinderToDepth(cyl: THREE.Mesh, depth: DepthAxis): void {
  if (depth.axis === 'x') cyl.rotation.z = Math.PI / 2;
  else if (depth.axis === 'z') cyl.rotation.x = Math.PI / 2;
  // depth.axis === 'y' → no rotation (cylinder is already along +Y).
}

/**
 * Front-face center in fixture-local coords. `insetFromFront` ≥ 0 backs
 * off the point INTO the body by that distance — useful for placing a
 * recess that has its own depth (so the recess box sits just inside the
 * front face instead of crossing through it).
 */
export function frontFaceCenter(
  facing: Facing,
  size: FixtureSize,
  insetFromFront = 0,
): [number, number, number] {
  switch (facing) {
    case '+x':
      return [size.x - insetFromFront, size.y / 2, size.z / 2];
    case '-x':
      return [insetFromFront, size.y / 2, size.z / 2];
    case '+y':
      return [size.x / 2, size.y - insetFromFront, size.z / 2];
    case '-y':
      return [size.x / 2, insetFromFront, size.z / 2];
    case '+z':
      return [size.x / 2, size.y / 2, size.z - insetFromFront];
    case '-z':
      return [size.x / 2, size.y / 2, insetFromFront];
  }
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

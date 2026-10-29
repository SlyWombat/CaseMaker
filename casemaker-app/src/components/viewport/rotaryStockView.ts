/**
 * #716 — THE MAP WRAPPED BACK ONTO THE STOCK (design `rotary-flow.md` §3.7, R-UI-5 / R11).
 *
 * The design preview is drawn in the map frame: X millimetres along from the jaws, Y the arc at the
 * surface (`s = R·θ`), Z the height, 0 at the surface and negative into the material. The Stock view
 * shows the SAME opened regions on the cylinder, so both views are the one geometry: a map vertex
 * `(x, y, z)` becomes the stock point
 *
 *   θ = y / R,   r = R + z,   world = (x, r·sin θ, −R + r·cos θ)
 *
 * i.e. the seam `y = 0` sits at the TOP (where A homes, §9 row 4) and the map's two edges meet
 * there. Nothing is re-derived: the wrap is a coordinate change over the meshes the preview already
 * holds, which is why a stroke that merges on the map merges on the stock (R11).
 *
 * Pure geometry, no React: the viewport builds the wrapped geometry once per mesh and disposes it
 * with the map one (a scrub or a job edit replaces the mesh and must not leak its pair).
 */
import * as THREE from 'three';

/** One map point → one stock point. `z` is 0 at the surface and negative into the material. */
export function wrapMapPoint(
  x: number,
  y: number,
  z: number,
  radius: number,
): [number, number, number] {
  const theta = y / radius;
  const r = radius + z;
  return [x, r * Math.sin(theta), -radius + r * Math.cos(theta)];
}

/**
 * A wrapped COPY of `geometry` (the map geometry is left untouched for the Map view), with normals
 * recomputed: the map's flat +Z normals are not the cylinder's normals, and a wrapped face lit by
 * them would read inside-out.
 */
export function wrapMapGeometry(
  geometry: THREE.BufferGeometry,
  radius: number,
  /** #716 — paint a floor ON the surface: its depth is shown by its colour, on the rod's skin. */
  liftToSurface = false,
): THREE.BufferGeometry {
  const out = geometry.clone();
  const position = out.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const [x, y, z] = wrapMapPoint(
      position.getX(i),
      position.getY(i),
      liftToSurface ? 0 : position.getZ(i),
      liftToSurface ? radius + 0.05 : radius,
    );
    position.setXYZ(i, x, y, z);
  }
  position.needsUpdate = true;
  out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

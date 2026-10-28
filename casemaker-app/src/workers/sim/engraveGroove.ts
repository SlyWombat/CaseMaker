/**
 * The groove a V-bit TRACE actually leaves (#420 slice 4).
 *
 * A trace is one pass of the cutter's centre along a polyline, so what it removes is the cone
 * dragged along that line — not a cylinder. The preview used to extrude the trace's MOUTH footprint
 * straight down to the floor, which drew a straight-walled slot: too wide at the floor and missing
 * the taper the CAM and the simulator both cut. This module builds the real solid instead.
 *
 * THE ONE STATEMENT OF THE GEOMETRY is `vProfile.ts`. At a level `z` below the top face the cone's
 * reach is `grooveRadiusAt(cone, tipDepth - z)`: the tip plane sits `tipDepth` down and the level is
 * `tipDepth - z` above it. That is exactly the reach the oracle predicts with (`grooveRegionAt`)
 * and the column engine sweeps, so the picture cannot disagree with either about where the cone
 * cuts. No cone arithmetic is restated here.
 *
 * HOW THE SOLID IS BUILT. The cone swept along a polyline is the union of:
 *
 *   - a trapezoidal PRISM along each straight run: the run's cross-section perpendicular to it is
 *     a rectangle whose half-width grows from the tip radius at the floor to the mouth at the top,
 *     and extruding that trapezoid along the run is exactly the rectangle part of every capsule;
 *   - a truncated CONE at each path point: the round cap the cutter leaves at a vertex, at every
 *     level.
 *
 * That is the same decomposition `traceSweptProfile` uses in 2D (each segment's capsule is the hull
 * of two equal discs), lifted into 3D. The union over a path is therefore the Minkowski sum of the
 * polyline with the cone — the true swept groove.
 *
 * OWNERSHIP: every `CrossSection` and intermediate `Manifold` is `.delete()`d here. The returned
 * body is the caller's to subtract and delete, like every cut body in `engravePreview`.
 */

import { coneHeight, grooveRadiusAt, type VCone } from '@/engine/cnc/vProfile';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type Point = readonly [number, number];

/**
 * The solid a V trace removes, in the work frame, or `null` when there is nothing to sweep.
 *
 * `tipDepth` is the trace's own depth below the top face (the tip plane), positive. `overshoot`
 * lifts the top of the body past Z = 0 so the preview's subtraction never meets a coplanar face,
 * exactly as the straight cuts do; it does not change the groove below the face.
 */
export function vGrooveSolid(
  tl: ManifoldToplevel,
  paths: readonly (readonly Point[])[],
  closed: readonly boolean[],
  cone: VCone,
  tipDepth: number,
  overshoot: number,
): ManifoldInstance | null {
  if (!(tipDepth > 0) || !Number.isFinite(tipDepth)) return null;
  if (!(overshoot >= 0) || !Number.isFinite(overshoot)) return null;
  if (paths.length === 0) return null;

  // The cone's reach at its floor and at the solid's top, both from the one module. The top is
  // above the face, where the cone is wider than the mouth by `overshoot·tanHalf`.
  const floorRadius = grooveRadiusAt(cone, 0);
  const topRadius = grooveRadiusAt(cone, tipDepth + overshoot);
  if (!(topRadius > 0)) return null;

  const height = tipDepth + overshoot;
  // #741 — THE FLANK ENDS AT THE BIT'S BODY. `grooveRadiusAt` caps the reach there, but the shape
  // between the floor and the top must cap too: above the height where the cone meets the body
  // (`coneHeight`) the bit cuts a VERTICAL wall at `outerRadius`, not a continued taper. A single
  // trapezoid from the tip to the (capped) top would be a shallower cone than the real one.
  const bodyRadius = cone.outerRadius;
  const flank = coneHeight(cone);
  const wall =
    bodyRadius !== undefined && flank !== null && flank < height
      ? { radius: bodyRadius, at: flank }
      : null;
  const segments = segmentsForRadius(topRadius);
  const pieces: ManifoldInstance[] = [];

  /** The cap at one path point: the cone the cutter turns on, plus its body above it. */
  const coneAt = (p: Point): void => {
    if (wall === null) {
      // `radiusLow` must be positive, so the cone is built mouth-down and turned over: the cylinder
      // constructor then takes the wide radius it requires and the tip radius may be zero.
      const body = tl.Manifold.cylinder(height, topRadius, floorRadius, segments, false);
      const turned = body.rotate([180, 0, 0]);
      body.delete();
      const placed = turned.translate([p[0], p[1], height - tipDepth]);
      turned.delete();
      pieces.push(placed);
      return;
    }
    // The flank, from the floor up to the body at `flank` above the tip plane.
    const coneLow = tl.Manifold.cylinder(wall.at, wall.radius, floorRadius, segments, false);
    const coneTurned = coneLow.rotate([180, 0, 0]);
    coneLow.delete();
    const conePlaced = coneTurned.translate([p[0], p[1], wall.at - tipDepth]);
    coneTurned.delete();
    pieces.push(conePlaced);
    // The body's cylindrical wall, from there to the solid's top.
    const upper = tl.Manifold.cylinder(height - wall.at, wall.radius, wall.radius, segments, false);
    const upperTurned = upper.rotate([180, 0, 0]);
    upper.delete();
    const upperPlaced = upperTurned.translate([p[0], p[1], height - tipDepth]);
    upperTurned.delete();
    pieces.push(upperPlaced);
  };

  /** The trapezoidal prism along one straight run — the rectangle part of its capsule. */
  const prism = (a: Point, b: Point): void => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (!(length > 0)) return;
    const ux = dx / length;
    const uy = dy / length;
    // The perpendicular in XY. Its sign is immaterial: the profile is symmetric about the run.
    const nx = -uy;
    const ny = ux;

    // Perpendicular coordinate p and Z q. A zero tip is a TRIANGLE: the profile closes to a point at
    // the floor, which is what a sharp V leaves there. A positive tip is the trapezoid. #741 — with
    // the wall binding, the flank stops at the body and the profile continues vertically.
    const profile: [number, number][] =
      wall !== null
        ? floorRadius > 0
          ? [
              [-floorRadius, -tipDepth],
              [floorRadius, -tipDepth],
              [wall.radius, wall.at - tipDepth],
              [wall.radius, overshoot],
              [-wall.radius, overshoot],
              [-wall.radius, wall.at - tipDepth],
            ]
          : [
              [0, -tipDepth],
              [wall.radius, wall.at - tipDepth],
              [wall.radius, overshoot],
              [-wall.radius, overshoot],
              [-wall.radius, wall.at - tipDepth],
            ]
        : floorRadius > 0
          ? [
              [-floorRadius, -tipDepth],
              [floorRadius, -tipDepth],
              [topRadius, overshoot],
              [-topRadius, overshoot],
            ]
          : [
              [0, -tipDepth],
              [topRadius, overshoot],
              [-topRadius, overshoot],
            ];

    const cs = tl.CrossSection.ofPolygons([profile], 'Positive');
    const extruded = tl.Manifold.extrude(cs, length);
    cs.delete();
    // Local X is the perpendicular, local Y is world Z, and the extrusion axis is the run. Columns
    // are the images of the local basis, so local (p, q, s) maps to p·n + q·Z + s·u + a.
    const placed = extruded.transform([nx, ny, 0, 0, 0, 0, 1, 0, ux, uy, 0, 0, a[0], a[1], 0, 1]);
    extruded.delete();
    pieces.push(placed);
  };

  for (let pi = 0; pi < paths.length; pi++) {
    const path = paths[pi]!;
    const n = path.length;
    if (n === 0) continue;
    // Every vertex is a cap. A one-point path (a plunge dot) is that cap alone.
    for (const p of path) coneAt(p);
    if (n === 1) continue;
    const last = (closed[pi] ?? false) ? n : n - 1;
    for (let i = 0; i < last; i++) prism(path[i]!, path[(i + 1) % n]!);
  }

  if (pieces.length === 0) return null;
  if (pieces.length === 1) return pieces[0]!;
  const solid = tl.Manifold.union(pieces);
  for (const piece of pieces) piece.delete();
  return solid;
}

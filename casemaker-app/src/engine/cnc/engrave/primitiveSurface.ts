/**
 * #786 slice 4a-2 — A CONE OR A SPHERE IS A SURFACE, NOT A REGION.
 *
 * The region CAM cuts walls parallel to the cutter axis, so a sloped cone wall and a curved
 * sphere floor cannot be a flat-floor pocket. Both are exactly described by an analytic
 * top-Z field, though, and the 3D surfacing CAM (`cam/surface3d`) already cuts one: this module
 * turns the primitive into the same {@link GoalHeightfield} a goal mesh samples into, so the
 * roughening/finishing passes, the surface check and the sweep are the goal program's own — not a
 * second approximation of a surface.
 *
 * WORK FRAME (the goal sampler's contract): the stock top is work Z 0 and the field stores the
 * TOP of the material per column, so a cavity's cells hold NEGATIVE Z and the stock around it
 * holds `topZ`. The primitive's `position` is its centre in work XY; `depth` is how far below the
 * top face it reaches. Rotation is not read: both shapes are rotationally symmetric about Z.
 *
 *   - CONE: wide `diameter` at the top face (z = 0 at ρ = R) tapering to `tipDiameter` at
 *     `depth` (z = −d at ρ = r). Inside the tip's own disc the floor is flat at −d.
 *       z(ρ) = −d·(R − ρ)/(R − r),  r ≤ ρ ≤ R
 *   - SPHERE: a cap of the ball of `diameter` D, cut `depth` deep from the top face. The ball's
 *     centre is at −(R − d) and the rim is where the surface reaches z = 0 again:
 *     ρmax = √(R² − (R − d)²).
 *       z(ρ) = −(√(R² − ρ²) − (R − d)),  ρ ≤ ρmax
 *
 * Cells outside the footprint are the sentinel `topZ` (nothing to remove there), exactly as a goal
 * mesh's uncovered cells are.
 */

import { DEFAULT_GRID_PITCH_MM, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import type { EngraveConePrimitive, EngraveJob, EngravePrimitive, EngraveSpherePrimitive } from '@/types/engraveJob';

/** The two shapes the flat region CAM cannot cut and the surface CAM can. */
export type SurfacePrimitive = EngraveConePrimitive | EngraveSpherePrimitive;

/**
 * The enabled, top-facing cone/sphere primitives of a job, in the document's order. An axis the
 * surface CAM does not cut (X or Y) stays out — a side-opening undercut keeps its existing
 * warning and is not silently approached from above.
 */
export function surfacePrimitivesOf(job: EngraveJob): SurfacePrimitive[] {
  return (job.primitives ?? []).filter(
    (p): p is SurfacePrimitive =>
      p.enabled && (p.kind === 'cone' || p.kind === 'sphere') && (p.axis ?? 'z') === 'z',
  );
}

/** True for an item id that names one of those primitives. */
export function isSurfacePrimitiveId(job: EngraveJob, id: string): boolean {
  return surfacePrimitivesOf(job).some((p) => p.id === id);
}

/** The cavity's radius at `rho` from the axis, as the surface's own Z (work frame). */
function coneZ(R: number, r: number, d: number, rho: number): number | null {
  if (rho <= r) return -d;
  if (rho > R) return null;
  return -d * ((R - rho) / (R - r));
}

function sphereZ(R: number, d: number, rho: number): number | null {
  // The rim is where the cap meets the top face. `d ≤ 2R` holds for a cap of this ball; a record
  // outside it has no rim on the top face and states no surface this module can stand behind.
  const rim = Math.sqrt(Math.max(0, R * R - (R - d) * (R - d)));
  if (rho > rim) return null;
  return -(Math.sqrt(Math.max(0, R * R - rho * rho)) - (R - d));
}

/** Is this record's geometry a surface at all? A zero radius or a non-positive depth is not. */
export function surfacePrimitiveUsable(p: SurfacePrimitive): boolean {
  if (!(p.depth > 0)) return false;
  const R = p.diameter / 2;
  if (!(R > 0)) return false;
  if (p.kind === 'cone') {
    const r = p.tipDiameter / 2;
    return r >= 0 && r < R;
  }
  return p.depth <= p.diameter;
}

/**
 * The analytic top-Z field for one primitive, on the goal sampler's grid: the same requested
 * pitch (`sim.columnFlatPitchYMm`, else the 0.1 mm default), the same 4 000 000-cell cap with the
 * pitch coarsened rather than the job refused, and the same resolution sentence.
 *
 * `null` when the record is not a surface (see {@link surfacePrimitiveUsable}).
 */
export function primitiveHeightfield(
  primitive: SurfacePrimitive,
  opts: { pitchMm?: number | null; maxCells: number; stockTopZ?: number },
): GoalHeightfield | null {
  if (!surfacePrimitiveUsable(primitive)) return null;
  const R = primitive.diameter / 2;
  const d = primitive.depth;
  const topZ = opts.stockTopZ ?? 0;
  const requested = opts.pitchMm !== null && opts.pitchMm !== undefined && opts.pitchMm > 0 ? opts.pitchMm : DEFAULT_GRID_PITCH_MM;
  const maxCells = opts.maxCells;

  // The footprint, plus one cell of margin so the rim's zero-cells are inside the grid.
  const rim =
    primitive.kind === 'cone' ? R : Math.sqrt(Math.max(0, R * R - (R - d) * (R - d)));
  const cx = primitive.position.x;
  const cy = primitive.position.y;
  const extent = 2 * (rim + requested);
  let pitch = requested;
  let nx = Math.max(1, Math.ceil(extent / pitch) + 1);
  let ny = nx;
  let coarsened = false;
  if (nx * ny > maxCells) {
    pitch = requested * Math.sqrt((nx * ny) / maxCells);
    nx = Math.max(1, Math.ceil(extent / pitch) + 1);
    ny = nx;
    coarsened = true;
  }
  const x0 = cx - (nx - 1) * pitch * 0.5;
  const y0 = cy - (ny - 1) * pitch * 0.5;

  const z = new Float32Array(nx * ny);
  z.fill(topZ);
  const covered = new Uint8Array(nx * ny);
  let coveredCount = 0;
  let minZ = topZ;
  for (let j = 0; j < ny; j++) {
    const y = y0 + j * pitch;
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * pitch;
      const rho = Math.hypot(x - cx, y - cy);
      const cellZ =
        primitive.kind === 'cone'
          ? coneZ(R, primitive.tipDiameter / 2, d, rho)
          : sphereZ(R, d, rho);
      if (cellZ === null) continue;
      const k = j * nx + i;
      z[k] = cellZ;
      covered[k] = 1;
      coveredCount += 1;
      if (cellZ < minZ) minZ = cellZ;
    }
  }

  const resolutionNote = coarsened
    ? `sampled on a ${pitch.toFixed(4)} mm grid (coarsened from the requested ${requested} mm: ` +
      `the footprint would need ${Math.ceil(extent / requested) ** 2} cells, over the ${maxCells}-cell cap)`
    : `sampled on a ${pitch} mm grid`;

  return { nx, ny, x0, y0, pitch, topZ, minZ, z, covered, coveredCount, resolutionNote };
}

/**
 * #786 slice 4a-2 — THE SURFACE NEEDS A BALL FOR A TRUE FINISH. A flat end mill can cut a stepped
 * approximation from the same field (the CAM's own note says so); a ball follows the curve. This
 * is the smallest radius of curvature the field has, which is the ball radius that can reach every
 * point of it: the cone's tip radius (a wider ball bridges the floor's rim) and the sphere's own
 * ball radius (a wider ball bottoms out early).
 */
export function surfaceCurvatureRadius(p: SurfacePrimitive): number {
  return p.kind === 'cone' ? Math.min(p.tipDiameter / 2, p.diameter / 2) : p.diameter / 2;
}

/** One owned ball cutter a shop could cut `primitive` with: its key, name and radius. */
export interface SurfaceBallOffer {
  key: string;
  name: string;
  radius: number;
}

/**
 * The ball to OFFER for this surface (#786 4a-2, the smart-selection rule): among the shop's own
 * ball cutters that fit the curvature (radius ≤ the surface's smallest radius of curvature), the
 * LARGEST — it clears fastest and its finish is the finest the shape allows. Owned (`inv:`) first,
 * then the house's definitions; a catalogue row is not a cutter in the drawer. Null when none
 * fits: the owner cutter cuts the surface as it is, and the finding says what the finish will be.
 */
export function surfaceBallOffer(
  primitive: SurfacePrimitive,
  entries: readonly { key: string; tool: { shape: string; name: string; tipDiameter: number | null; diameter: number | null } }[],
): SurfaceBallOffer | null {
  const limit = surfaceCurvatureRadius(primitive);
  let best: SurfaceBallOffer | null = null;
  for (const entry of entries) {
    if (entry.key.startsWith('cat:')) continue;
    if (entry.tool.shape !== 'ball' && entry.tool.shape !== 'bull') continue;
    const radius = (entry.tool.tipDiameter ?? entry.tool.diameter ?? 0) / 2;
    if (!(radius > 0) || radius > limit + 1e-9) continue;
    if (best === null || radius > best.radius) best = { key: entry.key, name: entry.tool.name, radius };
  }
  return best;
}

/** The primitive's own name for a sentence, matching `primitiveLabel`. */
export function surfacePrimitiveWord(p: SurfacePrimitive): string {
  const named = p.name ? ` "${p.name}"` : '';
  return p.kind === 'cone'
    ? `Cone${named} ⌀${p.diameter}→⌀${p.tipDiameter}`
    : `Sphere${named} ⌀${p.diameter}`;
}

/** True for a primitive whose kind is one of the surface kinds (used by other modules' tests). */
export function isSurfacePrimitive(p: EngravePrimitive): p is SurfacePrimitive {
  return p.kind === 'cone' || p.kind === 'sphere';
}

/**
 * #822 — THE CAVITY'S CROSS-SECTION, for the preview picture: the material the surface program
 * removes, as a closed polygon in (radius, depth-below-the-top) — the form Manifold's revolve
 * takes (it turns a cross-section about the Y axis into a solid about Z). The caller revolves it
 * and turns it over so the cavity opens at the stock's top face.
 *
 *   - CONE: the top face from the axis to the rim, down the flank to the tip's disc, and back
 *     along the floor to the axis.
 *   - SPHERE: the top face to ρmax, then the cap's arc down to its floor at the axis.
 *
 * `null` for a record that is not a surface (see {@link surfacePrimitiveUsable}).
 */
export function primitiveCavityProfile(p: SurfacePrimitive): [number, number][] | null {
  if (!surfacePrimitiveUsable(p)) return null;
  const R = p.diameter / 2;
  const d = p.depth;
  if (p.kind === 'cone') {
    return [
      [0, 0],
      [R, 0],
      [p.tipDiameter / 2, d],
      [0, d],
    ];
  }
  const rim = Math.sqrt(Math.max(0, R * R - (R - d) * (R - d)));
  const profile: [number, number][] = [
    [0, 0],
    [rim, 0],
  ];
  const samples = 48;
  for (let i = 1; i < samples; i++) {
    const rho = rim * (1 - i / samples);
    profile.push([rho, Math.sqrt(Math.max(0, R * R - rho * rho)) - (R - d)]);
  }
  profile.push([0, d]);
  return profile;
}

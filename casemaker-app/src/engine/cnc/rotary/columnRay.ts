/**
 * engine/cnc/rotary/columnRay.ts — THE CUTTER'S OWN GEOMETRY ON A COLUMN RAY, moved here from
 * `workers/geometry/columnEngine.ts` (#1164 slice a) so the PLANNER and the column sweep read ONE
 * derivation. The import gate forbids cam -> workers; this module is the extraction the analyst's
 * design note names, and `columnEngine.ts` imports it back and re-exports the same names, so every
 * existing consumer is unchanged. Pure math — no worker state, no imports.
 */

/**
 * The cutter a column sweep removes material with (#405).
 *
 * A FLAT end mill is a disc of `radius` at the tip plane — the whole of V1 until #405. A V-bit is
 * a CONE: the same flat tip of `radius`, then a flank rising at `1/tanHalf` away from the axis, so
 * the floor a move leaves at a column depends on how far that column is from the tool's path. The
 * exact 2.5D sweeper has no form for that (`cuttingRadiusForSweep` refuses it by name); here it is
 * a height profile over the disc, which is exactly what a column grid holds.
 */
export interface ColumnCutter {
  /** Cutting radius at the tip plane, mm. */
  radius: number;
  /** The cone's rise per mm of radial distance, or `null` for a flat end (a level floor). */
  tanHalf: number | null;
  /**
   * The cone's OUTER radius, mm, where it meets the cutter's cylindrical body — or absent for a cone
   * with no stated end (a V-bit, #405, whose flank is taken to run to the top face). A DRILL has one
   * (#382): its point is a cone from a sharp tip out to the drill's radius, and past that radius the
   * drill is a wall, so nothing beyond it is cut however deep the tip goes. Ignored for a flat end,
   * whose `radius` already is its outer edge. For a THREAD MILL (#445) it is the padded footprint
   * bound: the tooth's tip radius plus the engine's half-cell widening.
   */
  outerRadius?: number;
  /**
   * A THREAD MILL's tooth root radius, mm (#445): the radius where the 60° tooth meets the reduced
   * neck. At or inside it the cutter is its neck — a level floor at the tip plane; between it and
   * `radius` the tooth's flank rises INWARD, away from the wall, which is the opposite slope to a
   * V-bit. Absent for every other cutter.
   */
  toothRootRadius?: number;
  /**
   * A ROUNDED tip's corner-arc radius, mm (#532): a BALL nose or a BULL nose. Inside `radius` the
   * floor is flat at the tip plane; from `radius` out to `radius + cornerRadius` (= `outerRadius`)
   * it follows a quarter-round of this radius — the torus/sphere surface — and past `outerRadius`
   * the cutter is its cylindrical body, so nothing beyond is cut. A BALL is the special case
   * `radius = 0`, `cornerRadius = outerRadius = R` (a hemisphere of the tool radius); a BULL has
   * `radius = R − cornerRadius`. Absent for every other cutter, and never set together with
   * `toothRootRadius` or a non-null `tanHalf`.
   */
  cornerRadius?: number;
}

/**
 * #763 — THE FLOOR a cutter leaves on one column of the rotary grid, given the tool's tip height
 * `zt` (radius above the axis), the column's angular offset φ from the tool (radians) and its
 * axial offset `dx`. The column is the ray `(dx, u·sinφ, u·cosφ)` for u ≥ 0; the cutter's body
 * occupies a set of those points and the smallest u inside it is the floor. The flat's disc
 * reproduces the model the engine has always used exactly (its plane lies at the tip's height, so
 * the ray meets it at `zt/cosφ` and the disc's reach there is `dx² + (zt·tanφ)²`), which is why
 * adding a body here cannot move a flat job.
 */
export function cutterFloorOnColumn(cutter: ColumnCutter, zt: number, phiRad: number, dx: number): number | null {
  const cos = Math.cos(phiRad);
  const sin = Math.sin(phiRad);
  if (!(cos > 1e-9) || !(zt > 0)) return null;
  // BALL (#532/#763): the sphere of R centred on the tool axis at zt + R.
  if (cutter.cornerRadius !== undefined) {
    const R = cutter.cornerRadius;
    if (!(R > 0)) return null;
    const c = zt + R;
    const disc = c * c * cos * cos - (dx * dx + zt * zt + 2 * zt * R);
    if (disc < 0) return null;
    const u = c * cos - Math.sqrt(disc);
    if (!(u > 0)) return null;
    // Past the ball's own radius there is the shank, not the cap.
    if (Math.hypot(dx, u * sin) > (cutter.outerRadius ?? R) + 1e-9) return null;
    return u;
  }
  // FLAT: the disc at the tip's plane, exactly as before.
  if (cutter.tanHalf === null) {
    const dy = zt * Math.tan(phiRad);
    if (dx * dx + dy * dy > cutter.radius * cutter.radius) return null;
    return zt / cos;
  }
  // V (#405/#763): the flat tip first — under it the floor is the tip's plane.
  const tipFloor = zt / cos;
  if (Math.hypot(dx, tipFloor * sin) <= cutter.radius + 1e-12) return tipFloor;
  const k = cutter.tanHalf;
  const b = cutter.radius - zt * k;
  const A = sin * sin - cos * cos * k * k;
  const B = -2 * cos * k * b;
  const C = dx * dx - b * b;
  const roots: number[] = [];
  if (Math.abs(A) < 1e-12) {
    if (Math.abs(B) > 1e-12) roots.push(-C / B);
  } else {
    const disc = B * B - 4 * A * C;
    if (disc >= 0) {
      roots.push((-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A));
    }
  }
  roots.sort((p, q) => p - q);
  for (const u of roots) {
    if (!(u > tipFloor - 1e-9)) continue;
    const S = k * (u * cos - zt) + cutter.radius;
    if (S < -1e-9) continue;
    if (cutter.outerRadius !== undefined && Math.hypot(dx, u * sin) > cutter.outerRadius + 1e-9) continue;
    return u;
  }
  return null;
}


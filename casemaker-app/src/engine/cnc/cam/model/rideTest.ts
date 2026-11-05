/**
 * rideTest.ts — THE RIDE TEST FOR A JOIN OVER A CUT SURFACE (#962; shared by the ops and, per the
 * manager's 2026-11-05 coordination, D's row-end leg-join for the flat ops, the rest, the skin and
 * the flat raster).
 *
 * A stay-down join may travel at the op's own cut z only where the surface the op is cutting says
 * it is clear along the path — not merely at the endpoints. The test samples the join's CENTRE
 * line against the surface's own top at each sample (the caller supplies `topAt`, which answers
 * null where the surface has no reach) and requires:
 *
 *  - KIRI:MOTO'S SHORT HOP: the join is no longer than the caller's cap (2 x the cutter's
 *    diameter for the ops' own joins). B's review of e3f25fc7 found a long ride approved purely
 *    on its centre samples; the cap lives HERE, inside the test, so every caller gets it.
 *  - the surface answers at every sample (a null is no proof; the join retracts), and
 *  - the join's interpolated z is at or above the surface's top at each sample (within the
 *    surface's own tolerance) — a path that dips below the surface would cut into the design.
 *
 * THE CALLER'S SURFACE IS THE DESIGN BOUND, NOT THE STOCK: for the finish the surface is the
 * cutter's own CL, for the skim it is the CL the skim cuts to. Material standing ABOVE the surface
 * (the band the op exists to remove) is what the join cuts at its cutting feed — the same cut the
 * passes either side of it make.
 */

export interface RidePoint {
  x: number;
  y: number;
  z: number;
}

/**
 * True when a join from `from` to `to` may stay down: within the short hop, over a surface that
 * answers all the way, never dipping below it.
 */
export function ridesCutSurface(
  from: RidePoint,
  to: RidePoint,
  topAt: (x: number, y: number) => number | null,
  toleranceMm: number,
  shortHopMm: number,
  pitchMm: number,
): boolean {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  if (length > shortHopMm + 1e-9) return false;
  const steps = Math.max(1, Math.ceil(length / Math.max(pitchMm, 1e-9)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const top = topAt(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t);
    if (top === null) return false;
    const z = from.z + (to.z - from.z) * t;
    if (z < top - toleranceMm) return false;
  }
  return true;
}

/**
 * #1215 (planner v3, slice 2) — FLAT REACH BY DIAMETER.
 *
 * For a region and a list of flat-cutter diameters: what each diameter can clear, and what a
 * smaller diameter adds over the next larger one. A round cutter of diameter d clears the region
 * shrunk by d/2 and grown back by d/2 (the morphological opening): narrow necks and sharp inside
 * corners are what it cannot reach.
 *
 * `fullyReachable` is the existing opening; the offset is INJECTED (`OffsetFn`) so this module
 * carries no geometry kernel and is exercised in node with the real Clipper offset.
 */
import type { OffsetFn, Polygons } from '../pocket';
import { signedArea } from '../profile';
import { fullyReachable } from '../model/ops/pocket';

/** Area of a region, mm²: outer contours count positive, holes negative. Never below 0. */
export function polygonsArea(region: Polygons): number {
  let sum = 0;
  for (const contour of region) sum += signedArea(contour);
  return Math.max(0, sum);
}

export interface ReachStep {
  diameterMm: number;
  /** The part of the region a flat cutter of this diameter can clear. */
  reach: Polygons;
  areaMm2: number;
  /** areaMm2 minus the next LARGER diameter's areaMm2 (its own area for the largest). Never below 0. */
  addedAreaMm2: number;
}

/**
 * The area each diameter can clear in `region`, LARGEST diameter first. Diameters that are not
 * finite or not above 0 are dropped; equal diameters (within 1e-9) appear once.
 */
export function flatReach(region: Polygons, diametersMm: readonly number[], offset: OffsetFn): ReachStep[] {
  const sorted = diametersMm.filter((d) => Number.isFinite(d) && d > 0).sort((a, b) => b - a);
  const diameters: number[] = [];
  for (const d of sorted) {
    const previous = diameters[diameters.length - 1];
    if (previous === undefined || Math.abs(previous - d) > 1e-9) diameters.push(d);
  }
  if (region.length === 0) {
    return diameters.map((diameterMm) => ({ diameterMm, reach: [], areaMm2: 0, addedAreaMm2: 0 }));
  }
  const steps: ReachStep[] = diameters.map((diameterMm) => {
    const reach = fullyReachable(region, offset, diameterMm / 2);
    return { diameterMm, reach, areaMm2: polygonsArea(reach), addedAreaMm2: 0 };
  });
  // A smaller cutter reaches at least what a larger one does; the kernel's rounding can break that
  // by a hair, so the areas are made monotone — the reach itself is never changed.
  for (let k = 1; k < steps.length; k++) {
    const previous = steps[k - 1]!;
    const step = steps[k]!;
    if (step.areaMm2 < previous.areaMm2) step.areaMm2 = previous.areaMm2;
  }
  for (let k = 0; k < steps.length; k++) {
    const step = steps[k]!;
    const previous = k === 0 ? 0 : steps[k - 1]!.areaMm2;
    step.addedAreaMm2 = Math.max(0, step.areaMm2 - previous);
  }
  return steps;
}

/** The total length of every contour of a region, mm (each contour closed back to its first point). */
export function polygonsPerimeter(region: Polygons): number {
  let total = 0;
  for (const contour of region) {
    for (let k = 0; k < contour.length; k++) {
      const a = contour[k]!;
      const b = contour[(k + 1) % contour.length]!;
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
  }
  return total;
}

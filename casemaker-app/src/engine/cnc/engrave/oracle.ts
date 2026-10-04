/**
 * The volumetric oracle (#206, `/Simulation.md` §7). The last gate before a `.nc` is offered for
 * download: it compares what the SIMULATION removed against what the CAM PREDICTED, level by
 * level, and refuses the file when they disagree by more than the tolerance the pipeline's own
 * two approximations can explain.
 *
 * The prediction is the union of the OPENED regions of every item whose depth reaches a level —
 * the reachable region of a glyph for a given tool radius (`engravableProfile`, the morphological
 * opening `offset(offset(G, -r), +r)`). The simulation is the sweep's cumulative `removal` solid,
 * sliced just above the level's floor Z. At a level with floor Z, the removal region is every
 * point the tool cut at or below Z; the predicted region is every point a cut SHOULD reach at that
 * level. They are the same set up to two tolerances.
 *
 * The band is DERIVED, never hand-set (the whole point of `ARC_CHORD_TOLERANCE_MM`'s doc): the
 * sweep simplifies each union tree with `SWEEP_SIMPLIFY_EPS_MM` once per chunk and once per tree
 * level, and both the profile and the removal carry one arc-chord flattening each. So
 *
 *   band = levels x SWEEP_SIMPLIFY_EPS_MM + 2 x ARC_CHORD_TOLERANCE_MM
 *
 * A difference inside the band is expected float/approximation drift; a difference outside it is
 * a CAM bug — too coarse a step-over (the #191 rule, stepOver <= tool radius) leaves an uncut
 * spine, and the under-cut is exactly that spine's area.
 */

import { ARC_CHORD_TOLERANCE_MM, SWEEP_SIMPLIFY_EPS_MM, segmentsForRadius } from '@/engine/compiler/arcResolution';
import { SWEEP_TOLERANCES } from '@/workers/geometry/sweep';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';

type ManifoldInstance = InstanceType<ManifoldToplevel['Manifold']>;
type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

/** A closed 2D polygon in the work frame, mm. */
export type OraclePolygon = [number, number][];

/** One item's predicted region at one depth (the opened region of a glyph or a shape). */
export interface OraclePredicted {
  /** Floor of this item's cut, depth below the stock top face, mm (positive). */
  depth: number;
  /** Outer contours CCW and holes CW, as `measureLabels` / `toPartPlan` produce them. */
  polygons: OraclePolygon[];
}

/** The comparison at one distinct floor Z. */
export interface OracleLevel {
  /**
   * The floor in the WORK frame, mm. The work origin is the stock's top face, so a cut is at
   * NEGATIVE Z: `z = -depth`. This is the value `removal.slice(z + 0.001)` uses.
   */
  z: number;
  /** Area the prediction says is cut at this level, mm². */
  predictedArea: number;
  /** Area the simulation removed at this level, mm². */
  simulatedArea: number;
  /** Predicted but not simulated: area the file FAILED to cut, mm². */
  underCut: number;
  /** Simulated but not predicted: area the file cut OUTSIDE the plan, mm². */
  overCut: number;
}

export interface OracleReport {
  ok: boolean;
  /** The derived tolerance used, mm. */
  band: number;
  levels: OracleLevel[];
  /** The worst under- and over-cut over every level, mm². */
  worst: { underCut: number; overCut: number };
}

/**
 * Areas below this are slivers: a `subtract` of two coincident boundaries leaves a
 * floating-point-thin ring with a tiny non-zero area. Not a CAM defect. mm².
 */
export const ORACLE_AREA_FLOOR = 1e-3;

/** Slice this far ABOVE a floor Z so the slice is inside the pocket cut toward that floor, mm. */
export const ORACLE_SLICE_LIFT_MM = 0.001;

/** The derived oracle band for a sweep whose worst checkpoint saw `contours` 2D contours. */
export function oracleBand(contours: number): number {
  return SWEEP_TOLERANCES.simplifyLevels(contours) * SWEEP_SIMPLIFY_EPS_MM + 2 * ARC_CHORD_TOLERANCE_MM;
}

/**
 * Compare `removal` (the sweep's cumulative removal solid) against `predicted`, level by level.
 * Every CrossSection it makes is deleted exactly once, on both the success and the throw path.
 */
export function computeOracle(
  tl: ManifoldToplevel,
  removal: ManifoldInstance,
  predicted: readonly OraclePredicted[],
  band: number,
): OracleReport {
  const CS = tl.CrossSection;
  // The offsets are by `band` itself, so the arc being flattened has radius ≈ band.
  const roundSegments = segmentsForRadius(band);

  // One level per distinct depth that actually carries geometry. Ascending so the report reads
  // shallow-first, matching the stock.
  const depths = [...new Set(predicted.filter((p) => p.polygons.length > 0 && p.depth > 0).map((p) => p.depth))].sort((a, b) => a - b);

  const levels: OracleLevel[] = [];
  let worstUnder = 0;
  let worstOver = 0;

  for (const depth of depths) {
    // The work-frame floor Z: the origin is the top face, so a cut is at NEGATIVE Z.
    const z = -depth;
    // The predicted region at this level: every item whose floor is at or below it. Union of
    // CrossSections (not one ofPolygons of concatenated contours) so a hole inside one item is
    // preserved when another item overlaps it.
    const parts: CrossSectionInstance[] = [];
    for (const p of predicted) {
      if (p.depth + 1e-9 >= depth && p.polygons.length > 0) parts.push(CS.ofPolygons(p.polygons));
    }
    if (parts.length === 0) continue;

    let predictedCS: CrossSectionInstance;
    if (parts.length === 1) {
      predictedCS = parts[0] as CrossSectionInstance;
      parts.length = 0; // ownership moved to predictedCS
    } else {
      predictedCS = CS.union(parts);
      for (const p of parts) p.delete();
    }

    const shrunk = predictedCS.offset(-band, 'Round', 2, roundSegments);
    const grown = predictedCS.offset(band, 'Round', 2, roundSegments);
    const sliceCS = removal.slice(z + ORACLE_SLICE_LIFT_MM);

    const predictedArea = predictedCS.area();
    const simulatedArea = sliceCS.area();

    const underCS = CS.difference([shrunk, sliceCS]);
    const overCS = CS.difference([sliceCS, grown]);
    const underCut = Math.max(0, underCS.area());
    const overCut = Math.max(0, overCS.area());

    underCS.delete();
    overCS.delete();
    sliceCS.delete();
    shrunk.delete();
    grown.delete();
    predictedCS.delete();

    levels.push({ z, predictedArea, simulatedArea, underCut, overCut });
    if (underCut > worstUnder) worstUnder = underCut;
    if (overCut > worstOver) worstOver = overCut;
  }

  return {
    ok: worstUnder <= ORACLE_AREA_FLOOR && worstOver <= ORACLE_AREA_FLOOR,
    band,
    levels,
    worst: { underCut: worstUnder, overCut: worstOver },
  };
}

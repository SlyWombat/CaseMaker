/**
 * The oracle's plain shapes and its area floor, in a module that imports no CAM (#924, #956 R1).
 *
 * `oracle.ts` compares the simulation with the CAM's own predicted regions, so by design it reads
 * the CAM's cone (`vProfile.ts`) and sweep (`partPlan.ts`). The design check (`designCheck.ts`) is
 * part of the independent gate and needs only these shapes and the floor. While they lived in
 * `oracle.ts`, importing them pulled the CAM's geometry into the gate's value-import closure
 * (`tests/unit/gateImports.spec.ts`). They live here now. `oracle.ts` re-exports them, so its
 * importers are unchanged.
 *
 * Keep this module free of value imports: the gate's independence spec walks it.
 */

import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';

type CrossSectionInstance = InstanceType<ManifoldToplevel['CrossSection']>;

/** A point in the work frame, mm. */
export type OraclePoint = [number, number];

/** An axis-aligned region in the work frame, mm. */
export interface OracleBbox {
  min: OraclePoint;
  max: OraclePoint;
}

/** A closed contour in the work frame, mm: outer contours CCW and holes CW. */
export type OraclePolygon = OraclePoint[];

/**
 * Areas below this are slivers: a `subtract` of two coincident boundaries leaves a
 * floating-point-thin ring with a tiny non-zero area. Not a CAM defect. mm².
 */
export const ORACLE_AREA_FLOOR = 1e-3;

/**
 * #580 — the resolution-aware floor's cell count. The column engine cannot resolve a region
 * smaller than its grid cell, so a "worst under-cut" of one dexel is a disagreement, not material
 * left standing. The verdict uses the greater of {@link ORACLE_AREA_FLOOR} and the grid's cell
 * area × this count — a 2×2 cell block, the smallest region the grid can actually represent.
 */
export const ORACLE_AREA_FLOOR_CELLS = 4;

/**
 * What the engine that swept the run can say about one level, as a CrossSection the CALLER of
 * `sliceAt` owns and the oracle deletes. `null` means it cut nothing at or below this level — an
 * empty region, which the oracle reports as an area of 0 without asking a `CrossSection` to be
 * built from no polygons (`ofPolygons([])` throws).
 *
 * The argument is the SLICE height, i.e. the level's floor `z` plus `ORACLE_SLICE_LIFT_MM`: a
 * column whose floor is exactly the level must count, and float equality does not.
 */
export type OracleSliceAt = (zSlice: number) => CrossSectionInstance | null;

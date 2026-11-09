/**
 * cam/model/clsurface.ts — the cutter-location surface by drop-cutter (#957, B), §2 of
 * `docs/design/cam-model-engine.md`.
 *
 * Re-implemented from OpenCamLib's published description (`BatchDropCutter`/`PathDropCutter`,
 * LGPL-2.1, algorithm reference only — no OCL source read or copied) and PyCAM's
 * (`PathGenerators/DropCutter.py`, GPL-3.0, reference only) for flat/ball/bull; the V cutter is
 * OpenCamLib's description alone. Adaptive sampling per §2: subdivide on departure from the
 * straight-line interpolation past `ARC_CHORD_TOLERANCE_MM`, down to `minSpacingMm`; a stated
 * `maxSpacingMm` per cutter from its own sagitta (ball/bull/flat) or flank sensitivity (V); a
 * staircase, not a diagonal, when a true discontinuity is found at `minSpacingMm` (the lesson from
 * Session C's #945 finding and Review B's F1 — the old engine's defect was always a straight-line
 * approximation graded against a rule that didn't agree with how it was built).
 *
 * The real drop-cutter geometry is `dropcutter.ts`'s `dropCutterHeight`/`profileOf` — built, and
 * checked red-first against F's parity fixtures (`tests/unit/clSurface957.spec.ts`, 33 passing
 * cases, both OpenCamLib and PyCAM columns). `clSurface()` below stays a throwing stub: it needs a
 * `DropCutterMesh` view of `RemainderRegion.triangles`' backing mesh, which `RemainderRegion` does
 * not itself carry (it only has `Uint32Array` triangle indices, not the vertex positions they index
 * into) — that wiring is #959's integration (the caller holds `ModelPlanInput.geometry`, the mesh
 * these indices resolve against). `reach()` needs no mesh and is implemented now.
 */

import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';
import type { Tool } from '@/engine/cnc/tool';
import type { FeatureSource, RemainderRegion } from './features';
import { dropCutterHeight, profileOf, type DropCutterMesh } from './dropcutter';
import { footprintIndex } from './footprintIndex';

export interface ClSurface {
  /**
   * The CL height at (x, y); `null` outside the region's footprint (a hair on its boundary still
   * counts as inside — see the footprint guard below) or where no triangle lies within the cutter's reach.
   * `reach()`'s face rule is a CALLER's admission test, never a gate inside this query (E's review
   * of #1033 corrected the old wording, which claimed one).
   */
  dropCutter(x: number, y: number): number | null;
  /**
   * #1033 (lever b) — THE SAME CL, IGNORING THE FOOTPRINT CLIP. Outside the region's footprint the
   * physical surface still exists: the ball riding an island's top or a pocket mouth sits at its
   * own CL there, and a join may ride across it ONLY when its chord stays at or above that height.
   * The rows keep the clipped query; this one is the join's proof against the neighbouring surface.
   * `null` where no triangle lies within the cutter's reach (off the part entirely). Optional so a
   * caller's own `ClSurface` literal (the op specs' fakes) keeps compiling; absent reads as "no
   * unclipped proof", which is exactly the pre-#1033 refusal.
   */
  dropCutterUnclipped?(x: number, y: number): number | null;
  toleranceMm: number;
  /**
   * #1129 — THE ADAPTIVE SAMPLER'S FLOOR: no row segment is subdivided finer than this. It is NOT
   * the chord tolerance (which stays the ACCEPTANCE rule): a derived sampling spacing —
   * `min(finishStepOver / 10, 0.05 mm)`, never below {@link ARC_CHORD_TOLERANCE_MM} — unless the
   * job states `surface.minSpacingMm`. See {@link minSampleSpacingFor}.
   */
  minSpacingMm: number;
  maxSpacingMm: number;
  /** #1129 — where {@link minSpacingMm} came from: the job's stated value, or the step-over derivation. */
  minSpacingSource: MinSpacingSource;
  /** #1129 — the finish step-over the derived floor divided by 10 (the number the receipt states). */
  minSpacingFromStepOverMm: number;
  /** How many drop-cutter evaluations this surface took to build — a report number, not a budget (§6: no caps on geometry, a stall guard only). */
  sampleCount: number;
}

export interface ReachResult {
  reachable: boolean;
  /** Stated when `reachable` is false — e.g. a V cutter's flank angle is shallower than the region's own slope. */
  note?: string;
}

/**
 * The manager's ruling on B's question (6621141190): `geometry` is `ModelPlanInput.geometry` (the
 * FeatureSource #958's `FeatureTree` is built from) — the ONE mesh `RemainderRegion.triangles`
 * indexes into, which `RemainderRegion` never carried on its own. `clSurface()` is a LAZY point
 * query, not a pre-built adaptive grid: §2's own adaptive sampling (subdivide on departure from a
 * straight-line interpolation, down to `minSpacingMm`, a staircase not a diagonal past a true
 * discontinuity) is a PATH concern — the `finish()`/`rough()` row-dropper's job, walking along a
 * raster row — not this interface's; `dropCutter` answers one (x, y) at a time, against every
 * triangle of the WHOLE mesh (never just `region.triangles`) so a cutter overhanging the region's
 * own edge still sees the wall/land beside it, not air past the region's own footprint boundary.
 */
/**
 * THE FOOTPRINT GUARD. A point exactly on the region's own boundary is reachable:
 * `pointInPolygons` answers "outside" for a point lying ON a vertical edge (ray casting's own
 * convention, `pocket.ts`), while the raster's interval tracer counts that same column as inside —
 * the disagreement surfaced as `dropRow`'s "footprint notch" on the organizer's grown finish
 * region, whose offset lands vertical edges on exactly the raster's round x values.
 *
 * #1134 — the two tests (even-odd membership and the boundary distance) are the SAME predicates
 * `pointInPolygons` and the pre-#1134 `onBoundary` answered, now behind `footprintIndex`: the
 * mask asks the CL 18 times per cell and the sequence pricing asks thousands of cells, so the
 * old full edge scan per query (with the bbox rebuilt every call) was 40 % of the ideal half's
 * profile. The index keeps every comparison and the distance rule unchanged and buckets the
 * edges by the rows their y-range covers; the equivalence test proves the answers point for
 * point.
 */

/**
 * #1129 — THE SAMPLE FLOOR, DERIVED AND STATED (defaults over knobs). Before this, `clSurface`
 * passed the CHORD TOLERANCE (0.005 mm) as the row-dropper's minimum spacing: a geometry
 * acceptance number used as a sampling floor, so every kink subdivided a row to 5 µm — 1.72 M
 * drop-cutter queries and 1.42 B edge-search evaluations in 72 s on a 59 mm plate (#1129's
 * profile). The floor is now a sampling spacing: the job's own `surface.minSpacingMm` when stated,
 * else `min(stepOver / 10, 0.05 mm)` (a tenth of the raster pitch, capped at 0.05 mm — fine enough
 * that the staircase rule still catches real discontinuities, coarse enough not to chase the
 * heightfield's own noise), never below the chord tolerance. The chord tolerance keeps governing
 * ACCEPTANCE in `dropRow`; only the floor moved.
 */
export const MIN_SAMPLE_SPACING_CAP_MM = 0.05;

export type MinSpacingSource = 'derived' | 'stated';

export interface MinSampleSpacing {
  mm: number;
  source: MinSpacingSource;
  /** The step-over the derived floor divided by 10; the job's own numbers either way. */
  fromStepOverMm: number;
}

/** #1129 — one cutter's recorded sampling facts: the plan's `clGrid` entry, and the receipt's `sampling` row. */
export interface ClGridEntry {
  cutterKey: string;
  toleranceMm: number;
  minSpacingMm: number;
  maxSpacingMm: number;
  minSpacingSource: MinSpacingSource;
  minSpacingFromStepOverMm: number;
}

export function minSampleSpacingFor(stepOverMm: number, statedMm?: number | null): MinSampleSpacing {
  if (statedMm !== undefined && statedMm !== null && Number.isFinite(statedMm) && statedMm > 0) {
    return { mm: Math.max(statedMm, ARC_CHORD_TOLERANCE_MM), source: 'stated', fromStepOverMm: stepOverMm };
  }
  const derived = Math.min(stepOverMm / 10, MIN_SAMPLE_SPACING_CAP_MM);
  return { mm: Math.max(derived, ARC_CHORD_TOLERANCE_MM), source: 'derived', fromStepOverMm: stepOverMm };
}

export function clSurface(
  geometry: FeatureSource,
  region: RemainderRegion,
  cutter: Tool,
  stepOverMm: number,
  /** #1129 — the job's stated `surface.minSpacingMm`, when it states one. */
  statedMinSpacingMm?: number | null,
): ClSurface {
  const profile = profileOf(cutter);
  if (profile === null) {
    throw new Error(`cam/model/clsurface: ${cutter.name || cutter.shape} has no drop-cutter profile for a CL surface`);
  }
  const mesh: DropCutterMesh = geometry.triangles;
  const toleranceMm = ARC_CHORD_TOLERANCE_MM;
  const spacing = minSampleSpacingFor(stepOverMm, statedMinSpacingMm);
  // The sagitta bound (the same closed form `finishStepOverForCusp`, surface3d.ts, derives for the
  // scallop band — here for the GEOMETRIC sampling tolerance instead): the largest spacing that
  // keeps a straight-line interpolation within `toleranceMm` of the cutter's own curved profile. A
  // flat/cone has no such curvature within its own flat/tip radius, so its own radius is the
  // stated bound instead — this is the cutter's OWN worst case, not a claim that sampling this
  // coarsely always finds a real surface discontinuity (the row-dropper's own job).
  const maxSpacingMm =
    profile.kind === 'arc' && profile.curveRadiusMm !== undefined && profile.curveRadiusMm > toleranceMm
      ? 2 * Math.sqrt(2 * profile.curveRadiusMm * toleranceMm - toleranceMm * toleranceMm)
      : profile.radiusMm;
  let sampleCount = 0;
  // #1134 — the footprint guard is indexed ONCE per surface: the mask and the sequence pricing
  // ask thousands of points of it, and the raw scan was 40 % of the ideal half's profile.
  const footprint = footprintIndex(region.footprint);
  return {
    dropCutter(x, y) {
      if (!footprint.contains(x, y) && !footprint.within(x, y)) return null;
      sampleCount++;
      return dropCutterHeight(profile, mesh, x, y);
    },
    // #1033 — the footprint clip is the ROWS' own reach rule; the join's ride proof asks the same
    // mesh without it, so the neighbouring surface (an island's top, a pocket mouth) can prove a
    // chord at or above it. Same profile, same bins, same value inside the footprint.
    dropCutterUnclipped(x, y) {
      sampleCount++;
      return dropCutterHeight(profile, mesh, x, y);
    },
    toleranceMm,
    minSpacingMm: spacing.mm,
    minSpacingSource: spacing.source,
    minSpacingFromStepOverMm: spacing.fromStepOverMm,
    maxSpacingMm,
    get sampleCount() {
      return sampleCount;
    },
  };
}

/**
 * #965 (the review session's step 2; the manager's 2026-11-05 ruling) — THE CREASE ADMISSION, the
 * groove's own rule, BESIDE `reach()` and never replacing it: `reach()` is the FACE rule (a V's
 * apex touches only a slope shallower than its flank — a V cutting a surface); a V riding a
 * CREASE is the opposite case, admitted where BOTH walls are steeper than 90° − the half-angle
 * (the flanks clear the walls) and the groove's width at the leftover depth — `d/tanθL + d/tanθR`
 * — is within the V's width there (`2·(tipRadius + d·tanθ)`), so the flanks stay out of the walls.
 */
export function creaseFits(
  cutter: Tool,
  crease: { leftSlopeDeg: number; rightSlopeDeg: number; depthMm: number },
): ReachResult {
  const profile = profileOf(cutter);
  if (profile === null || profile.kind !== 'cone' || profile.tanHalfAngle === undefined) {
    return { reachable: false, note: `${cutter.name || cutter.shape}: not a V — the crease rule is the V's own` };
  }
  const flankDeg = 90 - (Math.atan(profile.tanHalfAngle) * 180) / Math.PI;
  const shallower = Math.min(crease.leftSlopeDeg, crease.rightSlopeDeg);
  if (shallower < flankDeg) {
    return { reachable: false, note: `a wall (${shallower.toFixed(1)}° from horizontal) is shallower than the V's flank (${flankDeg.toFixed(1)}°)` };
  }
  const d = Math.max(0, crease.depthMm);
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  const grooveWidth = d / Math.tan(rad(crease.leftSlopeDeg)) + d / Math.tan(rad(crease.rightSlopeDeg));
  const vWidth = 2 * (profile.flatRadiusMm + d * profile.tanHalfAngle);
  if (grooveWidth > vWidth + 1e-9) {
    return { reachable: false, note: `the groove is ${grooveWidth.toFixed(2)} mm wide at ${d.toFixed(2)} mm depth, wider than the V (${vWidth.toFixed(2)} mm) there` };
  }
  return { reachable: true };
}

/**
 * A V/chamfer cutter's apex can only touch a slope shallower than its own flank angle from
 * horizontal (`90° − half-angle`) without the flank interfering — §2's derivation, carried into the
 * `dropcutter.ts` profile as `flatRadiusMm`/`tanHalfAngle`. Flat/ball/bull have no such limit within
 * this engine's scope (a slope steep enough to be a real overhang is an undercut, A's #958
 * `unreachable` list, not a `RemainderRegion`'s own `slopeDeg`).
 */
export function reach(cutter: Tool, feature: RemainderRegion): ReachResult {
  const profile = profileOf(cutter);
  if (profile === null) return { reachable: false, note: `${cutter.shape} has no drop-cutter profile for a CL surface` };
  if (profile.kind !== 'cone') return { reachable: true };
  const halfAngleDeg = profile.tanHalfAngle === undefined ? 90 : Math.atan(profile.tanHalfAngle) * (180 / Math.PI);
  const flankFromHorizontalDeg = 90 - halfAngleDeg;
  const steepest = feature.slopeDeg[1];
  if (steepest > flankFromHorizontalDeg) {
    return {
      reachable: false,
      note: `${cutter.name || cutter.shape}'s flank (${flankFromHorizontalDeg.toFixed(1)}° from horizontal) is shallower than this region's steepest slope (${steepest.toFixed(1)}°)`,
    };
  }
  return { reachable: true };
}

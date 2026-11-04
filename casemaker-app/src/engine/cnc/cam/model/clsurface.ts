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

import type { Tool } from '@/engine/cnc/tool';
import type { RemainderRegion } from './features';
import { profileOf } from './dropcutter';

export interface ClSurface {
  /** The CL height at (x, y), or `null` where the cutter cannot reach (outside the region, or past `reach`'s limit). */
  dropCutter(x: number, y: number): number | null;
  toleranceMm: number;
  minSpacingMm: number;
  maxSpacingMm: number;
  /** How many drop-cutter evaluations this surface took to build — a report number, not a budget (§6: no caps on geometry, a stall guard only). */
  sampleCount: number;
}

export interface ReachResult {
  reachable: boolean;
  /** Stated when `reachable` is false — e.g. a V cutter's flank angle is shallower than the region's own slope. */
  note?: string;
}

/**
 * Per-slice minimum (C's #956 comment 6619787259): `clSurface(cutter, stepOver, region)` plus a
 * cheap `reach`/sample-count check, so #961 can prune a candidate cutter before generating its full
 * surface.
 */
export function clSurface(_cutter: Tool, _stepOverMm: number, _region: RemainderRegion): ClSurface {
  throw new Error('cam/model/clsurface: clSurface() not implemented — needs the mesh RemainderRegion.triangles indexes into (#957/#959 integration)');
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

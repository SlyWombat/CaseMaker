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
 * This file is the skeleton stub: real geometry lands as #957's own commits, on top of this one.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { RemainderRegion } from './features';

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
  throw new Error('cam/model/clsurface: clSurface() not implemented (#957)');
}

export function reach(_cutter: Tool, _feature: RemainderRegion): ReachResult {
  throw new Error('cam/model/clsurface: reach() not implemented (#957)');
}

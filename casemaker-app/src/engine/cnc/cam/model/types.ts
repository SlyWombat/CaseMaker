/**
 * cam/model/types.ts — the `ModelPlanInput`/`ModelPlanOutput` fields with no existing codebase
 * equivalent and no home in C's real #961 module (§3.0 of `docs/design/cam-model-engine.md`).
 * `CutterCandidates` is C's own (`sequence.ts`), not redefined here; `Tool`, `ObstacleBox`,
 * `FixtureEnvelope`, `CycleTerms`, `Mount`, `ToolpathIR` are imported from their own modules in
 * `plan.ts`.
 */

import type { PlannedOpKind } from './sequence';

export interface ModelTolerances {
  /** The finish tolerance — §2's `ARC_CHORD_TOLERANCE_MM`-derived adaptive-spacing basis. Per A's R3, this does NOT carry an edge-break leg; see `EdgeBreakSpec`. */
  finishMm: number;
}

/**
 * The job's own stated edge break (or a shop constant) — read by the chamfer op (§3.5) to size its
 * cut. Per A's R3: the gate's allowance reads the SAME job field independently, through its own
 * path, capped by the chamfer Tool record's own geometry; neither side derives its number from the
 * other's plan output.
 */
export interface EdgeBreakSpec {
  legMm: number;
}

/**
 * #964/#961 — THE GOAL FIELD AS `cam/model` SEES IT. The completeness simulation needs the goal's
 * cell grid (extent, pitch) and its own data (`z`, `covered`) — the DATA, never the gate's
 * heightfield module: the rebuild's point is that the engine stops planning on the field the gate
 * measures with (gateImports' reverse rule), so the planner names its own structural type here and
 * a caller passes its field against it. The gate's `GoalHeightfield` is assignable to this shape,
 * which is the whole contract: no module of `cam/model/**` imports `engrave/goalHeightfield`.
 */
export interface GoalCellField {
  nx: number;
  ny: number;
  x0: number;
  y0: number;
  pitch: number;
  z: Float32Array;
  covered: Uint8Array;
}

export interface ModelPlanProgress {
  setupIndex: number;
  op: PlannedOpKind | 'features' | 'clSurface' | 'sequence' | 'linking';
  fraction: number;
}

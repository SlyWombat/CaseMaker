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

export interface ModelPlanProgress {
  setupIndex: number;
  op: PlannedOpKind | 'features' | 'clSurface' | 'sequence' | 'linking';
  fraction: number;
}

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
 * THE PROBED STOCK TOP (#943's ruling, 2026-11-05): the surface measurement, handed in by the
 * caller that holds it. The engine never reads the registration store (the sim-worker import-graph
 * rule), and a job with no measurement has NO entry — "not yet measured" is its own answer.
 *
 * DATUM: the plan's own — the registration writes Z0 at the LOWEST touch (#475's `Z0_REFERENCE`),
 * so among the readings the lowest sits at 0 and the highest at `+spreadMm`. The caller hands the
 * spread, not the raw points: the facing stage needs the extremes, and the count/source are what
 * the plan states.
 */
export interface StockProbes {
  /** How many surface touches produced the extremes, as the plan states them. */
  count: number;
  /** Highest reading − lowest reading, mm — the surface's own spread about the zero. */
  spreadMm: number;
  /** Where the readings came from (decision 28's provenance rule). */
  source: 'probe' | 'touch-off' | 'stated';
}

export interface ModelPlanProgress {
  setupIndex: number;
  op: PlannedOpKind | 'features' | 'clSurface' | 'sequence' | 'linking';
  fraction: number;
}

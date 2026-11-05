/**
 * cam/model/types.ts — the `ModelPlanInput`/`ModelPlanOutput` fields with no existing codebase
 * equivalent and no home in C's real #961 module (§3.0 of `docs/design/cam-model-engine.md`).
 * `CutterCandidates` is C's own (`sequence.ts`), not redefined here; `Tool`, `ObstacleBox`,
 * `FixtureEnvelope`, `CycleTerms`, `Mount`, `ToolpathIR` are imported from their own modules in
 * `plan.ts`.
 */

import type { PlannedOpKind } from './sequence';

export interface ModelTolerances {
  /**
   * The finish tolerance the JOB states — the ball's scallop height, mm (per A's R3 this does NOT
   * carry an edge-break leg; see `EdgeBreakSpec`).
   *
   * #965 (the review session's ruling, 2026-11-05): the job's tolerance IS the scallop. It is not
   * floored against the engine's default — a job that states 0.01 mm finishes at 0.01 mm, and the
   * default applies only when the job states none (`undefined`).
   */
  finishMm?: number;
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

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
  /**
   * #985 — THE JOB'S FINISH RASTER PITCH, mm. A WIDTH, not a height: the old engine's lateral
   * spacing between finishing scan lines. It is carried here as its own seat and turned into a
   * cusp height where the finishing ball is known (`plan.ts`, `cusp = R − √(R² − (s/2)²)`), so an
   * operator's pitch is honoured AS A PITCH — it never lands in `finishMm`, whose unit is the
   * cusp. A stated `finishMm` (a cusp) wins over a pitch; absent both, the engine's default.
   */
  finishStepOverMm?: number;
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
 * #992 — A STATEMENT THE PLAN OWES THE OPERATOR, typed. `notes` is the dump's full prose (the
 * failure path joins it into its message, and the acceptance specs read it); a statement is the
 * SAME fact with the two things a downstream consumer needs and a string does not carry: a CODE
 * (so it can be deduped, routed and documented) and a SEVERITY (so the seam knows where it goes).
 *
 * The #962 rule applies to every emitter: ONE statement per cause with a COUNT, never a line per
 * region. `ids` carries the regions a grouped statement covers (the detail, not the sentence).
 *
 * Severities, as the review's ruling sorts them:
 * - `warning` — it changes what comes off the machine or needs a decision (a region left uncut,
 *   the part never freed, a cutter substituted, skin left standing, a rim not broken);
 * - `info` — it records a choice or a fact with no action (a relief edge, the finish mode, no
 *   edge break asked, what the plan chose and what it costs);
 * - `sheet` — a fact of the run the run sheet prints (registration, facing, freeing order, the
 *   pipeline summary, empty stages). Sheet codes are NOT `JobFindingCode`s: they never reach the
 *   panel, only the sheet — but the guide's scanner reads every `code:` literal, so they get a
 *   chapter 8 row whose meaning says "printed on the run sheet".
 */
export type PlanFindingCode =
  | 'goal-not-freed'
  | 'goal-region-uncut'
  | 'goal-cutter-substituted'
  | 'goal-skin-standing'
  | 'goal-rim-unbroken'
  | 'goal-fixture-unmodelled'
  | 'goal-relief-edge'
  | 'goal-finish-mode'
  | 'goal-no-edge-break'
  | 'goal-plan-tradeoff';

export type PlanSheetCode = 'plan-setup' | 'plan-run';

export type PlanStatement = PlanFindingStatement | PlanSheetStatement;

export interface PlanFindingStatement {
  severity: 'warning' | 'info';
  code: PlanFindingCode;
  text: string;
  /** How many causes/regions this one statement covers (the #962 grouping). */
  count?: number;
  /** The region/rim ids behind a grouped statement — the detail, never a line each. */
  ids?: string[];
}

export interface PlanSheetStatement {
  severity: 'sheet';
  code: PlanSheetCode;
  text: string;
  count?: number;
  ids?: string[];
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

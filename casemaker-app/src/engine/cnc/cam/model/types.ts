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
  // #1023 — the finish's own leftover: `goal-rest-pass` is the info form when a smaller owned
  // ball ran, `goal-rest-uncut` the warning/info form when nothing owned takes what it left.
  | 'goal-rest-pass'
  | 'goal-rest-uncut'
  | 'goal-plan-tradeoff'
  // #1012 — the rim stage's bevel was clamped to the V's one-pass reach (the 2.5D path's own code).
  | 'chamfer-too-wide'
  // #1019 — the engine-chosen curved rough's stated flat could not reach the region's depth.
  | 'goal-rough-unreachable'
  // #1052 — a finish op would build past the move cap: the candidate leaves the rank with its
  // number (never an OOM), and the plan continues with the other candidates.
  | 'goal-finish-too-many-moves'
  // #1042 — the job's chosen cutter is not in the shop's inventory; it cuts because the job names
  // it, and the plan says so (a warning: the bench cuts owned cutters).
  | 'goal-cutter-not-owned'
  // #1047 — a house cutter set aside before the search: neither its own catalogue row nor the
  // starting table can feed it for this material, so it leaves the candidate set instead of
  // refusing the plan (info, one per cutter, named with the material).
  | 'goal-cutter-unfeedable'
  // #1063 — instrument records (probes) leave the candidate set before feeds are asked: they are
  // not cutters at all, and one aggregate line names them instead of a "no feeds" line each.
  | 'goal-cutter-instrument'
  // #1037 — no cutter in the set reaches a curved region's floor: the finish does not post the
  // region, and the sentence names the region, the floor and the finisher's usable length.
  | 'goal-finish-unreachable'
  // #1092 — a rest region's per-region drop-tip field exceeds the op budget: the region is left
  // uncut and the finding names the region, the cutter, the evaluations against the budget and the
  // way out (warning when the coverage line still passes, error when it fails because of it).
  | 'rest-region-over-budget'
  // #1005 — the mould's own four. Rim and floor are the goal validator's
  // (`validateGoalObject`); one-sided and no-draft are the plan's, from its own solid.
  | 'goal-mold-rim'
  | 'goal-mold-floor'
  | 'goal-mold-one-sided'
  | 'goal-mold-no-draft'
  // #1021 — a pocket floor strip narrower than the primary flat's own ring (its opening is
  // empty there) IS finished, by the ball, as its own floor pass. Good news, stated once per
  // setup with the pocket ids and count — never the #982 fallback's `goal-region-uncut` (that
  // one means left uncut; this one means covered a different way).
  | 'goal-pocket-floor-rest'
  // #943 (10) — the goal's outline is the stock's own: there is no material around the part to
  // free, so the plan cuts no freeing contour and says so.
  | 'goal-outline-is-stock';

/**
 * #721/#1005 — the steepest cavity wall a mould is cut with before it is warned as having no
 * draft, degrees from horizontal. A labelled default: casting practice wants a degree or more of
 * draft. Shared by both engines so the warning's number cannot drift between them — the old
 * heightfield path re-exports it from here.
 */
export const MOLD_DRAFT_LIMIT_DEG = 85;

export type PlanSheetCode = 'plan-setup' | 'plan-run';

export type PlanStatement = PlanFindingStatement | PlanSheetStatement;

export interface PlanFindingStatement {
  // #1092 (0f's land14 ruling) — a plan finding may be an ERROR: the rest-region tip budget is
  // stated as a warning when the finish's own coverage line still passes, and as an error when
  // that refusal is why the line fails.
  severity: 'error' | 'warning' | 'info';
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

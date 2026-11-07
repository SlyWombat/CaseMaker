/**
 * cam/model/plan.ts — the one entry point of the model-driven CAM engine (#956). §3.0/§3.0.1 of
 * `docs/design/cam-model-engine.md` is this file's source of truth; read that before changing
 * anything here.
 *
 * `planModelCam` replaced `generateSurface3dForGoal`/`generateSurface3dIR` and their
 * `generateGoalPrograms`/`generateSurfacePrimitiveProgram` call sites outright (#966): the old
 * heightfield engine, and the `USE_MODEL_CAM_ENGINE` seam that once chose between the two, are
 * both gone from `engraveGenerate.ts`. `cam/model` is the only path a goal job plans through now.
 *
 * The PUBLIC output types below (`OpOutcome`, `RegionAtZ`, `RegionRef`, `PassRef`, `PlannedOp`,
 * `Polygon`, `Box2`, and this file's OWN `CycleCost`) are distinct from `linking.ts`'s and
 * `sequence.ts`'s internal shapes: those two modules are C's real #961/#962 implementations, with
 * their own richer internal types (`SequenceStep`/`CandidateSequence`/a DIFFERENT, internal
 * `CycleCost` in `sequence.ts` that sums to a bare `estimateSeconds: number`; `LinkPoint`/
 * `MaterialField`/`PassLink` in `linking.ts`). `planModelCam` is the adapter between C's internal
 * shapes and this serialisable `SetupPlan` — the surface F's parity harness (`modelGolden.spec.ts`)
 * and D's panel read, and the one this file's own `CycleCost` is shaped to match exactly.
 */

import type { EngraveJob } from '@/types/engraveJob';
import type { Mount } from '@/engine/cnc/setups/types';
import type { FixtureEnvelope } from '@/engine/cnc/setup';
import type { ObstacleBox } from '@/engine/cnc/setup';
import { cuttingDiameter, flatEndMill, type Tool } from '@/engine/cnc/tool';
import { coneHeight, isVShape, vCone, type VCone } from '@/engine/cnc/vProfile';
import { vCarvePassPitch } from '@/engine/cnc/vCarveGeometry';
import { concatToolpathIR, estimateCycleTerms, HOP_Z, SAFE_Z, type CycleTerms, type RapidEstimate, type ToolpathIR } from '@/engine/cnc/cam/ir';
import { feedCatalogueSnapshot, feedsFor, feedsToolForSurface, resolvedFeedsTable, type CutParams } from '@/engine/cnc/feeds';
import { Z1 } from '@/engine/cnc/machine';
import { readDefault, liveShopDefaults } from '@/platform/defaultsClient';
import { REST_MACHINING_FALLBACK, type RestSettingSource } from '@/engine/cnc/engrave/restSettings';
import { makeClipperOffset, makeClipperSubtract, makeClipperUnion } from '@/engine/cnc/cam/engraveJob';
import { pointInPolygons } from '@/engine/cnc/engrave/throughMask';
import { getToplevel } from '@/workers/geometry/ManifoldRuntime';
import type { OffsetFn, Polygons } from '@/engine/cnc/cam/pocket';
import type { BooleanFn } from '@/engine/cnc/cam/engraveJob';
import type { FeatureSource, FeatureTree, PocketNode, RemainderRegion, SetupFrame } from './features';
import { recogniseFeatures, regionRefs } from './features';
import type { EdgeBreakSpec, GoalCellField, ModelPlanProgress, ModelTolerances, PlanStatement, StockProbes } from './types';
import { MOLD_DRAFT_LIMIT_DEG } from './types';
import { batchSameCutterRuns, chooseSequence, cutterKeyOf, type CutterCandidates, type PlannedOpKind, type SequenceChoice, type SequenceFeature, type SequenceOptions, type SequenceStep, type SequenceStepFailure } from './sequence';
import { documentXY, mapIRToDocument, registerSetupOrigin, rotatedGeometryFor, shiftToStockTop, type SetupRegistration } from './setups';
import { fullyReachable, pocket } from './ops/pocket';
import { roughLeftAbove } from './ops/rough';
import { clSurface, creaseFits } from './clsurface';
import { dropCutterHeight, profileOf, type CutterProfile, type DropCutterMesh } from './dropcutter';
import { ARC_CHORD_TOLERANCE_MM } from '@/engine/compiler/arcResolution';

/**
 * #965/#898 part 2 — THE FRAME-FLIP ALGEBRA, isolated from feature recognition's own
 * uncertainties so it has its own direct, hand-checkable test (`contourFreeingCl965.spec.ts`).
 *
 * `toSetupFrame`'s own half-turn-about-X for `up = [0, 0, -1]` (`features.ts`) negates Y and Z of
 * every mesh position, with NO translation — so a non-first setup's own RAW local Z (the same
 * axis `ContourOpOptions.depthMm`/`zPasses` already cut on, before `planPocketsForTree`'s own
 * `-stockTop` rebase) is exactly the NEGATION of the one fixed frame `ModelPlanInput.geometry`
 * itself sits in (the opposite, `top`, setup's own frame — `up = [0, 0, 1]`, the identity
 * rotation — called "world" here only in that sense, not a machine coordinate). A local depth `d`
 * below THIS setup's own stock top is raw local Z `stockTop - d`, so `worldZ(d) = d - stockTop`.
 *
 * The opposite setup's solid sits at or below its own `dropCutterHeight` at the SAME document
 * (world) point (#957's drop-cutter, read off the design mesh itself — the same ground truth
 * `rough`/`rest`/`finish` already trust for "where the final surface is," not `SetupPlan.clGrid`,
 * which carries only `{toleranceMm, minSpacingMm, maxSpacingMm}` per cutter and no sampled height
 * at all). This setup's cut stays safe while it never reaches past that same world height, less a
 * numerical-noise margin (the SAME chord-tolerance bound `PROFILE_OFFSET_GUARD_MM`/
 * `ARC_CHORD_TOLERANCE_MM` already uses elsewhere, not a new tuned number):
 * `d <= surfaceWorldZ - margin + stockTop`.
 *
 * `frame` is THIS (non-first) setup's own — the ONLY supported case is its `up = [0, 0, -1]`
 * (#965's stated scope: a vise's bottom flip, the one `frameForFace`/`documentXY` actually map);
 * the caller (`planModelCam`) is what checks that before ever calling this, so this function
 * itself assumes it, not re-checks it. `profile`/`mesh` are the OPPOSITE setup's own tool profile
 * and ITS rotated mesh (`rotatedGeometryFor(input.geometry, opposite.features.frame)`).
 *
 * #965 REVIEW FINDING, fixed here: this function maps `(x, y)` through `documentXY` — the SAME
 * function `mapIRToDocument` uses to place this setup's own posted moves in the document frame.
 * It must therefore take the SAME registration `offset` `planModelCam` passes to that call, or it
 * checks a different point than the one the cut actually lands on the instant registration finds
 * a real (non-zero) correction — dormant until then, since every current fixture (including a
 * genuinely two-setup `planModelCam` run) only ever produces `[0, 0]` for this module's own pure
 * axis-through-origin flip (no caller has ever needed to exercise it before `registrationFreeingCl965.spec.ts`).
 */
export function oppositeSurfaceSafeDepthMm(
  frame: SetupFrame,
  profile: CutterProfile,
  mesh: DropCutterMesh,
  x: number,
  y: number,
  marginMm: number = ARC_CHORD_TOLERANCE_MM,
  // #965 review finding: this MUST be the same registration offset `mapIRToDocument` is given
  // for this setup's own posted program, and it MUST go through the same `documentXY` call — the
  // one mapping both share — or this function checks a different point than the one the cut
  // actually posts to. Absent → [0, 0], unchanged for every pre-existing caller (none of which
  // pass a non-zero offset today; see this function's own header for why that case has never
  // come up on a real job yet).
  offset: readonly [number, number] = [0, 0],
): number | null {
  const [wx, wy] = documentXY(frame, x, y, offset);
  const surfaceWorldZ = dropCutterHeight(profile, mesh, wx, wy);
  if (surfaceWorldZ === null) return null;
  return surfaceWorldZ + frame.stockTop - marginMm;
}
import { rough, skin } from './ops/rough';
import { maskCellsExact } from './finishMask';
import { FLAT_SURFACE_MAX_SLOPE_DEG, flatSurfaceMaxSlopeDeg, skinStepdownFactor } from './settings';
import { cellPolygons, rest } from './ops/rest';
import { DEFAULT_FINISH_SCALLOP_MM, finish, finishKindFor, type FinishKind } from './ops/finish';
import { hasValley, pencil } from './ops/pencil';
import { chamfer } from './ops/chamfer';
import { contour as contourOp, throughHole } from './ops/contour';
import { postZ1, type PostContext } from '@/engine/cnc/post/z1';
import { parseGcode } from '@/engine/cnc/gcode';
import { setupFromHeader } from '@/engine/cnc/setupFromHeader';
import { stubSetup } from '@/engine/cnc/setup';
import { buildTimeline } from '@/engine/cnc/emulator/timeline';
import { exactSweptFieldTooled } from '@/workers/sim/sweptPoint';
import { buildTriangleBins, binnedReachableTriangles, type TriangleBins } from './triangleBins';

/** One ring (outer boundary or a hole); `pocket.ts`'s `Polygons` is `Polygon[]`. NEW — no existing equivalent. */
export type Polygon = [number, number][];

/** NEW — no existing equivalent. */
export interface Box2 {
  min: [number, number];
  max: [number, number];
}

/** The material removed at one Z — outer boundary plus holes. */
export interface RegionAtZ {
  z: number;
  boundary: Polygon[];
}

/**
 * One pass within an op, in execution order (C's #956 comment 6619787259 point 4, restored on
 * C's objection: the reshaped `PlannedOp` dropped entry/exit, and `link()`/`linkPasses` (`linking.ts`)
 * cannot find where one pass ends and the next begins without them).
 */
export interface PassRef {
  z: number;
  boundary: Polygon[];
  cleared: RegionAtZ;
  entry: [number, number, number];
  exit: [number, number, number];
}

/**
 * Every op generator returns one of these. `cutter` is a ToolKey — no such type exists yet
 * (`roughToolKey?: string`, `types/engraveJob.ts:770`), so this is a bare `string`, not invented.
 */
export interface OpOutcome {
  ir: ToolpathIR;
  cutter: string;
  /** In execution order; what `linkPasses` (`linking.ts`) joins. */
  passes: PassRef[];
  /** What the op removed, per depth — the material state's input. Absent for an op that removes nothing new. */
  cleared?: RegionAtZ[];
  /** #960 — statements the op makes about its own method (a skipped wall band, a stated slope
   *  threshold), carried into the plan's notes so the operator sees them. */
  notes?: string[];
  /**
   * #1012 — the rim stage's bevel was CLAMPED to the cone's one-pass reach: the LEG it asked for
   * and the leg it cut, mm. Absent when the cone reaches the asked leg. The plan states it once
   * per cause (`chamfer-too-wide`, both widths in the sentence) — a cut that differs from what
   * the operator asked for is never silent.
   */
  clampedLegMm?: { wanted: number; cut: number };
}

export type RegionKind = 'pocket' | 'island-top' | 'curved' | 'contour' | 'rim';

export interface RegionRef {
  id: string;
  kind: RegionKind;
  bounds: Box2;
  topZ: number;
  bottomZ: number;
  /**
   * The fixture's boxes that reach this region's bounds — already inflated by the fixture
   * envelope's own `uncertainty` (the same inflation `prepareFixtureBoxes`/the sweep applies,
   * `workers/geometry/sweep.ts:622`), not the whole fixture. This is the #949 jaw-clearance data.
   */
  obstacles: ObstacleBox[];
  /**
   * The lowest Z that clears every one of `obstacles`, mm — C's point 3 ruling: the per-region
   * clearance plane a stay-down link retracts to inside this region (`linking.ts`'s
   * `LinkOptions.clearanceZ` is this value). The OTHER clearance height C's note meant is
   * `ToolpathIR.safeZ` (existing field, ir.ts) — the program-wide retract between regions/ops.
   * Neither is named `stayDownClearanceMm`/`retractClearanceMm`; this note's first pass at the
   * names was wrong, per C's objection.
   */
  regionClearanceZ: number;
}

/**
 * One planned operation, in a `SetupPlan.ops[]` execution order.
 */
export interface PlannedOp {
  kind: PlannedOpKind;
  region: RegionRef;
  outcome: OpOutcome;
}

export interface SetupSpec {
  frame: SetupFrame;
  /** #898's three choices. */
  underside: 'flatOnStockBottom' | 'flippedTabs' | 'plinth';
  /**
   * #988 — THE DEPTH BAND THIS SETUP CUTS TO, mm below the stock top (positive). Absent = the
   * whole depth, the pre-#988 plan. The seam sets it from `goal.cutWithinReach` (the cutter's
   * known reach less the clearance — the old path's own number) or a split's stated band (#888);
   * the plan then stops the freeing contour, every pocket/through/V floor and every curved
   * region's CL surface at −band, names what is left, and does not tell the contour to release.
   */
  bandMm?: number;
}

export interface ModelPlanInput {
  geometry: FeatureSource;
  /**
   * #1003 (the manager's narrowing) — the sacrificial board's BREAKTHROUGH, mm. Used ONLY for the
   * freeing contour's floor (a contour cuts through the blank into the board by design); pockets
   * and curved regions never use it.
   */
  sacrificialBreakthroughMm?: number;
  /** #959 ruling: `'on'` plans the facing stage; absent/`'off'` gives the skin to the `skin` pass. */
  facing?: 'off' | 'on';
  /**
   * #943's ruling — the probed stock top, handed in by the caller that holds the measurement
   * (the registration store lives on the main thread; this plan cannot read it). ABSENT is a job
   * with no measurement: the facing depth comes from the stated stock top and the plan says so.
   */
  stockProbes?: StockProbes;
  /** The shared flat/ball slope parameter (#959); absent → the provisional `FLAT_SURFACE_MAX_SLOPE_DEG`. */
  flatSurfaceMaxSlopeDeg?: number;
  /**
   * Length 1 for the tray/organizer today; #898/#914's flip plan (`held/914-flip-plan`: the
   * reach-aware face decision, the stock-floor anchor, the band-floor trigger) and #965 fill this
   * to more than one entry. Reserved now so #965 does not reopen this interface.
   */
  setups: SetupSpec[];
  stock: Pick<EngraveJob['stock'], 'length' | 'width' | 'thickness' | 'material'>;
  /**
   * The resolved fixture, by mount type — `viseEnvelope(job.stock, jobVise(job), job.sacrificial)`
   * for a vise (`engine/cnc/fixture.ts:371`, the same call `jobSetup.ts:1207`'s `defaultFixture`
   * makes), `bracketMount(...).fixture` for a bracket (already a `FixtureEnvelope`,
   * `mounts/bracket.ts:451`), `null` for tape. The SAME object the sweep checks the posted program
   * against — not rebuilt here, so this engine and the sweep cannot disagree about where the jaws
   * are (the #949 class).
   */
  fixture: { mount: Mount; envelope: FixtureEnvelope | null };
  cutters: CutterCandidates;
  tolerances: ModelTolerances;
  edgeBreak: EdgeBreakSpec;
  /**
   * #961 — THE GOAL, when the caller can supply it: the model's top surface on the stock frame
   * (Z 0 = stock top, the same 0.1 mm field the goal check samples). The picker's completeness
   * is then the SIMULATED OUTCOME — the goal cells a candidate's own sweep leaves above the
   * 0.1 mm band (the maintainer's 11-05 ruling), not the count of pockets left behind. Absent →
   * the old pocket-count completeness, unchanged.
   */
  goal?: GoalCellField;
  /**
   * #1023 — the shop's leftover-visibility thresholds, carried from the location's
   * `rest.visibleDepthMm` / `rest.thirdToolPct` by the caller (the engine never reads the
   * location). A leftover deeper than `depthMm` OR a larger share than `share` is VISIBLE: its
   * statement is a warning, otherwise information. Absent → the labelled
   * {@link REST_MACHINING_FALLBACK} numbers, both sources `'fallback'`.
   *
   * #1027 — EACH THRESHOLD KEEPS ITS OWN SOURCE. The two settings are read from the location
   * independently (`readDefault` answers per key), so a shop can state one and fall back for the
   * other; the sentence names each threshold's source when they differ, and one phrase when they
   * agree.
   */
  restVisibility?: {
    depthMm: number;
    share: number;
    depthSource: RestSettingSource;
    shareSource: RestSettingSource;
  };
  /**
   * #1027 (E's review) — DOES THIS SHOP HAVE A CUTTER CATALOGUE AT ALL? The rest statement's
   * no-reference clause points the operator at the catalogue; whether one is CONFIGURED is not
   * the same as whether one was MEASURED here. `planTwoOutcomes` empties the catalogue before
   * planning the owned plan (`twoPlans.ts`'s owned call), so it carries the original answer on
   * this field; a direct caller defaults to its own `cutters.catalogue.length > 0`. Absent ⇒ the
   * default.
   */
  catalogueConfigured?: boolean;
  /**
   * #1005 — WHEN THIS PLAN CUTS A MOULD. The seam sets it when the goal's `goalMode` is `'mold'`:
   * its `geometry` is then the stock block minus the part turned over (`engrave/mouldSolid.ts`),
   * and the plan states the two mould findings that need the cavity's own geometry — one-sided
   * (always, info) and no-draft (warning past {@link MOLD_DRAFT_LIMIT_DEG}). `steepestWallDeg` is
   * measured from the part's surface at the seam: a PLANAR wall is classified as a pocket wall and
   * appears in no `remainder[].slopeDeg`, so the tree alone could not answer the box case. Rim and
   * floor stay the goal validator's own findings (`validateGoalObject`), unchanged in code and
   * wording.
   */
  mould?: { name: string; steepestWallDeg: number };
  /**
   * #869/#966 — THE CURVED PIPELINE'S OWN ROUGH, independent of `primary` (the pockets' own
   * largest flat, which a goal with no pockets picks only because the house owns one at all).
   * Absent (every existing caller): unchanged — the curved pipeline ROUGHS with `primary`, exactly
   * as before this field existed. `null`: no rough at all, the ball alone takes each remainder
   * region's full depth (#869's stated default for a goal with no `roughToolKey`). A `Tool`: that
   * tool roughs instead of `primary` (#869's `roughToolKey`, once validated by the caller — this
   * field is not itself validated here, the same contract `cutters.house` already keeps).
   */
  curvedRoughTool?: Tool | null;
}

/**
 * #961 (the card slice) — THE PLAN'S OWN MEASURED OUTCOME, when the caller supplied `input.goal`.
 * Both plans of `planTwoOutcomes` carry one, so the job card can compare them with
 * `comparePlanOutcomes` without a second pipeline: `coverage` is the share of the goal's covered
 * cells the plan's own sweep leaves within the 0.1 mm band, and `maxMm` the deepest it stands above
 * the goal. The ADJUDICATED cut-into share is the gate's number (it applies the edge-break / wall
 * allowances the planner does not own), so it is `null` here and the comparison skips that row
 * rather than guessing it.
 */
/**
 * #986 — THE FINISHING BALL'S CANDIDATE LIST, from the recognised tree (the review session's
 * analysis, #986 §4). Balls are grouped one per CUTTING DIAMETER (the LONGEST FLUTE of each wins,
 * because reach is what a deep crease needs), and the list is REACH-FILTERED against the deepest
 * remainder the setup must finish: a ball whose flute cannot descend to that floor never touches
 * it, and choosing it — which is exactly what the old "largest diameter, first in catalogue
 * order" rule did — bridges every crease narrower than its radius. When NO candidate reaches, the
 * longest-flute ball is returned alone, so the plan states its one limitation rather than picking
 * by size. The caller measures these candidates by finish and stamp; this function only decides
 * which balls are worth measuring, and it never consults catalogue order.
 */
export function finishBallCandidates(house: readonly Tool[], deepestMm: number): Tool[] {
  const byDiameter = new Map<number, Tool>();
  for (const tool of house) {
    if (tool.shape !== 'ball') continue;
    const diameter = cuttingDiameter(tool) ?? 0;
    if (!(diameter > 0)) continue;
    const current = byDiameter.get(diameter);
    if (current === undefined || (tool.fluteLength ?? 0) > (current.fluteLength ?? 0)) byDiameter.set(diameter, tool);
  }
  const all = [...byDiameter.values()];
  const reaching = all.filter((tool) => (tool.fluteLength ?? 0) + 1e-9 >= deepestMm);
  // #986 (C's pre-read) — THE SUPERSET HOLDS BY DIAMETER, NOT BY TOOL OBJECT: two sets can differ
  // in which balls their reach filters keep, so the PRE-#986 PICK (largest diameter, first in the
  // list — the rule this issue replaces) is appended as a candidate whenever the filtered list
  // does not already carry it. The plan the old rule chose is therefore always measured, and a
  // superset can never lose to its subset through a fallback list the subset never had.
  const legacy = house
    .filter((t) => t.shape === 'ball' && (cuttingDiameter(t) ?? 0) > 0)
    .sort((a, b) => (cuttingDiameter(b) ?? 0) - (cuttingDiameter(a) ?? 0))[0];
  const withLegacy = (list: Tool[]): Tool[] => (legacy === undefined || list.includes(legacy) ? list : [...list, legacy]);
  if (reaching.length > 0) return withLegacy(reaching);
  const longest = [...all].sort((a, b) => (b.fluteLength ?? 0) - (a.fluteLength ?? 0))[0];
  return withLegacy(longest === undefined ? [] : [longest]);
}

export interface PlanOutcome {
  coverage: number | null;
  /**
   * The gate's cut-into numbers are NOT the planner's to state: the adjudicated share applies the
   * job's edge-break and wall allowances, and `maxMm` on the card means the deepest cut BELOW the
   * goal. Both are null here — the planner does not judge them — so the comparison states those
   * rows as not judged rather than filling them with a different quantity.
   */
  cutInto: { adjudicatedFraction: number | null; maxMm: number | null };
  /**
   * THE DEEPEST LEFTOVER ABOVE THE GOAL, mm — material the plan's own sweep leaves standing, the
   * worst cell of `coverage`'s complement. It is NOT cut-into and must never be printed as such:
   * on the panther it reads ~18 mm, which is an uncut deep feature, not a gouged part.
   */
  leftoverAboveMm: number;
  /** The plan's own cycle estimate, seconds — the comparison's cycle row. */
  cycleSeconds: number;
  /**
   * #1023 — the same stamp's cell counts, so the leftover statement states the cells and the area
   * it is a share of without a second measurement. `coverage` is `1 − leftoverCells / coveredCells`.
   */
  leftoverCells: number;
  coveredCells: number;
  cellAreaMm2: number;
}

export interface ModelPlanOutput {
  perSetup: SetupPlan[];
  /** #961 — measured on the plan's own programs when `input.goal` was supplied; absent otherwise. */
  outcome?: PlanOutcome;
}

/**
 * The PUBLIC cost wrapper `SetupPlan.sequence[].cost` carries — distinct from `sequence.ts`'s own
 * internal `CycleCost` (which sums to a bare `estimateSeconds: number`, not a `CycleTerms` object).
 * `terms` is #927's real type (`ir.ts`) on this cutter's posted, concatenated `ToolpathIR`;
 * `toolChangeSeconds`/`totalSeconds` wrap it per C's cost ruling; `toolChanges` is optional — the
 * ruling's wrapper does not require the count, though C's module states it.
 */
export interface CycleCost {
  terms: CycleTerms;
  toolChangeSeconds: number;
  totalSeconds: number;
  toolChanges?: number;
}

/**
 * One cutter's priced place in the sequence. `pinned`/`house` come from the chosen
 * `SequenceStep.cutter: CutterChoice` for that key (`sequence.ts`), not duplicated state.
 */
export interface SequencedCutter {
  cutterKey: string;
  cost: CycleCost;
  pinned: boolean;
  house: boolean;
}

export interface SetupPlan {
  setupIndex: number;
  features: FeatureTree;
  /** Grid resolution per cutter/op — renamed from `clSurface` to avoid colliding with `clsurface.ts`'s exported function of that name. */
  clGrid: { cutterKey: string; toleranceMm: number; minSpacingMm: number; maxSpacingMm: number }[];
  ops: PlannedOp[];
  sequence: SequencedCutter[];
  linking: { rapidsCount: number; hopsCount: number; airFractionPct: number };
  /**
   * One program per RUN, in execution order — #419's "one program per tool" still holds for a
   * job with no cutter revisit; a cutter #961 returns to for the freeing cut (cheaper than its
   * last cutter taking the profile) posts as a SECOND, separate entry here, never merged with
   * its first (advisor's review on ab6b2827 — merging them posts a file that frees the part
   * before the step in between it ever ran).
   */
  programs: ToolpathIR[];
  totalCostSeconds: number;
  /**
   * The plan's statements to the operator — every stage that found nothing to cut, a feeds
   * substitution, a limit this entry does not yet cover. Stated, never silent: the check suite's
   * own finding was that `planModelCam` computed these and dropped them.
   */
  notes: string[];
  /**
   * #992 — `notes`, typed: the same facts with a code and a severity, so the seam can route them
   * (warning/info to the panel's findings, sheet lines to the run sheet) instead of leaving every
   * ruling "stated on the card" reachable only by the acceptance specs. One per cause, with a
   * count (#962's rule); `notes` stays as the dump's full prose.
   */
  statements: PlanStatement[];
  /** Features no cutter in the chain covers, each a sentence naming the limiting number. */
  unreachable: string[];
  /**
   * #959 item 5 — every region/stage of THIS plan that threw or planned nothing, in `sequence.ts`'s
   * own `SequenceStepFailure` shape (kind, cutter, regions, the reason). The rest of the plan still
   * posts; only a primary failure refuses (`priceSequence`'s step-0 rule).
   */
  unplanned: SequenceStepFailure[];
  /**
   * #961 acceptance (the maintainer's 11-05 review) — the pocket chain's full picker result: the
   * chosen chain's cost and EVERY candidate it priced (`considered`), so a card or the run sheet
   * prints the candidates beside the choice instead of only the winner. The plan already computed
   * this; before this field it was dropped at the SetupPlan seam.
   */
  choice: SequenceChoice;
}

export interface PlanModelCamOptions {
  signal?: AbortSignal;
  onProgress?: (p: ModelPlanProgress) => void;
  /**
   * #1023 — TRUE (default) emits the finish's leftover statement. `planTwoOutcomes` suppresses it
   * on the IDEAL reference run: the owned plan is the one that posts, and its statement is the one
   * that names the ideal's measured ball (one leftover statement per card, not two).
   */
  restStatement?: boolean;
}

/**
 * The rough's stock-to-leave band, mm — the old engine's own `DEFAULT_STOCK_TO_LEAVE_MM`
 * (`cam/surface3d.ts:74`). That file is #966's to delete, so the number is stated here as the
 * entry's default until the band is an input field (§3.6 point 4's job fields, which #965 decides).
 * It is the ROUGH's band only; the ball's promised cusp is the job's finish tolerance
 * (`finishScallopMm`), because F's coverage line counts anything over 0.1 mm standing above the
 * goal as leftover — a finish leaving the rough's band as its own scallop reads as uncovered.
 */
export const MODEL_STOCK_TO_LEAVE_MM = 0.3;

/** #962 — how close a rim's own first and last point must already be to count as closed; past
 * this is a genuine gap in `findRims`' own chain, not float noise from the mesh. */
const RIM_CLOSE_TOL_MM = 0.01;

/**
 * One cutter's resolved cut numbers, through the app's one feeds resolver (the labelled fallback
 * table when no catalogue row answers).
 *
 * THE CHECK SUITE FOUND THIS: the compiled starting table tops out at 3.2 mm, and the house's
 * primary ⌀6 has no row in a realm where no catalogue is installed (the specs, the hosted build) —
 * every plan was refused at the first cutter. Refusing would be right if the numbers were a guess;
 * they are not: the material's LARGEST covered row answers through a FLAT proxy at the row's own
 * diameter (the same substitution #669 makes for a chamfer without a V row), which is a shallower
 * step-down and a slower feed than this cutter could take — the conservative side. The
 * substitution is returned so the plan STATES it, never posts it silently.
 */
function resolvedCutParams(input: ModelPlanInput, tool: Tool): { params: CutParams; substitution: string | null } {
  const resolved = feedsFor(feedCatalogueSnapshot(), input.stock.material, feedsToolForSurface(tool), Z1);
  if (resolved.ok) return { params: resolved.params, substitution: null };
  const rows = resolvedFeedsTable()
    .table.filter((row) => row.material === input.stock.material && (row.edge ?? 'flat') === 'flat')
    .sort((a, b) => b.maxDiameter - a.maxDiameter);
  const largest = rows[0];
  if (largest !== undefined) {
    const proxy = flatEndMill(largest.maxDiameter, { number: tool.number, id: tool.id, name: tool.name });
    const viaProxy = feedsFor(feedCatalogueSnapshot(), input.stock.material, proxy, Z1);
    if (viaProxy.ok) {
      return {
        params: viaProxy.params,
        substitution:
          `${tool.name || tool.id || `${cuttingDiameter(tool)} mm cutter`}: no starting row covers its diameter — ` +
          `${input.stock.material}'s largest covered row (${largest.maxDiameter} mm) answered, its step-down and feed ` +
          'being the conservative side',
      };
    }
  }
  const label = tool.name || tool.id || `${tool.shape} cutter`;
  throw new Error(`cam/model/plan: no feeds for ${label} in ${input.stock.material} — ${resolved.reason}`);
}

/**
 * THE REVIEW'S FINDING (item 8): the curved pipeline's ball and V were fed and spun at the
 * PRIMARY FLAT's own resolved numbers — `resolvedCutParams` exists per tool, but was only ever
 * called for the primary. Resolved the same way for a non-flat tool; if even the largest-covered-
 * row proxy cannot answer for it (`resolvedCutParams` throws), the primary's already-resolved
 * numbers stand in instead — stated in a note, never silently.
 */
function toolCutParams(input: ModelPlanInput, tool: Tool, primaryParams: CutParams): { params: CutParams; note: string | null } {
  try {
    const { params, substitution } = resolvedCutParams(input, tool);
    return { params, note: substitution };
  } catch (err) {
    const label = tool.name || tool.id || `${tool.shape} cutter`;
    const reason = err instanceof Error ? err.message : String(err);
    return {
      params: primaryParams,
      note: `${label}: ${reason} — the primary flat's own feeds/RPM answer instead, the conservative side`,
    };
  }
}

/** §5's three numbers, read off the posted moves: a hop retracts to `hopZ`, a rapid to `safeZ`. */
function linkingStats(programs: readonly ToolpathIR[]): SetupPlan['linking'] {
  let rapidsCount = 0;
  let hopsCount = 0;
  let feedXy = 0;
  let rapidXy = 0;
  for (const ir of programs) {
    let prev: { x: number; y: number } | null = null;
    for (const operation of ir.operations) {
      for (const move of operation.moves) {
        const d = prev === null ? 0 : Math.hypot(move.x - prev.x, move.y - prev.y);
        if (move.kind === 'rapid') {
          if (move.z <= ir.hopZ + 1e-9) hopsCount++;
          else rapidsCount++;
          rapidXy += d;
        } else {
          feedXy += d;
        }
        prev = { x: move.x, y: move.y };
      }
    }
  }
  const total = feedXy + rapidXy;
  return { rapidsCount, hopsCount, airFractionPct: total > 0 ? (rapidXy / total) * 100 : 0 };
}

/** `fmt3`: trims a computed mm figure to 3 decimals without carrying float noise into the note. */
const fmt3 = (n: number): string => String(Number(n.toFixed(3)));

/**
 * #965 registration's own stated sentence — names the datum `registerSetupOrigin` found and the
 * offset it computed, so the number in `SetupPlan.notes` is traceable to real recognised
 * geometry, never just "trust the vise".
 */
function describeRegistration(setupIndex: number, registration: SetupRegistration): string {
  const [dx, dy] = registration.offsetMm;
  const offset = `offset [${fmt3(dx)}, ${fmt3(dy)}] mm`;
  if (registration.datum.basis === 'two-holes') {
    const [h1, h2] = registration.datum.holes;
    return (
      `setup ${setupIndex}: registered against setup 0 via two through-holes — "${h1.id}" at ` +
      `(${fmt3(h1.x)}, ${fmt3(h1.y)}) and "${h2.id}" at (${fmt3(h2.x)}, ${fmt3(h2.y)}), ` +
      `${fmt3(registration.datum.separationMm)} mm apart — computed ${offset} (#965 registration)`
    );
  }
  const [a, b] = registration.datum.endpoints;
  return (
    `setup ${setupIndex}: registered against setup 0 via a single straight outline edge from ` +
    `(${fmt3(a[0])}, ${fmt3(a[1])}) to (${fmt3(b[0])}, ${fmt3(b[1])}), ${fmt3(registration.datum.lengthMm)} mm long ` +
    `— no through-hole pair qualified — computed ${offset} (#965 registration)`
  );
}

/**
 * THE ENTRY (#956 §3.0, filled in on F's check suite finding it still threw). One whole job — every
 * setup, every feature the tree recognises — planned through the model engine and returned as
 * #963's `SetupPlan`:
 *
 *   - the pocket chain by cost (`planPocketsForTree`), the curved remainder and the rims by the
 *     ruling's pipeline, and the freeing contour LAST (`planTreePrograms`);
 *   - programs ONE PER RUN, in execution order (a run starts when the cutter changes), each the
 *     concatenation of its ops' IRs;
 *   - cut numbers through the app's one feeds resolver (`feedsFor`), the shop's
 *     `toolChange.seconds` through the labelled default, both the same calls the rest of the app
 *     makes — this entry invents no numbers.
 *
 * STATED LIMITS, not silent ones: a fixture envelope is not yet wired into `RegionRef.obstacles`
 * (the plan says so in its notes; the sweep still checks the posted program against the SAME
 * envelope); `input.cutters.catalogue` is not in the pocket chain yet (`planPocketsForTree` takes
 * house flats only) — the plan says that too when a caller supplies one.
 */
export async function planModelCam(input: ModelPlanInput, opts: PlanModelCamOptions = {}): Promise<ModelPlanOutput> {
  const tl = await getToplevel();
  const offset = makeClipperOffset(tl);
  const boolean = { union: makeClipperUnion(tl), subtract: makeClipperSubtract(tl) };
  const toolChangeSeconds = readDefault(liveShopDefaults(), 'toolChange.seconds').value;
  // #961 — THE SIMULATED OUTCOME'S STAMP. With a goal supplied, every candidate the picker prices
  // is posted and stamped exactly as the goal check does, and the cells its sweep leaves above the
  // 0.1 mm band are counted — the rank's first key. The goal is the caller's (the job's target),
  // not re-derived here.
  const coverageGoal = input.goal;
  const coverageCtx: PostContext = {
    jobName: 'model-coverage',
    stock: { length: input.stock.length, width: input.stock.width, thickness: input.stock.thickness },
    materialName: input.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: 'model-cam',
    toolKey: 'multi',
  };
  // #961 — each distinct IR is posted and stamped ONCE, however many candidates carry it (the
  // steps' IRs are memoized in `planStep`, so identity is stable); a candidate's fold is then a
  // walk over its own IRs' cached fields.
  const stampCache = new WeakMap<ToolpathIR, Float32Array | null>();
  const stampedField = (ir: ToolpathIR): Float32Array | null => {
    const cached = stampCache.get(ir);
    if (cached !== undefined) return cached;
    let field: Float32Array | null = null;
    const posted = postZ1(ir, coverageCtx, Z1);
    if (posted.ok) {
      const parsed = parseGcode(posted.text);
      const part = setupFromHeader(parsed.header).patch.part;
      if (part !== undefined && part.kind === 'prism' && part.outline.kind === 'p-rect') {
        const setup = stubSetup(part, { kind: 'tape-down', contact: part.outline }, { startingTool: 1 }, Z1);
        const stamp = exactSweptFieldTooled(coverageGoal!, buildTimeline(parsed, setup, Z1), () => ir.tool);
        if (stamp !== null) field = stamp.field;
      }
    }
    stampCache.set(ir, field);
    return field;
  };
  // #961 follow-up — THE REST'S REGION FROM THE SIMULATED FIELD: the cells the chain so far
  // leaves more than the 0.1 mm band above the goal, inside the pocket's own footprint, as loops
  // (dilated by the ROUNDER in `planPocketsForTree`, which knows the cutter). A field that cannot
  // be stamped falls back to the whole footprint — the floor pass as it was.
  const restRegion = coverageGoal === undefined
    ? undefined
    : (prefixIrs: readonly ToolpathIR[], region: { id: string; footprint: Polygons; floorZ: number; bounds: { min: [number, number]; max: [number, number] } }): Polygons | null => {
        let acc: Float32Array | null = null;
        for (const ir of prefixIrs) {
          const field = stampedField(ir);
          if (field === null) continue;
          if (acc === null) acc = Float32Array.from(field);
          else for (let k = 0; k < acc.length; k++) if (field[k]! < acc[k]!) acc[k] = field[k]!;
        }
        if (acc === null) return region.footprint;
        const goal = coverageGoal;
        const pitch = goal.pitch;
        const i0 = Math.max(0, Math.floor((region.bounds.min[0] - goal.x0) / pitch));
        const i1 = Math.min(goal.nx - 1, Math.ceil((region.bounds.max[0] - goal.x0) / pitch));
        const j0 = Math.max(0, Math.floor((region.bounds.min[1] - goal.y0) / pitch));
        const j1 = Math.min(goal.ny - 1, Math.ceil((region.bounds.max[1] - goal.y0) / pitch));
        if (i1 < i0 || j1 < j0) return null;
        const cells = acc;
        const inside = (i: number, j: number): boolean => {
          const k = (j0 + j) * goal.nx + (i0 + i);
          if (goal.covered[k] !== 1) return false;
          if (!(cells[k]! - (goal.z[k] as number) > 0.1)) return false;
          const x = goal.x0 + (i0 + i) * pitch;
          const y = goal.y0 + (j0 + j) * pitch;
          return pointInPolygons(region.footprint, x, y);
        };
        return cellPolygons(inside, i1 - i0 + 1, j1 - j0 + 1, goal.x0 + i0 * pitch, goal.y0 + j0 * pitch, pitch);
      };
  const goalCoverage =
    coverageGoal === undefined
      ? undefined
      : (irs: readonly ToolpathIR[]): { leftoverCells: number; coveredCells: number; cellAreaMm2: number } | null => {
          let acc: Float32Array | null = null;
          for (const ir of irs) {
            const field = stampedField(ir);
            if (field === null) continue;
            if (acc === null) acc = Float32Array.from(field);
            else for (let k = 0; k < acc.length; k++) if (field[k]! < acc[k]!) acc[k] = field[k]!;
          }
          if (acc === null) return null;
          let covered = 0;
          let leftover = 0;
          for (let k = 0; k < acc.length; k++) {
            if (coverageGoal.covered[k] !== 1) continue;
            covered++;
            if (acc[k]! - (coverageGoal.z[k] as number) > 0.1) leftover++;
          }
          return { leftoverCells: leftover, coveredCells: covered, cellAreaMm2: coverageGoal.pitch * coverageGoal.pitch };
        };
  const perSetup: SetupPlan[] = [];
  // #965 registration — setup 0's own recognised tree is the document-frame ground truth every
  // later setup's locating features are read against (`registerSetupOrigin`'s own header on
  // `setups.ts`). Kept across loop iterations for exactly that comparison; `null` only before
  // setup 0 has run, which no setup ever observes (setup 0 never reads it).
  let setup0Tree: FeatureTree | null = null;

  for (let setupIndex = 0; setupIndex < input.setups.length; setupIndex++) {
    opts.signal?.throwIfAborted();
    const spec = input.setups[setupIndex]!;
    // #988 — THE SETUP'S DEPTH BAND (`SetupSpec.bandMm`, set by the seam from `cutWithinReach` or
    // a split's own band). Positive mm below the stock top; absent = the whole depth.
    const depthBandMm = spec.bandMm !== undefined && spec.bandMm > 0 ? spec.bandMm : undefined;
    opts.onProgress?.({ setupIndex, op: 'features', fraction: 0 });
    // #1018 — THE DOOR (see `shiftToStockTop`'s own header): every Z this setup's own tree, curved
    // geometry and pocket-floor bins see from here on is stock-top-relative, because the mesh
    // itself was shifted before any of them read it — not because each one subtracts `stockTop`
    // on its own way out.
    const { geometry: doorGeometry, frame: doorFrame } = shiftToStockTop(input.geometry, spec.frame);
    const tree = recogniseFeatures(doorGeometry, doorFrame, tl);
    if (setupIndex === 0) setup0Tree = tree;

    // #965 registration — computed, never assumed. `registerSetupOrigin` THROWS, by name, when
    // this part carries neither a reliable two-hole datum nor a long straight edge (see its own
    // header): that throw is left to propagate out of `planModelCam` rather than caught and
    // papered over with a nominal `[0, 0]`, per the issue's own ruling ("never falls back to a
    // guessed/nominal origin"). Only setup 0 is ever registration-free (it IS the reference).
    const registration: SetupRegistration | null = setupIndex === 0 ? null : registerSetupOrigin(setup0Tree!, tree);
    const registrationOffset: [number, number] = registration?.offsetMm ?? [0, 0];

    const flats = input.cutters.house
      .filter((t) => t.shape === 'flat' && (cuttingDiameter(t) ?? 0) > 0)
      .sort((a, b) => (cuttingDiameter(b) ?? 0) - (cuttingDiameter(a) ?? 0));
    const balls = input.cutters.house
      .filter((t) => t.shape === 'ball' && (cuttingDiameter(t) ?? 0) > 0)
      .sort((a, b) => (cuttingDiameter(b) ?? 0) - (cuttingDiameter(a) ?? 0));
    // #982 (the review session's ruling) — NO FLAT IN THE SET: the ball takes the primary's place.
    // It roughs with its own profile and the pocket floors are its scallop pass; the card states
    // the wall-foot fillet (the ball's radius) as the tradeoff. Only a set with NO round cutter at
    // all is refused, by name.
    const noFlatFallback = flats.length === 0;
    const primary = flats[0] ?? balls[0];
    if (primary === undefined) {
      throw new Error('cam/model/plan: the house states no flat end mill and no ball nose with a cutting diameter — no round cutter can plan this part');
    }
    // #986 — THE FINISHING BALL IS RANKED, NOT SIZED. Candidates are one ball per cutting
    // diameter (the longest flute of each), reach-filtered against this setup's deepest remainder;
    // the measured rank below prices them by finish + stamp and keeps the best. The old
    // "largest diameter, first in catalogue order" rule is the DEFAULT when there is no goal grid
    // to measure against — the documented pre-#986 behaviour, and this base pick.
    const deepestRemainderMm = tree.remainder.reduce((m, r) => Math.max(m, r.zTop - r.zBottom), 0);
    const ballCandidates = finishBallCandidates(input.cutters.house, deepestRemainderMm);
    let ball = balls[0];
    // #965 (the review session's ruling, item 3.1) — THE REST BALL: the next-smaller ball, admitted
    // only on a STATED reach that covers the deepest remainder. The vendor's long ⌀1
    // (6*1*30.5mm Ball Nose Engraving, 161032105031) states a 30.5 mm flute and reaches the
    // figures' 26 mm relief; the house's 0.5 ball states no flute length at all and failed on
    // reach in the review's own measurement, so it can never qualify. No new op: the rest runs the
    // finish's machinery over the ball's own leftover mask.
    const restBallFor = (chosen: Tool | undefined): Tool | undefined =>
      balls.find((t) => t !== chosen && (t.fluteLength ?? 0) >= deepestRemainderMm - 1e-9);
    // #989 — THE RIM STAGE TAKES THE PINNED V when the caller names one (`pinned.chamfer`, the
    // cutterKeyOf key the goal seam derives from its own chamfer request); otherwise the first
    // chamfer/engraving in the house, as before. A pin the house cannot answer is a caller bug,
    // never a silent fallback to another V (the cutter would not be the one the job named).
    const pinnedVKey = input.cutters.pinned?.['chamfer'];
    const pinnedV = pinnedVKey === undefined ? undefined : input.cutters.house.find((t) => cutterKeyOf(t) === pinnedVKey);
    if (pinnedVKey !== undefined && pinnedV === undefined) {
      throw new Error(`cam/model/plan: cutters.pinned.chamfer names "${pinnedVKey}" but the house has no cutter with that key — the rim stage cannot honour the pin`);
    }
    const vbit = pinnedV
      ?? input.cutters.house.find((t) => t.shape === 'chamfer')
      ?? input.cutters.house.find((t) => t.shape === 'engraving');
    // #982 — NO BALL IN THE SET: the flat finishes the curved remainder (a flat-raster over the
    // whole region, the flat's cusp rule), the creases via the rest with the smallest flat. The
    // throw the old code raised here was the refusal the ruling forbids.
    const finishFlat = flats.length > 0 ? flats[flats.length - 1] : undefined;

    const { params: pocketParams, substitution } = resolvedCutParams(input, primary);
    const feeds = { feedMmPerMin: pocketParams.feed, plungeFeedMmPerMin: pocketParams.plungeFeed };

    // THE REVIEW'S FINDING (item 8): the ball and the V each get their OWN catalogue row — not
    // the primary flat's, reused as every tool's numbers before this.
    const toolSubstitutions: string[] = substitution === null ? [] : [substitution];
    const vbitParams = vbit === undefined ? null : toolCutParams(input, vbit, pocketParams);

    // #985/#965 — THE STATED TOLERANCE, as a function of the ball: a stated cusp (`finishMm`)
    // wins; a stated PITCH (`finishStepOverMm`, a width) is converted to the cusp it leaves on the
    // FINISHING ball, whose radius the candidate supplies — never fed into `finishMm`'s height seat.
    const statedCuspFor = (b: Tool | undefined): number | undefined => {
      if (input.tolerances.finishMm !== undefined) return input.tolerances.finishMm;
      const pitch = input.tolerances.finishStepOverMm;
      const radiusMm = b === undefined ? undefined : (cuttingDiameter(b) ?? 0) / 2;
      if (pitch === undefined || radiusMm === undefined || !(radiusMm > 0) || !(pitch > 0)) return undefined;
      const half = pitch / 2;
      return radiusMm - Math.sqrt(Math.max(0, radiusMm * radiusMm - half * half));
    };

    // #982 — NO FLAT: each pocket node becomes a synthetic remainder-style region the curved
    // pipeline plans with the ball (its rough, then the ball's scallop finish). The floor is
    // CLAMPED at the real design top over the opening: a spurious pocket floor below the body
    // (the 11.37 mm gouge) yields no depth, so the ball can never cut through the part.
    const pocketFloorRegions: RemainderRegion[] = [];
    // #982's own note site ran BEFORE this setup's `notes` array exists (the walk below is
    // called before the array is built), a temporal-dead-zone crash waiting on the first pocket
    // narrower than the ball; #992 collects them here — same sentence, same position ahead of
    // the result notes — and the ids so ONE statement can state the cause with its count.
    const earlyNotes: string[] = [];
    const ballUncutIds: string[] = [];
    if (noFlatFallback) {
      const bins = buildTriangleBins(doorGeometry.triangles);
      const walkPockets = (nodes: PocketNode[]): void => {
        for (const node of nodes) {
          let designMax = -Infinity;
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const ring of node.region) {
            for (const [x, y] of ring) {
              minX = Math.min(minX, x); maxX = Math.max(maxX, x);
              minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            }
          }
          for (let x = minX; x <= maxX + 1e-9; x += 0.5) {
            for (let y = minY; y <= maxY + 1e-9; y += 0.5) {
              const top = topSurfaceAt(bins, x, y);
              if (top !== null && top > designMax) designMax = top;
            }
          }
          const zBottom = Number.isFinite(designMax) ? Math.max(node.floorZ, designMax) : node.floorZ;
          // The ball's CENTRE space: the footprint is eroded by the ball's radius, exactly as the
          // pocket chain offsets its loops — otherwise the ball's centre reaches the wall and its
          // flank cuts a radius into it (a 0.95 mm gouge measured on the elephant). Eroded, the
          // flank is tangent at the wall foot: the stated fillet, never a gouge.
          const ballRadius = (cuttingDiameter(primary) ?? 0) / 2;
          const footprint = ballRadius > 0 ? offset(node.region, -ballRadius) : node.region;
          if (footprint.length === 0) {
            earlyNotes.push(`${node.id}: the ball cannot enter this pocket (narrower than its radius) — left uncut`);
            ballUncutIds.push(node.id);
            walkPockets(node.children);
            continue;
          }
          pocketFloorRegions.push({
            id: node.id,
            footprint,
            area: Math.abs(node.region.reduce((sum, ring) => sum + ringAreaOf(ring), 0)),
            zTop: node.mouthZ,
            zBottom,
            triangles: new Uint32Array(0),
            slopeDeg: [0, 0],
            slopeMedianDeg: 0,
            in: 'top',
          });
          walkPockets(node.children);
        }
      };
      walkPockets(tree.pockets);
    }

    // #965 — the per-setup mesh the curved pipeline's `clSurface` must score against: `recogniseFeatures`
    // (above) already rotated `input.geometry` into THIS setup's frame to build `tree`; `clSurface`
    // is handed `ModelPlanInput.geometry` at every call site inside `planCurvedForTree` and must see
    // the SAME rotation, or a non-identity setup's drop-cutter reads the part's OLD orientation
    // against a tree built in the NEW one (`rotatedGeometryFor`'s own doc). Identity for `up = [0, 0, 1]`
    // (every job today), so this changes nothing for the existing single-setup caller.
    const curvedGeometry = rotatedGeometryFor(doorGeometry, doorFrame);

    // #986 — THE CURVED PIPELINE'S OPTIONS, as a function of the ball, so the SAME finish can be
    // planned once per candidate for measurement and then once for the winner.
    // #1019 — THE CURVED ROUGH'S REACH, PER REGION (6b's ruling (b), per-feature). Each curved
    // remainder region keeps the first stated flat whose USABLE length (shoulder, else flute —
    // the holder gate's own number) reaches THAT region's depth below the stock top; a region no
    // flat reaches is the ball's rough instead (#982's mechanism), stated on its own line. One
    // deep pocket therefore costs its own region a ball rough, never the whole side.
    //
    // AN UNSTATED LENGTH IS NOT A SHORT ONE. A flat that states no shoulder and no flute has an
    // unknown reach, not a known-insufficient one: the holder gate owns that question, and the
    // flat keeps the rough (the pre-#1019 behaviour). Only a STATED length below the region's
    // depth makes the flat absent for that region — the case the sentence names.
    //
    // These are declared BEFORE `curvedOptionsFor` on purpose: the #986 ball rank calls that
    // helper for every candidate, and a `const` declared after it would be in its temporal dead
    // zone there — every candidate would throw and the rank would measure none (the gate's
    // finishBallFixture986 failure, 2026-11-06).
    const usableLengthMm = (t: Tool): number | null => t.shoulderLength ?? t.fluteLength;
    /** The stated flat whose usable length reaches this region, or null when none does. */
    const reachingFlatFor = (r: RemainderRegion): Tool | null => {
      // #1018 — the door shifts the mesh by `-stockTop` once, so the region's own zBottom is
      // already stock-top-relative: the depth below the stock top is `-zBottom` (frame.stockTop
      // reads 0 here), no rebase added.
      const depth = -r.zBottom;
      return flats.find((t) => {
        const usable = usableLengthMm(t);
        return usable === null || usable + 1e-9 >= depth;
      }) ?? null;
    };
    const curvedOptionsFor = (b: Tool | undefined, paramsFor: (tool: Tool) => CutParams): PlanCurvedOptions => ({
      offset,
      safeZMm: SAFE_Z,
      hopZMm: HOP_Z,
      ...(depthBandMm === undefined ? {} : { depthBandMm }),
      geometry: curvedGeometry,
      // #982 — NO FLAT ANYWHERE IN THE HOUSE: the ball stands in for the flat (ball-as-rough,
      // 0ca79e89's disc-aware proof against the region and the CL), and the pocket floors (no
      // pocket chain at all without a flat) become `extraRegions`. A goal's own `curvedRoughTool`
      // is moot here — with no flat anywhere it can only ever validate to `null` (see the other
      // branch's own doc), which this one already subsumes with the more capable mechanism.
      //
      // #869/#966 — otherwise: absent (every existing caller): `primary`, unchanged. `null` (a
      // goal with no `roughToolKey`): no rough, ball alone. A `Tool` (a goal's validated
      // `roughToolKey`): that tool roughs instead of `primary`, which this job's own pockets (if
      // it has any) still use — the two are independent on purpose, see
      // `ModelPlanInput.curvedRoughTool`'s own doc.
      // #982 — NO FLAT ANYWHERE IN THE HOUSE: the pocket floors become the ball's own regions,
      // standing in for the whole pocket chain. #1021's strips are NOT added here: they depend on
      // the chain the plan actually chooses, so `planTreePrograms` decides them after the pockets
      // and merges them into these options (see `PlanTreeOptions.floorStrips`).
      ...(noFlatFallback
        ? { flat: primary, extraRegions: pocketFloorRegions }
        : input.curvedRoughTool === undefined
          ? flats.length > 0
            ? { flat: primary, flatFor: (r: RemainderRegion): Tool | null => reachingFlatFor(r) ?? b ?? null }
            : b === undefined
              ? {}
              : { flat: b }
          : input.curvedRoughTool === null
            ? {}
            : { flat: input.curvedRoughTool }),
      ...(b === undefined ? {} : { ball: b }),
      ...(restBallFor(b) === undefined ? {} : { restBall: restBallFor(b) }),
      // #982 — NO BALL IN THE SET: the flat finishes the curved remainder (a flat-raster over
      // the whole region, the flat's cusp rule), the creases via the rest with the smallest flat.
      ...(b === undefined ? { finishFlat: finishFlat ?? primary } : {}),
      ...(b === undefined && finishFlat !== undefined && finishFlat !== primary ? { restFlat: finishFlat } : {}),
      ...(vbit === undefined ? {} : { vbit }),
      stepDownMm: pocketParams.stepDown,
      bandMm: MODEL_STOCK_TO_LEAVE_MM,
      // #965/#985 — the job's own tolerance, per candidate (see `statedCuspFor`): a stated cusp
      // wins, a stated pitch converts on THIS ball's radius, and the 0.027 mm default stands only
      // when the job states neither.
      finishScallopMm: statedCuspFor(b) ?? DEFAULT_FINISH_SCALLOP_MM,
      stepOverMm: pocketParams.stepOver,
      feeds,
      cutParamsFor: paramsFor,
      rapid: Z1.rapidEstimate,
      spindleRpm: pocketParams.rpm,
      air: true,
      edgeBreak: input.edgeBreak,
      toolNumberFor: (tool) => tool.number ?? 1,
      facing: input.facing ?? 'off',
      ...(input.flatSurfaceMaxSlopeDeg === undefined ? {} : { flatSurfaceMaxSlopeDeg: input.flatSurfaceMaxSlopeDeg }),
    });
    // The cut params a ball candidate would use — the same rule the chosen ball's `cutParamsFor`
    // applies, so the measurement prices each candidate with its own catalogue row.
    const cutParamsForBall = (b: Tool | undefined): ((tool: Tool) => CutParams) => {
      const bp = b === undefined ? null : toolCutParams(input, b, pocketParams);
      return (tool: Tool): CutParams => {
        if (b !== undefined && tool === b && bp !== null) return bp.params;
        if (vbit !== undefined && tool === vbit && vbitParams !== null) return vbitParams.params;
        return pocketParams;
      };
    };
    // #986 — THE RANK: finish each candidate over the remainder and stamp it against the goal
    // grid; keep the least leftover, then the cheaper cycle. The owned ball is always among the
    // candidates (the ideal's house contains the owned set), so a superset can never score below
    // its subset by construction. No goal grid → nothing to measure, and the pick above stands.
    // #986 (the ruling) — THE RANK'S OWN STATEMENT: every measured candidate's leftover and
    // cycle, the one that won, and the uncapped best as a fact. It rides the plan's notes.
    const ballRankNotes: string[] = [];
    if (coverageGoal !== undefined && goalCoverage !== undefined && ballCandidates.length > 1 && tree.remainder.length > 0) {
      let best: { tool: Tool; leftover: number; cycle: number } | null = null;
      let uncappedBest: { tool: Tool; leftover: number; cycle: number } | null = null;
      const measuredRows: string[] = [];
      // #986 — MEASURE THE LIKELY WINNER FIRST, THEN STOP AT THE FIRST NON-IMPROVEMENT. Candidates
      // are ordered FINE → COARSE, because leftover is monotone in the diameter: a smaller ball
      // reaches deeper into a crease, so it leaves no more than a larger one on the same remainder.
      // The finest reaching ball is therefore the likely winner and is measured first; the first
      // candidate that fails to beat the best ends the search, because every candidate after it is
      // coarser still. Two finishes per plan is the normal case (the panther's target 200–300 s
      // for the ideal); the monotone argument is stated here so the early exit is auditable, and a
      // candidate that does TIE keeps the cycle tie-break.
      const ordered = [...ballCandidates].sort((a, b) => (cuttingDiameter(a) ?? 0) - (cuttingDiameter(b) ?? 0));
      for (const candidate of ordered) {
        opts.signal?.throwIfAborted();
        let measured: PlanCurvedResult;
        try {
          // #986 (the ruling) — CANDIDATES ARE RANKED COARSE, at the vendor's cusp, on the 4a
          // mask; only the WINNER is planned at the job's own tolerance. The rank compares balls,
          // and the cusp the job states is a property of the chosen finish, not of the candidate.
          measured = planCurvedForTree(tree, {
            ...curvedOptionsFor(candidate, cutParamsForBall(candidate)),
            finishScallopMm: DEFAULT_FINISH_SCALLOP_MM,
          });
        } catch {
          continue; // a candidate that cannot plan this remainder is not a candidate
        }
        const coverage = goalCoverage(measured.ops.map((o) => o.outcome.ir));
        if (coverage === null) continue;
        const leftover = coverage.leftoverCells / Math.max(1, coverage.coveredCells);
        const cycle = measured.ops.reduce(
          (n, o) => n + o.outcome.ir.operations.reduce((k, op) => k + (op.estimatedSeconds ?? 0), 0),
          0,
        );
        // #986 (the maintainer's ruling) — NO CYCLE CAP: a longer plan is a cost the operator is
        // shown, not a reason to hide a better surface. Every measured candidate is stated with
        // its leftover and its cycle, and the rank decides on outcome.
        if (uncappedBest === null || leftover < uncappedBest.leftover - 1e-9 || (Math.abs(leftover - uncappedBest.leftover) <= 1e-9 && cycle < uncappedBest.cycle)) {
          uncappedBest = { tool: candidate, leftover, cycle };
        }
        const diameterMm = cuttingDiameter(candidate) ?? 0;
        measuredRows.push(`⌀${diameterMm.toFixed(2)} mm ${candidate.name}: leftover ${(leftover * 100).toFixed(2)} %, cycle ${cycle.toFixed(0)} s`);
        if (best === null || leftover < best.leftover - 1e-9 || (Math.abs(leftover - best.leftover) <= 1e-9 && cycle < best.cycle)) {
          best = { tool: candidate, leftover, cycle };
          continue;
        }
        // Coarser and not better: stop. Every remaining candidate is coarser still.
        if (leftover > best.leftover + 1e-9) break;
      }
      if (best !== null) ball = best.tool;
      // The rank's statement: the measured candidates, the winner, and the uncapped best as a fact.
      const chosen = best === null ? 'no candidate could plan the remainder — the pre-#986 pick stands' : `${best.tool.name} (leftover ${(best.leftover * 100).toFixed(2)} %, cycle ${best.cycle.toFixed(0)} s)`;
      ballRankNotes.push(
        `ball rank: measured ${measuredRows.length} candidate(s) — ${measuredRows.join('; ')}. Chosen: ${chosen}.` +
          (uncappedBest !== null && (best === null || uncappedBest.tool !== best.tool)
            ? ` The uncapped best is ${uncappedBest.tool.name} (leftover ${(uncappedBest.leftover * 100).toFixed(2)} %, cycle ${uncappedBest.cycle.toFixed(0)} s).`
            : ''),
      );
    }
    // The chosen ball's own params and note (the note joins the substitution statements) — read
    // AFTER the rank, so a candidate that won gets its own catalogue row, never the default's.
    const restBall = restBallFor(ball);
    const ballParams = ball === undefined ? null : toolCutParams(input, ball, pocketParams);
    if (ballParams?.note !== null && ballParams?.note !== undefined) toolSubstitutions.push(ballParams.note);
    if (vbitParams?.note !== null && vbitParams?.note !== undefined) toolSubstitutions.push(vbitParams.note);
    const restBallParams = restBall === undefined ? null : toolCutParams(input, restBall, pocketParams);
    if (restBallParams?.note !== null && restBallParams?.note !== undefined) toolSubstitutions.push(restBallParams.note);
    // #990 — EVERY OTHER CUTTER GETS ITS OWN ROW TOO: a rest flat, the goal's own
    // `curvedRoughTool`, a smaller skin/rest flat — anything in the house that differs from
    // `primary` was silently handed `pocketParams` (the primary's feed/step-down/RPM) until now.
    // Memoised by cutter key, so a plan with several candidate flats resolves each ONCE no
    // matter how many ops ask for it.
    const otherParams = new Map<string, CutParams>();
    const notedOthers = new Set<string>();
    const primaryKey = cutterKeyOf(primary);
    const cutParamsFor = (tool: Tool): CutParams => {
      if (ball !== undefined && tool === ball && ballParams !== null) return ballParams.params;
      if (restBall !== undefined && tool === restBall && restBallParams !== null) return restBallParams.params;
      if (vbit !== undefined && tool === vbit && vbitParams !== null) return vbitParams.params;
      const key = cutterKeyOf(tool);
      if (key === primaryKey) return pocketParams;
      const cached = otherParams.get(key);
      if (cached !== undefined) return cached;
      const { params, note } = toolCutParams(input, tool, pocketParams);
      otherParams.set(key, params);
      if (note !== null && !notedOthers.has(key)) {
        notedOthers.add(key);
        toolSubstitutions.push(note);
      }
      return params;
    };

    opts.onProgress?.({ setupIndex, op: 'sequence', fraction: 0.4 });

    // #965 — MULTI-SETUP TABS: a job with more than one setup must stay ONE piece of stock
    // through the turn-over, so every setup but the LAST keeps the pocket chain's own default
    // tabs (`DEFAULT_RELEASE_TABS`) on its freeing contour, whatever `spec.underside` says — the
    // part is not released until it has nothing left to turn INTO. The LAST setup's freeing
    // contour is the one that actually frees the part (`{ count: 0 }`, the pocket chain's own
    // explicit-release case). A single-setup job (today's only real caller) is untouched: `tabs`
    // is left unset, so `planPocketsForTree` keeps its own `DEFAULT_RELEASE_TABS` default exactly
    // as before.
    //
    // STATED, NOT YET DONE (#965 open item — flagged in this issue's progress comment, not
    // guessed): the LAST setup's freeing contour is still a FLAT-Z pass to `tree.contour.zTo`,
    // the SAME op a single-setup job posts. #898 part 2's "tabbed freeing cut ... re-planned over
    // the CL surface" — tracking the OTHER setup's already-cut 3D surface instead of one flat Z,
    // so the final release cannot stand on (or cut into) whatever the earlier setup already
    // shaped on what is now the underside — is NOT implemented: `contourOp`/`ops/contour.ts` has
    // no CL-surface input today. A multi-setup job's last-setup release is therefore only as safe
    // as `tree.contour.zTo` being shallow enough not to reach the opposite setup's cut, which this
    // plan does not check.
    // #988 — A BANDED CONTOUR DOES NOT REACH THE PART'S BOTTOM, so it frees nothing and the
    // release instruction must not be given: the contour keeps its tabs exactly as a non-last
    // setup's does. (The band is measured from this setup's stock top.)
    const bandReachesBottom = depthBandMm === undefined || depthBandMm + 1e-9 >= -tree.contour.zTo;
    const tabs =
      input.setups.length <= 1 || !bandReachesBottom
        ? undefined
        : setupIndex === input.setups.length - 1
          ? { count: 0, width: DEFAULT_RELEASE_TABS.width, height: DEFAULT_RELEASE_TABS.height }
          : DEFAULT_RELEASE_TABS;

    // #965/#898 part 2: the LAST setup's freeing contour must not cut past the OPPOSITE setup's
    // already-finished surface (this file's own #965 open-item note, below, used to be the whole
    // story). Only the LAST of exactly two setups has an opposite one already planned — a single-
    // setup job's `setupIndex` is never `> 0`, so `oppositeSafeDepthMm` stays `undefined` and
    // `contourOp` behaves exactly as before (#959/#960's regression safety); the FIRST setup's own
    // contour has no earlier setup to read either. `buildSetupSpecs`'s own stated scope (#965
    // header) offers only `top`/`bottom` — `perSetup[0]` IS "the opposite setup" whenever this
    // branch runs, never a guess at which earlier entry that is.
    //
    // The opposite setup's "finished surface" is read straight off the SAME design mesh
    // (`input.geometry`, rotated into ITS frame — `rotatedGeometryFor`, the same helper `curvedGeometry`
    // above uses) via a real drop-cutter height (`dropcutter.ts`, #957) — not `clGrid` (it carries
    // only `{toleranceMm, minSpacingMm, maxSpacingMm}` per cutter, a report of what was sampled,
    // never the sampled heights themselves, so it cannot answer "how deep is safe at (x, y)").
    // Re-querying the mesh directly is the SAME ground truth `rough`/`rest`/`finish` already trust
    // for "where the final surface is," not a second, divergent source.
    //
    // The cutter used to read it is THIS setup's own `primary` flat — not a guess: a LARGER radius
    // leaves MORE material standing in a tight corner than the mesh's own mathematical surface
    // (concave corners it cannot fully enter), so reading the opposite surface through the SAME
    // tool radius that actually cut it is the conservative direction — it never reports less
    // material remaining there than the real cut would leave.
    let oppositeSafeDepthMm: ((x: number, y: number) => number | null) | undefined;
    const freeingNotes: string[] = [];
    // #992 — the freeing-depth check's outcome, typed: the bounded case is a fact of the run
    // (sheet); the two "not checked" cases are developer gaps and stay in `notes` only.
    const freeingStatements: PlanStatement[] = [];
    if (setupIndex > 0 && setupIndex === input.setups.length - 1) {
      const opposite = perSetup[0];
      if (opposite === undefined) {
        throw new Error('cam/model/plan: the last setup has no earlier setup planned yet to free against (#965) — the setup loop order is broken');
      }
      const [ux, uy, uz] = spec.frame.up;
      if (ux === 0 && uy === 0 && uz === -1) {
        const oppositeGeometry = rotatedGeometryFor(input.geometry, opposite.features.frame);
        const profile = profileOf(primary);
        if (profile === null) {
          freeingNotes.push(
            `setup ${setupIndex}: the freeing contour's depth could not be checked against setup 0's finished surface — ${primary.name || primary.shape} has no drop-cutter profile (#965) — it still cuts to this setup's own flat zTo`,
          );
        } else {
          const mesh: DropCutterMesh = oppositeGeometry.triangles;
          const frameForQuery = spec.frame;
          // #965 review finding: this setup's own `registrationOffset` — the SAME one
          // `mapIRToDocument` below places this setup's posted moves with — or the safety check
          // and the real cut disagree about where a point is the moment registration is ever
          // non-zero.
          oppositeSafeDepthMm = (x: number, y: number): number | null =>
            oppositeSurfaceSafeDepthMm(frameForQuery, profile, mesh, x, y, ARC_CHORD_TOLERANCE_MM, registrationOffset);
          freeingNotes.push(
            `setup ${setupIndex}: the freeing contour's depth is bounded, at every point its path samples, by setup 0's own finished surface (#965, #898 part 2) — it will not cut deeper than that surface, read through this setup's own ${primary.name || primary.shape}`,
          );
          freeingStatements.push({ severity: 'sheet', code: 'plan-run', count: 1, text: freeingNotes[freeingNotes.length - 1]! });
        }
      } else {
        freeingNotes.push(
          `setup ${setupIndex}: this setup's frame is not the stated bottom flip (#965 scope: up = [0, 0, -1]) — the freeing contour is NOT checked against setup 0's surface and still cuts to this setup's own flat zTo`,
        );
      }
    }


    const curvedRoughSubstitutions: string[] =
      !noFlatFallback && flats.length > 0 && input.curvedRoughTool === undefined
        ? tree.remainder
            // E's review (finding 2): filter on the FLAT's own reach. `curvedFlatFor` returns the
            // BALL when no flat reaches, so a null test there only ever caught the no-ball case
            // and the substitution was never stated on a job that really ball-roughed a region.
            .filter((r) => reachingFlatFor(r) === null)
            .map((r) => {
              const named = flats[0]!;
              const usable = usableLengthMm(named);
              const depth = Number((-r.zBottom).toFixed(1));
              const ballName = ball === undefined ? 'no ball in the set' : (ball.name || 'the ball');
              return `"${r.id}": the ${named.name || named.shape}'s ${usable === null ? 'unstated' : `${usable} mm`} usable length does not reach the ${depth} mm this region cuts below the stock top — ${ballName} roughs it`;
            })
        : [];
    // #1021 — THE FLOOR STRIPS THE PRIMARY FLAT'S RING CANNOT REACH, WHEN NOTHING ELSE OWNS THEM.
    // A floor strip narrower than the flat's diameter never holds a ring (`pocketLoops` insets by
    // the radius, and the strip's centre space is empty by construction), and with a flat in the
    // set the #982 ball-only floor regions are never built; #961's rest owns these cells only when
    // the set holds a rest cutter. With a flat, a ball and no rest, the strip belongs to nobody —
    // the tray's five strips between the scoops stand as the two balls' scallop cusp (0.70 mm).
    // Each node's gap (`region \ fullyReachable(region, R_flat)`, the same erode/dilate pair
    // `pocketLoops` rings with) is built here and handed to the curved pipeline as
    // `extraRegions`: the ball rasters the strips against the real CL surface (never deeper than
    // the design) as its own floor pass.
    //
    // COST (#1021 §8.9): one erode+dilate + subtract per pocket node, one boundary-band offset
    // per node with interior components, one erode per strip per rest flat the chain runs (the
    // ownership test) and one drop-cutter CL sampling per kept strip — all plan-time work over
    // small polygons, milliseconds on the tray's 20 nodes and the organizer's 58. Nothing is
    // posted for a strip nothing can enter; a strip the ball fits is planned as its own floor
    // pass (feed over the strip's own area).
    //
    // THE KEEP RULES. First, A STRIP LIES INSIDE THE FLOOR: a gap component that touches the
    // node's own outer boundary is a CORNER — the flat's wall-foot tradeoff, which the card
    // already states and which a ball reaches no better (its own fillet is its radius). Only
    // components clear of that boundary are strips the rings genuinely cannot own. The node's
    // HOLES (islands, and the curved regions' mouths) are not its outer boundary: a strip between
    // two scoops touches both of their walls and nothing else, and is kept.
    //
    // Second, A STRIP A SMALLER FLAT CAN ENTER IS THE REST'S (the maintainer's 11-05 ruling, the
    // 2026-11-06 narrowing): #961's rest already owns every strip a smaller owned flat can reach
    // — on the app path the ⌀3.175 rest cuts the tray's five strips to their floor at −4.200 —
    // so this builder keeps only the strips NO owned flat can enter. A strip the ball alone could
    // reach is exactly the no-rest-flat case this issue is about.
    const buildFloorStrips = (restCutters: readonly Tool[], statedByPlan: ReadonlySet<string>): PlanningFloorStrips => {
      const regions: RemainderRegion[] = [];
      const unreachable: { id: string; area: number; fitShare: number }[] = [];
      const planned: PlanningFloorStrips['planned'] = [];
      const masks = new Map<string, (x: number, y: number) => boolean>();
      if (noFlatFallback) return { regions, unreachable, planned, masks };
      const flatRadius = (cuttingDiameter(primary) ?? 0) / 2;
      if (flatRadius > 0) {
        // Signed, so a hole (negative) is never mistaken for a component.
        const signedArea = (ring: readonly [number, number][]): number => {
          let a = 0;
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            a += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
          }
          return a / 2;
        };
        const areaOf = (polys: Polygons): number => polys.reduce((s, ring) => s + signedArea(ring), 0);
        const intersect = (a: Polygons, b: Polygons): Polygons => boolean.subtract(a, boolean.subtract(a, b));
        // A 0.05 mm band inside the outer ring — wide enough to survive polygonization, far
        // narrower than any real corner, so only a component that reaches the boundary touches it.
        const BOUNDARY_BAND_MM = 0.05;
        const walkStrips = (nodes: PocketNode[]): void => {
          for (const node of nodes) {
            // A through node has no floor (the contour frees it); nothing to finish. Neither has
            // a ZERO-DEPTH node — one whose floor is its mouth (the organizer's engraved outlines
            // read as pockets at −0.80): its "strip" is the surface itself, and a ball pass over
            // it would be a no-op stated as a missing floor.
            const outer =
              node.through || node.floorZ >= node.mouthZ - 0.05 || statedByPlan.has(node.id)
                ? []
                : node.region.filter((ring) => signedArea(ring) > 0);
            if (outer.length > 0) {
              const reach = fullyReachable(node.region, offset, flatRadius);
              const gap = boolean.subtract(node.region, reach);
              let kept: Polygons;
              if (reach.length === 0 || Math.abs(areaOf(reach)) <= 1e-9) {
                // THE WHOLE NODE IS THE STRIP: the flat's ring cannot enter the floor at all (the
                // organizer's pocket-34, a 66 × 1.1 mm ledge). There is no interior to judge — the
                // node's floor is the strip, so it is kept WHOLE, holes included: keeping only the
                // positive rings claimed an island's footprint as strip (F's review, finding 1).
                kept = node.region;
              } else {
                const band = boolean.subtract(outer, offset(outer, -BOUNDARY_BAND_MM));
                kept = [];
                let current: Polygons | null = null;
                // Clipper emits each component's outer ring followed by its holes; judge the
                // component as one polygon set (its holes included) and keep it whole or not at all.
                const flush = (): void => {
                  if (current !== null && current.length > 0 && areaOf(intersect(current, band)) <= 1e-6) kept.push(...current);
                  current = null;
                };
                for (const ring of gap) {
                  if (signedArea(ring) > 0) {
                    flush();
                    current = [ring];
                  } else if (current !== null) {
                    current.push(ring);
                  }
                }
                flush();
              }
              // Slivers below a tenth of a square millimetre are polygon noise, not floors.
              if (Math.abs(areaOf(kept)) < 0.1) kept = [];
              // A strip an owned FLAT can enter is the rest's (see this block's keep rules): the
              // eroded component is non-empty for any flat whose radius fits inside it.
              // The REST'S OWNERSHIP IS THE PLAN'S, NOT THE SET'S: only a rest step this plan
              // actually runs can own a strip (on the ideal run the house is owned ∪ catalogue,
              // and a catalogue flat the chain never uses must not silence it).
              const restOwned = kept.length === 0
                ? true
                : restCutters.some((candidate) => {
                    if (candidate.shape !== 'flat') return false;
                    const r = (cuttingDiameter(candidate) ?? 0) / 2;
                    if (!(r > 0)) return false;
                    const eroded = offset(kept, -r);
                    return eroded.length > 0 && Math.abs(areaOf(eroded)) > 1e-9;
                  });
              // THE BALL FITS BY ITS DROP-CUTTER, AND THE FIT RETURNS THE AREA IT REACHES (#1026).
              // The fit samples the strip's cells at their CENTRES (phase bbox + pitch/2 — a grid
              // from the bbox minimum put its first column on the strip's edge and read 14.3 % of
              // a strip the ball reaches along 0.3 mm of it) and keeps the cells whose CL is
              // within the plan's 0.1 mm goal band of the node's floor. Those cells — as a
              // polygon via `cellPolygons`, the #961 helper — ARE the region the ball's floor
              // pass is planned over, so the pass rasters ground the ball can reach and no air
              // over ground it cannot. The bar is AREA: plan when the reachable area is at least
              // max(1 mm², the ball's step-over × 1 mm); below that the whole strip is stated
              // standing. A strip every sampled cell reaches keeps its ORIGINAL footprint, so the
              // cards' plans stay byte-identical.
              const ballRadiusMm = ball === undefined ? 0 : (cuttingDiameter(ball) ?? 0) / 2;
              const BAND_MM = 0.1;
              let ballFitShare = 0;
              let ballFits = false;
              let plannedStrip:
                | { footprint: Polygons; reachArea: number; stripArea: number; staysArea: number; standingMm: number; allReached: boolean }
                | null = null;
              let fitGrid: { nx: number; ny: number; minX: number; minY: number; pitch: number; reach: Uint8Array; cl: ReturnType<typeof clSurface> } | null = null;
              if (kept.length > 0 && ball !== undefined && ballRadiusMm > 0) {
                const fitRegion: RemainderRegion = {
                  id: `${node.id}:fit`,
                  footprint: kept,
                  area: Math.abs(areaOf(kept)),
                  zTop: node.mouthZ,
                  zBottom: node.floorZ,
                  triangles: new Uint32Array(0),
                  slopeDeg: [0, 0],
                  slopeMedianDeg: 0,
                  in: 'top',
                };
                const cl = clSurface(curvedGeometry, fitRegion, ball, pocketParams.stepOver);
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const ring of kept) {
                  for (const [x, y] of ring) {
                    if (x < minX) minX = x;
                    if (x > maxX) maxX = x;
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                  }
                }
                const FIT_PITCH_MM = 0.5;
                const nx = Math.max(1, Math.ceil((maxX - minX) / FIT_PITCH_MM));
                const ny = Math.max(1, Math.ceil((maxY - minY) / FIT_PITCH_MM));
                const reach = new Uint8Array(nx * ny);
                let cells = 0;
                let within = 0;
                let standingMm = 0;
                for (let j = 0; j < ny; j++) {
                  for (let i = 0; i < nx; i++) {
                    const x = minX + (i + 0.5) * FIT_PITCH_MM;
                    const y = minY + (j + 0.5) * FIT_PITCH_MM;
                    if (!pointInPolygons(kept, x, y)) continue;
                    const clAt = cl.dropCutter(x, y);
                    if (clAt === null) continue;
                    cells++;
                    const stand = clAt - node.floorZ;
                    if (stand <= BAND_MM) {
                      within++;
                      reach[j * nx + i] = 1;
                    } else if (stand > standingMm) {
                      standingMm = stand;
                    }
                  }
                }
                ballFitShare = cells === 0 ? 0 : within / cells;
                fitGrid = { nx, ny, minX, minY, pitch: FIT_PITCH_MM, reach, cl };
                const cellAreaMm2 = FIT_PITCH_MM * FIT_PITCH_MM;
                const reachArea = within * cellAreaMm2;
                const stripArea = Math.abs(areaOf(kept));
                ballFits = reachArea >= Math.max(1, (ballParams?.params.stepOver ?? 0) * 1);
                if (ballFits) {
                  const allReached = cells > 0 && within === cells;
                  plannedStrip = {
                    footprint: allReached
                      ? kept
                      : cellPolygons((i, j) => reach[j * nx + i] === 1, nx, ny, minX, minY, FIT_PITCH_MM),
                    reachArea,
                    stripArea,
                    staysArea: Math.max(0, stripArea - reachArea),
                    standingMm,
                    allReached,
                  };
                }
              }
              if (kept.length > 0 && !restOwned && !ballFits) {
                unreachable.push({ id: node.id, area: Math.abs(areaOf(kept)), fitShare: ballFitShare });
              }
              if (kept.length > 0 && !restOwned && ballFits && plannedStrip !== null) {
                // THE FLOOR IS THE NODE'S OWN, not a sampled design top: the #982 clamp's
                // `max(floorZ, designMax)` read the part's top over the opening on the tray and the
                // organizer and collapsed strips to zero-depth passes at the mouth (topZ = bottomZ
                // = −1.20 and −0.80 measured), which then cut nothing and were stated wrongly.
                const zBottom = node.floorZ;
                const stripId = `${node.id}:floor-strip`;
                const reachCells: { x: number; y: number }[] = [];
                const grid = fitGrid;
                if (grid !== null) {
                  for (let j = 0; j < grid.ny; j++) {
                    for (let i = 0; i < grid.nx; i++) {
                      if (grid.reach[j * grid.nx + i] !== 1) continue;
                      reachCells.push({ x: grid.minX + (i + 0.5) * grid.pitch, y: grid.minY + (j + 0.5) * grid.pitch });
                    }
                  }
                  // The mask admits a point only where the BALL'S OWN CL is within the band of the
                  // floor — the fit's rule, point for point — so the finish's rows cannot climb a
                  // wall the ball does not reach (its raster Z is the CL, which rides the wall).
                  const clForMask = grid.cl;
                  masks.set(stripId, (x: number, y: number): boolean => {
                    const at = clForMask.dropCutter(x, y);
                    return at !== null && at <= node.floorZ + BAND_MM;
                  });
                }
                planned.push({
                  id: stripId,
                  nodeId: node.id,
                  reachArea: plannedStrip.reachArea,
                  stripArea: plannedStrip.stripArea,
                  staysArea: plannedStrip.staysArea,
                  standingMm: plannedStrip.standingMm,
                  allReached: plannedStrip.allReached,
                  cells: reachCells,
                });
                regions.push({
                  id: `${node.id}:floor-strip`,
                  footprint: plannedStrip.footprint,
                  area: plannedStrip.reachArea,
                  zTop: node.mouthZ,
                  zBottom,
                  triangles: new Uint32Array(0),
                  slopeDeg: [0, 0],
                  slopeMedianDeg: 0,
                  in: 'top',
                });
              }
            }
            walkStrips(node.children);
          }
        };
        walkStrips(tree.pockets);
      }
      return { regions, unreachable, planned, masks };
    };

    const result = planTreePrograms(tree, {
      offset,
      floorStrips: buildFloorStrips,
      pockets: noFlatFallback ? null : {
        ...(depthBandMm === undefined ? {} : { depthBandMm }),
        houseFlats: flats,
        houseAll: input.cutters.house,
        ...(input.sacrificialBreakthroughMm === undefined ? {} : { sacrificialBreakthroughMm: input.sacrificialBreakthroughMm }),
        // #975 — the V bits are the pocket chain's last resort: a pocket no flat covers gets the
        // narrowest V whose tip fits the stroke and whose leg reaches the floor, floor-correct.
        houseVs: input.cutters.house.filter((t) => isVShape(t)),
        paramsFor: cutParamsFor,
        stepDownMm: pocketParams.stepDown,
        feeds,
        rapid: Z1.rapidEstimate,
        toolChangeSeconds,
        spindleRpm: pocketParams.rpm,
        air: true,
        boolean,
        // #966/#970 — the per-level shadow check (`PocketOpOptions.aboveMaterial`'s own doc): the
        // SAME rotated design mesh `curvedGeometry` below already reads for this setup's own frame,
        // so every pocket/facing/through-as-pocket op this setup plans is bounded by the real
        // ceiling, not just each node's own static `region` — #970's own finding (a ⌀6 flat planned
        // straight through ~22 mm of the elephant's body, because the belly closing the gap above a
        // recognised floor was never checked).
        //
        // CORRECTION (Session A, independent re-check): `curvedOpsProperty959.spec.ts`'s own
        // `sloped`/`filletedFloor` coverage drop, first reported here as "CSG-noise artefact of
        // `slopedPocketVoid`/`filletFloorVoid`'s own construction," was NOT that — both flagged
        // nodes are the ordinary open-shoulder-notch and blind-hole subtraction every
        // `randomParts.ts` kind shares, and a direct `dropCutterHeight` probe at each one's own
        // centroid read back EXACTLY its own `floorZ`, real material, not stock top. The actual
        // cause (confirmed by tracing and fixed in `ops/pocket.ts`'s own `ceilingMaskAt`): the
        // per-level predicate read a node's OWN floor — the only thing a probe ever finds along a
        // vertical line through a floor with nothing above it — as an obstruction AT that floor's
        // own depth, excluding the node's entire LAST pass. Fixed at the source; see
        // `ops/pocket.ts`'s own comment at the predicate and `pocketShadow966.spec.ts`'s "#970
        // over-clip" / `pocketShadowNestedFloor966.spec.ts` cases. `curvedOpsProperty959` is back
        // at its own 95% line, unchanged.
        shadowMesh: curvedGeometry.triangles,
        ...(tabs === undefined ? {} : { tabs }),
        ...(oppositeSafeDepthMm === undefined ? {} : { oppositeSafeDepthMm }),
        facing: input.facing ?? 'off',
        ...(goalCoverage === undefined ? {} : { goalCoverage }),
        ...(restRegion === undefined ? {} : { restRegion }),
        ...(input.stockProbes === undefined ? {} : { stockProbes: input.stockProbes }),
      },
      curved: curvedOptionsFor(ball, cutParamsFor),
    });
    opts.signal?.throwIfAborted();
    opts.onProgress?.({ setupIndex, op: 'linking', fraction: 0.9 });

    // AN EMPTY PROGRAM NEVER REACHES THE POST — the rule, applied at the one place every stage's
    // IR passes (the manager's finding on F's seeds: postZ1 refuses an IR with no moves — 'the
    // toolpath IR has no operation with any moves: nothing to post'). planCurvedForTree drops its
    // own empty stages; this guard covers the pocket/through-hole/contour chain too, so a step that
    // planned nothing can only ever be a STATED op, never a posted file. A contour that emitted
    // nothing is called out for what it is: the part is not freed.
    const ops: PlannedOp[] = [];
    const emptyStages: string[] = [];
    // #992 — the same drops, grouped per kind for the operator (one statement per cause with a
    // count); the per-op strings above stay in `notes` as the dump's detail.
    const emptyOpGroups = new Map<string, { kind: string; count: number; ids: string[] }>();
    for (const op of result.ops) {
      if (op.outcome.ir.operations.some((operation) => operation.moves.length > 0)) {
        // #965 — every op's posted IR is mapped to the DOCUMENT (world) XY here, once, before it
        // becomes part of `SetupPlan.ops`/`programs`: identity for the top setup (`up = [0, 0, 1]`,
        // every job today), the setup→document map for a flip (`setups.ts`'s own doc on why this
        // is required before two setups' programs can be read on one goal grid).
        ops.push({ ...op, outcome: { ...op.outcome, ir: mapIRToDocument(op.outcome.ir, spec.frame, registrationOffset) } });
        continue;
      }
      emptyStages.push(
        `${op.kind} "${op.region.id}" emitted no moves — not posted` +
          (op.kind === 'contour' ? ' — THE PART IS NOT FREED BY THIS PLAN' : ''),
      );
      const group = emptyOpGroups.get(op.kind) ?? { kind: op.kind, count: 0, ids: [] };
      group.count++;
      group.ids.push(op.region.id);
      emptyOpGroups.set(op.kind, group);
    }

    // #964's own measurement: the curved pipeline's per-region loop alternates flat/ball once per
    // remainder region (rough, [rest], finish, pencil, next region's rough, ...) — region A's
    // rough has no dependency on region B's ball stage or vice versa, so nothing here demands
    // that alternation. `batchSameCutterRuns` groups same-cutter ops back together wherever nothing
    // depends on the gap between them (`sequence.ts`'s own header on the one real invariant: never
    // reorder two ops on the SAME region), with the freeing contour pinned exactly where it was.
    const batchedOps = batchSameCutterRuns(ops, (op) => op.outcome.cutter, (op) => op.kind === 'contour');

    // Programs ONE PER RUN, in execution order — the same rule `planPocketsForTree` states: a run
    // starts when the cutter key changes, so a cutter's two non-contiguous visits never merge.
    const programs: ToolpathIR[] = [];
    let run: { key: string; ir: ToolpathIR } | null = null;
    for (const op of batchedOps) {
      if (run !== null && run.key !== op.outcome.cutter) {
        programs.push(run.ir);
        run = null;
      }
      run = run === null ? { key: op.outcome.cutter, ir: op.outcome.ir } : { key: run.key, ir: concatToolpathIR(run.ir, op.outcome.ir) };
    }
    if (run !== null) programs.push(run.ir);

    let totalCostSeconds = 0;
    for (let p = 0; p < programs.length; p++) {
      totalCostSeconds += estimateCycleTerms(programs[p]!, Z1.rapidEstimate).totalSeconds;
      if (p > 0) totalCostSeconds += toolChangeSeconds;
    }

    const notes = [...earlyNotes, ...result.notes, ...emptyStages, ...freeingNotes];
    // #988 — the setup's band, stated once: the depth cut and what the tree's deepest demand
    // leaves below it. (The seam carries the old path's `goal-cut-top-band` warning already; this
    // is the PLAN's own line, so the model plan says the same thing in its own words.)
    if (depthBandMm !== undefined) {
      const demands: number[] = [-tree.contour.zTo, ...tree.remainder.map((r) => -r.zBottom)];
      const walkFloors = (nodes: typeof tree.pockets): void => {
        for (const n of nodes) {
          demands.push(-n.floorZ);
          walkFloors(n.children);
        }
      };
      walkFloors(tree.pockets);
      const left = Math.max(...demands) - depthBandMm;
      const mm3 = (v: number): number => Math.round(v * 1000) / 1000;
      // #1013 — the note names the face the band cuts: a flipped setup's band is measured from the
      // stock's own bottom, so "the stock's top" would name the wrong side of the part.
      const face = spec.frame.up[2] === -1 ? 'bottom' : 'top';
      notes.push(
        left > 1e-6
          ? `Cut only the stock's ${face} ${mm3(depthBandMm)} mm; ${mm3(left)} mm of the goal is left below the band`
          : `Cut only the stock's ${face} ${mm3(depthBandMm)} mm; nothing of the goal is below the band`,
      );
    }
    notes.push(...toolSubstitutions);
    // #986 (the ruling) — the ball rank's own statement: the measured candidates, the winner and
    // the uncapped best, so the operator sees what the cap cost.
    notes.push(...ballRankNotes);
    // #982 (the review session's ruling) — the two cutter fallbacks, stated on the card in
    // outcome terms (the measured coverage/cycle numbers are the acceptance card's; the plan
    // states the method and the tradeoff it implies). #992 — each is typed: a cut made by a
    // fallback the job did not ask for changes what comes off the machine (wall fillets, a
    // flat's raster on a curved surface), so both are warnings.
    const fallbackStatements: PlanStatement[] = [];
    if (noFlatFallback) {
      const r = (cuttingDiameter(primary) ?? 0) / 2;
      const text =
        `the set holds no flat end mill — the pocket floors are cut by the ${primary.name || primary.shape} ball: ` +
        `wall feet carry a ${r.toFixed(3)} mm fillet and the floor a stepped scallop between passes (the tradeoff of cutting without a flat)`;
      notes.push(text);
      fallbackStatements.push({ severity: 'warning', code: 'goal-cutter-substituted', count: 1, text });
    }
    if (ball === undefined && tree.remainder.length > 0) {
      const flatName = (finishFlat ?? primary).name || 'flat';
      const text =
        `the set holds no ball nose — the curved remainder is finished by the ${flatName} as a flat-raster over the whole region ` +
        `(cusp rule: step = cusp / tan of the steepest slope, clamped to the flat's radius/10 to radius); ` +
        (finishFlat !== undefined && finishFlat !== primary ? 'the creases go to the rest pass with the smallest flat' : 'no smaller flat is offered, so the creases are left as the raster finds them');
      notes.push(text);
      fallbackStatements.push({ severity: 'warning', code: 'goal-cutter-substituted', count: 1, text });
    }
    // #992 — THE TYPED STATEMENTS: the two planners' own, then this loop's. Every one is the same
    // fact its `notes` line states; the code and severity are what route it to the operator.
    const statements: PlanStatement[] = [...result.statements, ...freeingStatements, ...fallbackStatements];
    // #1005 — THE MOULD'S OWN FACTS, from the cavity the plan was handed. The sentences are the old
    // heightfield path's own, word for word (the guide's chapter 8 rows document these codes); the
    // draft number is measured from the part's surface at the seam, because a planar wall has no
    // remainder record in the tree. One-sided is always stated: a mould cut from the top cannot
    // carry undercuts, and the operator should hear it once.
    if (input.mould !== undefined) {
      const mouldOneSided =
        `The mould of "${input.mould.name}" is cut from the top only: the cavity is the part's top surface, ` +
        'turned over so the casting reads the right way round, and the casting\'s underside is the ' +
        'flat face you pour into. A part with undercuts, or one shaped on both sides, needs a ' +
        'two-part mould — two setups.';
      notes.push(mouldOneSided);
      statements.push({ severity: 'info', code: 'goal-mold-one-sided', count: 1, text: mouldOneSided });
      if (input.mould.steepestWallDeg > MOLD_DRAFT_LIMIT_DEG) {
        const draft =
          `The mould of "${input.mould.name}" has a wall at ${Number(input.mould.steepestWallDeg.toFixed(1))}° — steeper than ` +
          `${MOLD_DRAFT_LIMIT_DEG}°, so it has little or no draft and may hold the casting. Give the ` +
          'part tapered sides, or use a flexible casting material.';
        notes.push(draft);
        statements.push({ severity: 'warning', code: 'goal-mold-no-draft', count: 1, text: draft });
      }
    }
    for (const group of emptyOpGroups.values()) {
      const plural = group.count === 1 ? 'op' : 'ops';
      statements.push(
        group.kind === 'contour'
          ? {
              severity: 'warning',
              code: 'goal-not-freed',
              count: group.count,
              ids: group.ids,
              text: `${group.kind}: ${group.count} ${plural} emitted no moves — THE PART IS NOT FREED BY THIS PLAN`,
            }
          : {
              severity: 'warning',
              code: 'goal-region-uncut',
              count: group.count,
              ids: group.ids,
              text: `${group.kind}: ${group.count} ${plural} emitted no moves — nothing for it to cut`,
            },
      );
    }
    for (const text of toolSubstitutions) {
      // A cutter cut with another tool's numbers (a fallback/proxy feed row) changes the cut.
      statements.push({ severity: 'warning', code: 'goal-cutter-substituted', count: 1, text });
    }
    if (ballUncutIds.length > 0) {
      // #982/#992 — the no-flat fallback's ball cannot enter a pocket narrower than its radius:
      // material stands there. One statement per cause with the count, never a line per pocket.
      const plural = ballUncutIds.length === 1 ? 'pocket' : 'pockets';
      statements.push({
        severity: 'warning',
        code: 'goal-region-uncut',
        count: ballUncutIds.length,
        ids: ballUncutIds,
        text: `${ballUncutIds.length} ${plural} narrower than the ball's radius — left uncut`,
      });
    }
    for (const substitution of curvedRoughSubstitutions) {
      // #1019 — one region the stated flat cannot reach: the ball took THAT region's rough and the
      // numbers are on the line (the region, the flat, its length, the region's depth).
      notes.push(substitution);
      statements.push({ severity: 'warning', code: 'goal-rough-unreachable', count: 1, text: substitution });
    }
    const plannedStrips = result.floorStrips?.regions ?? [];
    const unplannedStrips = result.floorStrips?.unreachable ?? [];
    // #1021 — a strip the BALL actually finishes is no longer "not cut" by the chain: its id comes
    // out of the setup's unreachable list below (the chain could not reach it; the ball does).
    const floorStripsCut = new Set<string>();
    if (plannedStrips.length > 0 || unplannedStrips.length > 0) {
      // #1021 — ONLY WHAT THE MOVES SHOW. A strip the ball fits is planned as its floor pass and
      // judged by that pass's own feeds INSIDE the strip and within the plan's 0.1 mm goal band
      // of its floor; a strip no owned flat can enter AND the ball cannot fit is never planned
      // as air — it is stated as standing (the EXISTING `goal-region-uncut` warning), because a
      // round cutter that does not fit cannot reach its floor at all. Never a "finished by the
      // ball" line the paths do not support.
      // A node the plan ALREADY states as unreachable is not restated here (`goal-region-uncut`
      // is one code with many causes; one sentence per node is enough).
      const alreadyStated = new Set(result.statements.flatMap((st) => st.ids ?? []));
      const cutIds: string[] = [];
      const remainderWhy: string[] = [];
      const shortWhy: string[] = [];
      const R_BALL_MM = ball === undefined ? 0 : (cuttingDiameter(ball) ?? 0) / 2;
      const unreachable = unplannedStrips.filter((s) => !alreadyStated.has(s.id));
      const uncutIds: string[] = unreachable.map((s) => s.id);
      const uncutWhy: string[] = unreachable.map((s) =>
        ball === undefined
          ? `${s.id}: ${s.area.toFixed(1)} mm² — no ball is held to finish it`
          : `${s.id}: ${s.area.toFixed(1)} mm², the ball reaches ${(s.fitShare * 100).toFixed(0)} % of it within the 0.1 mm band`,
      );
      const plannedAreas = new Map((result.floorStrips?.planned ?? []).map((p) => [p.id, p] as const));
      for (const strip of plannedStrips) {
        // THE REACH CHECK ON THE PASS'S OWN MOVES (#1026): the planned region IS the area the fit
        // found reachable, so the check runs over those cells and a cell AT the band counts as
        // reached (`<= band + 1e-6` — the knife-edge comparison that read 0 % on ground the fit
        // had just passed is gone).
        const areas = plannedAreas.get(strip.id);
        const feeds: { x: number; y: number; z: number }[] = [];
        for (const op of result.ops) {
          if (op.region.id !== strip.id) continue;
          for (const irOp of op.outcome.ir.operations) {
            for (const m of irOp.moves) if (m.kind === 'feed') feeds.push({ x: m.x, y: m.y, z: m.z });
          }
        }
        const leftoverAt = (x: number, y: number): number => {
          let cut = Infinity;
          for (const f of feeds) {
            const d = Math.hypot(f.x - x, f.y - y);
            if (d > R_BALL_MM) continue;
            const surface = f.z + R_BALL_MM - Math.sqrt(Math.max(0, R_BALL_MM * R_BALL_MM - d * d));
            if (surface < cut) cut = surface;
          }
          return cut === Infinity ? Infinity : cut - strip.zBottom;
        };
        // THE CHECK IS ON THE FEEDS, the acceptance's own rule: every feed on the planned area
        // must sit within the band of the floor (`<= band + 1e-6`; a feed AT the band counts).
        void leftoverAt;
        const feedsOnArea = feeds.filter((f) => pointInPolygons(strip.footprint, f.x, f.y));
        const shortFeeds = feedsOnArea.filter((f) => f.z > strip.zBottom + 0.1 + 1e-6);
        const share = feedsOnArea.length === 0 ? 0 : 1 - shortFeeds.length / feedsOnArea.length;
        const nodeId = strip.id.replace(/:floor-strip$/, '');
        if (alreadyStated.has(nodeId)) continue;
        // A PLANNED PASS IS NEVER LABELLED "CANNOT REACH": the chain sentence is cleared and the
        // statement names what the pass did with the area it was planned over (F's review 5,
        // finding 3). A pass that fell short of its own planned area says exactly that.
        floorStripsCut.add(nodeId);
        if (share >= 0.99) {
          cutIds.push(nodeId);
          if (areas !== undefined && !areas.allReached) {
            remainderWhy.push(
              `${nodeId}: ${areas.reachArea.toFixed(1)} of ${areas.stripArea.toFixed(1)} mm² finished by the ball; ` +
                `${areas.staysArea.toFixed(1)} mm² stays, up to ${areas.standingMm.toFixed(2)} mm tall`,
            );
          }
        } else {
          cutIds.push(nodeId);
          shortWhy.push(
            `${nodeId}: the pass fell short on ${((1 - share) * (areas?.reachArea ?? 0)).toFixed(1)} mm² of the ` +
              `${areas?.reachArea.toFixed(1) ?? 'reachable'} mm² it was planned over`,
          );
        }
      }
      const ballName = ball === undefined ? 'ball' : ball.name || ball.shape;
      if (cutIds.length > 0) {
        const plural = cutIds.length === 1 ? 'strip' : 'strips';
        const text =
          `${cutIds.length} pocket floor ${plural} narrower than the ${primary.name || primary.shape}'s ring ` +
          `(${cutIds.join(', ')}) ${cutIds.length === 1 ? 'is' : 'are'} finished by the ${ballName} as its own floor pass` +
          (remainderWhy.length === 0 && shortWhy.length === 0
            ? ' across it'
            : ` — ${[...remainderWhy, ...shortWhy].join('; ')}`);
        notes.push(text);
        statements.push({ severity: 'info', code: 'goal-pocket-floor-rest', count: cutIds.length, ids: cutIds, text });
      }
      if (uncutIds.length > 0) {
        const plural = uncutIds.length === 1 ? 'strip' : 'strips';
        const text =
          `${uncutIds.length} pocket floor ${plural} narrower than the ${primary.name || primary.shape}'s ring ` +
          `${uncutIds.length === 1 ? 'is' : 'are'} left standing — ` +
          (ball === undefined ? 'and no ball is held to finish ' : `the ${ballName} cannot reach `) +
          `${uncutIds.length === 1 ? 'it' : 'them'} (${uncutWhy.join('; ')})`;
        notes.push(text);
        statements.push({ severity: 'warning', code: 'goal-region-uncut', count: uncutIds.length, ids: uncutIds, text });
      }
    }
    if (input.fixture.envelope !== null) {
      const text = `the ${input.fixture.mount} fixture envelope is not yet wired into the region obstacles — this plan carries none; the posted program is still checked against the same envelope by the sweep`;
      notes.push(text);
      statements.push({ severity: 'warning', code: 'goal-fixture-unmodelled', count: 1, text });
    }
    if (input.cutters.catalogue.length > 0) {
      // #992 dump-only: a developer gap ("not in the pocket chain yet"), not an operator fact.
      notes.push(`${input.cutters.catalogue.length} catalogue cutter(s) are not in the pocket chain yet — the house set is what it chooses from`);
    }
    // #965 — registration against setup 0's own cut features is now COMPUTED
    // (`registerSetupOrigin`, `setups.ts`), not left to the operator's fixture/jig: the note
    // states WHICH datum was found and the offset it produced, so the number is auditable rather
    // than asserted. (The freeing-contour gap just below is a SEPARATE, still-open #965 item —
    // the flat-Z release pass, not the registration this function now answers.)
    if (setupIndex > 0) {
      const text = describeRegistration(setupIndex, registration!);
      notes.push(text);
      statements.push({ severity: 'sheet', code: 'plan-setup', count: 1, text });
      // The freeing contour's own depth IS now bounded against the opposite setup's finished
      // surface (above, `freeingNotes`) — this is no longer a stated gap; see that note for the
      // actual outcome (or why it could not be checked) on THIS plan.
    }

    perSetup.push({
      setupIndex,
      features: tree,
      clGrid: result.clGrid,
      ops,
      sequence: result.sequence,
      linking: linkingStats(programs),
      programs,
      totalCostSeconds,
      notes,
      statements,
      // ONLY the cutter-size sentence is cleared for a strip the ball finishes: a 'planning
      // failed (…)' sentence is a different fact about the node and stays (F's review, finding 3).
      unreachable: result.unreachable.filter(
        (entry) => ![...floorStripsCut].some((id) => entry.startsWith(`${id}: not cut — needs a cutter `)),
      ),
      unplanned: result.unplanned,
      choice: result.choice,
    });
    opts.onProgress?.({ setupIndex, op: 'linking', fraction: 1 });
  }
  // #961 (the card slice) — THE PLAN'S OWN OUTCOME, from the same stamping the picker already uses.
  // Nothing new is simulated: every program's IR is posted and stamped once (the cache above), the
  // fields are unioned, and the result is the coverage the 0.1 mm band leaves and the deepest
  // overshoot. Absent without `input.goal` — the caller did not ask for an outcome.
  const outcome: PlanOutcome | undefined = (() => {
    if (coverageGoal === undefined) return undefined;
    const fields: Float32Array[] = [];
    for (const setup of perSetup) for (const ir of setup.programs) {
      const field = stampedField(ir);
      if (field !== null) fields.push(field);
    }
    if (fields.length === 0) return undefined;
    const union = Float32Array.from(fields[0]!);
    for (const field of fields.slice(1)) for (let k = 0; k < union.length; k++) if (field[k]! < union[k]!) union[k] = field[k]!;
    let covered = 0;
    let leftover = 0;
    let leftoverAboveMm = 0;
    for (let k = 0; k < union.length; k++) {
      if (coverageGoal.covered[k] !== 1) continue;
      covered++;
      const over = union[k]! - (coverageGoal.z[k] as number);
      if (over > 0.1) leftover++;
      if (over > leftoverAboveMm) leftoverAboveMm = over;
    }
    const cycleSeconds = perSetup.reduce((n, setup) => n + setup.totalCostSeconds, 0);
    return {
      coverage: covered === 0 ? null : 1 - leftover / covered,
      cutInto: { adjudicatedFraction: null, maxMm: null },
      leftoverAboveMm,
      cycleSeconds,
      leftoverCells: leftover,
      coveredCells: covered,
      cellAreaMm2: coverageGoal.pitch * coverageGoal.pitch,
    };
  })();
  // #1023 — THE FINISH'S LEFTOVER IS STATED, on the plan that posts. `planTwoOutcomes` replaces
  // this base sentence with the ideal plan's measured ball when one exists; the statement lives on
  // the LAST setup because the outcome is the union of every setup's programs (the plan's final
  // state), never one setup's own.
  if (outcome !== undefined && opts.restStatement !== false) {
    const statement = restStatementForPlan(perSetup, outcome, input, null);
    if (statement !== null) {
      const last = perSetup[perSetup.length - 1]!;
      last.statements.push(statement);
      // The dump's prose carries the same line; the card's notes are what a reviewer reads.
      last.notes.push(statement.text);
    }
  }
  return outcome === undefined ? { perSetup } : { perSetup, outcome };
}

const allPockets = (nodes: PocketNode[]): PocketNode[] => nodes.flatMap((n) => [n, ...allPockets(n.children)]);

/** #1023 — the finishing ball a plan actually ran: the smallest-diameter ball among its programs. */
function finishingBallOf(setups: readonly SetupPlan[]): Tool | null {
  let finish: Tool | null = null;
  let finishD = Infinity;
  for (const setup of setups) {
    for (const ir of setup.programs) {
      if (ir.tool.shape !== 'ball') continue;
      const d = cuttingDiameter(ir.tool) ?? 0;
      if (!(d > 0) || d >= finishD) continue;
      finish = ir.tool;
      finishD = d;
    }
  }
  return finish;
}

/** The digits the statement prints: 6 → "6", 3.175 → "3.175". */
const diaWord = (d: number): string => String(Number(d.toFixed(3)));

/** A share as the operator reads it: 0.02 → "2", 0.214 → "21.4". */
const shareWord = (share: number): string => String(Number((share * 100).toFixed(1)));

/** #1023 — the ideal plan's measured ball, as the owned plan's statement names it. */
export interface RestReference {
  ball: Tool;
  /** The ideal plan's own leftover share (1 − its coverage) — the number its sentence prints. */
  leftoverShare: number;
  /** The ideal plan's cycle less the owned plan's, seconds (the #961 tradeoff carrier's row). */
  cycleDeltaSeconds: number;
}

/**
 * #1023 — THE FINISH'S LEFTOVER, AS ONE STATEMENT.
 *
 * `goal-rest-uncut` when nothing smaller than the largest owned ball ran: the finish leaves
 * `leftoverAboveMm` over `1 − coverage` of the goal's cells, past or under the shop's visibility
 * thresholds, and no owned ball takes it. `goal-rest-pass` (always info) when a smaller owned ball
 * DID run: what remains after it. Numbers first, the cutter last, and every clause testable by the
 * sentence alone — the two precedents are the old heightfield sentence (`goal-rest-uncut`'s own
 * words) and #992's statement rule.
 *
 * The "ball that would take it" is the ideal plan's when `reference` is non-null and that ball is
 * not in the owned set; otherwise the sentence gives no size and points at the catalogue as the
 * action (none configured for this shop). `restVisibility`
 * carries the shop's thresholds and their provenance; absent is the labelled fallback.
 */
export function restStatementForPlan(
  setups: readonly SetupPlan[],
  outcome: PlanOutcome,
  input: ModelPlanInput,
  reference: RestReference | null,
): PlanStatement | null {
  if (outcome.coverage === null || outcome.coverage >= 1 - 1e-9) return null;
  const finish = finishingBallOf(setups);
  const finishD = finish === null ? 0 : cuttingDiameter(finish) ?? 0;
  if (finish === null || !(finishD > 0)) return null;
  const ownedBalls = input.cutters.house
    .filter((t) => t.shape === 'ball')
    .map((t) => cuttingDiameter(t) ?? 0);
  const largestOwned = ownedBalls.length === 0 ? 0 : Math.max(...ownedBalls);
  const smallerRan = largestOwned > finishD + 1e-9;
  const vis = input.restVisibility ?? {
    depthMm: REST_MACHINING_FALLBACK.visibleDepth,
    share: REST_MACHINING_FALLBACK.thirdToolFraction,
    depthSource: REST_MACHINING_FALLBACK.source,
    shareSource: REST_MACHINING_FALLBACK.source,
  };
  const share = 1 - outcome.coverage;
  const visible = outcome.leftoverAboveMm > vis.depthMm || share > vis.share;
  const code = smallerRan ? 'goal-rest-pass' : 'goal-rest-uncut';
  const severity = smallerRan ? 'info' : visible ? 'warning' : 'info';
  const numbers =
    `${outcome.leftoverAboveMm.toFixed(2)} mm standing over ${shareWord(share)} % of the goal ` +
    `(${outcome.leftoverCells} cells, ${(outcome.leftoverCells * outcome.cellAreaMm2).toFixed(1)} mm²)`;
  const cutter = `${finish.name} (⌀${diaWord(finishD)} mm)`;
  if (smallerRan) {
    return {
      severity,
      code,
      count: outcome.leftoverCells,
      text: `After the ${cutter}, the finish leaves up to ${numbers}.`,
    };
  }
  const look = visible
    ? `— past the ${vis.depthMm.toFixed(2)} mm or ${shareWord(vis.share)} % that marks a leftover visible —`
    : `— under the ${vis.depthMm.toFixed(2)} mm and ${shareWord(vis.share)} % that marks a leftover visible —`;
  // #1027 (E's review) — WHICH CATALOGUE FACT IS TRUE. `reference === null` means no catalogue
  // BALL was measured here, never "no catalogue is configured": the owned plan is planned with the
  // catalogue emptied, and `enrichOwnedRestStatement` leaves the plan alone when the ideal's ball
  // is owned or better. The configured case names the measured answer's absence; the unconfigured
  // case points at the setting.
  const catalogueConfigured = input.catalogueConfigured ?? input.cutters.catalogue.length > 0;
  const would =
    reference === null
      ? catalogueConfigured
        ? ' The ball that would take it is measured from the cutter catalogue — none of its balls takes this leftover (Manage → Tools).'
        : ' The ball that would take it is measured from the cutter catalogue — none is configured for this shop (Manage → Tools).'
      : ` The catalogue's ${reference.ball.name} (⌀${diaWord(cuttingDiameter(reference.ball) ?? 0)} mm) would: ` +
        `leftover ${shareWord(reference.leftoverShare)} %, ` +
        `${reference.cycleDeltaSeconds >= 0 ? '+' : ''}${Math.round(reference.cycleDeltaSeconds)} s of cycle (measured).`;
  return {
    severity,
    code,
    count: outcome.leftoverCells,
    text:
      `The finish with the ${cutter} leaves up to ${numbers} where it cannot enter ${look} and no owned ball takes it.` +
      would +
      thresholdProvenanceClause(vis.depthSource, vis.shareSource),
  };
}

/** #1027 — one threshold's source in the sentence's own words (the run sheet's longer phrases live in `restSettings`). */
function thresholdSourceWords(source: RestSettingSource): string {
  switch (source) {
    case 'fallback':
      return 'this build’s fallback';
    case 'user':
      return 'the command line';
    case 'measured':
      return 'the bench’s own measurement';
    case 'chosen':
    case 'seeded':
      return 'the shop’s location document';
  }
}

/**
 * #1027 — BOTH THRESHOLDS' PROVENANCE, ONE PHRASE WHEN THEY AGREE. The two readings are
 * independent (`readDefault` answers per key), so one shop can state the visible depth and fall
 * back for the share; the sentence names each threshold's source when they differ.
 */
function thresholdProvenanceClause(depth: RestSettingSource, share: RestSettingSource): string {
  if (depth === share) {
    return depth === 'fallback'
      ? ' The thresholds are this build’s labelled fallback.'
      : ` Both thresholds are from ${thresholdSourceWords(depth)}.`;
  }
  return ` The visible depth is from ${thresholdSourceWords(depth)}; the third-tool share is from ${thresholdSourceWords(share)}.`;
}

/**
 * #1023 — THE OWNED PLAN'S STATEMENT, ENRICHED WITH THE IDEAL'S MEASURED BALL. `planTwoOutcomes`
 * plans the owned set first and the ideal second; when the ideal's finishing ball is not owned, it
 * is the ball that would take what the owned plan left, and its own outcome gives the sentence its
 * measured leftover share and cycle delta. Nothing but the statement's text changes.
 */
export function enrichOwnedRestStatement(
  owned: ModelPlanOutput,
  ideal: ModelPlanOutput,
  input: ModelPlanInput,
): ModelPlanOutput {
  const outcome = owned.outcome;
  const idealOutcome = ideal.outcome;
  if (outcome === undefined || idealOutcome === undefined || idealOutcome.coverage === null) return owned;
  const ownedBall = finishingBallOf(owned.perSetup);
  const idealBall = finishingBallOf(ideal.perSetup);
  if (ownedBall === null || idealBall === null) return owned;
  if (cutterKeyOf(idealBall) === cutterKeyOf(ownedBall)) return owned;
  if (input.cutters.house.some((t) => cutterKeyOf(t) === cutterKeyOf(idealBall))) return owned;
  const rebuilt = restStatementForPlan(owned.perSetup, outcome, input, {
    ball: idealBall,
    leftoverShare: 1 - idealOutcome.coverage,
    cycleDeltaSeconds: idealOutcome.cycleSeconds - outcome.cycleSeconds,
  });
  if (rebuilt === null) return owned;
  const lastIndex = owned.perSetup.length - 1;
  const last = owned.perSetup[lastIndex]!;
  const at = last.statements.findIndex((s) => s.code === 'goal-rest-uncut' || s.code === 'goal-rest-pass');
  const statements =
    at < 0
      ? [...last.statements, rebuilt]
      : [...last.statements.slice(0, at), rebuilt, ...last.statements.slice(at + 1)];
  // The dump's prose line is replaced with the enriched one, never duplicated.
  const oldText = at < 0 ? null : last.statements[at]!.text;
  const notes =
    oldText !== null && last.notes.includes(oldText)
      ? last.notes.map((n) => (n === oldText ? rebuilt.text : n))
      : [...last.notes, rebuilt.text];
  return { ...owned, perSetup: owned.perSetup.map((s, i) => (i === lastIndex ? { ...s, statements, notes } : s)) };
}

/** The `facing` region's own `Box2` — there is no `PocketNode`/`regionRefs` entry for it (it is
 * not a recognised feature, it is this plan's own synthesis of `FeatureTree.top.floors`). */
/**
 * The topmost mesh surface at (x, y), or null where no triangle covers the point.
 *
 * PERF FINDING (#959 review): this used to scan EVERY triangle of the whole mesh, for every one
 * of `rims x segments x 5` samples — the same cost `triangleBins.ts`'s own header describes for
 * `dropcutter.ts`'s pre-bins query. `binnedReachableTriangles(bins, x, y, 0)` is the exact same
 * drop-in: a radius-0 query answers "triangle's own bbox contains (x, y)", a NECESSARY condition
 * for the barycentric test below to ever accept it, so the candidate set it returns is a superset
 * of the true containing triangle(s) — the barycentric filter here still does the real work, and
 * the retained (best) result is identical to the brute-force scan's, never just close to it.
 */
function topSurfaceAt(bins: TriangleBins, x: number, y: number): number | null {
  const p = bins.mesh.positions;
  const indices = bins.mesh.indices;
  let best: number | null = null;
  for (const t of binnedReachableTriangles(bins, x, y, 0)) {
    const i0 = indices[t * 3]! * 3;
    const i1 = indices[t * 3 + 1]! * 3;
    const i2 = indices[t * 3 + 2]! * 3;
    const x0 = p[i0]!, y0 = p[i0 + 1]!, z0 = p[i0 + 2]!;
    const x1 = p[i1]!, y1 = p[i1 + 1]!, z1 = p[i1 + 2]!;
    const x2 = p[i2]!, y2 = p[i2 + 1]!, z2 = p[i2 + 2]!;
    const d = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(d) < 1e-12) continue;
    const a = ((y1 - y2) * (x - x2) + (x2 - x1) * (y - y2)) / d;
    const b = ((y2 - y0) * (x - x2) + (x0 - x2) * (y - y2)) / d;
    const c = 1 - a - b;
    if (a < -1e-9 || b < -1e-9 || c < -1e-9) continue;
    const z = a * z0 + b * z1 + c * z2;
    if (best === null || z > best) best = z;
  }
  return best;
}

/** The chamfer's own air-side sign: outward for the part's contour, into the pocket for a rim. */
function rimAirSign(rim: { of: string }): number {
  return rim.of === 'contour' ? 1 : -1;
}

/** A closed ring normalised to positive orientation (the same convention `chamfer()` uses). */
function rimRing(polyline: readonly [number, number][]): [number, number][] {
  const ring = polyline.map((q) => [q[0], q[1]] as [number, number]);
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  return area < 0 ? ring.reverse() : ring;
}

/**
 * IS THIS RIM EXPOSED FROM +Z? (the manager's ruling, from the tray's 0.5 mm cell). The tray's
 * chamfer ran a 130 mm feed along a real 90° mesh edge whose air side is COVERED: the goal's top
 * surface continues across the edge at the same height (the edge lies under the land — a cavity
 * mouth, not an open lip), so the break cut 0.5 mm into ground the goal never exposes. A rim is
 * breakable only where its AIR side actually drops — by the goal's own step threshold (0.2 mm,
 * `designEdgeCells`). Sampled at EVERY segment midpoint (not a stride across them — an 8-point
 * stride missed covered stretches on the tray), seven distances onto the air side (0.25/0.5/1.0/
 * 1.3/1.55/1.65/1.8 mm, the V's whole 1.6375 mm skirt reach plus margin); ANY covered sample means
 * the rim is not broken whole (conservative: never break under a lip).
 */
function rimExposedFromAbove(
  bins: TriangleBins,
  rim: { polyline: readonly [number, number][]; z: number; of: string },
  stepMm = 0.2,
): boolean {
  const ring = rimRing(rim.polyline);
  const segments = ring.length - 1;
  if (segments <= 0) return true;
  // EVERY segment midpoint, not a sample of them: an 8-point stride missed covered stretches on
  // the tray (adjudicated cut fell 0.00128 -> 0.00031, not to zero) because a long rim can pass
  // under a lip for a short run between the sampled points.
  const air = rimAirSign(rim);
  for (let s = 0; s < segments; s++) {
    const a = ring[s]!;
    const b = ring[(s + 1) % segments]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    // For a positively oriented closed ring the interior is on the left; outward is (dy, -dx).
    const nx = (dy / len) * air;
    const ny = (-dx / len) * air;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    // The samples must cover the V's WHOLE footprint, not just the edge's neighbourhood: the
    // cutter's skirt reaches its own outer radius from the path (offset 0.05 on the air side plus
    // 1.5875 of cone = 1.6375 from the rim), so covered ground that starts ~1.5 mm out is still
    // cut at 0.5 mm deep. The organizer's 45-degree rim cut one cell at 1.6 mm — past the old last
    // sample at 1.55 — which is why its 0.04 % survived the first filter.
    for (const d of [0.25, 0.5, 1.0, 1.3, 1.55, 1.65, 1.8]) {
      const top = topSurfaceAt(bins, mx + nx * d, my + ny * d);
      if (top !== null && top > rim.z - stepMm) return false;
    }
  }
  return true;
}

/** A ring's projected area (shoelace), mm² — absolute, so the ring's winding does not matter. */
function ringAreaOf(ring: readonly [number, number][]): number {
  let area = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[j]![0] * ring[i]![1] - ring[i]![0] * ring[j]![1];
  }
  return Math.abs(area / 2);
}

function boundsOfPolygons(polygons: Polygons): Box2 {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of polygons) for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { min: [minX, minY], max: [maxX, maxY] };
}

export interface PlanPocketsOptions {
  /** The real Clipper2 offset, or a test fake — `pocketLoops`' own contract, carried through unchanged. */
  offset: OffsetFn;
  /**
   * #1003 (the manager's narrowing) — THE BOARD'S BREAKTHROUGH, mm, and ONLY for the freeing
   * contour: the contour's job is to cut through the blank into the board, so its clamp is the
   * stock bottom minus this. Pocket floors and the curved regions stay at exactly the stock bottom —
   * nothing there has a reason to go below the blank — and the verifier's spatial rule stays the
   * net for everything else.
   */
  sacrificialBreakthroughMm?: number;
  /**
   * #1037 — THE WHOLE HOUSE, unfiltered. `houseFlats` is the chain's own candidate list (flats with
   * a stated cutting diameter); the `goal-not-freed` warning must be able to name a house flat that
   * REACHES the profile but is not a chain candidate (no stated diameter), or its sentence would
   * call a set with a reaching flute "short". Absent: `houseFlats` is used.
   */
  houseAll?: readonly Tool[];
  /** House cutters, largest first is NOT required — #961's `chooseSequence` ranks by cost, not list order. */
  houseFlats: readonly Tool[];
  /**
   * #975 — an optional per-cutter cut-parameter resolver, so a V floor run speaks the SAME feeds
   * and spindle speed as that cutter's other steps (the rim chamfer): the two runs merge into one
   * program, and `concatToolpathIR` refuses a header mismatch. Absent → `feeds`/`spindleRpm`.
   */
  paramsFor?: (tool: Tool) => CutParams;
  /**
   * #975 — the V bits in the house set (engraving/chamfer shapes), as the pocket chain's LAST
   * RESORT: a pocket no flat covers gets the narrowest V whose tip is no wider than the stroke
   * and whose leg reaches the floor, cut as a floor-correct pocket (the maintainer's 2026-11-05
   * ruling — "never a refusal where a tool in the set can do the job"). Absent = no V pocketing.
   */
  houseVs?: readonly Tool[];
  /**
   * #988 — THE SETUP'S DEPTH BAND, mm below the stock top (positive; `SetupSpec.bandMm`): the
   * contour, every pocket/through/V floor and the CL surface stop at −band and the remainder is
   * named. Absent → the whole depth, every existing caller unchanged.
   */
  depthBandMm?: number;
  stepDownMm: number;
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  rapid: RapidEstimate;
  /** The shop's `toolChange.seconds` (#858) — #961's own per-change allowance, not a default here. */
  toolChangeSeconds: number;
  spindleRpm: number;
  air: boolean;
  /** The card's "vendor + 1" cutter budget (`SequenceOptions.maxCutters`). Absent → no cap. */
  maxCutters?: number;
  /** Absent → {@link DEFAULT_RELEASE_TABS} (the part must stay held until the last cut touches it). */
  tabs?: { count: number; width: number; height: number };
  /** A real Clipper2 union/subtract, for an OPEN node's region extension (finding 3). Absent on an open node leaves it unextended, stated by the caller, not assumed silently. */
  boolean?: { union: BooleanFn; subtract: BooleanFn };
  /** `ContourOpOptions.oppositeSafeDepthMm`, carried straight through to the contour op when this
   * setup's freeing cut must stay off the opposite setup's already-finished surface (#965). Absent
   * for every single-setup job and the first of two — `contourOp` then behaves exactly as before. */
  oppositeSafeDepthMm?: (x: number, y: number) => number | null;
  /**
   * #966 — the real design mesh, ALREADY ROTATED into THIS setup's own frame (the SAME one
   * `recogniseFeatures` built `tree` from — `planModelCam`'s own `curvedGeometry`). Threaded into
   * every `pocket()` call (`PocketOpOptions.aboveMaterial`'s own doc) so a node's per-level cut is
   * bounded by the true ceiling read off the mesh, not just `node.region`'s own static "air at
   * floorZ" footprint — #966's elephant/table finding (a flat planned straight through an overhang
   * with no floor patch of its own to correct `mouthZ`). Absent → every pre-#966 call site/test
   * (every one of them) is unaffected: no shadow check runs, `pocket()` behaves exactly as before.
   */
  shadowMesh?: DropCutterMesh;
  /**
   * #959 (2026-11-05 ruling): FACING OFF by default. `'on'` plans the facing stage exactly as
   * before (the operator option); absent or `'off'` plans none, and the skin over the top land
   * belongs to the flat surface-following pass (`skin`).
   */
  facing?: 'off' | 'on';
  /**
   * #962 — the rest region's dilation about the leftover mask, mm. Default `2 x the cutter's
   * radius + 0.25` (the MEASURED value: `pocketLoops` erodes by r before ringing, so the grown
   * strip must be a cutter diameter wide for the ring to exist). Exposed so a spec can drive the
   * failure geometry a smaller dilation produces — and prove such a rest is STATED, never silent.
   */
  restDilationMm?: number;
  /**
   * #961 — the simulated outcome for a candidate's planned IRs: the goal cells left above the
   * band and the covered cells, stamped by the caller (which owns the goal). Absent → the
   * picker keeps its pocket-count completeness.
   */
  goalCoverage?: (irs: readonly ToolpathIR[]) => { leftoverCells: number; coveredCells: number; cellAreaMm2: number } | null;
  /**
   * #961 — a COVERAGE rest's region, from the caller's own simulated field: the cells the chain so
   * far leaves above the band, as polygons in the plan's XY (the caller owns the goal and the
   * stamp). Absent → the rest cuts its whole pocket floor (the pre-restriction behaviour).
   */
  restRegion?: (
    prefixIrs: readonly ToolpathIR[],
    region: { id: string; footprint: Polygons; floorZ: number; bounds: { min: [number, number]; max: [number, number] } },
  ) => Polygons | null;
  /**
   * #943's ruling — the probed stock top (see {@link ModelPlanInput.stockProbes}): the facing
   * cut starts at the highest probed point and its target clamps at the part top. Absent → the
   * stated stock top, stated on the plan.
   */
  stockProbes?: StockProbes;
}

/**
 * A's review 6622610124 raised a real sequencing question this default answers, stated here for
 * the Manager/C to confirm rather than decided silently: #961's chain may add a rest flat AFTER
 * this contour step runs (the tray's 3.6 mm channels need ⌀3.175, smaller than the primary that
 * carries the contour), and the part must stay captured until the LAST cutter touches it. Of the
 * three ways to guarantee that — run the contour last (an extra tool change #961 does not price),
 * cut it with the chain's last cutter, or tab it — tabs cost the least to wire here: the contour
 * keeps whatever position the chain gives it, and these four shallow bridges hold the part
 * through every cut that follows. `{count: 0}` is no longer the default; it still frees the part
 * outright when the caller states it explicitly.
 */
export const DEFAULT_RELEASE_TABS = { count: 4, width: 6, height: 1 };

export interface PlanPocketsResult {
  ops: PlannedOp[];
  /**
   * One program per RUN, in execution order — NOT one per cutter key (advisor's review on
   * ab6b2827): #961 may legitimately return to an earlier cutter for the freeing cut (cheaper
   * than the chain's last cutter taking the profile itself), and a `Map<cutterKey, …>` merges
   * that cutter's two non-contiguous visits into ONE file — which, read in that file's own
   * order, frees the part before the rest step in between ever ran. A run starts whenever a
   * step's cutter differs from the previous step's; the SAME cutter key can appear in more than
   * one run.
   */
  programs: { cutterKey: string; ir: ToolpathIR }[];
  /**
   * `SetupPlan.sequence`'s own shape — `terms` computed HERE, from each cutter's concatenated
   * posted `ToolpathIR` via #927's `estimateCycleTerms` (§3.0.1), not reused from `choice.cost`'s
   * per-step sum (`sequence.ts`'s own internal accounting is a different, bare `estimateSeconds`).
   */
  sequence: SequencedCutter[];
  /** A feature no cutter in the chosen chain's budget covers, as a stated finding naming the limiting number — `SequenceChoice.unreachable`, turned into a sentence. */
  unreachable: string[];
  /** Other stated findings — a skin above the part this plan does not fully face, and similar gaps that are not a refusal. */
  notes: string[];
  /** #992 — `notes`, typed: one statement per cause with its code, severity and count. */
  statements: PlanStatement[];
  /** The full picker result (`considered`, `cost`) — for a caller that wants more than `ops`/`unreachable`. */
  choice: SequenceChoice;
  /** #959 item 5 — the chosen chain's failed steps, one entry per region that threw (with its own message). */
  unplanned: SequenceStepFailure[];
}

/**
 * Every non-through floored `PocketNode`, AND the outer contour, in a `FeatureTree`, planned
 * TOGETHER through #961's real `chooseSequence` rest chain (`sequence.ts`) — one `SequenceDemand`
 * covering both, so the chain's cutter choice is priced against the whole job, not pocket and
 * contour separately. The manager's rule after E's a46f0358 run: an op that is real enters this
 * function AND whatever acceptance spec plans through it in the same commit, so a real run
 * exercises what the engine would actually post.
 *
 * `planStep` (the seam `chooseSequence` prices candidates through) dispatches each region id in a
 * step to `pocket()` (a real `PocketNode`) or `contourOp()` (`id === 'contour'`, `regionRefs`' own
 * reserved id for the tree's outer contour) and caches the resulting `OpOutcome`s by step
 * signature — `chooseSequence` calls `planStep` once per candidate it prices, not just the winner.
 */
export function planPocketsForTree(tree: FeatureTree, opts: PlanPocketsOptions): PlanPocketsResult {
  // #1018 — ONE Z DATUM, by construction: `zPasses`, SAFE_Z/HOP_Z (ir.ts) and the post's own
  // `probed-top-face` convention all assume IR Z 0 is the STOCK top, and `tree` already is —
  // `planModelCam`'s own setup loop shifts the mesh by `-stockTop` at the door, once, before
  // `recogniseFeatures` ever sees it, so `tree.frame.stockTop` reads 0 here and every Z this
  // function reads off `tree` is already stock-top-relative. Was rebased per-value here
  // (`rebase`, `z - stockTop`) until the door made that unconditional and the per-site shim
  // redundant.
  // #988 — THE SETUP'S DEPTH BAND (`SetupSpec.bandMm`): every floor this function hands an op is
  // clamped to it, so the contour, the pockets/through holes and the chain's own cutter sizing
  // (the feature depths below) all stop at the band, and the remainder is named. Absent: the
  // pre-#988 plan, byte-identical.
  const depthBandMm = opts.depthBandMm;
  const cutFloor = (floorZ: number): number => (depthBandMm === undefined ? floorZ : Math.max(floorZ, -depthBandMm));

  const refs = regionRefs(tree);
  // `regionRefs` reads `topZ`/`bottomZ` straight off `tree`, already stock-top-relative (#1018).
  const refById = new Map(refs.map((r) => [r.id, {
    ...r,
    topZ: r.topZ,
    bottomZ: depthBandMm === undefined ? r.bottomZ : Math.max(r.bottomZ, -depthBandMm),
    obstacles: [],
    // The skin above an OPEN node (a shoulder) is cut by this plan; above anything else (an
    // island's own cap, say) it is not, and stays at the stock's own top (0) — never below it,
    // or a clearance plane under 5 mm above a thick, uncut skin would not clear it.
    regionClearanceZ: Math.max(0, tree.frame.partTop) + 5,
  }]));

  // A's review 6622610124, finding 2: a ROOT node's mouth is the STOCK's own top, not the
  // recognised part top — the tray's top land sits 1.2 mm below the stock surface, and without
  // this the first pass engages 1.2 mm + one step-down with nothing faced first. A nested node's
  // mouth is correctly its parent's own floor, so only roots get the override (below).
  const rootIds = new Set(tree.pockets.map((n) => n.id));
  const allNodes = allPockets(tree.pockets);
  const pocketNodes = allNodes.filter((n) => !n.through && n.floors.length > 0);
  const pocketsById = new Map(pocketNodes.map((n) => [n.id, n] as const));
  // A's review 6622610124, finding 4: a through node used to be skipped with nothing in
  // `unreachable` — it is cut by the SAME contour-op machinery as the outer release (a hole, cut
  // INSIDE its own outline), as its own `SequenceFeature` so the chain can size it a cutter that
  // fits its own narrowest opening, independent of whatever covers the outer contour.
  const throughNodes = allNodes.filter((n) => n.through);
  const throughById = new Map(throughNodes.map((n) => [n.id, n] as const));

  // A's review 6622610124, most severe: `zPasses` counts down from Z 0, the STOCK top, not the
  // recognised part top — a `partTop - zTo` depth stopped the contour short by exactly the skin
  // between the stock and the part (1.2 mm on the tray, 0.8 mm on the organizer), so the part was
  // never actually freed. `tree.contour.zTo` is already stock-top-relative (#1018's door).
  const contourDepthRawMm = -tree.contour.zTo;
  // #988 — the freeing contour stops at the band: depth min(demand, band). The demand stays for
  // the setup's own "what is left" line in `planModelCam`.
  //
  // #1003 — THE STOCK BOTTOM IS THE FLOOR TOO. A goal taller than its blank (the corpus figure is
  // 41.337 mm on a 40 mm stock) must not free through the vise: the verifier's `cut-too-deep` is
  // the hard gate, and this is the PLAN honouring it — the freeing contour is cut off at the stock
  // bottom and the clipped millimetres are stated. The sacrificial board's allowance is a separate
  // input this function does not receive yet (stated, not silently zero). The two floors COMPOSE:
  // the shallower of the demand, the band and the stock bottom wins.
  // #1018 — `tree.frame.stockBottom` is shifted by the SAME door translate `stockTop` is (the
  // door's own doc), so this is already "depth below the stock top", no `z0` subtraction needed.
  const stockBottomZ = tree.frame.stockBottom;
  const stockFloorDepthMm = stockBottomZ === undefined ? undefined : -stockBottomZ;
  const breakthroughMm = opts.sacrificialBreakthroughMm ?? 0;
  const contourFloorDepthMm = stockFloorDepthMm === undefined ? undefined : stockFloorDepthMm + Math.max(0, breakthroughMm);
  const contourDepthMm = Math.min(
    contourDepthRawMm,
    depthBandMm === undefined ? Number.POSITIVE_INFINITY : depthBandMm,
    contourFloorDepthMm === undefined ? Number.POSITIVE_INFINITY : contourFloorDepthMm,
  );
  /** #1003 — the SAME floor for every op's depth: nothing is planned below the stock bottom. */
  const capDepth = (raw: number): number => (stockFloorDepthMm === undefined ? raw : Math.min(raw, stockFloorDepthMm));

  // The manager's #959 ruling: the top land OUTSIDE every pocket's footprint, faced through the
  // SAME `pocket()` op and `link()` safety every other region uses — not a new op. `tree.top.floors`
  // is NOT the right region for it (advisor's review on 9a5cc607): features/tree.ts's own "top
  // land" step deliberately EXCLUDES an island's own top (so it is not faced either, there is
  // nowhere else a skin over one gets cut) and, being a recognised shape, erodes away under a
  // real cutter's own radius wherever the land is a wall or a rim narrower than that — exactly
  // where this plan most needs it to still reach. Facing the WHOLE outline instead (the SAME
  // open-edge overhang the open-shoulder fix already uses, `offset(outline, +2r)`) has neither
  // problem. Computed per cutter (below, not here) since the margin is `r`-sized.
  //
  // Ordering now DOES matter (advisor's review on this revert): a root pocket's/wide through
  // hole's own mouth is `tree.top.z`, not the stock top (below) — it assumes facing already took
  // the skin everywhere, so facing posting AFTER one would hand it a first stepdown pass deeper
  // than `stepDownMm` expects. This is pushed FIRST into `features`, below, which is enough: a
  // flat tool covers facing unconditionally (no opening/corner/flute-depth constraint it can
  // fail), so `chainFrom`'s own `addLink(primary)` always claims it on the first cutter's first
  // link — and `regionIds`' own order-preserving filter over `pocketFeatures` then puts it ahead
  // of every pocket/through-hole sharing that same step. See the regression test proving this by
  // POSTED ORDER, not by trusting this push order alone, in `opsAcceptance959.spec.ts`.
  const facingSkinMm = -tree.top.z;
  // #959 (2026-11-05 ruling): facing is an OPERATOR OPTION, off by default.
  const hasFacing = (opts.facing ?? 'off') === 'on' && facingSkinMm > 1e-6;
  // #943 (2026-11-05 ruling): FACING LEVELS THE TOP, it does not skin it. The top is the HIGHEST
  // probed point; the TARGET is one step-down below the LOWEST probed point — "it may require many
  // passes as the high point may be a large variance" — so a stock standing well proud of the part
  // finishes one step below its low point and the remaining skin is the rough's/skin's to take.
  // The target clamps at the PART TOP (one step deeper would cut the design's own top face), and
  // the clamp is STATED when it binds (a skin thinner than one row step). In this datum the
  // registration writes Z0 at the LOWEST touch (#475's `Z0_REFERENCE`), so the highest reading is
  // `+spreadMm` above the zero and the target sits at `−stepDown`. No probes → the stated stock
  // top is the cut's start, stated on the plan.
  const facingSpreadMm = Math.max(0, opts.stockProbes?.spreadMm ?? 0);
  const facingTopZ = facingSpreadMm;
  const facingDepthMm = Math.min(opts.stepDownMm, facingSkinMm);
  if (hasFacing) {
    refById.set('facing', {
      id: 'facing', kind: 'pocket', bounds: boundsOfPolygons(tree.contour.outline),
      topZ: facingTopZ, bottomZ: -facingDepthMm, obstacles: [],
      regionClearanceZ: Math.max(0, tree.frame.partTop) + 5,
    });
  }

  const features: SequenceFeature[] = [];
  if (hasFacing) features.push({ id: 'facing', kind: 'pocket', depthMm: facingDepthMm });
  for (const node of pocketNodes) {
    features.push({
      id: node.id,
      kind: 'pocket',
      // An OPEN node's OWN narrowest is measured against its unextended boundary, which is not
      // the real constraint at an open edge (finding 3) — the extension this op applies (below)
      // is what decides whether a cutter fits there, not this number; stating it here would
      // exclude a cutter the extended region can serve.
      minOpeningMm: node.open ? null : node.narrowest,
      cornerRadiusMm: node.open ? null : node.narrowest / 2,
      // Measured below the STOCK top (`SequenceFeature.depthMm`'s own doc), not the node's own
      // mouth — a nested node's flute reach is under-reported by `mouthZ - floorZ` alone.
      // #988 — the BAND makes the feature shallower: the cutter is sized against the depth the
      // plan actually cuts, and the rest is stated as remainder (the rule itself is untouched).
      // #1003 — the stock bottom caps it as well; the shallower wins.
      depthMm: capDepth(depthBandMm === undefined ? -node.floorZ : Math.min(-node.floorZ, depthBandMm)),
    });
  }
  for (const node of throughNodes) {
    features.push({
      id: node.id,
      kind: 'pocket',
      minOpeningMm: node.narrowest,
      cornerRadiusMm: node.narrowest / 2,
      depthMm: capDepth(depthBandMm === undefined ? -node.floorZ : Math.min(-node.floorZ, depthBandMm)),
    });
  }
  // #987 — a skirt-closed relief's outline is synthetic: the kernel's own requirement for a
  // solid, not a design edge, so no contour op is demanded against it. `tree.contour.frees`
  // stays what it always was (whether a REAL contour reaches the stock bottom, which decides
  // tabs below) — a different question from whether a contour exists at all.
  if (!tree.contour.synthetic) {
    features.push({ id: 'contour', kind: 'contour', depthMm: contourDepthMm });
  }
  const demand = { features };

  const cutters: CutterCandidates = { house: [...opts.houseFlats], catalogue: [] };

  // #990 — EVERY CANDIDATE FLAT, ITS OWN ROW. `opts.paramsFor`, when the caller supplies it
  // (`planModelCam` now does, for every tool in the house), resolves feed/plunge/step-down/RPM
  // from THAT cutter's own catalogue row; absent, every existing caller that never passes it
  // keeps the old (primary-wide) numbers unchanged. `stepOver` here stays this function's own
  // quarter-diameter convention either way — `opts.paramsFor`'s own `.stepOver` is a different,
  // catalogue-row number no pocket-chain call site reads from this result.
  const cutParamsFor = (cutter: Tool): CutParams => ({
    ...(opts.paramsFor?.(cutter) ?? {
      rpm: opts.spindleRpm,
      feed: opts.feeds.feedMmPerMin,
      plungeFeed: opts.feeds.plungeFeedMmPerMin,
      stepDown: opts.stepDownMm,
      peck: 0,
      air: opts.air,
    }),
    // Only feed/plunge/step-down/RPM vary by cutter here (#990); `stepOver` keeps this
    // function's own quarter-diameter convention and `peck`/`air` keep the pocket chain's own
    // values regardless of what the resolved row's own catalogue entry happens to carry —
    // `opts.paramsFor`'s result is a full `CutParams` (its OWN peck/air, meant for a DIFFERENT
    // consumer), not this function's contract.
    peck: 0,
    air: opts.air,
    stepOver: (cuttingDiameter(cutter) ?? 1) / 4,
  });

  /**
   * #961 — A REST'S OWN REGION (the manager's 11-05 finding, measured): the tray's ⌀3.175 rest was
   * planned as a full pocket pass — every op the ⌀6 already cut, re-cut at all three levels, 4,306 s
   * (90.2 % of its 60,266 mm of feed travelled over floor the primary had already cleared and
   * removed nothing). The material a pocket primary leaves standing is AT THE FLOOR: the 0.58 mm
   * lands between the tray's scoops, which the ⌀6's disc cannot span but the ⌀3.175's can. The
   * rest is therefore ONE pass at the node's floor over the pocket's own region — not the mouth,
   * not every level, not the facing the primary already finished.
   *
   * The manager's suggested criterion (`cut only where prevCl − restCl > band`) was tried first and
   * blocked by the rest op's own rule (`ops/rest.ts`): its mask is `nextCL + stockToLeave + margin
   * < levelZ`, so it always stops a band ABOVE its own CL — in the curved pipeline the ball finish
   * takes that band. As a POCKET rest it cannot cut to the floor at all (at the floor level its
   * mask is empty by construction), and the tray's lands stand at the floor. The floor-level pass
   * is the shape that cuts what actually stands, and it keeps the coverage bit-identical.
   *
   * #961 follow-up — THE REGION IS THE SIMULATED LEFTOVER: when the caller supplies `restRegion`
   * (it owns the goal), the pass is confined to the cells the CHAIN SO FAR leaves above the band,
   * dilated by the rest's radius plus its step-over so its centre can reach them. The material
   * map showed the untrimmed floor pass still crossing cleared floor at 83 % of its feed; the
   * spine strips and slot-wall corners are all there is to cut.
   */
  const planRestRegion = (id: string, step: SequenceStep, prefix: readonly SequenceStep[] | undefined): OpOutcome | null => {
    // The primary faced the land and cleared the through holes; nothing rests there (the primary's
    // own pass already reached the design surface). Only a pocket's floor can hold a land.
    if (id === 'facing') return null;
    const node = pocketsById.get(id);
    if (node === undefined) return null;
    const ref = refById.get(id);
    if (ref === undefined) return null;
    const cutter = step.cutter.tool;
    const floorZ = cutFloor(node.floorZ);
    const stepOverMm = (cuttingDiameter(cutter) ?? 1) / 4;
    const radius = (cuttingDiameter(cutter) ?? 0) / 2;
    // The chain so far, as IRs (each prefix step planned with its own prefix; all memoized).
    const prefixIrs: ToolpathIR[] = [];
    if (prefix !== undefined) {
      for (let i = 0; i < prefix.length; i++) {
        let ir: ToolpathIR | null;
        try {
          ir = planStep(prefix[i]!, prefix.slice(0, i));
        } catch {
          ir = null;
        }
        if (ir !== null) prefixIrs.push(ir);
      }
    }
    let regionPolys = node.region;
    if (opts.restRegion !== undefined) {
      if (prefixIrs.length === 0) return null; // nothing planned before it: no leftover to cut
      const mask = opts.restRegion(prefixIrs, { id, footprint: node.region, floorZ, bounds: ref.bounds });
      if (mask === null || mask.length === 0) return null;
      // #962 — THE DILATION: 2r + 0.25, MEASURED. `2r + stepOver + 0.25` grew the leftover mask
      // ~4.2 mm on a ⌀3.175 and the rings swept that grown area: the integration tip's tray rest
      // spent 601 s of feed over cells the prefix already held within the band. But `r + 0.25`
      // is WORSE, not tighter: `pocketLoops` erodes the region by r before it rings it, so a
      // strip grown only to r leaves a region narrower than the cutter's diameter and the rest
      // emits NO toolpath at all for that pocket — six of the tray's seven lost their pass
      // outright and coverage fell 99.34 → 99.03 %. The tray sweep brackets the threshold at
      // exactly 2r (3.15 mm: 99.30 %; 3.20 mm: 99.34 %; 2r = 3.175): the grown strip needs to be
      // a cutter diameter wide for the eroded ring to exist. So the dilation is 2r — the ring's
      // own inset plus the reach the cell needs — plus 0.25 mm of margin; the grown region is
      // still clipped back to the pocket's own mouth (A ∩ B = A \ (A \ B)). Tray at this value:
      // coverage 99.344 % (identical to the over-grown tip), rapid 660.6 s vs its 732.3 s.
      regionPolys = opts.offset(mask, opts.restDilationMm ?? 2 * radius + 0.25);
      if (regionPolys.length === 0) return null;
      if (opts.boolean !== undefined) {
        const clipped = opts.boolean.subtract(regionPolys, opts.boolean.subtract(regionPolys, node.region));
        // #962 — the mask holds standing cells but nothing of it survives at this pocket's own
        // mouth: a planned pass that would cut nothing, STATED rather than silently dropped
        // (the same silence the r-only dilation produced when `pocketLoops` could not ring).
        if (clipped.length === 0) {
          throw new Error(
            `the rest's leftover mask has standing cells but none of it survives inside this pocket at the ` +
              `cutter's radius (${radius} mm) — standing material outside the mask's reach is left uncut`,
          );
        }
        regionPolys = clipped;
      }
    }
    const restNode: PocketNode = {
      ...node,
      open: false,
      through: false,
      region: regionPolys,
      floors: [{ polygons: regionPolys, area: 0 }],
      mouthZ: floorZ,
      floorZ,
    };
    const restOutcome = pocket({
      cutter,
      node: restNode,
      region: ref,
      stepOverMm,
      // #990 — a rest's cutter is SMALLER than the primary by construction (that is the whole
      // point of a rest); its own row, not the primary's, is what this pocket is cut at.
      stepDownMm: cutParamsFor(cutter).stepDown,
      feeds: { feedMmPerMin: cutParamsFor(cutter).feed, plungeFeedMmPerMin: cutParamsFor(cutter).plungeFeed },
      offset: opts.offset,
      safeZMm: SAFE_Z,
      hopZMm: HOP_Z,
      toolNumber: cutter.number ?? 1,
      spindleRpm: cutParamsFor(cutter).rpm,
      air: opts.air,
      rapid: opts.rapid,
      boolean: opts.boolean,
    });
    // #962 — A REST THAT CUTS NOTHING OVER LIVE STANDING MATERIAL IS STATED, NEVER SILENT: the
    // mask said cells stand here, and the op produced no toolpath (the region eroded to nothing
    // at the cutter's radius — the failure a too-small dilation produced on six of the tray's
    // seven rest passes, where those plans simply had no rest op and said nothing). Throwing
    // takes the region into `unplanned` with this reason, in the plan's own outcome words.
    if (restOutcome.ir.operations.every((operation) => operation.moves.length === 0)) {
      throw new Error(
        `the rest's leftover mask eroded to nothing at the cutter's radius (${radius} mm) — ` +
          'standing material under this mask is left uncut',
      );
    }
    return restOutcome;
  };

  const planRegion = (id: string, step: SequenceStep, prefix?: readonly SequenceStep[]): OpOutcome | null => {
    const ref = refById.get(id);
    if (ref === undefined) return null;
    const cutter = step.cutter.tool;
    // #961 — Only a COVERAGE rest is a floor-level pass: the primary already cleared the pocket
    // above its floor. A GEOMETRIC rest (a pocket the primary cannot enter at all) still needs the
    // full depth pass — its material stands from the mouth down, not just at the floor.
    if (step.kind === 'rest' && step.coverageRest === true) {
      return planRestRegion(id, step, prefix);
    }
    if (id === 'contour') {
      return contourOp({
        cutter,
        contour: tree.contour,
        region: ref,
        depthMm: contourDepthMm,
        tabs: opts.tabs ?? DEFAULT_RELEASE_TABS,
        offset: opts.offset,
        params: cutParamsFor(cutter),
        rapid: opts.rapid,
        ...(opts.oppositeSafeDepthMm === undefined ? {} : { oppositeSafeDepthMm: opts.oppositeSafeDepthMm }),
      });
    }
    if (id === 'facing') {
      const toolRadius = (cuttingDiameter(cutter) ?? 0) / 2;
      // `offset(outline, +2r)`: the same open-edge overhang the open-shoulder fix uses, so the
      // facing cut reaches all the way to the true outer edge, past every island top and every
      // wall/rim too narrow to survive `tree.top.floors`' own erosion. The overshoot past the
      // true edge is air once the contour frees the part, same reasoning as the shoulder case.
      //
      // E's measurement on faf7ad78: excluding each pocket's own interior made BOTH reference
      // parts SLOWER (tray +165 s, organizer +155 s) — the holed raster this cut into the
      // facing region, going around every pocket's own boundary, is many SHORT feed segments
      // (+58 %/+27 % feed moves), and that cost more than the area it skipped saved. Reverted:
      // facing covers the WHOLE grown outline again, no exclusion. The real lever E found in
      // the posted program was the STEP-OVER: facing ran at 25 % of the cutter's own diameter
      // (the same fraction a tight pocket needs for wall engagement), where an OPEN, single-pass
      // facing cut can use far more of it. The manager's stated band was 50-60 %; `pocketLoops`
      // itself refuses anything over 50 % by default (`maxStepOver = toolRadius`, #191 — past
      // that, contour-parallel rings leave an uncut spine) and `pocket()` does not expose a
      // higher one to ask for, so 50 % (= toolRadius, exactly the ceiling) is what this can
      // actually post, not a choice within the band. Not a lookup of the real feeds row's own
      // stepOverFraction (feeds.ts) either — wiring that in needs a material/tool lookup this
      // function does not have today, named as the next integration point.
      const facingRegion = opts.offset(tree.contour.outline, 2 * toolRadius);
      return pocket({
        cutter,
        node: {
          id: 'facing', floorZ: -facingDepthMm, mouthZ: facingTopZ, open: false, through: false,
          region: facingRegion, floors: [], islands: [], children: [], remainder: [], narrowest: Infinity,
        },
        region: ref,
        stepOverMm: toolRadius,
        // #990 — this cutter's own row, not necessarily the primary's (facing is usually cut by
        // the chain's primary, but the cutter is still named per-call, never assumed).
        stepDownMm: cutParamsFor(cutter).stepDown,
        feeds: { feedMmPerMin: cutParamsFor(cutter).feed, plungeFeedMmPerMin: cutParamsFor(cutter).plungeFeed },
        offset: opts.offset,
        safeZMm: SAFE_Z,
        hopZMm: HOP_Z,
        toolNumber: cutter.number ?? 1,
        spindleRpm: cutParamsFor(cutter).rpm,
        air: opts.air,
        rapid: opts.rapid,
        boolean: opts.boolean,
        ...(opts.shadowMesh === undefined ? {} : { aboveMaterial: { mesh: opts.shadowMesh } }),
      });
    }
    const throughNode = throughById.get(id);
    if (throughNode !== undefined) {
      const diameter = cuttingDiameter(cutter) ?? 1;
      // The manager's #959 ruling 2: a through hole is CLEARED, not just profiled — a profile cut
      // alone leaves an uncut slug in the middle of anything wider than about two cutter
      // diameters (through-the-material, nothing holds it, nowhere for the chips of it to go).
      // Narrower than that, the slug a profile cut would leave is negligible next to the kerf
      // itself, and the real pocket op's own Z-level stepping/linking would be wasted on it.
      if (throughNode.narrowest >= 2 * diameter) {
        return pocket({
          cutter,
          // `tree.top.z`, not the stock top — facing already clears the skin above it everywhere,
          // this hole's own footprint included (same reasoning as the root-pocket mouth, below).
          node: { ...throughNode, mouthZ: tree.top.z, floorZ: throughNode.floorZ },
          region: ref,
          stepOverMm: diameter / 4,
          // #990 — this cutter's own row.
          stepDownMm: cutParamsFor(cutter).stepDown,
          feeds: { feedMmPerMin: cutParamsFor(cutter).feed, plungeFeedMmPerMin: cutParamsFor(cutter).plungeFeed },
          offset: opts.offset,
          safeZMm: SAFE_Z,
          hopZMm: HOP_Z,
          toolNumber: cutter.number ?? 1,
          spindleRpm: cutParamsFor(cutter).rpm,
          air: opts.air,
          rapid: opts.rapid,
          boolean: opts.boolean,
          ...(opts.shadowMesh === undefined ? {} : { aboveMaterial: { mesh: opts.shadowMesh } }),
        });
      }
      return throughHole({
        cutter,
        id,
        outline: throughNode.region,
        region: ref,
        depthMm: capDepth(depthBandMm === undefined ? -throughNode.floorZ : Math.min(-throughNode.floorZ, depthBandMm)),
        offset: opts.offset,
        params: cutParamsFor(cutter),
        rapid: opts.rapid,
      });
    }
    const node = pocketsById.get(id);
    if (node === undefined) return null;
    const diameter = cuttingDiameter(cutter) ?? 1;
    // Rebased onto the SAME Z 0 = stock top every op shares (see this function's header note); a
    // root's own mouth is `tree.top.z`, not the stock top directly — facing (above) already
    // clears the skin from the stock top down to the top land everywhere, including over every
    // root pocket's own footprint, so a root pocket starting at the stock top too would re-face
    // that same skin layer a second time (the manager's "pocket passes that overlap the faced
    // land start below it"). `tree.top.z` equals the stock top when there is no skin, so this is
    // the stock top again in that case — not a separate branch. A nested node's mouth is
    // unaffected, its parent's own floor, as before.
    const mouthZ = rootIds.has(node.id) ? tree.top.z : node.mouthZ;
    return pocket({
      cutter,
      node: { ...node, mouthZ, floorZ: cutFloor(node.floorZ) },
      region: ref,
      stepOverMm: diameter / 4,
      // #990 — this cutter's own row (a nested/coverage node can be assigned a rest flat, not
      // necessarily the primary).
      stepDownMm: cutParamsFor(cutter).stepDown,
      feeds: { feedMmPerMin: cutParamsFor(cutter).feed, plungeFeedMmPerMin: cutParamsFor(cutter).plungeFeed },
      offset: opts.offset,
      // The SAME constants `contourOp` gets from `generateProfile` (ir.ts) — a pocket and the
      // contour in one cutter's program must agree on `safeZ`/`hopZ` (`concatToolpathIR` refuses
      // otherwise); both are only meaningful heights ABOVE the stock because every Z passed to
      // either op is now on that SAME stock-top-relative axis.
      safeZMm: SAFE_Z,
      hopZMm: HOP_Z,
      toolNumber: cutter.number ?? 1,
      spindleRpm: cutParamsFor(cutter).rpm,
      air: opts.air,
      rapid: opts.rapid,
      openOutline: node.open ? tree.contour.outline : undefined,
      boolean: opts.boolean,
      ...(opts.shadowMesh === undefined ? {} : { aboveMaterial: { mesh: opts.shadowMesh } }),
    });
  };

  // `chooseSequence` calls `planStep` once per candidate it prices (not just the chosen one); a
  // step's own signature (kind + cutter + regionIds) is stable across those calls, so the SAME
  // step, priced more than once, is only ever planned once.
  const outcomeCache = new Map<string, { id: string; outcome: OpOutcome }[] | null>();
  const stepSignature = (step: SequenceStep): string => `${step.kind}:${step.cutter.key}:${step.regionIds.join(',')}`;

  // The manager's ruling on #959: a throwing region must not crash the whole plan. `sequence.ts`
  // prunes candidates on GEOMETRY alone (an opening, a corner, a flute length) — it has no notion
  // of a region that passes that pruning but fails when actually planned (a Clipper failure on an
  // extended open shoulder, a degenerate through hole), so this is the one place that can catch
  // it. Caught per region, not per step: the OTHER regions in the same step still plan and post.
  const regionFailures = new Map<string, SequenceStepFailure>();
  // The same failures by step signature, so the plan states the CHOSEN chain's own (not another
  // candidate's) in `unplanned`, each with the message its region threw.
  const stepFailures = new Map<string, { id: string; reason: string }[]>();

  // #961 — THE SAME STEP, PRICED BY MANY CANDIDATES, IS ONE IR: the picker stamps every priced
  // candidate's steps, so the merge (and, in `planModelCam`, the stamp) must be done once per
  // step, not once per candidate. Keyed by the same signature the outcome cache uses.
  // #961 — a COVERAGE rest's IR depends on the chain so far (its region is that chain's stamped
  // leftover), so the caches key on the prefix for a rest step; every other step is prefix-free.
  const stepKey = (step: SequenceStep, prefix: readonly SequenceStep[] | undefined): string =>
    step.kind === 'rest' && prefix !== undefined && prefix.length > 0
      ? `${stepSignature(step)}|after:${prefix.map((s) => stepSignature(s)).join('>')}`
      : stepSignature(step);
  const irCache = new Map<string, ToolpathIR | null>();
  const planStep: SequenceOptions['planStep'] = (step, prefix) => {
    const signature = stepKey(step, prefix);
    if (irCache.has(signature)) return irCache.get(signature)!;
    // The outcome cache uses the SAME key as the IR cache (a rest's regions depend on its prefix),
    // and the chosen chain's ops build reads it back by `stepKey` — the two must agree or a rest's
    // ops silently drop out of the posted program.
    let outcomes = outcomeCache.get(signature);
    if (outcomes === undefined) {
      outcomes = [];
      for (const id of step.regionIds) {
        let outcome: OpOutcome | null;
        try {
          outcome = planRegion(id, step, prefix);
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          if (!regionFailures.has(id)) regionFailures.set(id, { kind: step.kind, cutterKey: step.cutter.key, regionIds: [id], reason });
          const signature = stepSignature(step);
          stepFailures.set(signature, [...(stepFailures.get(signature) ?? []), { id, reason }]);
          continue;
        }
        if (outcome === null) continue;
        outcomes.push({ id, outcome });
      }
      outcomeCache.set(signature, outcomes);
    }
    const merged = outcomes === null || outcomes.length === 0
      ? null
      : outcomes.map((o) => o.outcome.ir).reduce((a, b) => concatToolpathIR(a, b));
    irCache.set(signature, merged);
    return merged;
  };

  // #987 — a demand with NOTHING in it (every pocket/through-hole is a `curved` region planned
  // by `planCurvedForTree` instead, and the contour is synthetic or absent) is trivially
  // satisfied: no pocket-chain cutter is needed, so none is required to exist. Without this,
  // `candidateSequences` finds no candidate to build (every built step list is empty and `add`
  // drops it) and `chooseSequence` threw "no cutter sequence can be planned" against a relief
  // that in fact needs no pocket-chain cutter at all (#869's ball-alone relief, #966's open-mesh
  // relief). Guarded here, not in `sequence.ts`, so the general-purpose chooser stays untouched.
  const choice: SequenceChoice = demand.features.length === 0
    ? { steps: [], cost: { entries: [], estimateSeconds: 0, toolChanges: 0, toolChangeSeconds: 0, totalSeconds: 0 }, considered: [], unreachable: [], freeing: null, unplanned: [] }
    : chooseSequence(demand, cutters, {
    rapid: opts.rapid,
    toolChangeSeconds: opts.toolChangeSeconds,
    planStep,
    maxCutters: opts.maxCutters,
    ...(opts.goalCoverage === undefined
      ? {}
      : {
          coverage: (steps: readonly SequenceStep[]) => {
            // The candidate's PLANNED steps' IRs (cached by planStep) — what would post. A step
            // that throws cuts nothing (`priceSequence` already caught it and stated the failure),
            // so it contributes no IR here either: a candidate is never crashed by a simulation.
            const irs: ToolpathIR[] = [];
            const already: SequenceStep[] = [];
            for (const step of steps) {
              let ir: ToolpathIR | null;
              try {
                ir = planStep(step, already);
              } catch {
                ir = null;
              }
              if (ir !== null) irs.push(ir);
              already.push(step);
            }
            return irs.length === 0 ? null : opts.goalCoverage!(irs);
          },
        }),
  });

  // #975 — THE V FLOOR (the maintainer's 2026-11-05 ruling). A pocket the chosen chain leaves
  // UNREACHABLE is not refused while a V bit in the set can do the job: the NARROWEST V whose tip
  // is no wider than the pocket's narrowest stroke and whose leg reaches the floor cuts it as a
  // FLOOR-CORRECT pocket — the model's floor at the model's depth, the floor plane exact (rings
  // from the region offset by the tip's own radius, at the V-carve pass pitch, one level), the
  // walls opening at the V's half-angle, and the land the flanks take per side (`depth·tan(half)`)
  // STATED, never counted as a failure (the gate's edge-break class carries it: the IR's tool is
  // the V, so `whoAt` answers it there). Planned OUTSIDE the chain's cost ranking on purpose —
  // the V is the last resort for features nothing else covers, and a 0.05 mm floor pitch would
  // never earn its place against a covering flat by cost. Its run posts BEFORE the freeing
  // contour: the part must stay captured while it is cut.
  const vCovered = new Set<string>();
  const vOps: PlannedOp[] = [];
  const vRuns: { cutterKey: string; ir: ToolpathIR }[] = [];
  const vNotes: string[] = [];
  // #992 — the per-pocket V-floor numbers behind `vNotes`, so ONE grouped statement can state the
  // cause with its count (the #962 rule) while every pocket keeps its own line in the dump.
  const vFloors: { id: string; depth: number; land: number; angleDeg: number }[] = [];
  if (opts.houseVs !== undefined && opts.houseVs.length > 0 && choice.unreachable.length > 0) {
    const featureOf = new Map(demand.features.map((f) => [f.id, f] as const));
    const byV = new Map<string, { tool: Tool; cone: VCone; ids: string[] }>();
    for (const listed of choice.unreachable) {
      // #1019 review (finding 3) — an un-enterable pocket arrives as its own SENTENCE (the search
      // writes one line per pocket; the bare id is not repeated), so the id is read off the
      // sentence's `': '` prefix before the pocket lookup.
      const id = listed.includes(': ') ? listed.slice(0, listed.indexOf(': ')) : listed;
      const node = pocketsById.get(id);
      const feature = featureOf.get(id);
      if (node === undefined || feature === undefined || feature.kind !== 'pocket' || throughById.has(id)) continue;
      let pick: { tool: Tool; cone: VCone } | null = null;
      // The V's reach is measured from the node's MOUTH, not the stock top: the cone only has to
      // span mouth-to-floor (`SequenceFeature.depthMm` is stock-top-relative for a FLAT's flute,
      // which would refuse the tray's digits by 0.26 mm — their mouth is the −1.2 land, their
      // floor −1.8), and above the mouth the shank rides in air the facing already cleared.
      const mouthZAbsV = rootIds.has(node.id) ? tree.top.z : node.mouthZ;
      // #988 — the V is sized and floored on the band, like the flats: the leg must reach from the
      // MOUTH to the band floor (whichever is shallower), not the node's stated floor.
      const flooredZAbsV = depthBandMm === undefined ? node.floorZ : Math.max(node.floorZ, -depthBandMm);
      const nodeDepthMm = mouthZAbsV - flooredZAbsV;
      for (const tool of opts.houseVs) {
        const cone = vCone(tool);
        if (cone === null) continue;
        const tip = cone.tipRadius * 2;
        if (feature.minOpeningMm !== null && feature.minOpeningMm !== undefined && tip > feature.minOpeningMm + 1e-9) continue;
        const leg = coneHeight(cone);
        if (leg === null || leg + 1e-9 < nodeDepthMm) continue;
        if (pick === null || tip < pick.cone.tipRadius * 2) pick = { tool, cone };
      }
      if (pick === null) continue;
      const key = cutterKeyOf(pick.tool);
      const entry = byV.get(key) ?? { tool: pick.tool, cone: pick.cone, ids: [] };
      entry.ids.push(id);
      byV.set(key, entry);
    }
    for (const [key, group] of byV) {
      const pitch = vCarvePassPitch(group.cone.tipRadius, group.cone);
      const irs: ToolpathIR[] = [];
      for (const id of group.ids) {
        const node = pocketsById.get(id)!;
        const ref = refById.get(id)!;
        const mouthZ = rootIds.has(node.id) ? tree.top.z : node.mouthZ;
        const floorZ = cutFloor(node.floorZ);
        // The V's OWN row where the caller resolves one (its rpm/feed must match that cutter's
        // other runs so the two merge into one program) — the plan's flat numbers otherwise.
        const vParams = opts.paramsFor?.(group.tool);
        const outcome = pocket({
          cutter: group.tool,
          node: { ...node, mouthZ, floorZ },
          region: ref,
          // The floor-correct pass: the tip's own radius as the boundary offset (the floor plane
          // lands on the model's outline), the V-carve pass pitch between rings (clamped to the
          // tip radius, so the tip's flat covers every gap and the floor is flat, not a knife
          // line), and ONE level at the floor (`stepDown = the whole depth`).
          stepOverMm: pitch,
          stepDownMm: mouthZ - floorZ,
          feeds: vParams === undefined ? opts.feeds : { feedMmPerMin: vParams.feed, plungeFeedMmPerMin: vParams.plungeFeed },
          offset: opts.offset,
          safeZMm: SAFE_Z,
          hopZMm: HOP_Z,
          toolNumber: group.tool.number ?? 1,
          spindleRpm: vParams?.rpm ?? opts.spindleRpm,
          air: opts.air,
          rapid: opts.rapid,
          boolean: opts.boolean,
          ...(opts.shadowMesh === undefined ? {} : { aboveMaterial: { mesh: opts.shadowMesh } }),
        });
        vOps.push({ kind: 'pocket', region: ref, outcome });
        irs.push(outcome.ir);
        vCovered.add(id);
        const depth = mouthZ - floorZ;
        const land = depth * group.cone.tanHalf;
        vFloors.push({ id, depth, land, angleDeg: group.cone.halfAngleDeg });
        const r3 = (n: number): string => String(Math.round(n * 1000) / 1000);
        vNotes.push(
          `${id}: cut by the ${group.tool.name || group.tool.shape} V as a floor-correct pocket — floor at the model's ` +
            `−${r3(depth)} mm, walls at ${r3(group.cone.halfAngleDeg)}°, land ${r3(land)} mm per side (the V's own geometry: ` +
            `depth × tan(half)); the land at the surface is the edge-break class, not cut-into`,
        );
      }
      if (irs.length > 0) vRuns.push({ cutterKey: key, ir: irs.reduce((a, b) => concatToolpathIR(a, b)) });
    }
  }

  const ops: PlannedOp[] = [];
  // Advisor's review on ab6b2827: grouped by cutter KEY (a Map), a return visit merges into the
  // SAME file as that cutter's first visit — which, read in that file's own order, frees the
  // part (the contour, appended at the end) before whatever ran in between on the OTHER cutter
  // ever did. Grouped by RUN instead: a new entry starts the moment the step's cutter changes,
  // so the SAME cutter key can appear more than once, in the right place each time.
  const programs: { cutterKey: string; ir: ToolpathIR }[] = [];
  let currentRun: { cutterKey: string; ir: ToolpathIR } | null = null;
  // The manager's #959 ruling: the part's freeing cut (the outer contour) is posted LAST, after
  // every rest/finish/chamfer step that still touches the part. #961 now owns this directly: the
  // contour is its own step, always last in `choice.steps`, and its cutter is priced like any
  // other choice (a RETURN to an earlier cutter is charged a tool change in `choice.cost`, same
  // as the chain's last cutter taking the profile itself when that is cheaper) — nothing to defer
  // or re-plan here, every step (contour included) goes through the SAME loop.
  for (let stepIndex = 0; stepIndex < choice.steps.length; stepIndex++) {
    const step = choice.steps[stepIndex]!;
    // #975 — the V-floor run posts BEFORE the freeing contour (the part must stay captured while
    // its narrow pockets are cut); it is flushed exactly once, at the contour step or at the end
    // when the chain has no contour step.
    if (step.kind === 'contour' && vRuns.length > 0) {
      if (currentRun !== null) programs.push(currentRun);
      currentRun = null;
      ops.push(...vOps);
      programs.push(...vRuns);
      vRuns.length = 0;
    }
    // The SAME key the picker priced it under — a coverage rest's IR depends on its prefix.
    const outcomes = outcomeCache.get(stepKey(step, choice.steps.slice(0, stepIndex)));
    if (outcomes === undefined || outcomes === null) continue; // chooseSequence only chose postable steps
    if (currentRun === null || currentRun.cutterKey !== step.cutter.key) {
      if (currentRun !== null) programs.push(currentRun);
      currentRun = null;
    }
    for (const { id, outcome } of outcomes) {
      const ref = refById.get(id)!;
      // A through hole is cleared like a pocket now (ruling 2), profile-only only when it is too
      // narrow for that to mean anything — 'pocket' either way describes what it does.
      ops.push({ kind: id === 'contour' ? 'contour' : 'pocket', region: ref, outcome });
      currentRun = currentRun === null
        ? { cutterKey: step.cutter.key, ir: outcome.ir }
        : { cutterKey: currentRun.cutterKey, ir: concatToolpathIR(currentRun.ir, outcome.ir) };
    }
  }
  if (currentRun !== null) programs.push(currentRun);
  if (vRuns.length > 0) {
    // No contour step in the chain (a caller that states none): the V run still posts.
    ops.push(...vOps);
    programs.push(...vRuns);
    vRuns.length = 0;
  }

  const offered = [...opts.houseFlats].map((t) => `⌀${cuttingDiameter(t)}`).join(', ');
  // A's review 6622610124, finding 4: a through node's own limiting number was lost (the lookup
  // only checked `pocketsById`) — the SAME sentence either kind of node gets.
  const unreachable = choice.unreachable.filter((id) => !vCovered.has(id) && !(id.includes(': ') && vCovered.has(id.slice(0, id.indexOf(': '))))).map((id) => {
    // #1019 — an entry the SEARCH composed (a pocket no cutter can enter, stated with its own
    // number: "pocket-0: 0.541 mm opening, … — left standing") passes through as written unless a
    // V-floor run covers that pocket (then it is cut, not standing); a bare region id is given
    // this plan's own sentence below.
    if (id.includes(': ')) {
      const named = id.slice(0, id.indexOf(': '));
      return vCovered.has(named) ? '' : id;
    }
    const node = pocketsById.get(id) ?? throughById.get(id);
    const failed = regionFailures.get(id);
    // #959 item 5: a region the chosen chain left out because its planning THREW (the chain that
    // would have cut it ranked lower for that failure) is not a cutter-size limit — say why.
    if (failed !== undefined) return `${id}: not cut — planning failed (${failed.reason})`;
    return node === undefined
      ? `${id}: not cut`
      : `${id}: not cut — needs a cutter ≤ ${node.narrowest.toFixed(2)} mm (house offers ${offered})`;
  });

  // A step that posted with some regions thrown, and a step that failed whole (`choice.unplanned`):
  // either way one entry per thrown region, with its own message; a step that failed without a
  // throw (it planned nothing) keeps the sequence's own entry.
  const unplanned: SequenceStepFailure[] = [];
  for (const step of [...choice.steps, ...choice.unplanned]) {
    const kind = step.kind;
    const cutterKey = 'cutter' in step ? step.cutter.key : step.cutterKey;
    const thrown = stepFailures.get(`${kind}:${cutterKey}:${step.regionIds.join(',')}`) ?? [];
    for (const { id, reason } of thrown) unplanned.push({ kind, cutterKey, regionIds: [id], reason });
    if (thrown.length === 0 && 'reason' in step) unplanned.push(step);
  }
  // A region the chosen chain does not cut at all because every chain that tried it threw (the
  // chain without it then ranks first): its first failure, so its own message is stated too.
  for (const id of choice.unreachable) {
    const failed = regionFailures.get(id);
    if (failed !== undefined && !unplanned.some((f) => f.regionIds.includes(id))) unplanned.push(failed);
  }
  // #962 — AND A THROWN REGION IS STATED when the chosen plan leaves its material standing, even
  // when its candidate lost the ranking. WARNINGS MUST DISCRIMINATE: a REGION the chosen chain
  // covers, which threw only in a candidate that lost, has its material cut — not stated. A REST
  // is different in kind: its mask was computed as leftover standing above the band, so a rest
  // that could not cut is standing-material evidence whatever the chain chose.
  const chosenCovers = new Set(choice.steps.flatMap((step) => step.regionIds));
  for (const [id, failure] of regionFailures) {
    if (failure.kind !== 'rest' && chosenCovers.has(id)) continue;
    if (!unplanned.some((f) => f.regionIds.includes(id))) unplanned.push(failure);
  }

  const notes: string[] = [];
  // #992 — the SAME facts, typed: code, severity and count, so the seam can route them. `notes`
  // keeps every string exactly as before (the failure path joins it, the acceptance reads it).
  const statements: PlanStatement[] = [];
  // #1037 — A PLAN THAT DOES NOT FREE THE PART SAYS SO, WITH THE NUMBERS. When the demand carries
  // a real contour (`tree.contour.synthetic` false) and the CHOSEN sequence has no contour step —
  // no link's stated flute reaches the profile's floor — the profile is not cut and the part stays
  // attached to the stock. The reach numbers come from the STATED flutes only (the owned cutters
  // carry no ids; no catalogue row is read, 6b's rule): the profile's floor and the longest stated
  // flute among the set's flats. The old behaviour was silence, and the whole-goal reach gate used
  // to mask it on the model path (#1037). A job that never frees a part (no contour in the demand)
  // is untouched.
  {
    const contourFeature = features.find((f) => f.kind === 'contour');
    if (contourFeature !== undefined && !choice.steps.some((step) => step.kind === 'contour')) {
      const floorMm = Number(contourFeature.depthMm.toFixed(3));
      const stated = (opts.houseAll ?? cutters.house).filter((t) => t.shape === 'flat' && t.fluteLength !== null);
      const longest = stated.reduce<Tool | null>(
        (best, t) => (best === null || (t.fluteLength ?? 0) > (best.fluteLength ?? 0) ? t : best),
        null,
      );
      const diaWords = (t: Tool): string => `⌀${Number((t.diameter ?? t.tipDiameter ?? 0).toFixed(3))} flat`;
      // THE CAUSE HAS TO BE TRUE (the Manager's review): a house flat whose stated flute DOES reach
      // the floor but no step of the chosen chain covers the profile is a different fact from "the
      // set's longest flute is short" — say which, or the numbers would contradict themselves
      // ("floor 27.2 … longest stated flute 42 mm").
      const text =
        longest !== null && (longest.fluteLength ?? 0) + 1e-9 >= contourFeature.depthMm
          ? `the chosen chain does not free the part: the profile's floor is ${floorMm} mm and the ${diaWords(longest)} states a ${longest.fluteLength} mm flute that reaches it, but no step of the chosen chain covers the profile — choose a chain that frees it, or free it by hand`
          : `the part is not freed by this plan: the profile's floor is ${floorMm} mm and ${
              longest === null
                ? 'no flat in the set states a flute'
                : `the longest stated flute in the set is ${longest.fluteLength} mm (${diaWords(longest)})`
            }, so no freeing contour is cut and the part stays attached to the stock — ` +
            `use a flat with a stated flute ≥ ${floorMm} mm, or free it by hand`;
      statements.push({ severity: 'warning', code: 'goal-not-freed', count: 1, ids: [contourFeature.id], text });
      notes.push(text);
    }
  }
  // #1019 — THE POCKETS NO CUTTER CAN ENTER ARE STATED even when nothing else is planned. The
  // search carries them as its own sentences (id, opening, the set it was measured against); one
  // statement per cause with the count (#962), the ids as the cause's pockets, and a single
  // pocket's own sentence as the text so the number is on the statement itself.
  {
    // A sentence whose pocket a V-floor run covers is NOT standing: drop it from the statement.
    const unenterable = choice.unreachable.filter((u) => u.includes(': ') && !vCovered.has(u.slice(0, u.indexOf(': '))));
    if (unenterable.length > 0) {
      const ids = unenterable.map((u) => u.slice(0, u.indexOf(': ')));
      const plural = unenterable.length === 1 ? 'pocket' : 'pockets';
      statements.push({
        severity: 'warning',
        code: 'goal-region-uncut',
        count: unenterable.length,
        ids,
        text: unenterable.length === 1
          ? unenterable[0]!
          : `${unenterable.length} ${plural} no cutter in the set can enter — left standing: ${unenterable.join('; ')}`,
      });
    }
  }
  // #988 — WHAT THE BAND LEAVES, one line per clipped pocket/through feature: the floor it is cut
  // to and the floor the tree states (`pocket-3: cut to −11 of −18 — 7 mm is left in the stock`).
  if (depthBandMm !== undefined) {
    const mm3 = (n: number): string => String(Math.round(n * 1000) / 1000);
    for (const node of [...pocketNodes, ...throughNodes]) {
      const floor = node.floorZ;
      if (floor < -depthBandMm - 1e-9) {
        notes.push(
          `${node.id}: cut to −${mm3(depthBandMm)} of −${mm3(-floor)} — ${mm3(-floor - depthBandMm)} mm is left in the stock (the setup's depth band)`,
        );
      }
    }
  }
  // #1003 — the stock bottom's own clip (plus the board's breakthrough, CONTOUR ONLY), stated
  // once per setup, in the same statement path.
  if (contourFloorDepthMm !== undefined && contourDepthRawMm > contourFloorDepthMm + 1e-9) {
    notes.push(
      `the goal extends ${(contourDepthRawMm - contourFloorDepthMm).toFixed(3)} mm below the stock; the freeing contour is cut off at the stock bottom` +
        (breakthroughMm > 0 ? ` plus the board's ${breakthroughMm.toFixed(3)} mm breakthrough` : ''),
    );
  }
  // #943 (2026-11-05 ruling): the facing stage states where its cut starts, how many passes the
  // probed spread takes, and the clamp when the part top binds. The count mirrors `depthPasses`'
  // own rule (`ceil(total / stepDown)`, the last pass on the floor). `facingDepthMm` is the
  // TARGET depth — one row step below the low point, clamped at the part top — and the skin left
  // above the part top is stated with it.
  if (hasFacing) {
    const mm = (n: number): string => String(Math.round(n * 1000) / 1000);
    const passes = Math.max(1, Math.ceil((facingSpreadMm + facingDepthMm) / opts.stepDownMm - 1e-9));
    const plural = passes === 1 ? 'pass' : 'passes';
    const above = Math.max(0, facingSkinMm - facingDepthMm);
    const clamp = facingSkinMm < opts.stepDownMm - 1e-9;
    const floorWords = clamp
      ? `the part top ${mm(facingDepthMm)} mm below the zero`
      : `${mm(facingDepthMm)} mm below the zero, the lowest point less one row step (${mm(above)} mm above the part top)`;
    const facingText =
      opts.stockProbes === undefined
        ? `facing: no surface measurement — the stated stock top is the cut's start, ${passes} ${plural} of at most ${mm(opts.stepDownMm)} mm to ${floorWords}`
        : `facing: ${opts.stockProbes.count} surface touches, spread ${mm(opts.stockProbes.spreadMm)} mm from the highest point — ${passes} ${plural} of at most ${mm(opts.stepDownMm)} mm to ${floorWords}`;
    notes.push(facingText);
    statements.push({ severity: 'sheet', code: 'plan-run', text: facingText, count: passes });
    if (clamp) {
      const clampText = `facing stops at the part top ${mm(facingDepthMm)} mm below the zero — less than one ${mm(opts.stepDownMm)} mm row step; the low side gets a ${mm(facingDepthMm)} mm bite, because one step deeper would cut the design`;
      notes.push(clampText);
      statements.push({ severity: 'sheet', code: 'plan-run', text: clampText, count: 1 });
    }
  }
  // #975 — the V floor's own lines: floor, wall angle, and the land per side the flanks take
  // (the V's own geometry, stated; the gate's edge-break class carries the land).
  notes.push(...vNotes);
  if (vFloors.length > 0) {
    // #992 — ONE statement for the V floor, with the count: the same cause on every pocket, and
    // the six per-pocket lines above are the dump's detail. The numerals are the range the group
    // actually cuts at, never one pocket's numbers generalised to the others.
    const r3 = (n: number): string => String(Math.round(n * 1000) / 1000);
    const depths = vFloors.map((f) => f.depth);
    const lands = vFloors.map((f) => f.land);
    const angles = [...new Set(vFloors.map((f) => r3(f.angleDeg)))];
    const dMin = r3(Math.min(...depths));
    const dMax = r3(Math.max(...depths));
    const lMin = r3(Math.min(...lands));
    const lMax = r3(Math.max(...lands));
    const plural = vFloors.length === 1 ? 'pocket' : 'pockets';
    statements.push({
      severity: 'info',
      code: 'goal-plan-tradeoff',
      count: vFloors.length,
      ids: vFloors.map((f) => f.id),
      text:
        `${vFloors.length} ${plural} cut by the V as floor-correct ${vFloors.length === 1 ? 'pocket' : 'pockets'} — ` +
        `floor at the model's −${dMin === dMax ? dMin : `${dMin}…${dMax}`} mm, walls at ${angles.join('/')}°, ` +
        `land ${lMin === lMax ? lMin : `${lMin}…${lMax}`} mm per side (the V's own geometry: depth × tan(half)); ` +
        'the land at the surface is the edge-break class, not cut-into',
    });
  }
  // #987 — a synthetic outline (the skirt `closeOpenSheet` added to close an open relief) is not
  // a design edge, so this plan demands no contour op against it at all: an open-surface relief —
  // its edge is the stock beside it; nothing is freed.
  if (tree.contour.synthetic) {
    notes.push('an open-surface relief: its edge is the stock beside it; nothing is freed');
    statements.push({
      severity: 'info',
      code: 'goal-relief-edge',
      count: 1,
      text: 'an open-surface relief: its edge is the stock beside it; nothing is freed',
    });
  }
  // #962 — ONE STATEMENT PER CAUSE, NOT A LINE PER REGION: failed regions are grouped by their
  // kind and reason with a count; the per-region detail lives in `unplanned` (machine-readable),
  // never as a wall of operator lines.
  {
    const byCause = new Map<string, { kind: string; reason: string; count: number; ids: string[] }>();
    // #992 — what the OPERATOR actually loses: the same discriminate rule `unplanned` applies
    // (a region the chosen chain covers, which threw only in a candidate that lost, has its
    // material cut). The note above stays the dump's full accounting; the statement must not
    // warn about a region that was cut.
    const lostByCause = new Map<string, { count: number; ids: string[] }>();
    for (const [id, failure] of regionFailures) {
      const key = `${failure.kind}: ${failure.reason}`;
      const entry = byCause.get(key) ?? { kind: failure.kind, reason: failure.reason, count: 0, ids: [] };
      entry.count++;
      entry.ids.push(...failure.regionIds);
      byCause.set(key, entry);
      if (failure.kind !== 'rest' && chosenCovers.has(id)) continue;
      const lost = lostByCause.get(key) ?? { count: 0, ids: [] };
      lost.count++;
      lost.ids.push(...failure.regionIds);
      lostByCause.set(key, lost);
    }
    for (const entry of byCause.values()) {
      const plural = entry.count === 1 ? 'region' : 'regions';
      const text = `${entry.kind}: ${entry.count} ${plural} could not be cut — ${entry.reason}`;
      notes.push(text);
    }
    for (const [key, lost] of lostByCause) {
      const entry = byCause.get(key)!;
      const plural = lost.count === 1 ? 'region' : 'regions';
      const text = `${entry.kind}: ${lost.count} ${plural} could not be cut — ${entry.reason}`;
      // #992 — a region the plan demanded and did not cut changes what comes off the machine:
      // a warning, one per cause with its count (the #962 grouping above). A failed freeing
      // contour is its own code because its consequence is its own: the part is never released.
      statements.push({
        severity: 'warning',
        code: entry.kind === 'contour' ? 'goal-not-freed' : 'goal-region-uncut',
        count: lost.count,
        ids: lost.ids,
        text: entry.kind === 'contour' ? `${text} — THE PART IS NOT FREED BY THIS PLAN` : text,
      });
    }
  }
  // A root pocket's/wide through hole's own mouth assumes facing already cleared the skin
  // (above) — if facing itself is the region that failed, that assumption is now FALSE for
  // every pocket this plan still posted, and nothing re-plans them at the stock top instead.
  // Named here rather than silently trusted, per the advisor's review on this revert.
  if (regionFailures.has('facing')) {
    const text =
      'facing failed to plan but the skin is real (see above) — every pocket/through-hole posted still ' +
      'assumes it is gone; their own first pass is deeper than it looks.';
    notes.push(text);
    statements.push({ severity: 'warning', code: 'goal-region-uncut', count: 1, ids: ['facing'], text });
  }
  // #961's own pick between the two freeing-cut options (a return to the covering cutter, or the
  // chain's last cutter taking the profile itself) is priced in `choice.cost` either way; stated
  // here only when it actually cost something — a plain "no extra change" pick is not a finding.
  if (choice.freeing !== null && choice.freeing.extraToolChange) {
    const lastChainCutter = [...choice.steps].reverse().find((s) => s.kind !== 'contour')?.cutter.key ?? 'the last step';
    const text = choice.freeing.lastCutterEligible
      ? `the freeing cut (contour) is posted LAST on ${choice.freeing.cutterKey} — a RETURN tool change back to it after ${lastChainCutter}, priced in the cycle (taking the profile with ${lastChainCutter} was dearer)`
      : `the freeing cut (contour) is posted LAST on ${choice.freeing.cutterKey} — a RETURN tool change back to it after ${lastChainCutter}, priced in the cycle; ${lastChainCutter} cannot take the profile (flute or stated shape)`;
    notes.push(text);
    statements.push({ severity: 'sheet', code: 'plan-run', text, count: 1 });
  }

  const sequence: SequencedCutter[] = choice.cost.entries.map((entry) => {
    // #927's terms summed over every RUN this cutter appears in (almost always one; a return
    // visit for the freeing cut is two) — concatenating them for `estimateCycleTerms` is only
    // for this one estimate, not a claim they post as a single file (`programs` above is that).
    const cutterRuns = programs.filter((p) => p.cutterKey === entry.cutterKey).map((p) => p.ir);
    const ir = cutterRuns.length === 0 ? undefined : cutterRuns.reduce((a, b) => concatToolpathIR(a, b));
    const terms: CycleTerms = ir === undefined
      ? { movesSeconds: 0, entrySeconds: 0, spinUpSeconds: 0, totalSeconds: 0 }
      : estimateCycleTerms(ir, opts.rapid);
    const stepCutter = choice.steps.find((s) => s.cutter.key === entry.cutterKey)?.cutter;
    return {
      cutterKey: entry.cutterKey,
      cost: {
        terms,
        toolChangeSeconds: entry.toolChangeSeconds,
        totalSeconds: terms.totalSeconds + entry.toolChanges * entry.toolChangeSeconds,
        toolChanges: entry.toolChanges,
      },
      pinned: stepCutter?.pinned ?? false,
      house: stepCutter?.house ?? false,
    };
  });

  // #975 — a V that only the floor run uses is not in `choice.cost.entries`; its run still prices
  // into the cycle, so it gets its own sequence entry (one tool change in). A V already in the
  // chain — the tray's chamfer, which also breaks the rims — needs nothing here: its entry's own
  // terms already sum over every run of its key, the floor run included.
  const sequenced = new Set(sequence.map((s) => s.cutterKey));
  for (const run of programs) {
    if (sequenced.has(run.cutterKey)) continue;
    if (choice.steps.some((s) => s.cutter.key === run.cutterKey)) continue;
    sequenced.add(run.cutterKey);
    const terms = estimateCycleTerms(run.ir, opts.rapid);
    sequence.push({
      cutterKey: run.cutterKey,
      cost: {
        terms,
        toolChangeSeconds: opts.toolChangeSeconds,
        totalSeconds: terms.totalSeconds + opts.toolChangeSeconds,
        toolChanges: 1,
      },
      pinned: false,
      house: true,
    });
  }

  return { ops, programs, sequence, unreachable, notes, statements, choice, unplanned };
}

/**
 * #959's curved half — THE RULING'S PIPELINE, one op per stage, per `RemainderRegion` and rim.
 *
 * The manager's ruling on the curved regions: the FLAT Z-steps every curved region to its own CL
 * surface, leaving one BAND above it (`bandMm` — the finish's promised scallop/stock-to-leave);
 * where that band is all the finish needs (the shallow ground), the flat's own band step-over is
 * the whole story, and where the surface is steep the flat roughs to the CL instead of trying to
 * follow it. The BALL then runs ONE final level over the region (a single pass at the region's
 * depth, not another Z-staircase) to take the band; a PENCIL pass follows each crease the ball's
 * CL surface leaves; and where a smaller flat is offered (`restFlat`), a REST pass clears by CL
 * difference between the two flats before the ball. Every rim the tree found is broken by the V
 * at the job's stated edge break. The FIGS' goal path uses this same pipeline (`rough` first).
 *
 * These ops are entered into the acceptance spec in the same commit (the manager's rule after
 * E's a46f0358 run): an op that is real is planned through the product path and measured there.
 */
export interface PlanCurvedOptions {
  /** The mesh the tree's regions index into (`ModelPlanInput.geometry`). */
  geometry: FeatureSource;
  /** #982 — extra remainder-style regions the curved pipeline also plans (the no-flat path's
   *  synthetic pocket floors). Absent → the tree's own remainder only. */
  extraRegions?: RemainderRegion[];
  /**
   * #1026 — A MASK PER EXTRA REGION, keyed by its id: the finish cuts only the points the mask
   * admits. A floor strip's mask is the cells the fit found reachable, so the ball never rasters
   * rows up a wall it cannot reach (the raster's Z is the CL, which rides the wall).
   */
  extraRegionMasks?: ReadonlyMap<string, (x: number, y: number) => boolean>;
  /** The real Clipper2 offset, or a test fake — the pocket op's own contract. */
  offset: OffsetFn;
  /**
   * The three tools the curved pipeline uses: the flat roughs, the ball finishes, the V breaks
   * rims. Absent (#869/#966): no rough at all — the ball alone takes each remainder region's
   * whole depth in one pass, and the skin stage (which only a flat can surface-follow) is not
   * planned either. Every existing caller passes a flat; this keeps that path byte-identical.
   */
  flat?: Tool;
  /**
   * #1019 — THE PER-REGION OVERRIDE OF THE ROUGH CUTTER. A region the given `flat` cannot reach
   * (its usable length below the region's depth) is roughed by the BALL instead; `null` means "no
   * flat reaches this one". Absent: `flat` for every region, exactly as before (the
   * tray/organizer path is byte-identical).
   */
  flatFor?: (region: RemainderRegion) => Tool | null;
  /** The ball. Absent is allowed when the tree has no remainder to finish — the region loop refuses by name the moment one needs it. */
  ball?: Tool;
  /**
   * #965 (the review session's ruling, item 3.1) — THE REST BALL: a smaller ball whose stated reach
   * covers the remainder's depth (the vendor's long ⌀1). It runs the finish's machinery a second
   * time over the cells where the main ball's OWN CL still stands above the design by more than the
   * band, at its own radius' footprint — the sequence's rest rule, no new op.
   */
  restBall?: Tool;
  /** The V. Absent is allowed when the job states no edge break — the rim stage is then not planned at
   * all (the property specs' house holds no V and asks for none). */
  vbit?: Tool;
  /** An optional smaller flat for the rest pass by CL difference. */
  restFlat?: Tool;
  /** #982 — the finish cutter when the set holds no ball: the smallest flat that reaches.
   *  Absent with `ball` absent → the primary flat. */
  finishFlat?: Tool;
  /** #988 — the setup's depth band, mm below the stock top (see `PlanPocketsOptions`): every
   *  region's zBottom clamps to −band and every CL surface is floored there. Absent → whole depth. */
  depthBandMm?: number;
  stepDownMm: number;
  /** The ROUGH's stock-to-leave band, mm — what the flat leaves standing for the ball. */
  bandMm: number;
  /**
   * The BALL's promised cusp, mm (#964 finding). Defaults to `bandMm` — the old conflation — but
   * F's coverage line counts anything standing more than 0.1 mm above the goal as leftover, so a
   * finish leaving the rough's 0.3 mm band as its own scallop reads as an uncovered surface even
   * where every cell was swept. `planModelCam` passes the job's finish tolerance here; the rough's
   * band stays its own number.
   */
  finishScallopMm?: number;
  /**
   * #960 — THE FLAT/BALL THRESHOLD, degrees. A parameter while the picture decides the value
   * (equal-cusp 1.9° vs vendor-like 7.1°); the constant is shared with C's #959 skin pass.
   */
  flatFinishMaxSlopeDeg?: number;
  /** The rings' spacing; absent → the flat's own radius. */
  stepOverMm?: number;
  /** `flat`'s own feed/plunge — kept as the fallback every tool used before the review's finding
   * below named it: the ball and the V each cut at a DIFFERENT diameter and want their own
   * catalogue row, not the flat's. */
  feeds: { feedMmPerMin: number; plungeFeedMmPerMin: number };
  rapid: RapidEstimate;
  /** `flat`'s own spindle RPM — see {@link feeds}. */
  spindleRpm: number;
  /**
   * THE REVIEW'S FINDING (item 8): every cutter in the curved pipeline — rough's flat, rest's
   * smaller flat, the ball, the V — was fed and spun at `feeds`/`spindleRpm` ABOVE, which
   * `planModelCam` resolves for the PRIMARY FLAT ONLY. A ball nose and a V cut at their own
   * diameters, and the house catalogue has their own rows; absent, the resolver falls back to
   * `feeds`/`spindleRpm` here, so every existing caller that never passes it keeps the old
   * (flat-wide) numbers unchanged.
   */
  cutParamsFor?: (tool: Tool) => CutParams;
  air: boolean;
  safeZMm: number;
  hopZMm: number;
  /** The job's own edge break — the chamfer's depth (A's R3). */
  edgeBreak: EdgeBreakSpec;
  toolNumberFor: (tool: Tool) => number;
  startFrom?: readonly [number, number];
  /** #959 ruling: `'on'` puts the skin back on the facing stage; absent/`'off'` gives it to `skin`. */
  facing?: 'off' | 'on';
  /** The shared flat/ball slope parameter (#959); absent → `FLAT_SURFACE_MAX_SLOPE_DEG`'s provisional value. */
  flatSurfaceMaxSlopeDeg?: number;
}

export interface PlanCurvedResult {
  ops: PlannedOp[];
  /** Statements the plan owes the operator: nothing here is silent. */
  notes: string[];
  /** #992 — `notes`, typed: one statement per cause with its code, severity and count. */
  statements: PlanStatement[];
  /** `SetupPlan.clGrid`'s entries — every CL surface this pipeline sampled, one per cutter that built one. */
  clGrid: { cutterKey: string; toleranceMm: number; minSpacingMm: number; maxSpacingMm: number }[];
  /** #959 item 5 — every stage that threw, per region/rim, and the stages a failed rough skipped. */
  unplanned: SequenceStepFailure[];
}

function regionRefOf(id: string, kind: RegionKind, footprint: Polygons, topZ: number, bottomZ: number): RegionRef {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of footprint) {
    for (const [x, y] of ring) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    id,
    kind,
    bounds: { min: [minX, minY], max: [maxX, maxY] },
    topZ,
    bottomZ,
    obstacles: [],
    regionClearanceZ: Math.max(0, topZ) + 5,
  };
}

export function planCurvedForTree(tree: FeatureTree, opts: PlanCurvedOptions): PlanCurvedResult {
  const ops: PlannedOp[] = [];
  const notes: string[] = [];
  // #992 — the SAME facts, typed (codes, severities, counts), for the seam to route.
  const statements: PlanStatement[] = [];
  // THE CURVED PROPERTY SEEDS FOUND THIS: some stages legitimately have nothing to cut (the pencil
  // on a surface with no creases, a rough whose mask is empty), and an op that emitted no moves was
  // still pushed — then posted as a program `postZ1` refuses ("no operation with any moves").
  // An op with no moves is not a program: it is dropped here WITH A NOTE, so the plan stays honest
  // rather than posting an empty file. A stage that SHOULD have cut and did not still shows up as
  // a coverage failure at the goal check — the drop does not hide it.
  // #962 — THE OPERATOR SEES ONE STATEMENT PER CAUSE, NOT A LINE PER REGION (the standing rule
  // that warnings must discriminate): an empty stage and a finish's own slope wording are
  // accumulated per kind and stated once, with a count and the deepest ground among the regions.
  const emptyStages = new Map<PlannedOp['kind'], { count: number; deepestMm: number }>();
  const finishKinds = new Map<string, { count: number; minSlope: number; maxSlope: number }>();
  const pushStage = (kind: PlannedOp['kind'], ref: RegionRef, outcome: OpOutcome): void => {
    if (outcome.ir.operations.some((operation) => operation.moves.length > 0)) {
      ops.push({ kind, region: ref, outcome });
      return;
    }
    const entry = emptyStages.get(kind) ?? { count: 0, deepestMm: 0 };
    entry.count++;
    entry.deepestMm = Math.max(entry.deepestMm, Math.abs(ref.topZ - ref.bottomZ));
    emptyStages.set(kind, entry);
  };
  // #959 item 5 — A THROWING STAGE DOES NOT SINK THE PLAN: each stage (its CL surface included) is
  // caught per region/rim and stated in `unplanned` in `sequence.ts`'s step-failure shape; the
  // other stages and regions still plan. Returns whether the stage planned.
  const unplanned: SequenceStepFailure[] = [];
  const attempt = (kind: PlannedOp['kind'], cutter: Tool, ref: RegionRef, plan: () => OpOutcome): boolean => {
    try {
      pushStage(kind, ref, plan());
      return true;
    } catch (err) {
      unplanned.push({ kind, cutterKey: cutterKeyOf(cutter), regionIds: [ref.id], reason: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };
  // #962 — ONE bins build for the whole plan's top-surface queries (the rim filter, the 4a mask
  // and every op's material field share it), and THE DESIGN'S TOP at (x, y) in this plan's datum:
  // the answer the material fields need past their own sampled reach, where a wall or land beside
  // a region can stand HIGHER than the region's own top. The mesh's top where it answers; null
  // where it is silent (the ops then fall back to the stock top, 0 in this datum).
  let surfaceBins: TriangleBins | null = null;
  const binsForMask = (): TriangleBins => (surfaceBins ??= buildTriangleBins(opts.geometry.triangles));
  const designTopAt = (x: number, y: number): number | null => topSurfaceAt(binsForMask(), x, y);
  const clGrid: PlanCurvedResult['clGrid'] = [];
  const noteGrid = (cutter: Tool, surface: ReturnType<typeof clSurface>): void => {
    const key = cutterKeyOf(cutter);
    if (clGrid.some((entry) => entry.cutterKey === key)) return;
    clGrid.push({
      cutterKey: key,
      toleranceMm: surface.toleranceMm,
      minSpacingMm: surface.minSpacingMm,
      maxSpacingMm: surface.maxSpacingMm,
    });
  };
  // #1018 — ONE DATUM NOW, not shimmed here: `region.zTop`/`zBottom` and every `clSurface` CL
  // height already come from `tree`/`opts.geometry`, both built from the door-shifted mesh
  // (`shiftToStockTop`, in `planModelCam`'s own setup loop) — stock-top-relative from the start,
  // the same datum IR Z 0 (the STOCK top) needs for the post's `probed-top-face` convention and
  // safeZ/hopZ. Was shimmed per-value here (a per-call subtraction of this setup's own stock top)
  // until the door made the shift unconditional and the shim redundant (the three real bugs that
  // class cost — #1003, #1013, #1014 — are the twin-guard's own header).
  // #988 — THE SETUP'S DEPTH BAND over the CL surface: a query below −band answers the band, so
  // rows, levels, the finish and the dip follows never descend past it. The regions' own zBottom
  // is clamped below too, so `depthPasses` stops there as well. Absent → the surface unchanged.
  const bandFloorZ = opts.depthBandMm === undefined ? null : -opts.depthBandMm;
  const floorSurface = (surface: ReturnType<typeof clSurface>): ReturnType<typeof clSurface> =>
    bandFloorZ === null
      ? surface
      : {
          ...surface,
          dropCutter: (x: number, y: number) => {
            const z = surface.dropCutter(x, y);
            return z === null ? null : Math.max(z, bandFloorZ);
          },
        };
  // #869/#966 — NO ROUGH AT ALL is a real state (ball alone): the sampling pitch that would have
  // come from the flat's own radius falls back to the ball's, so `clSurface`'s own sampling still
  // has a sensible step when there is no flat to size it against.
  const stepOverSizer = opts.flat ?? opts.ball;
  const cuts: CutParams = {
    rpm: opts.spindleRpm,
    feed: opts.feeds.feedMmPerMin,
    plungeFeed: opts.feeds.plungeFeedMmPerMin,
    stepDown: opts.stepDownMm,
    stepOver: opts.stepOverMm ?? (stepOverSizer === undefined ? 1 : cuttingDiameter(stepOverSizer) ?? 1) / 2,
    peck: 0,
    air: opts.air,
  };
  // THE REVIEW'S FINDING (item 8): every one of these calls used `cuts` — the FLAT's own resolved
  // numbers — for the ball and the V too. `cutParamsFor`, when the caller supplies it, resolves
  // each tool's OWN catalogue row; absent, this falls back to exactly `cuts`'s own shape (the flat
  // feeding every tool, unchanged for every existing caller that never passes it).
  const paramsFor = (tool: Tool): CutParams =>
    opts.cutParamsFor?.(tool) ?? {
      rpm: opts.spindleRpm,
      feed: opts.feeds.feedMmPerMin,
      plungeFeed: opts.feeds.plungeFeedMmPerMin,
      stepDown: opts.stepDownMm,
      stepOver: opts.stepOverMm ?? (cuttingDiameter(tool) ?? 1) / 2,
      peck: 0,
      air: opts.air,
    };
  const feedsOf = (p: CutParams): { feedMmPerMin: number; plungeFeedMmPerMin: number } => ({
    feedMmPerMin: p.feed,
    plungeFeedMmPerMin: p.plungeFeed,
  });

  for (const region of [...tree.remainder, ...(opts.extraRegions ?? [])]) {
    const ball = opts.ball;
    // #982 (the review session's ruling) — NO BALL IN THE SET: the flat finishes the whole curved
    // remainder as a flat-raster, the creases via the rest with the smallest flat. Never a throw.
    const finishCutter = ball ?? opts.finishFlat ?? opts.flat;
    if (finishCutter === undefined) {
      throw new Error(
        `cam/model/plan: the remainder region "${region.id}" needs a cutter to finish and the call states no ball, no finish flat and no flat`,
      );
    }
    // #1003 — THE STOCK BOTTOM IS THE FLOOR HERE TOO: a goal taller than its stock must not finish
    // below the blank. #1013 — the depth band composes with it; the shallower of the two wins.
    // #1018 — `tree.frame.stockBottom` is shifted by the door the same way `region.zBottom`
    // already is (both stock-top-relative from construction now), so the clamp is a plain max —
    // the class of bug E's review of b74f653c6 found (comparing a rebased value against an
    // absolute one, dropping a flipped setup's rough/finish to nothing) cannot recur here.
    const planFloorZ = tree.frame.stockBottom;
    const base = {
      ...region,
      zTop: region.zTop,
      zBottom: Math.max(
        region.zBottom,
        bandFloorZ === null ? Number.NEGATIVE_INFINITY : bandFloorZ,
        planFloorZ === undefined ? Number.NEGATIVE_INFINITY : planFloorZ,
      ),
    };
    const ref = regionRefOf(region.id, 'curved', base.footprint, base.zTop, base.zBottom);
    // THE REVIEW'S SAFETY FINDING: the finish's outer footprint is grown by the ball's radius, and
    // nothing roughed that ring — the ball would take a full-width, full-depth bite of stock that
    // no rough had touched. The flat roughs the SAME grown region first (its own drop-cutter rests
    // against the part's flank over exactly that ring), leaving the band the ball is allowed to
    // take; both stages then see one region.
    //
    // The outer-surface test is the footprint's LARGEST ring against the contour's own: the
    // figure's remainder is an ANNULUS (two rings, outer ring = the silhouette), a summed area or a
    // single-ring count both rejected it and its coverage fell back to 87.77 %.
    const finishRadius0 = (cuttingDiameter(finishCutter) ?? 0) / 2;
    const outerMost = (polys: Polygons): number => Math.max(0, ...polys.map(ringAreaOf));
    const contourRing = outerMost(tree.contour.outline);
    const isOuterSurface =
      finishRadius0 > 0 && contourRing > 0 && Math.abs(outerMost(region.footprint) - contourRing) <= 0.01 * contourRing;
    const grownFootprint = isOuterSurface ? opts.offset(region.footprint, finishRadius0) : [];
    const roughRegion = grownFootprint.length > 0 ? { ...base, footprint: grownFootprint } : base;
    const roughRef = roughRegion === base
      ? ref
      : regionRefOf(region.id, 'curved', roughRegion.footprint, base.zTop, base.zBottom);
    // 1. THE FLAT Z-steps the region to its own CL, leaving the band — #869/#966: absent (ball
    // alone, no rough tool chosen for this goal), there is nothing to pre-clear and no band to
    // leave; the ball takes the region's own full depth in one pass below (step 3's `depth`
    // already computes that when there is no rough to leave a thinner one).
    //
    // #959 item 5: the rough is this region's PRIMARY — a rest, finish or pencil on stock it never
    // cleared would take a full-depth bite — so when it throws, the region's later stages are
    // stated as skipped, not planned.
    // #1019 — the per-region reach: a region the stated flat cannot reach is the BALL's rough
    // (null → undefined here), never sent too deep and never turning the whole side into a ball.
    const flat = opts.flatFor !== undefined ? (opts.flatFor(region) ?? undefined) : opts.flat;
    let prevCl: ReturnType<typeof clSurface> | undefined;
    const restClSink: { surface?: ReturnType<typeof clSurface> } = {};
    if (flat !== undefined) {
      const flatCl: { surface?: ReturnType<typeof clSurface> } = {};
      const roughed = attempt('rough', flat, ref, () => {
        const clFlat = floorSurface(clSurface(opts.geometry, roughRegion, flat, cuts.stepOver));
        flatCl.surface = clFlat;
        noteGrid(flat, clFlat);
        return rough({
          cutter: flat,
          region: roughRegion,
          regionRef: roughRef,
          clSurface: clFlat,
          // #990 — this rough's own row: `flat` (the goal's own `curvedRoughTool`) can be a
          // different diameter than `primary`, which `opts.stepDownMm` is sized for.
          stepDownMm: paramsFor(flat).stepDown,
          stockToLeaveMm: opts.bandMm,
          // #869/#966 — `opts.stepOverMm` is sized for `primary` (the pockets' own flat, the plan-
          // level default); `flat` (this goal's own `curvedRoughTool`) can be a SMALLER tool, and
          // handing it a step-over bigger than its own radius is exactly the defect the rest
          // stage's own `Math.min` guard (below, the "rest flat is SMALLER than the primary" note)
          // already exists to prevent — `pocketLoops` refuses it by name ('step-over exceeds the
          // tool radius'). Same guard, same reason, here.
          stepOverMm: opts.stepOverMm === undefined
            ? undefined
            : Math.min(opts.stepOverMm, (cuttingDiameter(flat) ?? 0) / 2),
          feeds: feedsOf(paramsFor(flat)),
          offset: opts.offset,
          // #982 — the ball-as-rough fallback (no flat in the set): every cut point must lie
          // inside the region's own footprint, and the skim's standing field must say so too.
          ...(opts.ball !== undefined && opts.ball === flat ? { cutPointInRegion: true } : {}),
          safeZMm: opts.safeZMm,
          hopZMm: opts.hopZMm,
          toolNumber: opts.toolNumberFor(flat),
          spindleRpm: paramsFor(flat).rpm,
          air: opts.air,
          rapid: opts.rapid,
          materialTopAt: designTopAt,
          stockTopZMm: 0,
          ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
        });
      });
      prevCl = flatCl.surface;
      if (!roughed || prevCl === undefined) {
        const skipped: [PlannedOp['kind'], Tool][] = [
          ...(opts.restFlat === undefined ? [] : [['rest', opts.restFlat] as [PlannedOp['kind'], Tool]]),
          ['finish', finishCutter] as [PlannedOp['kind'], Tool],
          ...(ball === undefined ? [] : [['pencil', ball] as [PlannedOp['kind'], Tool]]),
        ];
        for (const [kind, cutter] of skipped) {
          unplanned.push({ kind, cutterKey: cutterKeyOf(cutter), regionIds: [region.id], reason: `not planned: the rough of "${region.id}" failed` });
        }
        continue;
      }
    }

    // 2. REST BY CL DIFFERENCE, when the caller offers a smaller flat: the band the previous
    //    cutter left standing, where the smaller one can reach. Never offered without a rough —
    //    there is nothing for a rest to clean up.
    const restFlat = flat === undefined ? undefined : opts.restFlat;
    if (restFlat !== undefined && prevCl !== undefined) {
      // B's review of `0461df01`: the rest stage was left on the MESH-ABSOLUTE region and an
      // unshifted surface — `depthPasses` reads `opts.region.zTop/zBottom`, so at stockTop != 0 the
      // rebased levels sat above every mesh-absolute CL value and the mask came out EMPTY (a rest
      // pass silently missing, not merely off-datum). Both go through the plan's one datum here:
      // the region is `base`, the surface is shifted like the flat's.
      attempt('rest', restFlat, ref, () => {
        const restCl = floorSurface(clSurface(opts.geometry, base, restFlat, cuts.stepOver));
        restClSink.surface = restCl;
        noteGrid(restFlat, restCl);
        return rest({
          cutter: restFlat,
          region: base,
          regionRef: ref,
          prevClSurface: prevCl,
          clSurface: restCl,
          // #990 — the rest flat's own row, not `primary`'s (or `flat`'s): it is SMALLER than
          // both by construction, so its own feeds-band step-down is finer too.
          stepDownMm: paramsFor(restFlat).stepDown,
          stockToLeaveMm: opts.bandMm,
          // The rest flat is SMALLER than the primary: the plan-level step-over is the primary's
          // (half a ⌀6 is 3 mm), and handing that to a ⌀3.175 rest is more than its own radius —
          // `pocketLoops` refuses it by name ('step-over 3 mm exceeds the 1.5875 mm tool radius').
          // The rest takes the smaller of the stated step-over and its own radius.
          stepOverMm: opts.stepOverMm === undefined
            ? undefined
            : Math.min(opts.stepOverMm, (cuttingDiameter(restFlat) ?? 0) / 2),
          feeds: feedsOf(paramsFor(restFlat)),
          offset: opts.offset,
          safeZMm: opts.safeZMm,
          hopZMm: opts.hopZMm,
          toolNumber: opts.toolNumberFor(restFlat),
          spindleRpm: paramsFor(restFlat).rpm,
          air: opts.air,
          rapid: opts.rapid,
          ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
        });
      });
    }

    // ITEM 4a — THE FINISH'S MASK: leftover = the flat's CL − the design > band, dilated by the
    // ball's footprint (its centre just outside the leftover still cuts into it, and just outside
    // the part still finishes the skirt its flank holds).
    //
    // #970 (the manager's ruling, #965's bisect) — THE EXACT PER-POINT RULE IS THE MASK'S RULE.
    // cd5ec056 replaced these queries with a leftover grid read by `Math.round`, which drops the
    // leftover between its samples: on the panther's 74–89° flanks the finish stopped running
    // (coverage 73.17 → 49.09 %), and MASK-EQUIV showed the grid cannot be made conservative at
    // its pitch (9,483 of 23,058 points dropped at 0.5 mm, 0 over-included; a 0.1 mm grid is still
    // 2.5 points short). Correct cuts before speed: the mask asks the exact CL at the point and at
    // its eight footprint neighbours, as it did before cd5ec056. The skimming grid that change
    // also made for `skin()` is untouched — that one carries its own read (#970's 6b35d6e9).
    const finishBand = opts.finishScallopMm ?? opts.bandMm;
    const flatCl = (x: number, y: number): number | null => (prevCl === undefined ? null : prevCl.dropCutter(x, y));
    const restCl = (x: number, y: number): number | null => restClSink.surface?.dropCutter(x, y) ?? null;
    // #1014 — THE LEFTOVER IS WHAT THE ROUGH LEFT, NOT ITS CUTTER'S IDEAL CL. The old read took
    // the rough cutter's CL as the leftover; with a flat rough that over-estimates by R·tan θ and
    // the finish ran, but under the #982 no-flat fallback the rough cutter is the BALL, whose CL
    // hugs the design on a shallow slope (R(1/cos θ − 1) = 0.0025 mm at 5.7°) — so the mask called
    // the slope finished while the rough's 0.3 mm terraces stood 0.3–0.6 mm proud. The rough's own
    // two outputs are stated in ONE helper beside `depthPasses` (`roughLeftAbove`): the CL where
    // its band skim could cut, else the first of its Z-levels at or above `cl + band` (the stock
    // top when none) — the level the mask itself admits a cell to. The rest pass's CL stays min'd
    // in: a smaller FLAT's CL is an honest over-estimate of what a flat leaves, the same premise
    // that holds for a flat rough.
    // #1018 — ONE DATUM NOW: `flatCl`/`restCl` and `base.zTop/zBottom` are BOTH stock-top-relative
    // from the door, so `roughLeftAbove` takes the CL straight through — no shift into a second
    // datum and back. (E's review of e5b215423 found this exact mismatch when `flatAbs` answered
    // mesh-absolute while `base.zTop/zBottom` were already rebased; #1018 removes the second datum
    // that mismatch needed in the first place.)
    const roughStepDown = flat === undefined ? 0 : paramsFor(flat).stepDown;
    const roughLeft = (x: number, y: number): number | null => {
      const f = flatCl(x, y);
      const r = restCl(x, y);
      if (f === null) return r;
      const left = roughLeftAbove(f, base.zTop, base.zBottom, roughStepDown, opts.bandMm);
      return r === null ? left : Math.min(left, r);
    };
    const leftoverAbove = (x: number, y: number): boolean => {
      const left = roughLeft(x, y);
      if (left === null) return false;
      const design = topSurfaceAt(binsForMask(), x, y);
      if (design === null) return false;
      return left - design > finishBand;
    };
    const ballRadiusForMask = (cuttingDiameter(finishCutter) ?? 0) / 2;
    const maskRing: [number, number][] = [];
    for (let d = 0; d < 8; d++) {
      const a = (d * Math.PI) / 4;
      maskRing.push([Math.cos(a) * ballRadiusForMask, Math.sin(a) * ballRadiusForMask]);
    }
    // #869/#966 — NO ROUGH, NO MASK: with no flat ahead of it the ball has nothing to compare
    // against, and nothing to mask against either — it takes the whole region, as `finish()`'s own
    // `maskCells === undefined` case already means ("the plan admits every point of every row").
    const extraMask = opts.extraRegionMasks?.get(region.id);
    const maskCells = extraMask ?? (flat === undefined ? undefined : (x: number, y: number): boolean => maskCellsExact(leftoverAbove, maskRing, x, y));

    // 3. THE BALL'S ONE FINAL LEVEL: a single pass at the region's depth takes the band.
    //
    // THE CURVED PROPERTY SEEDS FOUND THIS: the ball was dropped onto `finishCl` — the FLAT's CL
    // surface (or the rest flat's) — so it rode the rough's own clearance instead of the design.
    // On the sloped seed a flat ⌀6 held tangent to an 11° ramp stands tan(11°)·3 ≈ 0.58 mm above
    // the surface at its downhill edge, and the ball followed that: 0.58 mm of material left over
    // the whole pocket. The finish and the pencil follow the BALL'S OWN CL surface; the flat's
    // stays the rough's (and the rest pass's) reference, which is what that CL difference is.
    // THE FIGURE SEEDS FOUND THIS: the raster confined the ball's CENTRE to the region's own
    // footprint, so a convex flank — the figure's bell, whose widest point is at its base — stood
    // in its own shadow: any ball centred inside the part had to rest on the higher shoulder
    // within its radius, and the skirt below read as 12.2 % left standing. A ball cuts a shoulder
    // from OUTSIDE it, so the finish runs on the same region the rough just cleared (grown, when
    // the region is the part's own outer surface). The CL surface is sampled on it too — dropping
    // a row against a surface that does not reach its own endpoints is what `dropRow` refuses.
    // The ball's CL surface is shared by the finish and the pencil; built inside whichever stage
    // reaches it first, so its own failure is that stage's.
    let clBallCache: ReturnType<typeof clSurface> | undefined;
    const clBall = (): ReturnType<typeof clSurface> => {
      if (clBallCache === undefined) {
        clBallCache = floorSurface(clSurface(opts.geometry, roughRegion, finishCutter, cuts.stepOver));
        noteGrid(finishCutter, clBallCache);
      }
      return clBallCache;
    };
    // #869/#966, SAFETY (the review's finding, item 1): "the ball alone" never meant one pass at
    // the region's own full depth into untouched stock — that is the exact full-depth bite this
    // file's own #959 item 5 and "THE REVIEW'S SAFETY FINDING" (above) exist to prevent. WITH a
    // rough ahead, one level is enough (it already stepped down to within the band). With NONE,
    // the ball must step down on its OWN row, same as a rough would, over as many levels as the
    // region's depth needs.
    const depth = flat === undefined ? paramsFor(ball ?? finishCutter).stepDown : Math.max(opts.stepDownMm, base.zTop - base.zBottom);
    // #960 — FLAT OR BALL BY THE REGION'S OWN SLOPE, with the threshold stated on the plan; the
    // constant is a parameter (shared with C's #959 skin pass) while the picture decides 1.9° vs 7.1°.
    // #982 — with no ball the slope limit is lifted: the flat raster covers the WHOLE remainder.
    const finishKind: FinishKind = ball === undefined
      ? 'flat-raster'
      : finishKindFor(roughRegion, opts.geometry.triangles, opts.flatFinishMaxSlopeDeg ?? FLAT_SURFACE_MAX_SLOPE_DEG);
    {
      const entry = finishKinds.get(finishKind) ?? { count: 0, minSlope: Infinity, maxSlope: -Infinity };
      entry.count++;
      entry.minSlope = Math.min(entry.minSlope, roughRegion.slopeDeg[0]);
      entry.maxSlope = Math.max(entry.maxSlope, roughRegion.slopeDeg[1]);
      finishKinds.set(finishKind, entry);
    }
    attempt('finish', finishCutter, ref, () => finish({
      cutter: finishCutter,
      region: roughRegion,
      regionRef: roughRef,
      clSurface: clBall(),
      kind: finishKind,
      mesh: opts.geometry.triangles,
      scallopMm: opts.finishScallopMm ?? DEFAULT_FINISH_SCALLOP_MM,
      ...(ball === undefined ? { flatFallback: true } : {}),
      maskCells,
      // #962 — the material field's answers past the region's own reach (the linker's disc and the
      // down-leg floor reach up to a cutter radius outside it): the goal/mesh top there, which is
      // the honest bound a wall or land beside a low region demands, and the stock top where the
      // mesh is silent. The region's own zTop is NOT that bound — a neighbouring wall can out-top
      // it, and a rapid floored at zTop would run into the wall. In this datum (every Z rebased by
      // −stockTop) the stock top is 0.
      materialTopAt: designTopAt,
      stockTopZMm: 0,
      stepDownMm: depth,
      feeds: feedsOf(paramsFor(finishCutter)),
      safeZMm: opts.safeZMm,
      hopZMm: opts.hopZMm,
      toolNumber: opts.toolNumberFor(finishCutter),
      spindleRpm: paramsFor(finishCutter).rpm,
      air: opts.air,
      rapid: opts.rapid,
    }));

    let restBallCl: ReturnType<typeof clSurface> | undefined;
    // 3b. THE REST BALL (#965, the review session's ruling item 3.1): where the ball's OWN CL still
    // stands above the design by more than the band — its fillet at a wall foot, the slots its
    // radius cannot enter — a smaller ball whose stated reach covers this region runs the same
    // finish machinery at its own CL, restricted to that mask and to its own radius' footprint.
    // The sequence's rest rule, no new op; the reach is the one that qualified it.
    if (opts.restBall !== undefined) {
      const restBallTool = opts.restBall;
      const ballMaskRadiusMm = (cuttingDiameter(restBallTool) ?? 0) / 2;
      const restRing: [number, number][] = [];
      for (let d = 0; d < 8; d++) {
        const a = (d * Math.PI) / 4;
        restRing.push([Math.cos(a) * ballMaskRadiusMm, Math.sin(a) * ballMaskRadiusMm]);
      }
      // #1018 — the ball's own CL and the design's top are both stock-top-relative from the door;
      // no shift needed to compare them.
      const afterBallLeftover = (x: number, y: number): boolean => {
        const b = clBall().dropCutter(x, y);
        if (b === null) return false;
        const design = topSurfaceAt(binsForMask(), x, y);
        if (design === null) return false;
        return b - design > finishBand;
      };
      attempt('rest', restBallTool, ref, () => finish({
        cutter: restBallTool,
        region: roughRegion,
        regionRef: roughRef,
        clSurface: (restBallCl = clSurface(opts.geometry, roughRegion, restBallTool, cuts.stepOver)),
        kind: finishKind,
        mesh: opts.geometry.triangles,
        scallopMm: opts.finishScallopMm ?? DEFAULT_FINISH_SCALLOP_MM,
        maskCells: (x, y) => maskCellsExact(afterBallLeftover, restRing, x, y),
        materialTopAt: designTopAt,
        stockTopZMm: 0,
        stepDownMm: depth,
        feeds: feedsOf(paramsFor(restBallTool)),
        safeZMm: opts.safeZMm,
        hopZMm: opts.hopZMm,
        toolNumber: opts.toolNumberFor(restBallTool),
        spindleRpm: paramsFor(restBallTool).rpm,
        air: opts.air,
        rapid: opts.rapid,
      }));
    }

    // 3c. THE CREASE PASS (#965, the review session's step 2; the vendor's own figure method): a
    // conical engraver riding the creases with its OWN CL, after the rest ball. Admitted only
    // where `reach()`'s own rule allows — the V's flank angle against the region's steepest slope
    // (clsurface.ts `reach()`); a region the V cannot descend is STATED by name in `unplanned`,
    // never silently skipped.
    if (opts.vbit !== undefined && (opts.vbit.shape === 'chamfer' || opts.vbit.shape === 'engraving')) {
      const vTool = opts.vbit;
      // C's review of the crease pass (2026-11-05): PRE-GATE on a cheap valley test over the
      // PREVIOUS cutter's own CL — a region with no crease cell gets no pencil grid and no line at
      // all. The gate samples at 0.5 mm, 25x coarser than the pencil: it exists to skip regions,
      // not to judge cells.
      // shortcut: the gate is a PROXY — it reads the PREVIOUS cutter's CL (the ball, or the rest
      // ball), so a crease too narrow for that cutter to register, or finer than the 0.5 mm gate
      // grid, is not pre-detected and its region is skipped (the #983 wall-foot class); upgrade
      // the gate pitch if a job's creases need it.
      const vPitchGate = Math.max(0.5, (cuttingDiameter(vTool) ?? 0) / 4);
      const prevClGate = restBallCl ?? clBall();
      if (hasValley(prevClGate, { min: roughRef.bounds.min, max: roughRef.bounds.max }, vPitchGate)) {
      const prevCl = restBallCl ?? clBall();
      const vPitch = Math.min(0.5, Math.max(0.1, (cuttingDiameter(vTool) ?? 0) / 4));
      let creaseAdmitted = 0;
      let creaseRefused = 0;
      attempt('pencil', vTool, ref, () => {
        // The V's own CL and the previous (rest ball's) CL: the leftover depth at a crease is the
        // material between them — the number the crease rule's width test is stated at.
        //
        // #961 (the gate on 961-wiring-r) — BUILT INSIDE THE `attempt`: a V whose cone the house
        // does not state (the organizer's catalogue row) has no drop-cutter profile and
        // `clSurface` throws by name; the crease must be STATED in `unplanned` with that reason,
        // never refuse the whole job. The throw used to sit above the attempt and escaped.
        const vCl = clSurface(opts.geometry, roughRegion, vTool, cuts.stepOver);
        const out = pencil({
          cutter: vTool,
          region: roughRegion,
          regionRef: roughRef,
          clSurface: vCl,
          gridPitchMm: vPitch,
          admitCrease: (i, j, z, leftSlopeDeg, rightSlopeDeg) => {
            const x = roughRef.bounds.min[0] + i * vPitch;
            const y = roughRef.bounds.min[1] + j * vPitch;
            const prev = prevCl.dropCutter(x, y);
            const depth = prev === null ? 0 : Math.max(0, prev - z);
            const fits = creaseFits(vTool, { leftSlopeDeg, rightSlopeDeg, depthMm: depth });
            if (fits.reachable) creaseAdmitted++;
            else creaseRefused++;
            return fits.reachable;
          },
          feeds: feedsOf(paramsFor(vTool)),
          safeZMm: opts.safeZMm,
          hopZMm: opts.hopZMm,
          toolNumber: opts.toolNumberFor(vTool),
          spindleRpm: paramsFor(vTool).rpm,
          air: opts.air,
          rapid: opts.rapid,
        });
        const emitted = out.ir.operations.some((operation) => operation.moves.length > 0);
        if (!emitted) {
          // Stated, never a silent skip: no crease on this region passed the admission.
          unplanned.push({
            kind: 'pencil',
            cutterKey: cutterKeyOf(vTool),
            regionIds: [ref.id],
            reason: `the crease pass was admitted at no crease this region (${creaseAdmitted} admitted, ${creaseRefused} refused by the crease rule) — nothing emitted`,
          });
        }
        return out;
      });
      }
    }

    // 4. PENCIL along the creases the ball's own CL surface leaves — no ball, no pencil: the
    // creases are the rest rule's job (the smallest flat, above).
    if (ball !== undefined) attempt('pencil', ball, ref, () => pencil({
      cutter: ball,
      region,
      regionRef: ref,
      clSurface: clBall(),
      feeds: feedsOf(paramsFor(ball)),
      safeZMm: opts.safeZMm,
      hopZMm: opts.hopZMm,
      toolNumber: opts.toolNumberFor(ball),
      spindleRpm: paramsFor(ball).rpm,
      air: opts.air,
      rapid: opts.rapid,
    }));
  }

  // THE SKIN PASS (#959, 2026-11-05 ruling): the stock stands above the part top and the job asks
  // for no facing — the FLAT takes the skin, surface-following (C6's Makera T1 shape), capped at
  // its own step-down and gated by the shared slope parameter. Facing `'on'` keeps that stage
  // instead (the operator option).
  const skinMm = -tree.top.z;
  if (skinMm > 1e-6 && (opts.facing ?? 'off') !== 'on' && opts.flat === undefined) {
    // #869/#966 — NO FLAT, NO SKIN: the skin is a flat's own surface-following pass (`skin()`
    // only a flat runs); a ball-alone goal states the skin standing rather than removing it with
    // the wrong tool. `facing: 'on'` is the operator's other route to the same stock.
    const skinText =
      `${String(Math.round(skinMm * 1000) / 1000)} mm of skin stands above the part top — no rough tool is chosen for ` +
      'this goal, so it is left standing rather than cleared with the ball; set a rough tool, or turn facing on, to remove it';
    notes.push(skinText);
    // #992 — the skin is real material left on the part: a decision the operator has to make.
    statements.push({ severity: 'warning', code: 'goal-skin-standing', count: 1, text: skinText });
  } else if (skinMm > 1e-6 && (opts.facing ?? 'off') !== 'on' && opts.flat !== undefined) {
    const flat = opts.flat;
    const flatRadius = (cuttingDiameter(flat) ?? 0) / 2;
    const grownSkin = flatRadius > 0 ? opts.offset(tree.contour.outline, 2 * flatRadius) : [];
    const skinFootprint = grownSkin.length > 0 ? grownSkin : tree.contour.outline;
    const skinRegion: RemainderRegion = {
      id: 'skin', footprint: skinFootprint, area: tree.contour.area, zTop: 0, zBottom: tree.top.z,
      triangles: new Uint32Array(), slopeDeg: [0, 0], slopeMedianDeg: 0, in: 'top',
    };
    const skinRef = regionRefOf('skin', 'curved', skinFootprint, 0, -skinMm);
    // THE SKIN'S DEPTH IS ITS LEVELS, not an exclusion: they stop at the part top, so a pocket's
    // own ground is never touched — but the skin ABOVE every pocket's mouth (which the pocket op,
    // starting at that mouth, never removes) is taken here. The first attempt excluded the pocket
    // footprints and left that skin standing: the tray's coverage fell 0.77 %.
    attempt('skin', flat, skinRef, () => {
      const skinCl = clSurface(opts.geometry, skinRegion, flat, cuts.stepOver);
      return skin({
        cutter: flat,
        regionRef: skinRef,
        outline: tree.contour.outline,
        clSurface: skinCl,
        skinMm,
        // THE CAP IS THE ROW'S OWN STEP-DOWN x THE FACTOR (#959): a parameter, provisional at
        // 1.0 — two passes on the tray's 1.2 mm skin, one on the organizer's 0.8.
        stepDownMm: paramsFor(flat).stepDown * skinStepdownFactor(),
        maxSlopeDeg: opts.flatSurfaceMaxSlopeDeg ?? flatSurfaceMaxSlopeDeg(),
        stepOverMm: opts.stepOverMm,
        feeds: feedsOf(paramsFor(flat)),
        offset: opts.offset,
        safeZMm: opts.safeZMm,
        hopZMm: opts.hopZMm,
        toolNumber: opts.toolNumberFor(flat),
        spindleRpm: paramsFor(flat).rpm,
        air: opts.air,
        rapid: opts.rapid,
        materialTopAt: designTopAt,
        stockTopZMm: 0,
        ...(opts.startFrom === undefined ? {} : { startFrom: opts.startFrom }),
      });
    });
  }

  // 5. EVERY RIM the tree found, broken by the V at the job's stated edge break.
  //
  // THE PROPERTY SPECS FOUND THIS: an edge break of ZERO — every rectilinear card, and the curved
  // seeds that state none — is not a refusal, it is a job that asks for no bevel. `chamfer()`
  // rightly refuses a zero-depth cut (a scratch is not a bevel), so reaching the stage at all
  // threw a refusal at a job the tree said was fine. The stage is skipped WHOLE, and the note says
  // the rims stay sharp rather than leaving the reader to infer it.
  if (opts.edgeBreak.legMm > 0) {
    if (opts.vbit === undefined) {
      throw new Error(
        `cam/model/plan: the job states a ${opts.edgeBreak.legMm} mm edge break but the call states no V cutter for the rim stage`,
      );
    }
    const vbit = opts.vbit;
    // Built ONCE, reused by every rim's query below (#960's own bins, not a fresh brute-force
    // scan per rim — see `topSurfaceAt`'s own header for the perf finding this replaces).
    const rimBins = tree.rims.length > 0 ? buildTriangleBins(opts.geometry.triangles) : null;
    // #992 — a rim the stage declines is stated ONCE PER CAUSE with its count (the #962 rule);
    // the per-rim lines stay in `notes` as the dump's detail.
    const rimSkips = new Map<'covered' | 'open-loop', { count: number; ids: string[] }>();
    // #1012 — the rims whose bevel the V's cone CLAMPED, and the first clamp's own numbers (every
    // rim asks the same edge break and cuts with the same V, so one sample speaks for all).
    const clampedRims: string[] = [];
    let clampedSample: { wanted: number; cut: number } | undefined;
    for (const rim of tree.rims) {
      try {
        // THE MANAGER'S RULING from the tray's 0.5 mm cell: a rim whose air side is COVERED is not
        // broken — see `rimExposedFromAbove` for the measurement that put this here. `rimBins`
        // and `rim.z` are both stock-top-relative from the door (#1018), so the test reads them
        // straight through.
        if (!rimExposedFromAbove(rimBins!, rim)) {
          notes.push(
            `rim "${rim.id}" not broken: covered from above (its air side does not drop by 0.2 mm — the edge lies under the land)`,
          );
          const skip = rimSkips.get('covered') ?? { count: 0, ids: [] };
          skip.count++;
          skip.ids.push(rim.id);
          rimSkips.set('covered', skip);
          continue;
        }
        // #962 — THE ORGANIZER'S 77 mm GROOVE FOUND THIS: `findRims`' edge-chaining can leave a
        // POCKET rim's own loop OPEN (a branch point in the sharp floor|wall graph took the wrong
        // one of several unused edges, per `features/rims.ts`'s `chain()`), and `chamfer()`'s own
        // `closedRing()` does not know the difference — it closes ANY polyline whose ends don't
        // already coincide with one more straight point, a phantom edge across whatever lies
        // between them. That phantom edge is real material to `generateChamfer`: it feeds along
        // it like any other edge of the ring, which is the posted gouge (E's render set, #962) —
        // not a `link()` defect, since `link()` never emits a lateral feed; this is the RING'S
        // OWN trace. A POCKET encloses a cavity, so its rim's own first and last point must be
        // the SAME vertex `chain()` started and ended on — not approximately, exactly, give or
        // take float noise from the mesh itself — so a gap past that noise floor there means the
        // chain never closed, and bridging it is refused. A CONTOUR rim is exempt: the outer
        // silhouette can legitimately run open to the stock's own edge (a shoulder cut to +X,
        // `buildRandomPart`'s own fixture finds this on every synthetic kind, rim-6, 8 mm open,
        // (20, -4)→(20, 4)) — closing that one just retraces its own two points, never a bridge
        // across unrelated ground.
        const first = rim.polyline[0];
        const last = rim.polyline[rim.polyline.length - 1];
        if (rim.of !== 'contour' && first !== undefined && last !== undefined && Math.hypot(first[0] - last[0], first[1] - last[1]) > RIM_CLOSE_TOL_MM) {
          notes.push(
            `rim "${rim.id}" not broken: its own loop is not closed (ends ${Math.hypot(first[0] - last[0], first[1] - last[1]).toFixed(2)} mm apart) — ` +
              `a straight bridge there is not real geometry, so no chamfer is cut rather than gouging across it`,
          );
          const skip = rimSkips.get('open-loop') ?? { count: 0, ids: [] };
          skip.count++;
          skip.ids.push(rim.id);
          rimSkips.set('open-loop', skip);
          continue;
        }
        // #1018 — the rim's own Z already comes off the door-shifted tree: stock-top-relative
        // from the start, no rebase needed here.
        const ref = regionRefOf(rim.id, 'rim', [[...rim.polyline]], rim.z, rim.z);
        const out = chamfer({
          cutter: vbit,
          rim,
          region: ref,
          edgeBreak: opts.edgeBreak,
          offset: opts.offset,
          params: paramsFor(vbit),
          rapid: opts.rapid,
        });
        if (out.clampedLegMm !== undefined) {
          clampedRims.push(rim.id);
          clampedSample ??= out.clampedLegMm;
        }
        pushStage('chamfer', ref, out);
      } catch (err) {
        // #959 item 5: one rim that cannot be broken (its exposure test included) is stated, not fatal.
        unplanned.push({ kind: 'chamfer', cutterKey: cutterKeyOf(vbit), regionIds: [rim.id], reason: err instanceof Error ? err.message : String(err) });
      }
    }
    // #992 — ONE statement per cause, with the count and the rim ids (the per-rim lines above
    // are the dump's detail). The two causes have different remedies, so they are never merged.
    for (const [cause, entry] of rimSkips) {
      const plural = entry.count === 1 ? 'rim' : 'rims';
      statements.push({
        severity: 'warning',
        code: 'goal-rim-unbroken',
        count: entry.count,
        ids: entry.ids,
        text:
          cause === 'covered'
            ? `${entry.count} ${plural} not broken: covered from above (the air side does not drop by 0.2 mm — the edge lies under the land)`
            : `${entry.count} ${plural} not broken: the rim's own loop is not closed, so no chamfer is cut rather than bridging across it`,
      });
    }
    // #1012 — A BEVEL WIDER THAN THE CONE REACHES IS CLAMPED AND SAID. The cut is the cone's own
    // leg (right — a deeper pass would bury the flank), but the operator asked for another width,
    // so the plan states both, in the widths they asked in (`leg = width / tan α`, so
    // `width = leg × tan α` of the SAME V), one statement for every rim the clamp touched.
    if (clampedSample !== undefined) {
      const cone = vCone(vbit);
      const tanHalf = cone?.tanHalf ?? 1;
      const mm = (v: number): string => String(Number(v.toFixed(4)));
      const askedMm = clampedSample.wanted * tanHalf;
      const cutMm = clampedSample.cut * tanHalf;
      const plural = clampedRims.length === 1 ? 'rim asks' : 'rims ask';
      const text =
        `${clampedRims.length} ${plural} for a ${mm(askedMm)} mm chamfer, but “${vbit.name}”’s cone ` +
        `reaches ${mm(cutMm)} mm in one pass — the cut is ${mm(cutMm)} mm wide, ${mm(askedMm - cutMm)} mm short ` +
        'of the design. A wider V-bit, or a second pass, reaches the rest.';
      notes.push(text);
      statements.push({ severity: 'warning', code: 'chamfer-too-wide', count: clampedRims.length, ids: clampedRims, text });
    }
  } else if (tree.rims.length > 0) {
    const text = `the job states no edge break — ${tree.rims.length} rim(s) stay sharp`;
    notes.push(text);
    // #992 — the job asked for no bevel: a fact, not a fault (the operator's own choice).
    statements.push({ severity: 'info', code: 'goal-no-edge-break', count: tree.rims.length, text });
  }

  if (tree.remainder.length === 0) {
    const text = 'no curved remainder regions — the rough/rest/finish/pencil stages have nothing to plan';
    notes.push(text);
    statements.push({ severity: 'sheet', code: 'plan-run', text, count: 1 });
  }
  if (tree.rims.length === 0) {
    const text = 'no rims — the chamfer stage has nothing to plan';
    notes.push(text);
    statements.push({ severity: 'sheet', code: 'plan-run', text, count: 1 });
  }
  {
    // #1019 review (finding 2) — the ruling's own sentence is TRUE only for the regions the flat
    // can reach: a region the flat cannot is the ball's rough (its own line names it), so the note
    // says so rather than claiming a flat Z-step it never planned.
    const ballRoughRegions = opts.flatFor === undefined
      ? 0
      : tree.remainder.filter((r) => {
          const flat = opts.flatFor!(r) ?? undefined;
          return flat !== undefined && flat !== opts.flat;
        }).length;
    const substitution = ballRoughRegions === 0
      ? ''
      : ` (${ballRoughRegions} region${ballRoughRegions === 1 ? ' is' : 's are'} deeper than the flat's own reach and ${ballRoughRegions === 1 ? 'is' : 'are'} the ball's rough, stated with its own numbers)`;
    const text =
      `the curved pipeline follows the ruling: the flat Z-steps each remainder region${substitution} to its CL less ${opts.bandMm} mm, ` +
      `the ball runs ONE final level, the pencil follows the creases${opts.restFlat === undefined ? ', and no rest flat was offered' : ', and a rest flat clears the CL difference first'}`;
    notes.push(text);
    statements.push({ severity: 'sheet', code: 'plan-run', text, count: 1 });
  }
  // #962 — the grouped statements, one per cause (see the accumulators above).
  for (const [kind, entry] of emptyStages) {
    const plural = entry.count === 1 ? 'region' : 'regions';
    const text =
      `${kind}: ${entry.count} ${plural} emitted no moves — nothing for it to cut` +
      (entry.deepestMm > 0 ? `; the deepest ground among them is ${entry.deepestMm.toFixed(1)} mm below the part top` : '');
    notes.push(text);
    statements.push({ severity: 'sheet', code: 'plan-run', count: entry.count, text });
  }
  for (const [finishKind, entry] of finishKinds) {
    // #965 — the card states the scallop it used, never just "constant": the job's own tolerance
    // when it states one, the vendor's 0.027 mm default when it does not.
    // #982 — with no ball the slope limit is lifted and the flat's own cusp rule sets the step;
    // the card states both, so the tradeoff is in outcome terms on the plan.
    const scallopMm = opts.finishScallopMm ?? DEFAULT_FINISH_SCALLOP_MM;
    const words = finishKind === 'flat-raster'
      ? (opts.ball === undefined
          ? `flat's fallback raster (no ball in the set; step ${scallopMm.toFixed(3)} mm cusp / tan of the steepest slope, clamped to the flat's radius/10 to radius)`
          : 'flat-following raster')
      : `ball at a constant ${scallopMm.toFixed(3)} mm scallop`;
    const plural = entry.count === 1 ? 'region' : 'regions';
    const text = `finish: ${entry.count} ${plural} run as a ${words} (slopes ${entry.minSlope.toFixed(1)}–${entry.maxSlope.toFixed(1)}°, flat threshold ${(opts.flatFinishMaxSlopeDeg ?? FLAT_SURFACE_MAX_SLOPE_DEG).toFixed(2)}°)`;
    notes.push(text);
    // #992 — which finish mode ran, and at what scallop: a fact of the run with no action.
    statements.push({ severity: 'info', code: 'goal-finish-mode', count: entry.count, text });
  }
  return { ops, notes, statements, clGrid, unplanned };
}

/**
 * #959/#966's ONE INTERFACE — a whole `FeatureTree` planned and posted through this engine:
 * pockets and through-holes by the costed chain, the curved remainder by the ruling's pipeline,
 * the rims by the V. The programs come back per cutter, concatenated in EXECUTION order.
 *
 * THE FREEING CUT STAYS LAST. `planPocketsForTree` already posts the contour after its own
 * pockets; the curved stages must therefore run BEFORE it, not after — a rest or finish cutting a
 * part the contour has just freed is the defect #959's ruling 1 names. So the pocket result's ops
 * are split around the contour and the tree's order is: pockets, curved, rims, freeing contour.
 */
export interface PlanTreeOptions {
  /** #982 — NULL skips the pocket chain entirely (the no-flat path plans the pocket floors as
   *  the ball's scallop pass through the curved pipeline and states the contour as not planned). */
  pockets: Omit<PlanPocketsOptions, 'offset'> | null;
  /**
   * The curved stages' options MINUS the retract heights. THE REAL TRAY FOUND THIS: the pocket
   * ops and `generateProfile`'s contour both retract at `SAFE_Z`/`HOP_Z` (`ir.ts`) and
   * `concatToolpathIR` refuses two programs that disagree — the whole-tree run threw 5 vs 12 the
   * moment the curved stages took their own. A tree posts ONE program per cutter, so it has ONE
   * program-wide retract; the type says so instead of letting a caller choose a height that
   * cannot concatenate.
   */
  curved: Omit<PlanCurvedOptions, 'offset' | 'safeZMm' | 'hopZMm'>;
  /**
   * #1021 — THE POCKET FLOOR STRIPS, built once the CHAIN IS CHOSEN. A strip the plan's own rest
   * step can enter is the rest's; set membership is not the test (on the ideal run the house is
   * owned ∪ catalogue, and a catalogue flat the chain never runs must not silence a strip). The
   * hook is called with this plan's rest cutters and returns the strips to plan as the ball's own
   * floor passes plus the ones nothing can reach.
   */
  floorStrips?: (restCutters: readonly Tool[], alreadyStated: ReadonlySet<string>) => PlanningFloorStrips;
  offset: OffsetFn;
}

/** #1021 — see {@link PlanTreeOptions.floorStrips}. */
export interface PlanningFloorStrips {
  regions: RemainderRegion[];
  unreachable: { id: string; area: number; fitShare: number }[];
  /** #1026 — a mask per planned strip: the finish cuts only the cells the fit found reachable. */
  masks: ReadonlyMap<string, (x: number, y: number) => boolean>;
  /** #1026 — the areas the fit's own cells give each planned strip, for its statement. */
  planned: {
    id: string;
    nodeId: string;
    reachArea: number;
    stripArea: number;
    staysArea: number;
    standingMm: number;
    allReached: boolean;
    /** The reachable cells' centres — the reach check's own sample set. */
    cells: { x: number; y: number }[];
  }[];
}

export interface PlanTreeResult {
  ops: PlannedOp[];
  /** One program per cutter, in the order the cutters are first posted. */
  programs: Map<string, ToolpathIR>;
  /** `SetupPlan.sequence` — the pocket chain's priced cutters, unchanged from `planPocketsForTree`. */
  sequence: SequencedCutter[];
  /** `SetupPlan.clGrid` — the CL surfaces the curved stages sampled. */
  clGrid: { cutterKey: string; toleranceMm: number; minSpacingMm: number; maxSpacingMm: number }[];
  unreachable: string[];
  notes: string[];
  /** #992 — the pocket and curved planners' statements, in the same order as `notes`. */
  statements: PlanStatement[];
  /** #959 item 5 — the pocket chain's failed steps, then the curved/rim stages'. */
  unplanned: SequenceStepFailure[];
  /** #961 — the pocket chain's picker result, carried through for `SetupPlan.choice`. */
  choice: SequenceChoice;
  /** #1021 — the floor strips this plan built (and the ones nothing can reach), when it asked. */
  floorStrips?: PlanningFloorStrips;
}

/**
 * #962 — THE REGION TOUR: within each cutter's run, order the regions so each one's exit joins the
 * nearest other region's entry (nearest neighbour + 2-opt — the finish's strip tour one level up).
 * E's rapid-class picture: the ⌀6 flat's region-to-region moves criss-crossed the tray (404 against
 * the vendor's 96) and were most of its rapids.
 *
 * THE UNIT IS A REGION: all of that cutter's ops on it, in their planned order — a same-region
 * pair must never be reversed (`sequence.ts`'s own invariant). The ops' paths themselves are
 * fixed, so a 2-opt move swaps the ORDER of regions and never a region's direction; only the two
 * boundary edges change.
 *
 * THE FREEING CUT NEVER MOVES: the contour op stays pinned at the end, exactly where the plan put
 * it — pulling it earlier would un-free the part before the last stage ran.
 */
export function orderOpsForPrograms(ops: readonly PlannedOp[]): PlannedOp[] {
  const sentinels = ops.filter((op) => op.kind === 'contour');
  const movable = ops.filter((op) => op.kind !== 'contour');
  const groups: PlannedOp[][] = [];
  const atByKey = new Map<string, number>();
  for (const op of movable) {
    let at = atByKey.get(op.outcome.cutter);
    if (at === undefined) {
      at = groups.length;
      atByKey.set(op.outcome.cutter, at);
      groups.push([]);
    }
    groups[at]!.push(op);
  }
  const out: PlannedOp[] = [];
  for (const group of groups) {
    const units: { ops: PlannedOp[]; entry: [number, number, number] | null; exit: [number, number, number] | null }[] = [];
    const unitByRegion = new Map<string, number>();
    for (const op of group) {
      let at = unitByRegion.get(op.region.id);
      if (at === undefined) {
        at = units.length;
        unitByRegion.set(op.region.id, at);
        units.push({ ops: [], entry: null, exit: null });
      }
      const unit = units[at]!;
      unit.ops.push(op);
      if (unit.entry === null && op.outcome.passes[0] !== undefined) unit.entry = op.outcome.passes[0]!.entry;
      if (op.outcome.passes[op.outcome.passes.length - 1] !== undefined) unit.exit = op.outcome.passes[op.outcome.passes.length - 1]!.exit;
    }
    if (units.some((u) => u.entry === null || u.exit === null)) {
      // An op that recorded no passes: the tour cannot price it, so this run keeps its order.
      out.push(...group);
      continue;
    }
    const entryOf = (at: number): [number, number, number] => units[at]!.entry!;
    const exitOf = (at: number): [number, number, number] => units[at]!.exit!;
    const d = (a: [number, number, number], b: [number, number, number]): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
    const remaining = units.map((_, k) => k);
    const order: number[] = [];
    let px = 0;
    let py = 0;
    while (remaining.length > 0) {
      let bestPos = 0;
      let best = Infinity;
      for (let k = 0; k < remaining.length; k++) {
        const e = entryOf(remaining[k]!);
        const dist = Math.hypot(e[0] - px, e[1] - py);
        if (dist < best - 1e-12) {
          best = dist;
          bestPos = k;
        }
      }
      const idx = remaining.splice(bestPos, 1)[0]!;
      order.push(idx);
      const e = exitOf(idx);
      px = e[0];
      py = e[1];
    }
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 64) {
      improved = false;
      for (let i = 1; i + 1 < order.length; i++) {
        for (let k = i; k < order.length; k++) {
          const before = d(exitOf(order[i - 1]!), entryOf(order[i]!))
            + (k + 1 < order.length ? d(exitOf(order[k]!), entryOf(order[k + 1]!)) : 0);
          const after = d(exitOf(order[i - 1]!), entryOf(order[k]!))
            + (k + 1 < order.length ? d(exitOf(order[i]!), entryOf(order[k + 1]!)) : 0);
          if (after < before - 1e-9) {
            order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse());
            improved = true;
          }
        }
      }
    }
    for (const at of order) out.push(...units[at]!.ops);
  }
  return [...out, ...sentinels];
}

export function planTreePrograms(tree: FeatureTree, opts: PlanTreeOptions): PlanTreeResult {
  const pocketResult: PlanPocketsResult = opts.pockets === null
    ? {
        ops: [],
        programs: [],
        sequence: [],
        unreachable: [],
        notes: [
          'the set holds no flat end mill — the pocket chain is not planned: its freeing contour is not planned with a ball either, so this plan does not free the part',
        ],
        // #992 — the no-flat fallback (#982) never frees the part: a warning, and the sentence
        // says so in the operator's own words (the review's ruling: "no flat, so the part isn't
        // freed" is a warning, never a silent property of the plan).
        statements: [
          {
            severity: 'warning',
            code: 'goal-not-freed',
            count: 1,
            text: 'the set holds no flat end mill — the part is not freed by this plan: no freeing contour is cut, so it stays attached to the stock',
          },
        ],
        unplanned: [],
        choice: {
          steps: [],
          cost: { entries: [], estimateSeconds: 0, toolChanges: 0, toolChangeSeconds: 0, totalSeconds: 0 },
          considered: [],
          unreachable: [],
          freeing: null,
          unplanned: [],
        },
      }
    : planPocketsForTree(tree, { ...opts.pockets, offset: opts.offset });
  // #1021 — the floor strips are decided HERE, after the chain: only the cutters THIS plan runs
  // as rest can own a strip.
  const stripped: PlanningFloorStrips | undefined = opts.floorStrips?.(
    pocketResult.choice.steps.filter((step) => step.kind === 'rest').map((step) => step.cutter.tool),
    new Set(pocketResult.statements.flatMap((st) => st.ids ?? [])),
  );
  const extraRegions = [...(opts.curved.extraRegions ?? []), ...(stripped?.regions ?? [])];
  const curvedResult = planCurvedForTree(tree, {
    ...opts.curved,
    ...(extraRegions.length === 0 ? {} : { extraRegions }),
    ...(stripped === undefined || stripped.masks.size === 0 ? {} : { extraRegionMasks: stripped.masks }),
    offset: opts.offset,
    safeZMm: SAFE_Z,
    hopZMm: HOP_Z,
  });
  const freeing = pocketResult.ops.filter((op) => op.kind === 'contour');
  // #962 — THE REGION TOUR: each cutter's run visits its regions in nearest-neighbour order
  // rather than the planning order; the freeing contour stays pinned last (see the helper).
  const ops: PlannedOp[] = orderOpsForPrograms([
    ...pocketResult.ops.filter((op) => op.kind !== 'contour'),
    ...curvedResult.ops,
    ...freeing,
  ]);
  const programs = new Map<string, ToolpathIR>();
  for (const op of ops) {
    const key = op.outcome.cutter;
    const existing = programs.get(key);
    programs.set(key, existing === undefined ? op.outcome.ir : concatToolpathIR(existing, op.outcome.ir));
  }
  return {
    ops,
    programs,
    sequence: pocketResult.sequence,
    clGrid: curvedResult.clGrid,
    unreachable: pocketResult.unreachable,
    notes: [...pocketResult.notes, ...curvedResult.notes],
    statements: [...pocketResult.statements, ...curvedResult.statements],
    unplanned: [...pocketResult.unplanned, ...curvedResult.unplanned],
    choice: pocketResult.choice,
    ...(stripped === undefined ? {} : { floorStrips: stripped }),
  };
}

/**
 * Generate → verify, headless (#206). Turns an `EngraveJob` into the exact `.nc` text that will
 * be saved, running every gate the pipeline has BEFORE the text exists:
 *
 *   findings (#200/#201/#203)  → the job as data, the vise, and the tool-opened geometry
 *   feeds    (#202)            → the cutting parameters for the material and the cutter
 *   cam      (#172)            → the toolpath IR: the region operations off the SAME opened
 *                                polygons stage 1 measured, then the single-line traces (#219)
 *                                appended as their own operations (#287)
 *   post     (#173)            → the `.nc` text
 *   verify   (#174)            → the text, re-parsed and checked against the depth limit
 *   frame    (#244)            → the same toolpath traced in the air, a second `.nc` file
 *
 * Since #419 J3 the whole of that runs ONCE PER PROGRAM: a job with `setups[]` is one file per setup
 * and cutter, and the result carries them as a list. One file has one tool, so the post's `M6`, the
 * verifier's single-tool checks and the frame all keep their single-tool shape.
 *
 * Each stage stops the pipeline on an error and reports which stage stopped it. What gets
 * verified is the TEXT, never the IR (`/Simulation.md` §1.2): `verifyProgram` parses the bytes
 * the machine would read, so a post-processor bug cannot hide behind a clean IR.
 *
 * Headless — it takes the Manifold toplevel like `session.ts` and `engravePreview.ts` do, so it
 * runs (and is tested) in plain Node, and `sim.worker.ts` is a thin Comlink shell over it.
 * Pure given `(tl, job)`: the same job produces byte-identical `nc`.
 *
 * The result carries two fields the issue's interface did not name, both because the main thread
 * cannot recompute them without wasm:
 *   - `predicted`: the opened regions per item, which the oracle (#206 §3) compares the
 *     simulation against. `session.oracle` needs them and only this module has the polygons.
 *   - `errors`: the stage failure MESSAGES. The issue's interface has room for `feeds`/`verify`
 *     but not for a CAM or POST refusal, and a refusal with no reason is useless in the panel.
 */

import type { EngraveItem, EngraveJob, EngraveMargins, EngraveTargetObject } from '@/types/engraveJob';
import type { Mm } from '@/types/units';
import { segmentsForRadius } from '@/engine/compiler/arcResolution';
// package.json version for the post's `;@MKR|CAM|v=` header. Read from package.json directly
// rather than Vite's `__APP_VERSION__` define: Vite replaces the define at build time, but a
// headless run under `tsx`/Node (the bench-file generator, CI) has no such define and used to
// fall back to `dev`, so a generated-then-committed `.nc` was not byte-identical to the app's
// own save (#231 item 4). package.json is the single source in every environment.
import { version as CAM_VERSION } from '../../../package.json';
import type { MillProfile } from '@/engine/cnc/machine';
import { jobMachine, type MachineCalibration } from '@/engine/cnc/calibration';
import { catalogueCoverageFor, feedsFor, type FeedsEntry, type FeedsResult, type FeedCatalogueRow } from '@/engine/cnc/feeds';
import {
  cuttingDiameter,
  cuttingForTrace,
  cuttingRadiusForSweep,
  drillPointAngle,
  flatEndMill,
  pointLength,
  tipNotRecorded,
  traceRadiusAt,
  type Tool,
} from '@/engine/cnc/tool';
import { threadMillIR, threadSettings, type ThreadMillPlan, type ThreadSettingsResult } from '@/engine/cnc/cam/threadMill';
import { drillBitIR, drillSettings, type DrillBitPlan, type DrillSettings } from '@/engine/cnc/cam/drillBit';
import { borePitchMm, boreRampAngleFrom } from '@/engine/cnc/cam/drill';
import { readDefault, type ShopDefaults } from '@/platform/defaultsClient';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { vCone, vDepthLimit, vDepthRefusal, vTraceDepthRefusal, vTraceDepthWarning, type VCone } from '@/engine/cnc/vProfile';
import { minimumXyStepMm } from '@/engine/cnc/machine';
import {
  coreOffsetRadius,
  vCarveGrooveRefusal,
  vCarvePlane,
  vCarveRowStepover,
  vCarveStepoverClampNote,
  type VCarvePlane,
} from '@/engine/cnc/vCarveGeometry';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { cutterOnMetalLine } from '@/engine/cnc/engrave/cutterMaterial';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { entryFor } from '@/engine/cnc/toolRegistry';
import { toPartPlan, labelProfile, jobDepthLimit, keepOutNameAt, type PartPlan } from '@/engine/cnc/engrave/partPlan';
import {
  dedupeFindings,
  jobSetups,
  pureGoalObject,
  setupProgramFindings,
  toSetup,
  validateGoalObject,
  validateJob,
  type JobFinding,
} from '@/engine/cnc/engrave/jobSetup';
import { jobForSetup, setupPrograms, type JobProgramRef } from '@/engine/cnc/engrave/programs';
import {
  restJobFor,
  vBitRestRefusal,
  type RestPassFacts,
  type RestProgram,
  type UnroughedItem,
} from '@/engine/cnc/engrave/restPass';
import {
  restSeamFacts,
  thirdToolAdvice,
  REST_MACHINING_FALLBACK,
  type RestSettingSource,
  type SeamCutter,
  type SeamFacts,
} from '@/engine/cnc/engrave/restSettings';
import { findItem, itemName } from '@/engine/cnc/engrave/recommendTool';
import { unionRemoval, restMachining, type RestRegion, type RestResult } from './engraveRest';
import { createSimSession, type SimLoadOk, type SimLoadResult } from './session';
import { simErrors, simulationProblem } from '@/engine/cnc/simGate';
// #747 review — the one sentence normaliser (`#724 W5`): a cause that already ends in a full stop
// must not grow a second one. `engraveRunGate` imports types and `simGate` only, so it is safe in
// the worker and the CLI.
import { withPeriod } from '@/store/engraveRunGate';
import type { NodeMeshOutput } from '../geometry/meshOutput';
import { programHash } from '@/engine/cnc/programHash';
import { validateVise } from '@/engine/cnc/fixture';
import { generateEngrave, makeClipperOffset, zPasses, type EngraveRegion, type FinishPassSpec, type VCarveRegion } from '@/engine/cnc/cam/engraveJob';
import type { FinishStockToLeave } from '@/engine/cnc/engrave/finishPass';
import { generateFacing, type FacingCamSummary } from '@/engine/cnc/cam/facing';
import { chooseFacingTool } from '@/engine/cnc/engrave/facingTool';
import { facingRefusal } from '@/engine/cnc/stockStart';
import { generateTrace } from '@/engine/cnc/cam/trace';
import {
  enclosedPath,
  generateProfile,
  kerfPolygons,
  placeTabs,
  profilePath,
  signedArea,
  tabBars,
  tabBridgeRectangles,
  type ProfileCut,
  type ProfileSpan,
} from '@/engine/cnc/cam/profile';
import { buildThroughMask, type MaskCutout } from '@/engine/cnc/engrave/throughMask';
import { tapeHoldFindings, type TapedPiece } from '@/engine/cnc/engrave/tapeHold';
import type { BedUnderFacts } from '@/engine/cnc/engrave/jobSetup';
import { generateChamfer, type ChamferCut } from '@/engine/cnc/cam/chamfer';
import type { Polygons } from '@/engine/cnc/cam/pocket';
import { concatToolpathIR, estimateCycleSeconds, HOP_Z, raiseTravelOver, toolNumberFor, travelHeightOver, travelStats, type CamMove, type CamPassStep, type ToolpathIR } from '@/engine/cnc/cam/ir';
import {
  DEFAULT_STOCK_TO_LEAVE_MM,
  generateSurface3dForGoal,
  isMold,
  steepestWallDeg,
  type GoalSurfaceFacts,
  type SurfaceFeeds,
} from '@/engine/cnc/cam/surface3d';
import { postZ1, type PostContext, type VacuumSpan } from '@/engine/cnc/post/z1';
import { applySurfaceLift, maxSurfaceLift, type SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import { FRAME_Z, runSheetFileName, runSheetFrameFileName } from '@/engine/cnc/engrave/runSheet';
import type { Setup } from '@/engine/cnc/setup';
import type { MountObstacles } from '@/engine/cnc/mounts/bracket';
import { unfacedBands } from '@/engine/cnc/mounts/inPath';
import { verifyProgram, type DepthLimit, type ThroughMask, type VerifyReport } from '@/engine/cnc/verify';
import type { ManifoldToplevel } from '@/workers/geometry/evaluateOp';
import { executeProfile } from '@/workers/geometry/evaluateOp';
import { circlePolygon } from '@/workers/geometry/sweep';
import {
  bindingVoidsByRegion,
  itemDepthBoundFindings,
  engraveCutRegions,
  engravabilityFindings,
  keepOutFindings,
  measureLabels,
  measureRaisedTexts,
  raisedTextFindings,
  traceCutRegions,
  type CutRegion,
  type LabelEngravability,
  type LabelRatioAt,
  type PerCharGlyph,
} from './engraveGeometry';
import { colourBoundaryFor, stackDepthLimit, type StackDepthLimit } from './stackDepthLimit';
import { rotaryJobFindings } from '@/engine/cnc/rotary/findings';
import {
  ROTARY_NECK_EDGE_GRID_MM,
  ROTARY_NECK_ID,
  neckCutterTooWideSentence,
  neckNoProgramSentence,
  rotaryNeckBand,
  rotaryNeckCutRegion,
  rotaryNeckFacts,
  rotaryNeckOf,
  type RotaryNeckFacts,
} from '@/engine/cnc/rotary/neck';
import { rotaryMapOf, toRotaryIR } from '@/engine/cnc/rotary/wrap';
import { ceilingName, effectiveMargins, MARGIN_DEFAULTS } from '@/engine/cnc/engrave/depthBounds';
import { ORACLE_SHALLOW_DEPTH_FRACTION, type OraclePredicted, type OracleThreadMove } from '@/engine/cnc/engrave/oracle';
import type { SurfaceProgramCheck } from '@/engine/cnc/uploadGate';

/** The stage that stopped the pipeline, or `done` when everything passed. */
export type EngraveStage = 'findings' | 'feeds' | 'cam' | 'post' | 'verify' | 'done';

/**
 * The shop defaults the engrave pipeline reads but this realm cannot (#451): the location lives on
 * the main thread, so the caller sends each chosen number as plain data. `null`/absent means the
 * caller had no location — the receiving module then keeps its own LABELLED fallback, never an
 * unlabelled literal.
 *
 * `lostDetailWarnRatio` is `engrave.lostDetailWarnRatio` (the share of an item's area a cutter must
 * keep before `item-detail-lost` is raised). `peckClearanceMm` is `drill.peckClearanceMm` (how far
 * above the floor just cut a peck's re-entry rapid stops). Both are read by `engraveRunStore` and
 * `engravePreviewStore` — the preview needs only the ratio; the run needs both.
 */
export interface EngraveShopOpts {
  lostDetailWarnRatio?: number | null;
  peckClearanceMm?: number | null;
  /**
   * #450 slice 3 — the table `feedsFor` resolves against, resolved on the caller's side
   * (`resolvedFeedsTable().table`) because the location lives on the main thread and a worker's own
   * module state has no located table. Absent: the worker's compiled `FEEDS_TABLE` fallback.
   */
  feeds?: readonly FeedsEntry[] | null;
  /**
   * #445 — the whole shop-defaults map, because the thread settings carry a SOURCE per key and
   * `readDefault` resolves each one against the location. `engraveRunStore` passes the same map
   * it reads the two numbers above from, so a run's thread numbers and its peck clearance are one
   * snapshot. `null`/absent means no location: `readDefault` then labels each fallback.
   */
  defaults?: ShopDefaults | null;
  /**
   * #432 slice 2 — the registry snapshot (`getTools()`), handed in for the same reason `catalogue`
   * is: the sim worker cannot see the tool registry, so the facing pass's own cutter is chosen from
   * the list the picker is showing rather than from the worker's empty module state. Absent: no
   * facing tool can be chosen, and a job that faces has its facing program refused with that
   * reason — the engraving still generates.
   */
  tools?: readonly ToolLibraryEntry[] | null;
  /**
   * #432 review R10 — the inventory's condition summaries (`inventoryConditions()`), handed in for
   * the same reason `tools` is: `toolCondition`'s map is main-thread module state, and the sim
   * worker's copy is empty. The facing pick skips a cutter every copy of which is marked broken and
   * prefers a fresher copy only on an equal diameter. Absent/null is "nothing known": no cutter is
   * excluded as broken and a worn one stays eligible, exactly as before the table was passed.
   */
  conditions?: ReadonlyMap<string, ConditionSummary> | null;
  /**
   * #712 — what the machine's bed carries under the stock (the active profile's surface, the
   * wasteboard's thickness and its depth limit, the house board a bare bed needs), resolved on the
   * CALLER's side like `mount` because the active bed profile lives in the location. Absent/null is
   * no location: the through sentences are exactly the pre-#712 ones.
   */
  bed?: BedUnderFacts | null;
  /**
   * #442's #427 item — the mount's obstacles (the bracket's arms and the top clamps, with the fit),
   * or `null` when the job is held in the vise. Resolved on the CALLER's side for the same reason
   * `defaults` is: the bracket sizes are shop defaults the location owns, and this worker must not
   * pull the defaults client in (`verify.ts`'s boundary, `mounts/bracket.ts`'s import).
   *
   * Absent or null changes nothing: the verifier is handed no obstacles and the simulation checks
   * the vise's own envelope, exactly as every pre-#427 run did.
   */
  mount?: MountObstacles | null;
  /**
   * #472 — the location's two rest-machining numbers, resolved on the CALLER's side for the same
   * reason `defaults` is: the worker must not pull the defaults client (and its house transport)
   * into this realm. `engraveRunStore` reads them from `rest.overlapMm` and `rest.thirdToolPct`
   * through `readDefault`, so the source travels with the number exactly as it does on the CLI route.
   * Absent/null is no location: the labelled `REST_MACHINING_FALLBACK` pair is used.
   */
  rest?: {
    overlap: { value: number; source: RestSettingSource };
    thirdToolPct: { value: number; source: RestSettingSource };
  } | null;
  /**
   * #250 — `finish.stockToLeaveMm`, resolved on the CALLER's side like `rest`: the location lives on
   * the main thread and the worker must not pull the defaults client in. The source travels with the
   * number so the run sheet prints where the allowance came from. Absent/null means the build has no
   * finish setting: every program cuts in one pass, exactly as before #250, which is what the golden
   * `.nc` and every direct-engine caller rely on. `engraveRunStore` always supplies it.
   */
  finish?: { stockToLeaveMm: FinishStockToLeave } | null;
  /**
   * #535 — the shop's `sim.columnFlatPitchYMm` (the FLAT heightfield pitch), resolved on the
   * CALLER's side like `finish`: the goal operation samples its heightfield at this pitch when it
   * states none of its own, and the source travels so the run sheet and the row can say where the
   * number came from. Absent/null is no location: the CAM's labelled `DEFAULT_GRID_PITCH_MM`.
   */
  surfaceGrid?: { pitchMm: { value: number; source: 'seeded' | 'chosen' | 'measured' | 'fallback' } } | null;
  /**
   * #434 — the drill-bit numbers (`drill.peckDiameters`, `drill.peckClearanceMm`,
   * `drill.pointAngleDeg`, `drill.plungeFeed`, `drill.spindleRpm`) with each one's source,
   * resolved on the CALLER's side by `drillSettings(shopDefaults)` exactly as `rest` is. The
   * worker plans a drill program and states the point angle its findings used from this reading;
   * absent/null falls back to `drillSettings(shop.defaults)` and then to the labelled fallbacks,
   * so an old caller states `fallback` rather than inventing a number.
   */
  drill?: { settings: DrillSettings; sources: Record<keyof DrillSettings, string> } | null;
  /**
   * #608 — the fitted surface plane from registration, so the posted program follows the blank's
   * tilt instead of cutting a flat floor across it. `plane` is the least-squares plane through the
   * surface touches (in the readings' machine-Z frame); `z0` is the reference reading the origin was
   * written from (the LOWEST touch). Only FEED moves are lifted, so air moves and the frame file are
   * untouched. Absent/null: the program is posted flat, byte-for-byte as before this option existed.
   *
   * #623 — the SAME pair is what the simulation is loaded with (`SimLoadOpts.surface`), so the
   * program's frame and the oracle's frame are one value (#628 un-lifts the program into it). The
   * result repeats it as `EngraveGenerated.surface`, so a caller never has to guess the frame from
   * what it asked for: the package states the frame it was posted against.
   */
  surface?: SurfaceFrame | null;
}

/** A stage refusal with its reason, so the panel can list it under the right row. */
export interface EngraveFailure {
  stage: EngraveStage;
  message: string;
}

/** The CAM's own counts, for the panel's "Toolpath generated" row. */
export interface EngraveCamSummary {
  operations: number;
  cuttingMoves: number;
  estimatedSeconds: number;
  passes: number;
  /**
   * #487 — XY travel of the whole program: the rapid (air) distance and the cutting distance,
   * mm. The receipt and the run sheet print them against the pre-#487 order, so the gain is a
   * number rather than a claim. OPTIONAL because a generated object stored by an older build
   * still has a `cam` without them, and the sheet must then say nothing rather than invent a
   * number; `summarize` always fills them.
   */
  rapidMm?: number;
  cutMm?: number;
  /** The same program under the pre-#487 loop order, mm. Equal to `rapidMm` when there was nothing to order. */
  baselineRapidMm?: number;
  /** `'proximity'` when the region CAM placed loops by #487; null when the program had no region loops. */
  ordering?: 'proximity' | null;
  /**
   * #250 — operations that cut with a roughing allowance, and operations that finished at full
   * depth. OPTIONAL: a stored generated object from before #250 has neither, and the sheet then
   * narrates the program as one pass. `summarize` always fills them (0 when the program was not
   * split).
   */
  roughOperations?: number;
  finishOperations?: number;
  /**
   * #218 — how many operations in this program are full-depth `'through'` passes (a through
   * shape/drill region or a cut-out profile). Optional so a stored object from an older build
   * reads as "not recorded"; `summarize` always fills it.
   */
  throughOperations?: number;
  /**
   * #735 — the program's depth passes grouped by the step each took, deepest step first. Present
   * only when EVERY operation declared both its pass count and its step, so the sheet can print
   * "33 depth passes — 11 × 0.5 mm, 22 × 0.25 mm" instead of one feeds-row number that was true
   * for some of them. Absent (an old stored result, or a program with an undeclared operation):
   * the sheet prints its pre-#735 wording from `passes` and the feeds row.
   */
  passSteps?: CamPassStep[];
}

/**
 * #473 — what a program IS, so the run order can name the blank's skim as the first file rather
 * than calling it "setup 1". Absent on a result stored by a build before this field existed, and
 * read as `'engrave'`.
 */
export type EngraveProgramKind = 'facing' | 'engrave';

/**
 * ONE program of the job (#419 J3): a single setup cut with a single cutter, posted, verified and
 * keyed. The job's programs are a LIST because the run is a list — one file per tool, loaded and
 * played in order, with the vacuum left on across the changes between them.
 *
 * #473 — a facing pass adds ONE file BEFORE the setups: its own program, cut with its own flat
 * cutter and posted with the run's first vacuum word. It is `kind: 'facing'`; the setup programs
 * that follow are `kind: 'engrave'`.
 *
 * `programHash` is FNV over `nc` (decision 3) — the same key the run confirmation and
 * `finishedHashes` use, so a program that finished on this machine is recognised across reloads.
 *
 * Only a program that POSTED and PASSED THE VERIFIER appears here: a withheld file is not a program,
 * and `EngraveGenerated.ok` is false whenever one is missing from the list it should have been in.
 */
export interface EngraveProgram {
  /** #473 — `'facing'` for the blank's skim; absent or `'engrave'` for a setup's program. */
  kind?: EngraveProgramKind;
  /**
   * #240 — the frame the POST wrote this file in: `'flat'` for the 3-axis dialect, `'rotary'` for
   * the 4th axis's (Z = radius from the axis, A on every move). The run path reads THIS fact, not
   * the job's workholding, to know a package holds a rotary program; `freezePackage` copies it into
   * the frozen record. Optional and absent on results stored before the field existed (read as
   * flat), and on the facing file, which is always the flat dialect.
   */
  frame?: 'flat' | 'rotary';
  /** 1-based, the operator's "Setup 2". The facing program shares the first setup's index. */
  setupIndex: number;
  setupId: string;
  /** The cutter this file runs — the setup's tool, and the header's `;@CM|TOOL|key=` line. */
  toolKey: string;
  nc: string;
  /**
   * The exact 2.5D verifier's report. #535 — null ONLY on a surface program, which the verifier
   * cannot judge; such a program carries `surfaceCheck` instead. A program with neither is refused
   * by the release gates (`programUploadProblem`'s "never none").
   */
  verify: VerifyReport | null;
  /**
   * #535 — a pure goal job's check: the material sweep that stood in for the 2.5D verifier, with
   * the dexel grid it ran on and the CAM's roughing layers. Null/absent on every other program.
   */
  surfaceCheck?: SurfaceProgramCheck | null;
  /** This program's own frame file (#244), checked by the same verifier; null when not produced. */
  frameNc: string | null;
  frameVerify: VerifyReport | null;
  /** #747 — this program's frame height in work Z, and why it was withheld when it was. */
  frameZ?: Mm | null;
  frameError?: string | null;
  /** FNV-1a over `nc` — `programHash` in `engine/cnc/programHash.ts`. */
  programHash: string;
  cam: EngraveCamSummary | null;
  /**
   * #434 — the drill facts when THIS program is the drill bit's, so a caller describing program N
   * (the run plan, a per-program sheet) can name its `drill.*` numbers. Null on every other file.
   */
  drill?: DrillProgramFacts | null;
  /**
   * #250 — the allowance this program split against, when it wrote rough and/or finishing passes.
   * Null/absent on a program that cut in one pass: a drill's file, a V region, or a build with no
   * finish setting.
   */
  finish?: FinishPassFacts | null;
  /**
   * #218 — the cut-out/tab facts when THIS program cuts the profiles. Null on every other file:
   * the run sheet's tab-removal step belongs to the program that leaves the tabs, not to the run
   * as a whole (a job may cut its regions with one tool and its profiles with another).
   */
  through?: ThroughCutFacts | null;
  /**
   * #668 — the bore facts when THIS program helices a hole to size. Null on every other file: the
   * run sheet's pitch step belongs to the program that cuts the wall, not to the run as a whole.
   */
  bore?: BoreProgramFacts | null;
  /**
   * #669 — the chamfer facts when THIS program cuts a bevel. Null on every other file: the run
   * sheet's bevel step belongs to the program that cuts the edge.
   */
  chamfer?: ChamferProgramFacts | null;
  /**
   * #677 — the core facts when THIS program clears the middle a variable-depth V-carve cannot
   * reach. Null on every other file: the run sheet's flat-bottom step belongs to the program that
   * pockets the core, and the areas are the ones the CAM cut rather than a second measurement.
   */
  core?: CoreProgramFacts | null;
  /**
   * #737 — the neck for parting HERE, when this program leaves one. Null/absent on every other
   * file: the saw step belongs to the program that cut the neck, and the numbers are the ones the
   * findings judged and the CAM cut.
   */
  neck?: RotaryNeckFacts | null;
}

/** #677 — one program's clearance of the standing cores, one entry per variable region. */
export interface CoreProgramFacts {
  cores: { of: string; name: string; areaMm2: number; depthMm: number }[];
}

/**
 * #250 — what a program's rough/finish split was, for the run sheet's two steps. The sheet already
 * has the job's items; `itemIds` says which of them this program actually split, because a drill or
 * a V region is never split even when the program's `mode` asks for both passes.
 */
export interface FinishPassFacts {
  /** The allowance the roughing pass left on walls and floor, and where the number came from. */
  stockToLeaveMm: FinishStockToLeave;
  /** Which half (or both) this program wrote. */
  mode: FinishPassSpec['mode'];
  /** Label ids this program split, in the order their operations were emitted. */
  itemIds: string[];
}

/** #250 — the pass split one program writes. The job's program count is #472's, not this. */
export type FinishPassMode = FinishPassSpec['mode'];

/**
 * #434 — what the DRILL PROGRAM cut, and with which numbers. One entry per drill item the
 * program carries (a drill program's items are its drills), in document order, plus the settings
 * the planner read and each one's source, so the run sheet prints provenance rather than
 * re-resolving the shop's defaults.
 *
 * `simDrillPoint` is the point default `planDrillBit` used (`SimLoadOpts.drillPointDefault`), so
 * the column engine sweeps the point the CAM planned instead of re-reading the setting.
 */
export interface DrillProgramFacts {
  /** The bit's own name, so the run sheet names the cutter rather than "the drill". */
  toolName: string;
  settings: DrillSettings;
  sources: Record<keyof DrillSettings, string>;
  plans: (DrillBitPlan & { id: string; name: string })[];
  simDrillPoint: { deg: number; source: string };
}

/**
 * #218 — what the CUT-OUT program cut, for the run sheet's tab-removal step. One entry per
 * cut-out the program carries, with the tab spec the file was cut with and how many tabs were
 * actually placed (a `tab-unplaceable` finding refuses the run, so a successful run has every
 * requested tab, but the count is stated rather than inferred).
 */
export interface ThroughCutFacts {
  /** The breakthrough the cut-out programs cut to, mm below the blank's bottom face. */
  breakthroughMm: number;
  /** The under-board's thickness, mm, or null when the job has none (refused before CAM). */
  boardThicknessMm: number | null;
  cutouts: {
    id: string;
    name: string;
    tabs: { count: number; widthMm: number; heightMm: number };
    /** Tab spans actually placed across every contour of the cut. */
    spans: number;
    /** Tabs asked for but not placed; 0 on a run that reached CAM. */
    unplaceable: number;
  }[];
}

/**
 * #668 — what the BORES in one program cut, for the run sheet's pitch step. One entry per bore
 * item, in document order, with the numbers the CAM ran it at. The pitch and the two numbers it
 * was resolved from travel together, because the sheet's whole point is to say WHICH of them is
 * binding: a helix capped by the feeds row's step-down is the row's number, and one capped by the
 * ramp angle is the shop's.
 */
export interface BoreProgramFacts {
  items: {
    id: string;
    name: string;
    /** The hole's diameter, mm — what the bore asks for. */
    holeDiameterMm: number;
    /** The cutter's cutting diameter, mm. */
    cutterDiameterMm: number;
    /** The helix's centre-path radius: hole radius less cutter radius, mm. */
    centreRadiusMm: number;
    /** The helix's descent per revolution, mm — `min(step-down, 2π·Rc·tan(ramp angle))`. */
    pitchMm: number;
    /** The feeds row's step-down cap, mm — one of the pitch's two sources. */
    stepDownMm: number;
    /** The shop's ramp angle used, degrees — the pitch's other source. */
    rampAngleDeg: number;
    /** Where `rampAngleDeg` came from (`bore.rampAngleDeg`'s reading: seeded, chosen, fallback). */
    rampSource: string;
  }[];
}

/**
 * #669 — what the CHAMFERS in one program cut, for the run sheet's bevel step. One entry per
 * chamfer, in document order, with the width, the derived tip depth and the side — plus WHICH kind
 * of rim it breaks, because the sheet says when it runs: a pocket's rim after the pocket, a part's
 * edge before the cut-out.
 */
export interface ChamferProgramFacts {
  items: {
    id: string;
    name: string;
    /** The bevel's width on the top face, mm. */
    widthMm: number;
    /** The tip plane's depth below the top face, mm — the bevel's bottom. */
    depthMm: number;
    /** The side of the rim's outline the cutter runs: 'outside' breaks a part's edge, 'inside' a pocket's rim. */
    side: 'outside' | 'inside';
    /** The cutter's tip diameter, mm — the radius the bevel's bottom stands off the wall by. */
    tipDiameterMm: number;
    /**
     * Where that tip came from. `'stated'` is the cutter's own record; `'point, by kind'` is a
     * chamfer with none stated, which is a point by the bit's shape — an assumption worth naming,
     * because a real flat would mark the wall at the bevel's bottom by its radius.
     */
    tipSource: 'stated' | 'point, by kind';
  }[];
}

export interface EngraveGenerated {
  /** False as soon as any stage reports an error. */
  ok: boolean;
  /** The stage that stopped it, or `done`. */
  stage: EngraveStage;
  /** #200, #201, #203. */
  findings: JobFinding[];
  /** #202. */
  feeds: FeedsResult | null;
  /**
   * #445 — one plan per thread item, in document order: the pass radii, the run-out and the plain
   * `simThreads` the simulator load needs. `null` for every job with no thread, so a job before
   * #445 reads exactly as it did.
   */
  threads: ThreadMillPlan[] | null;
  /**
   * #445 phase B — the numbers the thread program was cut with, AND where each came from.
   *
   * `threads` states the geometry but not its provenance: the same 300 mm/min could be a catalogue
   * row for this cutter or the shop's labelled placeholder. The run sheet has to say which, so the
   * worker hands the resolved settings and their per-key sources across instead of letting the
   * sheet re-resolve them — a second resolution could print numbers the file was not cut with.
   * `null` for every job with no thread, and for a run that never resolved them. OPTIONAL because
   * a generated object can arrive without it — one stored by an older build, or the bench script's
   * — and the sheet must then say the source was not recorded rather than guess.
   */
  threadMachining?: ThreadSettingsResult | null;
  cam: EngraveCamSummary | null;
  /**
   * #250 — the rough/finish split of the program this object describes (the FIRST program for the
   * legacy single-file adapter). Null/absent when the program was not split; `programs` carries each
   * program's own facts.
   */
  finish?: FinishPassFacts | null;
  /** The exact text to be saved. */
  nc: string | null;
  /**
   * #240 — the frame the POST wrote program 1 in: `'rotary'` when the job was cut on its unrolled
   * map and `toRotaryIR` converted it, `'flat'` otherwise. Absent on results stored before the
   * field existed, which read as flat; each `EngraveProgram` carries its own, because a run is a
   * list of files.
   */
  frame?: 'flat' | 'rotary';
  /** #174. */
  verify: VerifyReport | null;
  /**
   * #244 — the frame file: a tiny air trace of the job's XY extent at `frameZ`, emitted as
   * `<job>-frame.nc` beside the job. It is produced by THIS gated action, from the same toolpath,
   * and checked by the same verifier.
   *
   * NULL when the run never reached the frame, when the job was refused — and, since #747, when
   * the frame alone was withheld (see `frameError`). A withheld frame does NOT refuse the run:
   * the verified program is still produced and savable.
   */
  frameNc: string | null;
  /**
   * #244 — `verifyProgram`'s report on the posted frame, or null when no frame was posted. Since
   * #747 it is retained when the report's errors WITHHELD the file, so every finding can reach the
   * receipt and the run sheet instead of only the error count.
   */
  frameVerify: VerifyReport | null;
  /**
   * #747 — the WORK Z the frame traced at, in mm above the blank's top face. `frameTraceZ` raises
   * the design's 20 mm air clearance to clear the clamps and arms wherever this setup's WCS
   * reaches, then clamps it to what the machine's Z envelope allows (a thick blank's WCS origin,
   * or a measured one, can be a float hair below the ceiling), so the sheet prints this number
   * rather than the constant. Null when no frame file was produced.
   * Optional: a result stored before #747 reads as `FRAME_Z`, which is what it was traced at.
   */
  frameZ?: Mm | null;
  /**
   * #747 — why the frame file is absent even though the program is good: no reachable height
   * cleared the mount, or the frame's own verifier refused it. Null when a frame was produced (or
   * when the program itself never reached this stage). A frame fault NEVER stops the run: the
   * verified program stays, the frame is withheld, and this sentence says why.
   */
  frameError?: string | null;
  /**
   * #432 slice 2 — the FACING program, as its own `.nc` beside the job: the skim of the blank's
   * top, posted against the PROBED top (Z = 0 is the blank as the probe found it) with its own
   * cutter (`facingToolKey`). The engraving program is NOT shifted — it stays in the document's
   * frame, whose Z = 0 is the faced surface — because slice 4 re-zeros Z on that surface between the
   * two files; the two programs meet physically, never arithmetically.
   *
   * `null` when the job does not face, when the run stopped before the artefact was built, or when
   * it could not be produced — `facingError` then says why. A null here never fails the run: the
   * engraving still generates and is still savable.
   */
  facingNc: string | null;
  /**
   * #432 — `verifyProgram`'s report on `facingNc`, or null when none was produced. A report with
   * errors means the file was WITHHELD (see `facingError`): no unchecked program is handed over.
   */
  facingVerify: VerifyReport | null;
  /**
   * #432 — the registry key of the cutter the facing program was written for, or null with
   * `facingNc`. The operator loads it for the facing file alone; it is deliberately not the job's
   * `toolKey`, which is the cutter the engraving runs.
   */
  facingToolKey: string | null;
  /** #432 — why the facing program is absent, or null. Never a stage refusal: the run is not stopped. */
  facingError: string | null;
  /**
   * #432 slice 3 — what the facing program was cut with: its OWN cutter, the pass count and the
   * numbers from its feeds row. Null when no facing file was produced (see `facingError`), so the
   * run sheet can state a face the file actually makes and say why when there is none. It is
   * `FacingCamSummary`, not the sheet's own re-derivation: passes are `zPasses`' answer for this
   * depth and this row, and a second computation could print a pass count the file does not make.
   */
  facingCam: FacingCamSummary | null;
  /**
   * #419 J3 — the job's programs, in cut order: one per setup, each with its own `.nc`, verifier
   * report, frame file and FNV key. A single-setup job has exactly one, and the top-level `nc` /
   * `verify` / `cam` fields above are that same program — the adapter the panels and the bench
   * scripts read today.
   *
   * #473 — a job that faces has its face file FIRST (`kind: 'facing'`), before every setup's
   * program: upload it with the list and play it first so the vacuum is already on across the bit
   * change to the engraving cutter. The face file's own span is `'first'`; the engraving program
   * that follows carries the run's last word. The top-level `nc`/`verify`/`cam` still describe the
   * first ENGRAVING program, not the face file.
   *
   * Empty when nothing was posted (a refusal before the CAM, or a withheld file). Callers that need
   * the whole run — the package freeze, the run plan — must check `ok` first: a partial list is a
   * diagnosis, not a runnable job.
   */
  programs: EngraveProgram[];
  /**
   * #472 — the two-tool story, when a setup names more than one cutter and the rest pass actually
   * produced a second program. Every number comes from the measurements made HERE (the first
   * program's simulated removal, the rest regions it left, and the second program's chained sweep),
   * so the run sheet prints the numbers the files were cut with rather than re-deriving them.
   *
   * Absent/null on every one-cutter job, and on a multi-cutter setup whose rest pass had nothing to
   * cut — the sheet then has no second program to describe.
   */
  restPass?: RestPassFacts | null;
  /**
   * #434 — what the DRILL program cut: one plan per drill item, the settings and their sources,
   * and the point default the plan used. Present only when this result is the drill bit's own
   * program (a `(setup, drill)` entry); absent/null on every other program, so the run sheet's
   * drill section describes the file that actually holds the holes.
   */
  drill?: DrillProgramFacts | null;
  /**
   * #218 — what the CUT-OUTS in this program cut: the breakthrough, the board and each cut-out's
   * tab spec. Present only on the program whose tool cuts the profiles (the cut-outs are a class
   * of their own and always arrive on a flat end mill's setup); absent/null on every other file,
   * so the run sheet's tab-removal step describes the file that actually leaves the tabs.
   */
  through?: ThroughCutFacts | null;
  /**
   * #668 — what the BORES in this program cut: one entry per bore item, with the hole's diameter,
   * the cutter's, and the helix pitch the CAM ran it at together with both numbers the pitch came
   * from. Present only when the program carries a bore; absent/null everywhere else, so the run
   * sheet's bore step describes the file that really helices and says nothing on any other.
   */
  bore?: BoreProgramFacts | null;
  /**
   * #669 — what the CHAMFERS in this program cut: one entry per bevel, with its width, the derived
   * tip depth and the side. Present only when the program carries a chamfer.
   */
  chamfer?: ChamferProgramFacts | null;
  /**
   * #535 — a PURE GOAL job's surfacing facts: the numbers the roughing/finishing passes ran with
   * and the heightfield they sampled. Present only on the goal path (a job whose only work is a
   * `role: 'goal'` mesh); absent on every item job and on a result stored by an older build, so
   * the row and the run sheet say nothing rather than inventing a number.
   */
  surface3d?: GoalSurfaceFacts | null;
  /**
   * #623 — the fitted surface this package was POSTED against, or null on a flat post. The frame
   * the programs speak: the caller loads the simulation with exactly this value (`SimLoadOpts.surface`)
   * so the stock is seated on the same plane and the oracle judges in it. Absent/null is a flat
   * post, which is also what a stored package from before #623 says.
   */
  surface?: SurfaceFrame | null;
  /**
   * The regions the CAM cut and the oracle must match (#206 §3): each region item's opened
   * polygons, each drill's discs, and — since #287 — each single-line trace's swept region.
   */
  predicted: OraclePredicted[];
  /**
   * #748 — the floors this run's items sit on, mm below the top face (missing ids: the top face,
   * 0). Computed once for the WHOLE document and carried on every program, because a program's
   * sub-job holds only its own items: the run sheet reads this map to state a V-carve's floor
   * inset from the floor the item is actually written into. OPTIONAL because a generated object
   * can arrive without it — one stored by an older build — and the sheet then reads 0, the
   * pre-#748 top-face answer.
   */
  floors?: Record<string, number>;
  /** Stage refusals, in stage order. Empty on a clean run. */
  errors: EngraveFailure[];
}

/**
 * #201's measurement for ONE cutter and nothing else: how much of each item its opening reaches.
 *
 * `engraveRegions` computes exactly these rows on its way to a toolpath, which is the right price
 * for a job you are about to cut and the wrong one for a scan over a dozen candidate cutters
 * (#410's reachability table), most of which will not be picked. Same `measureLabels` call, same
 * `perChar`, same `toPartPlan`, so a share reported by a scan is the share the run would measure —
 * the scan cannot disagree with the program it is deciding.
 *
 * Returns `[]` for a cutter that cannot open a region at all: a non-flat, or a V-bit, whose groove
 * width is a function of depth (#405). Nothing was measured, so nothing is claimed.
 */
export function measureEngraving(tl: ManifoldToplevel, job: EngraveJob, tool: Tool): LabelEngravability[] {
  const usable = cuttingForTrace(tool);
  if (!usable.ok || usable.tool.shape !== 'flat') return [];
  return measureLabels(tl, toPartPlan(job), usable.tool.radius, job.edgeMargin, perCharFor(job));
}

/** `perChar` for a job: one single-character glyph profile per character, in text order. */
function perCharFor(job: EngraveJob): (labelId: string) => PerCharGlyph[] {
  return (labelId) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return [];
    return [...label.text].map((char) => ({
      char,
      profile: labelProfile({ ...label, text: char }, job.customFonts),
    }));
  };
}

/**
 * `ratioAt` for a job at a given cutter radius: re-typeset one label at a candidate cap height
 * and re-measure only that label (#201/#205). Copied from `engravePreview.ts` because that
 * helper is private to its module and this file must not edit it.
 */
function ratioAtFor(
  tl: ManifoldToplevel,
  job: EngraveJob,
  radius: number,
  radiusFor?: (labelId: string) => number,
): LabelRatioAt {
  return (labelId, size) => {
    const label = job.labels.find((l) => l.id === labelId);
    if (!label) return 0;
    const probe: EngraveJob = { ...job, shapes: [], labels: [{ ...label, size }] };
    const r = radiusFor?.(labelId) ?? radius;
    if (!(r > 0)) return 0;
    return measureLabels(tl, toPartPlan(probe), r, job.edgeMargin, perCharFor(probe))[0]?.ratio ?? 0;
  };
}

/** The text an engrave region pockets: a label's text, empty for a shape. */
function regionText(item: EngraveItem | undefined): string {
  return item && !('kind' in item) ? item.text : '';
}

/**
 * #677 — below this area the "core" is polygonisation dust between the deepest tip flat and the
 * wall, not floor worth a program of its own: the same 1 mm² bar the #665 warning kept.
 */
export const CORE_MIN_AREA_MM2 = 1;

/**
 * #677 — one derived CORE: the middle of a variable-depth V-carve that the V's width cannot reach
 * at the cap, as the flat cutter's next program pockets it.
 *
 * `polygons` is `offset(design, −coreOffsetRadius(cone, depth))` — the far edge of the deepest tip
 * flat — so the pocket's wall is TANGENT to the V's sloped flank at the floor and never cuts into
 * it. `id` is `core:<itemId>`: never a document id, so nothing that looks an id up in the job can
 * mistake the core for an item.
 */
export interface CoreCut {
  id: string;
  /** The variable-depth region this core stands under. */
  of: string;
  /** That region's own operation name, for the finding and the sheet. */
  ofName: string;
  /** The derived operation's name (`Core clearance of …`). */
  name: string;
  /** The cap depth, mm below the top face — the floor the V reaches at its centre line. */
  depth: number;
  polygons: Polygons;
  areaMm2: number;
}

/**
 * The measured opening of a job: the plan, its engravability measurements, the ready-to-cut regions
 * and every cut the program makes. Exported so `engraveOracle.spec.ts` can build a bad-step-over
 * toolpath off the SAME polygons `engraveGenerate` would have cut, without re-deriving them — and so
 * `engravePreview` can DRAW those same polygons instead of measuring a second set of its own (#288).
 */
export interface EngraveRegions {
  plan: ReturnType<typeof toPartPlan>;
  measured: LabelEngravability[];
  /** What the REGION CAM is handed: labels, shapes and drills (#220). Traces are not here — see `cuts`. */
  regions: EngraveRegion[];
  /**
   * #218 — the CUT-OUTS' profile cuts, ready for `cam/profile.ts`: each one's offset centre path,
   * through depth and tab spec. Empty when the job has none or the cutter is not a flat end mill
   * (a cut-out needs one; the setup gate refuses the pairing). Kept here so the CAM, the oracle's
   * prediction and the through mask all read the SAME path.
   */
  profiles: ProfileCut[];
  /**
   * #218 — the spatial through mask `jobDepthLimit` is composed with. Built from the geometry CAM
   * actually cuts: opened through regions, through-drill discs, and each cut-out's kerf with its
   * tab spans capped at `T − tabs.height`. Null when the job has no through work, which keeps the
   * limit exactly as it was before.
   */
  throughMask: ThroughMask | null;
  /**
   * EVERY cut the program makes, in cutting order, one entry per item (#288): the region CAM's own
   * list above, then the single-line traces, which are CAM'd separately (`generateTrace`) and so are
   * deliberately absent from `regions` — a swept line is not a pocketed region.
   *
   * This is the ONE list the oracle's prediction and the preview's picture are both built from, so a
   * class added here reaches the prediction, the picture and the program together, and a class left
   * out is missing from all three loudly rather than from the picture quietly (#288: the preview
   * walked `plan.engraves` on its own, so it never drew a drill's hole or a trace's groove).
   */
  cuts: CutRegion[];
  /**
   * #669 — the CHAMFERS' passes, ready for `cam/chamfer.ts`: each bevel's centre path (the rim's
   * edge offset by the tip radius on the air side) and its tip-plane depth. Empty when the job has
   * none or its cutter is not a cone (the finding refuses that pairing).
   */
  chamfers: ChamferCut[];
  /**
   * #677 — THE CORES a variable-depth V-carve leaves standing at its cap: `offset(design,
   * −coreOffsetRadius)`, the middle the V's width cannot reach. Derived here, where the design
   * polygons and the cone meet, so the core the finding measures, the region the flat cutter
   * pockets and the sheet's area are one geometry. Empty unless the program's cutter is a cone
   * and one of its regions asks for the variable carve.
   */
  cores: CoreCut[];
  /**
   * #748 — THE FLOOR EACH REGION SITS ON, mm below the top face: the pocket a label is written
   * into, the recess a carve sits inside. Missing ids are on the stock's top face (0). The plane
   * arithmetic above, the merge findings, the cores, the prediction, the preview, the panel and
   * the sheet all read this one map, so no consumer re-derives what "the floor" means.
   */
  floors: Record<string, number>;
  predicted: OraclePredicted[];
  /**
   * #737 — the neck this job leaves for sawing off, in map millimetres, or null when it has none.
   * Carried on the measured regions so `generateOneProgram` cuts exactly the span the findings
   * judged, and the run sheet prints the same numbers.
   */
  neck: RotaryNeckFacts | null;
  tool: Tool | null;
  radius: number | null;
  findings: JobFinding[];
  /**
   * #711 — every piece a through cut FREES, measured for the tape hold rule (#707 BM-4): each
   * released cut-out's footprint and the tape under it (the footprint eroded by the job's tape
   * inset). Empty on a job that is not taped, or one that frees no piece. The rule itself is
   * judged where the cutter's bite is known (`generateOneProgram`), because it needs the resolved
   * step-down.
   */
  releasedPieces: TapedPiece[];
  /**
   * The blank's colour split, mm below the engraved face, ON a real layer line (#285), or null
   * when the job states no print and there are no colour layers to speak of.
   *
   * Read here rather than in the preview so both halves of the pipe — the picture and the
   * generated program — are told the same plane by the same call: the preview draws it and
   * `item-depth-bound` is raised against it, and the verifier's limit comes from the same stack.
   */
  colourBoundaryDepth: Mm | null;
  /**
   * The depth margins this job ran with (#345), resolved from the job's own record or from the
   * house setting the caller handed in. Returned so the preview draws and reports the SAME numbers
   * the findings and the verifier used instead of resolving a second set of its own.
   */
  margins: EngraveMargins;
}

/**
 * Makera's "for Metal" line: REFUSED by name on a blank that is not metal (#405 review, the
 * maintainer's 2026-10-09 ruling). This is a finding about the PAIR — the bit's line and the blank's
 * material — so it is judged for EVERY cutter a job resolves, whatever its shape (#407).
 *
 * This was a warning, and it stopped the 60° bit only by accident — that bit's 0.1 mm tip falls
 * outside every PLA V row, so the job died at the feeds stage for a reason that says nothing about
 * the line. A metal 30° 0.3 mm ENGRAVER has the same name and a tip INSIDE the V row's band, so it
 * would have cut PLA on numbers nobody measured for it with nothing but a sentence on the sheet.
 *
 * A cutter ground for metal is not the cutter for a plastic or a wood — the claim is about the
 * PAIR, and this half of it fails — so the job does not run. `isMetalTool` reads every statement
 * of the line a cutter can carry: the NAME (`(Metal)` as a catalogue row spells it, `for Metal`
 * as the printed label spells it — the form an owned `inv:` cutter actually reaches a job with)
 * and the `-M-` box code, so a cutter filed under a code is refused too.
 *
 * The reach is deliberate (#407): this lived inside `vCutterFindings`, which only runs for
 * engraving/chamfer shapes, so a metal FLAT end mill on PLA — the built-in
 * `3.175*12mm Flat End(Metal)` is exactly that bit — was never judged. Nothing about the hazard is
 * specific to a V, so the flat family cannot slip past it.
 *
 * `null` tool answers nothing: there is no cutter to name.
 */
/** The cutter a key names, in the operator's display form (#690b); null when the registry cannot
 *  name it, so the caller can word the sentence without printing a key or repeating itself. */
function cutterWords(toolKey: string): string | null {
  const entry = entryFor(toolKey);
  return entry === null ? null : toolDisplayName(entry.tool);
}

function metalLineFindings(job: EngraveJob, tool: Tool | null, catalogue: readonly FeedCatalogueRow[]): JobFinding[] {
  if (tool === null) return [];
  // #732 — the finding is not raised for a pair the vendor's catalogue RATES: a `covered` row is
  // Makera's own feed row for this cutter on this material (direct, or through the labelled plastic
  // mapping), and the finding's premise — "no feed row was written for it on this material" — is
  // then false. The coverage rule is `catalogueCoverageFor`, the same one the feeds resolve with.
  const covered = catalogueCoverageFor(catalogue, job.stock.material, tool).kind === 'covered';
  if (!cutterOnMetalLine(tool, job.stock.material, covered)) return [];
  const overridden = job.metalLineOverride === true;
  return [
    {
      severity: overridden ? 'warning' : 'error',
      code: 'tool-metal-line',
      message: overridden
        ? `${toolDisplayName(tool)} is on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[job.stock.material]}: ` +
          `chosen despite the material mismatch — feeds and speeds are a guess, and the bit can chip or snap.`
        : `${toolDisplayName(tool)} is on Makera's "for Metal" line, and this job cuts ${MATERIAL_LABELS[job.stock.material]}: ` +
          `the bit's geometry and its coating are ground for metal, and no feed row was written for it on this material. ` +
          `Pick a wood/plastic cutter for this blank, or change the stock to a metal before cutting.`,
    },
  ];
}

/**
 * Surface area that means two V openings really merged, mm² (#221). The floor is far above
 * Clipper2's ~1e-8 mm² noise and far below the sliver a 0.1 mm bridge across a 5 mm stroke leaves
 * (~0.5 mm²), so `vcarve-surface-merge` is raised for a merge and not for an offset artefact.
 *
 * This is the floor for the CROSS-item check, where the quantity is the intersection of two
 * separate items' openings: any overlap at all means their two grooves meet. The intra-item
 * check, which reads the closing of ONE item's opening, needs the larger floor below.
 */
export const VCARVE_MERGE_AREA_MM2 = 0.001;

/**
 * How far a filled gap must RUN to be a ridge, mm (#748).
 *
 * The intra-item merge test closes the surface opening and asks what came back solid. That area is
 * not only the gaps between strokes: a closing also fills the artwork's own sharp concave corners,
 * which every outline has, and the fill grows with the outset. Measured on real type — the bench's
 * 2.6 mm "13G" labels at 0.25 mm of material, outset 0.067 mm — the corner fill alone is 0.011 mm²,
 * above {@link VCARVE_MERGE_AREA_MM2}. A merged gap is a STRIP, though: the ridge left below the
 * colour plane runs along the strokes, while a corner fill is a knife-edge sliver. So the area is
 * required to reach a gap-width strip (2 × the outset) at least this long — a quarter millimetre of
 * run — and a corner sliver cannot reach it. At the same outset each 13G label fills 0.005–0.011 mm²;
 * the thin fixture's tight script strokes fill 0.059–0.076 mm² and still warn.
 */
export const VCARVE_MERGE_RUN_MM = 0.25;

/**
 * The material a tab ACTUALLY leaves at a deep pass, as polygons (#218).
 *
 * A tab's nominal shape is `width` of material across the kerf, but the cutter cannot start and
 * stop at a square end. The deep passes stop with the cutter's CENTRE at the
 * span start and resume at the span end, so each end is an n-gon disc of radius r, the same
 * `circlePolygon` the sweep uses (`segmentsForRadius(r)`). What is left standing is the band
 * across the span LESS those two discs, which (for a straight span) is the band plus a shallow
 * circular segment at each end (area `r² (2 − π/2)` each). The band follows the span's own
 * points (#736), so on an arc the kept strip curves with the path. Predicting the plain rectangle
 * left that material as an under-cut in the oracle, which is exactly the check catching its own
 * geometric idealisation rather than a CAM mistake. The tab is still the bridge the operator
 * asked for; this is its shape where the cutter meets it.
 */
function tabKeptRegions(tl: ManifoldToplevel, spans: readonly ProfileSpan[], radius: number): Polygons {
  if (spans.length === 0 || !(radius > 0)) return [];
  const CS = tl.CrossSection;
  const n = segmentsForRadius(radius);
  const out: Polygons = [];
  for (const span of spans) {
    // The SWEPT band: the span's own path, one radius either side, with NO inset. The cutter
    // crosses the span at the tab top, so its swept plan is this band; the deep passes stop with
    // its centre at the span's ends, removing the two end discs from that band. Trimming the band
    // by the radius first (to the tab's material width) and then
    // subtracting the discs double-counts the trim, and the oracle read the difference as an
    // under-cut. The band comes from its one owner, `tabBars` (profile.ts), so the oracle and the
    // CAM cannot hold two readings of one span; it is wound CW for a kerf subtraction, so reverse
    // it to CCW — CrossSection reads a CW outer as a hole.
    const [bandContour] = tabBars([span], 0, radius);
    if (bandContour === undefined) continue;
    const band = CS.ofPolygons([[...bandContour].reverse()]);
    const startDisc = CS.ofPolygons([circlePolygon(span.start[0], span.start[1], radius, n)]);
    const endDisc = CS.ofPolygons([circlePolygon(span.end[0], span.end[1], radius, n)]);
    try {
      const kept = CS.difference([band, startDisc, endDisc]);
      try {
        // Reversed to a NEGATIVE winding: the prediction appends these to the kerf, and a filled
        // (positive) contour inside the kerf would be swallowed by the union instead of carving
        // the standing material out of it — a negative winding carves instead of being filled.
        out.push(...(kept.toPolygons() as Polygons).map((contour) => [...contour].reverse()));
      } finally {
        kept.delete();
      }
    } finally {
      band.delete();
      startDisc.delete();
      endDisc.delete();
    }
  }
  return out;
}

/** The area of a polygon set, mm². A tiny helper so the merge tests read as geometry. */
function polygonsArea(tl: ManifoldToplevel, polygons: Polygons): number {
  if (polygons.length === 0) return 0;
  const cs = tl.CrossSection.ofPolygons(polygons);
  try {
    return cs.area();
  } finally {
    cs.delete();
  }
}

/**
 * #711 — one freed piece as the tape sees it.
 *
 * `enclosed` is the region inside the cut-out's CENTRE path (#218's `enclosedPath`), which is the
 * piece PLUS the kerf's half-width beyond its edge: the tool cuts a kerf of its own radius around
 * the path, so the piece's real edge is `toolRadius` inside it. The TAPE under the piece is
 * therefore the enclosed region eroded by `toolRadius + inset` — the strips stop `inset` inside
 * every edge of the piece — and the FOOTPRINT the sentence quotes is that region's box narrowed by
 * the same two radii. A piece smaller than the inset answers 0 mm² of tape (it is refused, which
 * is right: nothing holds it).
 *
 * The offset is the measured geometry, not a box ideal: on a rectangle it reproduces the design's
 * `(L − 2i)(W − 2i)` (the Star's 64.00 mm² is asserted), and on an irregular piece it measures the
 * tape that really fits under it rather than an enclosing box it does not fill.
 */
function measureTapedPiece(tl: ManifoldToplevel, name: string, enclosed: Polygons, insetMm: number, toolRadius: number): TapedPiece | null {
  if (enclosed.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const contour of enclosed) {
    for (const [x, y] of contour) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const cs = tl.CrossSection.ofPolygons(enclosed, 'Positive');
  const grow = Math.max(insetMm + toolRadius, 0.5);
  const eroded = cs.offset(-grow, 'Round', 2, segmentsForRadius(grow));
  try {
    // `area()` forces the offset before the handles go (Manifold is lazy).
    const tapedAreaMm2 = eroded.area();
    const r3 = (n: number): number => Math.round(n * 1000) / 1000;
    return { name, widthMm: r3(maxX - minX - 2 * toolRadius), heightMm: r3(maxY - minY - 2 * toolRadius), tapedAreaMm2 };
  } finally {
    eroded.delete();
    cs.delete();
  }
}

/** The area two polygon sets share, mm². */
function intersectionArea(tl: ManifoldToplevel, a: Polygons, b: Polygons): number {
  if (a.length === 0 || b.length === 0) return 0;
  const ca = tl.CrossSection.ofPolygons(a);
  const cb = tl.CrossSection.ofPolygons(b);
  try {
    const shared = ca.intersect(cb);
    try {
      return shared.area();
    } finally {
      shared.delete();
    }
  } finally {
    ca.delete();
    cb.delete();
  }
}

/**
 * #741 — A V-CARVE OR INLAY DEEPER THAN THE CUTTER'S CONE IS REFUSED.
 *
 * A V-bit is a cone only up to the height where its flank meets its cylindrical body: the bench's
 * 3.175 mm 90° chamfer reaches its ⌀3.175 mm body at (3.175 − 0.1) / (2·tan 45°) = 1.5375 mm, and
 * the 30° 0.5 mm engraver at 4.9916 mm. Below that height the flank cuts a V; ABOVE it the body
 * cuts a vertical wall, so the pocket is no longer a V and an inlay's plug will not seat in it.
 * (The simulation's cone is capped at the same body, the other half of #741 — but a modelled
 * wrong cut is still a wrong part.)
 *
 * REFUSED, not capped: the depth IS the design. An inlay's female depth and its derived plug are
 * one number, so a silent cap would change the part and desynchronise the pair; and the panel's
 * sentence can then name the way out instead of quietly doing something else. The limit and the
 * sentence are the ONE owner in `vProfile.ts` (`vDepthLimit` / `vDepthRefusal`), which the CAM's
 * own guard (`generateEngrave`) also reads, so the finding, the guard and the panel cannot name
 * two different heights.
 *
 * A STATED flute shorter than the cone binds instead, and is named. A PRISM is judged by the
 * prism model's own sentence (`prism-height` in `jobSetup.ts`, from `prismNumbers`), not by this
 * one, so the panel names the shape's height and its cone rather than a V-carve's depth — that is
 * why the prism's engrave entry is skipped here (#741 review; the marker no longer EXEMPTS it,
 * it only routes it to the sentence that knows it is a raised shape).
 *
 * SINGLE-STROKE V TRACES (#741 review) are judged at their DEEPEST point — `depth` or any point
 * of a flute's per-point `depths`. A trace's line is the design, so it is not silently capped:
 * past the cone the bit's body rubs the groove and the job gets a WARNING
 * (`vcarve-trace-beyond-cone`); past a stated flute there is no cutting edge at all, so it is
 * REFUSED (`vcarve-trace-beyond-flute`). Both sentences come from the same owner.
 */
function vCarveDepthFindings(plan: PartPlan, tool: Tool): JobFinding[] {
  const limit = vDepthLimit(tool);
  if (limit === null) return [];
  const findings: JobFinding[] = [];
  for (const item of plan.engraves) {
    if (item.prism !== undefined) continue;
    if (!(item.depth > limit.limitMm + 1e-9)) continue;
    findings.push({
      severity: 'error',
      code: 'vcarve-depth-beyond-cone',
      labelId: item.id,
      message: vDepthRefusal(item.name, item.depth, tool, limit),
    });
  }
  for (const trace of plan.traces) {
    let deepest = trace.depth;
    for (const pathDepths of trace.depths ?? []) {
      for (const d of pathDepths) if (d > deepest) deepest = d;
    }
    if (limit.statedFluteMm !== null && deepest > limit.statedFluteMm + 1e-9) {
      findings.push({
        severity: 'error',
        code: 'vcarve-trace-beyond-flute',
        labelId: trace.id,
        message: vTraceDepthRefusal(trace.name, deepest, tool, limit),
      });
      continue;
    }
    if (limit.coneHeightMm !== null && deepest > limit.coneHeightMm + 1e-9) {
      findings.push({
        severity: 'warning',
        code: 'vcarve-trace-beyond-cone',
        labelId: trace.id,
        message: vTraceDepthWarning(trace.name, deepest, tool, limit),
      });
    }
  }
  return findings;
}

/**
 * What a V-BIT in a job means, now that it cuts regions (#221): the two findings the colour-plane
 * model needs, both about the geometry rather than about the cutter.
 *
 *  - `vcarve-above-colour-plane` — the item stops above the film, so the second colour is never
 *    reached. The design was stated at that plane; a cut that cannot reach it cannot produce it.
 *  - `vcarve-groove-too-narrow` — the groove at the plane is narrower than the machine's X/Y
 *    step (read from `MillProfile.axisSteps`), so the controller cannot resolve its two walls.
 *    The refusal is by name and says the way out, "go deeper or widen the stroke".
 *
 * THE STEP-OVER NOTE (#221 slice D) says which number set the pass pitch. The feeds row asks for
 * a step-over at the colour plane; the floor allows at most the tip radius, so the CAM runs the
 * smaller of the two ({@link vCarveRowStepover}). When the clamp wins, the operator is told both
 * numbers and why — the cut is correct either way, so the finding is worded as a note, not a
 * fault. `requestedStepOver` is the feeds resolver's own answer (`feedsFor(...).params.stepOver`),
 * passed in by `engraveRegions`; when feeds refuse, the CAM will refuse at its own gate and no
 * note is raised here.
 *
 * THE MERGE CHECK is the design check from the brief. The surface opening of an item is its
 * colour-plane design offset outward by `surfaceOutset` per side. When two of those openings
 * overlap — two strokes of one item, or two items — the cavity merges at the top face and leaves a
 * ridge of the top colour below, which is a different look from two separate grooves. We detect
 * overlap directly (the closing of each surface opening, and the pairwise intersection between
 * items), which is the fact itself, not a distance approximation. The warning names the item (or
 * the pair) and the threshold that was crossed.
 *
 * `null` tool, or any cutter that is not a cone, answers nothing: a flat end mill's surface and
 * floor are the design, and every finding before this one is unchanged.
 */
function vCarveFindings(
  tl: ManifoldToplevel,
  plan: PartPlan,
  tool: Tool,
  cone: VCone,
  machine: MillProfile,
  planeById: ReadonlyMap<string, VCarvePlane>,
  designById: ReadonlyMap<string, Polygons>,
  surfaceById: ReadonlyMap<string, Polygons>,
  requestedStepOver: number | null,
): JobFinding[] {
  const offset = makeClipperOffset(tl);
  const findings: JobFinding[] = [];
  const mm = (v: number): string => String(Math.round(v * 1000) / 1000);
  // #748 — where the grooves meet: the surface the item sits on, and the words for it. The top
  // face is the pre-#748 sentence, unchanged at floor 0.
  const surfaceWords = (plane: VCarvePlane): string =>
    plane.floor > 0 ? `the floor ${mm(plane.floor)} mm down` : 'the top face';
  const floorWords = (plane: VCarvePlane): string =>
    plane.floor > 0 ? ` at that ${mm(plane.floor)} mm floor` : '';

  for (const item of plan.engraves) {
    // #665 — a VARIABLE-depth item has no colour plane and no constant floor: its depth follows
    // the region's width, so the plane model's checks (the clamp, the film, the groove width)
    // describe a cut it does not make. #677 — its CORE is derived and reported by the RUN, not
    // here: only the run knows the setup's later cutters, so it alone can say whether the core is
    // cleared, and by which end mill. #673 — an INLAY half has no colour plane either: its flank
    // is on the design at the top face.
    if (item.variableDepth === true || item.inlay !== undefined) continue;
    const plane = planeById.get(item.id);
    if (plane === undefined) continue;

    if (requestedStepOver !== null) {
      // The CAM's fraction is `params.stepOver` over the diameter the row was resolved on — a
      // chamfer's base, an engraver's tip — never the tip width (#740). A row number that cannot
      // be expressed as a fraction raises no note: the feeds gate refuses it before the CAM.
      const stepover = vCarveRowStepover(tool, requestedStepOver, plane.planeRadius, cone);
      if (stepover !== null && stepover.clamped) {
        findings.push({
          severity: 'warning',
          code: 'vcarve-stepover-clamped',
          labelId: item.id,
          // One sentence, shared with the panel: the clamp note is the finding's own words.
          message: vCarveStepoverClampNote(item.name, stepover, cone.tipRadius),
        });
      }
    }

    // #748 — the plane's own film, not the document's: a colour boundary at or above the floor
    // the item sits on is already cut through, and a boundary below the floor is reached by a cut
    // `item.depth` deep below the TOP FACE exactly as before.
    if (plane.film > 0 && item.depth < plane.film - 1e-9) {
      findings.push({
        severity: 'error',
        code: 'vcarve-above-colour-plane',
        labelId: item.id,
        message:
          `${item.name} is ${mm(item.depth)} mm deep, but this blank's colour plane is at ` +
          `${mm(plane.film)} mm: the cut never reaches the second colour, so the design cannot appear ` +
          `there. Cut at least ${mm(plane.film)} mm deep, or make the artwork a stroke trace.`,
      });
    }

    const narrow = vCarveGrooveRefusal(plane, minimumXyStepMm(machine));
    if (narrow !== null) {
      findings.push({
        severity: 'error',
        code: 'vcarve-groove-too-narrow',
        labelId: item.id,
        message: `${item.name}: ${narrow}.`,
      });
    }
  }

  // Intra-item: closing the surface opening fills any gap narrower than twice its outset. What
  // comes back wider than the colour-plane design is exactly those gaps turned solid at the top.
  // #748 — the floor it is measured against: a closing also fills the artwork's own sharp concave
  // corners, so the area must reach a gap-width strip of {@link VCARVE_MERGE_RUN_MM} before it is a
  // ridge between strokes rather than a corner sliver. Both the opening and the strip are taken at
  // the floor the item sits on, so a label 0.25 mm into a pocket is judged at 0.25 mm of material.
  for (const item of plan.engraves) {
    const plane = planeById.get(item.id);
    const design = designById.get(item.id);
    const surface = surfaceById.get(item.id);
    if (plane === undefined || design === undefined || surface === undefined) continue;
    if (plane.surfaceOutset <= 0 || surface.length === 0 || design.length === 0) continue;
    const closed = offset(surface, -plane.surfaceOutset);
    const gained = polygonsArea(tl, closed) - polygonsArea(tl, design);
    const ridgeFloor = Math.max(
      VCARVE_MERGE_AREA_MM2,
      plane.surfaceOutset * 2 * VCARVE_MERGE_RUN_MM,
    );
    if (gained > ridgeFloor) {
      findings.push({
        severity: 'warning',
        code: 'vcarve-surface-merge',
        labelId: item.id,
        message:
          `two or more strokes of ${item.name} are closer than ${mm(plane.surfaceOutset * 2)} mm ` +
          `(2 × the ${mm(plane.surfaceOutset)} mm surface wall offset${floorWords(plane)}): their V ` +
          `openings merge at ${surfaceWords(plane)} and leave a ridge of the top colour below the ` +
          'colour plane.',
      });
    }
  }

  // Cross-item: the openings themselves, each with its own outset, intersected.
  for (let i = 0; i < plan.engraves.length; i++) {
    for (let j = i + 1; j < plan.engraves.length; j++) {
      const a = plan.engraves[i]!;
      const b = plan.engraves[j]!;
      const pa = planeById.get(a.id);
      const pb = planeById.get(b.id);
      const sa = surfaceById.get(a.id);
      const sb = surfaceById.get(b.id);
      if (pa === undefined || pb === undefined || sa === undefined || sb === undefined) continue;
      // #748 — openings only meet if they open INTO the same surface. Two items on different
      // floors (a label in the pocket, the pocket itself) are separated by the pocket's wall and
      // cannot merge at either face: their outsets are measured from different datums, so adding
      // them is meaningless too.
      if (pa.floor !== pb.floor) continue;
      if (intersectionArea(tl, sa, sb) > VCARVE_MERGE_AREA_MM2) {
        findings.push({
          severity: 'warning',
          code: 'vcarve-surface-merge',
          labelId: a.id,
          message:
            `${a.name} and ${b.name} are closer than ${mm(pa.surfaceOutset + pb.surfaceOutset)} mm ` +
            `at ${surfaceWords(pa)} (their two surface wall offsets added): their V openings merge, ` +
            `leaving a ridge of the top colour between them.`,
        });
      }
    }
  }

  return findings;
}

/**
 * The disc a plunge drill opens at one hole: radius `r`, polygonized with the same segment count
 * `segmentsForRadius` picks everywhere else (#190). The holes are unioned so a dense array whose
 * discs overlap still yields one region per drill item rather than double-counted overlap — the
 * oracle and the preview both compare against a single region.
 */
function drillPolygons(tl: ManifoldToplevel, holes: readonly [number, number][], radius: number): Polygons {
  const CS = tl.CrossSection;
  const discs = holes.map(([x, y]) => CS.circle(radius, segmentsForRadius(radius)).translate([x, y]));
  if (discs.length === 0) return [];
  const union = discs.length === 1 ? discs[0]! : CS.union(discs);
  if (discs.length > 1) discs.forEach((d) => d.delete());
  const polygons = union.toPolygons() as Polygons;
  union.delete();
  return polygons;
}

/**
 * A milled thread's oracle prediction (#445): the item's dimensions, the tool's cutting diameter,
 * and the plan's own FEED moves as segments. The oracle sweeps the same column/cone profile the
 * simulator does over these, on the grid the run was swept with, so there is no second model of the
 * thread and no annulus guessed against an envelope.
 *
 * Every move's start is the preceding move's endpoint; the first feed therefore needs no start of
 * its own because the plan always opens with a rapid. Only feeds cut — a rapid stays at HOP_Z/above
 * the top face and lowers no column.
 */
function threadPrediction(plan: ThreadMillPlan): OraclePredicted {
  const moves: OracleThreadMove[] = [];
  let prev: { x: number; y: number; z: number } | null = null;
  for (const m of plan.moves) {
    if (m.kind === 'feed' && prev !== null) {
      moves.push({ x0: prev.x, y0: prev.y, x1: m.x, y1: m.y, z: Math.min(prev.z, m.z) });
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return {
    depth: plan.tipDepth,
    polygons: [],
    thread: {
      x: plan.position[0],
      y: plan.position[1],
      majorMm: plan.major,
      minorMm: plan.minor,
      pitchMm: plan.pitch,
      threadDepthMm: plan.threadDepth,
      tipDepthMm: plan.tipDepth,
      cuttingDiameterMm: plan.cuttingDiameter,
      moves,
    },
  };
}

/** #748 — the area below which a containing region is floating-point dust, mm². */
const CONTAINMENT_AREA_EPS_MM2 = 1e-6;

/**
 * #748 — THE FLOOR EACH ENGRAVE SITS ON: one answer for a whole document's plan.
 *
 * An item lying WHOLLY inside another blind region — a label in a pocket, a carve in a recess —
 * cuts into that region's floor, so its cone opens over `depth − floor` of material rather than
 * over its full depth below the stock's top face. The floor is the DEEPEST other blind engrave
 * that contains the item and is shallower than it: a pocket at 4 mm under a 0.25 mm-deep label
 * gives 4, and a sub-pocket at 3 inside a pocket at 4 gives 3, never 0.
 *
 * "Contains" is the CONTAINER'S PROFILE holding the item's profile whole: the offset difference
 * between the profiles is below {@link CONTAINMENT_AREA_EPS_MM2}, so a stroke poking past the
 * pocket's rim does NOT sit on the floor. The profile is the pocket's MOUTH; a container whose
 * walls slope (a V-carved pocket) has a smaller floor than its mouth, so an item inside the mouth
 * but over the flank is read as on the floor — the plan knows the pocket's DEPTH, not a
 * per-cutter wall profile, and #748 asks for the plan's floor rather than a second geometry model.
 *
 * Through, variable-depth, inlay and prism items are not floors: a through cut leaves no surface
 * at its depth, and the other three have a floor that is a function of the design or of a
 * different frame. Cut ORDER is not modelled either: this reads the document's plan, so a region
 * a later program cuts is still a floor for the earlier one (the bench's j24 labels are cut after
 * the recess, which is the same answer). A job whose floors live in another DOCUMENT — j24's split
 * `-c` file, whose recess is in `-a` — cannot know them.
 *
 * Only items with a floor above 0 appear in the map; every missing id reads as 0.
 */
export function supportingFloors(tl: ManifoldToplevel, plan: PartPlan): Map<string, number> {
  const floors = new Map<string, number>();
  const items = plan.engraves;
  if (items.length < 2) return floors;
  const polygonsById = new Map<string, Polygons>();
  const areaById = new Map<string, number>();
  for (const engrave of items) {
    const cs = executeProfile(tl, engrave.profile);
    try {
      const polygons = cs.toPolygons() as Polygons;
      polygonsById.set(engrave.id, polygons);
      areaById.set(engrave.id, polygons.length === 0 ? 0 : polygonsArea(tl, polygons));
    } finally {
      cs.delete();
    }
  }
  for (const item of items) {
    const itemArea = areaById.get(item.id) ?? 0;
    const itemPolygons = polygonsById.get(item.id);
    if (!(itemArea > CONTAINMENT_AREA_EPS_MM2) || itemPolygons === undefined) continue;
    let floor = 0;
    for (const container of items) {
      if (container.id === item.id) continue;
      if (container.through === true || container.variableDepth === true) continue;
      if (container.inlay !== undefined || container.prism !== undefined) continue;
      if (!(container.depth < item.depth - 1e-9) || !(container.depth > floor)) continue;
      const containerPolygons = polygonsById.get(container.id);
      if (containerPolygons === undefined || containerPolygons.length === 0) continue;
      const shared = intersectionArea(tl, containerPolygons, itemPolygons);
      // Wholly inside: the intersection is the item, up to polygonisation noise. A fixed 1 µm²
      // floor plus a relative part, so a big pocket's numerical drift does not unseat a label.
      if (shared >= itemArea - Math.max(CONTAINMENT_AREA_EPS_MM2, itemArea * 1e-6)) floor = container.depth;
    }
    if (floor > 0) floors.set(item.id, floor);
  }
  return floors;
}

/**
 * `tool` is HANDED IN (#305): this is worker-side, where neither the job store nor the tool
 * registry is visible, so the caller resolves it — `jobTool(job)` on the main thread, or
 * `toolForJob(job, tools)` from the list the preview was sent. One `Tool` object then feeds the
 * measurement, the findings, the CAM and the verifier, so the run can never disagree with itself
 * about which cutter it used.
 *
 * `shop` carries the caller's engrave shop defaults (#451); only the warn ratio is read here, since
 * this stage measures and finds rather than emitting a peck path. See {@link EngraveShopOpts}.
 *
 * `floors` is #748's supporting-floor map. The run computes it ONCE for the whole document
 * (`supportingFloors` on the full plan) and hands it to every program, because a program's sub-job
 * holds only its own items and would not see the pocket another setup cuts. Omitted, it is
 * computed from this call's own plan — the right answer for a whole-document caller (the preview,
 * a test) and for a single-setup job.
 */
export function engraveRegions(
  tl: ManifoldToplevel,
  job: EngraveJob,
  tool: Tool | null,
  margins: EngraveMargins = effectiveMargins(job, MARGIN_DEFAULTS),
  shop: EngraveShopOpts = {},
  machine: MillProfile | null = null,
  catalogue: readonly FeedCatalogueRow[] = [],
  /**
   * #677 — regions the DOCUMENT does not hold: the variable V-carve's cores, handed to the flat
   * cutter's program by the run's generator. They join the plan as ordinary engraves (see
   * `PartPlanOptions.derivedEngraves`), so everything below — the measurement, the CAM, the
   * prediction, the verifier — reads them exactly as it reads a drawn pocket.
   */
  derivedCores?: readonly CoreCut[],
  /** #748 — the whole document's supporting floors, or omitted to compute this plan's own. */
  floors?: ReadonlyMap<string, number>,
): EngraveRegions {
  const plan = toPartPlan(
    job,
    derivedCores === undefined || derivedCores.length === 0
      ? {}
      : {
          derivedEngraves: derivedCores.map((core) => ({
            id: core.id,
            name: core.name,
            profile: { kind: 'p-poly', contours: core.polygons },
            depth: core.depth,
          })),
        },
  );
  // #748 — THE FLOOR EACH ITEM SITS ON, one owner for the whole pipeline. Every plane below, the
  // merge findings, the cores and the prediction read this map; the run hands in the document's
  // map so a program's sub-job still knows the pocket another setup cuts.
  const floorById = floors ?? supportingFloors(tl, plan);
  const mill = machine ?? jobMachine(job);
  const perChar = perCharFor(job);
  // The cutter, split into the things the pipeline needs from it (#405, #221). `radius` is the
  // FLAT radius the region stages take: measuring a glyph's opening, opening it with an offset,
  // sweeping it into a drill disc. A V-bit has no single radius — its width is a function of
  // depth — so it answers null there, but since #221 it is no longer refused: the region stages
  // take its per-item PLANE radius (`rPlane`), and the measurement, the CAM and the oracle all use
  // that same number. A trace needs only the width at the trace's own depth (`traceRadiusAt`).
  const usable = tool === null ? null : cuttingForTrace(tool);
  const radius = usable !== null && usable.ok && usable.tool.shape === 'flat' ? usable.tool.radius : null;
  const cone = usable !== null && usable.ok && usable.tool.shape === 'v' ? usable.tool.cone : null;
  const traceRadius = tool === null ? null : (depth: number): number | null => traceRadiusAt(tool, depth);

  // Slice D — the step-over the feeds row asks for, resolved by the same function the CAM path
  // uses, with the same inputs (`job.cutOverride`, the shop's located table). The CAM resolves
  // feeds again at its own gate; this call exists so the clamp NOTE can name the number that was
  // actually asked for rather than a constant copied from the seed. A refusal here raises nothing:
  // the feeds gate owns that sentence, and the note is skipped.
  let requestedStepOver: number | null = null;
  if (cone !== null && tool !== null) {
    const requested = feedsFor(catalogue, job.stock.material, tool, mill, job.cutOverride, shop.feeds ?? undefined);
    if (requested.ok) requestedStepOver = requested.params.stepOver;
  }

  // #285 — the colour boundary, when the job states its print. PURE grid arithmetic (#285 review):
  // the boundary is a rule about the layer grid, not a measurement of the solid, so it is read
  // straight off `colourBoundaryFor` rather than by building the stack here and freeing it again.
  // Since #221 it is also the V-carve's colour plane `f`.
  const colourBoundaryDepth = colourBoundaryFor(plan, job);

  // The colour-plane geometry of every region, computed once: the measurement, the CAM, the
  // prediction, the preview and the merge warning all read these same numbers (#221).
  const planeById = new Map<string, VCarvePlane>();
  const engraveById = new Map(plan.engraves.map((e) => [e.id, e] as const));
  const planeRadiusFor = (labelId: string): number => {
    const engrave = engraveById.get(labelId);
    if (engrave === undefined || cone === null) return 0;
    const plane = vCarvePlane(
      cone,
      engrave.depth,
      colourBoundaryDepth,
      floorById.get(labelId) ?? 0,
    );
    // #673 — an INLAY has no colour plane: the flank is on the design at the TOP face and the
    // floor is the design eroded by the cut's whole depth, which is the variable carve's frame
    // with a flat cap. The plane radius is therefore `tip + depth·tan`, and the floor inset the
    // whole depth's slant. #748 — "the top face" is the surface the item sits on, so the depth is
    // the MATERIAL depth (`plane.material`), which is the whole depth on the stock top.
    //
    // #674 — a PRISM is the same convention for the same reason: its ring's boundary IS the mouth
    // at the top face (the shape's edge and the derived margin), so the flank stands on it and the
    // floor is the mouth eroded by the whole height's slant — which is what makes the base `base`
    // wide and the shape stand at full height.
    const effective =
      engrave.inlay !== undefined || engrave.prism !== undefined
        ? {
            ...plane,
            planeRadius: cone.tipRadius + plane.material * cone.tanHalf,
            floorInset: plane.material * cone.tanHalf,
            surfaceOutset: 0,
          }
        : plane;
    planeById.set(labelId, effective);
    return effective.planeRadius;
  };
  if (cone !== null) {
    for (const engrave of plan.engraves) planeRadiusFor(engrave.id);
  }

  // #240 slice 2 — a rotary job measures on its MAP, and the opening is ANISOTROPIC there
  // (R10): `r_t` along X, `r_t·R/(R − d)` around. The measurement reads the same radius/depth
  // pair `generateEngrave` scales the CAM by, so what the panel calls reachable and what the
  // file cuts cannot disagree. The flat path passes nothing and is unchanged.
  const rotaryMap = rotaryMapOf(job);
  // #737 — the neck for parting, as the plan places it. Null when the job is not rotary or has no
  // neck. The bands it must clear are the map's own, so the REFUSALS read this exact span
  // (`rotaryJobFindings`), the CAM cuts this exact span and the run sheet states it.
  const neck = rotaryNeckFacts(job);
  const wrapFor =
    rotaryMap === null
      ? undefined
      : (labelId: string): { radius: number; depth: number } => ({
          radius: rotaryMap.radius,
          depth: engraveById.get(labelId)?.depth ?? 0,
        });
  const measureRadius = radius ?? cone?.tipRadius ?? null;
  const measured =
    measureRadius === null
      ? []
      : measureLabels(
          tl,
          plan,
          measureRadius,
          job.edgeMargin,
          perChar,
          cone === null ? undefined : planeRadiusFor,
          wrapFor,
        );
  const ratioAt =
    cone === null
      ? ratioAtFor(tl, job, radius ?? 0)
      : ratioAtFor(tl, job, cone.tipRadius, planeRadiusFor);
  // #665 — the engravability measurement judges a region against ONE cutter width at the plane;
  // a variable-depth item's width follows its own design at every point, so its `item-empty`
  // (a plane radius of 0 on a point-tip bit) would refuse a cut that is entirely sound. #677 — a
  // DERIVED core is inside its parent design, so any breach it could report is the parent's
  // finding, said against a row that exists.
  const variableIds = new Set(plan.engraves.filter((e) => e.variableDepth === true).map((e) => e.id));
  // #673 — an inlay's floor is the design eroded by its own depth, not a cutter-width limit: the
  // opening ratio and the empty check describe a colour-plane carve it does not make.
  const inlayIds = new Set(plan.engraves.filter((e) => e.inlay !== undefined).map((e) => e.id));
  // #674 — a prism's flank is the cone's, so it is not a colour-plane carve either.
  const prismIds = new Set(plan.engraves.filter((e) => e.prism !== undefined).map((e) => e.id));
  const derivedIds = new Set((derivedCores ?? []).map((core) => core.id));
  // #740 — THE PLANE-MODEL ITEMS: the ones the colour-plane reach and groove findings judge. A
  // variable-depth carve (#665), an inlay (#673) and a prism (#674) have their own geometry — their
  // flank stands on the design at the top face, not at a colour plane — and a derived core (#677) is
  // the flat cutter's. Only these ask the cutter for ONE width at the plane, so only these can be
  // told "the cutter cannot reach it".
  const planeModelIds = new Set(
    plan.engraves
      .filter(
        (e) =>
          e.variableDepth !== true &&
          e.inlay === undefined &&
          e.prism === undefined &&
          !derivedIds.has(e.id),
      )
      .map((e) => e.id),
  );
  // #740 — a pointed cutter whose tip the record does not state has no width to judge an item with.
  // The cone both the measurement and the CAM read has a POINT there (#669), never the 3.175 mm
  // shank `cuttingDiameter` falls back to, so every plane sentence written from that fallback would
  // name a cutter that does not exist. Ask for the tip instead — ONE finding naming the cutter, the
  // field and its unit — and leave the plane model's sentences unsaid until it is recorded.
  const tipUnrecorded = tool !== null && planeModelIds.size > 0 && tipNotRecorded(tool);
  // #740 — THE CONE-CARVED ITEMS THE PLANE MODEL DOES NOT JUDGE: a variable-depth carve, an inlay
  // and a prism cut with the cone's flank, so `vCone` reads an unrecorded tip as the POINT it
  // assumes (#669). That plan is slightly DEEPER than a cutter with a real tip, and the operator is
  // entitled to know: a warning names the cutter and the assumption. It is not the plane model's
  // error — these items are not judged against the shank at all — so the two findings never
  // describe the same item.
  const assumedPointIds = new Set([...variableIds, ...inlayIds, ...prismIds].filter((id) => !derivedIds.has(id)));
  const tipAssumedPoint = tool !== null && assumedPointIds.size > 0 && tipNotRecorded(tool);
  const tipFindings: JobFinding[] = [
    ...(tipUnrecorded && tool !== null
      ? [
          {
            severity: 'error' as const,
            code: 'tool-tip-unrecorded' as const,
            message:
              `The cutter "${tool.name}" records no tip ⌀ (mm). A V-bit cuts with its tip — for a ` +
              'chamfer or an engraver the diameter field is its shank — so the width it reaches the ' +
              'design with is unknown. Record the tip ⌀ (mm) for this cutter in Manage → Tools or ' +
              'in the inventory’s cutter record, then regenerate.',
          },
        ]
      : []),
    ...(tipAssumedPoint && tool !== null
      ? [
          {
            severity: 'warning' as const,
            code: 'tool-tip-assumed-point' as const,
            message:
              `The cutter "${tool.name}" records no tip ⌀ (mm). Its variable-depth, inlay and ` +
              'prism cuts follow the cone, so the plan assumes a SHARP POINT (0 mm tip) and will ' +
              'cut slightly deeper than a cutter with a real tip. Record the tip ⌀ (mm) for this ' +
              'cutter in Manage → Tools or in the inventory’s cutter record to plan the tip ' +
              'itself, then regenerate.',
          },
        ]
      : []),
  ];
  const engFindings =
    tipUnrecorded || measured.length === 0
      ? []
      : engravabilityFindings(job, measured, ratioAt, tool, shop.lostDetailWarnRatio ?? null).filter(
          (f) =>
            f.labelId === undefined ||
            (!variableIds.has(f.labelId) && !inlayIds.has(f.labelId) && !derivedIds.has(f.labelId)),
        );

  // #739 — RAISED TEXT. A cutaway leaves its construction labels standing at full height; the
  // cutter opens the field with the SAME radius the region stage cuts it at (`measureRadius` for
  // a flat cutter, the V's plane radius otherwise), and the measurement asks whether the opening
  // lets the letters stay apart. The radius is captured as a const so the callback and the
  // measurement below cannot resolve two different cutters.
  const flatRadius = measureRadius;
  const raisedRadiusFor =
    flatRadius === null
      ? null
      : (cutawayId: string): number => (cone === null ? flatRadius : planeRadiusFor(cutawayId));
  const raisedMeasured =
    raisedRadiusFor === null ? [] : measureRaisedTexts(tl, job, plan.raisedTexts, raisedRadiusFor);

  // #171/#345 — the cut regions a void check reads are built ONCE, below: the engrave openings,
  // the swept traces (#270) and — since #218 — each cut-out's kerf. A void-free job is the common
  // case and pays for nothing here — sweeping the traces means wasm, and #205 calls this on a
  // debounce.

  const byId = new Map(measured.map((m) => [m.labelId, m] as const));
  /**
   * #665 — a region's DESIGN polygons. The measurement opens the region at the cutter's plane
   * radius; a VARIABLE-depth item has no single plane (a point-tip V on a blank with no film
   * measures a radius of 0), so its design is the profile itself — the ladder erodes it at each
   * level and the oracle reads the same set.
   */
  const designOf = (engrave: PartPlan['engraves'][number]): Polygons => {
    // #673 — an INLAY's design is the TOP boundary (the profile): its flank stands on the design
    // at the top face, so the measured opening at a plane is not the design. #674 — a PRISM's is
    // its RING's boundary, the same way.
    if (engrave.inlay !== undefined || engrave.prism !== undefined) {
      const cs = executeProfile(tl, engrave.profile);
      const polygons = cs.toPolygons() as Polygons;
      cs.delete();
      return polygons;
    }
    const measuredPolygons = byId.get(engrave.id)?.polygons;
    if (measuredPolygons !== undefined && measuredPolygons.length > 0) return measuredPolygons;
    if (engrave.variableDepth !== true) return [];
    const cs = executeProfile(tl, engrave.profile);
    const polygons = cs.toPolygons() as Polygons;
    cs.delete();
    return polygons;
  };
  const itemById = new Map<string, EngraveItem>();
  for (const l of job.labels) itemById.set(l.id, l);
  for (const s of job.shapes) itemById.set(s.id, s);

  // The three outlines of every V region (#221). `design` is the measured plane polygon set — the
  // CAM's own input — so the offsets here cannot disagree with the toolpath. The floor and the
  // surface are consequences of the cone; computing them once is what lets the prediction, the
  // preview and the merge warning read the same geometry.
  const vCarveById = new Map<string, VCarveRegion>();
  const designById = new Map<string, Polygons>();
  const surfaceById = new Map<string, Polygons>();
  if (cone !== null) {
    const offset = makeClipperOffset(tl);
    for (const engrave of plan.engraves) {
      const plane =
        planeById.get(engrave.id) ??
        vCarvePlane(cone, engrave.depth, colourBoundaryDepth, floorById.get(engrave.id) ?? 0);
      const design = designOf(engrave);
      if (design.length === 0) continue;
      // #584 — THE FLOOR IS WHAT THE TOOLPATH CAN REACH, not `design − floorInset`. The two are
      // the same on a broad face, but `pocketLoops` starts from `design − planeRadius` and the TIP
      // disc clears `(that) ⊕ tipRadius`; a component too small to survive the first erosion (the
      // badge's Ø0.61 dot against 0.3004) is DROPPED from the reach — and the `floorInset`
      // approximation still called it cut, which the oracle read as 0.0815 mm² of under-cut. With
      // the floor derived from the same two offsets the CAM takes, the prediction cannot promise
      // a floor the rings do not clear, at any precision.
      const floor = offset(offset(design, -plane.planeRadius), cone.tipRadius);
      const surface = plane.surfaceOutset > 0 ? offset(design, plane.surfaceOutset) : design;
      vCarveById.set(engrave.id, {
        plane: design,
        floor,
        surface,
        // #665 — the medial-axis carve: the CAM builds its ladder, and the oracle predicts the
        // ring at each level rather than this floor.
        ...(engrave.variableDepth === true ? { variable: true } : {}),
        // #673 — an inlay half: the CAM bounds the floor's pass pitch by the glue gap.
        ...(engrave.inlay === undefined ? {} : { inlay: engrave.inlay }),
        // #741 — a PRISM is out of the depth rule's scope (its height is #674's own bound), and
        // this marker is how the CAM's guard tells it from an ordinary V-carve.
        ...(engrave.prism === undefined ? {} : { prism: true as const }),
        // With no film (or a cut that never reaches it) the plane IS the floor, so the design
        // outline is drawn at the cut depth; otherwise it sits at the colour boundary.
        planeDepth: plane.film > 0 && engrave.depth >= plane.film ? plane.film : engrave.depth,
        planeRadius: plane.planeRadius,
        floorInset: plane.floorInset,
        surfaceOutset: plane.surfaceOutset,
        // #748 — the surface the item sits on. The preview draws the surface opening there, and the
        // variable ladder starts its depth map from it.
        ...(plane.floor > 0 ? { floorDepth: plane.floor } : {}),
      });
      designById.set(engrave.id, design);
      surfaceById.set(engrave.id, surface);
    }
  }

  // #677 — THE CORE. Where a variable-depth region is wider than its cap allows, the V's width
  // runs out before the middle and the deepest tip flat cannot reach in past
  // `coreOffsetRadius = 2·r1 + cap·tanHalf`. That middle is the flat bottom, and the setup's flat
  // end mill pockets exactly it at the cap in its own program. Derived here, from the SAME design
  // polygons the ladder carves, so the pocket's wall is tangent to the V's sloped flank at the
  // floor: the ring at the cap ends where the core begins.
  const cores: CoreCut[] = [];
  if (cone !== null) {
    const coreOffset = makeClipperOffset(tl);
    for (const engrave of plan.engraves) {
      if (engrave.variableDepth !== true) continue;
      const design = designById.get(engrave.id);
      if (design === undefined) continue;
      // #748 — the middle the V's width cannot reach is measured over the MATERIAL the item cuts:
      // a carve 2 mm into a 1 mm pocket floor leaves a core sized by its 1 mm cap, not its 2 mm
      // depth below the top face. The core itself still bottoms at the absolute `engrave.depth`,
      // which is where the flat cutter pockets it.
      const material = planeById.get(engrave.id)?.material ?? engrave.depth;
      if (!(material > 0)) continue;
      const polygons = coreOffset(design, -coreOffsetRadius(cone, material));
      if (polygons.length === 0) continue;
      const cs = tl.CrossSection.ofPolygons(polygons);
      const areaMm2 = cs.area();
      cs.delete();
      // Below a square millimetre the "core" is polygonisation dust between the wall and the tip
      // flat, not floor worth a program of its own — the same bar the #665 warning kept.
      if (!(areaMm2 > CORE_MIN_AREA_MM2)) continue;
      cores.push({
        id: `core:${engrave.id}`,
        of: engrave.id,
        ofName: engrave.name,
        name: `Core clearance of ${engrave.name}`,
        depth: engrave.depth,
        polygons,
        areaMm2,
      });
    }
  }
  const carveFindings =
    cone === null || tool === null || tipUnrecorded
      ? []
      : vCarveFindings(
          tl,
          plan,
          tool,
          cone,
          mill,
          planeById,
          designById,
          surfaceById,
          requestedStepOver,
        );
  // #741 — the depth rule runs whatever the tip's record state: a cutter with no stated tip still
  // has a stated body and angle, and a V-cut past its cone is refused on those.
  const depthFindings = tool === null ? [] : vCarveDepthFindings(plan, tool);

  // #218 — CUT-OUTS: each one's offset centre path, its tab spans, the kerf the oracle expects
  // and the finding a tab that could not be placed raises. Built here, with the same injected
  // offset the region CAM uses, so the path CAM cuts, the path the verifier's mask tests and the
  // region the oracle expects are one geometry rather than three derivations.
  const throughDepth = plan.stock.thickness + job.breakthrough;
  const profiles: ProfileCut[] = [];
  const cutoutMask: MaskCutout[] = [];
  const cutoutCuts: CutRegion[] = [];
  const cutoutPredicted: OraclePredicted[] = [];
  const tabFindings: JobFinding[] = [];
  // #218/#750 — the bottom face's removal for the loose-piece analysis: each CONTOUR's kerf,
  // less the material that contour's own placed tabs keep, and each cut-out that cut itself free.
  // The tabs are kept as BRIDGES (#750): the kerf's width plus a whisker either side, so the
  // difference joins the part to the waste by area, not only along the kerf's own edges — an
  // imported outline's off-axis edge is a rounding away from the band, and the tab it was meant
  // to keep then reads as a loose 38 mm² piece. The bridge follows the span's own points (#736),
  // so on an arc it curves with the path. The difference is per CONTOUR, not per cut-out:
  // two contours can run a diameter apart, and the neighbour's pass removes material across this
  // tab's bridge. Subtracting all of a cut-out's tabs from all of its kerfs would punch that
  // material back into the neighbour's band and hold a part that is really free (#750 bounce).
  // Faces are combined by UNION after each keeps its own difference. A cut-out with every
  // requested tab unplaceable is free too, even though `released-onto-board` is not raised for
  // it — the error is `tab-unplaceable`; either way the part's disconnection is expected, not a
  // second finding.
  const cutoutFaces: { kerf: Polygons; tabs: Polygons }[] = [];
  const cutoutReleased: Polygons[] = [];
  // #711 — THE PIECES THE TAPE MUST HOLD. A released cut-out is a piece tape holds INSTEAD of
  // tabs, and its tape area is its footprint eroded by the job's tape inset (the strips stop
  // inside every edge). Measured here, where the geometry is; judged where the cutter's bite is
  // known (`generateOneProgram`).
  const tapeInset = job.workholding.kind === 'tape' ? job.workholding.tape.inset : null;
  const releasedPieces: TapedPiece[] = [];
  if (radius !== null && plan.cutouts.length > 0) {
    const offset = makeClipperOffset(tl);
    for (const c of plan.cutouts) {
      const outlineCS = executeProfile(tl, c.outline);
      const outline = outlineCS.toPolygons() as Polygons;
      outlineCS.delete();
      if (outline.length === 0) {
        // #218 — a referenced outline that resolves to nothing has no path to cut. Without this
        // finding the cut-out would vanish from the program with no sentence saying why.
        tabFindings.push({
          severity: 'error',
          code: 'cutout-empty',
          labelId: c.id,
          message:
            `${c.name} cannot follow its outline: the item it references resolves to an empty ` +
            'region, so there is no part to cut out.',
        });
        continue;
      }
      const path = profilePath(outline, c.side, radius, c.inset, offset);
      if (path.length === 0) {
        // #218 — the offset consumed the outline: `profilePath` returns [] and the cut-out would
        // silently disappear. The common case is a `stock-inset` larger than half the blank.
        tabFindings.push({
          severity: 'error',
          code: 'cutout-empty',
          labelId: c.id,
          message:
            `${c.name} cannot be cut: its ${c.inset} mm inset on the ${c.side} of the outline, ` +
            'together with the cutter radius, leaves no path to follow. Reduce the inset or ' +
            'choose a larger outline.',
        });
        continue;
      }
      const spans: ProfileSpan[][] = [];
      let placed = 0;
      let unplaceable = 0;
      for (const contour of path) {
        const placement = placeTabs(contour, c.tabs.count, c.tabs.width, radius);
        spans.push(placement.spans);
        placed += placement.spans.length;
        unplaceable += placement.unplaceable;
      }
      profiles.push({
        id: c.id,
        name: c.name,
        path,
        depth: c.depth,
        thickness: c.thickness,
        tabs: { count: c.tabs.count, width: c.tabs.width, height: c.tabs.height },
      });
      cutoutMask.push({ path, spans, toolRadius: radius, tabHeight: c.tabs.height });
      if (unplaceable > 0) {
        tabFindings.push({
          severity: 'error',
          code: 'tab-unplaceable',
          labelId: c.id,
          message:
            `Cut-out "${c.name}" asks for ${c.tabs.count} holding tabs ${c.tabs.width} mm wide, ` +
            `but ${unplaceable} could not be placed: the cut path has no straight or smoothly ` +
            `curved edge with enough free length to hold ${unplaceable === 1 ? 'it' : 'them'}. The part ` +
            `would be released where ${unplaceable === 1 ? 'that tab was' : 'those tabs were'} ` +
            'meant to hold it. Use a smaller tab width or count, or a larger outline.',
        });
      }
      const kerf = kerfPolygons(path, radius, offset);
      const tabTop = c.thickness - c.tabs.height;
      for (let i = 0; i < path.length; i++) {
        cutoutFaces.push({
          kerf: kerfPolygons([path[i]!], radius, offset),
          tabs: tabBridgeRectangles(spans[i] ?? [], radius),
        });
      }
      // The part a released cut-out frees is the area ENCLOSED by its centre path. `path` is CW
      // for an inside profile, so it is put back to a fillable winding first: a CW outer reads as
      // empty in the loose-piece cross-section and the part would be counted as the loose piece.
      if (placed === 0) {
        const piece = enclosedPath(path);
        cutoutReleased.push(piece);
        if (tapeInset !== null && radius !== null) {
          // The refusal names the ITEM ("“Star”"), not the operation phrase the program carries.
          const itemName = job.cutouts?.find((x) => x.id === c.id)?.name ?? c.name;
          const measured = measureTapedPiece(tl, itemName, piece, tapeInset, radius);
          if (measured !== null) releasedPieces.push(measured);
        }
      }
      cutoutCuts.push({
        id: c.id,
        name: c.name,
        depth: c.tabs.count > 0 ? tabTop : c.depth,
        polygons: kerf,
        // #218 — the kerf leaves the blank, so a void under it is an ERROR in the void check.
        through: true,
        cutout: true,
      });
      // Two levels, as the oracle needs them: the whole kerf is cut down to the tab top, and the
      // deep passes remove it everywhere except what the interrupted pass leaves standing. That
      // kept region is the swept band less the two end discs (`tabKeptRegions`) — the band follows
      // the span's own path (#736), so an arc tab's is curved — because the sweep stops with a
      // round cutter and the oracle compares against the removal the file really makes.
      if (c.tabs.count > 0) {
        const keptPredicted = spans.flatMap((one) => tabKeptRegions(tl, one, radius));
        cutoutPredicted.push({ depth: tabTop, polygons: kerf, itemId: c.id });
        cutoutPredicted.push({ depth: c.depth, polygons: [...kerf, ...keptPredicted], itemId: c.id });
      } else {
        cutoutPredicted.push({ depth: c.depth, polygons: kerf, itemId: c.id });
      }
    }
  }

  // #171/#345 — the cut regions a void check reads, built ONCE: the engrave openings, the swept
  // traces (#270) and each cut-out's KERF (#218). The cut-outs join only now, when their geometry
  // exists, so a declared void under a kerf is seen by the same scan as one under a pocket.
  const voidCuts: CutRegion[] =
    plan.stock.keepOuts.length === 0
      ? []
      : [
          ...engraveCutRegions(plan, measured),
          ...(traceRadius === null ? [] : traceCutRegions(tl, plan, traceRadius)),
          ...cutoutCuts,
        ];

  // #345 decision B — ONE scan decides which void binds each region, and BOTH stages read it: the
  // per-move warning (#171) and the per-item bound, so the banner and the item cannot name
  // different voids for the same overlap.
  const bindingVoids = bindingVoidsByRegion(tl, job, plan, voidCuts, margins.boundaryMargin);
  const voidFindings = keepOutFindings(job, voidCuts, bindingVoids);

  // `job.sacrificial` is threaded so the generate path's `vise-grip-shallow` judges what the
  // jaws actually grip (#213 §2), not the raw stock: the argument `validateVise` has accepted
  // since `454110a` but this call never passed.
  // #434 — the point angle the DRILL findings are judged with: the caller's resolved settings,
  // else the labelled fallback (never a silent literal). It is the same reading `planDrillBit`
  // takes, so the depth a finding accepts and the depth a program cuts cannot disagree.
  const drillResolved = shop.drill ?? drillSettings(shop.defaults ?? null);
  const findings = dedupeFindings([
    ...validateJob(
      job,
      { deg: drillResolved.settings.pointAngleDeg, source: drillResolved.sources.pointAngleDeg },
      { derivedCores: derivedCores?.length ?? 0, bed: shop.bed ?? null, defaults: shop.defaults },
    ),
    // #240 — the vise's validator is the VISE's; a rotary job's holding findings are slice 3's.
    ...(job.workholding.kind === 'vise'
      ? validateVise(job.stock, job.workholding.vise, job.sacrificial)
      : []),
    // #240 slice 2 — the surface wrap's own document checks: a floor at or past the axis, a cut
    // class the wrap does not cut yet, and an item opening that reaches into either end band (at
    // its row). `measured` carries each item's OPENED region in map millimetres. Empty for a flat
    // job.
    ...rotaryJobFindings(job, plan, measured),
    // #740 — the tip the record does not state, in place of the plane sentences that would have
    // read the shank as the cutter.
    ...tipFindings,
    ...engFindings,
    ...raisedTextFindings(raisedMeasured, tool),
    ...metalLineFindings(job, tool, catalogue),
    // #741 — a V-cut past the cutter's cone is not a V, so it is refused by name before the CAM.
    ...depthFindings,
    ...carveFindings,
    ...voidFindings,
    // #345 — every item judged against every bound under its footprint: the split on the side its
    // own `depthIntent` put it, and the ceiling of any void it sits over. A no-op for a job with
    // neither.
    ...itemDepthBoundFindings(job, colourBoundaryDepth, margins.boundaryMargin, bindingVoids),
    // #218 — a tab the CAM could not place on any edge.
    ...tabFindings,
  ]);

  const regions: EngraveRegion[] = plan.engraves.map((e) => {
    const vCarve = vCarveById.get(e.id);
    return {
      id: e.id,
      text: regionText(itemById.get(e.id)),
      name: e.name,
      depth: e.depth,
      polygons: designOf(e),
      ...(vCarve === undefined ? {} : { vCarve }),
      ...(e.inlay === undefined ? {} : { inlay: e.inlay }),
      ...(e.through === true ? { through: true as const } : {}),
    };
  });

  // Plunge drills (#220): a region whose cut is the cutter's own disc per hole, so the preview
  // and the oracle see it exactly as the CAM will cut it. A `through` hole (#218) is no longer
  // refused: its floor is the board, `thickness + breakthrough`, and its region carries the flag
  // that makes the operation a `'through'` pass.
  //
  // #434 — a DRILL BIT is refused by `cuttingForTrace` (no flat radius), but its discs are the
  // FULL diameter below the point, so the region takes `cuttingDiameter / 2`: the preview and the
  // oracle then see the hole the bit cuts, not an empty entry.
  const drillToolRadius =
    tool !== null && tool.shape === 'drill' ? (cuttingDiameter(tool) ?? 0) / 2 || null : null;
  for (const d of plan.drills) {
    // #668 — A BORE'S disc is the HOLE's, not the cutter's: the preview and the oracle see the
    // cylinder the job asked for. A bore that states no diameter records itself as a bore at the
    // cutter's radius, so the CAM refuses the pair by name rather than plunging a cutter-wide hole
    // the job never asked for.
    const boreRadius =
      d.mode === 'bore'
        ? d.diameter !== null && d.diameter > 0
          ? d.diameter / 2
          : (radius ?? drillToolRadius ?? 0)
        : null;
    const drillRadius = boreRadius ?? radius ?? drillToolRadius;
    const depth = d.through ? throughDepth : d.depth;
    regions.push({
      id: d.id,
      text: '',
      // The diameter is only known once the tool is resolved, so the region builder appends it —
      // the same division of labour `toPartPlan` documents (#220).
      name: drillRadius === null ? d.name : `${d.name} ⌀${drillRadius * 2}`,
      depth,
      polygons: drillRadius === null ? [] : drillPolygons(tl, d.holes, drillRadius),
      drill: {
        holes: d.holes.map(([x, y]) => [x, y] as [number, number]),
        ...(boreRadius === null ? {} : { bore: { radius: boreRadius } }),
        // #675 — the item's own peck, when it states one; the CAM prefers it over the feeds row.
        ...(d.peckMm === undefined ? {} : { peckMm: d.peckMm }),
      },
      // #668 — a through bore's level list includes the BLANK's bottom, so it clears its core to
      // the underside before the cutter crosses it (a level is added at `stockThickness`); no
      // other cut reads it.
      ...(d.through ? { through: true as const, stockThickness: job.stock.thickness } : {}),
    });
  }

  // #287 — a single-line trace cuts the region its cutter SWEEPS (#270): one entry per trace, at
  // the trace's own floor. The builder is the same `traceCutRegions` the void warning uses, so the
  // warning, the oracle and the picture cannot disagree about where a trace cuts. Empty — a no-op —
  // when the job has no trace or no usable cutter, the same "nothing measured" rule as above.
  //
  // The list is `cuts` rather than a private array because it is the ONE place the cut classes are
  // enumerated (#288): the prediction below and `engravePreview`'s picture are both its projection,
  // so a fourth class (#218's cut-outs) lands in the program, the oracle and the preview together.
  const traceCuts: CutRegion[] = traceRadius === null ? [] : traceCutRegions(tl, plan, traceRadius);
  // #669 — CHAMFERS: one closed bevel each, along its rim's edge. The EDGE is the cut-out's own
  // rim (its side and inset travel with the cut-out item) or a pocket's wall; the TOOL PATH is
  // that edge offset by the TIP RADIUS on the air side — the one offset that puts the cone's
  // flank on the bevel and keeps the tip's flat out of the wall (see `cam/chamfer.ts`). The tip
  // plane is the bevel's bottom, `width / tan(halfAngle)` down.
  //
  // THE PREDICTION AND THE PICTURE ARE THE SWEPT BAND, not just the bevel. At a level `d` the
  // cone's cross-section is a disc of `tipRadius + (h − d)·tan(halfAngle)` around the tool path,
  // so what the simulator removes there is a band on BOTH sides of the path — and the offcut side
  // is still solid when a part's edge is chamfered (the chamfer runs before the profile), so that
  // gouge is real material taken out. A pocket's rim is the other case: the tool runs over the
  // pocket's air, and only the bevel side is material. The band is clipped to the blank, because
  // a chamfer at the stock's own edge hangs the cutter over air.
  const chamferCone = tool === null ? null : vCone(tool);
  const chamferCuts: ChamferCut[] = [];
  const chamferRings: CutRegion[] = [];
  const chamferPredicted: OraclePredicted[] = [];
  if (chamferCone !== null && plan.chamfers.length > 0) {
    const offset = makeClipperOffset(tl);
    const CS = tl.CrossSection;
    const stockCS = executeProfile(tl, plan.stock.outline);
    const stockRect = CS.ofPolygons(stockCS.toPolygons() as Polygons);
    stockCS.delete();
    const clipped = (polygons: Polygons): Polygons => {
      if (polygons.length === 0) return [];
      const cs = CS.ofPolygons(polygons);
      const both = cs.intersect(stockRect);
      const out = both.toPolygons() as Polygons;
      both.delete();
      cs.delete();
      return out;
    };
    /**
     * The band the cone removes at a level whose bevel is `bevel` mm wide. A POCKET's rim loses the
     * bevel OUTSIDE its wall — the tool runs over the pocket's air and only the material side is
     * cut, from the edge out to the bevel's line. A PART's edge loses both: the bevel into the
     * part, and the cone's gouge into the offcut out to `2·tipRadius + bevel` (the offcut is still
     * solid when the chamfer runs before the profile).
     */
    const sweptBand = (edge: Polygons, side: 'outside' | 'inside', bevel: number): Polygons => {
      if (!(bevel > 0) || edge.length === 0) return [];
      const inner = side === 'outside' ? offset(edge, -bevel) : edge;
      const outer = side === 'outside' ? offset(edge, 2 * chamferCone.tipRadius + bevel) : offset(edge, bevel);
      const a = CS.ofPolygons(outer);
      const b = CS.ofPolygons(inner);
      const d = a.subtract(b);
      const out = clipped(d.toPolygons() as Polygons);
      d.delete();
      a.delete();
      b.delete();
      return out;
    };
    /**
     * The rim's edge as a REGION: outer rings only, CCW, at the cut-out's own inset on its side.
     * (`profilePath` is the CAM's path builder — it reverses an inside path to the milling
     * direction, which is a MOVE order, not a fill — so the band arithmetic above does its own
     * offset here and keeps the winding a polygon set is read with.)
     */
    const edgeRegion = (outline: Polygons, side: 'outside' | 'inside', inset: number): Polygons => {
      const raw = inset > 0 ? offset(outline, side === 'outside' ? inset : -inset) : outline;
      return raw.filter((contour) => contour.length >= 3 && signedArea(contour) > 1e-9);
    };
    for (const c of plan.chamfers) {
      const outlineCS = executeProfile(tl, c.outline);
      const outline = outlineCS.toPolygons() as Polygons;
      outlineCS.delete();
      if (outline.length === 0) continue;
      // The edge is the rim's own outline; the chamfer states which side the cutter runs.
      const edge = edgeRegion(outline, 'outside', 0);
      if (edge.length === 0) continue;
      const toolSide: 'outside' | 'inside' = c.side;
      // The path is a TIP RADIUS off the edge on the air side. A point tip puts it ON the edge,
      // where an offset of 0 is not a call worth making (Clipper's zero delta is not an identity);
      // the winding still follows the profile CAM's convention.
      const path =
        chamferCone.tipRadius > 0
          ? profilePath(edge, toolSide, chamferCone.tipRadius, 0, offset)
          : toolSide === 'inside'
            ? edge.map((contour) => [...contour].reverse())
            : edge;
      if (path.length === 0) continue;
      const depth = c.width / chamferCone.tanHalf;
      chamferCuts.push({ id: c.id, name: c.name, path, depth });
      // The picture shows the bevel's MOUTH at the top face.
      chamferRings.push({ id: c.id, name: c.name, depth, polygons: sweptBand(edge, c.side, c.width) });
      // The oracle judges the band at the shallow level the groove prediction uses — the widest
      // section, where a wrong offset or width shows. The bevel has closed to `1 − fraction` of
      // its width there.
      const shallow = ORACLE_SHALLOW_DEPTH_FRACTION * depth;
      chamferPredicted.push({
        depth: shallow,
        polygons: sweptBand(edge, c.side, (depth - shallow) * chamferCone.tanHalf),
        itemId: c.id,
      });
    }
    stockRect.delete();
  }

  const cuts: CutRegion[] = [...regions, ...traceCuts, ...cutoutCuts, ...chamferRings];

  // #408 — a V TRACE's PREDICTION is a groove, not a region. What a cone removes at a level depends
  // on how far below its tip that level is, so a trace entry cannot be the mouth's polygon set the
  // picture uses: at the trace's own floor that set is 3x too wide and the oracle would call the
  // real cut an under-cut. The entry carries the cone and the CAM's OWN passes instead (a bold
  // stroke arrives at `plan.traces` already widened into parallel passes), and the oracle dilates
  // them by the reach at each level — the mouth at the top face, the tip's own flat at the floor.
  //
  // So the two tool shapes produce the prediction DIFFERENTLY rather than one supplementing the
  // other: a flat cutter keeps `traceCutRegions`' region, and a cone replaces it. Adding the groove
  // beside the mouth would predict both at once and fail every V job on the overlap.
  const predicted: OraclePredicted[] = [
    // A V region's prediction is its FLOOR at `depth` — the floor polygons the geometry built,
    // not the plane design. The oracle simulates at the floor and would call the wider design an
    // under-cut (#221). A flat region's floor IS its polygons.
    // #669 — a V region's FLOOR is its own level's answer; above it the cone is wider, so the
    // entry carries the flank's tan and the oracle grows the section per level.
    //
    // #665 — a VARIABLE-depth region has no single floor: its answer at level `d` is the design
    // eroded by `d·tanHalf` MINUS the core the cap cannot reach, and that ring is exact at any
    // level because every deeper pass's outer flank lies on the same wall line. Two levels are
    // predicted — the cap and a shallow tenth — and the `vRegion` growth is NOT set: the entries
    // already ARE the mouth at their depth, and growing them would double-count.
    ...regions.flatMap((c): OraclePredicted[] => {
      if (c.vCarve?.variable === true && cone !== null) {
        const design = c.polygons;
        // #748 — the median carve runs over the MATERIAL under the surface it sits on: the cap is
        // `depth − floor`, and the levels the oracle is told about are ABSOLUTE depths below the
        // top face (`floor + level`), because that is the datum the sweep slices at.
        const floor = floorById.get(c.id) ?? 0;
        const cap = c.depth - floor;
        if (!(cap > 0)) return [];
        const carveOffset = makeClipperOffset(tl);
        const ringAt = (level: number): Polygons => {
          // The removal at level z is ONE ring: the wall's lower part from `z·tan` in, through the
          // deepest pass's flat swath, to where its INNER flank has risen back to this level —
          // `(2·cap − z)·tan + 2·r1` from the boundary. Beyond that the inner mound stands — the
          // CORE — and the flat end mill's own program pockets it at the cap (#677).
          const outer = carveOffset(design, -level * cone.tanHalf);
          const innerBoundary = (2 * cap - level) * cone.tanHalf + 2 * cone.tipRadius;
          const inner = carveOffset(design, -innerBoundary);
          if (inner.length === 0 || outer.length === 0) return outer;
          const CS = tl.CrossSection;
          const a = CS.ofPolygons(outer);
          const b = CS.ofPolygons(inner);
          const d = a.subtract(b);
          const out = d.toPolygons() as Polygons;
          d.delete();
          a.delete();
          b.delete();
          return out;
        };
        return [cap * ORACLE_SHALLOW_DEPTH_FRACTION, cap].map(
          (level): OraclePredicted => ({ depth: floor + level, polygons: ringAt(level), itemId: c.id }),
        );
      }
      return [
        {
          depth: c.depth,
          polygons: c.vCarve?.floor ?? c.polygons,
          itemId: c.id,
          ...(c.vCarve !== undefined && cone !== null
            ? {
                vRegion: {
                  tanHalf: cone.tanHalf,
                  // #741 — the flank stops growing where it meets the bit's body (a vertical wall
                  // above it, never a wider V). Absent when the record states no wider diameter.
                  ...(cone.outerRadius === undefined
                    ? {}
                    : { maxGrow: cone.outerRadius - cone.tipRadius }),
                },
              }
            : {}),
        },
      ];
    }),
    ...(cone === null
      ? traceCuts.map((c): OraclePredicted => ({ depth: c.depth, polygons: c.polygons, itemId: c.id }))
      : plan.traces.flatMap((t): OraclePredicted[] => {
          // #674 — a FLUTE is predicted per SEGMENT at the segment's END depth, because that is
          // exactly what both sweep engines remove: a move is applied at its own Z. The entry is
          // the same #408 groove, just one segment wide, so nothing here re-derives the cone.
          if (t.depths === undefined) {
            return [{ depth: t.depth, polygons: [], itemId: t.id, groove: { paths: t.paths, closed: t.closed, cone } }];
          }
          const entries: OraclePredicted[] = [];
          for (let pi = 0; pi < t.paths.length; pi++) {
            const path = t.paths[pi]!;
            const depths = t.depths[pi];
            if (depths === undefined || path.length === 0) continue;
            const last = (t.closed[pi] ?? false) ? path.length : path.length - 1;
            for (let j = 0; j < last; j++) {
              // The move's DEEP end: `flatMovesOf` sweeps a segment at `min(z0, z1)` (#629), and Z
              // is NEGATIVE, so that is the DEEPER of the two points — `max` of the positive
              // depths. Predicting the shallow end's would leave the sim removing a sliver the
              // entry never promised.
              const depth = Math.max(depths[j] ?? 0, depths[(j + 1) % path.length] ?? 0);
              if (!(depth > 0)) continue;
              entries.push({
                depth,
                polygons: [],
                itemId: t.id,
                groove: {
                  paths: [[[path[j]![0], path[j]![1]], [path[(j + 1) % path.length]![0], path[(j + 1) % path.length]![1]]]],
                  closed: [false],
                  cone,
                },
              });
            }
          }
          return entries;
        })),
    // #218 — a cut-out's kerf at the tab top, and the same kerf less its kept tab bands at the
    // through depth. Every placed tab is subtracted; an unplaced one is not, and its material is
    // correctly predicted as cut away.
    ...cutoutPredicted,
    // #669 — a chamfer's wedge is predicted as the RING the bevel removes at the shallow level.
    ...chamferPredicted,
    // #737 — the neck is predicted as the BAND its cut leaves at the floor's full depth, all the
    // way round: the same rectangle the CAM's outer ring reaches (seam included). An itemId that is
    // not a document item keeps it out of the per-item reports; the oracle reads the polygons.
    ...(neck === null || rotaryMap === null || !(neck.depthMm > 0)
      ? []
      : [
          {
            depth: neck.depthMm,
            polygons: rotaryNeckBand(rotaryMap, neck),
            itemId: ROTARY_NECK_ID,
          } satisfies OraclePredicted,
        ]),
  ];

  // #218 — the verifier's through mask, built from the SAME geometry: every through region's
  // opened polygons (a through drill's discs are its region) and each cut-out's kerf with its
  // tab spans capped at the tab top. Null when the job has no through work, so `jobDepthLimit`
  // reads exactly as it did before this feature.
  // A through DRILL's point reaches below its full diameter, and the file's deepest move is the
  // tip: the mask allows exactly the tip depth `planDrillBit` computes (the same post-rounded
  // value), or a drill program would be refused by its own verifier. A flat end mill's through
  // hole has no point, so it adds nothing.
  const drillFallback = shop.drill ?? drillSettings(shop.defaults ?? null);
  const drillPoint =
    tool !== null && tool.shape === 'drill'
      ? drillPointAngle(tool, {
          deg: drillFallback.settings.pointAngleDeg,
          source: drillFallback.sources.pointAngleDeg,
        })
      : null;
  const drillDiameter = tool === null ? null : tool.tipDiameter ?? tool.diameter;
  const drillExtraDepth =
    drillPoint !== null && drillPoint.ok && drillDiameter !== null
      ? Math.max(
          0,
          Math.round((throughDepth + pointLength(drillDiameter, drillPoint.deg)) * 1000) / 1000 -
            throughDepth,
        )
      : 0;
  const throughMask = buildThroughMask({
    thickness: plan.stock.thickness,
    breakthrough: job.breakthrough,
    regions: regions
      .filter((r) => r.through === true)
      .map((r) => ({
        polygons: r.polygons,
        ...(r.drill === undefined ? {} : { extraDepth: drillExtraDepth }),
      })),
    cutouts: cutoutMask,
  });

  // #218 — what the through cuts disconnect: the check runs here, where Manifold is loaded, and
  // reads the SAME polygons the cut classes above were built from. A job with no through work is
  // a no-op (no removal polygons).
  const looseFindings = loosePieceFindings(
    tl,
    job.stock,
    regions.filter((r) => r.through === true).map((r) => r.polygons),
    cutoutFaces,
    cutoutReleased,
  );

  return {
    plan,
    measured,
    regions,
    profiles,
    throughMask,
    cuts,
    chamfers: chamferCuts,
    cores,
    floors: Object.fromEntries([...floorById].filter(([, floor]) => floor > 0)),
    predicted,
    neck,
    tool,
    radius,
    findings: [...findings, ...looseFindings],
    releasedPieces,
    colourBoundaryDepth,
    margins,
  };
}

/**
 * #218 — the LOOSE-PIECE check, done where the wasm lives.
 *
 * A through cut removes material from the bottom face: a through pocket or drill leaves a hole,
 * and a cut-out leaves its kerf less the material its placed tabs keep (`cutoutFaces`). The blank
 * is what is left of the stock after those removals; `decompose()` splits it into its topologically
 * disconnected parts. One part is the blank its tape/glue holds. Any OTHER part with positive area
 * moves when the cutter touches it.
 *
 * Each CONTOUR's tabs are SUBTRACTED from that contour's own kerf, explicitly, and the resulting
 * faces are unioned (#750). Two contours can run close enough that one's pass removes material
 * across the other's tab; cancelling the tab against a union of all removals would punch that
 * material back out of the neighbour's band and hold a part that is really free. Winding is a
 * property of the caller's contour, not of the material, so the kept region is normalised and
 * filled on its own (a union of the bridges, overlapping ones included) before the difference.
 * `tabBridgeRectangles` widens each bridge a whisker past the band, so the subtraction cannot be
 * decided by two coincident edges; following the span's own points (#736), the bridge curves with
 * an arc.
 *
 * A cut-out the job deliberately released (no tabs placed) is expected to be one of those parts:
 * it is the piece the operator asked to cut out, and `released-onto-board` (or the error
 * `tab-unplaceable`) already says so. Its region is the area enclosed by the centre path, so a
 * component that lies wholly inside one of those regions is that part, not a second finding.
 * Everything else is reported, once, as `loose-piece`.
 *
 * The 2D bottom face is the right test: every cut here passes through the full thickness, and a
 * tab is material at the bottom, so connectivity at the bottom is connectivity of the solid.
 * A declared void leaves the material at the bottom in place and therefore never appears.
 */
function loosePieceFindings(
  tl: ManifoldToplevel,
  stock: { length: number; width: number },
  throughPolygons: readonly Polygons[],
  cutoutFaces: readonly { kerf: Polygons; tabs: Polygons }[],
  releasedParts: readonly Polygons[],
): JobFinding[] {
  const removalPolygons = [...throughPolygons, ...cutoutFaces.map((face) => face.kerf)].flat();
  if (removalPolygons.length === 0) return [];
  const CS = tl.CrossSection;
  // Every wasm handle made here is deleted in the `finally`, decompose()'s children included.
  const owned: { delete(): void }[] = [];
  const own = <T extends { delete(): void }>(value: T): T => {
    owned.push(value);
    return value;
  };
  try {
    const stockCS = own(CS.square([stock.length, stock.width]));
    // The through cuts first, then each contour's kerf less its own tabs. Kept apart rather than
    // unioned into one polygon set, because a tab keeps material only the kerf it belongs to
    // passed over: a neighbour's pass through the same place still removes it.
    let removal: ReturnType<typeof CS.ofPolygons> | null =
      throughPolygons.flat().length === 0 ? null : own(CS.ofPolygons(throughPolygons.flat()));
    for (const face of cutoutFaces) {
      const kerf = own(CS.ofPolygons(face.kerf));
      // `enclosedPath` puts every bridge CCW so the default positive fill is their UNION: two
      // bridges that overlap keep the overlap, rather than XOR-ing it out (#750).
      const cut =
        face.tabs.length === 0
          ? kerf
          : own(kerf.subtract(own(CS.ofPolygons(enclosedPath(face.tabs)))));
      removal = removal === null ? cut : own(removal.add(cut));
    }
    if (removal === null) return [];
    const remaining = own(stockCS.subtract(removal));
    const parts = remaining.decompose().map(own);
    const areas = parts.map((part) => part.area());
    if (areas.filter((area) => area > 1e-6).length <= 1) return [];

    // The deliberately released parts are classified OUT first. A component that IS one of those
    // parts leaves (almost) nothing once they are subtracted; a millimetre-scale tolerance absorbs
    // the kerf's float arithmetic. Doing this before choosing the main part matters: the piece the
    // operator asked to cut out can be LARGER than the frame left around it, and the frame is the
    // material the mount holds however small it is. The largest of what remains is that body.
    const freeCS =
      releasedParts.length === 0 ? null : own(CS.ofPolygons(releasedParts.flat()));
    const countable: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (areas[i]! <= 1e-6) continue;
      if (freeCS !== null) {
        const rest = own(parts[i]!.subtract(freeCS));
        if (rest.area() <= Math.max(1e-3, areas[i]! * 1e-3)) continue;
      }
      countable.push(i);
    }
    if (countable.length <= 1) return [];
    // The largest remaining part is the blank's body; a severed chunk is what this check is
    // looking for. (If a cut leaves two similar halves, one of them is reported — the operator
    // needs to know either way.)
    let main = countable[0]!;
    for (const i of countable) if (areas[i]! > areas[main]!) main = i;
    let pieces = 0;
    let areaMm2 = 0;
    for (const i of countable) {
      if (i === main) continue;
      pieces++;
      areaMm2 += areas[i]!;
    }
    if (pieces === 0) return [];
    return [
      {
        severity: 'error',
        code: 'loose-piece',
        message:
          `The through cuts leave ${pieces === 1 ? 'a piece' : `${pieces} pieces`} of the blank ` +
          `(${fmtArea(areaMm2)}) disconnected from the material the mount holds. ` +
          `${pieces === 1 ? 'It' : 'They'} can move under the cutter after being freed; leave a ` +
          'connecting bridge of material, move the cut away from the blank’s edges, or add holding tabs.',
      },
    ];
  } finally {
    for (const handle of owned) handle.delete();
  }
}

/** A printed area for a finding, in mm²: one decimal below 10, whole numbers above. */
function fmtArea(mm2: number): string {
  return `${mm2 < 10 ? mm2.toFixed(1) : Math.round(mm2)} mm²`;
}

/** Count what the panel reports: operations, cutting moves, estimated seconds, depth passes. */
function summarize(ir: ReturnType<typeof generateEngrave>): EngraveCamSummary {
  let cuttingMoves = 0;
  let passes = 0;
  let estimatedSeconds = 0;
  let roughOperations = 0;
  let finishOperations = 0;
  let throughOperations = 0;
  // #735 — the per-step tally, kept only when every operation declares its own depth passes. One
  // undeclared operation (a surface relief, say) makes the run sheet's single-step wording wrong
  // again, so the sheet falls back to it rather than printing a tally that omits a cut.
  const passSteps: CamPassStep[] = [];
  let everyOperationDeclared = ir.operations.length > 0;
  for (const op of ir.operations) {
    if (op.passKind === 'rough') roughOperations++;
    else if (op.passKind === 'finish') finishOperations++;
    else if (op.passKind === 'through') throughOperations++;
    estimatedSeconds += op.estimatedSeconds;
    const zs = new Set<number>();
    for (const m of op.moves) {
      if (m.kind !== 'feed') continue;
      cuttingMoves++;
      zs.add(m.z);
    }
    if (op.depthPasses !== undefined && op.passStepMm !== undefined) {
      passes += op.depthPasses;
      addPassStep(passSteps, op.passStepMm, op.depthPasses);
    } else {
      // No declaration: a pocket's distinct feed Z values ARE its depth passes, so this is the
      // pre-#735 reading rather than a guess.
      everyOperationDeclared = false;
      passes += zs.size;
    }
  }
  // #487 — the program's own travel, and the same program had its region loops been placed in
  // document order. The report's two region numbers differ by exactly the ordering's doing, so
  // swapping them in leaves every non-region move (a trace, a drill) where it was.
  const travel = travelStats(ir.operations.flatMap((op) => op.moves));
  const ordering = ir.ordering;
  const baselineRapidMm =
    ordering === undefined
      ? travel.rapidMm
      : travel.rapidMm - ordering.rapidMm + ordering.baselineRapidMm;
  passSteps.sort((a, b) => b.stepMm - a.stepMm);
  return {
    operations: ir.operations.length,
    cuttingMoves,
    estimatedSeconds,
    passes,
    rapidMm: travel.rapidMm,
    cutMm: travel.cutMm,
    baselineRapidMm,
    ordering: ordering === undefined || ordering.order !== 'proximity' ? null : 'proximity',
    roughOperations,
    finishOperations,
    throughOperations,
    ...(everyOperationDeclared && passSteps.length > 0 ? { passSteps } : {}),
  };
}

/** #735 — fold one operation's declared passes into the step tally, meters within 1e-6 mm. */
function addPassStep(tally: CamPassStep[], stepMm: number, passes: number): void {
  const entry = tally.find((t) => Math.abs(t.stepMm - stepMm) <= 1e-6);
  if (entry !== undefined) entry.passes += passes;
  else tally.push({ stepMm, passes });
}

/**
 * The XY trace of the job's cut footprint (#244), as a closed rectangle of RAPID moves at
 * height `z`: `(minX,minY) → (maxX,minY) → (maxX,maxY) → (minX,maxY) → (minX,minY)`. The
 * extent is every positioned move endpoint in the toolpath, GROWN BY THE CUTTER RADIUS so the
 * trace is the cutter's footprint, not just its centre path. Null when the toolpath has no
 * positioned move — nothing to trace. Pure, so the geometry is tested without wasm.
 */
export function frameCorners(ir: ToolpathIR, radius: number, z: number): CamMove[] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const op of ir.operations) {
    for (const m of op.moves) {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      minX = Math.min(minX, m.x);
      maxX = Math.max(maxX, m.x);
      minY = Math.min(minY, m.y);
      maxY = Math.max(maxY, m.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  const x0 = minX - radius;
  const x1 = maxX + radius;
  const y0 = minY - radius;
  const y1 = maxY + radius;
  return [
    { kind: 'rapid', x: x0, y: y0, z },
    { kind: 'rapid', x: x1, y: y0, z },
    { kind: 'rapid', x: x1, y: y1, z },
    { kind: 'rapid', x: x0, y: y1, z },
    { kind: 'rapid', x: x0, y: y0, z },
  ];
}

/**
 * The frame file's program (#244): the corner trace, posted by the SAME post (#173) and checked
 * by the SAME verifier (#174) as the job. Rapids only — it cuts nothing — so the verifier's cut
 * checks have nothing to flag; the point is that the dialect, the preamble and the ending are
 * the post's own, never a hand-written second dialect the machine might refuse. Returns the
 * posted text plus its verify report, or the reason it could not be produced.
 */
/**
 * The verifier's view of the mount (#442's #427 item): the obstacles and the fit, or nothing at all
 * when the job is held in the vise — and then `verify.ts` behaves exactly as it did before #427.
 */
function mountCtx(
  mount: MountObstacles | null | undefined,
  clearanceMm: number,
  /** #727 F2 — a fitted top's highest lift, which raises the clamps the verifier must clear. */
  topLiftMm = 0,
): { mountObstacles?: { obstacles: MountObstacles['obstacles']; uncertainty: number; clearance: number; topLift: number } } {
  // #710 — the fixture clearance (the job's jaw clearance) rides with the obstacles, so the verifier
  // grows every clamp and arm by the tool, the fit AND it, in one place.
  return mount
    ? { mountObstacles: { obstacles: mount.obstacles, uncertainty: mount.uncertainty, clearance: clearanceMm, topLift: topLiftMm } }
    : {};
}

/**
 * #747 — THE ONE PLACE THE FRAME'S TRACE HEIGHT IS COMPUTED, in WORK Z (the frame the document and
 * the sheet speak), and the reason it cannot be traced when there is none.
 *
 * It used to be the constant `FRAME_Z` (20), full stop. But the stub places every blank's TOP FACE
 * at the machine's tool-change safe height (`machinePlacement`: `safeZ - thickness`, then the WCS
 * puts the origin back on the top face), so the work Z a frame can reach is `envelope.z.max - wcs.z`
 * — 20 for a Z1, but reached through a subtraction and an addition of the blank's thickness that
 * do not cancel exactly in floating point for every thickness. On a 22.8 mm blank the WCS origin
 * lands on -19.999999999999996, so a trace at work Z 20 posts to machine Z 0.0000000000000036:
 * five femtometres above the envelope's top, refused by the verifier as five `outside-envelope`
 * errors that print as `0.000` (#747). The reachable height is therefore not "always 20": it is
 * the highest WORK height whose POSTED form (the machine's own axis precision, three decimals on
 * the Z1) still lands inside the machine's Z envelope — with a margin below the envelope top if
 * the float does not agree.
 *
 * THE DESIGN HEIGHT IS A MINIMUM, NOT THE ANSWER (review, 2026-10-28). `FRAME_Z` is the air
 * clearance #207 §6 wants, but the mount may stand higher, and a MEASURED work origin may sit
 * lower than the stub's, giving the machine more reach than 20 mm over the work. The trace is
 * raised to whatever the mount requires (`travelHeightOver` — #710's rule, the same one the job's
 * own travel uses; the frame's rapids are checked against the clamps and arms by the same
 * verifier) whenever that height is reachable. Only when even the reachable TOP cannot clear the
 * mount is the frame withheld — and the reason then names that top, not the design height.
 *
 * A frame that cannot meet both is WITHHELD, not guessed at: `error` says which bound failed. The
 * caller keeps the verified program; a frame is an aid, not a gate (#747).
 */
export function frameTraceZ(
  setup: Setup,
  machine: MillProfile,
  mount: MountObstacles | null | undefined,
  /** The job's fixture clearance, mm (the same number the mount's verifier gets). */
  clearanceMm: number,
  /** #727 F2 — the fitted top's highest lift, which raises the clamps this trace must clear. */
  topLiftMm = 0,
): { z: Mm } | { error: string } {
  const ceiling = machine.envelope.z.max;
  const origin = setup.wcs.origin[2];
  // The POST's own precision, not a remembered three: the value must survive `formatFixed` to the
  // machine's decimals. A profile that wrote two would round 19.999 up to 20.000 and put the
  // breach straight back.
  const decimals =
    Number.isInteger(machine.dialect.axisPrecision) && machine.dialect.axisPrecision > 0
      ? machine.dialect.axisPrecision
      : 3;
  const scale = 10 ** decimals;
  const step = 1 / scale;
  const round = (v: number): number => Math.round(v * scale) / scale;
  if (!Number.isFinite(ceiling) || !Number.isFinite(origin)) {
    return { error: `the work origin and the ${machine.name}'s Z envelope cannot be compared` };
  }
  // The reachable WORK Z is FLOORED to the posted precision: rounding up would post a height above
  // the ceiling by less than the last decimal.
  const reach = Math.floor((ceiling - origin) * scale) / scale;
  const noHeight = {
    error:
      `no height above the work is inside the ${machine.name}'s Z envelope — the work origin ` +
      `sits at machine Z ${round(origin)} mm, and the envelope tops out at ${round(ceiling)} mm`,
  };
  if (!(reach > 0)) return noHeight;
  // #710/#727 F2 — the same rule the job's own travel is raised by, so the frame's height and the
  // verifier's clamp check cannot disagree about what "clear" is. `travelHeightOver` is rounded to
  // the post's precision already. It is a MINIMUM: the design's 20 mm is the wanted air clearance,
  // but a mount that stands higher raises the trace, up to whatever this setup's WCS can reach.
  const minZ = travelHeightOver(mount?.obstacles ?? [], clearanceMm + topLiftMm, mount?.uncertainty ?? 0);
  const target = minZ === null ? FRAME_Z : Math.max(FRAME_Z, minZ);
  let z = Math.min(target, reach);
  // The floor and the divide are floats too. Ask the machine's own comparison, in the machine
  // frame the emulator will use, and step down one posted unit if the sum still lands above the top.
  // A step that also drops below the mount's requirement is a refusal below, never a low trace.
  while (z + origin > ceiling) z = round(z - step);
  if (!(z > 0)) return noHeight;
  if (minZ !== null && z < minZ) {
    return {
      error:
        `its air trace would run below the mount: the trace can reach ${round(reach)} mm above ` +
        `the work, but the clamps or arms need ${round(minZ)} mm`,
    };
  }
  return { z };
}

function frameProgram(
  ir: ToolpathIR,
  ctx: PostContext,
  machine: MillProfile,
  setup: Setup,
  tool: Tool,
  limit: DepthLimit,
  mount: MountObstacles | null | undefined,
  clearanceMm: number,
  /** #727 F2 — the fitted top's highest lift: the frame trace rides above the lifted clamps too. */
  topLiftMm = 0,
): { nc: string; verify: VerifyReport; z: Mm } | { error: string } {
  // #747 — the trace height is computed HERE, once, for the file, the sheet and the receipt. The
  // design's `FRAME_Z` is the minimum air clearance; `frameTraceZ` raises it to clear the mount
  // wherever the setup's WCS can reach, and refuses only when even that top cannot.
  const height = frameTraceZ(setup, machine, mount, clearanceMm, topLiftMm);
  if ('error' in height) return height;
  const { z } = height;
  // The cutter's footprint in XY, grown by the SAME rule the corner box has always been built with
  // (#244): the disc the toolpath removes. A V-bit's is the groove at the DEEPEST cut in the program
  // (#405) — a cone's opening widens with depth, and the frame has to cover the widest cut it makes,
  // not the tip's 0.3 mm. `traceRadiusAt` answers both shapes, so a flat end mill's frame is
  // unchanged to the last digit.
  const deepestCut = ir.operations.reduce((deepest, op) => Math.max(deepest, op.depth), 0);
  // A flat end mill or a V-bit answers here. A THREAD MILL does not trace (#445): its cut is the
  // annulus around the orbit, and `traceRadiusAt` refuses the shape by name, so the frame would
  // otherwise trace the tool's CENTRE path and miss the cutter's own radius. Growing by the
  // cutting radius is the same rule the disc gets; it is an air trace, so nothing else changes.
  const radius = traceRadiusAt(tool, deepestCut) ?? (tool.shape === 'thread' ? (cuttingDiameter(tool) ?? 0) / 2 : 0);
  const moves = frameCorners(ir, radius, z);
  if (moves === null) return { error: 'the toolpath has no positioned move to trace' };
  const frameIr: ToolpathIR = {
    frame: 'flat', // an air trace of a flat blank; a rotary job has no frame file in this slice (#240, slice 3)
    tool: ir.tool,
    toolNumber: ir.toolNumber,
    spindleRpm: ir.spindleRpm,
    // #419 Q-F — THE FRAME FILE CARRIES NO VACUUM WORDS. An air trace cuts nothing, so the vacuum
    // buys it nothing, and a `M332` here would switch the mode OFF between two cutting programs
    // (or an `M331` switch it on and leave the mode changed after an operator's own check). The
    // span below is belt and braces: `air: false` alone would already suppress both words.
    air: false,
    // The trace IS the safe height: the preamble retracts to the computed work Z and every trace
    // rapid is at it, so there is no operator offset to set or clear. `hopZ` stays HOP_Z (the
    // job's own rapid floor): the post's fixed ending retracts to Z15 and homes, so the frame's
    // verifier must not demand a rapid floor above the post's own ending.
    safeZ: z,
    hopZ: HOP_Z,
    operations: [
      {
        number: 1,
        name: 'Frame trace',
        labelId: '',
        depth: 0,
        moves,
        estimatedSeconds: estimateCycleSeconds(moves, machine.rapidEstimate),
      },
    ],
  };
  const posted = postZ1(frameIr, ctx, machine, { vacuum: 'none' });
  if (!posted.ok) return { error: posted.errors.join('; ') };
  const verify = verifyProgram(posted.text, { setup, machine, tool, depthLimit: limit, minRapidZ: frameIr.hopZ, ...mountCtx(mount, clearanceMm, topLiftMm) });
  return { nc: posted.text, verify, z };
}

/**
 * The FACING program (#432 slice 2): the skim of the blank's top, as its own file.
 *
 * Posted against the PROBED top — Z0 is the blank as the probe found it, which is the surface this
 * program removes — with the facing pass's OWN cutter (`chooseFacingTool`), its own feeds row, and
 * the SAME post and verifier as the job. The file's header names that cutter, not the job's: the
 * operator loads it for this file alone, and a header claiming the engraving bit would send them to
 * the wrong station.
 *
 * A verifier error WITHHOLDS the file: `nc` comes back null with the report attached, because the
 * one rule this pipeline has is that a program is only handed over after it has been checked.
 *
 * Nothing here can fail the RUN. Every refusal — no suitable cutter, no feeds row, an unsupported
 * geometry, a verifier error — comes back as `error` with `nc: null`, and the caller keeps the
 * engraving the run already produced.
 */
function facingProgram(
  job: EngraveJob,
  depth: Mm,
  ctx: PostContext,
  machine: MillProfile,
  setup: Setup,
  limit: DepthLimit,
  mount: MountObstacles | null | undefined,
  tools: readonly ToolLibraryEntry[],
  /**
   * #432 review R10 — the bench's condition summaries, handed in from `shop.conditions` for the
   * same worker-realm reason as `tools` (see `EngraveShopOpts`). Null: nothing is known broken.
   */
  conditions: ReadonlyMap<string, ConditionSummary> | null | undefined,
  catalogue: readonly FeedCatalogueRow[],
  table: readonly FeedsEntry[] | undefined,
  /**
   * This file's share of the run's vacuum words (#419 decision 4). The facing file is the FIRST
   * program of a run that has one — it runs before any cutter touches the part — so the caller
   * passes `'first'`: the vacuum comes on here and stays on across the bit change, and the
   * engraving program that follows is posted `'last'` to switch it off.
   */
  span: VacuumSpan,
  /**
   * #727 F2 — the fitted top's highest lift, mm. The skim is posted against the PROBED top, which a
   * tilt may stand below the real one by this much, so the clamps' tops sit that far above the
   * frame the facing passes are written in.
   */
  topLiftMm = 0,
): {
  nc: string | null;
  verify: VerifyReport | null;
  toolKey: string | null;
  error: string | null;
  cam: FacingCamSummary | null;
} {
  // #474/#493 — the rule is the MATERIAL's, not the panel's. A legacy or hand-edited job that still
  // turns facing on for a plastic must not get a face file either: the worker refuses it by name,
  // so the R11 Facing row and the run sheet say why rather than walking the operator through a pass
  // the app will not produce.
  const refusal = facingRefusal(job.stock.material);
  if (refusal !== null) return { nc: null, verify: null, toolKey: null, error: refusal, cam: null };
  const pick = chooseFacingTool(
    tools,
    catalogue,
    job.stock.material,
    job.facing?.toolKey ?? null,
    conditions,
  );
  if (pick.entry === null) return { nc: null, verify: null, toolKey: null, error: pick.reason, cam: null };
  const tool = pick.entry.tool;
  const toolKey = pick.entry.key;
  // The facing pass resolves its OWN feeds: it is a different cutter in the same material, so the
  // engraving's numbers are not its numbers. `feedsFor` is the same resolver the program above uses,
  // against the same catalogue and the same shop table.
  //
  // NO `cutOverride` — deliberately. The job's override is the hand-entered speed and feed for the
  // job's ENGRAVING cutter (#205): a person who typed 12 000 rpm for a 1 mm flat has said nothing
  // about the 6 mm mill that skims the top, and handing those numbers over would run the big cutter
  // at a small cutter's feed rate. The facing file's S/F are the row's own for the facing cutter.
  const feeds = feedsFor(catalogue, job.stock.material, tool, machine, undefined, table);
  if (!feeds.ok) {
    return {
      nc: null,
      verify: null,
      toolKey,
      error: `the facing cutter "${tool.name}": ${feeds.reason}`,
      cam: null,
    };
  }
  // What the file was cut with, for the sheet (#432 slice 3). `zPasses` is the SAME answer the IR
  // uses for its Z levels, so the printed pass count cannot drift from the moves.
  const cam: FacingCamSummary = {
    toolName: tool.name,
    diameterMm: cuttingDiameter(tool) ?? 0,
    passes: zPasses(depth, feeds.params.stepDown).length,
    stepDown: feeds.params.stepDown,
    stepOver: feeds.params.stepOver,
    rpm: feeds.params.rpm,
    feed: feeds.params.feed,
    plungeFeed: feeds.params.plungeFeed,
    air: feeds.params.air,
  };
  try {
    const ir = raiseTravelOver(
      generateFacing(
        // #743 D6 — a disc's top is its face: the raster covers the rim's circle, not the box.
        { length: job.stock.length, width: job.stock.width, shape: job.stock.shape === 'disc' ? 'disc' : undefined, diameter: job.stock.diameter },
        tool,
        feeds.params,
        machine.rapidEstimate,
        depth,
      ),
      // #710 — the skim's hops and retracts clear the mount too: the raster crosses the whole top,
      // so a clamp would otherwise be refused by every facing pass on a bracket job.
      travelHeightOver(mount?.obstacles ?? [], job.jawClearance + topLiftMm, mount?.uncertainty ?? 0),
      machine.rapidEstimate,
    );
    const posted = postZ1(ir, { ...ctx, toolKey }, machine, { vacuum: span });
    if (!posted.ok) {
      return { nc: null, verify: null, toolKey, error: posted.errors.join('; '), cam: null };
    }
    const verify = verifyProgram(posted.text, {
      setup,
      machine,
      tool,
      depthLimit: limit,
      minRapidZ: ir.hopZ,
      ...mountCtx(mount, job.jawClearance, topLiftMm),
    });
    const refused = verify.findings.filter((f) => f.severity === 'error');
    if (refused.length > 0) {
      // #432 decision 5 — the whole top is the raster and the verifier is its guard, so a skim that
      // would run into the mount is refused and the refusal names the strips it could not face
      // rather than shrinking the pass behind the operator's back. `mount` is non-null here in
      // practice (a mount finding cannot exist without obstacles), but the guard keeps the type
      // honest.
      const atMount = refused.some((f) => f.code === 'clamp-in-path' || f.code === 'bracket-in-path');
      const bands =
        atMount && mount
          ? unfacedBands(mount.obstacles, { x: job.stock.length, y: job.stock.width }, {
              // The band is PHYSICAL: the strips the cutter cannot reach because the clamp stands
              // over them (its footprint grown by the tool and the fit). The fixture clearance is a
              // path rule, not a reach: adding it here would claim the cutter cannot reach strips
              // it can, and the refusal above already says the skim runs into the mount (#710).
              radius: (cuttingDiameter(tool) ?? 0) / 2,
              uncertainty: mount.uncertainty,
            })
          : [];
      return {
        nc: null,
        verify,
        toolKey,
        error:
          `the facing program has ${refused.length} verifier error(s)` +
          (bands.length > 0 ? `: the skim would run into the mount, and ${bands.join('; ')}` : ''),
        // No file, so there is nothing whose numbers the sheet could print.
        cam: null,
      };
    }
    return { nc: posted.text, verify, toolKey, error: null, cam };
  } catch (e) {
    return { nc: null, verify: null, toolKey, error: e instanceof Error ? e.message : String(e), cam: null };
  }
}

/**
 * The tail of the `cut-too-deep` sentence: WHICH plane the limit at (x, y) is (#285, #345).
 *
 * Two answers, and the difference is what the operator acts on. Over a void the solid itself
 * stopped the cutter, so the sentence names the plane the floor would have crossed — the void's
 * ceiling, named by the same `ceilingName` the bound model uses, so the sentence and the per-item
 * finding cannot describe one plane two ways. Everywhere else the limit is the job's own floor
 * under the stock (or the sacrificial height), and naming a ceiling there would send the operator
 * looking for a pocket that is not there.
 *
 * Exported so the branch is directly testable: over solid stock nothing can reach the verifier
 * today — `validateJob` refuses the same depth first — so only the void half is reachable through
 * the pipeline, and the floor half would otherwise be an unverified string.
 */
export function depthLimitReason(stack: StackDepthLimit, job: EngraveJob, x: Mm, y: Mm): string {
  if (stack.reasonAt(x, y) === 'stock') return '— the floor the job keeps under the stock';
  return `— ${ceilingName(keepOutNameAt(job, x, y) ?? '')}`;
}

/**
 * One program's result, before the list is assembled. `generateOneProgram`'s return shape.
 */
type OneProgram = Omit<EngraveGenerated, 'programs'> & {
  /**
   * #737 — the neck for parting THIS program leaves, or null/absent on a program that cuts no
   * neck. The run sheet's saw step belongs to the file that leaves it; the top-level field is the
   * first program's (the single-program adapter), so a multi-program sheet reads each program's.
   */
  neck?: RotaryNeckFacts | null;
  /** #677 — the cores this program's V left standing, for the run to hand to the flat cutter. */
  cores?: readonly CoreCut[];
  /** #677 — the cores THIS program cleared: the core-clearance program's own sheet facts. */
  core?: CoreProgramFacts | null;
};

/**
 * A program the run will really play: it posted and the verifier passed. `make` builds it again
 * with a different share of the run's vacuum words, which is how the first and last programs are
 * settled once the rest pass has decided how many files the run actually has (#472).
 */
interface PostedProgram {
  ref: JobProgramRef;
  one: OneProgram;
  make: (span: VacuumSpan) => OneProgram;
  span: VacuumSpan;
}

/**
 * The measurements a rest pair produced, held until the program list is final so the facts read
 * the files the run will actually play (the vacuum words are settled after this point).
 */
interface RestLink {
  roughIndex: number;
  restIndex: number;
  roughJob: EngraveJob;
  restJob: EngraveJob;
  roughKey: string;
  restKey: string;
  roughDiameter: number;
  restDiameter: number;
  roughShare: number;
  roughReason: string;
  restReason: string;
  unroughed: UnroughedItem[];
  regions: RestRegion[];
  rest1: RestResult;
  left: RestResult;
  p1: SimLoadOk;
  p2: SimLoadOk;
  seam: SeamFacts;
  thirdToolPct: number;
  thirdToolSource: RestSettingSource;
}

/**
 * A pair as one setup's generator hands it back: the measurements and the two programs, BEFORE
 * their places in the run are known (the main loop adds `roughIndex`/`restIndex` when it appends
 * the pair to the run's program list).
 */
type RestPairLink = Omit<RestLink, 'roughIndex' | 'restIndex'> & {
  rough: PostedProgram;
  rest: PostedProgram;
};

/**
 * Run one posted program through the same simulation the run will use, with the same setup the
 * generator built. The worker's own session is fresh each time; the meshes it returns are plain
 * data, so it is disposed on the way out — except that the caller keeps the removal mesh it needs,
 * which is a structured-clone-safe copy.
 */
function simulateProgram(
  tl: ManifoldToplevel,
  job: EngraveJob,
  nc: string,
  tool: Tool,
  calibration: MachineCalibration | null,
  shop: EngraveShopOpts,
  priorRemoval?: NodeMeshOutput,
): SimLoadResult {
  const mill = jobMachine(job, calibration);
  // #725 B7 — the wasteboard rides the setup as the under-board (a through cut may enter it).
  const setup = toSetup(job, mill, shop.mount?.fixture ?? undefined, shop.bed ?? null);
  const session = createSimSession(tl);
  try {
    return session.load(nc, setup, tool, job.machineId, {
      calibration,
      // #218: a through cut's kerf reaches this far below the blank. The exact sweeper cuts the
      // board from the G-code alone; the column engine needs the number because it clamps floors.
      breakthroughMm: job.breakthrough,
      ...(priorRemoval === undefined ? {} : { priorRemoval }),
    });
  } finally {
    session.dispose();
  }
}

/** Why a simulated program is not safe to measure against, or null when it is. */
function simRefusal(load: SimLoadResult): string | null {
  if (!load.ok) {
    const errors = simErrors(load.diagnostics).map((d) => d.message);
    return errors.length > 0 ? errors.join('; ') : 'the simulation refused the program';
  }
  return simulationProblem(load.diagnostics);
}

/** One program as the sheet's rest section prints it. */
function restProgramFact(
  one: OneProgram,
  job: EngraveJob,
  key: string,
  diameter: number,
  reason: string,
  removedVolume: number,
): RestProgram & { reason: string } {
  const cam = one.cam;
  return {
    key,
    diameter,
    reason,
    nc: runSheetFileName(job.name),
    frame: one.frameNc === null ? null : runSheetFrameFileName(job.name),
    params: one.feeds !== null && one.feeds.ok ? one.feeds.params : null,
    passes: cam?.passes ?? 1,
    traceOnly:
      toPartPlan(job).engraves.length === 0 &&
      (job.traces?.some((t) => t.enabled && !t.construction) ?? false),
    moves: cam?.cuttingMoves ?? 0,
    seconds: Math.round(cam?.estimatedSeconds ?? 0),
    ...(cam?.rapidMm !== undefined && cam.cutMm !== undefined && cam.baselineRapidMm !== undefined
      ? { travel: { rapidMm: cam.rapidMm, cutMm: cam.cutMm, baselineRapidMm: cam.baselineRapidMm } }
      : {}),
    removedVolume,
  };
}

/** The rest pair's story, assembled from the final posted programs and the measurements behind them. */
function assembleRestFacts(link: RestLink, posted: readonly PostedProgram[]): RestPassFacts {
  const roughOne = posted[link.roughIndex]!.one;
  const restOne = posted[link.restIndex]!.one;
  return {
    rough: {
      ...restProgramFact(
        roughOne,
        link.roughJob,
        link.roughKey,
        link.roughDiameter,
        link.roughReason,
        link.p1.stats.removedVolume,
      ),
      share: link.roughShare,
      score: link.roughDiameter * link.roughDiameter * link.roughShare,
    },
    rest: restProgramFact(
      restOne,
      link.restJob,
      link.restKey,
      link.restDiameter,
      link.restReason,
      link.p2.stats.removedVolume,
    ),
    unroughed: link.unroughed,
    regions: link.regions.map((r) => ({
      name: r.name ?? r.id,
      depth: r.depth,
      area: r.area,
      cutArea: r.cutArea,
      clearedArea: r.clearedArea,
    })),
    cutArea: link.rest1.cutArea,
    clearedArea: link.rest1.clearedArea,
    restArea: link.regions.reduce((sum, r) => sum + r.area, 0),
    overlap: link.seam.overlap,
    seam: link.seam,
    thirdTool: thirdToolAdvice(
      link.left.restArea,
      link.rest1.cutArea,
      { thirdToolFraction: link.thirdToolPct / 100, source: link.thirdToolSource },
      link.seam,
    ),
    restRemovedVolume: link.p2.stats.removedVolume,
    leftover: {
      area: link.left.restArea,
      byItem: link.left.regions
        .map((r) => ({ name: r.name ?? r.id, depth: r.depth, area: r.area }))
        .sort((a, b) => b.area - a.area),
    },
  };
}

/** `0.5` — a millimetre value as a finding or sheet sentence prints it. */
function mmValue(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

/**
 * #677 — A CORE THAT WILL STAND, said where the operator can act on it. One warning per standing
 * core: the area, the depth, and which cutter the setup must add after the V. `where` is null on a
 * legacy document (no setups to name), where the advice is to add one.
 *
 * No finding is raised for a core the engine CLEARS: a handled condition is not a warning, and the
 * core program's own section of the sheet states it.
 */
function coreWarningFindings(
  cores: readonly CoreCut[],
  where: { setupIndex: number; toolKey: string } | null,
): JobFinding[] {
  return cores.map((core) => ({
    severity: 'warning',
    code: 'vcarve-variable-core',
    labelId: core.of,
    message:
      `${core.ofName} is ${mmValue(core.depth)} mm deep at its centre, but the V's width runs out ` +
      `before the middle: ${mmValue(core.areaMm2)} mm² of floor is not reached by the V. ` +
      (where === null
        ? `Add a setup that names a flat end mill after the V; that cutter pockets the area at ` +
          `${mmValue(core.depth)} mm in its own program.`
        : (() => {
            const after = cutterWords(where.toolKey);
            return (
              `Add a flat end mill ${after === null ? 'after the V' : `after ${after}`} in setup ` +
              `${where.setupIndex + 1}; it pockets that area at ${mmValue(core.depth)} mm in its own program.`
            );
          })()),
  }));
}

/**
 * #677 — a core the named flat cutter cannot enter (the core eroded by its radius is empty), so
 * the pocket would open nothing and the flat bottom would stand. Said per core, naming the cutter
 * and the way out.
 */
function coreTooNarrowFindings(
  cores: readonly CoreCut[],
  cutter: Tool,
  diameter: number,
): JobFinding[] {
  return cores.map((core) => ({
    severity: 'warning',
    code: 'vcarve-variable-core',
    labelId: core.of,
    message:
      `The core under ${core.ofName} is ${mmValue(core.areaMm2)} mm² at ${mmValue(core.depth)} mm, ` +
      `and ${cutter.name} (⌀ ${mmValue(diameter)} mm) is wider than it at every point: the pocket ` +
      'would open nothing. Use a smaller flat end mill.',
  }));
}

/**
 * One setup's multi-cutter run, measured and generated (#472, #746). `null` when the rough program
 * did not post; the finding for why a later program could not be measured is pushed into
 * `findings`.
 *
 * #746 — EACH CUTTER CUTS THE ITEMS IT OWNS. The refs arrive from `setupPrograms`, so each later
 * ref's `itemIds` is the one `toolItemsFor` reading of the operator's assignment; this function
 * does not re-derive ownership. A later cutter with items gets a `jobForSetup` program of exactly
 * those items and NOTHING ELSE (a through vector stays through, a cut-out keeps its outline, a
 * bore stays a bore). A later cutter with NO items is #472's rest pass: its geometry is the
 * measured rest of the EARLIER cutter's UNFINISHED items — `measureJob` is the earlier ref's own
 * sub-job, never the whole setup. A cutter that owns items is never a rest cutter, so a V-bit
 * among them cuts its own work instead of being refused (#486 is a statement about rest passes).
 *
 * The order is the CLI route's (scripts/engrave-job.ts), and for its reasons: the first program is
 * generated, then SIMULATED, then the rest is measured against that sweep's own removal, then the
 * later programs are generated and swept from the earlier ones' result. Nothing here trusts an
 * offset standing in for a cut.
 *
 * #677 — A V FIRST IS NEVER THE REST MODEL. A cone cannot be rest-measured (#486), but a
 * variable-depth carve leaves a CORE the V's width cannot reach, and the first flat cutter after
 * the V pockets exactly that core at the cap in its own program — after the V program, in the
 * setup's own tool order. The V's items and every later cutter's items are still cut as themselves
 * (#746); the core is the only geometry handed between cutters.
 */
function generateRestPair(
  tl: ManifoldToplevel,
  job: EngraveJob,
  group: readonly JobProgramRef[],
  roughTool: Tool | null,
  restTools: readonly (Tool | null)[],
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null,
  margins: EngraveMargins,
  shop: EngraveShopOpts,
  withFacing: boolean,
  /**
   * #737 — this pair is the RUN'S LAST CUT, so its last program leaves the neck for parting. The
   * rough program never does: the neck comes after every finish pass.
   */
  withNeck: boolean,
  cursor: number,
  refCount: number,
  findings: JobFinding[],
  /** #748 — the document's supporting floors, for every program this pair generates. */
  floors?: ReadonlyMap<string, number>,
): {
  attempts: OneProgram[];
  posted: PostedProgram[];
  link: RestPairLink | null;
  cursor: number;
} {
  const roughRef = group[0]!;
  const attempts: OneProgram[] = [];
  const posted: PostedProgram[] = [];
  let nextCursor = cursor;
  const spanAt = (index: number): VacuumSpan =>
    refCount === 1 ? 'whole' : index === 0 ? 'first' : index === refCount - 1 ? 'last' : 'middle';
  const roughSpan = spanAt(nextCursor);
  nextCursor += 1;

  const mill = jobMachine(job, calibration);

  if (roughTool === null || group.length < 2) {
    const roughJob = jobForSetup(job, roughRef, roughTool);
    const makeRough = (span: VacuumSpan): OneProgram =>
      generateOneProgram(tl, roughJob, roughTool, catalogue, calibration, margins, shop, span, withFacing, 'rough-and-finish', withNeck, undefined, floors);
    const roughOne = makeRough(roughSpan);
    attempts.push(roughOne);
    if (roughOne.ok && roughOne.nc !== null && roughOne.verify !== null) {
      posted.push({ ref: roughRef, one: roughOne, make: makeRough, span: roughSpan });
    }
    return { attempts, posted, link: null, cursor: nextCursor };
  }

  // #486/#677/#746 — A CONE FIRST IS NEVER A REST PASS. A V cuts the items it owns at the colour
  // plane; what it cannot finish is a variable carve's CORE, which the first LATER FLAT pockets at
  // the cap in its own program (#677). A later cutter that owns items cuts them too (#746): the
  // core is handed to the first flat after the V, whether or not that flat owns items of its own.
  const roughJob = jobForSetup(job, roughRef, roughTool);
  if (vCone(roughTool) !== null) {
    const makeV = (span: VacuumSpan): OneProgram =>
      // The V is never the run's last cut: the later program is (#737).
      generateOneProgram(tl, roughJob, roughTool, catalogue, calibration, margins, shop, span, withFacing, 'rough-and-finish', false, undefined, floors);
    const vOne = makeV(roughSpan);
    attempts.push(vOne);
    if (!vOne.ok || vOne.nc === null || vOne.verify === null) {
      return { attempts, posted, link: null, cursor: nextCursor };
    }
    posted.push({ ref: roughRef, one: vOne, make: makeV, span: roughSpan });

    // The cores still waiting for a flat. Only the FIRST flat after the V takes them: a second
    // flat later in the setup owns its own items and has no business re-cutting the same floor.
    let pendingCores: CoreCut[] = [...(vOne.cores ?? [])];
    const takeCores = (flat: Tool): CoreCut[] => {
      if (pendingCores.length === 0 || flat.shape !== 'flat') return [];
      // A core the cutter cannot reach into is not a program — the pocket would open nothing.
      // Those cores stay, and the warning says which cutter could take them.
      const diameter = cuttingDiameter(flat) ?? 0;
      const radius = diameter / 2;
      const offset = makeClipperOffset(tl);
      const cuttable =
        radius > 0 ? pendingCores.filter((core) => offset(core.polygons, -radius).length > 0) : [];
      const standing = pendingCores.filter((core) => !cuttable.includes(core));
      if (standing.length > 0) findings.push(...coreTooNarrowFindings(standing, flat, diameter));
      pendingCores = [];
      return cuttable;
    };

    for (let r = 0; r < restTools.length; r++) {
      const restTool = restTools[r]!;
      const restRef = group[r + 1]!;
      if (restTool === null) {
        findings.push({
          severity: 'error',
          code: 'setup-rest-unavailable',
          message:
            `Setup ${restRef.setupIndex} names ${restRef.toolKey} as a later cutter, but that cutter ` +
            'is not on this bench. Add it to the tool library, or remove it from the setup.',
        });
        break;
      }
      const ownsItems = restRef.itemIds.length > 0;
      if (!ownsItems) {
        // A later cutter with no items of its own has only the V's cores to cut, and only a flat
        // can pocket those. Anything else is the V-carve being asked for a rest pass it has no
        // capacity for; the sentence says what to change.
        if (pendingCores.length > 0 && restTool.shape !== 'flat') {
          findings.push({
            severity: 'error',
            code: 'setup-rest-unavailable',
            message:
              `Setup ${restRef.setupIndex} names ${restRef.toolKey} after ${roughRef.toolKey}, but the ` +
              'core a variable V-carve leaves is a flat bottom, and only a flat end mill clears it. ' +
              'Name one, or remove the later cutter from the setup.',
          });
          break;
        }
        if (pendingCores.length === 0) {
          // #486 — a V-BIT cannot take a rest pass on a region job: it is the V-carve cutter
          // itself, not a second program. The refusal is about THIS later cutter, so both the
          // test and the sentence come from it — never from `roughTool`, whose refusal may be
          // null (a trace-only V) and used to print "but null".
          const restRefusal = vBitRestRefusal(roughJob, restTool);
          if (restRefusal !== null) {
            findings.push({
              severity: 'error',
              code: 'setup-rest-unavailable',
              message:
                `Setup ${restRef.setupIndex} names ${restRef.toolKey} after ${roughRef.toolKey}, but ` +
                `${restRefusal}. Remove the later cutter from the setup, or name a flat cutter first.`,
            });
            break;
          }
          // #472/#746 — A FLAT WITH NO CORE WAITING IS NOT A REFUSAL. The V's only leftover is
          // the variable carve's core, and the first flat after the V takes it; once it is taken
          // (or the V left none) this cutter has nothing to measure and nothing to cut. Say so
          // and move on, exactly as the flat-first branch does when a rest pass finds nothing.
          findings.push({
            severity: 'warning',
            code: 'setup-rest-nothing',
            message:
              `Setup ${restRef.setupIndex}'s ${restRef.toolKey} has nothing left to clean up: a ` +
              "V-carve's only leftover is the core a flat pockets, and no core is waiting for this " +
              'cutter. No program is written for it.',
          });
          continue;
        }
        const cuttable = takeCores(restTool);
        if (cuttable.length === 0) break; // every core is narrower than the flat; the warning says so
        // THE SECOND FILE: the flat cutter pockets the cores at the cap, after the V program — the
        // setup's own tool order, which is the order the run plays the files in.
        const coreSpan = spanAt(nextCursor);
        nextCursor += 1;
        const coreJob = jobForSetup(job, restRef, restTool);
        const makeCore = (span: VacuumSpan): OneProgram =>
          generateOneProgram(
            tl,
            coreJob,
            restTool,
            catalogue,
            calibration,
            margins,
            shop,
            span,
            false,
            'rough-and-finish',
            // Only the LAST program of a run that ends here leaves the neck (#737).
            withNeck && r === restTools.length - 1,
            cuttable,
            floors,
          );
        const coreOne = makeCore(coreSpan);
        attempts.push(coreOne);
        if (coreOne.ok && coreOne.nc !== null && coreOne.verify !== null) {
          posted.push({ ref: restRef, one: coreOne, make: makeCore, span: coreSpan });
        }
        continue;
      }

      // #746 — the later cutter owns items: it cuts THEM, as themselves. The cores ride along in
      // the same file when this is the first flat after the V; nothing else of the V's is handed
      // over, and the V's own items are not re-planned for this cutter.
      const derived = takeCores(restTool);
      const ownJob = jobForSetup(job, restRef, restTool);
      const ownSpan = spanAt(nextCursor);
      nextCursor += 1;
      const makeOwn = (span: VacuumSpan): OneProgram =>
        generateOneProgram(
          tl,
          ownJob,
          restTool,
          catalogue,
          calibration,
          margins,
          shop,
          span,
          false,
          'rough-and-finish',
          // #737 — only the last program of the run leaves the neck.
          withNeck && r === restTools.length - 1,
          derived.length === 0 ? undefined : derived,
          floors,
        );
      const ownOne = makeOwn(ownSpan);
      attempts.push(ownOne);
      if (!ownOne.ok || ownOne.nc === null || ownOne.verify === null) break;
      posted.push({ ref: restRef, one: ownOne, make: makeOwn, span: ownSpan });
    }

    if (pendingCores.length > 0) {
      // No later flat took them: the cores stand at the V's floor, and the warning names the
      // cutter that would clear them. The V's own items were still cut by the V's program above.
      findings.push(
        ...coreWarningFindings(pendingCores, { setupIndex: roughRef.setupIndex, toolKey: roughRef.toolKey }),
      );
    }
    return { attempts, posted, link: null, cursor: nextCursor };
  }

  // #746 — THE EARLIER CUTTER'S ITEM SET, NOT THE SETUP'S. `measureJob` is the same sub-job the
  // first program is built from, so the two readings cannot drift apart. Measuring the WHOLE setup
  // here — including the items `toolItems` assigned to a later cutter — is what re-planned a later
  // cutter's bore as "rest of Bore", its through vector as a deep pocket and its cut-out as an
  // outline whose part had vanished.
  const measureJob = roughJob;
  const measured = measureEngraving(tl, measureJob, roughTool);
  const glyphArea = measured.reduce((sum, m) => sum + m.glyphArea, 0);
  const openedArea = measured.reduce((sum, m) => sum + m.openedArea, 0);
  const roughShare = glyphArea > 0 ? openedArea / glyphArea : 0;
  const unroughed: UnroughedItem[] = measured
    .filter((m) => m.glyphArea > 0 && m.openedArea === 0)
    .map((m) => {
      const item = findItem(measureJob, m.labelId);
      return {
        id: m.labelId,
        name: item === undefined ? m.labelId : itemName(item),
        area: m.glyphArea,
        depth: item?.depth ?? 0,
      };
    });
  const unroughedIds = new Set(unroughed.map((u) => u.id));
  // #746 — ONLY A LATER CUTTER THAT OWNS NO ITEMS IS #472's REST PASS, and only that program
  // finishes the first program's split floors. When every later cutter owns items, each cuts its
  // own work and nobody will finish the rough's, so the first program cuts to depth itself rather
  // than leaving a stock allowance standing for a rest pass that is never written.
  const laterRestPass = group.slice(1).some((ref) => ref.itemIds.length === 0);
  // A rest pass takes over an item the first cutter cannot enter at all: `engraveRegions` would
  // stop the first program on `item-empty`, and the rest pass's design still contains the item, so
  // the item is trimmed from program 1 and cut by the finer cutter. With NO rest pass there is
  // nobody to take it: keeping it in the program is what makes `item-empty` REFUSE the job by name
  // instead of silently dropping the item from every program in the run.
  const roughRefKept: JobProgramRef = laterRestPass
    ? { ...roughRef, itemIds: roughRef.itemIds.filter((id) => !unroughedIds.has(id)) }
    : roughRef;
  const roughJobKept = jobForSetup(job, roughRefKept, roughTool);
  const makeRoughKept = (span: VacuumSpan): OneProgram =>
    generateOneProgram(
      tl,
      roughJobKept,
      roughTool,
      catalogue,
      calibration,
      margins,
      shop,
      span,
      withFacing,
      laterRestPass ? 'rough-only' : 'rough-and-finish',
      // The rough half of a pair never leaves the neck (#737).
      false,
      undefined,
      floors,
    );
  const keptOne = makeRoughKept(roughSpan);
  attempts.push(keptOne);
  if (!keptOne.ok || keptOne.nc === null || keptOne.verify === null) {
    return { attempts, posted, link: null, cursor: nextCursor };
  }
  const roughRecord: PostedProgram = { ref: roughRefKept, one: keptOne, make: makeRoughKept, span: roughSpan };
  posted.push(roughRecord);

  const p1 = simulateProgram(tl, roughJobKept, keptOne.nc, roughTool, calibration, shop);
  const p1Problem = simRefusal(p1);
  if (!p1.ok || p1Problem !== null) {
    findings.push({
      severity: 'error',
      code: 'setup-rest-unavailable',
      message:
        `Setup ${roughRef.setupIndex}'s first program could not be measured for the rest pass: ` +
        `${p1Problem ?? 'the simulation refused it'}. The job cannot plan its second cutter safely.`,
    });
    return { attempts, posted, link: null, cursor: nextCursor };
  }

  // (A V-bit first never reaches here: the clearance branch above owns every cone, so #486's
  // refusal is stated there — where a later cutter with no items of its own is the one asking for
  // a rest pass — rather than guessed from a whole-setup measurement.)

  const roughFeeds = feedsFor(catalogue, job.stock.material, roughTool, mill, job.cutOverride, shop.feeds ?? undefined);
  const roughDiameter = cuttingDiameter(roughTool) ?? 0;
  const overlapRead = shop.rest?.overlap ?? {
    value: REST_MACHINING_FALLBACK.overlap,
    source: REST_MACHINING_FALLBACK.source,
  };
  const thirdRead = shop.rest?.thirdToolPct ?? {
    value: REST_MACHINING_FALLBACK.thirdToolFraction * 100,
    source: REST_MACHINING_FALLBACK.source,
  };
  const roughCutter: SeamCutter = {
    key: roughRef.toolKey,
    diameter: roughDiameter,
    stepOver: roughFeeds.ok ? roughFeeds.params.stepOver : null,
  };

  let removal: NodeMeshOutput | null = p1.meshes.removal;
  let removalMeshes: NodeMeshOutput[] = removal === null ? [] : [removal];
  let link: RestPairLink | null = null;

  for (let r = 0; r < restTools.length; r++) {
    const restTool = restTools[r]!;
    const restRef = group[r + 1]!;
    const restSpan = spanAt(nextCursor);
    if (restTool === null) {
      findings.push({
        severity: 'error',
        code: 'setup-rest-unavailable',
        message:
          `Setup ${restRef.setupIndex} names ${restRef.toolKey} as a later cutter, but that cutter ` +
          'is not on this bench. Add it to the tool library, or remove it from the setup.',
      });
      break;
    }
    // #746 — A CUTTER WITH ITEMS IS NOT A REST PASS. It cuts exactly the items `setupPrograms`
    // assigned to it, as themselves: a through vector stays through, a bore stays a bore, a
    // cut-out keeps its outline. It is handed none of the earlier cutter's geometry (the rest
    // pass is the earlier cutter's own unfinished items, and those belong to a cutter that was
    // assigned none), so nothing here is re-planned as "rest of …", and #486's V-bit rest
    // refusal — a statement about rest cutters — never applies to it. A V that owns items cuts
    // them as a V-carve, whatever the setup named before it.
    if (restRef.itemIds.length > 0) {
      const ownJob = jobForSetup(job, restRef, restTool);
      const ownSpan = spanAt(nextCursor);
      nextCursor += 1;
      const makeOwn = (span: VacuumSpan): OneProgram =>
        generateOneProgram(
          tl,
          ownJob,
          restTool,
          catalogue,
          calibration,
          margins,
          shop,
          span,
          false,
          'rough-and-finish',
          // #737 — only the last program of the run leaves the neck.
          withNeck && r === restTools.length - 1,
          undefined,
          floors,
        );
      const ownOne = makeOwn(ownSpan);
      attempts.push(ownOne);
      if (!ownOne.ok || ownOne.nc === null || ownOne.verify === null) break;
      posted.push({ ref: restRef, one: ownOne, make: makeOwn, span: ownSpan });
      // #746 — A LATER REST PASS IS MEASURED AGAINST EVERY EARLIER PROGRAM, not program 1 only.
      // This program cut its items to depth; if a rest-only cutter follows, this program's own
      // removal joins the cumulative mesh, or the rest pass would plan its items a second time.
      // (The walk's from-blank retry is `programSweep`'s; this measurement is only asked when a
      // rest-only cutter actually needs it, so a group without one pays no sweep here.)
      if (group.slice(r + 1).some((later) => later.itemIds.length === 0)) {
        const ownSim = simulateProgram(tl, ownJob, ownOne.nc, restTool, calibration, shop);
        const ownProblem = simRefusal(ownSim);
        if (!ownSim.ok || ownProblem !== null) {
          findings.push({
            severity: 'error',
            code: 'setup-rest-unavailable',
            message:
              `Setup ${restRef.setupIndex}'s ${restRef.toolKey} program could not be measured for a ` +
              `later rest pass: ${ownProblem ?? 'the simulation refused it'}. Remove the later rest ` +
              'cutter, or regenerate without it.',
          });
          break;
        }
        if (ownSim.meshes.removal !== null) {
          removalMeshes = [...removalMeshes, ownSim.meshes.removal];
          removal = unionRemoval(tl, removalMeshes);
        } else if ((ownOne.cam?.cuttingMoves ?? 0) > 0) {
          findings.push({
            severity: 'error',
            code: 'setup-rest-unavailable',
            message:
              `Setup ${restRef.setupIndex}'s ${restRef.toolKey} program cut material but recorded no ` +
              'removal mesh, so a later rest pass cannot be measured against it. Remove the later ' +
              'rest cutter, or regenerate without it.',
          });
          break;
        }
      }
      continue;
    }
    // Only a cutter assigned NO items is #472's rest pass, and only a rest pass is refused a
    // V-bit (#486): its geometry is the measured rest of the EARLIER cutter's items.
    const restRefusal = vBitRestRefusal(measureJob, restTool);
    if (restRefusal !== null) {
      findings.push({
        severity: 'error',
        code: 'setup-rest-unavailable',
        message: `Setup ${restRef.setupIndex}'s ${restRef.toolKey} cannot take the rest pass: ${restRefusal}.`,
      });
      break;
    }
    // What this cutter would cut of the EARLIER cutter's work, measured before the first program's
    // items were trimmed — an item the first cutter cannot enter is entirely this one's job. The
    // later cutter's own items are NOT in `measureJob`; they are measured only in its own program.
    const design = engraveRegions(tl, measureJob, restTool, margins, shop, mill, catalogue, undefined, floors);
    const restFeeds = feedsFor(
      catalogue,
      job.stock.material,
      restTool,
      mill,
      undefined,
      shop.feeds ?? undefined,
    );
    const restDiameter = cuttingDiameter(restTool) ?? 0;
    const restCutterRef: SeamCutter = {
      key: restRef.toolKey,
      diameter: restDiameter,
      stepOver: restFeeds.ok ? restFeeds.params.stepOver : null,
    };
    const seam = restSeamFacts({
      stored: overlapRead.value,
      source: overlapRead.source,
      rough: roughCutter,
      rest: restCutterRef,
    });
    const rest1 = restMachining(tl, { removal, cuts: design.cuts, overlap: seam.overlap });
    // A region the second cutter's own opening erases is dropped rather than generated: left in,
    // it is an `item-empty` refusal that would stop the whole second program over a corner the
    // design never gave up. The CLI route drops the same regions for the same reason.
    let kept = rest1.regions;
    if (kept.length > 0) {
      const probe = { ...restJobFor(job, kept, restRef.toolKey), tool: restTool };
      const open = new Set(
        engraveRegions(tl, probe, restTool, margins, shop, mill, catalogue, undefined, floors)
          .measured.filter((m) => m.openedArea > 0)
          .map((m) => m.labelId),
      );
      kept = kept.filter((_, i) => open.has(`rest-${i + 1}`));
    }
    if (kept.length === 0) {
      findings.push({
        severity: 'warning',
        code: 'setup-rest-nothing',
        message:
          `Setup ${restRef.setupIndex}'s ${restRef.toolKey} has nothing left to clean up: the first ` +
          'program already removed everything this cutter can open, so no second program is written ' +
          'for it.',
      });
      // This rest-only cutter has nothing left to cut, but a LATER ref may own items and still
      // has a program to post, so the group goes on. (`break` here ended the whole group at the
      // first empty rest.)
      continue;
    }
    const restJobBase = restJobFor(job, kept, restRef.toolKey);
    // The generator's readers (`validateJob` inside `engraveRegions`, the verifier) resolve the
    // cutter through `job.tool` or the WORKER's registry, which is empty. The rest job names a key
    // the route resolved on this realm's side, so it is materialised exactly as `jobForSetup` does.
    const restJob: EngraveJob = { ...restJobBase, tool: restTool };
    const makeRest = (span: VacuumSpan): OneProgram =>
      generateOneProgram(
        tl,
        restJob,
        restTool,
        catalogue,
        calibration,
        margins,
        shop,
        span,
        false,
        'finish-only',
        // Only the LAST rest program of a pair that ends the run leaves the neck.
        withNeck && r === restTools.length - 1,
        undefined,
        floors,
      );
    const restOne = makeRest(restSpan);
    nextCursor += 1;
    attempts.push(restOne);
    if (!restOne.ok || restOne.nc === null || restOne.verify === null) break;
    const restRecord: PostedProgram = { ref: restRef, one: restOne, make: makeRest, span: restSpan };
    posted.push(restRecord);
    const p2 = simulateProgram(tl, restJob, restOne.nc, restTool, calibration, shop, removal ?? undefined);
    const p2Problem = simRefusal(p2);
    if (!p2.ok || p2Problem !== null) {
      findings.push({
        severity: 'error',
        code: 'setup-rest-unavailable',
        message:
          `Setup ${restRef.setupIndex}'s rest program (${restRef.toolKey}) could not be measured: ` +
          `${p2Problem ?? 'the simulation refused it'}.`,
      });
      break;
    }
    // What neither program touches: the same measurement on the union of both removals, at zero
    // overlap, so `restArea` is design material left standing and not the seam band.
    removalMeshes = [...removalMeshes, ...(p2.meshes.removal === null ? [] : [p2.meshes.removal])];
    const both = unionRemoval(tl, removalMeshes);
    const left = restMachining(tl, { removal: both, cuts: design.cuts, overlap: 0 });
    if (link === null) {
      const reached = new Set(kept.map((k) => k.id));
      link = {
        rough: roughRecord,
        rest: restRecord,
        roughJob: roughJobKept,
        restJob,
        roughKey: roughRef.toolKey,
        restKey: restRef.toolKey,
        roughDiameter,
        restDiameter,
        roughShare,
        roughReason:
          `${roughRef.toolKey} cuts first: the setup names it as the first cutter` +
          (unroughed.length > 0 ? `, and it cannot enter ${unroughed.length === 1 ? 'one item' : `${unroughed.length} items`} at all` : '') +
          (glyphArea > 0 ? `, reaching ${Math.round(roughShare * 100)} % of the design's area` : '') +
          '.',
        restReason:
          `${restRef.toolKey} cleans up: the setup names it after ${roughRef.toolKey}, and its ` +
          `regions are measured against what the earlier programs' own sweeps left.`,
        unroughed: unroughed.filter((u) => reached.has(u.id)),
        regions: kept,
        rest1,
        left,
        p1,
        p2,
        seam,
        thirdToolPct: thirdRead.value,
        thirdToolSource: thirdRead.source,
      };
    }
    // p2's mesh is the material ITS OWN cuts removed (the seed only told the sweeper what was
    // already gone), so the cumulative part for a third cutter is the union of every program's
    // mesh — p1's, any owning cutter's, and this rest pass's.
    removal = unionRemoval(tl, removalMeshes);
  }

  return {
    attempts,
    posted,
    link,
    cursor: nextCursor,
  };
}

/**
 * The goal object a PURE 3D-surfacing job is (#534, slice D), or `null` — `pureGoalObject` from
 * `jobSetup`, the ONE definition the validation and the setup bookkeeping read too (#535), so the
 * dispatch and the panel cannot disagree about which jobs are pure-goal.
 */

/**
 * The empty program-fields shell a goal result fills, so its return matches `EngraveGenerated`.
 */
function emptyGoalResult(): Omit<EngraveGenerated, 'ok' | 'stage' | 'findings' | 'feeds' | 'cam' | 'nc' | 'verify'> {
  return {
    threads: null,
    threadMachining: null,
    frameNc: null,
    frameVerify: null,
    facingNc: null,
    facingVerify: null,
    facingToolKey: null,
    facingError: null,
    facingCam: null,
    predicted: [],
    programs: [],
    errors: [],
  };
}

/**
 * 3D SURFACING FROM A GOAL MESH (#534, slice D) — the generate worker's dispatch to `cam/surface3d`.
 *
 * It samples the goal to a top-Z heightfield and emits a raster-roughing + ball-finishing toolpath
 * to the IR, then posts it. Feeds are the job's ordinary 2.5D feeds (a ball resolves them through a
 * flat proxy of its cutting diameter — a LABELLED placeholder, never a measured 3D feed: that is
 * the bench slice F, #536).
 *
 * `verify` is deliberately `null`: the exact 2.5D sweep (`verifyProgram`) cannot judge a 3D ball
 * program — a ball "can neither sweep nor trace" there — so the honest check is the FLAT dexel
 * (slice A), which the UI wires in slice E (#535). Until then the program is generated and posted
 * but is NOT promoted into `programs`, exactly as the single-file adapter already leaves an
 * unverified program out. The dry proof that the toolpath reproduces the goal is the unit spec.
 */
/**
 * #721 — the steepest cavity wall a mold is cut with before it is warned as having no draft, degrees
 * from horizontal. A labelled default: casting practice wants a degree or more of draft, and the
 * grid's own staircase reads a true vertical wall as a little under 90°.
 */
export const MOLD_DRAFT_LIMIT_DEG = 85;

export function generateGoalProgram(
  job: EngraveJob,
  goal: EngraveTargetObject,
  tool: Tool | null,
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null,
  shop: EngraveShopOpts,
): EngraveGenerated {
  const base = emptyGoalResult();
  const fail = (stage: EngraveStage, message: string, feeds: FeedsResult | null = null): EngraveGenerated => ({
    ...base,
    ok: false,
    stage,
    findings: [],
    feeds,
    cam: null,
    nc: null,
    verify: null,
    errors: [{ stage, message }],
  });

  // #726 W16 — THE DOCUMENT'S OWN FINDINGS RIDE WITH A GOAL RUN. The item pipeline has always
  // merged `validateJob` and the vise's validator into the run's findings; this dispatch returned
  // an empty list, so a goal job on the shipped default vise never carried `vise-default` — and
  // Save/Upload/Release asked for no clearance tick while Cut step 1 had no warning to show it.
  const documentFindings = (): JobFinding[] =>
    dedupeFindings([
      ...validateJob(job, null, { bed: shop.bed ?? null, defaults: shop.defaults }),
      ...(job.workholding.kind === 'vise' ? validateVise(job.stock, job.workholding.vise, job.sacrificial) : []),
    ]);

  // #539 — the pure-goal dispatch runs BEFORE the item pipeline's `validateJob`, so the
  // `goal-object-oversize`/zero-volume check (#533) never reaches a goal that is surfaced here.
  // Run the SAME validation and refuse an unmakeable goal with its blocking finding, rather than
  // sampling and posting a program the Cut gate would otherwise have to catch with no finding.
  const goalFindings = validateGoalObject(goal, job.stock, { minFloor: job.minFloor, edgeMargin: job.edgeMargin });
  const blocking = goalFindings.filter((f) => f.severity === 'error');
  if (blocking.length > 0) {
    return {
      ...base,
      ok: false,
      stage: 'findings',
      findings: dedupeFindings([...goalFindings, ...documentFindings()]),
      feeds: null,
      cam: null,
      nc: null,
      verify: null,
      errors: blocking.map((f) => ({ stage: 'findings' as EngraveStage, message: f.message })),
    };
  }

  if (tool === null) return fail('feeds', 'the job has no usable cutter');
  const mill = jobMachine(job, calibration);

  // Feeds — the job's 2.5D feeds, reused unchanged (slice F tunes 3D engagement, #536). A ball/bull
  // is refused by `feedsFor` (it cannot trace), so its feeds come through a FLAT proxy of its
  // cutting diameter; a flat cutter resolves directly.
  const isRound = tool.shape === 'ball' || tool.shape === 'bull';
  const feedTool = isRound ? flatEndMill(cuttingDiameter(tool) ?? 0, { name: `${tool.name} (feeds via flat proxy)` }) : tool;
  const resolved = feedsFor(catalogue, job.stock.material, feedTool, mill, job.cutOverride, shop.feeds ?? undefined);
  if (!resolved.ok) return fail('feeds', resolved.reason, resolved);

  // #535 — the goal operation's own settings, each falling back to the default it overrides: the
  // feeds row's step-down/step-over, and the shop's finish allowance and flat-grid pitch.
  const settings = goal.surface ?? {};
  const stockToLeaveMm = settings.stockToLeaveMm ?? shop.finish?.stockToLeaveMm.value;
  const gridPitchMm = settings.gridPitchMm ?? shop.surfaceGrid?.pitchMm.value ?? null;

  const feeds: SurfaceFeeds = {
    feed: resolved.params.feed,
    plungeFeed: resolved.params.plungeFeed,
    stepDown: settings.roughStepDownMm ?? resolved.params.stepDown,
    roughStepOver: settings.roughStepOverMm ?? resolved.params.stepOver,
    // A ball finish wants a finer step-over than a flat pocket's; no measured 3D number exists yet
    // (slice F), so the pocketing step-over stands as the labelled placeholder unless the goal
    // operation states its own.
    finishStepOver: settings.finishStepOverMm ?? resolved.params.stepOver,
  };
  // #671 — the two extra finishing passes are OPT-IN: absent = today's rough + parallel finish.
  const scallop = settings.scallop === true;
  const pencil = settings.pencil === true;
  const pencilCreaseDeg = settings.pencilCreaseDeg;

  let surfaced: ReturnType<typeof generateSurface3dForGoal>;
  try {
    surfaced = generateSurface3dForGoal({
      target: goal,
      tool,
      toolNumber: toolNumberFor(tool),
      spindleRpm: resolved.params.rpm,
      air: job.cutOverride?.air ?? true,
      feeds,
      rapid: mill.rapidEstimate,
      sample: gridPitchMm === null ? undefined : { pitchMm: gridPitchMm },
      opts: {
        stockToLeaveMm,
        scallop,
        pencil,
        ...(pencilCreaseDeg === undefined ? {} : { pencilCreaseDeg }),
      },
    });
  } catch (e) {
    return fail('cam', e instanceof Error ? e.message : String(e), resolved);
  }
  if (surfaced === null) {
    return fail('cam', `the goal "${goal.name}" lies at or above the stock top, so there is no surface to cut`, resolved);
  }

  // #721 — a MOLD's honest limits, said once. It is one-sided (cut from the top, so the cavity is
  // the part's top surface and the casting's underside is the flat pour face), and a wall with no
  // draft holds the casting: warn past the labelled limit, naming the steepest wall found.
  const moldFindings: JobFinding[] = [];
  if (isMold(goal)) {
    const steepest = steepestWallDeg(surfaced.heightfield);
    moldFindings.push({
      severity: 'info',
      code: 'goal-mold-one-sided',
      message:
        `The mold of "${goal.name}" is cut from the top only: the cavity is the part's top surface, ` +
        'turned over so the casting reads the right way round, and the casting\'s underside is the ' +
        'flat face you pour into. A part with undercuts, or one shaped on both sides, needs a ' +
        'two-part mold — two setups.',
    });
    if (steepest > MOLD_DRAFT_LIMIT_DEG) {
      moldFindings.push({
        severity: 'warning',
        code: 'goal-mold-no-draft',
        message:
          `The mold of "${goal.name}" has a wall at ${Number(steepest.toFixed(1))}° — steeper than ` +
          `${MOLD_DRAFT_LIMIT_DEG}°, so it has little or no draft and may hold the casting. Give the ` +
          'part tapered sides, or use a flexible casting material.',
      });
    }
  }

  const ctx: PostContext = {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    zDatum: 'probed-top-face',
    origin: 'topFrontLeft',
    camVersion: CAM_VERSION,
    toolKey: job.toolKey,
  };
  let nc: string;
  try {
    const posted = postZ1(surfaced.ir, ctx, mill, { vacuum: 'whole' });
    if (!posted.ok) return fail('post', posted.errors.join('; '), resolved);
    nc = posted.text;
  } catch (e) {
    return fail('post', e instanceof Error ? e.message : String(e), resolved);
  }

  // #535 — THE GOAL PROGRAM JOINS THE RUN. It is a release source like any other: the package
  // freezes it, the Cut step plays it and the upload seam takes it. Its check is the material
  // sweep (the 2.5D verifier cannot judge a 3D program), recorded with the heightfield's grid and
  // the CAM's roughing layers; the run store stamps the dexel grid the simulation actually ran on
  // once the sweep has happened.
  //
  // #671 — the check also carries the PASSES it was made over. The grid says what the sweep is
  // good to; the pass list says what that sweep judged, so a dropped finishing pass is visible in
  // the frozen package instead of assumed.
  const surfaceCheck: SurfaceProgramCheck = {
    kind: 'surface',
    gridPitchMm: surfaced.heightfield.pitch,
    roughingLayers: surfaced.roughingLayers,
    passes: surfaced.ir.operations.map((op) => op.name),
    resolutionNote: surfaced.heightfield.resolutionNote,
    bbox: pathBbox(surfaced.ir),
  };
  const cam = summarize(surfaced.ir);
  const program: EngraveProgram = {
    kind: 'engrave',
    setupIndex: 1,
    setupId: jobSetups(job)[0]!.id,
    toolKey: job.toolKey,
    nc,
    frame: surfaced.ir.frame,
    verify: null,
    surfaceCheck,
    frameNc: null,
    frameVerify: null,
    programHash: programHash(nc),
    cam,
  };

  return {
    ...base,
    ok: true,
    stage: 'done',
    findings: dedupeFindings([...documentFindings(), ...moldFindings]),
    feeds: resolved,
    cam,
    nc,
    verify: null,
    programs: [program],
    // #535 — the operation's own facts, for its row and the run sheet: the numbers the CAM ran
    // with and the grid it sampled. A caller with no generated result has no facts to print.
    surface3d: {
      resolutionNote: surfaced.heightfield.resolutionNote,
      gridPitchMm: surfaced.heightfield.pitch,
      gridCells: surfaced.heightfield.nx * surfaced.heightfield.ny,
      stepDownMm: feeds.stepDown,
      roughStepOverMm: feeds.roughStepOver,
      finishStepOverMm: feeds.finishStepOver,
      stockToLeaveMm: stockToLeaveMm ?? DEFAULT_STOCK_TO_LEAVE_MM,
      roughingLayers: surfaced.roughingLayers,
      scallop: surfaced.scallop === null ? null : surfaced.scallop.facts,
      pencil: surfaced.pencil === null ? null : surfaced.pencil.facts,
      // #721 — the run sheet and the row say a mold is a mold.
      notes: isMold(goal)
        ? [
            ...surfaced.notes,
            "Made as a mold: the part's shape is cut as a cavity from the stock's top face, turned over so a casting reads the right way round.",
          ]
        : surfaced.notes,
    } satisfies GoalSurfaceFacts,
  };
}

/**
 * The XY extent of a program's positioned moves, for the console's laser frame (#535). The
 * verifier's report normally carries this bbox; a surface program has no report, and its check
 * carries the same fact so the frame is still the program's own outline.
 */
function pathBbox(ir: ToolpathIR): { min: [number, number]; max: [number, number] } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const op of ir.operations) {
    for (const m of op.moves) {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
      minX = Math.min(minX, m.x);
      minY = Math.min(minY, m.y);
      maxX = Math.max(maxX, m.x);
      maxY = Math.max(maxY, m.y);
    }
  }
  return Number.isFinite(minX)
    ? { min: [minX, minY], max: [maxX, maxY] }
    : { min: [0, 0], max: [0, 0] };
}

/**
 * Generate, post and verify one engrave job.
 *
 * `tool` is the resolved cutter, HANDED IN (#305): this runs in the sim worker, where neither the
 * job store nor the tool registry can be read, so the caller resolves it (`jobTool(job)` on the
 * main thread) and the same object reaches the findings, the feeds, the CAM, the post and the
 * verifier. `null` is not an error to swallow — it stops at the feeds stage with "the job has no
 * usable cutter", which is exactly what `tool-missing` says above it.
 *
 * `catalogue` is Makera's feed rows, HANDED IN for the same reason (#324): `feeds.ts`'s own copy
 * lives in this worker's module realm and is always empty, so resolving feeds here without the
 * caller's rows would post the STARTING TABLE's numbers under a panel showing the catalogue's. The
 * `.nc` and the run sheet are cut from this call's result, so it is the numbers the operator reads
 * against the numbers the machine runs that is at stake.
 *
 * `margins` is the job's depth thresholds as the MAIN THREAD resolved them (#345), for the same
 * reason `catalogue` is handed in: the house setting lives in `useSettingsStore`, which this realm
 * cannot read. Omitted — a test, or a caller with no settings — the job's own record answers, and a
 * job that carries none falls back to the shipped default, so nothing here needs a store to be
 * correct.
 *
 * `calibration` is the machine's own frame, if the user has one saved (#279). The machine is resolved
 * from it ONCE here (#297) and that one object feeds the feeds, the post, the setup, the verifier and
 * the frame file — the same object the caller loads the simulation with. Before this, the verifier
 * expanded `M6`, `G28` and the probe cycle against the vendor's anchors while the simulation expanded
 * them against the calibrated ones, so the gate and the sim judged two different machines for one .nc.
 *
 * `shop` is the engrave pipeline's shop defaults (#451), read by the caller for the same reason
 * `margins` is: `engrave.lostDetailWarnRatio` decides which items the findings warn about, and
 * `drill.peckClearanceMm` decides where each peck's re-entry rapid stops. Omitted, both modules keep
 * their labelled fallbacks, so a test or a headless script with no location still cuts the same
 * program the shipped default would.
 *
 * IT RETURNS A LIST (#419 J3). `programs` is the job's files in cut order, one per setup, each
 * posted, verified and FNV-keyed on its own; the older single-program fields (`nc`, `verify`,
 * `frameNc`, `cam`) describe the FIRST program, which is the file the panels upload and simulate
 * until #419 §3's multi-program upload lands. A job with no `setups[]` is exactly one program and
 * takes the pre-#419 path unchanged, so its bytes do not move.
 */
export function engraveGenerate(
  tl: ManifoldToplevel,
  job: EngraveJob,
  tool: Tool | null,
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null = null,
  margins: EngraveMargins = effectiveMargins(job, MARGIN_DEFAULTS),
  shop: EngraveShopOpts = {},
): EngraveGenerated {
  // #473 — A MATERIAL `facingRefusal` REFUSES IS REFUSED OUTRIGHT, BEFORE ANY PROGRAM IS POSTED.
  //
  // #474 settled that facing is offered for wood and metal only: a flat cutter smears a plastic
  // top. The panel and the seed keep honest jobs honest, but a legacy or hand-edited document can
  // still carry the pass. It must not reach the run order: the engraving program is posted in the
  // document frame, whose Z0 is the FACED top, so a run whose skim will not happen would cut every
  // depth from the wrong surface. The refusal names the material's rule and the way out, and it
  // happens here — before the setups, the CAM and either program — rather than at the face file
  // alone. The predicate is `facingRefusal`'s, so every material it refuses — every non-wood,
  // non-metal blank, including acrylic and the other plastics (#493) — reaches this finding with
  // the material named.
  const facingWanted = job.facing !== undefined && job.facing.enabled && job.facing.depth > 0;
  const facingMaterialRefusal = facingWanted ? facingRefusal(job.stock.material) : null;
  if (facingMaterialRefusal !== null) {
    return {
      ok: false,
      stage: 'findings',
      findings: [
        {
          severity: 'error',
          code: 'facing-plastic',
          message: `${facingMaterialRefusal}. Turn facing off in the Cut panel and generate again.`,
        },
      ],
      feeds: null,
      threads: null,
      threadMachining: null,
      cam: null,
      nc: null,
      verify: null,
      frameNc: null,
      frameVerify: null,
      facingNc: null,
      facingVerify: null,
      facingToolKey: null,
      facingError: facingMaterialRefusal,
      facingCam: null,
      surface: null,
      predicted: [],
      programs: [],
      errors: [],
    };
  }

  // #534 slice D — A PURE 3D-SURFACING JOB. A job whose only work is a `role: 'goal'` mesh is
  // surfaced by `cam/surface3d` (raster roughing + ball finishing over the goal's heightfield),
  // dispatched here BEFORE the item pipeline, which has nothing to cut. A goal mixed with item work
  // stays on the path below (the items cut; the goal keeps its `goal-object-no-toolpath` info).
  const goal = job.setups === undefined ? pureGoalObject(job) : null;
  if (goal !== null) {
    // #623 — the surface-3D goal path posts flat (it never lifts feeds), so its package claims no
    // surface: the caller judges it in the work frame, which is the frame it was posted in.
    return { ...generateGoalProgram(job, goal, tool, catalogue, calibration, shop), surface: null };
  }

  // #419 J3 — A JOB IS A LIST OF PROGRAMS.
  //
  // The job document says how many: one per setup (J2's `setups[]`), each cut with that setup's own
  // cutter, each posted and verified on its own — because one FILE has one tool, and the run is the
  // files played in order. `setupPrograms` is that reading; this function is the loop over it plus
  // the adapter back to the single-program shape every existing caller reads.
  //
  // A LEGACY DOCUMENT (no `setups[]`) takes exactly today's path, unfiltered: one program, the whole
  // job, `postZ1`'s default vacuum span. Deriving its single setup and re-filtering the lists would
  // drop disabled and construction items from the CAM's input, which is a behaviour change this
  // issue does not own.
  //
  // #748 — THE DOCUMENT'S SUPPORTING FLOORS, computed ONCE before any program is split: a program's
  // sub-job holds only its own items, and the pocket a label is written into may be cut by another
  // setup's program. One plan, one map, handed to every program so every file judges the label
  // from the floor the run cuts under it.
  const documentFloors = supportingFloors(tl, toPartPlan(job));
  if (job.setups === undefined) {
    const one = generateOneProgram(
      tl,
      job,
      tool,
      catalogue,
      calibration,
      margins,
      shop,
      'whole',
      true,
      'rough-and-finish',
      true,
      undefined,
      documentFloors,
    );
    // #677 — a legacy document names ONE cutter, so a variable carve's core cannot be cleared: it
    // stands, and the warning says what to add. A job that has setups gets the same sentence from
    // the loop below, with the setup's number on it.
    const coreWarnings = (one.cores?.length ?? 0) === 0 ? [] : coreWarningFindings(one.cores!, null);
    const oneReady: OneProgram =
      coreWarnings.length === 0 ? one : { ...one, findings: dedupeFindings([...one.findings, ...coreWarnings]) };
    const ref: JobProgramRef = {
      setupIndex: 1,
      setupId: jobSetups(job)[0]!.id,
      toolKey: job.toolKey,
      itemIds: [],
    };
    const face = facingProgramOf(oneReady, ref);
    const engraved = oneReady.ok && oneReady.nc !== null && oneReady.verify !== null ? [programOf(oneReady, ref)] : [];
    // #623 — the frame the programs were posted against; the panel loads the simulation with it.
    return { ...oneReady, surface: shop.surface ?? null, programs: [...(face === null ? [] : [face]), ...engraved] };
  }

  // A setup that cannot become exactly one program is refused BEFORE anything is cut: the panel's
  // validation says the same sentence (#419 J3, `setupProgramFindings`).
  const setupProblems = setupProgramFindings(job);
  if (setupProblems.length > 0) {
    return {
      ok: false,
      stage: 'findings',
      // #725 B7 — the bed facts ride this call too: it is the same document gate as `engraveRegions`,
      // and a through sentence judged without them would name the vise on a bed job.
      findings: dedupeFindings([...setupProblems, ...validateJob(job, null, { bed: shop.bed ?? null, defaults: shop.defaults })]),
      feeds: null,
      threads: null,
      threadMachining: null,
      cam: null,
      nc: null,
      verify: null,
      frameNc: null,
      frameVerify: null,
      facingNc: null,
      facingVerify: null,
      facingToolKey: null,
      facingError: null,
      facingCam: null,
      surface: null,
      predicted: [],
      programs: [],
      errors: [],
    };
  }

  // #472 — ONE PROGRAM PER (SETUP, TOOL), and a later cutter is a REST PASS.
  //
  // A one-cutter setup is generated exactly as it was. A setup naming two or more cutters runs its
  // first program, SWEEPS it, measures the rest against that sweep, and generates the second file
  // from the measured regions — the CLI route's order (#410), now inside the app's own generator so
  // the panel, the run plan and the sheet all see the same two files. The measured facts are carried
  // on `restPass` for the sheet; nothing about program 1's geometry depends on them.
  const refs = setupPrograms(job);
  const setups = jobSetups(job);
  const attempts: OneProgram[] = [];
  const posted: PostedProgram[] = [];
  const restFindings: JobFinding[] = [];
  let restLink: RestLink | null = null;
  let cursor = 0;
  const spanAt = (index: number): VacuumSpan =>
    refs.length === 1 ? 'whole' : index === 0 ? 'first' : index === refs.length - 1 ? 'last' : 'middle';

  for (let s = 0; s < setups.length; s++) {
    const group = refs.filter((ref) => ref.setupIndex === s + 1);
    // #434 — A DRILL BIT IS NEVER A REST CUTTER. The setup's refs are partitioned into maximal
    // runs that keep their order: a drill ref is ONE program in place, and a run of end-mill refs
    // takes #472's model exactly as before (one program, or rough + measured rest). Partitioning
    // rather than special-casing the whole group keeps the (setup, tool) list the one split — the
    // drill is just another program in it — and leaves the rest-pass geometry untouched.
    const segments: { drill: boolean; refs: JobProgramRef[] }[] = [];
    for (const ref of group) {
      const drill = toolForProgram(ref, job, tool, shop)?.shape === 'drill';
      const last = segments.at(-1);
      if (last !== undefined && last.drill === drill) last.refs.push(ref);
      else segments.push({ drill, refs: [ref] });
    }

    for (const segment of segments) {
      const segmentRefs = segment.refs;
      // #737 — only the last segment of the last setup is the RUN'S last cut, so only its last
      // program leaves the neck; every earlier program cuts the part alone.
      const lastGroup = s === setups.length - 1 && segment === segments[segments.length - 1];
      if (segment.drill || segmentRefs.length <= 1) {
        const ref = segmentRefs[0];
        if (ref === undefined) continue;
        // Decision 4 — the vacuum words are spread across the RUN: on in the first program, off in
        // the last, neither in the ones between. One program is the whole run. These are provisional
        // while the rest pass decides how many files the run really has; `posted` settles them below.
        const span = spanAt(cursor);
        const subTool = toolForProgram(ref, job, tool, shop);
        const make = (nextSpan: VacuumSpan): OneProgram =>
          generateOneProgram(
            tl,
            jobForSetup(job, ref, subTool),
            subTool,
            catalogue,
            calibration,
            margins,
            shop,
            nextSpan,
            cursor === 0,
            'rough-and-finish',
            lastGroup,
            undefined,
            documentFloors,
          );
        const one = make(span);
        attempts.push(one);
        if (one.ok && one.nc !== null && one.verify !== null) posted.push({ ref, one, make, span });
        // #677 — a variable carve with no later cutter leaves its CORE standing: say so with the
        // area and name what to add. A core the clearance program clears raises nothing; the core
        // program's own section of the sheet states it.
        if (one.ok && (one.cores?.length ?? 0) > 0) {
          restFindings.push(...coreWarningFindings(one.cores!, { setupIndex: ref.setupIndex, toolKey: ref.toolKey }));
        }
        cursor += 1;
        continue;
      }

      const roughTool = toolForProgram(segmentRefs[0]!, job, tool, shop);
      const restTools = segmentRefs.slice(1).map((ref) => toolForProgram(ref, job, tool, shop));
      const base = posted.length;
      const pair = generateRestPair(
        tl,
        job,
        segmentRefs,
        roughTool,
        restTools,
        catalogue,
        calibration,
        margins,
        shop,
        cursor === 0,
        lastGroup,
        cursor,
        refs.length,
        restFindings,
        documentFloors,
      );
      attempts.push(...pair.attempts);
      posted.push(...pair.posted);
      if (pair.link !== null) {
        restLink = {
          ...pair.link,
          roughIndex: base,
          restIndex: base + pair.posted.indexOf(pair.link.rest),
        };
      }
      cursor = pair.cursor;
    }
  }

  // Settle the run's vacuum words against the programs that really posted. A rest pass that had
  // nothing to cut leaves fewer files than `refs` predicted, so the last actual program has to
  // become the run's last word; regenerating only the boundary files keeps every other byte where
  // it was.
  const total = posted.length;
  posted.forEach((program, i) => {
    const want: VacuumSpan = total === 1 ? 'whole' : i === 0 ? 'first' : i === total - 1 ? 'last' : 'middle';
    if (want === program.span) return;
    const next = program.make(want);
    if (next.ok && next.nc !== null && next.verify !== null) {
      program.one = next;
      program.span = want;
    }
  });

  const restPass = restLink === null ? null : assembleRestFacts(restLink, posted);
  const first = attempts[0]!;
  const stopped = attempts.find((one) => !one.ok);
  // #737 review item 1 — the neck is carried by a PROGRAM, not by the job. A run that drops its
  // last rest program (`setup-rest-nothing`) posts nothing that cuts the neck, and the per-program
  // check never fires because no program was asked to carry it. Refuse the run itself here, so the
  // panels' "the part stays on a neck" sentence is never shown for a neck nothing cut.
  if (stopped === undefined && rotaryNeckOf(job) !== null && !posted.some((p) => p.one.neck != null)) {
    restFindings.push({
      severity: 'error',
      code: 'neck-not-cut',
      labelId: ROTARY_NECK_ID,
      message: neckNoProgramSentence(),
    });
  }
  const restErrors = restFindings.filter((f) => f.severity === 'error');
  return {
    // The adapter: the top-level fields describe the FIRST program, which is the file the panels
    // upload, simulate and save today. Multi-program upload is #419 §3's, not this slice's.
    ...first,
    ok: stopped === undefined && restErrors.length === 0,
    stage: stopped?.stage ?? (restErrors.length > 0 ? 'findings' : 'done'),
    findings: dedupeFindings([...attempts.flatMap((one) => one.findings), ...restFindings]),
    errors: attempts.flatMap((one) => one.errors),
    // #623 — the frame the programs were posted against; the panel loads the simulation with it.
    surface: shop.surface ?? null,
    programs: posted.flatMap((program) => {
      // #473 — the face file is the run's first program, then the setup's own. Only the first
      // program builds it (`generateOneProgram`'s `withFacing`), so only the first posted one can
      // add it.
      const face = facingProgramOf(program.one, program.ref);
      return [
        ...(face === null ? [] : [face]),
        programOf(program.one, program.ref),
      ];
    }),
    restPass,
  };
}

/** One program as the result's list entry, keyed by the FNV of its posted text (decision 3). */
function programOf(one: OneProgram, ref: JobProgramRef): EngraveProgram {
  const nc = one.nc!;
  return {
    kind: 'engrave',
    setupIndex: ref.setupIndex,
    setupId: ref.setupId,
    toolKey: ref.toolKey,
    nc,
    // #240 — stated, not inferred: a result stored before the field existed reads as flat.
    frame: one.frame ?? 'flat',
    verify: one.verify!,
    frameNc: one.frameNc,
    frameVerify: one.frameVerify,
    frameZ: one.frameZ ?? null,
    frameError: one.frameError ?? null,
    programHash: programHash(nc),
    cam: one.cam,
    drill: one.drill ?? null,
    finish: one.finish ?? null,
    through: one.through ?? null,
    bore: one.bore ?? null,
    chamfer: one.chamfer ?? null,
    core: one.core ?? null,
    neck: one.neck ?? null,
  };
}

/**
 * #473 — the FACING file as the run order's first entry, or null when no face file was produced.
 *
 * It shares the first setup's index (there is one blank, so one skim, and it happens before setup
 * 1) but carries the FACING cutter's key, so the release step loads and runs it exactly as it does
 * any other file. It has no frame file: the face program is its own dry-run subject on the sheet.
 */
function facingProgramOf(
  one: Omit<EngraveGenerated, 'programs'>,
  ref: JobProgramRef,
): EngraveProgram | null {
  if (one.facingNc === null || one.facingVerify === null || one.facingToolKey === null) return null;
  return {
    kind: 'facing',
    setupIndex: ref.setupIndex,
    setupId: ref.setupId,
    toolKey: one.facingToolKey,
    nc: one.facingNc,
    verify: one.facingVerify,
    frameNc: null,
    frameVerify: null,
    programHash: programHash(one.facingNc),
    cam: null,
  };
}

/**
 * The cutter a program runs: the caller's resolved `Tool` when the program is the job's own cutter,
 * otherwise the same key in the run's registry snapshot (`shop.tools`).
 *
 * The worker cannot see the tool registry (#305), which is why the job's cutter arrives as an
 * argument at all. A setup naming a cutter that is in neither place returns null and the program
 * stops at `feeds` with "the job has no usable cutter" — the same refusal a missing job cutter got.
 */
function toolForProgram(
  ref: JobProgramRef,
  job: EngraveJob,
  tool: Tool | null,
  shop: EngraveShopOpts,
): Tool | null {
  if (ref.toolKey === job.toolKey && tool !== null) return tool;
  const entry = (shop.tools ?? []).find((e) => e.key === ref.toolKey);
  return entry?.tool ?? (ref.toolKey === job.toolKey ? tool : null);
}

/**
 * The engraving program's share of the run's vacuum words when a FACING file was produced for it
 * (#432 review R3).
 *
 * The vacuum words belong to the RUN (#419 decision 4), and the facing file is its first program:
 * it is posted `'first'`, switching the vacuum on before the skim, and it stays on across the bit
 * change to the engraving cutter. So the engraving program is no longer first — `'whole'` becomes
 * `'last'` (it opens nothing and closes the run), and a multi-setup run's own first program becomes
 * `'middle'`. The other two are unchanged: neither opens the run.
 *
 * Only applied when the facing file EXISTS. A facing file the verifier withheld leaves the
 * engraving as the run's first program, and it carries both words itself.
 */
function spanAfterFacing(span: VacuumSpan): VacuumSpan {
  if (span === 'whole') return 'last';
  if (span === 'first') return 'middle';
  return span;
}

/**
 * ONE program: the pipeline as it shipped, for one setup and one cutter. Returns everything the
 * result carries EXCEPT `programs` — the list is assembled by the loop in `engraveGenerate`, which
 * is the only place that knows how many programs the job has.
 *
 * `span` is this file's share of the run's vacuum words (decision 4) and `withFacing` says whether
 * this program builds the job's facing file. The facing pass is a property of the BLANK, not of a
 * setup, so exactly one program in a run produces it — the first, so the operator faces before any
 * cut. That file is the run's FIRST program and takes the first word; this program's own span is
 * then moved along by `spanAfterFacing`.
 */
function generateOneProgram(
  tl: ManifoldToplevel,
  job: EngraveJob,
  tool: Tool | null,
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null,
  margins: EngraveMargins,
  shop: EngraveShopOpts,
  span: VacuumSpan,
  withFacing: boolean,
  /**
   * #250 — which half of the rough/finish split this program writes. The caller knows it because it
   * knows the (setup, tool) list: a single program writes both, the first of a rest pair roughs, and
   * every later rest program finishes.
   */
  finishMode: FinishPassMode = 'rough-and-finish',
  /**
   * #737 — this program is the RUN'S LAST CUT, so it leaves the neck for parting. Only the last
   * program carries it: the neck must come after every finish pass and be cut once, by the cutter
   * that cut the part. False on every other program, and on a rough-only half of a rest pair.
   */
  withNeck = false,
  /**
   * #677 — the cores this program clears: the derived regions a variable V-carve leaves standing,
   * handed over by the run's generator. Present only on the core-clearance program, whose sub-job
   * has no items of its own.
   */
  derivedCores?: readonly CoreCut[],
  /**
   * #748 — the DOCUMENT's supporting floors, computed once by `engraveGenerate`. A sub-job holds
   * only this program's items and cannot see the pocket another setup cuts, so the map is handed
   * in; omitted (a direct caller), `engraveRegions` computes it from this job's own plan.
   */
  floors?: ReadonlyMap<string, number>,
): OneProgram {
  // #347 — the JOB's machine, not the app's only one: the envelope, the spindle ceiling and the
  // frame below are read off the profile the document names. The POST is still `postZ1`'s dialect,
  // which is the only post this app has; a second mill is a second post, and this line is where a
  // job naming it would have to be refused until there is one.
  const mill = jobMachine(job, calibration);
  const { plan, regions, profiles, throughMask, chamfers, cores, floors: floorById, predicted, findings, releasedPieces, neck } = engraveRegions(
    tl,
    job,
    tool,
    margins,
    shop,
    mill,
    catalogue,
    derivedCores,
    floors,
  );
  /**
   * #667 — WHAT THIS PROGRAM IS ASKED TO REMOVE. `predicted` is the design at its stated depths,
   * which is right for a program that reaches full depth; a ROUGH-ONLY program (the first file of
   * a rest pair) stops `stockToLeaveMm` above each split item's floor, and its prediction must
   * say so. Without this the run's oracle reads the finishing allowance as material the file
   * "left" and refuses a pair that cut exactly as planned.
   */
  let predictedForRun = predicted;
  const errors: EngraveFailure[] = [];
  // #240 slice 2 — the map this job is authored on, or null for a flat job. Every rotary branch
  // below reads this ONE value, `rotaryMapOf`'s, so the CAM, the post, the verifier and the
  // success result cannot disagree about whether this run is wrapped.
  const rotaryMap = rotaryMapOf(job);

  const stop = (
    stage: EngraveStage,
    extra?: {
      feeds?: FeedsResult | null;
      message?: string;
      threads?: ThreadMillPlan[] | null;
      threadMachining?: ThreadSettingsResult | null;
      /** #434 — the drill program's facts, when this program is the drill bit's. */
      drill?: DrillProgramFacts | null;
      /**
       * The facing file, when the stop happens AFTER it was built (#432 review R3 — the facing
       * program is produced before the engraving is posted, so a post refusal can now come second).
       * Omitted everywhere else: a run that stops before the artefact exists reports no facing
       * file, no reason and no tool — `facingError` is "the program could not be produced", not
       * "the run stopped first".
       */
      facing?: {
        nc: string | null;
        verify: VerifyReport | null;
        toolKey: string | null;
        error: string | null;
        cam: FacingCamSummary | null;
      };
    },
  ): Omit<EngraveGenerated, 'programs'> => {
    if (extra?.message !== undefined) errors.push({ stage, message: extra.message });
    return {
      ok: false,
      stage,
      findings,
      feeds: extra?.feeds ?? null,
      threads: extra?.threads ?? null,
      threadMachining: extra?.threadMachining ?? null,
      drill: extra?.drill ?? null,
      cam: null,
      nc: null,
      verify: null,
      frameNc: null,
      frameVerify: null,
      facingNc: extra?.facing?.nc ?? null,
      facingVerify: extra?.facing?.verify ?? null,
      facingToolKey: extra?.facing?.toolKey ?? null,
      facingError: extra?.facing?.error ?? null,
      facingCam: extra?.facing?.cam ?? null,
      predicted: predictedForRun,
      errors,
    };
  };

  // #737 review item 3 — a cutter as wide as the neck or wider cuts the whole band away instead of
  // pocketing a floor along it. That used to surface as `neck-not-cut` ("the cutter cannot leave a
  // flat floor"), which blames a cone's shape for a length that is simply too short. The check is
  // here, where `withNeck` and the program's own tool are both known, and before the gate below so
  // the refusal is `neck-too-narrow-for-cutter` at the findings stage. A V-bit or a drill has no
  // flat radius and is left to the existing `neck-not-cut` post-check.
  if (withNeck && neck !== null && tool !== null) {
    const neckCutter = cuttingForTrace(tool);
    if (neckCutter.ok && neckCutter.tool.shape === 'flat') {
      const cutterDiameter = neckCutter.tool.radius * 2;
      // The CAM pulls the neck's region in by `ROTARY_NECK_EDGE_GRID_MM` at each end, so the floor
      // it can leave is that much shorter than the nominal neck: judge the LENGTH THE CUT KEEPS,
      // not the drawing's. The post writes X to 0.001 mm, so the boundary is compared in those
      // integer thousandths: `6.002 - 0.002` is 6 to the post, and the answer must not depend on
      // the binary residue the subtraction happens to leave behind.
      const floorThousandths = Math.round((neck.lengthMm - 2 * ROTARY_NECK_EDGE_GRID_MM) * 1000);
      const cutterThousandths = Math.round(cutterDiameter * 1000);
      if (floorThousandths <= cutterThousandths) {
        findings.push({
          severity: 'error',
          code: 'neck-too-narrow-for-cutter',
          labelId: ROTARY_NECK_ID,
          message:
            'The neck for parting is too short for the cutter: ' +
            `${neckCutterTooWideSentence(neck.lengthMm, tool.name, cutterDiameter)}.`,
        });
      }
    }
  }

  // 1. findings (#200/#201/#203). Any error stops before feeds are even resolved.
  if (findings.some((f) => f.severity === 'error')) return stop('findings');

  // 2. feeds (#202) — OR, for a thread job, the thread settings (#445 D6). A tool the library
  // cannot resolve reads as `tool-missing` above; a tool with no row, or a step-over past the
  // radius (#191), refuses here. A V-BIT passes this gate since #405 — it is a cutter this CAM
  // can trace with, and `radius` being null only says it opens no region — so the refusal is the
  // trace path's own (`cuttingForTrace`), which names a ball nose, a bull nose, or a cone whose
  // header states no tip or angle.
  //
  // A THREAD MILL is refused by `cuttingForTrace` and by `feedsFor` at the same gate, correctly
  // for the region/trace CAM. The thread branch therefore goes BEFORE both and resolves
  // `threadSettings`, which asks the catalogue for a row itself (`catalogueCoverageFor`) and never
  // calls `feedsFor`. A thread-only job is the only job that reaches CAM with a thread mill:
  // `thread-mixed-tools` refuses a thread beside any other cut, because one program has one tool.
  if (tool === null) return stop('feeds', { message: 'the job has no usable cutter' });
  let feeds: FeedsResult | null = null;
  let threadPlans: ThreadMillPlan[] | null = null;
  let threadMachining: ThreadSettingsResult | null = null;
  let drillFacts: DrillProgramFacts | null = null;
  let cutoutFacts: ThroughCutFacts | null = null;
  let ir: ToolpathIR;
  // #250 — the allowance crosses as a plain number+source; the mode is this program's half. No
  // shop finish block at all means no split, so a direct-engine caller and the golden `.nc` are
  // byte-identical to before.
  const finishSpec: FinishPassSpec | null =
    shop.finish == null
      ? null
      : { stockToLeaveMm: shop.finish.stockToLeaveMm.value, mode: finishMode };
  let finishFacts: FinishPassFacts | null = null;
  // #668 — the bore facts the run sheet prints: the pitch the CAM cut and both numbers it came
  // from. Filled after the CAM succeeds, from the same `plan`, tool and feeds it ran with and the
  // same `borePitchMm` it calls — one formula, one reading.
  let boreFacts: BoreProgramFacts | null = null;
  // #669 — the chamfer facts the run sheet prints: the width, the derived tip depth and which kind
  // of rim each bevel breaks. Filled where the CAM is built, from the same plan and cone.
  let chamferFacts: ChamferProgramFacts | null = null;
  // #737 — the neck facts when THIS program cut the neck. Null on every other program: the sheet's
  // saw step belongs to the file that leaves the neck, not to the run as a whole.
  let neckProgram: RotaryNeckFacts | null = null;
  // #432 — the facing depth the plan carries, or 0 when the job does not face. It decides whether
  // the facing artefact is built at all; it never touches the ENGRAVING program, which stays in the
  // document's frame (Z0 = the faced surface) because the re-touch re-zeros Z there between the two
  // programs. Slice 3 orders the two; slice 4 is the re-touch itself.
  const facingDepth = plan.facing?.depth ?? 0;
  if (tool.shape === 'drill') {
    // #434 — A DRILL BIT'S OWN PROGRAM. `cuttingForTrace` and `feedsFor` both refuse a drill (it is
    // not a milling cutter), so this branch is taken BEFORE either. One operation per drill item,
    // `planDrillBit` → `drillBitIR`, joined by `concatToolpathIR` — one tool, so one file — then
    // posted, verified and framed exactly as any other program.
    //
    // The program cuts drilled holes ONLY: one file has one tool, and an engraver's work cannot be
    // done by a bit's point. `validateJob`/`setupProgramFindings` refuse the pairing before this
    // point on a document they see whole; this check guards the sub-job the split actually hands in.
    const otherWork = plan.engraves.length + plan.traces.length + plan.threads.length + plan.cutouts.length;
    if (otherWork > 0) {
      return stop('findings', {
        message:
          `"${tool.name}" is a drill bit, so this program cuts drilled holes only; it also has ` +
          `${otherWork} region, trace or thread item(s) to cut. Give that work to an end mill, in ` +
          'its own setup.',
      });
    }
    if (plan.drills.length === 0) {
      return stop('findings', {
        message: `"${tool.name}" is a drill bit, but this setup assigns it no holes to drill.`,
      });
    }
    const resolvedDrill = shop.drill ?? drillSettings(shop.defaults ?? null);
    const facts: DrillProgramFacts = {
      toolName: tool.name,
      settings: resolvedDrill.settings,
      sources: resolvedDrill.sources,
      plans: [],
      simDrillPoint: {
        deg: resolvedDrill.settings.pointAngleDeg,
        source: resolvedDrill.sources.pointAngleDeg,
      },
    };
    try {
      const irs: ToolpathIR[] = [];
      for (const item of plan.drills) {
        const r = drillBitIR({
          tool,
          holes: item.holes,
          // #218 — a through hole's full diameter clears the underside by the breakthrough. It is
          // the same number the verifier's mask allows, so the hole the file drills and the hole
          // the check expects cannot disagree.
          depth: item.through
            ? { kind: 'through', thickness: job.stock.thickness, breakthroughMm: job.breakthrough }
            : { kind: 'blind', fullDiameterDepth: item.depth },
          // #675 — the hole item's own peck, or the shop's `drill.peckDiameters × ⌀`; the plan
          // records which bound so the run sheet can name it.
          peckMm: item.peckMm ?? null,
          settings: resolvedDrill.settings,
          pointAngleSource: resolvedDrill.sources.pointAngleDeg,
          stock: { length: job.stock.length, width: job.stock.width },
          name: item.name,
          labelId: item.id,
          // Every cut in this app runs with the vacuum on (#283); `cutOverride.air` is the job's
          // own say, and the feeds table never states anything else.
          air: job.cutOverride?.air ?? true,
          rapid: mill.rapidEstimate,
        });
        if (!r.ok) return stop('cam', { message: r.reason, drill: facts });
        facts.plans.push({ ...r.plan, id: item.id, name: item.name });
        irs.push(r.ir);
      }
      // `concatToolpathIR` renumbers the operations from 1, which is its contract (#287).
      ir = irs.slice(1).reduce((a, b) => concatToolpathIR(a, b), irs[0]!);
      drillFacts = facts;
    } catch (e) {
      return stop('cam', { message: e instanceof Error ? e.message : String(e), drill: facts });
    }
  } else if (plan.threads.length > 0) {
    const resolved = threadSettings(shop.defaults ?? null, catalogue, job.stock.material, tool, mill);
    // Carried from here on, refusals included: even a run that stops still knows which numbers it
    // would have cut with and where they came from (#445 phase B's run sheet).
    threadMachining = resolved;
    const refused = resolved.diagnostics.filter((d) => d.severity === 'error');
    if (refused.length > 0) {
      return stop('feeds', { message: refused.map((d) => d.message).join('; '), threadMachining });
    }
    try {
      const plans: ThreadMillPlan[] = [];
      const irs: ToolpathIR[] = [];
      for (const item of plan.threads) {
        const r = threadMillIR({
          tool,
          position: item.position,
          size: item.size,
          depth: item.depth,
          through: item.through,
          settings: resolved.settings,
          stock: { length: job.stock.length, width: job.stock.width },
          descriptor: item.name,
          labelId: item.id,
          // Every cut in this app runs with the vacuum on (#283); `cutOverride.air` is the job's
          // own say, and the feeds table never states anything else.
          air: job.cutOverride?.air ?? true,
          rapid: mill.rapidEstimate,
        });
        if (!r.ok) return stop('cam', { message: r.reason, threadMachining });
        plans.push(r.plan);
        irs.push(r.ir);
      }
      // `concatToolpathIR` renumbers the operations from 1, which is its contract (#287).
      ir = irs.slice(1).reduce((a, b) => concatToolpathIR(a, b), irs[0]!);
      threadPlans = plans;
      // #445 — each thread is an ORACLE item now: the prediction is the plan's own feed geometry
      // against the item's dimensions, so `computeOracle` can judge the thread the program cuts
      // rather than skipping it (D7's no-prediction was a consequence of the old envelope model).
      for (const p of plans) predicted.push(threadPrediction(p));
    } catch (e) {
      return stop('cam', { message: e instanceof Error ? e.message : String(e), threadMachining });
    }
  } else {
    const usable = cuttingForTrace(tool);
    if (!usable.ok) return stop('feeds', { message: usable.reason });
    const resolved = feedsFor(catalogue, job.stock.material, tool, mill, job.cutOverride, shop.feeds ?? undefined);
    if (!resolved.ok) return stop('feeds', { feeds: resolved, message: resolved.reason });
    feeds = resolved;
    // #711 — THE TAPE HOLD RULE (#707 BM-4, design §3.4): the tape must cover `holdRatio × the
    // cutter's bite` under the stock and under every piece a through cut frees. Judged HERE
    // because the bite needs the resolved step-down, and a taped job's pieces were measured with
    // the geometry. Any refusal blocks Generate like the document findings above.
    if (job.workholding.kind === 'tape') {
      // The cutter's own width at the deepest cut: a flat end's radius all the way down, a V-bit's
      // groove wider with depth (#405) — the same function the frame and the trace CAM read.
      const deepest = Math.max(
        0,
        ...regions.map((r) => r.depth),
        ...plan.traces.map((t) => t.depth),
        ...profiles.map((p) => p.depth),
      );
      const radiusAt = traceRadiusAt(tool, deepest) ?? (cuttingDiameter(tool) ?? 0) / 2;
      const hold = readDefault(shop.defaults ?? null, 'tape.holdRatio');
      // #727 F9 — the pieces are freed by the PROFILE pass, which resolves the same row with the
      // slotting context (`feeds.ts`); its step-down is what the released piece's bite is judged at.
      const slottingRow = feedsFor(catalogue, job.stock.material, tool, mill, job.cutOverride, shop.feeds ?? undefined, { slotting: true });
      findings.push(
        ...tapeHoldFindings({
          stock: job.stock,
          tape: job.workholding.tape,
          cutterWords: tool.shape === 'flat' ? 'flat end' : (tool.typeText.toLowerCase() || 'cutter'),
          biteDiameterMm: radiusAt > 0 ? radiusAt * 2 : null,
          stepDownMm: resolved.params.stepDown,
          pieceStepDownMm: slottingRow.ok ? slottingRow.params.stepDown : resolved.params.stepDown,
          holdRatio: hold.value,
          pieces: releasedPieces,
        }),
      );
      if (findings.some((f) => f.severity === 'error')) return stop('findings', { feeds });
    }
    // #218 — a cut-out follows its outline with both sides of the cutter engaged: a full-width
    // SLOT. Resolve the same row again with `slotting`, and use THAT answer for the profile CAM
    // only, so the pocket, trace and rest passes keep the row's pocketing numbers.
    const profileFeeds =
      profiles.length === 0
        ? null
        : feedsFor(
            catalogue,
            job.stock.material,
            tool,
            mill,
            job.cutOverride,
            shop.feeds ?? undefined,
            { slotting: true },
          );
    if (profileFeeds !== null && !profileFeeds.ok) {
      return stop('feeds', { feeds: profileFeeds, message: profileFeeds.reason });
    }

    // 3. the CAM core (#172), on the SAME opened polygons stage 1 measured.
    // #668 — the shop's ramp angle for a bore's helix, read HERE (the worker's realm can resolve
    // `readDefault` against the caller's defaults map, the `drillSettings` precedent) so the CAM
    // and the run sheet's facts below take one number, not two resolutions. A job with no bore
    // never reads it.
    const boreRamp = readDefault(shop.defaults ?? null, 'bore.rampAngleDeg');
    try {
      // A job with no REGION item has nothing for the region CAM to open — and since #405 it must not
      // be handed an empty list either: a trace-only job can now reach this line with a CONE for a
      // tool, and `generateEngrave` refuses a V-bit by name (rightly: opening a region needs the
      // offset radius). The two CAMs return IRs describing the same machine state, so a job with no
      // regions simply IS the trace IR, and its `.nc` is unchanged.
      const regionIr = regions.length === 0
        ? null
        : generateEngrave(
            tl,
            regions,
            tool,
            resolved.params,
            mill.rapidEstimate,
            'nearest',
            shop.peckClearanceMm ?? null,
            finishSpec,
            boreRamp.value,
            // #240 slice 2 — a rotary region is pocketed on its MAP, with the around axis scaled
            // to the floor's own radius (R10's anisotropic opening). The moves stay map-space
            // until `toRotaryIR` below turns them into A.
            rotaryMap === null ? null : { radius: rotaryMap.radius },
          );
      // #287 — single-line traces (#219) are their own CAM: the cutter's centre follows the path,
      // so there is no region to open, no offset and no pocketing. They are appended AFTER the
      // region operations, so a trace can shift no pocket's ordering, and a job with none joins an
      // empty list — the renumbering is a no-op, so its `.nc` is byte-identical to before. Both
      // calls are inside this `try` so a trace CAM refusal reports the same `cam` stage a region
      // refusal does.
      //
      // ORDERING: the classes end up drills → pockets → traces → CUT-OUTS. Drills lead for the
      // reason `generateEngrave` states (#220: a peck cycle leaves the blank unweakened). Traces
      // come BEFORE the cut-outs (#218): a cut-out releases the part, and an engraving made after
      // that would be cut into a piece that can shift under the tape. The profile class is
      // therefore last, and it is the only class that cuts into the board.
      const traceIr = generateTrace(plan.traces, tool, resolved.params, mill.rapidEstimate);
      // #669 — THE CHAMFERS COME BETWEEN THE REGIONS AND THE CUT-OUTS. The order is the material:
      // a pocket's rim must EXIST before its chamfer can follow it, so a pocket chamfer runs after
      // the region CAM; a part's edge must still be in one piece when it is chamfered, so a
      // profile's chamfer runs before the cut-out. One chamfer program between the two satisfies
      // both, and it is one file because the job's cutter is the one cone that cuts every bevel.
      const chamferIr =
        chamfers.length === 0
          ? null
          : generateChamfer(chamfers, tool, resolved.params, mill.rapidEstimate);
      const profileResult =
        profiles.length === 0
          ? null
          : generateProfile(profiles, tool, profileFeeds!.params, mill.rapidEstimate);
      const beforeCutouts =
        regionIr === null ? traceIr : traceIr.operations.length > 0 ? concatToolpathIR(regionIr, traceIr) : regionIr;
      const beforeProfiles =
        chamferIr === null
          ? beforeCutouts
          : beforeCutouts.operations.length > 0
            ? concatToolpathIR(beforeCutouts, chamferIr)
            : chamferIr;
      ir =
        profileResult === null
          ? beforeProfiles
          : beforeProfiles.operations.length > 0
            ? concatToolpathIR(beforeProfiles, profileResult.ir)
            : profileResult.ir;
      if (profileResult !== null) {
        const byId = new Map(profiles.map((p) => [p.id, p] as const));
        cutoutFacts = {
          breakthroughMm: job.breakthrough,
          boardThicknessMm: job.sacrificial.under?.thickness ?? null,
          cutouts: profileResult.tabs.map((report) => {
            const cut = byId.get(report.id);
            return {
              id: report.id,
              name: report.name,
              tabs: {
                count: cut?.tabs.count ?? 0,
                widthMm: cut?.tabs.width ?? 0,
                heightMm: cut?.tabs.height ?? 0,
              },
              spans: report.spans,
              unplaceable: report.unplaceable,
            };
          }),
        };
      }

      // #737 — THE NECK FOR PARTING, APPENDED LAST. Everything above this line is the part: the
      // regions, traces, chamfers and cut-outs, and this program is the run's last cut and not a
      // rough half (the caller passes `withNeck` only there). The neck's own region is a plain
      // full-circumference rectangle on the map, cut at its full depth in one program — no rough
      // split and no restatement, so no pass ever leaves it half-cut. The cut is made with the
      // SAME cutter that cut the part, and the appended IR is renumbered by `concatToolpathIR`,
      // which makes it the file's last operation. `toRotaryIR` below turns it into A like the rest.
      if (withNeck && neck !== null && rotaryMap !== null) {
        const neckCutter = cuttingForTrace(tool);
        // A cone leaves a groove, not the flat floor a saw needs; its own refusal is raised below.
        if (neckCutter.ok && neckCutter.tool.shape !== 'v' && neck.depthMm > 0) {
          const neckRegion: EngraveRegion = {
            id: ROTARY_NECK_ID,
            text: '',
            name: 'Neck for sawing off',
            depth: neck.depthMm,
            polygons: rotaryNeckCutRegion(rotaryMap, neck, neckCutter.tool.radius),
          };
          const neckIr = generateEngrave(
            tl,
            [neckRegion],
            tool,
            resolved.params,
            mill.rapidEstimate,
            'nearest',
            shop.peckClearanceMm ?? null,
            // No rough/finish split: the neck is cut to its floor once, after every finish pass.
            null,
            null,
            { radius: rotaryMap.radius },
          );
          if (neckIr.operations.some((op) => op.moves.length > 0)) {
            ir = ir.operations.length === 0 ? neckIr : concatToolpathIR(ir, neckIr);
            neckProgram = neck;
          }
        }
      }
    } catch (e) {
      return stop('cam', { feeds, message: e instanceof Error ? e.message : String(e) });
    }

    // #668 — what the bores in THIS program cut, for the run sheet's pitch step. The cutter radius
    // is the one `generateEngrave` offsets by (`cuttingForTrace`'s flat radius, not a second
    // reading of the tool), and the pitch is the same `borePitchMm` call the CAM makes.
    const boreUsable = cuttingForTrace(tool);
    const cutterRadius = boreUsable.ok && boreUsable.tool.shape === 'flat' ? boreUsable.tool.radius : null;
    if (cutterRadius !== null) {
      const rampAngleDeg = boreRampAngleFrom(boreRamp.value);
      const items: BoreProgramFacts['items'] = [];
      for (const d of plan.drills) {
        if (d.mode !== 'bore' || d.diameter === null || !(d.diameter > 0)) continue;
        const centreRadiusMm = d.diameter / 2 - cutterRadius;
        items.push({
          id: d.id,
          name: d.name,
          holeDiameterMm: d.diameter,
          cutterDiameterMm: cutterRadius * 2,
          centreRadiusMm,
          pitchMm: borePitchMm(resolved.params.stepDown, centreRadiusMm, rampAngleDeg),
          stepDownMm: resolved.params.stepDown,
          rampAngleDeg,
          rampSource: boreRamp.source,
        });
      }
      if (items.length > 0) boreFacts = { items };
    }

    // #669 — what the chamfers in THIS program cut. The depth is derived once, from the same cone
    // the CAM offsets by; the plan's `width` is the top-face leg the operator set.
    const chamferCone = vCone(tool);
    if (chamferCone !== null) {
      const items: ChamferProgramFacts['items'] = [];
      for (const c of plan.chamfers) {
        items.push({
          id: c.id,
          name: c.name,
          widthMm: c.width,
          depthMm: c.width / chamferCone.tanHalf,
          side: c.side,
          tipDiameterMm: chamferCone.tipRadius * 2,
          tipSource: tool.tipDiameter !== null ? 'stated' : 'point, by kind',
        });
      }
      if (items.length > 0) chamferFacts = { items };
    }
  }

  // #737 — A NECK THE LAST PROGRAM COULD NOT CUT IS A REFUSAL, not a quiet omission. Every branch
  // above either cut it (the engraving program, with a flat cutter) or could not: a cone's tip
  // leaves a groove, a drill's point leaves a cone, and neither is the flat floor a saw needs.
  if (withNeck && neck !== null && neckProgram === null) {
    const why =
      tool === null
        ? 'the job has no usable cutter'
        : tool.shape === 'drill'
          ? `"${tool.name}" is a drill bit, whose point leaves a cone, not the flat floor a saw needs`
          : tool.shape === 'engraving' || tool.shape === 'chamfer'
            ? `"${tool.name}" is a V-bit, whose point leaves a groove, not the flat floor a saw needs`
            : `"${tool.name}" cannot cut a flat-bottomed band`;
    findings.push({
      severity: 'error',
      code: 'neck-not-cut',
      labelId: ROTARY_NECK_ID,
      message: `The neck for parting is set, but ${why}. Use a flat end mill for the part, or turn the neck off.`,
    });
    return stop('findings', { message: 'the neck for parting could not be cut by this program' });
  }

  // #240 slice 2 — THE MAP BECOMES THE ROTARY FRAME HERE, ONCE. Everything above is an ordinary
  // flat toolpath authored in map millimetres: X along the axis, Y around the surface at R, Z the
  // map's own height. `toRotaryIR` turns each move's `y` into an unwound A (R9), sets Y to 0,
  // makes Z the radius above the axis, and lifts rapids clear of the stock. The prediction stays
  // in MAP space: the oracle judges it there against the column sweep unfolded the same way.
  if (rotaryMap !== null) ir = toRotaryIR(ir, rotaryMap.radius, mill.rapidEstimate);

  // #649 — THE HOP CLEARS A LIFTED TOP. `applySurfaceLift` shifts FEED moves only, so a rapid that
  // ends at the CAM's fixed `HOP_Z` sits inside a blank the tilt lifts more than that — where the
  // lift exceeds 1 mm the "plunge" starts cutting from inside the material. One number for the
  // whole program: the CAM's hop plus the plane's HIGHEST lift over the stock, applied to every
  // rapid that stands at the hop (a `SAFE_Z` retract is already clear), and carried on the IR so
  // the post's air rule and the verifier's rapid floor judge the same height.
  //
  // #240 — a rotary job has no fitted top face to lift: registration measures a FLAT blank's
  // tilt, and the wrapped frame's Z is a radius. The surface frame is therefore not read at all.
  const surfaceFrame = rotaryMap === null ? (shop.surface ?? null) : null;
  const liftOverStock =
    surfaceFrame === null ? 0 : maxSurfaceLift(surfaceFrame.plane, surfaceFrame.z0, job.stock.length, job.stock.width);
  if (liftOverStock > 0) {
    const hopZ = Math.round((HOP_Z + liftOverStock) * 1000) / 1000;
    ir = {
      ...ir,
      hopZ,
      operations: ir.operations.map((op) => ({
        ...op,
        moves: op.moves.map((m) => (m.kind === 'rapid' && Math.abs(m.z - HOP_Z) <= 1e-9 ? { ...m, z: hopZ } : m)),
      })),
    };
  }
  if (liftOverStock > HOP_Z) {
    // The operator's alternative is G32 (#631): level the top from the console and keep the nominal
    // hop. The raise above already made the program safe, so this informs rather than blocks.
    const liftMm = Math.round(liftOverStock * 1000) / 1000;
    findings.push({
      severity: 'warning',
      code: 'surface-hop-raised',
      message:
        `the fitted tilt lifts the blank ${liftMm} mm at its highest corner — more than the ${HOP_Z} mm hop, ` +
        `so every rapid in this program runs at ${Math.round((HOP_Z + liftOverStock) * 1000) / 1000} mm. ` +
        `Run G32 from the console to level the top and the hop stays ${HOP_Z} mm.`,
    });
  }

  // #710 — THE TRAVEL HEIGHT CLEARS THE MOUNT. A bracket job's clamps stand above the stock's
  // top; a rapid at the CAM's 1 mm hop would drive through them. The design makes the TRAVEL HEIGHT
  // the tallest clamp (or arm) top plus the fixture clearance — 13 mm above the plate for the
  // defaults — so every hop and retract runs above the clamps, and the verifier (which checks
  // rapids as it checks cuts) refuses any rapid that still passes below one. A vise or tape job has
  // nothing above the stock and keeps the CAM's own floors.
  // #727 F2 — AND THE LIFT. A fitted top raises the clamps by up to `liftOverStock`, and rapids are
  // not lifted (`applySurfaceLift` shifts FEEDS only), so the travel clears `top + fit + lift +
  // clearance`; the verifier's own top gets the same lift through `mountCtx`.
  ir = raiseTravelOver(
    ir,
    travelHeightOver(shop.mount?.obstacles ?? [], job.jawClearance + liftOverStock, shop.mount?.uncertainty ?? 0),
    mill.rapidEstimate,
  );

  // #432 — FACING IS ITS OWN PROGRAM, and this one is untouched by it.
  //
  // The skim is posted against the blank's PROBED top and posted as its own file (below, beside the
  // frame file), with its own cutter: a 0.5 mm skim wants the widest flat the shop can justify,
  // while the engraving's cutter is chosen for the detail its items need. The engraving program
  // stays in the DOCUMENT's frame, whose Z = 0 is the faced surface, and its verifier's rapid floor
  // is therefore its own `hopZ` — nothing here is shifted, because nothing here is post-shift. What
  // makes the two files meet physically is the re-touch (slice 4): the machine re-zeros Z on the
  // faced surface between the facing program and this one, so a label the document calls 2 mm deep
  // physically sits 2 mm below the faced top in BOTH frames. A shift here would double-lower the
  // cut by the full facing depth once that re-touch lands.
  const minRapidZ = ir.hopZ;
  const cam = summarize(ir);
  if (shop.finish != null && (cam.roughOperations ?? 0) + (cam.finishOperations ?? 0) > 0) {
    // V regions and drills emit no `passKind`, so the ids are exactly the items this program split.
    finishFacts = {
      stockToLeaveMm: shop.finish.stockToLeaveMm,
      mode: finishMode,
      itemIds: [...new Set(ir.operations.filter((op) => op.passKind !== undefined).map((op) => op.labelId))],
    };
  }
  // #667 — THE ROUGH-ONLY HALF OF A REST PAIR LEAVES THE ALLOWANCE, BUT ONLY WHERE IT SPLITS.
  // `cam/engraveJob.ts`'s split applies to flat-CUTTER flat regions with a positive roughing
  // depth: their rings are eroded by the tool radius PLUS the allowance and their deepest pass
  // stops `leave` above the floor. Drilled regions, traces and cut-outs are NOT split — they run
  // at their full geometry in this program (a drill's disc, a trace's kerf and a cut-out's kerf
  // would be erased entirely by that erosion, and the oracle would call the real cut an over-cut),
  // and an item whose `depth − leave` is not positive has no roughing pass at all (the CAM keeps
  // its one full-depth pass). So the prediction is restated for exactly the items the CAM split,
  // and every other entry stands as it is.
  if (finishFacts !== null && finishFacts.mode === 'rough-only') {
    const leave = finishFacts.stockToLeaveMm.value;
    const split = new Set(
      ir.operations.filter((op) => op.passKind === 'rough').map((op) => op.labelId),
    );
    const offset = makeClipperOffset(tl);
    const radius = tool === null ? null : cuttingRadiusForSweep(tool);
    const r = radius !== null && radius.ok ? radius.radius : 0;
    predictedForRun = predicted.map((p) => {
      if (p.itemId === undefined || !split.has(p.itemId)) return p;
      if (p.polygons.length === 0 || p.depth <= 0) return p;
      const roughDepth = p.depth - leave;
      if (!(roughDepth > 0)) return p;
      // What the rough rings leave standing: the region eroded by the radius plus the allowance
      // and swept by the tool — erosion then dilation by the radius.
      return {
        ...p,
        depth: roughDepth,
        polygons: leave > 0 || r > 0 ? offset(offset(p.polygons, -(r + leave)), r) : p.polygons,
      };
    });
  }

  // 4. the depth limit and the setup. They are read by the facing file as well as by the verifier
  // below, and the facing file has to be built BEFORE the engraving is posted — see step 6 — so
  // both live up here. The depth limit is the one the JOB implies: the CNC-2 stock limit,
  // tightened where an under-surface void leaves a thinner membrane (#231 item 3). On a job that
  // states its print (#285) the whole limit comes from the layer stack instead, so the void
  // membrane is layer-aligned and the verifier's number is the one the printer will honour.
  // #712 — the wasteboard under a BED job takes the under-board's role for the depth limit: a
  // through cut may enter it by the breakthrough (the verifier's `sacrificialDepthLimit`), and no
  // board of the operator's own is needed on that surface. Thickness enough to take the
  // breakthrough, or it does not count (the through gate refuses it by name).
  const bedBoardMm =
    (job.workholding.kind === 'tape' || job.workholding.kind === 'bracket') &&
    shop.bed?.surface === 'wasteboard' &&
    shop.bed.wasteboardMm !== null &&
    shop.bed.wasteboardMm >= job.breakthrough + 1
      ? shop.bed.wasteboardMm
      : null;
  const stack = stackDepthLimit(tl, plan, job, margins.boundaryMargin, throughMask ?? undefined, bedBoardMm);
  const limit: DepthLimit = stack?.limit ?? jobDepthLimit(job, margins.boundaryMargin, throughMask ?? undefined, bedBoardMm);
  const limitReasonAt = stack
    ? (x: number, y: number): string => depthLimitReason(stack, job, x, y)
    : undefined;
  // #725 B7 — the wasteboard rides the setup as the under-board (a through cut may enter it).
  const setup = toSetup(job, mill, shop.mount?.fixture ?? undefined, shop.bed ?? null);

  // 5. the post-processor (#173). Its `ctx` comes first because the facing file is posted from it
  // too (step 6), and the two files share one job name, stock and frame.
  const ctx: PostContext = {
    jobName: job.name,
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    materialName: job.stock.material,
    // #240 — the rotary frame measures every Z from the AXIS (R6); the post refuses the wrong
    // datum rather than writing a file whose heights mean something else.
    zDatum: rotaryMap === null ? 'probed-top-face' : 'rotary-axis',
    origin: 'topFrontLeft',
    camVersion: CAM_VERSION,
    // #332: the key the JOB names, not anything off the `Tool` — a clone's rendered cutter carries
    // no identity of its own, and this is the line that lets the file say which cutter it was for.
    toolKey: job.toolKey,
  };

  // 6. the FACING file (#432 slice 2): the skim of the blank's top, as its own program, beside
  // the job. It shares nothing with the engraving program — its own cutter, its own feeds, its own
  // post and verify — and it can refind nothing either: a refusal is carried as `facingError` and
  // the run still succeeds, because an operator who cannot face in this app can face in their own
  // program and still cut what this run produced.
  //
  // BUILT BEFORE THE ENGRAVING IS POSTED (#432 review R3). The vacuum words belong to the RUN
  // (#419 decision 4): the facing file is its first program and switches the vacuum on, and the
  // engraving program that follows switches it off. So the engraving's own share depends on
  // whether this file exists at all — a withheld facing file (refused by the verifier) leaves the
  // engraving as the run's only program, and it has to carry BOTH words itself. The facing file's
  // own span is `'first'` for the same reason.
  const facing =
    withFacing && facingDepth > 0
      ? facingProgram(
          job,
          facingDepth,
          ctx,
          mill,
          setup,
          limit,
          shop.mount,
          shop.tools ?? [],
          shop.conditions ?? null,
          catalogue,
          shop.feeds ?? undefined,
          span === 'none' ? 'none' : 'first',
          liftOverStock,
        )
      : { nc: null, verify: null, toolKey: null, error: null, cam: null };

  // 7. the post-processor's text, with this file's share of the vacuum words: `span` when the
  // engraving is the run's only program (or the facing file was withheld), `spanAfterFacing(span)`
  // when the facing file has already taken the first word.
  // #608 — a fitted surface plane (registration measured the blank tilted, and the tilt fits) is
  // posted against: the FEED moves' Z follow the plane so the colour plane stays at the programmed
  // depth under the tilted top. The CAM's IR is untouched otherwise; the shift happens here, at the
  // one seam where the document frame meets the file's Z.
  const postIr = surfaceFrame !== null ? applySurfaceLift(ir, surfaceFrame.plane, surfaceFrame.z0) : ir;
  let nc: string;
  try {
    // #624 — hand the post the fitted frame so its air-cut check judges the lifted feeds against
    // the local top `lift(x, y)` rather than the flat work Z0.
    const posted = postZ1(postIr, { ...ctx, surface: surfaceFrame }, mill, {
      vacuum: facing.nc !== null ? spanAfterFacing(span) : span,
    });
    if (!posted.ok) return stop('post', { feeds, message: posted.errors.join('; '), facing });
    nc = posted.text;
  } catch (e) {
    return stop('post', { feeds, message: e instanceof Error ? e.message : String(e), facing });
  }

  // 8. the verifier (#174) on the TEXT. The stack holds wasm cross-sections, so it is released
  // when this function returns — it is read again by the verifier calls below and by the frame's.
  try {
    // #240 slice 2 — a rotary file is verified in its OWN frame: the frame's refusals (the axis,
    // the jaws' and tailstock's bands, a turn in the cut, the module's envelope) replace the flat
    // depth/structure rules, and the mount's obstacles do not apply (a chuck is not a bracket).
    const verify = verifyProgram(nc, {
      setup,
      machine: mill,
      tool,
      depthLimit: limit,
      minRapidZ,
      ...(limitReasonAt ? { limitReasonAt } : {}),
      ...(rotaryMap === null
        ? mountCtx(shop.mount, job.jawClearance, liftOverStock)
        : { rotary: { radius: rotaryMap.radius, stickout: rotaryMap.stickout, tailstock: rotaryMap.tailstock } }),
    });
    if (verify.findings.some((f) => f.severity === 'error')) {
      errors.push({ stage: 'verify', message: `${verify.findings.filter((f) => f.severity === 'error').length} verifier error(s)` });
      return { ok: false, stage: 'verify', findings, feeds, threads: threadPlans, threadMachining, drill: drillFacts, cam, nc, verify, frameNc: null, frameVerify: null, facingNc: null, facingVerify: null, facingToolKey: null, facingError: null, facingCam: null, predicted: predictedForRun, errors };
    }

    // 9. the frame file (#244): the job's XY extent traced in the air, beside the job. Produced by
    // THIS gated action from the same toolpath, and checked by the SAME verifier — a frame the
    // operator cannot run at the wrong Z, because the Z is in the file.
    //
    // #240 — a ROTARY job has no frame file in this slice: the frame is the flat stock's XY
    // rectangle traced in the air, and the wrapped frame has no such rectangle (X runs along the
    // axis, the surface wraps into A). Slice 3's rotary run sheet owns the rotary equivalent.
    //
    // #747 — A FRAME FAULT NEVER FAILS THE RUN. The program above has already passed the verifier;
    // a frame is an aid to the dry run, not a gate on a verified program. When the frame cannot be
    // produced at a height the machine can reach and the mount clears, or its own verifier refuses
    // it, the file is WITHHELD (`frameNc` null) with the reason in `frameError` and the report (when
    // there is one) kept in `frameVerify`, so the receipt, the sheet and the panel can say what
    // happened. The frame's Z is computed by `frameTraceZ`, the one owner of that rule.
    let frameNc: string | null = null;
    let frameVerify: VerifyReport | null = null;
    let frameZ: Mm | null = null;
    let frameError: string | null = null;
    if (rotaryMap === null) {
      const frame = frameProgram(ir, ctx, mill, setup, tool, limit, shop.mount, job.jawClearance, liftOverStock);
      if ('error' in frame) {
        // `withPeriod` rather than `+ '.'` (review, 2026-10-28): a cause that already ends in a
        // full stop used to print "..".
        frameError = `The frame file could not be produced: ${withPeriod(frame.error)}`;
      } else {
        frameVerify = frame.verify;
        const frameErrors = frame.verify.findings.filter((f) => f.severity === 'error');
        if (frameErrors.length > 0) {
          // The posted frame is withheld: no unchecked program is handed over (#432's rule, and
          // #174's). The report stays attached so every finding is carried, not just the count.
          frameError =
            `The frame file was withheld: its verifier found ${frameErrors.length} ` +
            `error${frameErrors.length === 1 ? '' : 's'}.`;
        } else {
          frameNc = frame.nc;
          frameZ = frame.z;
        }
      }
    }

    return {
      ok: true,
      stage: 'done',
      findings,
      feeds,
      threads: threadPlans,
      threadMachining,
      drill: drillFacts,
      finish: finishFacts,
      through: cutoutFacts,
      bore: boreFacts,
      chamfer: chamferFacts,
      cam,
      nc,
      // #240 — the frame the post actually wrote, carried to the run and the frozen package.
      frame: postIr.frame,
      verify,
      frameNc,
      frameVerify,
      // #747 — the height the frame was actually traced at (work Z), and, when the frame was
      // withheld despite a good program, why. Both travel to the sheet and the receipt.
      frameZ,
      frameError,
      facingNc: facing.nc,
      facingVerify: facing.verify,
      facingToolKey: facing.toolKey,
      facingError: facing.error,
      facingCam: facing.cam,
      predicted: predictedForRun,
      // #737 — the neck this program leaves, for the run sheet's saw step.
      neck: neckProgram,
      // #748 — the document's floors ride the program, so the sheet and the panel quote the floor
      // the item is written into even when the item's own setup never cut it.
      floors: floorById,
      // #677 — the V program's derived cores go UP to the run (which alone can see the setup's
      // later cutter); the core program's own facts go ON the program (the sheet's step).
      cores,
      core:
        derivedCores === undefined || derivedCores.length === 0
          ? null
          : {
              cores: derivedCores.map((c) => ({
                of: c.of,
                // The REGION's operation name, not the derived one: the sheet's sentence is about
                // the carve whose middle stood, not about this program's own operation.
                name: c.ofName,
                areaMm2: c.areaMm2,
                depthMm: c.depth,
              })),
            },
      errors,
    };
  } finally {
    stack?.dispose();
  }
}

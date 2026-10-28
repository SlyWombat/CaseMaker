import type { CamPassStep, RapidEstimate } from '@/engine/cnc/cam/ir';
import { aabbOfProfile } from '@/engine/compiler/profile';
import { itemLabel, jobSetups, jobTool, type JobFinding } from '@/engine/cnc/engrave/jobSetup';
import {
  idJawReach,
  jawGapFor,
  keepOutLimit,
  keepOutLimitParts,
  keepOutMembrane,
  labelGlyphMeasure,
  drillOperationName,
  labelJawReach,
  sweptCuts,
  toPartPlan,
  voidLimitForItem,
  type JawReach,
  type PartPlan,
} from '@/engine/cnc/engrave/partPlan';
import {
  effectiveMargins,
  MARGIN_DEFAULTS,
  marginSourceWords,
  recommendLabelDepth,
  recommendMargins,
  splitBound,
  splitDepthOf,
  zBudgetInputsFor,
  type MarginSettings,
} from '@/engine/cnc/engrave/depthBounds';
import { printedLayerGridOf } from '@/engine/cnc/layerStack';
import { statedCuttingSize } from '@/engine/cnc/tool';
import { cutterLegend, cutterProfileSvg } from '@/engine/cnc/cutterProfile';
// #221 — the V-carve facts are the CAM's own arithmetic and cone resolution, imported rather than
// re-derived: the sheet, the panel and the program must not print different plane radii or pitches.
import { vCone } from '@/engine/cnc/vProfile';
import { inlayGlueGap, inlayMarked, inlayMm, inlayNumbers } from './inlay';
import {
  DEFAULT_MAX_TEXTURE_STROKES,
  textureNumbers,
  textureOperationName,
  textureStrokes,
} from './texture';
import { FLUTE_RAMP_STEPS, fluteNumbers, fluteOperationName } from './flute';
import { prismNumbers } from './prism';
import { vCarveLevels, vCarvePlane, vCarveRowStepover } from '@/engine/cnc/vCarveGeometry';
import { colourBoundaryDepthFor } from '@/engine/cnc/layerStack';
import { axesWord, describeTouch, kindWord, PROBE_SPEC, readsWord, registrationFor, sideWords } from '@/engine/cnc/engrave/registration';
import {
  alongWord,
  inOutWord,
  planMaterialScan,
  surfaceWord,
  SCAN_FALLBACK,
  type MaterialScanSettings,
  type ScanTouch,
} from '@/engine/cnc/engrave/materialScan';
import type { FeedsResult } from '@/engine/cnc/feeds';
// #445 — `ThreadPlanFacts` exists for THIS reader: the half of the CAM's thread plan the sheet
// prints, with `moves`/the IR/the simulator's spec left out (see the type's own comment).
import type { ThreadPlanFacts, ThreadSettingsResult } from '@/engine/cnc/cam/threadMill';
import { FASTENERS } from '@/engine/compiler/fasteners';
import {
  finerThan,
  reachTable,
  untouchedBy,
  untouchedByAll,
  type Reachability,
  type ReachRow,
  type ReachTableRow,
} from '@/engine/cnc/engrave/reachability';
import { fmtDiameter } from '@/engine/cnc/engrave/recommendTool';
import type { RestPassFacts, RestProgram } from '@/engine/cnc/engrave/restPass';
import { attributedDiagnostics, type ProgramSweepSummary } from '@/engine/cnc/engrave/programSweep';
import {
  assessSurfaceSpread,
  domeAcceptSentence,
  surfaceDomeReseatNote,
  surfaceMarginWords,
  surfaceSpreadPlan,
  surfaceTiltWords,
  Z0_REFERENCE,
  type SurfaceLevelParameters,
  type SurfaceReading,
  type SurfaceReadingSource,
} from '@/engine/cnc/engrave/surfaceSpread';
import { restSeamSentence } from '@/engine/cnc/engrave/restSettings';
import { toolDisplayName } from '@/engine/cnc/toolDisplay';
import { entryFor } from '@/engine/cnc/toolRegistry';
import { finishSourceWords, type FinishSettingSource } from '@/engine/cnc/engrave/finishPass';
import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import { VISE_BODY_DEPTH, jobVise, viseEnvelope } from '@/engine/cnc/fixture';
import { hasSacrificial, stripHeight, viseJawShift } from '@/engine/cnc/sacrificial';
import { jobMachine } from '@/engine/cnc/calibration';
import { facingDefault, facingRefusal, finishOf } from '@/engine/cnc/stockStart';
import type { FacingCamSummary } from '@/engine/cnc/cam/facing';
import type { GoalSurfaceFacts } from '@/engine/cnc/cam/surface3d';
import type { InkMeasure } from '@/engine/cnc/engrave/inkBox';
import type { VerifyReport } from '@/engine/cnc/verify';
// #243 — the blind-spot sentence is the Simulate panel's OWN builder, imported rather than
// re-worded, so the sheet and the panel cannot disagree about what the sweep did not see.
import { coverageDisclaimer, type SimCoverageInput, type SimRunOutcome } from '@/components/panels/simCoverage';
import type { EngraveJob, EngraveMargins, JobStockFinish, ViseParams } from '@/types/engraveJob';
import type { Mm } from '@/types/units';

/**
 * The operator run sheet (#207): a printable, job-specific checklist for the person standing at
 * the machine, and the paper half of the workflow the app now runs.
 *
 * THE WORKFLOW IT BELONGS TO. A job is designed in the panel's **Design** mode: stock, mount,
 * the cuts, the setups and the cutters. Pressing **Cut** asks every preflight owner about the job
 * (#419); a green page freezes the cut package — the programs, their frame files, the plan and
 * the hashes — and any Design edit marks it stale. The Cut page also carries the **registration
 * step** (#495), which runs the setup's approved plan and writes the origin from a measurement
 * only after the operator presses the button. A finished multi-program job is played by the
 * **release step** (#469): it uploads every frozen program, plays them in cut order, keeps the
 * vacuum on across the bit change and stops for each cutter's calibration. A one-program job
 * keeps the single-file upload. The web build stops at the files and hands them to Makera Studio.
 * Everything the file ASSUMES about the physical setup still has to reach the operator on paper —
 * that is this module's job.
 *
 * This module is PURE DATA: `buildRunSheet` returns a plain `RunSheet` structure with no React,
 * no DOM and no wasm, so it is a function of the job plus what #206's `engraveGenerate` returned
 * plus the simulation's diagnostics. `RunSheetView.tsx` renders it; the SVG for the origin
 * diagram is generated here too (`runSheetDiagramSvg`) so the whole sheet is buildable and
 * testable without a browser.
 *
 * The sheet follows the job it describes: the four saved files (#244, #432), the facing order
 * probe → face → re-touch → engrave (with the re-touch a measurement, not a fixed depth), the
 * setups and their remount/registration approvals (#471, #495), the surface touches and depth
 * band (#475), a V-carve's cone and colour plane with the effective pitch beside the requested
 * one (#221), a thread's pilot and clearance (#445), and a purchased laminate's stated colour
 * cap (#492). A step that exists only on one kind of job is gated on that job, so an older job's
 * sheet reads exactly as it did before the step existed.
 *
 * A MULTI-PROGRAM RUN is described in cut order (#419): program 1 in the `cut` section, then one
 * section per later engraving program, each fed from that program's own facts — a drill's point
 * and `drill.*` provenance, the rest pass's measured pair, or a later setup's file and frame. The
 * per-job preamble (mount, load, origin, dry run) stays before them, because it happens once.
 *
 * Three assumptions can ruin the part or the cutter if they are wrong, so the sheet states each
 * one plainly: where X0 Y0 Z0 is (the stock's top-front-left corner, Z0 on the top face), which
 * way round the blank goes (length in X between the jaws, fixed jaw on the left), and that the
 * machine does NOT know the cutter's length (`T1 M6` to the already-active tool does nothing —
 * `StartingTool`, `setup.ts`; the manual step is `M491`, `/Fabrication.md` §2).
 *
 * STEPS MARKED `unverified` HAVE NOT BEEN RUN AT THE BENCH, and the view renders the tag — an
 * operator has to be able to tell a confirmed step from an assumed one (#207 "Do not hide the
 * ⚠ notes"). The mount, the cutter fit, the origin and the app's own run were walked at the
 * machine on 2026-10-12, -15, -16 and -17, so they carry no tag; what remains is the held stepped
 * material scan and the rest pass's routine, and they point at the bench issue that will confirm
 * them (#443).
 */

// ---------------------------------------------------------------------------------------------
// The input half the sheet does not compute itself
// ---------------------------------------------------------------------------------------------

/**
 * The CAM summary #206 returns on `EngraveGenerated.cam`. Structural, so the real object is
 * assignable. `estimatedSeconds` is the CYCLE estimate — cutting PLUS rapids, a feed run timed as
 * one move and a rapid as its own, through the trapezoid on the job machine's rapid model
 * (#242, #281).
 */
export interface RunSheetCamSummary {
  operations: number;
  cuttingMoves: number;
  estimatedSeconds: number;
  passes: number;
  /**
   * #487 — XY rapid and cutting travel, mm, and the rapid travel the pre-#487 loop order would
   * have spent on the same program. Optional so a caller that only has the old four numbers
   * still builds a sheet; `EngraveGenerated.cam` always carries them.
   */
  rapidMm?: number;
  cutMm?: number;
  baselineRapidMm?: number;
  ordering?: 'proximity' | null;
  /** #250 — how many of this program's operations rough and finish. Optional like the travel numbers. */
  roughOperations?: number;
  finishOperations?: number;
  /**
   * #735 — the program's depth passes by the step each took, deepest first. Present when every
   * operation declared its passes; absent on an older stored result, and the sheet then prints its
   * pre-#735 single-step-down wording from `passes` and the feeds row.
   */
  passSteps?: CamPassStep[];
}

/**
 * #434 — one drill operation's facts, structurally a `DrillBitPlan` (the fields this sheet reads).
 * `id`/`name` identify the item the holes belong to; `angle.from` is the CAM's own provenance
 * sentence for the point, so the sheet never re-resolves the shop's `drill.pointAngleDeg`.
 */
export interface RunSheetDrillPlan {
  id: string;
  name: string;
  diameter: number;
  angle: { deg: number; from: string };
  pointLength: number;
  tipDepth: number;
  peck: number;
  /** #675 — where the peck came from (`typed in this job`, or the shop's setting). Optional: a
   *  result stored before it was carried has none, and the sheet says so rather than guessing. */
  peckSource?: string;
  holes: readonly (readonly [number, number])[];
}

/**
 * ONE program of the run, as the sheet needs to describe it (#419 J3, #434, #472). A STRUCTURAL
 * SUBSET of `EngraveProgram` (`workers/sim/engraveGenerate.ts`), so the generated object is
 * assignable unchanged and a result stored by an older build — with no `programs` list at all —
 * still builds exactly the sheet it built before.
 *
 * The list is the run ORDER. A `facing` entry is the blank's skim, which the sheet already
 * describes in "Face the stock top"; the sections below number the ENGRAVING programs 1..n, so the
 * operator's "program 1" is the first file after the face, as the rest pass has always said.
 */
export interface RunSheetProgram {
  /** `'facing'` for the blank's skim; absent or `'engrave'` for a setup's program. */
  kind?: 'facing' | 'engrave';
  /** 1-based setup the program cuts. */
  setupIndex: number;
  /** The cutter this file runs. */
  toolKey: string;
  /** The file to load. */
  nc: string;
  /** This program's own frame file, or null when none was produced. */
  frameNc: string | null;
  /** What the CAM did, for the run step's estimate. */
  cam: RunSheetCamSummary | null;
  /**
   * #434 — the drill facts when THIS program is the drill bit's. Null on every other file. The
   * per-program section reads them from here, never from the top-level `drill` (which describes
   * program 1 only).
   */
  drill?: RunSheetDrillFacts | null;
  /**
   * #250 — the rough/finish split when THIS program wrote one. Null/absent on a one-pass program.
   * The per-program section reads it from here, never from the top-level facts.
   */
  finish?: RunSheetFinishFacts | null;
  /**
   * #218 — the cut-outs THIS program cuts through, when it has any. Structurally the worker's
   * `ThroughCutFacts`, so the generated object is assignable unchanged; absent on every program
   * that cuts no cut-out and on a result stored by an older build.
   */
  through?: RunSheetThroughFacts | null;
  /**
   * #668 — the bores THIS program helices to size, when it has any. Structurally the worker's
   * `BoreProgramFacts`, so the generated object is assignable unchanged; absent on every program
   * that cuts no bore and on a result stored by an older build.
   */
  bore?: RunSheetBoreFacts | null;
  /**
   * #669 — the chamfers THIS program cuts, when it cuts any. Structurally the worker's
   * `ChamferProgramFacts`; absent on every program with no bevel.
   */
  chamfer?: RunSheetChamferFacts | null;
  /**
   * #677 — the CORES this program clears, when it clears any. Structurally the worker's
   * `CoreProgramFacts`; absent on every program that pockets no core.
   */
  core?: RunSheetCoreFacts | null;
  /**
   * #737 — the neck for parting THIS program leaves, when it leaves one. Structurally the worker's
   * `RotaryNeckFacts`, so the generated object is assignable unchanged; absent on every program
   * that cuts no neck, and on a result stored by an older build.
   */
  neck?: RunSheetNeckFacts | null;
}

/**
 * #737 — the neck for parting, as the sheet states it: where its edges and saw line are, how thick
 * and long it is. Structurally `RotaryNeckFacts` from `rotary/neck.ts` — one definition of the
 * span, so the sheet cannot print a saw line the CAM did not cut.
 */
export interface RunSheetNeckFacts {
  end: 'chuck' | 'tailstock';
  diameterMm: number;
  lengthMm: number;
  fromMm: number;
  toMm: number;
  sawAtMm: number;
  depthMm: number;
  carriedMm: number;
  effectiveMm: number;
}

/**
 * #250 — what a program's rough/finish split was, structurally `FinishPassFacts` from
 * `engraveGenerate`. `itemIds` is the split items in operation order; a drill or a V region is
 * never in it. The allowance carries its source so the sheet prints provenance, not a bare number.
 */
export interface RunSheetFinishFacts {
  stockToLeaveMm: { value: number; source: FinishSettingSource };
  mode: 'rough-and-finish' | 'rough-only' | 'finish-only';
  itemIds: readonly string[];
}

/**
 * #218 — what a program's cut-outs cut: the breakthrough, the board it lands in, and one entry
 * per cut-out with the holding tabs the file was made with. The run sheet prints these numbers;
 * it never re-plans a tab.
 */
export interface RunSheetThroughFacts {
  /** How far below the blank's bottom face the kerf reaches, mm. */
  breakthroughMm: number;
  /** The board's thickness, or null when the job states none. */
  boardThicknessMm: number | null;
  cutouts: readonly {
    id: string;
    name: string;
    tabs: { count: number; widthMm: number; heightMm: number };
    /** Tab spans the CAM actually placed (one per contour). */
    spans: number;
    /** Spans it could not place; a non-zero count is a finding, never a silent omission. */
    unplaceable: number;
  }[];
}

/**
 * #668 — what a program's BORES cut, structurally `BoreProgramFacts` from `engraveGenerate`. The
 * pitch travels with both numbers it was resolved from (the feeds row's step-down and the shop's
 * ramp angle with its source), because the sheet's step says which of the two is binding — and
 * that is the operator's answer to "why is this helix this slow".
 */
export interface RunSheetBoreFacts {
  items: readonly RunSheetBoreItem[];
}

export interface RunSheetBoreItem {
  id: string;
  name: string;
  /** The hole's diameter, mm — what the bore asks for. */
  holeDiameterMm: number;
  /** The cutter's cutting diameter, mm. */
  cutterDiameterMm: number;
  /** The helix's centre-path radius: hole radius less cutter radius, mm. */
  centreRadiusMm: number;
  /** The helix's descent per revolution, mm. */
  pitchMm: number;
  /** The feeds row's step-down cap, mm. */
  stepDownMm: number;
  /** The shop's ramp angle used, degrees, and where it came from. */
  rampAngleDeg: number;
  rampSource: string;
}

/**
 * #669 — what a program's CHAMFERS cut, structurally `ChamferProgramFacts` from `engraveGenerate`.
 * The width, the DEPTH derived from it and the cutter's cone, and which kind of rim the bevel
 * breaks — the sheet says when each run: a pocket's rim after the pocket, a part's edge before the
 * cut-out releases it.
 */
export interface RunSheetChamferFacts {
  items: readonly RunSheetChamferItem[];
}

export interface RunSheetChamferItem {
  id: string;
  name: string;
  /** The bevel's width on the top face, mm. */
  widthMm: number;
  /** The tip plane's depth below the top face, mm. */
  depthMm: number;
  /** The side of the rim's outline the cutter runs: a part's edge (outside) or a pocket's rim (inside). */
  side: 'outside' | 'inside';
  /** The cutter's tip diameter, mm — how far the bevel's bottom can stand off the wall. */
  tipDiameterMm: number;
  /** `'stated'` on the cutter's record, or `'point, by kind'` for a chamfer that states none. */
  tipSource: 'stated' | 'point, by kind';
}

/**
 * #677 — what a program's CORE CLEARANCE cut, structurally `CoreProgramFacts` from
 * `engraveGenerate`: one entry per variable-depth region whose middle the V could not reach, with
 * the area the pocket clears at the cap. The step says the program runs after the V-carve and
 * names the depth the flat bottom sits at.
 */
export interface RunSheetCoreFacts {
  cores: readonly RunSheetCoreItem[];
}

export interface RunSheetCoreItem {
  /** The variable-depth region the core stands under. */
  of: string;
  /** That region's operation name. */
  name: string;
  /** The floor the pocket clears, mm². */
  areaMm2: number;
  /** The cap depth, mm below the top face. */
  depthMm: number;
}

/** #434 — the drill program's settings, their per-key sources, and one plan per drilled item. */
export interface RunSheetDrillFacts {
  /** The bit's own name. Optional so a generated object from before it was carried still sheets. */
  toolName?: string;
  settings: {
    peckDiameters: number;
    peckClearanceMm: number;
    pointAngleDeg: number;
    plungeFeed: number;
    spindleRpm: number;
  };
  sources: Record<'peckDiameters' | 'peckClearanceMm' | 'pointAngleDeg' | 'plungeFeed' | 'spindleRpm', string>;
  plans: readonly RunSheetDrillPlan[];
  simDrillPoint: { deg: number; source: string };
}

/**
 * The half of #206's `EngraveGenerated` this sheet reads. It is deliberately a STRUCTURAL SUBSET:
 * the real `EngraveGenerated` also carries `ok` and `stage`, which the sheet does not need, and
 * an `EngraveGenerated` is assignable to this interface unchanged. Everything the sheet reports
 * about the cut comes from here, so the numbers on the sheet are the numbers in the file.
 */
export interface RunSheetGenerated {
  /** The app's full finding list for the job (#206 stage 1: `validateJob` + `validateVise` + the geometry findings, deduped). */
  findings: readonly JobFinding[];
  /** `feedsFor`'s result, or null when that stage was not reached. */
  feeds: FeedsResult | null;
  cam: RunSheetCamSummary | null;
  /** The exact text to be saved; the file name's hash and the file's existence come from it. */
  nc: string | null;
  verify: VerifyReport | null;
  /**
   * The frame program that will be saved BESIDE the job (#244), or null when the run never reached
   * it. §6 says which file to load for the dry run, so the sheet has to know whether that file
   * exists (#273) — the app only writes a frame it actually produced.
   */
  frameNc: string | null;
  /**
   * #445 — the thread plans this sheet prints, reduced to what it says and never carrying `moves`.
   * Absent or null on a job with no thread; `EngraveGenerated` satisfies this as it stands.
   *
   * No `name`: the CAM's plan does not carry one, and the sheet zips it from `plan.threads` by
   * index — the order the CAM built the plans in (one per enabled `plan.threads` entry).
   */
  threads?: readonly ThreadPlanFacts[] | null;
  /**
   * #445 — how the thread program's numbers were resolved: values, per-field sources and the
   * catalogue's clamps. Null on a job that cuts no thread. The sheet prints the numbers the worker
   * resolved, never a second resolution of its own.
   */
  threadMachining?: ThreadSettingsResult | null;
  /**
   * #434 — what the DRILL program cut, structurally a `DrillProgramFacts` from
   * `engraveGenerate`. Present only when the TOP-LEVEL result is the drill bit's own program
   * (program 1); absent/null everywhere else, so a sheet whose first program engraves says
   * nothing about a drill here. A LATER drill program carries its own facts on `programs[n].drill`
   * and gets its own Cut section (#419). The sheet prints these numbers rather than re-planning
   * the holes: they are the numbers in the file.
   */
  drill?: RunSheetDrillFacts | null;
  /**
   * #250 — the rough/finish split of the program this object describes (program 1). Null/absent
   * when it cut in one pass; a later program carries its own facts on `programs[n].finish`.
   */
  finish?: RunSheetFinishFacts | null;
  /**
   * #218 — the cut-outs the FIRST program cuts through, when it cuts any (the top-level result
   * describes program 1, exactly as `drill` does). A later program's facts travel on
   * `programs[n].through` and are printed in that program's own section (#419). Absent or null on
   * a job with no cut-out, and on a result stored by an older build.
   */
  through?: RunSheetThroughFacts | null;
  /**
   * #668 — the bores the FIRST program helices to size, when it cuts any (the top-level result
   * describes program 1, exactly as `drill` does). A later program's facts travel on
   * `programs[n].bore`. Absent or null on a job with no bore, and on a result stored by an older
   * build.
   */
  bore?: RunSheetBoreFacts | null;
  /**
   * #669 — the chamfers the FIRST program cuts, when it cuts any. A later program's facts travel
   * on `programs[n].chamfer`. Absent or null on a job with no chamfer, and on a result stored by
   * an older build.
   */
  chamfer?: RunSheetChamferFacts | null;
  /**
   * #432 slice 3 — the FACING program: the skim of the blank's top, its own `.nc` beside the job
   * (`runSheetFaceFileName`), or null when none was produced. Optional because a generated object
   * stored by an older build has no such field, and a sheet for it must read exactly as it did
   * before facing existed. `EngraveGenerated` satisfies this as it stands.
   */
  facingNc?: string | null;
  /**
   * #737 — the neck the FIRST program leaves (the top-level result describes program 1, exactly as
   * `drill` does). A later program's facts travel on `programs[n].neck`. Optional because a result
   * stored by an older build has none.
   */
  neck?: RunSheetNeckFacts | null;
  /** #432 — why the facing file is absent, in the worker's own words; null with no reason. */
  facingError?: string | null;
  /**
   * #432 — what the facing file was cut with: its OWN cutter, the pass count and the feeds row's
   * numbers. Null when no file was produced. The sheet neither re-resolves nor re-counts: these are
   * the numbers in the file.
   */
  facingCam?: FacingCamSummary | null;
  /**
   * #535 — a PURE GOAL job's surfacing facts (`EngraveGenerated.surface3d`): the passes' numbers
   * and the heightfield's resolution. Present only on the goal path; absent on every item job and
   * on a result stored by an older build, so the sheet then reads exactly as it did before.
   */
  surface3d?: GoalSurfaceFacts | null;
  /**
   * #419 J3 — the run's programs in cut order (`EngraveGenerated.programs`). Present on every
   * generated result this build produces; OPTIONAL because a result stored by an older build (or a
   * caller that only has the single-program shape) has no list, and its sheet must read exactly as
   * it did before.
   *
   * When present, the sheet describes program 1 in the existing `cut` section and gives every
   * later ENGRAVING program its own section, in this order, fed from that program's own facts.
   * A `facing` entry is skipped: its section is "Face the stock top", which is already placed
   * before the cut.
   */
  programs?: readonly RunSheetProgram[];
}

/**
 * #490 — the code the panel's error boundary writes when a render threw. The sheet carries it
 * with the warnings even though its severity is `error`: by the time the sheet is read the crash
 * is a fact about the run the operator needs, not one of the findings that gate it.
 */
export const PANEL_RENDER_ERROR_CODE = 'panel-render-error';

/**
 * The simulation diagnostic the sheet carries, structurally a `SimDiagnostic`
 * (`src/workers/sim/session.ts`). Warnings reach the sheet, plus a panel crash (#490).
 */
export interface RunSheetSimDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
}

/** What the sheet needs from a simulation run. A `SimLoadResult` (either variant) satisfies it. */
export interface RunSheetSim {
  diagnostics: readonly RunSheetSimDiagnostic[];
  /**
   * #243 — what the load reached: a full sweep, a path-only refusal, or a refusal before the
   * path. Omitted means `'swept'`, which is what the panel's generate → simulate action leaves
   * when it gets this far; a caller that saw a refusal says so and the sheet prints the
   * blind-spot sentence the same way the Simulate panel does.
   */
  outcome?: SimRunOutcome;
  /**
   * #405 — which backend swept the material (`SimLoadOk.stats.engine`): `'exact'` or `'column'`.
   * Carried so the coverage disclaimer can say a sampled column sweep's numbers carry a grid
   * resolution (a rotary job, or a V-bit trace). Omitted when the caller did not load one.
   */
  engine?: 'exact' | 'column';
  /**
   * #408 — the band the oracle judged the prediction with (`OracleReport.band`), mm. Carried so the
   * sheet states the TOLERANCE the "matches prediction" claim was made to, beside the engine
   * disclaimer: a report that says a program matches the plan without saying how close is a claim
   * the reader cannot weigh, and the band is where most of its width comes from (a column sweep's
   * is dominated by its grid pitch). Omitted when no prediction was checked.
   */
  oracleBand?: number;
  /**
   * #744 — EVERY program's sweep, in cut order, as the shared walk summarised it
   * (`engine/cnc/engrave/programSweep.ts`). The sheet's §8 then reads the run rather than its first
   * file: each program's diagnostics are carried under its label, and the coverage sentence states
   * which programs were checked, on whose stock, which were re-swept from the blank and where a
   * stopped walk left off. OPTIONAL and append-only: a caller without the list (the bench scripts,
   * an older stored run) gets exactly the single-file sheet it got before.
   */
  programs?: readonly ProgramSweepSummary[];
}

// ---------------------------------------------------------------------------------------------
// The sheet itself
// ---------------------------------------------------------------------------------------------

/** One instruction the operator follows. */
export interface RunSheetStep {
  text: string;
  /** A number with units, shown bold. */
  value?: string;
  /**
   * A line to SEND, verbatim, in the console's own language — e.g. `G38.2 Z-8 F100`. Set in a
   * monospace run rather than left inside the sentence, because it is meant to be typed and not
   * read (#391 review item 1: a step that names a travel cap but never gives a sendable line is not
   * a step an operator can follow, and the command itself must not have to be reassembled from prose).
   */
  code?: string;
  /** Label of a blank the operator fills in. */
  record?: string;
  /**
   * The bench issue that will confirm this step on the machine, e.g. `'#443'`. PRESENT means the
   * step has not been run at the bench, so it is an assumption rather than a walked routine; the
   * view must show the tag.
   */
  unverified?: string;
  /** Render the step's text bold. The `vise-default` warning opens section 8 this way. */
  bold?: boolean;
}

export interface RunSheetSection {
  /** Stable id for tests and the view: 'need', 'mount', 'load', 'cutter', 'origin', 'dry-run', 'cut', 'warnings', 'record'. */
  id: string;
  title: string;
  steps: RunSheetStep[];
}

/** One item's bounding box on the origin diagram, in the STOCK frame, mm. */
export interface RunSheetDiagramItem {
  id: string;
  name: string;
  min: [Mm, Mm];
  max: [Mm, Mm];
  depth: Mm;
}

/** A jaw rectangle on the diagram, in the STOCK frame, mm (may extend past the stock). */
export interface RunSheetDiagramJaw {
  id: string;
  label: string;
  min: [Mm, Mm];
  max: [Mm, Mm];
}

/**
 * An under-surface void's footprint on the diagram, in the STOCK frame, mm (#231 item 3). Drawn
 * dashed, because it is not a cut — it is material MISSING under the top face. `solidThickness`
 * is the material left over it (`stock.thickness − zCeiling`), the number the operator must not
 * cut through.
 */
export interface RunSheetDiagramKeepOut {
  id: string;
  name: string;
  min: [Mm, Mm];
  max: [Mm, Mm];
  solidThickness: Mm;
}

/** Everything the top-view origin diagram needs — plain geometry, no markup. */
export interface RunSheetDiagram {
  /** The stock outline: X × Y, front-left at the origin. */
  stock: { length: Mm; width: Mm };
  /** The two jaws, at their faces (shifted for sacrificial material, #213). */
  jaws: RunSheetDiagramJaw[];
  /** The work origin, in the stock frame. Always `[0, 0]`. */
  origin: [Mm, Mm];
  /** Every enabled item that has a region, with its bounding box and depth. */
  items: RunSheetDiagramItem[];
  /** Enabled under-surface voids, as their footprints (#231 item 3). Empty for a solid blank. */
  keepOuts: RunSheetDiagramKeepOut[];
}

/**
 * One solid on the stack-up elevation (#213 §6), in the X–Z plane of the WORK frame. X runs left
 * to right between the jaws; Z is the job's Z, so the part's top face is Z = 0 and everything
 * below it is negative. `dimension` is the box's own size, already formatted for the operator.
 */
export interface RunSheetStackUpBox {
  id: string;
  label: string;
  minX: Mm;
  maxX: Mm;
  minZ: Mm;
  maxZ: Mm;
  /** The dimension printed on the box, e.g. `'12 mm'`; null for a jaw, whose size is not the point. */
  dimension: string | null;
  /** True for the board and the strips — drawn in the paler sacrificial tone. */
  sacrificial: boolean;
}

/**
 * The side view of the setup (#213 §6): jaws, strips, board and part, each at its own thickness,
 * so the operator can see what the jaws actually bear on and that Z0 is the PART's top face, not
 * the board's. Present only when the job has sacrificial material — a job without any is drawn by
 * the top-view origin diagram alone, and its sheet is unchanged.
 *
 * It is an X–Z ELEVATION, not a section: front and back strips lie behind the part in this view
 * and are named by `sacrificialSummary` in section 1 rather than drawn here.
 */
export interface RunSheetStackUp {
  boxes: RunSheetStackUpBox[];
  /** Z of the part's top face — the datum plane the operator probes. Always 0. */
  datumZ: Mm;
}

/**
 * The note beside the header's time estimate (#242, #281). The number is a CYCLE estimate —
 * cutting plus rapids, each timed through the trapezoid — so it is a planning figure, not a
 * measured cycle time. Built from the profile's own rapid model so the printed rates cannot drift
 * from the ones the estimate is timed with, and so a second mill prints its own. The model's
 * `source` rides along exactly as it does in the post's header line, so a sheet read on its own
 * still says where the numbers came from — a config read and a stopwatch sample, not a measurement
 * of the machine.
 */
export function rapidAssumptionNote(rapid: RapidEstimate): string {
  return (
    `cutting + rapids through the trapezoid, timed on a rapid model of ${rapid.xyMmPerMin} mm/min XY / ` +
    `${rapid.zMmPerMin} mm/min Z at ${rapid.accelMmPerS2} mm/s² (${rapid.source}) — a planning estimate, ` +
    `not a measured cycle time.`
  );
}

export interface RunSheetHeader {
  jobName: string;
  /**
   * The machine the job names (#347), by its profile name — `Makera Z1` today. On paper because it
   * is what the rest of the sheet is true ABOUT: the envelope the blank was checked against, the
   * spindle ceiling the feeds were clamped to, and the materials the job could be asked for are all
   * the machine's, and an operator holding a printout should not have to open the app to know which
   * one it was written for.
   */
  machine: string;
  /** #604 — the checked-out probe's name, or absent when none. */
  probe?: string;
  /** #604 — the mount's name (the vise the job holds with), or absent. */
  mount?: string;
  /** ISO date (`YYYY-MM-DD`) the sheet was generated. */
  generatedOn: string;
  /** The sanitised job name plus `.nc` — the file the operator loads. */
  fileName: string;
  /** First 8 hex of SHA-256 of the `.nc` text, so the sheet can be matched to the file. */
  fileHash: string;
  /** Formatted cycle estimate, from `generated.cam.estimatedSeconds`. */
  estimatedTime: string;
  /** Always `rapidAssumptionNote` for the job's machine — says the number is a planning estimate (#242, #281). */
  estimatedTimeNote: string;
}

export interface RunSheet {
  header: RunSheetHeader;
  sections: RunSheetSection[];
  /** Placed inside section 5 in the view. */
  diagram: RunSheetDiagram;
  /**
   * The side view of the setup, placed inside section 3 (#213 §6). ABSENT when the job has no
   * sacrificial material, so a job that does not use it produces a byte-identical sheet.
   */
  stackUp?: RunSheetStackUp;
  /**
   * The job cutter's monochrome side profile (#489), drawn under "What you need" — the section
   * that names the cutter. Standalone SVG from the same model the app draws, with the V-bit's
   * groove at the job's deepest cut. ABSENT when the job names no tool, so an old job's sheet is
   * byte-identical to before this field existed.
   */
  toolProfileSvg?: string;
  /**
   * The small print under that drawing: every code it draws, in order, each with its word. The
   * app needs no legend — every dimension line carries its words in a hover title — but paper
   * cannot hover, and the values are already printed on the lines. ABSENT with the drawing.
   */
  toolProfileLegend?: string;
}

// ---------------------------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------------------------

/** '2' for 2.0, '0.5' for 0.5, '12.346' for a value that needs rounding. Trailing zeros trimmed. */
function fmtNum(n: number): string {
  return String(Number(n.toFixed(3)));
}

// #347 — the app's word for a material comes from the ONE map (`materials.ts`), so this sheet and
// the flow's `<select>` cannot spell a material two ways.

/** '2 min 35 s'. Formats the seconds it is given; `estimatedTimeNote` says what they are. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min ${sec} s`;
  return `${sec} s`;
}

/**
 * The height the frame file traces at, mm above the top face (#244). This is #207 §6's 20 mm air
 * clearance, now baked into the generated frame file instead of an offset the operator sets and
 * must remember to clear: the trace cannot be run at the wrong Z. Fixed, not derived from the
 * job — tall enough to clear the cutter holder over the default stock.
 */
export const FRAME_Z: Mm = 20;

/**
 * The frame file's name (#244): the job's own file name with `-frame` before the extension, so
 * it sits beside the job and cannot be confused with it. Shares `runSheetFileName`'s sanitiser,
 * so the sheet and the saved file can never disagree about what the file is called.
 */
export function runSheetFrameFileName(jobName: string): string {
  return `${runSheetFileName(jobName).slice(0, -'.nc'.length)}-frame.nc`;
}

/**
 * The facing file's name (#432 slice 3): `-face` before the extension, beside the job and its
 * frame. One name, used by the save and by the sheet's own steps, so the operator cannot be sent
 * to a file the save never wrote.
 */
export function runSheetFaceFileName(jobName: string): string {
  return `${runSheetFileName(jobName).slice(0, -'.nc'.length)}-face.nc`;
}

/**
 * §9's per-item rows (#277): every cut item, in the order section 7 lists them, with the depth the
 * program was posted at. The printed sheet's "measured depth" blanks and the run record file's
 * `depths` array are both built from this one list, so a filled record can never answer a row the
 * sheet did not ask — the same single-funnel trick `toPartPlan` plays for the diagram and the
 * depth notes. It is the CALLER's plan, not a second `toPartPlan` call, so the two cannot diverge.
 */
export function recordDepths(plan: PartPlan): { id: string; name: string; depth: Mm }[] {
  return plan.engraves.map((item) => ({ id: item.id, name: item.name, depth: item.depth }));
}

/**
 * The `.nc` file name for a job: the job name with runs of anything but letters, digits, `-`, `_`
 * and `.` collapsed to `-`, trimmed, plus `.nc`. Empty after cleaning falls back to
 * `engrave-job.nc`.
 *
 * COUPLING: #206 owns the save, so this must match its sanitiser — both derive the name from
 * `job.name` and nothing else. If #206's rule differs, this is the one place to update; noted on
 * #207.
 */
export function runSheetFileName(jobName: string): string {
  const cleaned = jobName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '');
  return `${cleaned || 'engrave-job'}.nc`;
}

// ---------------------------------------------------------------------------------------------
// SHA-256 (`sha256Hex`) — MOVED to `engine/import/sha256.ts` (#731): the LAN rig needs the same
// function for file bytes, because `crypto.subtle` is absent over plain http. Re-exported here so
// the run record's existing import keeps its name.
// ---------------------------------------------------------------------------------------------

import { sha256HexText } from '@/engine/import/sha256';

/** The run record's name for it (#731 moved the implementation to `engine/import/sha256.ts`). */
export const sha256Hex = sha256HexText;

// ---------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------

/**
 * #285/#345/#351 — the void numbers on this sheet are `keepOutLimit`'s, not this file's.
 *
 * They used to be worked out here, because the sheet's no-wasm, main-thread contract forbids
 * building the layer stack and the grid arithmetic was reproduced by hand. #351 is what that cost:
 * the panel and the preview each had their own copy of the same composition and one of the three
 * drifted. `keepOutLimitParts` in `partPlan.ts` is now the single owner — the ceiling plane
 * (`voidCeilingFor`, layer-aligned where the blank states a print), the margin its rule keeps
 * (`voidMargin`, #345 decision A), and the `min` against the blank's own `thickness − minFloor` —
 * and the sheet, the panel and the preview all read it. The sheet still needs the two halves APART,
 * not just the answer, so it can say WHICH number bound: see the §1 step below.
 */

/**
 * Whether ANY plane in this job carries the `boundaryMargin` rule (#345) — a void's ceiling, or the
 * colour split under an item that states an intent.
 *
 * The sheet's margins block is gated on this, the way every other absent fact is: a one-colour job
 * over solid stock has no such plane, so the margin binds nothing and a block about it would be
 * noise. The split needs the print as well as the stock's `split`, because the depth the bound sits
 * at is the layer-aligned one — a blank with no stated print has no boundary to keep clear of, which
 * is `engraveRegions`' own rule for reporting `item-depth-bound`.
 */
function usesBoundaryMargin(job: EngraveJob, plan: PartPlan): boolean {
  if (plan.stock.keepOuts.length > 0) return true;
  const split = splitDepthOf(job);
  if (split === null) return false;
  // Read off the LABELS, not the plan: `plan.engraves` is the four fields a cut needs and does not
  // carry `depthIntent`, and only a label can state one. The two skips mirror
  // `itemDepthBoundFindings` exactly — a disabled or construction label is not judged, so it is not
  // a bound in play here either.
  return job.labels.some(
    (l) => l.enabled && l.construction !== true && splitBound(l.depthIntent, split) !== null,
  );
}

/**
 * The margins block for §1 (#345): the number every bound in this job uses, where it came from, and
 * the arithmetic the app recommends for THIS blank.
 *
 * Both numbers, because the operator holding a printout has no panel to check them against: the
 * house default is 0.2 mm, and a blank that states a 0.33 mm dome needs more than that. Printing
 * only the one in force would hide the disagreement the panel shows.
 */
function marginsStep(
  job: EngraveJob,
  plan: PartPlan,
  margins: EngraveMargins,
  settings: MarginSettings,
): RunSheetStep {
  // The recommendation is `max(setting, zTolerance)` — the house number, never the margin the job
  // happens to be running on, and the SAME inputs the panel resolves (`zBudgetInputsFor`), so the
  // printout and the panel cannot offer two different numbers for one blank (#345 review).
  const rec = recommendMargins(job, settings, zBudgetInputsFor(job));
  // #345 decision A — a blank that states NO print and has a void runs its void's ceiling on
  // `max(boundaryMargin, minFloor)`, so the boundary margin printed on this line is NOT the number
  // that void keeps. The only place the operator can read which rule applied is here; saying it only
  // when the structural floor is the larger one keeps the line about the margin that actually binds.
  const voidKeepsFloor =
    printedLayerGridOf(job.stock) === undefined &&
    plan.stock.keepOuts.length > 0 &&
    job.minFloor > margins.boundaryMargin;
  return {
    text:
      'Depth margins — how far every floor stays clear of a plane: a void’s ceiling, the colour ' +
      `split. Recommended for this blank: ${fmtNum(rec.boundaryMargin)} mm — ${rec.basis.join('; ')}.`,
    value:
      `${fmtNum(margins.boundaryMargin)} mm boundary margin · ${marginSourceWords(margins.source)}` +
      (voidKeepsFloor
        ? ` · no print grid stated: a void’s ceiling keeps the job’s minimum floor, ${fmtNum(job.minFloor)} mm`
        : ''),
  };
}

/**
 * The two-colour facts, in §1 (#492) — the sheet's print-facts step.
 *
 * A purchased laminate states a cap, not a print: no layers, no filament, no extruder. The step
 * says that plainly and names the cap's provenance, because the maintainer's 0.075 mm is ASSUMED
 * until the sheet is measured; printing "stated" without that word would present a guess as a datum.
 * A printed blank keeps its old sentence, now with the cap as the number the job holds.
 */
function colourStep(job: EngraveJob): RunSheetStep | null {
  const colour = job.stock.colour;
  if (colour === undefined) return null;
  const source = job.sources?.stock?.colour;
  if (colour.kind === 'laminate') {
    const assumed = source === 'assumed';
    return {
      text:
        `Two-colour laminate: cap ${fmtNum(colour.capMm)} mm ` +
        (assumed
          ? '(assumed — carried from the stock entry; this sheet has no measured cap).'
          : '(stated by the stock entry).') +
        ' The core is the second colour; there are no printed layers and no filament.',
      value: `${fmtNum(colour.capMm)} mm cap${assumed ? ' (assumed)' : ''}`,
    };
  }
  const split = job.stock.thickness - colour.capMm;
  const grid = printedLayerGridOf(job.stock);
  return {
    text:
      `Two-colour print: colour change ${fmtNum(split)} mm above the bottom face` +
      (grid === undefined
        ? ' — no layer height is stated, so the colour plane is the nominal one.'
        : `; ${fmtNum(grid.layerHeight)} mm layers${source === 'assumed' ? ' (assumed)' : ''}.`),
    value: `${fmtNum(colour.capMm)} mm cap`,
  };
}

/**
 * Where a label's depth came from, in words, for §7 (#362 review; #345's rule that the number says
 * where it came from).
 *
 * Only the app's OWN numbers get a sentence. A depth a person typed is theirs and needs no note; a
 * depth the recommendation wrote is the one an operator may reasonably read as a mistake — 0.51 mm
 * is shallow for a label — unless the printout says which constraint left only that much. The
 * sentence is the same `basis[0]` the label's own row shows in the panel, and it is produced by the
 * same call, so the paper and the screen cannot explain one number two ways.
 *
 * The clause is printed only when the recommendation STILL reproduces the depth the job carries.
 * `setStock` can be edited after a blank was taken without re-depthing anything, and quoting a
 * reason for a number this blank's arithmetic no longer produces would be the invented provenance
 * #345 is against — so a stale `computed` depth says only that the app chose it, and what the
 * blank now allows instead.
 */
function depthSourceWords(
  job: EngraveJob,
  item: { id: string; depth: Mm },
  boundaryMargin: Mm,
  measure: InkMeasure,
): string {
  const label = job.labels.find((l) => l.id === item.id);
  if (!label) return '';
  const claim = job.sources?.labels?.[label.id];
  // Anything but `computed` is the user's or the bench's number, and neither asked to be explained.
  if (claim?.depth !== 'computed') return '';
  const rec = recommendLabelDepth(job, label, {
    // #365 — this line's own extent decides which voids bound it, exactly as the store's walk and
    // the panel's row do it. The sheet used to quote the blank's shallowest void for every line.
    voidLimit: voidLimitForItem(job, label, boundaryMargin, measure),
    // #369 — the jaw bound behind the sentence is the one THIS line is charged, on the same measured
    // box the void bound above reads (#394 measures inside `labelJawReach`, off the same
    // `job.customFonts`), or the paper would explain the depth with a limit the app no longer holds
    // the line to.
    jawReach: labelJawReach(job, label),
    boundaryMargin,
    ...(claim.depthIntent === undefined ? {} : { intent: claim.depthIntent }),
  });
  if (rec !== null && Math.abs(rec.depth - item.depth) < 1e-9) return ` — ${rec.basis[0]}`;
  return (
    ' — the app recommended this depth for the blank it was taken on' +
    (rec === null ? '' : `; this blank's arithmetic allows ${fmtNum(rec.depth)} mm`)
  );
}

/**
 * The void a cut item's extent sits over, or null. Both the item and the void are reduced to
 * their stock-frame bounding boxes (`buildDiagram` has them), because the sheet is pure — no
 * wasm, so no exact region intersection — and a box overlap is the CONSERVATIVE test: it may
 * name a void whose footprint does not quite reach the item, but it never misses one that does.
 * When several voids overlap the item, the one with the shallowest limit wins.
 */
function keepOutOver(
  job: EngraveJob,
  box: { min: [Mm, Mm]; max: [Mm, Mm] } | undefined,
  keepOuts: readonly RunSheetDiagramKeepOut[],
  margin: Mm,
): RunSheetDiagramKeepOut | null {
  if (!box) return null;
  let worst: RunSheetDiagramKeepOut | null = null;
  let worstLimit = Infinity;
  for (const ko of keepOuts) {
    if (!boxesOverlap(box, ko)) continue;
    const limit = keepOutLimit(job, ko.solidThickness, margin);
    if (limit < worstLimit) {
      worstLimit = limit;
      worst = ko;
    }
  }
  return worst;
}

/** One sentence for the sacrificial setup (#213), or null when there is none. */
function sacrificialSummary(job: EngraveJob): string | null {
  const s = job.sacrificial;
  const parts: string[] = [];
  if (s.under) {
    const ov = s.under.overhang;
    const overhang =
      ov.left === 0 && ov.right === 0 && ov.front === 0 && ov.back === 0
        ? 'flush with the part'
        : `${fmtNum(ov.left)}/${fmtNum(ov.right)}/${fmtNum(ov.front)}/${fmtNum(ov.back)} mm overhang (left/right/front/back)`;
    parts.push(`a ${fmtNum(s.under.thickness)} mm board under the part, ${overhang}, fixed with ${s.under.attach}`);
  }
  const strips = (['left', 'right', 'front', 'back'] as const)
    .filter((pos) => s.sides[pos] !== null)
    .map((pos) => {
      const side = s.sides[pos]!;
      const height = side.height === 'flush' ? 'flush with the part' : `${fmtNum(side.height)} mm tall`;
      return `${pos} strip ${fmtNum(side.thickness)} mm, ${height}`;
    });
  if (strips.length > 0) parts.push(strips.join('; '));
  return parts.length === 0 ? null : parts.join(', and ');
}

/** Bounding-box overlap, touching counted — the sheet's conservative "sits over" test (#231). */
function boxesOverlap(a: { min: [Mm, Mm]; max: [Mm, Mm] }, b: { min: [Mm, Mm]; max: [Mm, Mm] }): boolean {
  return a.min[0] <= b.max[0] && a.max[0] >= b.min[0] && a.min[1] <= b.max[1] && a.max[1] >= b.min[1];
}

/**
 * The side view of the setup (#213 §6), or null when the job has no sacrificial material. Every
 * box is placed from the same model the rest of the pipeline uses: the strips come from their own
 * `thickness`/`height` (`stripHeight`), the board from `under.thickness`/`overhang`, the jaws from
 * `viseJawShift` + `viseEnvelope`'s own body depth. Nothing here is hand-placed.
 *
 * The left/right strips are the ones BETWEEN the jaw and the part, so this elevation shows them.
 * Front and back strips sit behind the part in this view (different Y, same X span); they are named
 * by `sacrificialSummary` in section 1 instead, not drawn.
 */
function buildStackUp(job: EngraveJob): RunSheetStackUp | null {
  if (!hasSacrificial(job.sacrificial)) return null;

  const { length, thickness } = job.stock;
  const { under, sides } = job.sacrificial;
  const vise = jobVise(job);
  const shift = viseJawShift(job.sacrificial);
  const jawTopZ = -vise.stockProud;
  const jawBottomZ = -(thickness + VISE_BODY_DEPTH);
  const mm = (n: number): string => `${fmtNum(n)} mm`;

  const boxes: RunSheetStackUpBox[] = [];

  // The board first, so the strips and the part draw over it.
  if (under) {
    boxes.push({
      id: 'sacrificial-under',
      label: 'board',
      minX: -under.overhang.left,
      maxX: length + under.overhang.right,
      minZ: -(thickness + under.thickness),
      maxZ: -thickness,
      dimension: mm(under.thickness),
      sacrificial: true,
    });
  }

  // The jaws, at their shifted faces — the same faces `viseEnvelope` collides against.
  boxes.push(
    {
      id: 'vise-fixed-jaw',
      label: 'fixed jaw (left)',
      minX: -shift.left - vise.fixedJawThickness,
      maxX: -shift.left,
      minZ: jawBottomZ,
      maxZ: jawTopZ,
      dimension: null,
      sacrificial: false,
    },
    {
      id: 'vise-moving-jaw',
      label: 'moving jaw (right)',
      minX: length + shift.right,
      maxX: length + shift.right + vise.movingJawThickness,
      minZ: jawBottomZ,
      maxZ: jawTopZ,
      dimension: null,
      sacrificial: false,
    },
  );

  for (const pos of ['left', 'right'] as const) {
    const strip = sides[pos];
    if (!strip) continue;
    const height = stripHeight(strip, thickness);
    boxes.push({
      id: `sacrificial-${pos}`,
      label: `${pos} strip`,
      // Left strips run from the part's left edge outward; right strips outward from its right.
      minX: pos === 'left' ? -strip.thickness : length,
      maxX: pos === 'left' ? 0 : length + strip.thickness,
      minZ: -thickness,
      maxZ: -thickness + height,
      dimension: mm(strip.thickness),
      sacrificial: true,
    });
  }

  // The part last: drawn on top, and its top face is the datum line.
  boxes.push({
    id: 'part',
    label: 'part',
    minX: 0,
    maxX: length,
    minZ: -thickness,
    maxZ: 0,
    dimension: mm(thickness),
    sacrificial: false,
  });

  return { boxes, datumZ: 0 };
}

/** The top-view origin diagram's plain geometry, derived from the job and its plan. */
function buildDiagram(job: EngraveJob, plan: PartPlan): RunSheetDiagram {
  const { length, width } = job.stock;
  const vise = jobVise(job);
  const shift = viseJawShift(job.sacrificial);
  const jawMinY = vise.jawStartY;
  const jawMaxY = vise.jawStartY + vise.jawLength;

  // `aabbOfProfile` keeps the un-shrunk box for a NEGATIVE offset (it will not guess how far a
  // concave region pulls in), so a `border` — an inward offset of the stock — would otherwise draw
  // as the whole blank. The stock outline is a known rectangle, so a border's true outer edge is
  // `inset` in from every side (#215).
  const borderInset = new Map<string, Mm>();
  for (const c of job.combined ?? []) if (c.kind === 'border') borderInset.set(c.id, c.inset);

  const items: RunSheetDiagramItem[] = [];
  for (const item of plan.engraves) {
    const inset = borderInset.get(item.id);
    const box =
      inset !== undefined
        ? { min: [inset, inset] as [Mm, Mm], max: [length - inset, width - inset] as [Mm, Mm] }
        : aabbOfProfile(item.profile);
    if (!box) continue; // empty region (e.g. whitespace-only text): no rectangle
    items.push({
      id: item.id,
      name: item.name,
      min: [box.min[0], box.min[1]],
      max: [box.max[0], box.max[1]],
      depth: item.depth,
    });
  }

  // #231 — an under-surface void's footprint, as the stock-frame box the operator sees it in.
  const keepOuts: RunSheetDiagramKeepOut[] = [];
  for (const ko of plan.stock.keepOuts) {
    const box = aabbOfProfile(ko.footprint);
    if (!box) continue;
    keepOuts.push({
      id: ko.id,
      name: ko.name || ko.id,
      min: [box.min[0], box.min[1]],
      max: [box.max[0], box.max[1]],
      solidThickness: keepOutMembrane(job, ko.zCeiling),
    });
  }

  return {
    stock: { length, width },
    jaws: [
      {
        id: 'vise-fixed-jaw',
        // The fixed jaw is on the LEFT (/Fabrication.md §7.3); its face is x = 0, shifted out
        // for sacrificial material (#213 §2).
        label: 'Fixed jaw (left)',
        min: [-shift.left - vise.fixedJawThickness, jawMinY],
        max: [0 - shift.left, jawMaxY],
      },
      {
        id: 'vise-moving-jaw',
        label: 'Moving jaw (right)',
        min: [length + shift.right, jawMinY],
        max: [length + shift.right + vise.movingJawThickness, jawMaxY],
      },
    ],
    origin: [0, 0],
    items,
    keepOuts,
  };
}

/**
 * Whether this job's vise is the shipped default — the warning `validateVise` raises for it
 * (`vise-default`, `fixture.ts`; #353 keeps it to that one validator), which §8 must open with.
 */
function isViseDefault(vise: ViseParams): boolean {
  return vise.source === 'default';
}

/**
 * #243 — the coverage input, assembled from what THIS job and THIS run carry, never from prose.
 * The panel builds the same structure from its own state (`SimPanel.tsx`); here every field comes
 * from the job the file was generated for and the diagnostics the run produced, so a sheet that
 * was printed for a run cannot claim coverage that run did not have.
 *
 * The fixture is the vise envelope `toSetup` hands the sweep (`viseEnvelope`), so the obstacles
 * the sheet names ARE the ones the sweep was given, and the tool name comes from the job's
 * cutter. The collet nut is NOT a field here (#314): the sheet reports the nut as a blind spot
 * only when the run's own codes say the check was needed and could not be made, which on a vise
 * job — every obstacle below the stock top — is never.
 */
function coverageFor(job: EngraveJob, generated: RunSheetGenerated, sim: RunSheetSim | null): SimCoverageInput {
  const codes = new Set<string>();
  for (const f of generated.findings) codes.add(f.code);
  for (const f of generated.verify?.findings ?? []) codes.add(f.code);
  for (const d of sim?.diagnostics ?? []) codes.add(d.code);
  // #744 — a later program's blind spots are the RUN's: a code raised only by program 3 names a
  // limit of this check just as much as program 1's does. The list is grouped per program below so
  // the shank caveat can name the program whose cutter states no lengths.
  for (const program of sim?.programs ?? []) {
    for (const d of program.diagnostics) codes.add(d.code);
    for (const d of program.notes) codes.add(d.code);
  }
  const envelope = viseEnvelope(job.stock, jobVise(job), job.sacrificial);
  return {
    outcome: sim?.outcome ?? 'swept',
    engine: sim?.engine,
    oracleBand: sim?.oracleBand,
    fixtureLabels: envelope.boxes.map((b) => b.label),
    fixtureSource: envelope.source,
    sacrificialModelled: hasSacrificial(job.sacrificial),
    toolName: jobTool(job)?.name ?? null,
    codes: [...codes],
    // #744 — the run's programs as the coverage builder reads them, and how many files the RUN has:
    // a walk that stopped part-way carries fewer results than the job has programs.
    ...(sim?.programs === undefined
      ? {}
      : {
          programs: sim.programs.map((p) => ({
            label: p.label,
            outcome: p.outcome,
            engine: p.engine,
            fromBlank: p.fromBlank,
            errorCount: p.errorCount,
            codes: [...p.diagnostics, ...p.notes].map((d) => d.code),
          })),
          expectedPrograms: generated.programs?.length ?? sim.programs.length,
        }),
  };
}

/** A leading letter, uppercased — the planner's notes are clauses, the sheet prints sentences. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * §5 — how the work origin is set, DERIVED from how the part is held (#272, decision 26).
 *
 * The sequence this replaced was decision 23's hand-written edge find, which decision 26
 * superseded: it named the left face and the front edge, said "check by eye", and could not say
 * what the jaws already reference, which axes are still open, or what is left uncertain
 * afterwards. `planProbing` answers all of it from the blank and the workholding, so the sheet
 * prints the plan rather than a rule that is correct for one fixture only.
 *
 * A REFUSAL IS A STEP. When no reachable straight edge can resolve an open axis the plan refuses
 * and names the clamp or jaw that is in the way — the one thing the old sequence could never say,
 * because it would have sent the probe to a face the fixture covers.
 *
 * #213 §6 — with sacrificial material the X and Y faces are still the PART's (the work frame does
 * not move; §"Frame — unchanged"), and Z0 is the PART's top face, never the board's. A board under
 * the part reaches a cut depth only if Z is probed on the wrong face, so the step says which face
 * it means whenever there is a board to confuse it with.
 */
/** How a stock's finish is put on paper (#413's four values). */
const FINISH_WORDS: Record<JobStockFinish, string> = {
  rough: 'rough',
  finished: 'finished',
  printed: 'printed',
  unknown: 'of unknown finish',
};

/**
 * §7's facing phase (#432 slice 3): the skim of the blank's top, before anything is engraved.
 *
 * Present ONLY for a job that carries `facing` at all. A document written before #432 plans exactly
 * as it did, so its sheet must not gain a section — not even one saying facing is off.
 *
 * The phase exists because the skim changes what every later step is measured from: the origin is
 * set on the blank as clamped (the pre-facing top), the skim removes `facing.depth`, and the
 * engraving file is posted from the surface that leaves. So the section closes with the re-touch,
 * and the Cut section after it is the first to assume the new Z0.
 *
 * The numbers come from the WORKER (`facingCam`), never re-derived here — the pass count is
 * `zPasses`' answer for the depth in the file. A null file is said plainly rather than left as a
 * missing step: the engraving can still run, and the operator has to know the top was not skimmed.
 */
function facingSteps(
  job: EngraveJob,
  generated: RunSheetGenerated,
  faceFile: string,
): RunSheetStep[] {
  const facing = job.facing!;
  // #432 slice 4 — the SAME reader the panel uses: a printed blank's implied finish counts, so a
  // job taken from a badge says "printed stock" here and not "finish is not recorded".
  const finish = finishOf(job);
  const def = facingDefault(finish ?? 'unknown', job.stock.material);
  const stockWords = finish === null ? 'stock whose finish is not recorded' : `${FINISH_WORDS[finish]} stock`;
  const steps: RunSheetStep[] = [];

  // #474/#493 — no plastic is faced (wood and metal only). A job that still carries a pass (written
  // before the rule, or edited elsewhere) is called out rather than presented as a step to run.
  const refusal = facingRefusal(job.stock.material);
  if (refusal !== null) {
    const on = facing.enabled && facing.depth > 0;
    steps.push({
      text: on
        ? `The facing program was not produced: ${refusal}. This job still has a ` +
          `${fmtNum(facing.depth)} mm facing pass; turn facing off in the Cut panel and generate ` +
          'again before running it.'
        : `No facing pass — ${refusal}.`,
      bold: on,
      value: on ? 'facing on, not offered' : 'facing off',
    });
    return steps;
  }

  if (!facing.enabled || !(facing.depth > 0)) {
    steps.push({
      text:
        `No facing pass — this job turns it off. By default the ${stockWords} is ` +
        `${def.on ? 'faced first' : 'cut as it is'}: ${def.reason}.`,
      value: 'facing off',
    });
    return steps;
  }

  steps.push({
    text:
      `Face the top first. The ${stockWords} means ${def.reason}. The skim removes ` +
      `${fmtNum(facing.depth)} mm over the whole top, and every later program is posted from the ` +
      'surface it leaves.',
    value: `${fmtNum(facing.depth)} mm off the whole top`,
  });

  const cam = generated.facingCam ?? null;
  if (generated.facingNc == null) {
    steps.push({
      text:
        'The facing program was not produced' +
        (generated.facingError == null ? '' : `: ${generated.facingError}`) +
        '. The program can still be run, but the top will not be skimmed — clear the ' +
        'reason and generate again.',
      bold: true,
    });
    return steps;
  }

  if (cam !== null) {
    steps.push({
      // #432 review R1 — the facing cutter is already in: it was fitted (and its Z0 written) in the
      // section above, so this step names the file and says WHICH cutter runs it, not "fit this".
      text:
        `The skim runs with the facing cutter fitted above — ${cam.toolName}, ⌀ ` +
        `${fmtNum(cam.diameterMm)} mm flat — not the engraving bit. The release step uploads ` +
        `${faceFile} with the run and plays it FIRST, before the program.`,
      value: `⌀ ${fmtNum(cam.diameterMm)} mm`,
    });
    steps.push({
      text: `Spindle, feed and step-over for the skim. Vacuum ${cam.air ? 'on' : 'off'}.`,
      value:
        `${cam.rpm} RPM · ${fmtNum(cam.feed)} mm/min feed · ${fmtNum(cam.plungeFeed)} mm/min plunge · ` +
        `${cam.passes} × ${fmtNum(cam.stepDown)} mm passes · ${fmtNum(cam.stepOver)} mm step-over`,
    });
  }
  steps.push({
    text:
      `Run ${faceFile} after the dry run above, air or on the blank as this job was approved. It ` +
      'is a skim, so the first pass is the real cut — hold the stop ready and watch the first two lines.',
  });
  // #432 review R1 — THE RE-TOUCH IS WITH THE PROBE, AND THE ENGRAVING CUTTER COMES BACK IN AFTER
  // IT. That is the order `retouchSurface` then `applyCorrection` run in, and it is the only one
  // that yields a Z0 for the engraving program at all: the G10 L2 that writes that Z0 zeroes the
  // tool-length offset to the CURRENT tool (#387), so the engraving cutter has to be fitted and
  // calibrated before the line is written. The old step stopped at the re-touch and never said so.
  steps.push({
    text:
      'Then measure the top the skim left. Home the machine, select G54 and run G92.1, and fit the ' +
      `wired probe again. Touch the faced top at the registration point: ${fmtNum(facing.depth)} mm ` +
      'below your FIRST reading is what the skim should have taken, and that is only what was ' +
      'EXPECTED — the number you write down is what the touch measures. If it sits far from that ' +
      'expectation the skim did not run as planned: stop and check it, rather than accepting a ' +
      'number the re-touch would refuse.',
    code: '$H',
    record: 'faced surface Z (mm)',
  });
  steps.push({
    text:
      'Home the machine, then take the probe out and fit the engraving cutter — the one this job ' +
      `was designed around, the cutter ${runSheetFileName(job.name)} was posted for. Run ` +
      'tool-length calibration from Studio (M491) and record its PRB: a reading of THIS cutter ' +
      'alone, not yet a Z.',
    code: 'M491',
    record: 'the engraving cutter’s PRB (mm)',
  });
  steps.push({
    text:
      'Set Z0 for the program from the re-touch and those two readings, NOT by touching ' +
      'the surface again: Z0 = the faced surface Z you just recorded + (the engraving cutter’s PRB ' +
      '− the probe’s PRB recorded when you set the origin). With the engraving cutter fitted, write ' +
      'it with G10 L2: that command zeroes the tool-length offset to the current tool. Home ' +
      `again once it is written, then load ${runSheetFileName(job.name)}.`,
    value: 'Z0 = faced surface + (engraving PRB − probe PRB)',
    record: 'Z0 for the program (mm)',
  });
  return steps;
}

function registrationSteps(
  job: EngraveJob,
  onBoard: boolean,
  tipDiameterMm?: Mm,
  /**
   * #432 review R1 — the job is skimmed before it is engraved, so the origin is probed with the
   * probe FITTED and the Z0 step records the probe's PRB rather than "the tool that made it": on
   * this job there is only one candidate, and naming it is what lets the facing cutter's and the
   * engraving cutter's Z0 be worked out from this one reading.
   */
  facingRun = false,
): RunSheetStep[] {
  const { length, width } = job.stock;
  // #449 — the tip is the shop's measured `registration.tipDiameterMm` when the caller passed the scan
  // settings; `PROBE_SPEC` (the same 2.0 mm, its labelled fallback) otherwise.
  const plan = registrationFor(job, tipDiameterMm === undefined ? undefined : { ...PROBE_SPEC, tipDiameter: tipDiameterMm });

  if ('refuse' in plan) {
    return [
      {
        text:
          `This job cannot be registered as set up: ${plan.message}. Move the fixture or the part, ` +
          'probe by hand, or change the workholding — do not run this file until X0, Y0 and Z0 are ' +
          'known.',
        bold: true,
      },
    ];
  }

  const steps: RunSheetStep[] = [];
  // What the fixture supplies before any touch. Stated first, because it is what makes the rest of
  // the sequence as short as it is.
  for (const d of plan.datums) {
    steps.push({
      text: `The ${kindWord(job.workholding.kind)} already references ${axesWord(d.fixes)} to within ±${fmtNum(d.uncertainty)} mm, before any touch.`,
    });
  }
  // One step per touch, in the plan's own order: rotation's pair first, then whatever the pair did
  // not settle. Named physically, never by coordinate alone.
  plan.touches.forEach((t, i) => {
    const words = describeTouch(t, length, width);
    steps.push({
      text: `Touch ${i + 1} of ${plan.touches.length}: ${words.edge}, ${words.where} — this gives ${readsWord(t)}.`,
    });
  });
  steps.push({
    // #410 review item 1 — the Z0 the whole job is cut against, and WHO set it. A second cutter's Z0
    // is not a second touch-off: it is the difference between this tool's PRB and the new cutter's,
    // so both numbers have to be readable later, on paper, by an operator with the machine in front
    // of them. The reference is named as "the tool that set Z0" rather than as the probe, because
    // nothing here knows which of the two was in the spindle: the cutter, freshly calibrated in the
    // step above, or the probe — and the formula's second term is whichever one it was.
    text:
      (onBoard
        ? facingRun
          ? "Z0: the PART's top face — probe it with the probe you just fitted. NOT the board's top face."
          : "Z0: the PART's top face — probe it, or touch off on it. NOT the board's top face."
        : facingRun
          ? "Z0: the blank's top face — probe it with the probe you just fitted."
          : "Z0: the blank's top face — probe it, or touch off on it.") +
      (facingRun
        ? ' Record the reading AND the probe’s PRB: this job is skimmed before it is cut, so ' +
          'this surface and the probe’s reading are what the facing cutter’s Z0 is worked out from ' +
          'and — after the re-touch on the faced top — the engraving cutter’s too.'
        : ' Record the reading AND the tool that made it: on a job cut by two cutters the second ' +
          'program’s Z0 is worked out from this surface and the PRB of whichever tool took this ' +
          'touch, so both go on this one blank — the first cutter’s own PRB is a separate reading, ' +
          'taken where it is fitted.'),
    record: facingRun
      ? 'surface Z (mm) and the probe’s PRB (mm)'
      : 'surface Z (mm) and the PRB of the tool that set Z0 (mm)',
  });
  steps.push({
    text:
      `X0 Y0 Z0 is the top-front-left corner of the ${onBoard ? 'part' : 'blank'}. That leaves the ` +
      `work origin within ±${fmtNum(plan.residual)} mm in X and Y` +
      (plan.rotationResidual > 0 ? ` and ±${fmtNum(plan.rotationResidual)}° in rotation` : '') +
      '. Move there and check by eye before going on. ' +
      // #391 review item 2 — the ±residual above is what the PLAN leaves open, not how well the
      // operator then sets it. Nothing in the app carries a term for that error (or for the blank
      // sitting differently from the model): every check judges the cut against the blank and the
      // jaws AT THIS ORIGIN, so a shifted origin moves the job in the real world without moving it
      // in the model. `edgeMargin` is the X/Y slack the content keeps from a stock edge — it is not
      // a locating tolerance, but it is all there is, so the sheet says so where the origin is set
      // rather than letting it be absorbed into the vise's own uncertainty band.
      `How well YOU set it is not modelled: the file places the blank at this corner and judges the ` +
      `jaws against it, so an origin that is out by a little — or a ${onBoard ? 'part' : 'blank'} ` +
      `sitting differently from what was measured — shifts the whole job relative to both without the ` +
      `app knowing. The only X/Y slack for that is this job's edge margin, ${fmtNum(job.edgeMargin)} mm, ` +
      'which is the gap the content keeps from a stock edge rather than a locating tolerance: a cut ' +
      'standing at that margin has used all of it.',
  });
  // The planner's own caveats — the static-`.nc` rotation limitation, why Z is always probed, and
  // where a footprint could not be resolved. Verbatim but for the leading letter: the planner
  // writes notes as clauses, and the sheet prints sentences.
  for (const note of plan.notes) steps.push({ text: sentence(note) });
  return steps;
}

/**
 * #475 — the surface SPREAD, as an operator reads it.
 *
 * The registration steps above set the origin and one Z0; on a printed blank that one touch is not
 * enough, because the colour line is a plane and the dome is extra material on top of it (#475's
 * observation of 2026-10-17). These steps plan the touches across the cut's extents, print the band
 * the floors must land in, and — when the caller has readings — say whether this blank passes.
 *
 * The READINGS are optional because the app has no reading-input path yet: with none, the sheet
 * prints the plan, the band, the Z0 rule and the stop rule, and an operator who takes the readings
 * can apply them by hand. `surfaceSpread.spec.ts` and `runSheet.spec.ts` pass readings so the
 * measured half cannot rot.
 */
function surfaceSpreadSteps(
  job: EngraveJob,
  margin: Mm,
  touchCount?: number,
  readings?: readonly SurfaceReading[],
  level?: SurfaceLevelParameters | null,
): RunSheetStep[] {
  const plan = surfaceSpreadPlan(job, { touchCount, margin, level: level ?? null });
  if (plan === null) return [];
  const n = plan.touches.length;
  const sourceWords = (s: SurfaceReadingSource): string =>
    s === 'probe' ? 'probe' : s === 'touch-off' ? 'touched off' : 'stated';
  const bandMm = fmtNum(plan.band.width);
  const refWords =
    Z0_REFERENCE === 'lowest' ? 'LOWEST' : Z0_REFERENCE === 'highest' ? 'HIGHEST' : 'MIDPOINT (the average)';

  const steps: RunSheetStep[] = [
    {
      text:
        `The blank's top is measured at ${n} points across the cut — its centre, then both extents on ` +
        'each axis — because a printed blank’s colour line is a plane and its dome is extra material ' +
        'above it: one touch at the centre cannot tell you the floor at the ends of a line. Take them ' +
        'in the order below and write each reading down.',
      record: 'surface Z at each point (mm), and how each was taken (probe / touch-off)',
    },
  ];
  plan.touches.forEach((t, i) => {
    steps.push({
      text:
        `Surface touch ${i + 1} of ${n}: ${t.at}, X ${fmtNum(t.x)} Y ${fmtNum(t.y)} — take the top there ` +
        'and record the reading.',
    });
  });
  steps.push({
    text:
      (plan.band.lower === null
        ? 'This blank states no colour split, so only the ceiling limits the floors: they must stay at ' +
          `most ${fmtNum(plan.band.upper.depth)} mm below the top (${plan.band.upper.name}, ` +
          `including its ${fmtNum(plan.band.upper.margin)} mm margin).`
        : `The floors must stay between ${fmtNum(plan.band.lower.depth)} mm below the top ` +
          `(${plan.band.lower.name}, including its ${fmtNum(plan.band.lower.margin)} mm margin) and ` +
          `${fmtNum(plan.band.upper.depth)} mm below it (${plan.band.upper.name}, including its ` +
          `${fmtNum(plan.band.upper.margin)} mm margin) — a band ${bandMm} mm wide.`) +
      ` A surface spread wider than that band cannot keep every floor past the colour line and clear ` +
      'of the pocket at the same time.',
    value: `band ${bandMm} mm`,
  });
  steps.push({
    text:
      `Set Z0 from the ${refWords} of these ${n} readings, not from the registration touch above and ` +
      'not from the centre alone. Every programmed floor depth is measured from Z0, so at a higher ' +
      'touch the local floor is deeper by exactly its height above Z0: with Z0 at the lowest reading, ' +
      'the programmed depth is the SHALLOWEST floor and the programmed depth plus the spread is the ' +
      'deepest.',
    value: `Z0 = the ${refWords.toLowerCase()} surface touch`,
    record: 'the touch Z0 was set from, and the readings it came from',
  });

  if (readings === undefined || readings.length !== n) {
    steps.push({
      text:
        `If the touches miss a fitted plane by more than ${bandMm} mm, do not cut. The app ` +
        'fits a plane to the readings and follows it when the leftover — the bow the tilt cannot ' +
        "explain — fits the band; it refuses that blank as: “this blank's top is not one plane: the " +
        'touches miss the fitted plane by <residual> mm, wider than the band”.',
      bold: true,
    });
    return steps;
  }

  const a = assessSurfaceSpread(job, readings, { touchCount, margin, level: level ?? null });
  const measured =
    `Measured: lowest ${fmtNum(a.min.z)} at ${a.min.at} (${sourceWords(a.min.source)}), highest ` +
    `${fmtNum(a.max.z)} at ${a.max.at} (${sourceWords(a.max.source)}); spread ${fmtNum(a.spread)} mm ` +
    `against the ${bandMm} mm band.`;
  const tiltWords = a.fit === null ? null : surfaceTiltWords(a.tilt);
  // #501/#631 — the shape verdict, in the same words the registration section uses. `tilt` is
  // followed (the re-posted program, with the console grid as the alternative); `dome` is levelled
  // by the machine's own G32 grid and the program uploads FLAT — never refused.
  const shapeWords =
    a.verdict === 'dome' ? 'dome' : a.verdict === 'tilt' ? `tilt (${fmtNum(a.slopeDeg)}°)` : 'flat';
  if (a.ok && a.landing !== null) {
    if (a.verdict === 'tilt' && tiltWords !== null) {
      steps.push({
        text:
          `Surface ${shapeWords} — tilted ${tiltWords}, followed: the program is posted against the ` +
          `fitted plane, so the colour plane stays at the programmed depth under the tilted top — ` +
          `${surfaceMarginWords(a)}.`,
        value: `tilt followed (residual ${fmtNum(a.fit!.residual)} mm)`,
      });
    } else {
      steps.push({
        text:
          `Surface ${shapeWords}: the fitted plane holds and its drop is inside the band` +
          `${tiltWords === null ? '' : ` (${tiltWords})`} — ${surfaceMarginWords(a)}.`,
        value: 'surface flat',
      });
    }
    // #501 — the machine-side alternative, for the operator who would rather level at the console.
    // CONSOLE ONLY: the sheet says so, and nothing here is written into a file.
    if (a.recommendation !== null) {
      steps.push({
        text:
          'If you would rather level the machine than rely on the re-posted program: run ' +
          `${a.recommendation.gcode} from the console before the job, then ${a.recommendation.dump} ` +
          `to dump the grid into the record, and ${a.recommendation.after} after it. ` +
          'G32 is never uploaded in a file — it is a console command only.',
        bold: true,
      });
    }
    steps.push({
      text:
        `${measured} Z0 is the lowest reading, so the floors may land from ${fmtNum(a.landing.lower)} to ` +
        `${fmtNum(a.landing.upper)} mm below Z0 and nowhere else: keep every programmed floor in that ` +
        'range.',
      record: 'floor depth (mm) against the landing range',
    });
  } else {
    steps.push({ text: measured });
    // #631 — a dome is no longer a dead end: the origin is still written (Z0 = the lowest touch),
    // the machine's own G32 grid levels the curved top, and the program uploads FLAT.
    const residualMm = a.fit === null ? 0 : fmtNum(a.fit.residual);
    steps.push({
      text:
        `Surface ${shapeWords}: a curved top, not a tilt — the machine's own leveling follows a curved ` +
        `top and the program uploads FLAT (no plane re-post) — ${surfaceMarginWords(a)}.`,
      value: `dome — G32 levels the machine (residual ${residualMm} mm)`,
      bold: true,
    });
    if (a.recommendation !== null) {
      steps.push({ text: a.recommendation.sentence, bold: true });
    }
    steps.push({
      text:
        'Tick it once G32 has been run from the console for this clamping — the machine levels the ' +
        'domed top in real time, the program stays FLAT, and G32 is never uploaded in a file.',
      record: 'G32 run from the console for this clamping (yes)',
    });
    // #631 (c) — the operator-accepted route: skip G32 and knowingly take the centre miss. The
    // sentence (and its number) is the same one the Cut step's checkbox prints, so paper and screen
    // cannot disagree about the consequence.
    const accept = domeAcceptSentence(a);
    if (accept !== null) {
      steps.push({
        text:
          `${accept}: skip G32 and accept the un-levelled floor — the operator knowingly takes the ` +
          'miss at the centre instead of levelling the machine.',
        bold: true,
        record: 'operator accepted the un-levelled floor (yes)',
      });
    }
    // #630 (amended) — LAST, information only: the physical cause, after both routes have been
    // stated. The sheet's own steps above already carry the machine route and the accepted one, so
    // only this note is appended.
    steps.push({ text: surfaceDomeReseatNote() });
  }
  return steps;
}

/**
 * §5's second half — the material-position check (#391, decision 26).
 *
 * The steps above set the origin; these OFFER to check it against the blank that is actually in the
 * jaws, which is a different question. `registrationSteps` answers it with X, Y and rotation
 * touches that the wired probe cannot make (it is Z-only, §11.7), so the sheet says which way the
 * blank has moved with the one gesture the probe does have: a downward touch across each edge, read
 * as "the blank's own top" or "not". `materialScan.ts` owns the geometry and the physics; this
 * function is only how an operator reads them, so every number here comes from the plan.
 *
 * IT IS AN OFFER, and the sheet says so, because the check costs a tool change: the probe goes in
 * for it and the cutter comes back after. When the blank is the one the origin was just set
 * against, the check confirms what the operator has already seen with their own hands.
 *
 * HELD, not printed (#391): `buildRunSheet` calls this only when `RunSheetOptions.materialScan` is
 * set, and nothing in the app sets it. The block was written, reviewed and held (review of 36f3837,
 * 2026-10-13); the review's seven items are now IN, one step each — the sendable `G38.2` line from a
 * stated start height with its travel cap and the miss's `$X`/lift (`clearanceZ`: the resolved
 * machine's `toolChange.clearanceZ`, the lift the sheet prints between touches), the tip stated as the
 * figure every other one derives from (an assumption when this was written; measured 2026-10-15, A8), the
 * correction reading PAST the edge as the module always meant, the
 * dome as a shape judged edge by edge, bisection either way and a step for a pass that never
 * bracketed the edge, and per-jaw numbers inside §11.8's bounds carrying their own uncertainty —
 * but the hold is not lifted until a person has read them again. See `RunSheetOptions.materialScan`.
 */
function materialPositionSteps(
  job: EngraveJob,
  onBoard: boolean,
  unverified: string,
  clearanceZ: number,
  scan: MaterialScanSettings = SCAN_FALLBACK,
): RunSheetStep[] {
  const part = onBoard ? 'part' : 'blank';
  // Nothing to check the blank against when the origin itself could not be resolved: §5 is then one
  // refusal step, and a scan printed under it would be a sequence the sheet has just declined to
  // stand behind. (`registrationFor` is pure point maths on the stock rectangle, so asking it twice
  // costs nothing and keeps this function's own contract — never a scan for an unresolvable origin.)
  if ('refuse' in registrationFor(job, { ...PROBE_SPEC, tipDiameter: scan.tipDiameterMm })) return [];
  // #449/#452 — the scan steps, lifts and caps by the SAME shop defaults the registration planner
  // reads (`RunSheetOptions.scan`); with none passed, their labelled fallbacks, which are the seeds.
  const plan = planMaterialScan(job, scan);
  if ('refuse' in plan) {
    return [
      {
        text:
          `The ${part}’s position cannot be checked with the probe on this setup: ${plan.message}. ` +
          'Set the origin as above and check the blank against it with a rule instead.',
        unverified,
      },
    ];
  }

  // The plan's own figures, quoted rather than re-derived: the sheet prints what the module decided,
  // and every number below appears exactly once as a source.
  const gapMm = fmtNum(plan.settings.startGapMm);
  const capMm = fmtNum(plan.missTravelMm);
  const travelMm = fmtNum(plan.settings.startGapMm + plan.missTravelMm);
  const stepMm = fmtNum(plan.settings.coarseStepMm);
  const feed = fmtNum(plan.settings.touchFeed);
  const biasMm = fmtNum(plan.resolutionMm);
  const belowMm = fmtNum(plan.bands.belowMm);
  /** The blank's own top band at an edge — the left/right and front/back figures differ (the dome). */
  const bandMm = (edge: 'left' | 'front'): string =>
    fmtNum(plan.edges.find((e) => e.edge === edge)!.bands.blankMm);
  const sidesMm = bandMm('left');
  const endsMm = bandMm('front');
  // #430 — a blank at or below the jaw tops splits the plan: the gripped edges are read off the
  // jaw's face (one confirming touch each), and only the free ends are scanned outward. The steps
  // have to say which is which; a sheet that printed four touches at every edge would send the
  // operator across the jaw's top on the two edges where that reading is the jaw, not stock.
  const jawRef = plan.edges.filter((e) => e.reference === 'jaw');
  const scanned = plan.edges.filter((e) => e.reference === 'scanned');
  const numberWord = (n: number): string =>
    ['no', 'one', 'two', 'three', 'four', 'five'][n] ?? String(n);
  const edgesPhrase =
    jawRef.length === 0
      ? `${plan.edges.length} edges, ${numberWord(plan.edges[0]!.touches.length)} touches each`
      : `${numberWord(jawRef.length)} jaw-referenced ${jawRef.length === 1 ? 'edge' : 'edges'} with one confirming touch each and ` +
        `${numberWord(scanned.length)} scanned ${scanned.length === 1 ? 'edge' : 'edges'} with ` +
        `${numberWord(scanned[0]!.touches.length)} touches each`;
  /** The jaw's top relative to the reference: above it when the blank sits at or below the jaw tops. */
  const jawAbove = plan.bands.jawMm <= plan.bands.blankMm;
  /**
   * The HIGH signature (#430 item 2): a reading that stops at the jaw's own top rather than having
   * nothing under it. With the jaw above the blank it arrives ABOVE the reference; with the blank
   * proud by less than the tip's radius plus the outward margin it arrives below — either way it is
   * the jaw, not stock, and the depths step says which.
   */
  const jawNear =
    !jawAbove && plan.bands.jawMm > 0 && plan.bands.jawMm < plan.tipRadiusMm + plan.settings.missMarginMm;

  const steps: RunSheetStep[] = [
    {
      text:
        'OPTIONAL, BEFORE THE FIRST CUT — check where the blank really is, with the wired probe. It ' +
        'is Z-only, so it cannot touch a side: it finds an edge by touching DOWN at points across ' +
        `it and watching where the reading changes. ${edgesPhrase}, a few minutes, one tool change. ` +
        'Skip this if this is the blank you have just set the origin against.',
      unverified,
    },
    {
      // #391 review item 2 — the assumptions come FIRST, before a single position is read off this
      // sheet: an operator deciding whether to trust a predicted depth is entitled to know which of
      // the figures behind it is measured and which is standing in. The plan words them, so the
      // sheet cannot soften one.
      text: 'Before you touch anything: what the numbers below assume, and what this fixture already gives you.',
      unverified,
    },
    ...plan.notes.map((text): RunSheetStep => ({ text, unverified })),
    {
      text:
        `Fit the probe and touch off ONCE on the ${part}’s top face, near the middle (M491 for the ` +
        'probe’s own length). Every reading below is a change from this one, so its Z is the zero ' +
        'depth to compare against.',
      unverified,
    },
    {
      // #391 review item 1 — a sendable line, and the height it is sent from. The cap the old step
      // named (`5 mm below the reference`) was a field the machine does not show: a `G38.2` takes a
      // TRAVEL distance, so without a stated start height there was nothing to send.
      text:
        `Every touch below is ONE line, sent with the tip held ${gapMm} mm above the top of the blank — ` +
        'lift to that height and jog X and Y THERE, never sideways at depth. The Z word is the distance ' +
        `the tip may TRAVEL, not a place to go: from the ${gapMm} mm gap it descends onto the ` +
        `blank and stops there, or runs the ${gapMm} mm plus the ${capMm} mm cap if there is nothing ` +
        'under it — as far as it may ever go, which is what keeps a touch that finds nothing off the bed:',
      code: `G38.2 Z-${travelMm} F${feed}`,
      unverified,
    },
    {
      text:
        'A touch that finds NOTHING is not a fault — it is one of the readings this check looks for. ' +
        'The console reports where the tip stopped with a 0 flag, then ALARM: Probe fail, and the ' +
        'machine locks: a lift is refused (error:Alarm lock) until the Alarm is cleared, which is what ' +
        'this sends:',
      code: '$X',
      unverified,
    },
    {
      text:
        'Then lift the tip clear of the clamp. Do this after EVERY touch, hit or miss, before any X or ' +
        'Y move — after a miss the tip is at the cap with a jaw beside it:',
      code: `G53 G0 Z${fmtNum(clearanceZ)}`,
      unverified,
    },
  ];

  // #391 review item 7 — when the fixture's own uncertainty reaches this point, the plan carries a
  // second reading: the nominal jaw stops short of it, and a jaw at the wide end of its band does
  // not. A step that printed only the first would turn a CORRECT reading into a fault the operator
  // has to explain. The second reading is always the jaw's TOP, because growing the box can only
  // add jaw — `ScanTouch.alsoMaybe` owns that direction.
  const reads = (t: ScanTouch): string =>
    t.alsoMaybe === undefined
      ? surfaceWord(t.expect)
      : `${surfaceWord(t.expect)} — or, if the jaw reaches this far after all, ${surfaceWord(t.alsoMaybe)}`;

  // One step per edge. The four touches of an edge differ only in how far they sit from it, so the
  // step is one sentence with the expected reading beside each position.
  for (const scan of plan.edges) {
    // #430 situation 1: a gripped edge with the blank at or below the jaw tops. There is no
    // outward scan here at all — the jaw's face is the edge's reference, and one touch on the
    // blank's own top inside it confirms the blank is seated against that face.
    if (scan.reference === 'jaw') {
      const confirm = scan.touches[0]!;
      steps.push({
        text:
          `Check ${sideWords(scan.edge)} — at ${alongWord(scan.edge)}, BY REFERENCE rather than by ` +
          'scanning: the blank is pushed against the fixed jaw and the moving jaw closes onto its ' +
          'width, so this edge is where the jaw’s face is. Touch down once, ' +
          `${fmtNum(Math.abs(confirm.offsetMm))} mm inside it (${reads(confirm)}): the blank’s own top ` +
          'there confirms it is seated against the jaw. Do NOT touch past this edge — the jaw’s top ' +
          'stands above the blank there, and an outward reading would be the jaw, not stock.',
        record: `${scan.axis === 'x' ? 'X' : 'Y'} of the jaw face, and whether the inside touch was the blank (mm)`,
        unverified,
      });
      continue;
    }
    const aimed = scan.touches.find((t) => t.role === 'edge')!;
    const inside = scan.touches.filter((t) => t.role === 'inside');
    const outward = scan.touches[scan.touches.length - 1]!;
    steps.push({
      text:
        `Check ${sideWords(scan.edge)} — at ${alongWord(scan.edge)}. Touch down at ` +
        `${inside.map((t) => fmtNum(Math.abs(t.offsetMm))).join(' and ')} mm inside (${reads(inside[0]!)}), ` +
        `at ${inOutWord(aimed.offsetMm)} (${reads(aimed)}), ` +
        `and at ${inOutWord(outward.offsetMm)} (${reads(outward)})` +
        (outward.expect === 'miss'
          ? ' — no jaw reaches under the tip past that edge, so a miss there is the expected reading, not a fault.'
          : '.'),
      record: `${scan.axis === 'x' ? 'X' : 'Y'} where the reading stops being the blank (mm)`,
      unverified,
    });
  }

  // What the readings mean. The bands are the JOB's own (its blank's dome, and the height it stands
  // proud) and they are PER EDGE, because the face is a shape: the whole point of #391's fourth
  // review item is that one figure quoted for the middle is not the top at the edges.
  steps.push({
    text:
      'Reading the depths. Each edge is judged against the blank’s own top WHERE THAT EDGE IS, not ' +
      `against one number, because the face is domed: within ${sidesMm} mm of the reference is the ` +
      `blank at the left and right edges, ${endsMm} mm at the front and back, and ${belowMm} mm or more ` +
      'below is off the blank at any of them. Between the two the tip is on the edge itself.' +
      (jawAbove
        ? ` A reading at the jaw’s own height — ${fmtNum(-plan.bands.jawMm)} mm ABOVE the reference — ` +
          'is the jaw, not the blank.'
        : jawNear
          ? ` A reading at ${fmtNum(plan.bands.jawMm)} mm below the reference is the jaw’s own top: ` +
            'off the blank, not stock.'
          : ''),
    unverified,
  });
  steps.push({
    text:
      // #391 review item 3 — PAST, which is what the module has always computed and what the physics
      // says: the corner contact has to sink the reading before the dial can see it, so the change
      // appears on the far side of the edge and the edge is measured back TOWARD the blank.
      `The reading leaves the blank about ${biasMm} mm PAST the real edge — the tip’s corner contact ` +
      `has to climb ${biasMm} mm before the dial moves — so the edge is ${biasMm} mm INSIDE where the ` +
      `reading changed: measure the change, then take ${biasMm} mm back toward the blank. It is the ` +
      'same figure and the same direction at all four edges.',
    unverified,
  });
  steps.push({
    text:
      // #391 review item 5 — BOTH directions. The old step halved the gap one way only.
      `To place an edge more finely, BISECT where the reading changed, in either direction: halve the ` +
      'gap between the last reading that was the blank and the first that was not — inward or outward, ' +
      'whichever side the change fell on — touch the middle of that gap, keep the two readings that ' +
      `straddle it, and go again until they are no more than ${biasMm} mm apart, which is as fine as ` +
      'this scan can honestly place an edge. Every touch that finds nothing needs the Alarm cleared and ' +
      'the lift first (above).',
    unverified,
  });
  steps.push({
    text:
      // #391 review item 6 — the pass that never brackets the edge, which the old steps had no answer
      // for: an operator whose four readings were all "the blank" had nothing to bisect between.
      `If the readings do not bracket the change at all, the edge is not where the first pass looked. ` +
      `ALL of them reading the blank means every touch was still on it: step ${stepMm} mm further OUT and ` +
      `try again. An OFF reading at the innermost touch means the pass started past the edge: step ` +
      `${stepMm} mm back IN. Keep stepping until two neighbouring readings straddle the change, then ` +
      'bisect as above — and past an edge with no jaw under the tip the change arrives as a miss, ' +
      'which counts as off the blank.' +
      (jawRef.length > 0
        ? ' This pass is for the scanned edges only: a jaw-referenced edge has nothing to bracket, ' +
          'because it is read off the jaw’s face.'
        : ''),
    unverified,
  });
  steps.push({
    text:
      jawRef.length === 0
        ? `Compare with the file: the edges should lie where it says they do — X = 0 and X = ${fmtNum(job.stock.length)} for the ` +
          `left and right, Y = 0 and Y = ${fmtNum(job.stock.width)} for the front and back — after the ${biasMm} mm ` +
          'above is taken back toward the blank. More than the job’s own margin out, and the blank has moved: re-clamp it, or set the ' +
          'origin from the measured position. Do not cut until the two agree.'
        : `Compare with the file: the scanned edges should lie where it says they do — ` +
          `${scanned.map((e) => `${e.axis.toUpperCase()} = ${fmtNum(e.nominalMm)}`).join(' and ')} ` +
          `after the ${biasMm} mm above is taken back toward the blank. The jaw-referenced edges ` +
          'have nothing to bracket: what to confirm is that the blank is seated against the jaw’s ' +
          'face (the inside touch found the blank’s own top) and that the jaw is where the fixture says. ' +
          'More than the job’s own margin out, and the blank has moved: re-clamp it, or set the ' +
          'origin from the measured position. Do not cut until the two agree.',
    value: `allowed ${fmtNum(job.edgeMargin)} mm`,
    record: 'edge that is out, and by how much (mm)',
    unverified,
  });
  steps.push({
    text:
      'Put the CUTTER back and measure its length again (M491): the probe and the cutter are ' +
      'different tools, and every Z in the program is the cutter’s.',
    unverified,
  });
  return steps;
}

/**
 * What a caller may switch ON, over and above the sheet the app has always printed. Every field is
 * absent by default, so a caller that passes nothing gets exactly the shipped sheet — and adding a
 * field here cannot change one that is already on paper.
 */
export interface RunSheetOptions {
  /**
   * #491 — the colour word(s) for the job's cutter, from `caseWordsForKey(job.toolKey)`: `Yellow
   * case`, or both cases in condition order for an indifferent pick. Passed in, never read from
   * `toolCondition`'s map here: the sheet is pure data and builds in realms (the sim worker, the
   * bench CLI) where that map is empty. Undefined means no case was recorded — the step keeps the
   * colourless wording it has always had, and nothing is guessed.
   */
  toolCase?: string;
  /**
   * Print §5's material-position check (`materialScan.ts`, #391). **OFF, deliberately and for now.**
   *
   * It is the operator-facing half of a feature whose printed steps a review held (review of 36f3837
   * on 2026-10-13). That review's seven items are now all IN — see `materialPositionSteps` for the
   * list and which step carries each — and the module and the block are both tested; what remains is
   * that no person has read the rebuilt steps at a machine, so no sheet — the app's, the bench
   * generator's, or a committed `docs/bench` one — prints them yet. The probe's tip used to be the
   * loudest assumption in them; A8 calipered it on 2026-10-15 (#208), so the step now names the
   * reading — but the CONTACT MODEL around that reading is still a ball's (`materialScan.ts`'s
   * round-foot note), and A8's tip is a hollow cylinder with no ball, so the corner band and the
   * resolution are arithmetic on a shape the probe does not have. That is #391's own open item, and
   * the second reason the hold stands. Two figures are still assumptions and the steps SAY so: the
   * blank's dome, which stands in from the badge blank where the job states none (#345) — and,
   * unstated by any document, the 0.05 mm dial. Lifting the hold is the maintainer's call, not this
   * flag's.
   *
   * Nothing in the app sets it. `runSheet.spec.ts` does, so the block cannot rot while it is held.
   */
  materialScan?: boolean;
  /**
   * #449/#452 — the material-position scan's tunables, from the shop defaults the registration planner
   * reads: `materialScanSettingsFrom(registrationSettings(defaults).settings)`. Passed in, never read
   * here — this module is in the sim worker's import graph. Absent: `SCAN_FALLBACK`, the seeds.
   */
  scan?: MaterialScanSettings;
  /**
   * #475 — the shop's `registration.surfaceTouchCount`: how many surface touches the cut regions'
   * extents get. Resolved by the caller from `registrationSettings(defaults).settings`, never read
   * here (this module is in the sim worker's import graph). Absent: the labelled fallback (5).
   */
  surfaceTouchCount?: number;
  /**
   * #451 — the shop's `runSheet.blankToleranceMm`: how far a measured blank may differ from the
   * job's stated size before the sheet tells the operator to change the job and regenerate. Resolved
   * by the caller from the shop defaults, never read here. Absent: the labelled fallback (0.5 mm).
   */
  blankToleranceMm?: number;
  /**
   * #475 — the measured surface readings, in the plan's order (the order {@link surfaceSpreadSteps}
   * prints). The registration step supplies them from the run it measured
   * (`engraveRegistrationStore`'s `surfaceSpreadFor`), so a sheet for an already-registered job
   * prints the measured spread and the landing range, or the dome's G32 route (#631). Absent: the
   * sheet prints the touch plan, the band, the Z0 rule and the stop rule, but cannot say whether
   * this blank passes — which is every sheet opened before the job has been registered on this
   * machine.
   */
  surfaceReadings?: readonly SurfaceReading[];
  /**
   * #501 — the inputs the console `G32` recommendation is sized from (the cutter's radius, the
   * probe clearance and the grid points). Passed by the caller that has the job and the approved
   * plan's own settings; absent, the sheet prints the verdict and slope but no console recipe.
   */
  surfaceLevel?: SurfaceLevelParameters | null;
  /**
   * The reachability table (#410), when the caller has measured one. **Absent for every job the app
   * and the bench script build** — nothing computes it on a hand-authored job, and no sheet that
   * exists today gains a line.
   *
   * It is `Reachability` itself rather than a pre-rendered block, because the sheet is not the only
   * place that prints it: the panel and the CLI's own report read the same object through the same
   * `reachTable` (#410's "the run sheet and the panel cannot disagree about what a row says"). What
   * this function adds is the sheet's framing — which numbers the operator has to record, and what
   * the numbers mean for the bit in the collet.
   *
   * It exists because of the ONE case a single number cannot carry: a design whose strokes are
   * finer than any cutter on the bench. `item-empty` refuses such a job outright, and the design
   * route turns the item off and reports the area — so the sheet has to say which region the file
   * asked for and no bit can cut, or the operator would find the absence only on the part.
   */
  reachability?: Reachability;
  /**
   * The regions the CALLER turned off because no cutter it measured reaches them (#410), from
   * `untouchedByAll`. It is the one fact the table cannot carry when the table is measured on the
   * job AS CUT: a disabled item is not in it at all, so the operator would be told a percentage of
   * a smaller design and never told what left it.
   *
   * Its presence is what turns the report's last lines on; a caller that measured a job it did not
   * edit can omit it, and the sheet then derives the same list from the table itself.
   */
  unreachable?: { row: ReachRow; cutters: number }[];
  /**
   * The two-tool rest pass (#410's scope comment), when the caller ran one. **Absent for every job
   * the app and the bench script build** — a job document names ONE cutter, so a sheet for a single
   * program has nothing to say about a second one, and every sheet that exists today gains no line.
   *
   * It carries the facts rather than the two jobs: what each program is, what tool 1 could not reach,
   * what tool 2 measured as its rest, and what the chained simulation says is left.
   *
   * When the caller ALSO supplies the run's program list (`RunSheetGenerated.programs`), the pair's
   * swap/Z0 routine and the second program's own feeds move into that program's Cut section
   * (`cut-2`, `cut-3`, …), labelled with its real position in the run. Without a list — an older
   * stored result, the CLI before this field, a spec that stubs the generated half — they stay in
   * program 1's Cut section with the old "Program 1/Program 2" words, byte-for-byte.
   */
  restPass?: RestPassFacts;
  /**
   * #596 — the machine's display name for the sheet's header: the nickname first, then the profile
   * name. Resolved by the caller (this module is in the sim worker's import graph), never read
   * here. Absent: the profile's own name, as before.
   */
  machineName?: string;
  /** #604 — the checked-out probe's name, or absent when none. */
  probeName?: string;
  /** #604 — the mount's name (the vise the job holds with), or absent. */
  mountName?: string;
  /**
   * #604 — the found position from the registration: how far the measured blank sits from the
   * plan's nominal origin. Absent: no registration has run on this machine, and no found-position
   * section prints — an unregistered job's sheet is unchanged.
   */
  found?: { offset: { x: number; y: number }; rotationDeg: number | null };
}

/** A share as the operator reads it. Rounded to the whole percent: a tenth is not a fact about a cutter. */
function pct(share: number): string {
  return `${Math.round(share * 100)} %`;
}

/**
 * #410's reachability report, as sheet steps.
 *
 * GROUPED BY OUTCOME, not cutter by cutter. The bench's twelve owned flat end mills fall into four
 * distinct readings on one badge — the 3.0 and 3.175 mm bits reach nothing, 2 mm reaches 62 % of the
 * design, 1 mm 83 %, 0.6 mm 87 % — and twelve rows that say four things bury the four. Every cutter
 * sharing a row is named in full, so a row is never a summary the operator cannot check against the
 * tool list in their hand.
 *
 * Item names come from `reach.items`, which `itemName` (#211's namer) filled — the SAME namer the
 * recommendation's own sentences use, so a region cannot be one thing here and another there. It
 * speaks a label and an imported outline with the quotes that belong around them, so this renderer
 * adds none of its own.
 */
function reachabilitySteps(
  reach: Reachability,
  chosenKey: string | null,
  unreachable: { row: ReachRow; cutters: number }[],
): RunSheetStep[] {
  const rows = reachTable(reach);
  const measured = rows.filter((r) => r.excluded === null);
  const unmeasured = rows.filter((r) => r.excluded !== null);
  const steps: RunSheetStep[] = [];
  const name = (i: number): string => reach.items[i]?.name ?? '?';

  steps.push({
    text:
      'What each of your cutters can actually reach on THIS design, measured from the file. A cutter ' +
      'reaches a region only where its own width fits the strokes, so a wider bit cannot enter at ' +
      'all; the share is the area of the region it opens, and the flats are listed largest first.',
  });

  // Identical shares on identical items are one outcome, however many cutters produce it.
  const groups = new Map<string, ReachTableRow[]>();
  for (const row of measured) {
    const signature = row.shares.map((s) => (s === null ? '-' : s.toFixed(4))).join('|');
    const group = groups.get(signature);
    if (group) group.push(row);
    else groups.set(signature, [row]);
  }
  const byDiameter = [...groups.values()].sort((a, b) => b[0]!.diameter - a[0]!.diameter);
  for (const group of byDiameter) {
    const head = group[0]!;
    const shares = head.shares.map((s, i) => `${name(i)} ${pct(s ?? 0)}`).join(' · ');
    steps.push({
      text: `⌀ ${fmtDiameter(head.diameter)} mm — ${group.map((g) => g.key).join(', ')}`,
      value: `${shares} · ${pct(head.total)} of the whole design`,
    });
  }

  // The cutters that cannot open a region at all, by reason — a drill, a ball-nose or a V-bit is not
  // a worse choice here, it is not a choice, and saying so stops an operator wondering why the bit
  // they would have reached for is absent from the list above.
  const byReason = new Map<string, number>();
  for (const row of unmeasured) byReason.set(row.excluded!, (byReason.get(row.excluded!) ?? 0) + 1);
  for (const [reason, count] of [...byReason].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    steps.push({ text: `${count} of your ${rows.length} cutters were not measured: ${reason}.` });
  }

  steps.push({
    text: chosenKey === null ? 'No cutter from this list is on the job.' : 'The cutter on this job.',
    value:
      chosenKey === null
        ? undefined
        : `${chosenKey} — ${reach.recommendation.reason}`,
  });

  // The regions NOTHING reaches: the one number no cutter choice can change, and the reason the
  // sheet has to name them rather than let the operator find the absence on the part. The caller's
  // list is used when it has one — the table above may be of a job these regions were already
  // turned off in — and derived from the table when it has not.
  const nothingReaches = new Set(unreachable.map((u) => u.row.itemId));
  for (const { row, cutters } of unreachable) {
    steps.push({
      text:
        `${row.name} is cut by none of the ${cutters} cutters measured above — the file asks for ` +
        `${fmtNum(row.glyphArea)} mm² of it and no bit you own reaches any of that. ` +
        'It stays in the job turned off, so the program does not cut it.',
      value: `${fmtNum(row.glyphArea)} mm² unreachable`,
    });
  }

  // The other 0 %: the item IS reachable, just not by the bit in the collet. That is a decision, not
  // a fact, so it is worded as one — with the cutter that would take it.
  if (chosenKey !== null) {
    for (const row of untouchedBy(reach, chosenKey)) {
      if (nothingReaches.has(row.itemId)) continue;
      const finer = reach.cutters
        .filter((c) => c.excluded === null)
        .map((c) => ({ c, r: c.rows.find((x) => x.itemId === row.itemId) }))
        .filter((x) => x.r !== undefined && x.r.ratio > 0)
        .sort((a, b) => b.r!.ratio - a.r!.ratio || a.c.diameter - b.c.diameter)[0];
      steps.push({
        text:
          `${chosenKey} reaches none of ${row.name}` +
          (finer ? `; ${finer.c.key} reaches ${pct(finer.r!.ratio)} of it` : '') +
          ' — cut it with that bit, or turn the region off before generating.',
        value: `${fmtNum(row.glyphArea)} mm² at risk`,
      });
    }
    const finer = finerThan(reach, chosenKey);
    if (finer) {
      steps.push({
        text:
          `A second, finer bit reaches more: ${finer.key} at ${pct(reach.totalShare.get(finer.key) ?? 0)} ` +
          `of the design, against ${chosenKey} at ${pct(reach.totalShare.get(chosenKey) ?? 0)}. Cutting ` +
          'both means one program per bit — the coarse one first, the fine one for what it left — and ' +
          'everything neither reaches is reported above.',
      });
    }
  }

  return steps;
}

/**
 * #410's two-tool rest pass, as the sheet's narrative: what the second program is FOR, what it will
 * cut, and the numbers the operator may want to check against the part afterwards.
 *
 * The physical routine is NOT here. Swapping the cutter, re-probing and setting Z0 a second time are
 * things the operator does between the two programs, so they are steps of the Cut section
 * ({@link restSwapSteps}) — a do-step filed under "what you need" would be read once, at the wrong
 * moment, and then acted on from memory. This section is the reading; that one is the doing.
 */
function restPassSteps(facts: RestPassFacts): RunSheetStep[] {
  const steps: RunSheetStep[] = [];
  const { rough, rest } = facts;
  const mm2 = (v: number): string => `${fmtNum(v)} mm²`;
  const dia = (d: number): string => `⌀ ${fmtDiameter(d)} mm`;

  steps.push({
    text:
      `This design is cut in TWO programs for these two cutters. ${rough.nc} clears every region ${dia(
        rough.diameter,
      )} can enter; ${rest.nc} then cuts only what the first program LEFT — the inside corners, the ` +
      'counters, the thin strokes and the tips a wider bit cannot reach. Nothing is cut twice except ' +
      'the band the second program deliberately overlaps.',
    value: `${rough.key}, then ${rest.key}`,
  });
  steps.push({
    text: rough.reason,
    value: `${pct(rough.share)} of the design, ${dia(rough.diameter)}`,
  });
  steps.push({ text: rest.reason, value: dia(rest.diameter) });

  // The items program 1 does not contain at all. Saying so is the point: the operator's copy of the
  // first program has fewer regions in it than the file they imported, and an absence that is never
  // named reads as a bug in the file.
  for (const item of facts.unroughed) {
    steps.push({
      text:
        `${item.name} is not in ${rough.nc} at all: ${dia(rough.diameter)} cannot enter a single stroke ` +
        `of it (${fmtNum(item.area)} mm² of strokes at ${fmtNum(item.depth)} mm). ${rest.key} cuts it in ` +
        'the second program.',
      value: `${fmtNum(item.area)} mm² left to ${rest.key}`,
    });
  }

  steps.push({
    text:
      `Measured against the first program’s OWN simulated removal — the material its toolpath really ` +
      `took out, not its offset drawn wider: ${rough.nc} removes ${mm2(facts.clearedArea)} of the ` +
      `${mm2(facts.cutArea)} ${rest.key} could open. What is left is the second program.`,
    value: `${mm2(facts.restArea)} to cut`,
  });
  for (const r of facts.regions) {
    steps.push({
      text:
        `${r.name} — floor at ${fmtNum(r.depth)} mm. The first program took ${mm2(r.clearedArea)} of its ` +
        `${mm2(r.cutArea)}; ${rest.key} traverses ${mm2(r.area)} of it, overlap included.`,
      value: `${fmtNum(r.depth)} mm deep`,
    });
  }
  // #436 — the band, its provenance, and what this JOB says about it. The old sentence claimed the
  // second cutter's scallop always fell on material the first program had already taken, which was
  // true of the diameter-wide default it was written against and is not true of a chosen band below
  // the scallop; the claim is now derived per job, and so is the band the pair's residue slivers
  // need. Silence would read as "the number is fine", which is the one thing this sheet may not
  // imply about a chosen value.
  const seam = restSeamSentence(facts.seam);
  steps.push({ text: seam.text, value: seam.value });

  // The chained simulation, which is the only reason either number above can be trusted: program 2
  // was swept on program 1's result, so the sweep knew what was already gone.
  //
  // AND THE TIME, because the volume alone misleads. On the badge blank the second program takes
  // 99.6 mm³ of the pair's 354.5 — 28 % of the material — and 21 min 35 s of its 23 min 9 s. The
  // reason is the overlap: the grown rest region is 233.9 mm² where only 101.5 mm² of it was ever
  // standing material, and the other 132 mm² — the band the second program deliberately crosses to
  // reach the seam — is traversed again at the fine bit's pace. An operator who reads only the volume
  // concludes the fine bit is nearly idle, which is the opposite of what will happen at the machine.
  // And the honest consequence, measured: with the overlap the region needs to stay cuttable, the
  // pair totals 23 min 9 s against ONE ⌀0.6 mm program's 22 min 21 s on this design. The split pays
  // where the rest is a few compact regions, not where it is the strokes.
  const pairSeconds = rough.seconds + rest.seconds;
  const pairVolume = rough.removedVolume + rest.removedVolume;
  const restShare = pairSeconds === 0 ? 0 : rest.seconds / pairSeconds;
  steps.push({
    text:
      `Both programs were simulated TOGETHER, the second one starting from the material the first one ` +
      `left. ${rest.nc} removes ${fmtNum(facts.restRemovedVolume)} mm³ of the pair’s ` +
      `${fmtNum(pairVolume)} mm³ — ${pct(pairVolume === 0 ? 0 : facts.restRemovedVolume / pairVolume)} ` +
      'of the material, and the ONLY measure of how much of this job is clean-up.' +
      (restShare <= 0.5
        ? ` It is estimated at ${formatDuration(rest.seconds)} against the first program’s ` +
          `${formatDuration(rough.seconds)}, and most of that is short passes between the shapes the ` +
          'first program could not enter.'
        : ` It is estimated at ${formatDuration(rest.seconds)} of this setup’s ` +
          `${formatDuration(pairSeconds)} — MOST of it, and the reason is the seam: the second program ` +
          `has to traverse ${mm2(facts.restArea)} to cut it, where only ` +
          `${mm2(facts.cutArea - facts.clearedArea)} of that was ever standing material, and the rest ` +
          `is the ${fmtNum(facts.overlap)} mm band it crosses to reach the seam. On a design whose ` +
          'rest is the strokes themselves this split is a wash — one fine-bit program over the whole ' +
          `file reaches the same part more simply. Run ${rough.nc} anyway: it is quick, it takes the ` +
          'bulk of the material, and it tells the second program what it does not have to cut.'),
    value: `${fmtNum(facts.restRemovedVolume)} mm³ · ${formatDuration(rest.seconds)}`,
  });
  if (facts.leftover.area > 0) {
    const worst = facts.leftover.byItem[0];
    steps.push({
      text:
        `Neither program reaches all of the design: ${mm2(facts.leftover.area)} is still standing when ` +
        'both have run. It is the corners and the narrowest tips — a round cutter cannot open a sharp ' +
        'inside corner, whatever the passes — and no program here claims to cut it.' +
        (worst === undefined
          ? ''
          : ` The largest is ${worst.name}: ${mm2(worst.area)} of it at ${fmtNum(worst.depth)} mm.`),
      value: `${mm2(facts.leftover.area)} unreachable`,
    });
    // #436 — the same remainder as a SHARE of what the design asked for, against the threshold that
    // decides whether a third program is worth writing. It sits under the unreachable sentence and
    // not in its place: that one says WHICH item is short, this one says whether it is enough to act
    // on, and a reader who wants the second is the reader who is choosing cutters.
    if (facts.thirdTool !== null) {
      steps.push({
        text: facts.thirdTool.text,
        value: `${pct(facts.thirdTool.share)} of the design${
          facts.thirdTool.suggested ? ' — a third cutter is suggested' : ''
        }`,
      });
    }
  } else {
    steps.push({
      text:
        'Between them the two programs open every region this design asks for: nothing is left ' +
        'standing but the round corners the second cutter’s own width puts there.',
    });
  }
  return steps;
}

/**
 * The two-tool routine's DO-steps, for the Cut section.
 *
 * Z0 IS NOT RE-SET FROM THE SURFACE for the second program. The surface has moved — the first
 * program cut into it — and the probe and the new cutter have different lengths, so the second
 * program's zero comes from the DIFFERENCE of the two `M491` readings. That is the formula the bench
 * used on 2026-10-15, and it is the reason this section exists at all: an operator who re-touches the
 * surface for tool 2 cuts tool 2's depths shallow by the first program's depth.
 *
 * BOTH TERMS OF THE DIFFERENCE ARE ALREADY ON THE PAPER (#410 review item 1). The steps below name
 * each one by the place it was written — "when you set the origin", "with the cutter" — and never by
 * section number: the origin step records the surface Z TOGETHER WITH the PRB of the tool that made
 * the touch, and the step that fits the first cutter records that cutter's own PRB, so the second
 * program's Z0 is arithmetic over two numbers the operator wrote down at the machine rather than a
 * third reading. That "together with" is the whole point: the formula names a reference, and until
 * it did, nothing on the paper said WHICH tool the reference reading belonged to — the cutter,
 * freshly calibrated, or the probe. Numbers are avoided because the printed list gains and loses
 * sections (the rest section, the reachability table), so a number written into this text is a stale
 * claim the first time one is added.
 */
function restSwapSteps(facts: RestPassFacts, labels?: RestProgramLabels): RunSheetStep[] {
  const { rough, rest } = facts;
  const dia = `⌀ ${fmtDiameter(rest.diameter)} mm`;
  // #419 — the pair is not always the run's first two files. When the caller supplies the run's
  // program list, the section says the REAL positions; without one the old words are kept
  // byte-for-byte ("the second program", "program 2's outline", ...).
  const restWord = labels === undefined || labels.rest === 2 ? 'the second program' : `program ${labels.rest}`;
  const restPoss = labels === undefined || labels.rest === 2 ? 'the second program’s' : `program ${labels.rest}’s`;
  const restPossAscii = labels === undefined || labels.rest === 2 ? "program 2's" : `program ${labels.rest}'s`;
  const roughWord = labels === undefined || labels.rough === 1 ? 'the first program' : `program ${labels.rough}`;
  const roughPoss = labels === undefined || labels.rough === 1 ? 'the first program’s' : `program ${labels.rough}’s`;
  /** '1.82 : 1' — the ratio every travel sentence below states the same way. */
  const ratio = (travel: { rapidMm: number; cutMm: number }): string =>
    travel.cutMm > 0 ? `${fmtNum(travel.rapidMm / travel.cutMm)} : 1` : 'nothing cut';
  const travelOf = (program: RestProgram, word: string): string | null =>
    program.travel === undefined
      ? null
      : `${word} spends ${fmtNum(program.travel.rapidMm)} mm in rapid against ` +
        `${fmtNum(program.travel.cutMm)} mm cutting (${ratio(program.travel)})`;
  const travelSentence = ((): string | null => {
    const a = travelOf(rough, rough.nc);
    const b = travelOf(rest, rest.nc);
    if (a === null || b === null) return null;
    return (
      `Air travel, which is what the loop ordering moves: ${a}; ${b}. ` +
      `Before the ordering the same programs spent ${fmtNum(rough.travel!.baselineRapidMm)} mm and ` +
      `${fmtNum(rest.travel!.baselineRapidMm)} mm in rapid.`
    );
  })();
  return [
    {
      text:
        `Run ${rough.nc} to the end — ${rough.moves} cutting moves, about ${formatDuration(rough.seconds)}. ` +
        `Then home the machine and change the cutter to ${rest.key} (${dia}). Nothing moves but the Z ` +
        'reference, so the X and Y origin stays where it is.',
      code: '$H',
      record: `depth after ${rough.nc} (mm), per region above`,
      unverified: '#443',
    },
    ...(travelSentence === null ? [] : [{ text: travelSentence }]),
    {
      text:
        'Calibrate the new cutter’s length the same way as the first (M491) and record its PRB. This ' +
        'is a reading of THIS cutter alone: the Z0 below compares it with the tool that set Z0, and ' +
        'that reference reading was written down when the origin was set, so neither is re-taken here.',
      code: 'M491',
      record: 'the new cutter’s PRB (mm)',
      unverified: '#443',
    },
    {
      text:
        `Set Z0 for ${restWord} from those two readings, NOT by touching the surface again: ` +
        'Z0 = the surface Z you recorded when you set the origin + (this cutter’s PRB − the PRB of ' +
        'the tool that set Z0, recorded there beside it). The surface has been cut since that ' +
        `reading, so touching it off again would sink every one of the ${restPoss} floors by ` +
        `${roughPoss} own depth.`,
      value: 'Z0 = surface + (cutter PRB − reference PRB)',
      record: `Z0 for ${restWord} (mm)`,
      unverified: '#443',
    },
    // #437 item 8 — program 2 has its own dry run, and it belongs HERE rather than in the Dry run
    // section: its frame can only be run after the cutter change and the new Z0, and a step in §8
    // would tell the operator to run a file whose Z0 does not exist yet. A null frame is not
    // hypothetical (#273): a program the verifier refuses is generated but has no frame, and naming
    // a file that was never produced is the failure mode the Dry run section already documents.
    rest.frame === null
      ? {
          text:
            'There is no frame file for this program: it did not pass verification, so the trace was ' +
            `never produced. Do not run ${rest.nc} — clear the errors, regenerate, and the frame ` +
            'comes back with the program.',
          bold: true,
          unverified: '#443',
        }
      : {
          text:
            `Load ${rest.frame} and run it. It traces ${restPossAscii} outline in the air, the same ` +
            `${fmtNum(FRAME_Z)} mm above the work — no Z offset to set. If the trace is not where the ` +
            'rest should land, stop.',
          value: `${fmtNum(FRAME_Z)} mm above the work`,
          unverified: '#443',
        },
    {
      text:
        `Load ${rest.nc} and run it. The cutter traces only the rest: expect it to cut in short passes ` +
        `around the shapes ${roughWord} could not enter, and to spend most of its time in the air ` +
        'between them.',
      value: `about ${formatDuration(rest.seconds)}`,
      unverified: '#443',
    },
  ];
}

/** The cutter a key names, in the operator's one display form (#690b). A key the registry does not
 *  hold is not printed as a key either: the sentence stays readable without one. */
function cutterWords(toolKey: string): string {
  const entry = entryFor(toolKey);
  return entry === null ? 'a flat end mill' : toolDisplayName(entry.tool);
}

/** #419 — a rest pair's positions in the run, 1-based among the ENGRAVING programs. */
interface RestProgramLabels {
  rough: number;
  rest: number;
}

/**
 * #434 — §1's drill-point statement, as a step. Shared by the one-program drill sheet and a drill
 * program's own section, so the two cannot word the point differently.
 */
function drillPointStep(facts: RunSheetDrillFacts): RunSheetStep | null {
  const first = facts.plans[0] ?? null;
  if (first === null) return null;
  return {
    text:
      `The drill’s point — ${first.angle.from}. A drill is the full ⌀ only a point length ` +
      'above its tip, so this program states each hole’s full-diameter depth and its tip depth.',
    value:
      `${fmtNum(first.angle.deg)}° included · tip ${fmtNum(first.pointLength)} mm below ` +
      `the full ⌀${fmtNum(first.diameter)} mm`,
  };
}

/**
 * #434 — the drill program's Cut steps: its parameters, their provenance, and one line per drilled
 * item with the full-diameter depth against the tip. The facts handed in are the program's OWN
 * (`programs[n].drill` or the top-level result when it is program 1), never a re-resolution.
 */
function drillCutSteps(
  facts: RunSheetDrillFacts,
  vacuumOn: boolean,
): { params: RunSheetStep; steps: RunSheetStep[] } {
  const s = facts.settings;
  const d0 = facts.plans[0]!;
  const params: RunSheetStep = {
    text: `Drill with ${facts.toolName ?? 'the drill bit'} — spindle, plunge feed and peck. Vacuum ${vacuumOn ? 'on' : 'off'}.`,
    value:
      `${s.spindleRpm} RPM · ${fmtNum(s.plungeFeed)} mm/min plunge · pecks of ` +
      `${fmtNum(d0.peck)} mm · re-entry ${fmtNum(s.peckClearanceMm)} mm above the floor just cut`,
  };
  const steps: RunSheetStep[] = [
    params,
    {
      text:
        `Where those numbers came from: drill.peckDiameters (${facts.sources.peckDiameters}) — ` +
        `${fmtNum(s.peckDiameters)} × ⌀${fmtNum(d0.diameter)} = ${fmtNum(Math.round(s.peckDiameters * d0.diameter * 1000) / 1000)} mm ` +
        'unless a hole states its own peck; ' +
        `drill.peckClearanceMm (${facts.sources.peckClearanceMm}); ` +
        `drill.plungeFeed (${facts.sources.plungeFeed}); ` +
        `drill.spindleRpm (${facts.sources.spindleRpm}).`,
    },
  ];
  for (const d of facts.plans) {
    // The plan rounds its tip and point to the post's precision; the full-diameter depth is the
    // difference, rounded the same way so it prints as the item stated it.
    const full = Math.round((d.tipDepth - d.pointLength) * 1000) / 1000;
    steps.push({
      text:
        `${d.name} — ${d.holes.length} hole(s) on the ${fmtNum(d.angle.deg)}° point ` +
        `(${d.angle.from}), pecked every ${fmtNum(d.peck)} mm ` +
        `(${d.peckSource ?? 'the stored result did not record the source'}). The full ` +
        `⌀${fmtNum(d.diameter)} mm reaches ${fmtNum(full)} mm; the tip carries ` +
        `${fmtNum(d.pointLength)} mm lower, to ${fmtNum(d.tipDepth)} mm.`,
      value: `⌀${fmtNum(d.diameter)} mm · ${fmtNum(d.peck)} mm pecks · tip ${fmtNum(d.tipDepth)} mm`,
    });
  }
  return { params, steps };
}

/** #472 — the rest program's own feeds line, labelled with its real position in the run. */
function restProgramParamsStep(rest: RestProgram, number: number): RunSheetStep {
  const label = `Program ${number}, ${rest.nc} (${rest.key}, ⌀ ${fmtNum(rest.diameter)} mm) — `;
  const p = rest.params;
  if (p === null) {
    return { text: `${label}cutting parameters were not resolved for this program.` };
  }
  // The trace-only rule is the rest program's own fact (`RestProgram.traceOnly`), not an assumption
  // about what a rest pass writes today (#405).
  return {
    text: rest.traceOnly
      ? `${label}spindle, feed and plunge. Vacuum ${p.air ? 'on' : 'off'}.`
      : `${label}spindle, feed, plunge, passes and step-down. Vacuum ${p.air ? 'on' : 'off'}.`,
    value: rest.traceOnly
      ? `${p.rpm} RPM · ${fmtNum(p.feed)} mm/min feed · ${fmtNum(p.plungeFeed)} mm/min plunge · ` +
        'a single stroke on every line, cut straight to depth — no step-over'
      : `${p.rpm} RPM · ${fmtNum(p.feed)} mm/min feed · ${fmtNum(p.plungeFeed)} mm/min plunge · ` +
        `${rest.passes} × ${fmtNum(p.stepDown)} mm passes · ${fmtNum(p.stepOver)} mm step-over`,
  };
}

/**
 * #419 — a rest program's own Cut section: the measured pair's swap/Z0 routine and the second
 * cutter's feeds, in the order they happen. The narrative (what each cutter is FOR, what it left,
 * the chained simulation) is the earlier "Two tools, one blank" section and is not repeated here.
 */
function restProgramSectionSteps(facts: RestPassFacts, labels: RestProgramLabels): RunSheetStep[] {
  const steps = restSwapSteps(facts, labels);
  // `restSwapSteps` always ends [frame step, load step]; the program's own numbers belong before
  // the dry run that first loads one of its files.
  steps.splice(steps.length - 2, 0, restProgramParamsStep(facts.rest, labels.rest));
  return steps;
}

/**
 * #250 — the allowance line before the split item rows: the number, its provenance, and which file
 * finishes the cut. Stated even for a good number, for the same reason `restSourceWords` states
 * every rest source.
 */
function finishAllowanceStep(facts: RunSheetFinishFacts): RunSheetStep {
  const leave = fmtNum(facts.stockToLeaveMm.value);
  const where =
    facts.mode === 'rough-and-finish'
      ? 'This file follows it with the finishing pass, at full depth.'
      : facts.mode === 'rough-only'
        ? 'A later program in this run is the finishing pass, at full depth.'
        : 'This program is the finishing pass; the roughing cut ran in the previous program.';
  return {
    text:
      `Finish allowance: the roughing pass leaves ${leave} mm of stock on the walls and the floor ` +
      `(${finishSourceWords(facts.stockToLeaveMm.source)}). ${where}`,
    value: `${leave} mm stock to leave`,
  };
}

/**
 * #673 — an INLAY half, in the operator's terms: which blank this is, the numbers the pair closes
 * with (`inlayNumbers`'s, never re-derived), and what happens after both runs. One step per marked
 * region on the female's side; the male's step is its own job's instructions, because the glue-up
 * is a physical act between two runs.
 */
function inlaySteps(job: EngraveJob): RunSheetStep[] {
  const marked = inlayMarked(job);
  if (marked.length === 0) return [];
  const tool = jobTool(job);
  const cone = tool === null ? null : vCone(tool);
  if (cone === null) return [];
  const steps: RunSheetStep[] = [];
  for (const { item, mark } of marked) {
    const name = itemLabel(item);
    if (mark.role === 'female') {
      const check = inlayNumbers(cone, item.depth, inlayGlueGap(mark));
      if (!check.ok) continue;
      const n = check.numbers;
      steps.push({
        text:
          `This is the FEMALE blank: ${name} is the pocket the plug glues into — ` +
          `${inlayMm(n.pocketDepthMm)} mm deep with a ${inlayMm(n.glueGapMm)} mm glue gap. Save the male ` +
          `blank from the row, cut it from the second blank with the same V-bit, and glue its machined face ` +
          `down into this pocket: the plug's edge sits ${inlayMm(n.topInsetMm)} mm inside the design and its ` +
          `end stops ${inlayMm(n.glueGapMm)} mm above this floor.`,
        value: `female · ${inlayMm(n.pocketDepthMm)} mm pocket · ${inlayMm(n.glueGapMm)} mm gap`,
      });
    } else {
      const gap = mark.glueGapMm === undefined ? null : mark.glueGapMm;
      steps.push({
        text:
          `This is the MALE blank: ${name} cuts the complement around the plug, so the plug stands ` +
          `${inlayMm(item.depth)} mm proud of the carved face. Cut it with the same V-bit as the female, glue ` +
          `this machined face down into her pocket` +
          (gap === null ? '' : ` (its marker records a ${inlayMm(gap)} mm glue gap)`) +
          `, and when the glue cures plane the male blank away down to the plug's base.`,
        value: `male · ${inlayMm(item.depth)} mm plug`,
      });
    }
  }
  return steps;
}

/**
 * #670 — a TEXTURE, in the operator's terms: the pattern, the numbers the CAM runs with (from the
 * same `textureNumbers`/`textureStrokes` the plan calls) and what each stroke is. One step per
 * textured region, after the inlay steps: a texture never changes WHICH blank is loaded, so it has
 * no glue-up to explain — only the pattern's repeatability.
 */
function textureSteps(job: EngraveJob): RunSheetStep[] {
  const steps: RunSheetStep[] = [];
  for (const item of job.shapes) {
    if (!item.enabled || item.construction || item.texture === undefined) continue;
    if (item.through === true) continue;
    const numbers = textureNumbers(item.texture, item.depth);
    const strokes = textureStrokes(item, numbers);
    const name = itemLabel(item);
    const pattern = textureOperationName(numbers.pattern);
    // A stipple's paths are strokes and its seed is the reason they repeat; a scallop's are row
    // runs with no randomness at all, so the seed sentence is the stipple's alone.
    const noun = numbers.pattern === 'scallop' ? 'run' : 'stroke';
    const count = `${strokes.paths.length} ${noun}${strokes.paths.length === 1 ? '' : 's'}`;
    const detail =
      numbers.pattern === 'stipple'
        ? `${fmtNum(numbers.strokeMm)} mm strokes at a ${fmtNum(numbers.pitchMm)} mm pitch ` +
          `(${numbers.pitchSource}, stroke ${numbers.strokeSource}), seed ${numbers.seed}`
        : `semicircular bumps at a ${fmtNum(numbers.pitchMm)} mm pitch (${numbers.pitchSource})`;
    if (strokes.paths.length === 0) {
      steps.push({
        text:
          `${name}: ${pattern} comes out empty at these numbers, so the program cuts nothing there. ` +
          'Widen the region or narrow the pitch.',
        value: `${pattern} · empty`,
      });
      continue;
    }
    steps.push({
      text:
        `${name}: ${pattern}. ${count} — ${detail} — cut ${fmtNum(numbers.depthMm)} mm deep, each ` +
        "one a trace at the cutter's own centre line." +
        (numbers.pattern === 'stipple' ? ' The stored seed lays the same pattern every run.' : '') +
        (strokes.capped
          ? ` The pattern wants more than the ${DEFAULT_MAX_TEXTURE_STROKES}-path cap; the first ` +
            `${DEFAULT_MAX_TEXTURE_STROKES} are cut.`
          : ''),
      value:
        `${pattern} · ${count} · ${fmtNum(numbers.pitchMm)} mm pitch · ${fmtNum(numbers.depthMm)} mm deep`,
    });
  }
  return steps;
}

/**
 * #674 — a FLUTE, in the operator's terms: the ramp, the step, the peak, and the fact that there
 * is no plunge. The numbers are `fluteNumbers`' and the plan's own profile step, never re-derived.
 */
function fluteSteps(job: EngraveJob): RunSheetStep[] {
  const steps: RunSheetStep[] = [];
  for (const trace of job.traces ?? []) {
    if (!trace.enabled || trace.construction || trace.kind !== 'line' || trace.flute === undefined) continue;
    const n = fluteNumbers(trace.flute, trace.depth);
    const pathLength = linePathLength(trace.points, trace.closed);
    const peak = 2 * n.rampMm >= pathLength ? (pathLength > 0 ? (n.depthMm * pathLength) / (2 * n.rampMm) : 0) : n.depthMm;
    steps.push({
      text:
        `${fluteOperationName(trace)}: a groove ${fmtNum(peak)} mm deep down the middle, ramping in ` +
        `and out over ${fmtNum(n.rampMm)} mm at each end (${n.rampSource}). The tool starts on the ` +
        'surface and feeds down, so there is no plunge dimple at either end; the ramp is cut in ' +
        `steps of ${fmtNum(n.depthMm / FLUTE_RAMP_STEPS)} mm, each one a move the sim and the ` +
        'oracle both read at its own depth.' +
        (peak < n.depthMm - 1e-9
          ? ` The path is ${fmtNum(pathLength)} mm long and shorter than its two ramps, so the groove never reaches the full depth.`
          : ''),
      value: `${fmtNum(peak)} mm deep · ${fmtNum(n.rampMm)} mm ramps`,
    });
  }
  return steps;
}

/** A line item's path length, mm — its segments plus the closing one for a ring. */
function linePathLength(points: readonly (readonly [number, number])[], closed: boolean): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  if (closed && points.length >= 2) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    total += Math.hypot(first[0] - last[0], first[1] - last[1]);
  }
  return total;
}

/**
 * #674 — a PRISM, in the operator's terms: what stands, on what base, and how far the cut reaches.
 * The numbers are `prismNumbers`', the same call the plan, the row and the findings make.
 */
function prismSteps(job: EngraveJob): RunSheetStep[] {
  const steps: RunSheetStep[] = [];
  const tool = jobTool(job);
  const cone = tool === null ? null : vCone(tool);
  for (const item of job.shapes) {
    if (!item.enabled || item.construction || item.prism === undefined) continue;
    if (item.through === true || item.texture !== undefined || item.inlay !== undefined || item.vCarveDepth === 'variable') continue;
    const n = prismNumbers(cone, item.depth, item.prism).numbers;
    steps.push({
      text:
        `${itemLabel(item)}: a raised prism — the shape stands ${fmtNum(n.heightMm)} mm, its sides ` +
        `sloping at the bit's own angle over ${fmtNum(n.slopeWidthMm)} mm, on a ${fmtNum(n.baseMm)} mm ` +
        `flat base (${n.baseSource}). The cut meets the untouched top face ${fmtNum(n.marginMm)} mm ` +
        `out from the shape, and a pointed tip would leave the base ridged.`,
      value: `${fmtNum(n.heightMm)} mm high · ${fmtNum(n.baseMm)} mm base · ${fmtNum(n.marginMm)} mm margin`,
    });
  }
  return steps;
}

/**
 * #675 — a MILLING CUTTER's plunge drill (`cam/drill.ts`): its peck comes from the feeds row, so an
 * item that states its own is named with BOTH numbers — the one the file cuts and the one the row
 * would have supplied. A drill bit's own program states the peck per hole in `drillCutSteps`
 * instead, so the two never describe the same hole twice.
 */
function drillPeckSteps(job: EngraveJob, feedsPeck: number | null): RunSheetStep[] {
  const steps: RunSheetStep[] = [];
  for (const d of job.drills ?? []) {
    if (!d.enabled || d.mode === 'bore' || d.peckMm === undefined) continue;
    steps.push({
      text:
        `${drillOperationName(d)}: pecked every ${fmtNum(d.peckMm)} mm — typed in this job` +
        (feedsPeck === null
          ? '.'
          : `, where the feeds row would peck every ${fmtNum(feedsPeck)} mm.`),
      value: `${fmtNum(d.peckMm)} mm per peck`,
    });
  }
  return steps;
}

/**
 * #535 — a PURE GOAL job's surface steps: what the two passes did, then the engine's own notes
 * (the feeds, the undercuts a heightfield cannot express, the resolution, and a flat finishing
 * cutter). Every number is `surface3d`'s, printed rather than re-derived here.
 */
function surfaceSteps(facts: GoalSurfaceFacts): RunSheetStep[] {
  const rough =
    facts.roughingLayers === 0
      ? 'Roughing has nothing to remove: no stock stands above the goal surface and its allowance.'
      : `Roughing in ${facts.roughingLayers} Z layer${facts.roughingLayers === 1 ? '' : 's'} at ` +
        `${fmtNum(facts.stepDownMm)} mm step-down and ${fmtNum(facts.roughStepOverMm)} mm step-over, ` +
        `leaving ${fmtNum(facts.stockToLeaveMm)} mm of stock on the surface.`;
  // #671 — the passes run in the order they are listed: the parallel finish, then the scallop
  // contours, then the pencil paths along the corners.
  const passes = [`Finishing follows the surface at ${fmtNum(facts.finishStepOverMm)} mm step-over.`];
  if (facts.scallop != null) {
    passes.push(
      `Then a scallop pass on ${facts.scallop.contours} offset contour${facts.scallop.contours === 1 ? '' : 's'}, ` +
        `the step held at ${fmtNum(facts.scallop.stepOverMm)} mm measured along the surface.`,
    );
  }
  if (facts.pencil != null) {
    passes.push(
      `Then a pencil pass along ${facts.pencil.paths} concave crease${facts.pencil.paths === 1 ? '' : 's'} ` +
        `(${fmtNum(facts.pencil.creaseDeg)}° or sharper), at the same gouge-safe drop.`,
    );
  }
  const steps: RunSheetStep[] = [
    {
      text: `Surface a mesh. ${rough} ${passes.join(' ')}`,
      value:
        `${facts.roughingLayers} layer${facts.roughingLayers === 1 ? '' : 's'} · ` +
        `${fmtNum(facts.stepDownMm)} mm step-down · ${fmtNum(facts.finishStepOverMm)} mm finish step-over · ` +
        `${fmtNum(facts.stockToLeaveMm)} mm left` +
        (facts.scallop == null ? '' : ' · scallop') +
        (facts.pencil == null ? '' : ' · pencil'),
    },
  ];
  for (const note of facts.notes) steps.push({ text: note });
  return steps;
}

/** The frame/load pair for a later program: its own dry run, then the file. */
function programRunSteps(program: RunSheetProgram, number: number): RunSheetStep[] {
  const steps: RunSheetStep[] = [];
  if (program.frameNc === null) {
    steps.push({
      text:
        `There is no frame file for program ${number}: it did not pass verification, so the trace ` +
        `was never produced. Do not run ${program.nc} — clear the errors, regenerate, and the frame ` +
        'comes back with the program.',
      bold: true,
    });
  } else {
    steps.push({
      text:
        `Load ${program.frameNc} and run it. It traces program ${number}'s outline in the air, the ` +
        `same ${fmtNum(FRAME_Z)} mm above the work — no Z offset to set. If the trace is not where ` +
        'the program should land, stop.',
      value: `${fmtNum(FRAME_Z)} mm above the work`,
    });
  }
  const cam = program.cam;
  steps.push({
    text:
      `Load ${program.nc} and run it` +
      (cam === null
        ? '. Its CAM summary was not recorded for this run.'
        : ` — ${cam.operations} operation${cam.operations === 1 ? '' : 's'}, ` +
          `${cam.cuttingMoves} cutting move${cam.cuttingMoves === 1 ? '' : 's'}.`),
    ...(cam === null ? {} : { value: `about ${formatDuration(cam.estimatedSeconds)}` }),
  });
  return steps;
}

/**
 * #218 — the through-cut and tab-removal steps for one program. Two separate steps on purpose:
 * the first says what the file does below the blank, the second is a physical action taken after
 * the program ends and is never buried inside another sentence. Empty for a program with no
 * cut-outs, so every pre-#218 sheet is unchanged.
 */
function throughCutSteps(facts: RunSheetThroughFacts | null | undefined): RunSheetStep[] {
  if (facts === null || facts === undefined || facts.cutouts.length === 0) return [];
  const count = facts.cutouts.length;
  const board = facts.boardThicknessMm;
  const steps: RunSheetStep[] = [
    {
      text:
        `This program cuts ${count === 1 ? 'one piece' : `${count} pieces`} out of the blank and through ` +
        `into the board, ${fmtNum(facts.breakthroughMm)} mm past the blank's underside` +
        (board === null
          ? '.'
          : ` — the board is ${fmtNum(board)} mm thick, so the kerf stops ` +
            `${fmtNum(Math.max(0, board - facts.breakthroughMm))} mm short of its underside.`),
      value: `${fmtNum(facts.breakthroughMm)} mm breakthrough`,
    },
  ];
  const tabbed = facts.cutouts.filter((c) => c.tabs.count > 0);
  if (tabbed.length > 0) {
    const total = tabbed.reduce((sum, c) => sum + c.tabs.count, 0);
    const detail = tabbed
      .map(
        (c) =>
          `${c.name}: ${c.tabs.count} tab${c.tabs.count === 1 ? '' : 's'}, ` +
          `${fmtNum(c.tabs.widthMm)} mm wide and ${fmtNum(c.tabs.heightMm)} mm high`,
      )
      .join('; ');
    steps.push({
      // A DISTINCT step, not a sentence inside another: the program holds the part by these tabs,
      // and the operator must not free it before the file ends.
      text:
        `Only after the program ends, remove the cut-out ${count === 1 ? 'part' : 'parts'} and cut ` +
        `the ${total === 1 ? 'holding tab' : 'holding tabs'} by hand — ${detail}. Cut each tab flush ` +
        'with the part and the blank; do not lever a part out by its tabs.',
      value: `${total} tab${total === 1 ? '' : 's'} to cut by hand`,
    });
  }
  return steps;
}

/**
 * #737 — the saw step for a rotary part left on a neck. It belongs to the program that cut the
 * neck, and it is the LAST physical action of that file: the neck is cut to depth all the way
 * round, and the part is sawn through it after the program ends.
 *
 * The words are the issue's own — "Saw the part off at X … mm (the neck)" — with the neck's size
 * after them, every number carrying its unit. Empty for a program with no neck, so every
 * pre-#737 sheet is unchanged.
 */
function neckSawSteps(facts: RunSheetNeckFacts | null | undefined): RunSheetStep[] {
  if (facts === null || facts === undefined) return [];
  return [
    {
      text:
        `Saw the part off at X ${fmtNum(facts.sawAtMm)} mm (the neck) — ⌀${fmtNum(facts.diameterMm)} mm ` +
        `and ${fmtNum(facts.lengthMm)} mm long, from X ${fmtNum(facts.fromMm)} mm to X ${fmtNum(facts.toMm)} mm, ` +
        `and ${fmtNum(facts.depthMm)} mm deep. It is the program's last cut, made all the way round.`,
      value: `⌀${fmtNum(facts.diameterMm)} × ${fmtNum(facts.lengthMm)} mm neck`,
    },
  ];
}

/** A drill program's own section — point, `drill.*` numbers and provenance, holes, then the file. */
function drillProgramSectionSteps(
  program: RunSheetProgram,
  facts: RunSheetDrillFacts,
  number: number,
  vacuumOn: boolean,
): RunSheetStep[] {
  const point = drillPointStep(facts);
  return [
    {
      text:
        `Program ${number} is ${program.nc}, the drill program for setup ${program.setupIndex} — ` +
        `cut with ${facts.toolName ?? 'the drill bit'}.`,
      value: `program ${number}`,
    },
    ...(point === null ? [] : [point]),
    ...drillCutSteps(facts, vacuumOn).steps,
    ...programRunSteps(program, number),
    ...throughCutSteps(program.through),
  ];
}

/**
 * #668 — a bore's helix, in the operator's terms: the pitch per turn, WHICH of its two sources
 * caps it, and the rest of the path. One step per bore item (the `drillCutSteps` pattern), so a
 * program with holes of different diameters states each one's own pitch rather than one number
 * that only fits the first.
 */
function boreSteps(facts: RunSheetBoreFacts): RunSheetStep[] {
  return facts.items.map((item) => {
    const rampTighter = item.pitchMm < item.stepDownMm - 1e-9;
    const stepDown = `the feeds row’s ${fmtNum(item.stepDownMm)} mm step-down`;
    const ramp = `the ${fmtNum(item.rampAngleDeg)}° ramp angle (the shop’s bore.rampAngleDeg, ${item.rampSource})`;
    const cap = rampTighter ? ramp : stepDown;
    const other = rampTighter ? stepDown : ramp;
    const floor =
      item.centreRadiusMm > item.cutterDiameterMm / 2
        ? 'and clears the disc at every level on the way down, then laps the wall at full depth'
        : 'then laps the wall at full depth, a lap that already reaches the hole’s centre';
    return {
      text:
        `${item.name} is a bore to size: a ⌀${fmtNum(item.holeDiameterMm)} mm hole cut by the ` +
        `⌀${fmtNum(item.cutterDiameterMm)} mm cutter, helixing at a ${fmtNum(item.centreRadiusMm)} mm ` +
        `centre radius. It drops ${fmtNum(item.pitchMm)} mm per turn — ${cap} is the tighter of it and ` +
        `${other} — ${floor}.`,
      value: `${fmtNum(item.pitchMm)} mm per turn`,
    };
  });
}

/**
 * #669 — a chamfer's bevel, in the operator's terms: the width on the top face, the depth the
 * cutter's cone takes it to, which side of the edge the tool runs, and WHEN it runs relative to
 * the cut that leaves the edge. One step per chamfer (the `boreSteps` pattern), because two
 * bevels can differ in width and side.
 */
function chamferSteps(facts: RunSheetChamferFacts): RunSheetStep[] {
  return facts.items.map((item) => {
    const when =
      item.side === 'outside'
        ? 'before the profile cuts the part free'
        : 'after the pocket that opens the rim';
    return {
      text:
        `${item.name} cuts a ${fmtNum(item.widthMm)} mm chamfer ${item.side === 'outside' ? 'on the part’s outer edge' : 'on the pocket’s rim'} — ` +
        `the bevel reaches ${fmtNum(item.depthMm)} mm below the top face — ${when}. ` +
        `Tip ${fmtNum(item.tipDiameterMm)} mm (${item.tipSource}).`,
      value: `${fmtNum(item.widthMm)} mm chamfer`,
    };
  });
}

/**
 * #677 — a core-clearance program's own step: what stood, where the flat bottom sits, and that this
 * is the program after the V-carve. One step per core (the `boreSteps` pattern), because a job can
 * carry two variable regions whose cores differ in area.
 */
function coreSteps(facts: RunSheetCoreFacts): RunSheetStep[] {
  return facts.cores.map((core) => ({
    text:
      `The middle of ${core.name} that the V’s width cannot reach is pocketed flat at ` +
      `${fmtNum(core.depthMm)} mm — ${fmtNum(core.areaMm2)} mm² of floor at the cap — in this ` +
      'program, after the V-carve that opened the sloped wall.',
    value: `${fmtNum(core.areaMm2)} mm² at ${fmtNum(core.depthMm)} mm`,
  }));
}

/** A later engraving program that carries no drill or rest facts of its own. */
function engraveProgramSectionSteps(program: RunSheetProgram, number: number): RunSheetStep[] {
  const cam = program.cam;
  return [
    {
      text:
        `Program ${number} is ${program.nc}, the cut for setup ${program.setupIndex} — ` +
        `cut with ${program.toolKey}.`,
      value:
        cam === null
          ? 'no CAM summary was recorded'
          : `${cam.operations} operation${cam.operations === 1 ? '' : 's'} · about ${formatDuration(cam.estimatedSeconds)}`,
    },
    ...(program.finish == null ? [] : [finishAllowanceStep(program.finish)]),
    ...(program.bore == null ? [] : boreSteps(program.bore)),
    ...(program.chamfer == null ? [] : chamferSteps(program.chamfer)),
    ...(program.core == null ? [] : coreSteps(program.core)),
    ...programRunSteps(program, number),
    ...throughCutSteps(program.through),
    ...neckSawSteps(program.neck),
  ];
}

/**
 * The FIRST cut of a rest pair that is not program 1: its own section, with its own feeds and file.
 * The pair's swap routine belongs to the second program's section, which starts by finishing this
 * one; nothing here repeats the measured rest facts.
 */
function restRoughProgramSection(program: RunSheetProgram, facts: RestPassFacts, number: number): RunSheetStep[] {
  return [
    {
      text:
        `Program ${number} is ${program.nc}, the first cut of the rest pair for setup ` +
        `${program.setupIndex} — cut with ${facts.rough.key} (⌀ ${fmtNum(facts.rough.diameter)} mm).`,
      value: `program ${number}`,
    },
    restProgramParamsStep(facts.rough, number),
    ...(program.finish == null ? [] : [finishAllowanceStep(program.finish)]),
    ...programRunSteps(program, number),
    ...throughCutSteps(program.through),
  ];
}

/** A rest program's own section: who it is, then the measured pair's swap and its own numbers. */
function restProgramSection(program: RunSheetProgram, facts: RestPassFacts, labels: RestProgramLabels): RunSheetStep[] {
  return [
    {
      text:
        `Program ${labels.rest} is ${program.nc}, the rest cut for setup ${program.setupIndex} — ` +
        `cut with ${facts.rest.key} (⌀ ${fmtNum(facts.rest.diameter)} mm).`,
      value: `program ${labels.rest}`,
    },
    ...(program.finish == null ? [] : [finishAllowanceStep(program.finish)]),
    ...restProgramSectionSteps(facts, labels),
    ...throughCutSteps(program.through),
    ...neckSawSteps(program.neck),
  ];
}

/** Where `nc` sits in the run, 1-based among the engraving programs; null when it is not there. */
function programNumberIn(run: readonly RunSheetProgram[], nc: string): number | null {
  const index = run.findIndex((program) => program.nc === nc);
  return index < 0 ? null : index + 1;
}

/**
 * The blank's colour plane, mm below the top face — the CAM's `f` (#221).
 *
 * `colourBoundaryFor` (`workers/sim/stackDepthLimit.ts`) owns the gate at generate time, but it
 * lives on the worker side of the engine→worker boundary. This module is pure engine data and must
 * not invert that direction, so it calls the SAME pure arithmetic the worker helper wraps:
 * `colourBoundaryDepthFor` (`layerStack.ts`, whose own comment names the run sheet as a caller).
 *
 * The gate is the job's FILM SOURCE, not a second rule. For a printed blank, `toPartPlan` copies the
 * colour facts into `plan.stock.split`/`layerHeight`, so a job that states no colour facts (or whose
 * plan carries no grid) has no colour plane — exactly the `gridOf` test `colourBoundaryFor` applies.
 * The raw model split is deliberately not used: the printed boundary is layer-quantised, and the
 * resolved value is the material (the thick fixture's 0.81 reads 0.80 on 0.2 mm layers; no finding is
 * raised).
 *
 * A laminate's film is its cap (`stock.colour.capMm`, #492), read directly: there is no print grid to
 * quantise to. It is still only a FILM SOURCE — no colour facts at all means the plane is the floor,
 * and the V-carve strategy itself never requires one.
 */
function colourPlaneFor(job: EngraveJob, plan: PartPlan): Mm | null {
  const colour = job.stock.colour;
  if (colour === undefined) return null;
  if (colour.kind === 'laminate') return colour.capMm;
  const { thickness, split, layerHeight, firstLayerHeight } = plan.stock;
  if (split === undefined || layerHeight === undefined) return null;
  return colourBoundaryDepthFor(thickness, split, layerHeight, firstLayerHeight ?? layerHeight);
}

/**
 * §1's colour-plane statement for a V-carve job (#221): the resolved film, with the file's raw
 * model split beside it, or the no-film case where the plane IS the floor. The issue asks for the
 * raw beside the resolved value verbatim ("0.80 mm below the top, from the file's 0.81 on 0.2 mm
 * layers") because the snap is the print's, not an error to be corrected. A laminate (#492) has no
 * raw companion: its cap is the manufacturer's figure, stated alone.
 */
function colourPlaneStep(job: EngraveJob, plan: PartPlan, film: Mm | null): RunSheetStep {
  const colour = job.stock.colour;
  const noFilm: RunSheetStep = {
    text:
      'The blank states no colour film, so the V-bit’s colour plane IS the floor: the design is ' +
      'correct at the cut depth, and a pointed bit draws a line twice the depth times ' +
      'tan(half-angle) wide at the surface and nothing at the bottom.',
    value: 'no film — the plane is the floor',
  };
  if (film === null || colour === undefined) return noFilm;
  if (colour.kind === 'laminate') {
    return {
      text:
        `The colour plane — where the V-bit’s design is correct — is the laminate's cap, ` +
        `${fmtNum(film)} mm below the top. The cap is the manufacturer's figure for the two-colour ` +
        'sheet; there is no print grid to quantise it to.',
      value: `colour plane ${fmtNum(film)} mm`,
    };
  }
  // `colourPlaneFor` returns a film for a printed blank only when the plan carries both, so this
  // guard restates that contract rather than guessing a layer height.
  if (plan.stock.split === undefined || plan.stock.layerHeight === undefined) return noFilm;
  const raw = plan.stock.thickness - plan.stock.split;
  const layer = plan.stock.layerHeight;
  return {
    text:
      `The colour plane — where the V-bit’s design is correct — is ${fmtNum(film)} mm below the top, ` +
      `from the file's raw ${fmtNum(raw)} mm boundary on ${fmtNum(layer)} mm layers. The print is ` +
      'layer-quantised, so this is the printed boundary rather than the model’s arithmetic; no ' +
      'warning is raised for the difference.',
    value: `colour plane ${fmtNum(film)} mm`,
  };
}

/** #604 — the found-position section, printed only when a registration measured the blank. */
function foundSteps(found: { offset: { x: number; y: number }; rotationDeg: number | null }): RunSheetStep[] {
  return [
    {
      text: 'The registration found the blank and wrote the origin at the found position, not the plan’s nominal one.',
      value: `offset X ${fmtNum(found.offset.x)} mm · Y ${fmtNum(found.offset.y)} mm${
        found.rotationDeg === null ? '' : ` · rotated ${fmtNum(found.rotationDeg)}°`
      }`,
    },
  ];
}

export function buildRunSheet(
  job: EngraveJob,
  generated: RunSheetGenerated,
  sim: RunSheetSim | null,
  now: Date = new Date(),
  settings: MarginSettings = MARGIN_DEFAULTS,
  options: RunSheetOptions = {},
): RunSheet {
  // One resolution, here: the sheet's own numbers and the panel's come off the same call with the
  // same house setting, and the BLOCK's recommendation is made from the setting rather than from
  // `margins`, which may be the job's own past recommendation (#345 review).
  const margins = effectiveMargins(job, settings);
  const { length, width, thickness, material } = job.stock;
  const vise = jobVise(job);
  // The one funnel all three item lists go through (#214/#215), so a `border`/`frame`/`cutaway`
  // is here too while a `construction` item, a broken reference and a self-intersecting polygon
  // are absent: the sheet describes exactly the cuts the `.nc` makes. `keepOuts` comes off the
  // same plan, so the diagram and the depth notes cannot disagree about where the voids are.
  const plan = toPartPlan(job);
  const items = plan.engraves;
  const diagram = buildDiagram(job, plan);
  const stackUp = buildStackUp(job);
  const itemBox = new Map(diagram.items.map((i) => [i.id, i] as const));
  // Only the cuts the cutter really gets OVER a jaw decide how far proud the blank must stand
  // (#369, #394). A floor works below the jaw tops only where a jaw is under it in XY, so a
  // blank-wide `deepest + clearance` told the operator to stop on a job the app itself had just
  // recommended: the badge hand-off's seeded line stands 6.9 mm clear of either jaw and cuts 1.0 mm,
  // yet the blank-wide reading demands `1.0 + 1` mm of stand — more than the vise default of the day
  // gave it (1.905) and far more than the seated default gives it now (0.71, #391). And the line this step prints is a STOP — an instruction to the
  // operator at the machine — so it takes the narrower reading the same rule answers with: the
  // cutter's own disc reaching the jaw face (`overJaw`, #394), not the wider reach the warning is
  // allowed to raise a band early on. The whole rule is `idJawReach`'s, so the paper and the panel
  // cannot disagree about whether the jaws bind at all.
  const overJaw = items
    .map((item) => ({ item, reach: idJawReach(job, item.id) }))
    .filter((r) => r.reach.overJaw);
  const deepestOver = overJaw.reduce<{ item: (typeof items)[number]; reach: JawReach } | null>(
    (deepest, r) => (deepest === null || r.item.depth > deepest.item.depth ? r : deepest),
    null,
  );
  // #362 review, #365 — the reason a recommended depth is as shallow as it is has to be the same
  // reason in all three places that state it, so the per-line void bound is worked out by the same
  // `voidLimitForItem` the store's walk and the panel's row call, on the same measurement
  // (`labelGlyphMeasure`). `depthSourceWords` asks it for the item it is wording, so a line the
  // sheet prints a reason for is judged against the voids THAT line reaches.
  const measure = labelGlyphMeasure(job.customFonts ?? []);
  // #207 section 3: below the deepest cut that sweeps OVER a jaw, by the clearance the JOB keeps,
  // the cutter is under the jaw tops. The number is the job's own `jawClearance` (#362 review) — the
  // same one `vise-jaw-collision` and `recommendLabelDepth` hold a floor to, so the printout
  // cannot tell the operator to stop somewhere the app does not. `null` when no cut comes over a jaw
  // (#369, #394): there is then no depth that would put a floor under one, and the step says so
  // instead of printing a stop the job cannot trip.
  const stopBelow = deepestOver === null ? null : deepestOver.item.depth + job.jawClearance;
  // #394 — the stop NAMES the cut that trips it and the jaw the cutter gets over. It is printed on
  // a sheet an operator did not write, and "stop" without a subject is a stop they cannot check.
  const stopWords =
    stopBelow !== null && deepestOver !== null
      ? `value. If it is less than ${fmtNum(stopBelow)} mm, stop: ${deepestOver.item.name} sweeps ` +
        `over the ${deepestOver.reach.jaw} jaw, so the cutter would work below the jaw tops.`
      : 'value. No cut on this job sweeps over a jaw, so there is no stop threshold to check.';
  // #488 — the load step states the proud it expects and the CLEARANCE RESULT, not a requirement.
  // The nearest cut's swept extent and the jaw face it comes nearest decide whether the blank needs
  // to stand higher at all; both are read through the same `sweptCuts`/`jawGapFor` pair
  // `validateJob`'s `vise-jaw-collision` uses, so the paper and the panel cannot disagree.
  const nearestCut = sweptCuts(job, plan).reduce<{
    name: string;
    jaw: 'fixed' | 'moving';
    gap: number;
  } | null>((nearest, cut) => {
    const { jaw, gap } = jawGapFor(job, cut.box);
    return nearest === null || gap < nearest.gap ? { name: cut.name, jaw, gap } : nearest;
  }, null);
  const clearanceWords =
    nearestCut === null
      ? 'No cut on this job comes near a jaw.'
      : nearestCut.gap >= job.jawClearance
        ? `Every cut keeps at least ${fmtNum(job.jawClearance)} mm clear of the jaws` +
          // The note's own case (#488): a blank below the jaw tops is not a reason to find a packer.
          (vise.stockProud <= 0 ? ', so the blank below the jaw tops needs no packer.' : '.')
        : `The nearest cut, ${nearestCut.name}, comes within ${fmtNum(nearestCut.gap)} mm of the ` +
          `${nearestCut.jaw} jaw face — inside the ${fmtNum(job.jawClearance)} mm the job keeps clear.`;
  const tool = jobTool(job);
  // #740 — what the record STATES it cuts with. `cuttingDiameter` falls back to `diameter`, which
  // for an engraver and a chamfer is the SHANK: printing that as the cutting size was another way
  // of telling the operator the bit is 3.175 mm wide. No stated size prints as unknown, not as the
  // shank.
  const diameter = tool ? statedCuttingSize(tool) : null;
  const params = generated.feeds && generated.feeds.ok ? generated.feeds.params : null;
  // #221 — the V-carve facts are resolved ONCE, with the engine's own functions: the cone from the
  // job's cutter, and the colour plane from the print grid the plan carries. A V-carve job is a V
  // bit cutting a REGION: a trace-only V job has a cone but no plane geometry to state, and a flat
  // job has neither, so both get none of the steps below.
  const cone = tool === null ? null : vCone(tool);
  const film = colourPlaneFor(job, plan);
  const vCarveJob = cone !== null && items.length > 0;
  const nc = generated.nc;
  // #419 — THE RUN, not only program 1. `generated.programs` is the frozen/approved list in cut
  // order; the facing entry has its own section ("Face the stock top"), so the numbering below is
  // among the ENGRAVING programs and matches the rest pass's long-standing "Program 1/2" words.
  // A caller without the list (an older stored result, the CLI before this field, every spec that
  // stubs the generated half) keeps the single-program sheet byte-for-byte.
  const hasProgramList = generated.programs !== undefined;
  const runPrograms = (generated.programs ?? []).filter((program) => (program.kind ?? 'engrave') !== 'facing');
  const roughNumber =
    options.restPass === undefined ? null : programNumberIn(runPrograms, options.restPass.rough.nc);
  const restNumber =
    options.restPass === undefined ? null : programNumberIn(runPrograms, options.restPass.rest.nc);
  // The rest steps move into their program's own section only when the program list places them.
  // Without that placement the old sheet is kept exactly, including its "Program 1"/"Program 2"
  // labels, so a stored result or the CLI cannot change under this feature.
  const restInOwnSection = hasProgramList && restNumber !== null && roughNumber !== null;
  const restLabels: RestProgramLabels | undefined =
    options.restPass !== undefined && roughNumber !== null && restNumber !== null
      ? { rough: roughNumber, rest: restNumber }
      : undefined;
  // #347 — the JOB's machine. Read once, here, rather than handed in: the name is the profile's and
  // no saved calibration touches it, so the sheet and the panel cannot disagree about which machine
  // this is even when the panel is showing a calibrated frame. Its rapid model is read from the same
  // profile (#281), so the note beside the estimate quotes the numbers the estimate was timed with.
  const machine = jobMachine(job);
  const header: RunSheetHeader = {
    jobName: job.name,
    machine: options.machineName ?? machine.name,
    generatedOn: now.toISOString().slice(0, 10),
    fileName: runSheetFileName(job.name),
    fileHash: nc === null ? '' : sha256Hex(nc).slice(0, 8),
    estimatedTime: generated.cam ? formatDuration(generated.cam.estimatedSeconds) : 'unknown',
    estimatedTimeNote: rapidAssumptionNote(machine.rapidEstimate),
    ...(options.probeName !== undefined ? { probe: options.probeName } : {}),
    ...(options.mountName !== undefined ? { mount: options.mountName } : {}),
  };

  // ---- 1 · What you need ---------------------------------------------------------------------
  const needSteps: RunSheetStep[] = [
    {
      text:
        `The blank. Measure it. If it differs by more than ${fmtNum(options.blankToleranceMm ?? 0.5)} mm in any dimension, change the job ` +
        'and regenerate — do not run this file.',
      value: `${fmtNum(length)} × ${fmtNum(width)} × ${fmtNum(thickness)} mm ${MATERIAL_LABELS[material]}`,
    },
    {
      text: tool
        ? `The cutter — ${options.toolCase === undefined ? '' : `${options.toolCase} — `}${toolDisplayName(tool)}.`
        : 'The cutter named by the job.',
      value: diameter === null ? 'cutting diameter unknown' : `⌀ ${fmtNum(diameter)} mm cutting`,
    },
    {
      text: "Record the cutter's flute length and its stick-out from the collet.",
      record: 'flute length (mm) / stick-out (mm)',
    },
    {
      text:
        'The Z1 low-profile vise, and the wired probe that ships with the machine — a mechanical ' +
        'touch tip, so it triggers on PLA (measured 2026-10-08, 0.001 mm). The 3D Probe stays in reserve.',
    },
  ];
  // #434 — a drill's cutting end is a POINT, so the hole is its full diameter only a point length
  // above the tip. State the point and its provenance before the bit is loaded: §7's depths are
  // stated twice (full diameter and tip) and the operator has to know why.
  const drillPoint = generated.drill === undefined || generated.drill === null ? null : drillPointStep(generated.drill);
  if (drillPoint !== null) needSteps.splice(2, 0, drillPoint);
  // #221 — a V-carve job's design is not the tip: it is the cone's width at the colour plane. State
  // the cone and the plane before the cutter is loaded, so the operator can check the bit and the
  // blank's printed film against the numbers §7 uses.
  if (vCarveJob && cone !== null) {
    needSteps.splice(
      2,
      0,
      {
        text:
          'The V-bit’s cone. The design is correct at the colour plane, not at the tip: every width ' +
          'this sheet states is measured on the cone’s wall at that plane.',
        value:
          `⌀ ${fmtNum(cone.tipRadius * 2)} mm tip · ${fmtNum(cone.halfAngleDeg)}° half-angle ` +
          `(${fmtNum(cone.halfAngleDeg * 2)}° included)`,
      },
      colourPlaneStep(job, plan, film),
    );
  }
  // #445 — a thread program cuts the thread only; the pilot is not in the file. The sheet says what
  // has to exist before it runs: the ISO basic minor (D1 = D − 1.0825P, `FASTENERS`) and the depth,
  // cleared by the shop's own `pilotTipClearanceMm`. The pilot DEPTH is not recomputed here —
  // `threadMillIR` owns that arithmetic — so the step states the threaded length and the clearance,
  // and an old generated object without `threadMachining` says the clearance was not recorded.
  if (plan.threads.length > 0) {
    const clearance = generated.threadMachining?.settings.pilotTipClearanceMm ?? null;
    needSteps.push({
      text:
        'The pilot — this program cuts the thread only and never the pilot. Every hole below must ' +
        'already be drilled, to the depth stated, before this file runs' +
        (clearance === null
          ? ' (the tip clearance was not recorded for this run).'
          : `, and the drill must clear the tool tip by ${fmtNum(clearance)} mm.`),
      value: plan.threads
        .map((t) => `${t.name}: ⌀${fmtNum(FASTENERS[t.size].minor)} mm pilot, ${fmtNum(t.depth)} mm of thread`)
        .join(' · '),
      bold: true,
    });
  }
  const sac = sacrificialSummary(job);
  if (sac !== null) needSteps.push({ text: 'Sacrificial material:', value: sac });
  // #345 — the margin every bound in this job is drawn to, with its source and the arithmetic the
  // app recommends for this blank. Only when a bound exists: see `usesBoundaryMargin`.
  if (usesBoundaryMargin(job, plan)) needSteps.push(marginsStep(job, plan, margins, settings));
  // #492 — the colour plane's own fact, and where its number came from. A laminate says "cap";
  // a printed blank says "colour change"; a one-colour job says nothing.
  const colour = colourStep(job);
  if (colour !== null) needSteps.push(colour);
  // #231 item 3 — an under-surface void is a property of the blank the operator must know about
  // before probing Z, so each one is stated up front with the material left over it.
  for (const ko of diagram.keepOuts) {
    // #285 review — the number below is the SMALLER of the void's own ceiling and the blank's
    // `thickness − minFloor`, so naming the void as its author is wrong whenever the blank's floor
    // binds. The sheet says which of the two is doing the limiting rather than leaving the operator
    // to guess, because the two have different fixes (pour a thicker blank vs. move the pocket).
    const parts = keepOutLimitParts(job, ko.solidThickness, margins.boundaryMargin);
    const byStockFloor = parts.stockFloor < parts.overVoid;
    needSteps.push({
      text:
        `Under-surface void — ${ko.name}. The blank is only ${fmtNum(ko.solidThickness)} mm thick ` +
        'over it: do not cut through.',
      value:
        `deepest cut ${fmtNum(parts.limit)} mm` +
        (byStockFloor ? ` (the blank’s own ${fmtNum(job.minFloor)} mm floor, not the void, sets this)` : ''),
    });
  }

  // ---- 2 · Mount the vise ---------------------------------------------------------------------
  // The bench issue any step that has NOT been walked at the machine names (see the module note):
  // today that is the held stepped material scan and the rest pass's routine.
  const BENCH_ISSUE = '#443';
  // #717 — Makera's low-profile-vise page, in its own order: home, tool out, power off at the
  // machine's switch, the board off, the pins, the jaw off for the six screws, the jaw back on
  // with its locating key seated. The fixed jaw is on the left.
  const mountSteps: RunSheetStep[] = [
    { text: 'Home the machine, remove any tool, then switch the machine off at its switch.' },
    { text: 'Remove the MDF wasteboard. Insert the two 4 × 11 mm locating pins.' },
    { text: 'With the left fixed jaw off, seat the vise on the pins; fasten it with six M5 × 20 screws.' },
    { text: 'Refit the left fixed jaw with its locating key seated. Switch the machine on.' },
  ];

  // ---- 3 · Load the blank --------------------------------------------------------------------
  const frontGap = -vise.jawStartY;
  // #213 §6 — `under` drives both the assembly steps in §3 and the wording of §5's datum: with a
  // board in the stack "the blank" is ambiguous, so those steps say "the part" and NAME the board
  // as the face Z0 must not be probed on. Without one, the sheet says what it always said.
  const under = job.sacrificial.under;
  const onBoard = under !== null;
  // #470 — which way round the blank goes is the FIRST setup's ORIENTATION (`setups/types.ts`: the
  // stock face at each machine face), not a constant. A remounted stock sits with another stock
  // face up, and the dimension between the jaws is then the other one; the identity every
  // one-setup job carries gives exactly the sentence this step has always printed. A document that
  // states an EMPTY `setups[]` has no first setup to read, so it falls back to the same identity
  // rather than throwing — the same `?.[0] ??` idiom `jobTool` uses.
  const orientation = jobSetups(job)[0]?.orientation ?? {
    top: 'top',
    bottom: 'bottom',
    left: 'left',
    right: 'right',
    front: 'front',
    back: 'back',
  };
  const betweenJaws = orientation.left === 'left' || orientation.left === 'right' ? 'length' : 'width';
  const loadSteps: RunSheetStep[] = [
    // #213 §6 — with sacrificial material the thing loaded is an assembly, and the order matters:
    // the part is fixed to the board/strips BEFORE it goes between the jaws, and the strips sit
    // between the jaw face and the part so the jaws bear on them, not on the part.
    ...(under
      ? [
          {
            text: `Fix the part to the board before loading — the board goes in with it.`,
            value: `${fmtNum(under.thickness)} mm board, fixed with ${under.attach}`,
          } as RunSheetStep,
        ]
      : []),
    ...(['left', 'right'] as const)
      .filter((pos) => job.sacrificial.sides[pos] !== null)
      .map((pos): RunSheetStep => {
        const strip = job.sacrificial.sides[pos]!;
        return {
          text: `Put the ${pos} strip between the ${pos === 'left' ? 'fixed' : 'moving'} jaw and the part — the jaw clamps the strip, not the part.`,
          value: `${fmtNum(strip.thickness)} mm strip`,
        };
      }),
    {
      text:
        `The blank's ${betweenJaws} runs left–right between the jaws. ` +
        (orientation.top === 'top'
          ? 'The face to be cut is up.'
          : `The stock's ${orientation.top} face is up — that is the face to be cut.`),
      value: `${fmtNum(betweenJaws === 'length' ? length : width)} mm`,
    },
    {
      text:
        `The ${onBoard ? "part's " : ''}top face stands ${fmtNum(vise.stockProud)} mm above the jaw tops. ` +
        `${clearanceWords} Record the measured ` +
        stopWords,
      record: 'measured stock proud (mm)',
    },
    {
      text: `Push the blank's front edge to where the file expects it: the front edge is ${fmtNum(frontGap)} mm behind the front of the jaws.`,
    },
    { text: 'Tighten. Check the blank does not rock.' },
  ];

  // #432 review R1 — A FACING JOB'S ORDER IS PROBE → FACE → RE-TOUCH → ENGRAVE. The origin is
  // probed before ANY cutter goes in, the first cutter fitted is the FACING one (its Z0 comes from
  // the probe's reading), and the engraving cutter is fitted at the very end, after the re-touch on
  // the faced top. So the two sections below SWAP for a facing job, and neither one's steps can be
  // written without knowing which job it is — this flag is the one place that is decided.
  //
  // True only when the skim will actually run. A facing file the verifier withheld leaves the job
  // as a plain one — the facing section below says so — and the sheet must not send the operator
  // looking for a skim that does not exist.
  const facingRun =
    job.facing !== undefined && job.facing.enabled && job.facing.depth > 0 && generated.facingNc !== null;

  // ---- 4 · Fit the cutter and measure its length ---------------------------------------------
  // For a facing job this section runs AFTER the origin (see `facingRun` above) and fits the FACING
  // cutter, because that is the first cutter to touch the blank: the skim happens before anything
  // else, and its Z0 comes from the probe's surface reading, not from a second touch-off.
  //
  // `M491` is run from the app's own console or from Makera Studio (the harness `tools/z1/`
  // drives the same command): naming only Studio said the app cannot do it, which stopped being
  // true when the desktop build learned to talk to the machine.
  const cutterSteps: RunSheetStep[] = facingRun
    ? [
        {
          text:
            'Home the machine, then fit the FACING cutter in place of the probe. Nothing moves but ' +
            'the Z reference, so the X and Y origin stays where the probing put it.',
          code: '$H',
        },
        {
          text:
            'Fit the FACING cutter, not the engraving bit. Run tool-length calibration from the ' +
            'app’s console or Studio (M491) and record this cutter’s PRB — a reading of THIS cutter ' +
            'alone, the second term of the Z0 below.',
          code: 'M491',
          record: 'the facing cutter’s PRB (mm)',
        },
        {
          text:
            'Set Z0 for the facing program from those two readings, NOT by touching the surface ' +
            'again: Z0 = the surface Z you recorded when you probed the origin + (this cutter’s PRB ' +
            '− the probe’s PRB, recorded there beside it). Write it with G10 L2 while the facing ' +
            'cutter is fitted: that command zeroes the tool-length offset to the current tool.',
          value: 'Z0 = surface + (facing PRB − probe PRB)',
          record: 'Z0 for the facing program (mm)',
        },
        {
          text:
            'Do not skip this because the program contains T1 M6. If the machine already believes ' +
            'tool 1 is fitted, that line does nothing.',
        },
      ]
    : [
        {
          text: 'Fit the cutter with its collar. Run tool-length calibration from the app’s console or Studio (M491).',
          // #410 review item 1 — the reading itself, on paper. Every Z in the program is this
          // cutter's, and a second cutter's Z0 is worked out from the difference between two of
          // these readings (the swap routine in the Cut section, and the origin step), so the number
          // has to be written down where it is taken.
          record: "the cutter's PRB (mm)",
        },
        {
          text:
            'Do not skip this because the program contains T1 M6. If the machine already believes tool 1 ' +
            'is fitted, that line does nothing.',
        },
      ];

  // ---- 5 · Set the work origin ---------------------------------------------------------------
  // #391 — where the origin IS, then how the operator checks it against the blank actually in the
  // jaws. One section, because they are one task: a corrected origin is corrected on the spot.
  //
  // The second half is HELD (`RunSheetOptions.materialScan`): it prints only when the caller asks for
  // it, and nothing in the app or the bench generator does. The plan is sound; the steps an operator
  // would follow are not yet safe, which is what #391's review of 36f3837 lists — a travel cap with
  // no field behind it, a tip diameter stated as fact, a correction direction that reads back to
  // front, and bisection that covers one direction only. Holding one array entry is the whole change:
  // `materialScan.ts` and its spec are untouched, so the block comes back the moment the fixes land.
  // #475 — a registration the planner refuses is ONE refusal step, and a surface plan printed under
  // it would be a sequence the sheet has just declined to stand behind. Same rule and same pure call
  // as `materialPositionSteps` (which also asks `registrationFor` rather than receive the answer).
  const registrationRefused =
    'refuse' in
    registrationFor(job, options.scan?.tipDiameterMm === undefined ? undefined : { ...PROBE_SPEC, tipDiameter: options.scan.tipDiameterMm });
  const originSteps: RunSheetStep[] = [
    // #432 review R1 — a facing job probes the origin before any cutter is fitted, and the probe's
    // own reading is what every cutter's Z0 below is worked out against. The step exists only for
    // that job: a plain job may set Z0 with either the probe or the cutter (see the Z0 step).
    ...(facingRun
      ? [
          {
            text:
              'Fit the wired probe, not a cutter. Run tool-length calibration from the app’s console ' +
              'or Studio (M491) and record the PROBE’s PRB: this job is skimmed before it is ' +
              'cut, so the probe sets Z0 and its reading is the reference each cutter’s Z0 is ' +
              'worked out against — the facing cutter’s below, and the engraving cutter’s after the ' +
              're-touch.',
            code: 'M491',
            record: 'the probe’s PRB (mm)',
          },
        ]
      : []),
    ...registrationSteps(job, onBoard, options.scan?.tipDiameterMm, facingRun),
    // #475 — Z0 is a spread, not a point: print the surface touches across the cut's extents, the
    // band they must land in, and (when the caller has readings) the measured verdict. Additive:
    // a caller that passes no `surfaceTouchCount`/`surfaceReadings` gets the plan and stop rule.
    ...(registrationRefused
      ? []
      : surfaceSpreadSteps(job, margins.boundaryMargin, options.surfaceTouchCount, options.surfaceReadings, options.surfaceLevel)),
    ...(options.materialScan === true ? materialPositionSteps(job, onBoard, BENCH_ISSUE, machine.toolChange.clearanceZ, options.scan) : []),
  ];

  // ---- 6 · Dry run ---------------------------------------------------------------------------
  // #244 — the frame file replaces the manual "raise Z by 20 mm" offset. Its Z is baked in, so
  // there is nothing for the operator to set (or to forget to clear), and it is a separate file,
  // so it cannot be confused with the job. The 20 mm height itself is `FRAME_Z` above, the figure
  // #207 specified.
  //
  // A null `frameNc` is not hypothetical (#273): a job program the verifier refuses comes back
  // with `nc` and `verify` populated but NO frame (the frame is derived after both gates), and
  // the sheet opens on exactly that — it is only blocked when the job has since changed. Telling
  // the operator here to load a file that was never produced is worse than saying nothing, so the
  // step is replaced rather than augmented.
  const dryRunSteps: RunSheetStep[] =
    generated.frameNc === null
      ? [
          {
            text:
              'There is no frame file for this job: the program above did not pass verification, so ' +
              'the trace was never produced. Do not run this file — clear the errors, regenerate, and ' +
              'the frame comes back with the program.',
            bold: true,
          },
        ]
      : [
          {
            text:
              `Load ${runSheetFrameFileName(job.name)} and run it. The cutter traces the job's outline in ` +
              `the air, ${fmtNum(FRAME_Z)} mm above the work — no Z offset to set. Watch that the trace ` +
              'stays over the blank and clear of the jaws.',
            value: `${fmtNum(FRAME_Z)} mm above the work`,
          },
          {
            text:
              `If the trace is not where the job should land, stop and change the job. ` +
              (job.facing !== undefined
                ? `Otherwise face the top and re-touch Z0 first (the next section), then load ${header.fileName} and cut.`
                : `Otherwise load ${header.fileName} and cut.`),
          },
        ];

  // ---- 7 · Cut -------------------------------------------------------------------------------
  const cutSteps: RunSheetStep[] = [];
  // #673 — an INLAY half opens the cut section with which blank this is and what happens to the
  // pair after both runs. The numbers are `inlayNumbers`'s, never re-derived here.
  cutSteps.push(...inlaySteps(job));
  // #670 — a TEXTURE's pattern follows: the strokes and the numbers that repeat them.
  cutSteps.push(...textureSteps(job));
  // #674 — FLUTES and PRISMS: the ramp's numbers, and what stands on what base.
  cutSteps.push(...fluteSteps(job));
  cutSteps.push(...prismSteps(job));
  // The one-program parameters step, kept by reference: a two-tool job relabels it PROGRAM 1 and
  // prints program 2's beside it (#437 item 8), and doing that by finding it again in the list
  // would be a search over prose.
  let programParams: RunSheetStep | null = null;
  const threadMachining = generated.threadMachining ?? null;
  const threadPlans = generated.threads ?? null;
  const drillFacts = generated.drill ?? null;
  // #675 — a plunge drill cut by a MILLING CUTTER (not a drill bit) has no drill-bit facts, so an
  // item's own peck is stated here with the feeds row's number beside it.
  if (drillFacts === null) {
    const feedsPeck = generated.feeds !== null && generated.feeds.ok ? generated.feeds.params.peck : null;
    cutSteps.push(...drillPeckSteps(job, feedsPeck));
  }
  if (drillFacts !== null && drillFacts.plans.length > 0) {
    // #434 — a DRILL program's Cut section. Its numbers are the drill's own (the settings the
    // planner was handed), not `feedsFor`'s: the bit is not a milling cutter and never resolved a
    // feeds row. `programParams` points at the parameters step so a rest-pass label can still
    // prefix it as it does for the other branches. The step builders are shared with a LATER
    // drill program's own section (#419), so the two cannot word the numbers differently.
    const drill = drillCutSteps(drillFacts, job.cutOverride?.air ?? true);
    cutSteps.push(...drill.steps);
    programParams = drill.params;
  } else if (plan.threads.length > 0) {
    // #445 — a thread job's cut section is the worker's own resolved numbers, said once, then one
    // line per thread and the check. `items` (`plan.engraves`) is empty on a thread job — threads
    // are a sibling list — so the per-item loop below adds nothing here.
    if (threadMachining !== null) {
      const s = threadMachining.settings;
      cutSteps.push({
        text: `Spindle, helical feed and the entry. Vacuum ${(job.cutOverride?.air ?? true) ? 'on' : 'off'}.`,
        value:
          `${s.spindleRpm} RPM · ${fmtNum(s.feed)} mm/min helical feed · ${fmtNum(s.plungeFeed)} mm/min ` +
          `down the pilot · ${threadPlans === null ? 'the radial pass count was not recorded' : `${threadPlans[0]?.passRadii.length ?? 0} radial pass(es) at ${fmtNum(s.radialStepoverMm)} mm inward`}`,
      });
      // The three placeholder keys say so in their own source sentence (`threadSettings`), so no
      // second wording is invented here.
      cutSteps.push({ text: `Where those numbers came from: ${threadMachining.sources.feed}.` });
      // An ERROR cannot reach here (the worker stops first); a CLAMP did happen to a real row and
      // the operator cut the clamped numbers, so the sheet repeats the machine's own sentence.
      for (const d of threadMachining.diagnostics.filter((diag) => diag.severity === 'warning')) {
        cutSteps.push({ text: d.message });
      }
    } else {
      cutSteps.push({
        text: 'The thread program’s parameters were not recorded for this run — use the numbers the job states.',
      });
    }
    // R18 / #460 option (a) — the thread and the cutter are printed on ONE line so a wrong pairing
    // is caught by eye. The cutter's own pitch is not on the wire in phase 2 (the item is the
    // authority, D2), so this pairing is the guard a person has. Revisit as option (b) — a served
    // `pitch` field plus a `thread-wrong-pitch` refusal — when a third thread mill arrives or the
    // first wrong pairing is seen; #460 is closed on that trigger.
    const cutterText =
      tool === null
        ? 'the job’s cutter'
        : `${tool.name}${diameter === null ? ' (cutting diameter not recorded)' : ` (⌀${fmtNum(diameter)} mm cutting)`}`;
    for (const [i, t] of plan.threads.entries()) {
      // The plan and the CAM's plans are built from the same enabled list, in the same order, so a
      // plan's facts are found by index. A missing fact says so rather than guessing a pass count.
      const facts = threadPlans?.[i] ?? null;
      cutSteps.push({
        text:
          `${t.name} — ${cutterText}, ⌀${fmtNum(FASTENERS[t.size].minor)} mm pilot` +
          (facts === null
            ? ', the pass count was not recorded'
            : `, ${facts.passRadii.length} radial pass(es) landing the tooth on the ${t.size} major radius`),
        value: `${fmtNum(t.depth)} mm of thread`,
      });
    }
    cutSteps.push({ text: `Check the thread with a ${plan.threads[0]!.size} screw.` });
  } else if (params !== null) {
    // #405 — A TRACE-ONLY JOB DOES NOT STEP OVER. A trace puts the cutter ON the line: there are
    // no contour-parallel loops, so nothing is ever stepped over, and the `stepOverFraction` a V
    // row has to carry for `CutParams`'s sake is inert (see the PLA V row in `feeds.ts`). Printing
    // a step-over here would hand the operator a number for a cut the program never makes — and
    // for a V bit it is the TIP's fraction of the TIP (0.45 × 0.3 mm), which reads like a real
    // pitch. A job with any region item keeps the full line: those loops DO step over.
    //
    // #535 — A GOAL JOB'S PASSES ARE ITS OWN. Its step-down and step-overs need not be the feeds
    // row's (the operation can state each), so this line keeps the spindle/feed/vacuum facts and
    // the surface steps below print the passes' own numbers.
    const traceOnly =
      items.length === 0 && (job.traces?.some((t) => t.enabled && !t.construction) ?? false);
    const surfaceFacts = generated.surface3d ?? null;
    // #735 — the CAM states each operation's depth passes and the step it took, so a program that
    // runs two step-downs names both (j01: 11 × 0.5 mm and 22 × 0.25 mm) and a bore prints its
    // helix pitch rather than the 3648 chords a helix changes Z on. An older stored result has no
    // tally and keeps the pre-#735 single-step wording from the feeds row.
    const passSteps = generated.cam?.passSteps ?? null;
    const passesText =
      passSteps !== null && passSteps.length > 1
        ? `${generated.cam?.passes ?? 0} depth passes — ` +
          passSteps.map((t) => `${t.passes} × ${fmtNum(t.stepMm)} mm`).join(', ')
        : `${generated.cam?.passes ?? 1} × ${fmtNum(passSteps?.[0]?.stepMm ?? params.stepDown)} mm passes`;
    const step: RunSheetStep =
      surfaceFacts !== null
        ? {
            text: `Spindle, feed and plunge. Vacuum ${params.air ? 'on' : 'off'}.`,
            value:
              `${params.rpm} RPM · ${fmtNum(params.feed)} mm/min feed · ` +
              `${fmtNum(params.plungeFeed)} mm/min plunge`,
          }
        : traceOnly
          ? {
              text: `Spindle, feed and plunge. Vacuum ${params.air ? 'on' : 'off'}.`,
              value:
                `${params.rpm} RPM · ${fmtNum(params.feed)} mm/min feed · ${fmtNum(params.plungeFeed)} mm/min ` +
                'plunge · a single stroke on every line, cut straight to depth — no step-over',
            }
          : {
              text: `Spindle, feed, plunge, passes and step-down. Vacuum ${params.air ? 'on' : 'off'}.`,
              value:
                `${params.rpm} RPM · ${fmtNum(params.feed)} mm/min feed · ${fmtNum(params.plungeFeed)} mm/min ` +
                `plunge · ${passesText} · ` +
                `${fmtNum(params.stepOver)} mm step-over`,
            };
    cutSteps.push(step);
    programParams = step;
    // #668 — a bore program states its helix pitch beside the parameters it was cut with: the
    // pitch is the number the operator watches on the first hole, and both its sources travel in
    // the fact, so this line can say which one is binding without re-reading a setting.
    if (generated.bore != null) cutSteps.push(...boreSteps(generated.bore));
    // #669 — the bevels this program cuts, with the depth derived from each width and the order
    // against the cut that leaves the edge.
    if (generated.chamfer != null) cutSteps.push(...chamferSteps(generated.chamfer));
    if (surfaceFacts !== null) cutSteps.push(...surfaceSteps(surfaceFacts));
    // #487 — what the ordering did, in the operator's terms: air travel against cutting travel,
    // and the same program under the order this CAM used before it. "Optimised" that cannot be
    // checked on paper is a feeling; the two numbers are the check. A job whose CAM carried no
    // loops (a trace-only program) has nothing to report and gets no step.
    const cam = generated.cam;
    if (
      cam?.ordering === 'proximity' &&
      cam.rapidMm !== undefined &&
      cam.cutMm !== undefined &&
      cam.baselineRapidMm !== undefined &&
      cam.cutMm > 0
    ) {
      const ratio = (rapid: number): string => `${fmtNum(rapid / cam.cutMm!)} : 1`;
      // Only the rough program IS program 1; a rest pair in a later setup does not rename this
      // section's program.
      const whose =
        options.restPass === undefined || (roughNumber !== null && roughNumber !== 1)
          ? ''
          : `Program ${roughNumber ?? 1}, ${options.restPass.rough.nc} — `;
      cutSteps.push({
        text:
          `${whose}the toolpath is ordered by proximity: the cutter finishes each contour to its ` +
          'depth before entering the next, takes each entry at the point nearest where it just ' +
          'was, and cuts the pocket rings inside-out so the wall is the last thing it touches. ' +
          `The file spends ${fmtNum(cam.rapidMm)} mm in the air against ${fmtNum(cam.cutMm)} mm ` +
          `cutting (${ratio(cam.rapidMm)}). The previous ordering spent ` +
          `${fmtNum(cam.baselineRapidMm)} mm (${ratio(cam.baselineRapidMm)}) on the same cut.`,
        value: `${fmtNum(cam.rapidMm)} mm rapid · ${fmtNum(cam.cutMm)} mm cut`,
      });
    }
  } else {
    cutSteps.push({ text: 'Cutting parameters were not resolved for this job.' });
  }
  // #437 item 8 — a two-tool job has a SECOND program, and its numbers are its own: a different
  // cutter in the same material, with a different feed and its own pass count. Printing one
  // parameters line for the pair reads as the whole job's and is wrong for half of it. Everything
  // here is gated on `restPass`, so a one-program sheet is byte-identical to the sheet before it.
  if (options.restPass !== undefined) {
    const { rough, rest } = options.restPass;
    // #419 — program 1's parameters are labelled with its REAL position in the run. Only the rough
    // program IS program 1; when the rest pair belongs to a later setup, the top-level parameters
    // here are still the first program's, so they keep the unlabelled/Program 1 words. The pair's
    // second program gets its own section below when the program list places it; without a list the
    // old single-document placement (its feeds line here) is kept byte-for-byte.
    if (programParams !== null && (roughNumber === null || roughNumber === 1)) {
      programParams.text = `Program ${roughNumber ?? 1}, ${rough.nc} — ${programParams.text}`;
    }
    if (!restInOwnSection) cutSteps.push(restProgramParamsStep(rest, restNumber ?? 2));
  }
  // #250 — the allowance is a shop number with a source, and it decides what the operator should
  // see after the roughing cut: stock standing on every wall and on the floor. The mode says whose
  // file finishes it, because a rest pair puts the two halves in two programs (#472).
  const finishFacts = generated.finish ?? null;
  if (finishFacts !== null) cutSteps.push(finishAllowanceStep(finishFacts));
  for (const item of items) {
    // #231 item 3 — say which cut sits over a void, and the depth the material there allows,
    // so the item name no longer has to smuggle the distinction onto the sheet.
    const over = keepOutOver(job, itemBox.get(item.id), diagram.keepOuts, margins.boundaryMargin);
    const note = over
      ? ` — over "${over.name}", only ${fmtNum(over.solidThickness)} mm of material` +
        (item.depth > keepOutLimit(job, over.solidThickness, margins.boundaryMargin)
          ? ` (DEEPER than the ${fmtNum(keepOutLimit(job, over.solidThickness, margins.boundaryMargin))} mm the void allows)`
          : ` (deepest cut there ${fmtNum(keepOutLimit(job, over.solidThickness, margins.boundaryMargin))} mm)`)
      : '';
    if (finishFacts !== null && finishFacts.itemIds.includes(item.id)) {
      // #250 — this item is cut in two removals. The roughing row says what stands after it (the
      // allowance on walls and floor); the finishing row says the full depth. A rest pair's first
      // program writes only the first row and its second program only the second, so the operator
      // reads the same two removals across the two files.
      const leave = finishFacts.stockToLeaveMm.value;
      if (finishFacts.mode !== 'finish-only') {
        cutSteps.push({
          text:
            `${item.name}${note}${depthSourceWords(job, item, margins.boundaryMargin, measure)} — ` +
            `roughing pass: leaves ${fmtNum(leave)} mm of stock on the walls and the floor.`,
          value: `rough to ${fmtNum(item.depth - leave)} mm deep · ${fmtNum(leave)} mm stock left`,
        });
      }
      if (finishFacts.mode !== 'rough-only') {
        cutSteps.push({
          text:
            `${item.name}${note}${depthSourceWords(job, item, margins.boundaryMargin, measure)} — ` +
            `finishing pass: full depth along the walls and the floor, ${fmtNum(leave)} mm below the ` +
            'roughing cut.',
          value: `${fmtNum(item.depth)} mm deep · full depth`,
        });
      }
      continue;
    }
    if (vCarveJob && cone !== null) {
      // #221 — the per-item V facts are the CAM's own numbers: the plane from `vCarvePlane`, the
      // pitch from `vCarveRowStepover` at the fraction the feeds row's step-over states (the same
      // fraction the `vcarve-stepover-clamped` finding reads). The design is correct at the colour
      // plane, so the floor inset and the surface outset are what the operator should expect to see
      // in the blank; the effective pitch is what the program actually runs.
      // #665 — a VARIABLE-depth item is the medial-axis carve: the depth follows the design's
      // width, cut as a ladder of level sets, and the floor's core is a flat end mill pocket's —
      // the run's own core program (#677). Its step replaces the plane statement, which describes
      // a constant floor this item does not have.
      if (item.variableDepth === true) {
        const levelPitch =
          params === null || !(cone.tanHalf > 0)
            ? null
            : Math.min(params.stepDown, params.stepOver / cone.tanHalf);
        const levels = levelPitch !== null && levelPitch > 0 ? vCarveLevels(cone, item.depth, levelPitch) : null;
        // #677 — the flat bottom is the run's own CORE CLEARANCE program when the setup names a
        // flat end mill after the V (the run's program list carries the facts); otherwise the core
        // stands and the step says what to add.
        const clearance = runPrograms
          .flatMap((program) =>
            program.core == null ? [] : program.core.cores.map((core) => ({ core, program })),
          )
          .find((entry) => entry.core.of === item.id);
        const clearanceNumber =
          clearance === undefined ? null : programNumberIn(runPrograms, clearance.program.nc);
        cutSteps.push({
          text:
            `${item.name}${note}${depthSourceWords(job, item, margins.boundaryMargin, measure)} — ` +
            'VARIABLE depth: the V follows the design’s width, its flank on the edge, from the ' +
            'outside in' +
            (levels === null
              ? ''
              : ` — ${levels.length} level${levels.length === 1 ? '' : 's'} at ${fmtNum(levelPitch as number)} mm`) +
            `, down to ${fmtNum(item.depth)} mm at its centre. Where that cap cannot reach, the ` +
            'middle stands as a core' +
            (clearance === undefined
              ? '; add a flat end mill to the setup and that cutter pockets it at that depth in its own program.'
              : `, and ${cutterWords(clearance.program.toolKey)} pockets it flat at that depth in its own program` +
                `${clearanceNumber === null ? '' : `, program ${clearanceNumber}`} — ` +
                `${fmtNum(clearance.core.areaMm2)} mm² of floor at the cap.`),
          value: `${fmtNum(item.depth)} mm at the centre${levels === null ? '' : ` · ${levels.length} levels`}`,
        });
        continue;
      }
      const plane = vCarvePlane(cone, item.depth, film);
      // #740 — the row's fraction is its step-over over the diameter it was resolved on (a
      // chamfer's base, an engraver's tip), read back by the same function the CAM and the finding
      // use; dividing by the tip width refused a chamfer's flat-row number as ratio 14.2875.
      const stepover =
        tool === null || params === null
          ? null
          : vCarveRowStepover(tool, params.stepOver, plane.planeRadius, cone);
      // The clamp sentence is the finding's own, not a softer paraphrase: the sheet, the panel and
      // §8 must agree that this is a note about a correct cut, not a fault. §8 carries the full
      // finding verbatim; this line states the same fact beside the item's numbers.
      const pitch =
        stepover === null
          ? 'the pass pitch was not resolved for this job'
          : `pass pitch ${fmtNum(stepover.effective)} mm at the colour plane, from the requested ` +
            `${fmtNum(stepover.requested)} mm` +
            (stepover.clamped
              ? ` — clamped to the cutter’s ${fmtNum(cone.tipRadius)} mm tip radius: a wider pitch ` +
                'would leave a ridge of the top colour down strokes narrower than two passes apart'
              : '');
      cutSteps.push({
        text:
          `${item.name}${note}${depthSourceWords(job, item, margins.boundaryMargin, measure)} — ` +
          (film === null
            ? 'with no film the colour plane is the floor, and the cone reaches '
            : 'at the colour plane the cone reaches ') +
          `${fmtNum(plane.planeRadius)} mm radius: the floor is ${fmtNum(plane.floorInset)} mm ` +
          `inside the design each side, the surface ${fmtNum(plane.surfaceOutset)} mm outside it; ` +
          `${pitch}.`,
        value:
          `${fmtNum(item.depth)} mm deep · plane radius ${fmtNum(plane.planeRadius)} mm · ` +
          `floor inset ${fmtNum(plane.floorInset)} mm · surface outset ${fmtNum(plane.surfaceOutset)} mm`,
      });
    } else {
      cutSteps.push({
        text: `${item.name}${note}${depthSourceWords(job, item, margins.boundaryMargin, measure)}`,
        value: `${fmtNum(item.depth)} mm deep`,
      });
    }
  }
  cutSteps.push({
    text: 'Stay at the machine. Stop it if the sound changes, the blank moves, or the cutter loads up.',
  });
  // #218 — program 1's through cut-outs and their holding tabs. Two distinct steps from the
  // helper: what the file does below the blank, then the tab removal done after it ends.
  cutSteps.push(...throughCutSteps(generated.through));
  // #410 — the second program's routine joins THIS section, not the narrative one: it is a sequence
  // of things done at the machine, in order, after the first file has run to its end.
  if (options.restPass !== undefined && !restInOwnSection) {
    cutSteps.push(...restSwapSteps(options.restPass));
  }
  // #737 — the saw comes after the run's last cut, never before it: the neck is only cut in that
  // last program, so the part is still on it until the file ends. Program 1's own fact (the
  // single-program case); a later program's neck is printed in its own section below.
  cutSteps.push(...neckSawSteps(generated.neck));

  // ---- per-program Cut sections (#419) ------------------------------------------------------
  // Program 1 is the `cut` section above, fed from the top-level result. Every later ENGRAVING
  // program gets its own section here, in cut order, fed from its own facts: a drill program's
  // `drill` block, a rest program's measured pair, or — for any other program — its file, CAM
  // summary and frame. The run is the files played in order, so the sections are the physical
  // order too: after program 1 finishes, the operator meets program 2's swap (or bit) here.
  const programSections: { id: string; title: string; steps: RunSheetStep[] }[] = [];
  if (hasProgramList) {
    for (let i = 1; i < runPrograms.length; i++) {
      const program = runPrograms[i]!;
      const number = i + 1;
      const rest =
        options.restPass !== undefined && restInOwnSection && program.nc === options.restPass.rest.nc
          ? options.restPass
          : null;
      const restRough =
        options.restPass !== undefined && restInOwnSection && program.nc === options.restPass.rough.nc
          ? options.restPass
          : null;
      if (rest !== null && restLabels !== undefined) {
        programSections.push({
          id: `cut-${number}`,
          title: `Cut, program ${number} — ${rest.rest.key} (rest)`,
          steps: restProgramSection(program, rest, restLabels),
        });
      } else if (restRough !== null) {
        programSections.push({
          id: `cut-${number}`,
          title: `Cut, program ${number} — ${restRough.rough.key} (first cut)`,
          steps: restRoughProgramSection(program, restRough, number),
        });
      } else if (program.drill !== undefined && program.drill !== null && program.drill.plans.length > 0) {
        programSections.push({
          id: `cut-${number}`,
          title: `Cut, program ${number} — ${program.drill.toolName ?? 'the drill bit'}`,
          steps: drillProgramSectionSteps(program, program.drill, number, job.cutOverride?.air ?? true),
        });
      } else {
        programSections.push({
          id: `cut-${number}`,
          title: `Cut, program ${number} — ${program.toolKey}`,
          steps: engraveProgramSectionSteps(program, number),
        });
      }
    }
  }

  // ---- 8 · Warnings carried from the app -----------------------------------------------------
  const warnings: RunSheetStep[] = [];
  const seen = new Set<string>();
  /**
   * Where the `vise-default` warning landed, so §8 can open with it in bold. Recorded by CODE as
   * the warning is pushed, never by matching its words: the message is prose that changes when the
   * facts do (it stopped saying "unmeasured defaults" on 2026-10-15), and a `findIndex` over prose
   * fails SILENTLY — a wording edit would leave the section un-opened with nothing to show for it.
   */
  let viseWarningAt = -1;
  const pushWarning = (code: string, message: string): void => {
    const key = `${code}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (code === 'vise-default' && viseWarningAt < 0) viseWarningAt = warnings.length;
    warnings.push({ text: message });
  };
  for (const f of generated.findings) {
    if (f.severity === 'warning') pushWarning(f.code, f.message);
  }
  if (generated.verify) {
    for (const f of generated.verify.findings) {
      if (f.severity === 'warning') pushWarning(f.code, f.message);
    }
  }
  if (sim) {
    // #744 — EVERY PROGRAM'S SWEEP. When the caller hands the run's programs, each one's own
    // diagnostics are carried under its label (the app's run store and the command line both build
    // the flat list with the same `attributedDiagnostics`, so the duplicate check keeps one copy).
    // A flat `diagnostics` list is still read for what no program owns — the panel's crash (#490).
    const expectedPrograms = generated.programs?.length ?? sim.programs?.length ?? 0;
    const diagnostics =
      sim.programs === undefined
        ? sim.diagnostics
        : [...attributedDiagnostics(sim.programs, expectedPrograms > 1), ...sim.diagnostics];
    for (const d of diagnostics) {
      // #490 — a panel crash is an `error`, but section 8 is where the sheet says what the app
      // could not do, so it is carried beside the warnings rather than dropped.
      if (d.severity === 'warning' || d.code === PANEL_RENDER_ERROR_CODE) pushWarning(d.code, d.message);
    }
    // #243 — the coverage sentence, from the same builder the Simulate panel prints: which
    // geometry the sweep was given and which it never saw, and whether this run swept at all.
    // It appears whenever a simulation is part of the run (a `sim` is passed), never when the
    // caller says there was none.
    for (const sentence of coverageDisclaimer(coverageFor(job, generated, sim))) pushWarning('coverage', sentence);
  }
  // "If the vise is the shipped default, this section opens with that, in bold."
  if (isViseDefault(vise) && viseWarningAt >= 0) {
    const [viseWarning] = warnings.splice(viseWarningAt, 1);
    viseWarning!.bold = true;
    warnings.unshift(viseWarning!);
  }
  if (warnings.length === 0) warnings.push({ text: 'No warnings were raised.' });

  // ---- 9 · Record afterwards -----------------------------------------------------------------
  // #277 — the same list the run record file's `depths` array is built from, so the blanks printed
  // here and the fields the readback answers are one list.
  const recordSteps: RunSheetStep[] = recordDepths(plan).map((item) => ({
    text: `Measured floor depth — ${item.name}`,
    record: 'measured depth (mm)',
  }));
  recordSteps.push(
    { text: 'Is the text legible?', record: 'yes / no' },
    { text: 'Surface finish', record: 'clean / fuzzy / burnt' },
    { text: 'Anything that went wrong', record: 'notes' },
  );

  // #410 — the reachability report, when the caller measured one, sits directly after §1: that
  // section names the cutter, and this one is why it is that cutter. Section NUMBERS are worked out
  // from position below, so a sheet that gains or loses a section cannot be mis-numbered — and a
  // sheet without this one is byte-identical to the sheet that existed before the section did.
  const reachSteps =
    options.reachability === undefined
      ? null
      : reachabilitySteps(
          options.reachability,
          job.toolKey,
          options.unreachable ?? untouchedByAll(options.reachability),
        );

  const facingSection =
    job.facing === undefined
      ? []
      : [
          {
            id: 'facing',
            title: 'Face the stock top',
            steps: facingSteps(job, generated, runSheetFaceFileName(job.name)),
          },
        ];

  const sections: { id: string; title: string; steps: RunSheetStep[] }[] = [
    { id: 'need', title: 'What you need', steps: needSteps },
    ...(reachSteps ? [{ id: 'reach', title: 'What each cutter reaches', steps: reachSteps }] : []),
    ...(options.restPass
      ? [{ id: 'rest', title: 'Two tools, one blank', steps: restPassSteps(options.restPass) }]
      : []),
    { id: 'mount', title: 'Mount the vise', steps: mountSteps },
    { id: 'load', title: 'Load the blank', steps: loadSteps },
    ...(options.found
      ? [{ id: 'found', title: 'Found position', steps: foundSteps(options.found) }]
      : []),
    // #432 review R1 — a facing job probes the origin FIRST, with the probe fitted, and only then
    // puts the facing cutter in: the section order is the physical order, and the two sections are
    // the run's first two acts at the machine either way.
    ...(facingRun
      ? [
          { id: 'origin', title: 'Set the work origin with the probe', steps: originSteps },
          { id: 'cutter', title: 'Fit the facing cutter and measure its length', steps: cutterSteps },
        ]
      : [
          { id: 'cutter', title: 'Fit the cutter and measure its length', steps: cutterSteps },
          { id: 'origin', title: 'Set the work origin', steps: originSteps },
        ]),
    { id: 'dry-run', title: 'Dry run', steps: dryRunSteps },
    // #432 slice 3 — the skim sits between the air run and the cut: the trace is checked against
    // the origin on the blank as clamped, the skim removes the finish error, the re-touch that ends
    // these steps moves Z0 onto the faced surface, and the Cut section is the first to assume it.
    ...facingSection,
    { id: 'cut', title: 'Cut', steps: cutSteps },
    // #419 — each later program's own Cut section, in run order. Program 1 is `cut` above.
    ...programSections,
    { id: 'warnings', title: 'Warnings carried from the app', steps: warnings },
    { id: 'record', title: 'Record afterwards', steps: recordSteps },
  ].map((section, i) => ({ ...section, title: `${i + 1} · ${section.title}` }));

  // #489 — the cutter as the paper should show it: the job tool's own profile, monochrome, with a
  // V-bit's groove at the deepest cut this job makes. The model is the app's, so the drawing in the
  // rail and the drawing at the bench cannot disagree. No tool named = no drawing to make.
  const deepestCut = items.reduce<number | null>(
    (deepest, item) => (deepest === null || item.depth > deepest ? item.depth : deepest),
    null,
  );
  const toolProfileSvg =
    tool === null ? undefined : cutterProfileSvg(tool, { size: 'print', grooveDepth: deepestCut });
  const toolProfileLegend = tool === null ? undefined : (cutterLegend(tool) ?? undefined);

  return {
    header,
    sections,
    diagram,
    // Absent rather than null for a job without sacrificial material, so its sheet — and the
    // snapshot of it — is byte-identical to before this field existed.
    ...(stackUp ? { stackUp } : null),
    ...(toolProfileSvg === undefined ? null : { toolProfileSvg }),
    ...(toolProfileLegend === undefined ? null : { toolProfileLegend }),
  };
}

// ---------------------------------------------------------------------------------------------
// The origin diagram, as SVG
// ---------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Diagram margin around the drawn geometry, mm. */
const DIAGRAM_PAD = 8;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A top view of the stock with the jaws either side, the origin at the front-left corner, X and
 * Y arrows, and every item's bounding box with its depth written on it. Pure string output, so
 * the whole sheet is testable without a DOM.
 *
 * The job frame has +Y AWAY from the operator; SVG y runs DOWN the page, so the viewBox is
 * anchored at `-ymax` and every job-frame point maps to `(x, -y)` — that is why the stock's
 * front edge (job y = 0) sits at the bottom of the drawing.
 */
export function runSheetDiagramSvg(diagram: RunSheetDiagram): string {
  const { length, width } = diagram.stock;
  const xs: number[] = [0, length];
  const ys: number[] = [0, width];
  for (const jaw of diagram.jaws) {
    xs.push(jaw.min[0], jaw.max[0]);
    ys.push(jaw.min[1], jaw.max[1]);
  }
  for (const item of diagram.items) {
    xs.push(item.min[0], item.max[0]);
    ys.push(item.min[1], item.max[1]);
  }
  for (const ko of diagram.keepOuts) {
    xs.push(ko.min[0], ko.max[0]);
    ys.push(ko.min[1], ko.max[1]);
  }
  const xmin = Math.min(...xs) - DIAGRAM_PAD;
  const xmax = Math.max(...xs) + DIAGRAM_PAD;
  const ymin = Math.min(...ys) - DIAGRAM_PAD;
  const ymax = Math.max(...ys) + DIAGRAM_PAD;

  const rect = (min: [number, number], max: [number, number], cls: string, extra: string): string => {
    const x = min[0];
    const y = -max[1]; // flip job-frame Y
    const w = max[0] - min[0];
    const h = max[1] - min[1];
    return `<rect ${extra} class="${cls}" x="${x}" y="${y}" width="${w}" height="${h}" />`;
  };

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="${SVG_NS}" viewBox="${xmin} ${-ymax} ${xmax - xmin} ${ymax - ymin}" ` +
      `class="run-sheet-svg" role="img" aria-label="Top view of the stock, the vise jaws and the work origin">`,
  );
  parts.push(
    `<defs><marker id="run-sheet-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">` +
      `<path d="M0,0 L6,3 L0,6 z" class="run-sheet-arrowhead" /></marker></defs>`,
  );

  // The stock outline.
  parts.push(rect([0, 0], [length, width], 'run-sheet-stock', 'data-stock="true"'));
  parts.push(
    `<text class="run-sheet-label" x="${length / 2}" y="${-width - 2}" text-anchor="middle">` +
      `${fmtNum(length)} × ${fmtNum(width)} mm stock</text>`,
  );

  // The jaws.
  for (const jaw of diagram.jaws) {
    parts.push(rect(jaw.min, jaw.max, 'run-sheet-jaw', `data-jaw-id="${escapeXml(jaw.id)}"`));
    parts.push(
      `<text class="run-sheet-label" x="${(jaw.min[0] + jaw.max[0]) / 2}" y="${-((jaw.min[1] + jaw.max[1]) / 2)}" ` +
        `text-anchor="middle">${escapeXml(jaw.label)}</text>`,
    );
  }

  // #231 — the under-surface voids, drawn DASHED (they are missing material, not cuts) and
  // BEFORE the items so an item's box stays legible over the void. The presentation is inline
  // because the sheet's own CSS lives in the panel (owned by another slot) and this SVG must
  // render correctly from `runSheet.ts` alone.
  for (const ko of diagram.keepOuts) {
    parts.push(
      rect(
        ko.min,
        ko.max,
        'run-sheet-keepout',
        `data-keepout-id="${escapeXml(ko.id)}" fill="none" stroke="#a00" stroke-width="0.5" stroke-dasharray="2 1.2"`,
      ),
    );
    const cx = (ko.min[0] + ko.max[0]) / 2;
    const cy = -((ko.min[1] + ko.max[1]) / 2);
    parts.push(
      `<text class="run-sheet-keepout-label" x="${cx}" y="${cy}" text-anchor="middle" font-size="3" fill="#a00">` +
        `${escapeXml(ko.name)} · ${fmtNum(ko.solidThickness)} mm over</text>`,
    );
  }

  // The origin and the X / Y arrows.
  const [ox, oy] = diagram.origin;
  parts.push(`<circle class="run-sheet-origin" cx="${ox}" cy="${-oy}" r="1.2" />`);
  parts.push(
    `<text class="run-sheet-origin-label" x="${ox + 1.6}" y="${-oy + 3.2}">X0 Y0 (front-left, top face)</text>`,
  );
  const arrowX = Math.min(14, length);
  const arrowY = Math.min(14, width);
  parts.push(
    `<line class="run-sheet-axis" x1="${ox}" y1="${-oy}" x2="${ox + arrowX}" y2="${-oy}" marker-end="url(#run-sheet-arrow)" />`,
  );
  parts.push(`<text class="run-sheet-axis-label" x="${ox + arrowX + 1}" y="${-oy + 1.2}">X</text>`);
  parts.push(
    `<line class="run-sheet-axis" x1="${ox}" y1="${-oy}" x2="${ox}" y2="${-oy - arrowY}" marker-end="url(#run-sheet-arrow)" />`,
  );
  parts.push(`<text class="run-sheet-axis-label" x="${ox - 1}" y="${-oy - arrowY - 1}">Y</text>`);

  // Every item's bounding box, with its depth written on it.
  for (const item of diagram.items) {
    const x = item.min[0];
    const y = -item.max[1];
    const w = item.max[0] - item.min[0];
    const h = item.max[1] - item.min[1];
    parts.push(
      `<rect data-item-id="${escapeXml(item.id)}" class="run-sheet-item" x="${x}" y="${y}" width="${w}" height="${h}">` +
        `<title>${escapeXml(item.name)}</title></rect>`,
    );
    const cx = (item.min[0] + item.max[0]) / 2;
    const cy = -((item.min[1] + item.max[1]) / 2);
    parts.push(
      `<text class="run-sheet-item-depth" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central">` +
        `${fmtNum(item.depth)} mm</text>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------
// The stack-up elevation, as SVG (#213 §6)
// ---------------------------------------------------------------------------------------------

/** Margin around the stack-up, mm. */
const STACKUP_PAD = 6;

/**
 * The side view of the setup, so the operator can see the assembly they are about to clamp: the
 * jaws at their shifted faces, the board under the part, the strips between the jaw and the part,
 * each with its own thickness, and the Z = 0 datum on the PART's top face.
 *
 * Pure string output, like the origin diagram, so the whole sheet is testable without a DOM. X is
 * the job's X (left to right); the viewBox anchors at `-zmax` because SVG y runs down and the job's
 * Z runs up, so the part's top face (Z = 0) is at the TOP of the drawing.
 *
 * A box taller than it is wide (a jaw, a narrow strip) gets its label rotated 90°, or the text
 * would be wider than the box it names.
 */
export function runSheetStackUpSvg(stackUp: RunSheetStackUp): string {
  const xs: number[] = [];
  const zs: number[] = [stackUp.datumZ];
  for (const b of stackUp.boxes) {
    xs.push(b.minX, b.maxX);
    zs.push(b.minZ, b.maxZ);
  }
  const xmin = Math.min(...xs) - STACKUP_PAD;
  const xmax = Math.max(...xs) + STACKUP_PAD;
  const zmin = Math.min(...zs) - STACKUP_PAD;
  const zmax = Math.max(...zs) + STACKUP_PAD;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="${SVG_NS}" viewBox="${xmin} ${-zmax} ${xmax - xmin} ${zmax - zmin}" ` +
      `class="run-sheet-svg run-sheet-stackup" role="img" ` +
      `aria-label="Side view of the setup: the vise jaws, the sacrificial board and strips, and the part">`,
  );

  for (const b of stackUp.boxes) {
    const w = b.maxX - b.minX;
    const h = b.maxZ - b.minZ;
    const cls = b.sacrificial
      ? 'run-sheet-stackup-sacrificial'
      : b.id.startsWith('vise-')
        ? 'run-sheet-jaw'
        : 'run-sheet-stackup-part';
    const title = b.dimension === null ? b.label : `${b.label} — ${b.dimension}`;
    parts.push(
      `<rect data-stackup-id="${escapeXml(b.id)}" class="${cls}" x="${b.minX}" y="${-b.maxZ}" ` +
        `width="${w}" height="${h}"><title>${escapeXml(title)}</title></rect>`,
    );

    const cx = (b.minX + b.maxX) / 2;
    const cy = -((b.minZ + b.maxZ) / 2);
    const text = b.dimension === null ? b.label : `${b.label} · ${b.dimension}`;
    // Rotate when the box is taller than wide, so the label fits inside what it names.
    const transform = h > w ? ` transform="rotate(-90 ${cx} ${cy})"` : '';
    parts.push(
      `<text class="run-sheet-stackup-label" x="${cx}" y="${cy}" text-anchor="middle" ` +
        `dominant-baseline="central"${transform}>${escapeXml(text)}</text>`,
    );
  }

  // The datum: Z0 on the part's top face. Drawn last so it reads over every box.
  parts.push(
    `<line class="run-sheet-stackup-datum" x1="${xmin}" y1="${-stackUp.datumZ}" ` +
      `x2="${xmax}" y2="${-stackUp.datumZ}" />`,
  );
  parts.push(
    `<text class="run-sheet-stackup-datum-label" x="${xmin + 1}" y="${-stackUp.datumZ - 1.2}">` +
      `Z0 — the part's top face</text>`,
  );

  parts.push('</svg>');
  return parts.join('');
}

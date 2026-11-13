/**
 * The engrave RUN state (#206): one Generate press takes the job through
 * generate → verify → simulate → oracle, and this store owns the result, the phase and the
 * staleness rule.
 *
 * The rule the whole issue turns on: a result is only savable while it still describes the job
 * on screen. Any edit to the job after a Generate marks the run STALE (the subscription at the
 * bottom), and a stale run cannot be saved — the user regenerates. There is no "save anyway".
 *
 * It holds no wasm handle and no mesh: `engraveGenerate` returns plain data and the oracle a
 * plain report. The sim program itself lives in `simStore` (this store only drives its load and
 * reads its diagnostics); the client is reached by a dynamic `import()` behind `featureSim` (#343),
 * exactly as `engravePreviewStore.ts` does, so a build with the flag off contains neither the sim
 * client nor its worker.
 */

import { featureSim } from '@/platform/features';
import { cancelActiveHouseRun, houseEngraveGenerate, houseGenerationAvailable } from '@/platform/houseGenerate';
import { create } from 'zustand';
import type { EngraveJob, EngraveMargins, EngraveTargetObject } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveGenerated, EngraveProgress, EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import {
  noteFinding,
  noteProgress as noteFlightProgress,
  noteStage,
  noteWorkEnd,
  noteWorkStart,
  recordCrumb,
  type WorkFacts,
} from '@/platform/flightRecorder';
import type { OraclePredicted, OracleReport } from '@/engine/cnc/engrave/oracle';
import type { DesignCheckItem } from '@/engine/cnc/engrave/designCheck';
import { rotaryMapOf } from '@/engine/cnc/rotary/wrap';
import { goalCheckForProgram, type SimGoalCheck } from '@/engine/cnc/engrave/goalCheckInput';
import { pureGoalObject } from '@/engine/cnc/engrave/jobKind';
import { goalEdgeBreakOptions } from '@/engine/cnc/engrave/edgeBreak';
import { goalPassCoverage, liveShopDefaults, readDefault } from '@/platform/defaultsClient';
import type { ProgramOracle } from './engraveRunGate';
import type { SimDiagnostic } from '@/workers/sim/session';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { SimStatus } from './simStore';
import { jobMountObstacles, jobSetups, jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { recheckStoredPrograms } from '@/engine/cnc/engrave/restoredRun';
import { appendRunLog, type RunLogEntry } from '@/engine/cnc/engrave/runLog';
import type { MountObstacles } from '@/engine/cnc/mounts/bracket';
import { carrySeedsForSetup, carriedMaps, orient, type CarrySetup } from '@/engine/cnc/setups';
import type { CarriedField, FlatField } from '@/workers/geometry/carriedField';
import { bedUnderFacts, machineForJob } from '@/platform/bedProfiles';
import { useLocationStore } from './locationStore';
import { isVShape } from '@/engine/cnc/vProfile';import { feedCatalogueRows, resolvedFeedsTable } from '@/engine/cnc/feeds';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { engraveShopOpts } from '@/engine/cnc/engrave/feeds';
import {
  combineCopperSides,
  pcbCopperTopologyInputs,
  type CopperSideReport,
  type PcbCopperTopologyInput,
} from '@/engine/cnc/engrave/pcbTopology';
import { jobMachine } from '@/engine/cnc/calibration';
import { getTools, benchCutterFor } from '@/engine/cnc/toolRegistry';
import { dedupeCutterEntries } from '@/engine/cnc/toolLibrary';
import type { PlanTradeoff } from '@/engine/cnc/cam/model/tradeoff';
import type { PlanOutcome } from '@/engine/cnc/cam/model/plan';
import { inventoryConditions } from '@/engine/cnc/toolCondition';
import type { MachineCalibration } from '@/engine/cnc';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { jobFingerprint } from '@/engine/cnc/engrave/package';
import {
  catalogueKey,
  changedInputs,
  cuttersKey,
  feedsKey,
  machineKey,
  marginsKey,
  runInputs,
  RUN_INPUT_ORDER,
  shopKey,
  surfaceKey,
  type EngraveInputKey,
  type EngraveRunInputs,
} from '@/engine/cnc/engrave/runInputs';
import type { SurfacePostFit } from '@/engine/cnc/engrave/surfaceSpread';
import { useSettingsStore } from './settingsStore';
import { useEngraveJobStore } from './engraveJobStore';
import { useEngravePreviewStore } from './engravePreviewStore';
import { useSimStore } from './simStore';
import { shopDefault, useShopDefaultsStore } from './shopDefaultsStore';
import { useFeedTableStore } from './feedTableStore';
import { useToolRegistryStore } from './toolRegistryStore';
import { useEngraveRegistrationStore } from './engraveRegistrationStore';
import type { EngraveRunPhase } from './engraveRunGate';
import {
  attributedDiagnostics,
  programLabel,
  refusalSummary,
  sweepPrograms,
  sweepSummary,
  type ProgramSweepFailure,
  type ProgramSweepOutcome,
  type ProgramSweepSummary,
  type SweepProgram,
} from '@/engine/cnc/engrave/programSweep';
import { simErrors } from '@/engine/cnc/simGate';

/**
 * The gates on the run's result, and the shape they read (#395), from their own module — re-exported
 * HERE so every existing import site (`EngravePanel`, the QA harness, the specs) keeps working.
 *
 * They are not in this file because this file cannot be loaded outside a browser: the
 * `platform/features` import below reads vite `define`s, so a node script that imports this module
 * for `uploadBlocker` dies with `ReferenceError: __FEATURE_SIM__ is not defined` — which is how
 * `scripts/machine-upload-check.ts` ended up re-stating the rule, weakly, for itself. One
 * implementation, one statement of the rule, two ways to reach it.
 */
export {
  ACKNOWLEDGE_CODES,
  requiredAckCodes,
  runErrorCodes,
  saveBlocker,
  firstRunError,
  gateViewFor,
  withPeriod,
  uploadBlocker,
  releaseBlocker,
  oracleSentence,
  surfaceCheckSentence,
  surfaceGridWords,
  verifySimulateSentences,
} from './engraveRunGate';
export type { EngraveRunPhase, EngraveRunView } from './engraveRunGate';

/** #1151 — the ideal comparison's call shape, whether it runs on the shared or its own worker. */
export type PlanIdealCall = (
  job: EngraveJob,
  goal: EngraveTargetObject,
  tool: Tool,
  shop?: EngraveShopOpts,
  catalogueTools?: readonly Tool[],
  /** #1049 — Generate's owned outcome, passed only while the run is not stale. */
  ownedOutcome?: PlanOutcome | null,
  /** #1047 — the Makera rows from this thread's snapshot: the worker realm's own copy is empty. */
  catalogue?: readonly FeedCatalogueRow[],
) => Promise<{ tradeoff: PlanTradeoff | null; owned: PlanOutcome | null; ideal: PlanOutcome | null }>;

export type EngraveRunClient = {
  engraveGenerate: (
    job: EngraveJob,
    tool: Tool | null,
    catalogue: readonly FeedCatalogueRow[],
    calibration: MachineCalibration | null,
    margins: EngraveMargins,
    /** The engrave pipeline's shop defaults (#451) — see `run` for why they are read here. */
    shop?: EngraveShopOpts,
    /** #785 — stage progress for the panel and the flight recorder. */
    onProgress?: (progress: EngraveProgress) => void,
    /**
     * #961 — the ideal plan's candidate set, read on this side (the worker cannot see the tool
     * library). Absent means no ideal: `planIdeal` stays null and only the owned plan is run.
     */
    catalogueTools?: readonly Tool[],
    /**
     * #1151 (#1134(c)'s ruling) — owned plan first: the result returns as soon as the cutting plan
     * has posted and says `idealDeferred`; the store then starts the comparison below.
     */
    deferIdeal?: boolean,
    /** #1046 — the virtual ladder, on demand (the run sheet's press). Off/absent: unchanged. */
    restLadder?: boolean,
  ) => Promise<EngraveGenerated>;
  // #924 activation — the generator's own raw design items ride the oracle call the same way
  // `predicted` does; additive, so a caller that sends none runs exactly as it did before.
  simOracle: (
    predicted: OraclePredicted[],
    pcb?: PcbCopperTopologyInput | null,
    designItems?: DesignCheckItem[],
    /** #948 — the goal this program makes, when it is a goal program (see `simClient.simOracle`). */
    goal?: SimGoalCheck | null,
  ) => Promise<OracleReport>;
  /**
   * #785 — stop the run's worker; the store has already orphaned the run (see `cancelGenerate`).
   * OPTIONAL so a fake client (a test, a preview-only build) need not implement a stop it has no
   * worker for; the real sim client's is `terminateSim`.
   */
  cancelGenerate?: () => void;
  /**
   * #986 (the ruling) — THE BACKGROUND IDEAL. Optional so a fake client (a test, a preview-only
   * build) need not implement it; when present, the run store calls it AFTER the owned plan has
   * posted and holds its answer as the second result stream.
   */
  engravePlanIdeal?: PlanIdealCall;
  /**
   * #1151 — THE SAME COMPARISON ON A DEDICATED WORKER, created for the call and terminated on
   * return: the panel's shared sim worker must stay free for the sweep (the ideal is ~15 min on
   * the set B top). Optional; a client without it falls back to `engravePlanIdeal`.
   */
  engravePlanIdealOnItsOwnWorker?: PlanIdealCall;
};

/**
 * #785 — THE JOB FACTS A CRASH REPORT QUOTES: the stock, the item count and the goal mesh's bytes
 * and triangle count (from a binary STL's own 84-byte header, when the bytes are embedded). The
 * job document rides along with its mesh bytes REMOVED — the meshes are named by hash; the bytes
 * are included only if the operator later chooses to.
 */
function goalMeshFacts(target: EngraveTargetObject): NonNullable<WorkFacts['meshes']>[number] & { triangles: number | null } {
  const bytes = typeof target.data === 'string' ? Math.floor((target.data.length * 3) / 4) : 0;
  let triangles: number | null = null;
  if (target.format === 'stl' && typeof target.data === 'string' && bytes >= 84) {
    try {
      // 112 base64 chars decode to the first 84 bytes: the header and the triangle count.
      const head = atob(target.data.slice(0, 112));
      const view = new DataView(Uint8Array.from(head, (c) => c.charCodeAt(0)).buffer);
      const count = view.getUint32(80, true);
      // A binary STL's length is exactly 84 + 50n; anything else is ASCII or not an STL.
      if (84 + 50 * count === bytes) triangles = count;
    } catch {
      triangles = null;
    }
  }
  return { name: target.name, sha256: target.sha256, format: target.format, bytes, triangles };
}

function generateFacts(job: EngraveJob): WorkFacts {
  const goals = [job.targetObject, ...(job.targetObjects ?? [])].filter(
    (t): t is EngraveTargetObject => t !== undefined && (t.role ?? 'reference') === 'goal' && t.enabled,
  );
  const meshes = goals.map(goalMeshFacts);
  const stripped: Record<string, unknown> = { ...job };
  delete stripped.targetObject;
  delete stripped.targetObjects;
  return {
    jobName: job.name,
    jobFingerprint: jobFingerprint(job),
    stock: { length: job.stock.length, width: job.stock.width, thickness: job.stock.thickness },
    items: job.labels.length + job.shapes.length,
    ...(meshes.length === 0
      ? {}
      : {
          goalBytes: meshes.reduce((sum, m) => sum + m.bytes, 0),
          ...(meshes.some((m) => m.triangles !== null) ? { goalTriangles: meshes.reduce((sum, m) => sum + (m.triangles ?? 0), 0) } : {}),
        }),
    meshes: meshes.map(({ triangles: _triangles, ...m }) => m),
    job: {
      ...stripped,
      ...(goals.length === 0 ? {} : { targets: goals.map(({ data: _data, ...t }) => t) }),
    },
  };
}

const loadClient = async (): Promise<EngraveRunClient> => {
  if (!featureSim) throw new Error('the run is not enabled in this build');
  return import('@/engine/jobs/simClient');
};
let clientLoader: () => Promise<EngraveRunClient> = loadClient;
/** For tests: swap the (lazy) client for a fake. */
export function setEngraveRunClientLoader(fn: (() => Promise<EngraveRunClient>) | null): void {
  clientLoader = fn ?? loadClient;
}

/**
 * #1126/#1175 — THE CLIENT GENERATE USES: the house's when the service can run one, else the
 * page's own worker.
 *
 * #1191 — THE BACKGROUND COMPARISON USES THE SAME CHOICE. The plans it compares must be made by
 * the planner the Generate press would run; asking the page's worker while the press would ask
 * the house would report a difference that is not the build's.
 */
async function clientForGenerate(): Promise<EngraveRunClient> {
  const base = await clientLoader();
  // #1175 — THE PUBLISH SWITCH. `true` forces the in-page worker for every Generate, exactly as a
  // service that reports `runs: false`: the house branch below is skipped and nothing else changes.
  const HOUSE_GENERATION_FORCED_OFF = false;
  if (HOUSE_GENERATION_FORCED_OFF || !(await houseGenerationAvailable())) return base;
  const { engravePlanIdeal: _idealOnTheBrowser, ...rest } = base;
  return {
    ...rest,
    // #1175 — ALL TEN ARGUMENTS OF THE BROWSER CALL ARE HONOURED. The tools list (8th) and the
    // ladder press (10th) ride the submit to the service and the CLI; `deferIdeal` (9th) has no
    // house analogue — the CLI's own Generate already runs both outcomes and returns the tradeoff,
    // so the result is never deferred and the store's after-Generate code reads it exactly as it
    // reads an in-page result.
    engraveGenerate: (
      jobArg,
      toolArg,
      catalogueArg,
      calibrationArg,
      marginsArg,
      shopArg,
      onProgressArg,
      catalogueToolsArg,
      _deferIdealArg,
      restLadderArg,
    ) =>
      houseEngraveGenerate({
        job: jobArg,
        tool: toolArg,
        catalogue: catalogueArg,
        calibration: calibrationArg,
        margins: marginsArg,
        ...(shopArg === undefined ? {} : { shop: shopArg }),
        ...(onProgressArg === undefined ? {} : { onProgress: onProgressArg }),
        ...(catalogueToolsArg === undefined ? {} : { catalogueTools: catalogueToolsArg }),
        ...(restLadderArg === undefined ? {} : { restLadder: restLadderArg }),
      }),
    cancelGenerate: () => {
      cancelActiveHouseRun();
      base.cancelGenerate?.();
    },
  };
}

/**
 * Half the job's smallest level step, mm — the ramp the column engine should name (#629). A move
 * whose Z ramps along its XY leg is swept at its deep end; it over-removes at a lower level only
 * when the ramp crosses a level boundary, so the threshold is half the smallest gap between the
 * predicted items' distinct depths. `null` for a job the column engine does not sweep (the exact
 * engine raises `ramp-over-removed` itself) or one with a single level (nothing to cross into).
 */
export function rampThresholdMm(predicted: readonly OraclePredicted[], tool: Tool): number | null {
  const onColumn =
    isVShape(tool) || tool.shape === 'drill' || tool.shape === 'thread' || tool.shape === 'ball' || tool.shape === 'bull';
  if (!onColumn) return null;
  const depths = [...new Set(predicted.map((p) => p.depth).filter((d) => d > 0))].sort((a, b) => a - b);
  if (depths.length < 2) return null;
  let smallest = Infinity;
  for (let i = 1; i < depths.length; i++) smallest = Math.min(smallest, depths[i]! - depths[i - 1]!);
  return smallest / 2;
}

/**
 * #1035 (6b's ruling, #948) — WHOSE COVERAGE FAILURE IS THE RUN'S. A #869 rough/finish split posts
 * two goal programs, and the goal check runs once per program on the cumulative field: the rough
 * stage reads the stock its own pass left (81.07 % under the 95 % line, `ok` false), the finish
 * reads the end state (100 %, `ok` true). The AND of both made Design's row cross while the Cut
 * card showed the finish pass — two surfaces disagreeing on one run. So an INTERMEDIATE goal
 * program contributes only its CUT-INTO verdict (a gouge is real whichever stage made it); the
 * coverage-vs-pass-line verdict counts on the LAST goal program's cumulative report.
 *
 * `true` when this report's own `ok` is false ONLY because its coverage is short: it is not the
 * run's failure, and the per-program evidence says its coverage is judged at the end of the run.
 *
 * INVARIANT — a deferred report is COVERAGE-SHORT ONLY. `checkGoalCutInto`'s `ok` is
 * `judgedCells === 0 && coverage`, and a judged cell is one deeper than the floor, so a report
 * with no adjudicated cut-into at the floor (the test below) can have failed on nothing but the
 * pass line. A report carrying a cut-into cell is never deferred: a gouge is the run's failure
 * whichever stage made it.
 */
export function goalCoverageDeferred(report: OracleReport, isLastGoalProgram: boolean): boolean {
  if (isLastGoalProgram) return false;
  const goal = report.goalCutInto;
  if (goal === undefined || report.ok || !goal.ran) return false;
  // `ok = judgedCells === 0 && coverage`; a judged cell is one below the floor, so a report with
  // no cut-into deeper than the floor failed on coverage, and that verdict is the run's last one.
  return goal.adjudicatedMaxMm <= goal.cutIntoFloorMm + 1e-9;
}

/**
 * #844 — THE RUN'S COMBINED ORACLE. Every program's own verdict must pass; the run's tick is all
 * of them. The numbers are the run's totals (each program's worst summed — the files cut
 * different material), the band the widest tolerance any of them used, and the first failing
 * report's location. A board's copper verdict is carried and must pass too.
 *
 * #1035 — with `goalCoverageDeferred`'s rule: an intermediate goal program whose only failure is
 * its own stage's coverage does not fail the run.
 */
export function combineOracles(reports: readonly OracleReport[], copper: OracleReport | null): OracleReport {
  const all = copper === null ? reports : [...reports, copper];
  const first = reports[0] ?? copper;
  if (first === null || all.length === 0) throw new Error('no oracle report to combine');
  // #948 — THE GOAL VERDICT IS THE FINAL SURFACE'S. A #869 rough/finish split posts two goal
  // programs and BOTH carry a check; the rough's leftover is not the run's verdict, so the LAST
  // program's report that carries one is taken (not the first that has one). #1035 — and it is
  // that report's coverage that counts: an earlier goal program contributes only its cut-into.
  const goal = reports.reduce<OracleReport | null>(
    (last, r) => (r.goalCutInto === undefined ? last : r),
    null,
  );
  const failing = reports.filter((r) => !r.ok && !goalCoverageDeferred(r, r === goal));
  const locus = failing[0] ?? first;
  // #947 gate 7 / #924 — THE REST OF THE ORACLE'S EVIDENCE TRAVELS TOO, the same way. The sliver
  // width is the constant every flat comparison that ran the open states; the design-side check is
  // whose verdict the `ok` above already folds, so without it a failed run shows an unexplained
  // cross with 0/0 under/over and no sentence. A FAILING design check wins the carry (it is the
  // one the operator must be able to read); otherwise the last program's stands.
  const sliver = reports.reduce<OracleReport | null>(
    (last, r) => (r.sliverWidthMm === undefined ? last : r),
    null,
  );
  const design = reports.reduce<OracleReport | null>((carried, r) => {
    if (r.designCheck === undefined) return carried;
    if (!r.designCheck.ok) return r;
    return carried !== null && carried.designCheck?.ok === false ? carried : r;
  }, null);
  return {
    ok: failing.length === 0 && (copper === null || copper.ok),
    band: Math.max(...all.map((r) => r.band)),
    // The levels the picture and the per-level sentence read: one coherent set, from the report
    // that decided the verdict (the first failing, else the first program's).
    levels: locus.levels,
    worst: {
      underCut: reports.reduce((sum, r) => sum + r.worst.underCut, 0),
      overCut: reports.reduce((sum, r) => sum + r.worst.overCut, 0),
      underAt: locus.worst.underAt ?? null,
      overAt: locus.worst.overAt ?? null,
    },
    ...(locus.areaFloor === undefined ? {} : { areaFloor: locus.areaFloor }),
    ...(locus.frame === undefined ? {} : { frame: locus.frame }),
    ...(copper?.copper === undefined ? {} : { copper: copper.copper }),
    ...(goal?.goalCutInto === undefined ? {} : { goalCutInto: goal.goalCutInto }),
    ...(sliver?.sliverWidthMm === undefined ? {} : { sliverWidthMm: sliver.sliverWidthMm }),
    ...(design?.designCheck === undefined ? {} : { designCheck: design.designCheck }),
  };
}

export interface EngraveRunState {
  /** The last generated result — kept on screen while a newer run builds. */
  generated: EngraveGenerated | null;
  /**
   * #986 (the ruling) — THE BACKGROUND IDEAL'S SECOND RESULT STREAM. `idle` until a run succeeds;
   * `comparing` while the ideal is planned behind the posted owned plan (the card reads
   * "comparing…"); `ready` with the tradeoff (null when there is no ideal or nothing material).
   */
  idealPlan: { status: 'idle' | 'comparing' | 'ready'; tradeoff: PlanTradeoff | null };
  /**
   * #986 — re-run the background comparison with the LAST RUN'S OWN arguments (the press). It
   * compares the job, tool and shop that run used — not whatever the job looks like now — so the
   * line it prints always belongs to the program on screen.
   */
  comparePlans: () => void;
  oracle: OracleReport | null;
  /**
   * #844 — EVERY PROGRAM'S OWN VERDICT, in cut order, with the words that name it. `oracle` is the
   * run's combined tick; this is the evidence behind it, and the gate's sentence reads it to name
   * the file that did not match.
   */
  oraclePrograms: ProgramOracle[];
  /** The diagnostics of the simulation load this run performed (#193, #204). */
  simDiagnostics: SimDiagnostic[];
  /** The terminal status of that load, or null before it ran. */
  simStatus: SimStatus | null;
  /**
   * True when that load was PATH-ONLY — the sweep was refused and only the tool path is drawn
   * (#194). Captured here, not read back from `simStore` at render time, so the coverage
   * sentence (#243) describes the run this panel actually performed, not whatever the Simulate
   * panel loaded afterwards.
   */
  pathOnly: boolean;
  /**
   * #405 — which backend swept the material this run (`SimLoadOk.stats.engine`), or null before a
   * run. Captured here, like `pathOnly`, so the run sheet's coverage disclaimer can say a column
   * sweep's numbers carry a grid resolution (a rotary job, or a V-bit trace) from THIS run and not
   * whatever the Simulate panel loaded afterwards.
   */
  simEngine: 'exact' | 'column' | null;
  /**
   * #535 — the FLAT dexel grid's Y pitch the column engine actually swept this run on, mm
   * (`SimLoadOk.stats.resolution.dThetaDeg`), or null when the run was not a flat column sweep.
   * Captured here like `simEngine`, and for the same reason: the goal program's check sentence
   * states the grid THIS run was checked on, not whatever the Simulate panel loaded afterwards.
   */
  simGridPitchMm: number | null;
  /**
   * #744 — EVERY program's sweep result, in cut order, for the panels and the run sheet. The
   * diagnostics are unprefixed here; `simDiagnostics` is the attributed projection the gate reads.
   * Empty before a run, and for a run whose first load never produced a sweep.
   */
  simPrograms: ProgramSweepSummary[];
  /**
   * #1068 — the mount this run derived (the bracket's arms and clamps, the job's own obstacle
   * boxes), captured at Generate like `simDiagnostics` so the run sheet's coverage section names
   * the fixture the sweep was actually handed. Null for the vise (whose own envelope is stated) and
   * for tape (nothing over the part).
   */
  runMount: MountObstacles | null;
  phase: EngraveRunPhase;
  /** The ONE statement (see `ACKNOWLEDGE_CODES`), reset on every Generate. */
  acknowledged: boolean;
  /**
   * #797 — WHICH program the statement was given for: the frozen package's hash. The statement is
   * asked once per program, so a package that changes (a new Generate, a re-freeze) is not covered
   * by the old tick; a job edit that leaves the program alone keeps it.
   */
  acknowledgedFor: string | null;
  /** Set when the job changed after a Generate; null while the result still matches. */
  staleSince: number | null;
  /**
   * #581 — WHICH input moved under the result, named rather than inferred (`staleSince` only says
   * "when"). Null before any stale mark; 'job' | 'machine' | 'margins' when one is set.
   */
  staleReason: EngraveInputKey | null;
  /**
   * #581 — what THIS Generate read, stamped once from the same snapshot it handed the worker. Kept
   * so the next Generate can compare (the oracle row names the input a verdict flip followed).
   */
  inputs: EngraveRunInputs | null;
  /**
   * #1123 — THE SHOP THIS RUN WAS GENERATED IN, as a signature of the house reads that were live
   * at the press (the location's and the tool registry's statuses and ETags). A DIAGNOSTIC on the
   * stored run, never a restore key: ETags move for record writes that do not change the program
   * (a finished program, an inventory note). The precise test is `recheckRunInputs`, which
   * compares the inputs the run really stamped. Null before a Generate.
   */
  shopSignature: string | null;
  /**
   * #1123 — THE PLAIN LINE after a reload found a stored run it could not restore (only another
   * build's record exists). Null when there is nothing to say. Cleared by the next Generate. A
   * moved shop is not a refusal: the restored run is marked stale with its named input instead.
   */
  restoreNote: string | null;
  /**
   * #1123 review — A RESTORED RUN IS UNVERIFIED UNTIL ITS RECHECK RUNS. When the house reads had
   * not settled at restore time, `recheckRunInputs()` is deferred until they do; while this is
   * true the result must not be offered as current (no Cut press, no Cut… primary). It clears
   * when the deferred recheck runs; a moved input then marks the ordinary stale reason.
   */
  restoreChecking: boolean;
  /**
   * #1191 — this build's background comparison of a not-yet-started restored run. Null before any
   * comparison (and after Keep); `same` says nothing on screen, `different` offers the choice.
   */
  buildCompare: BuildCompare | null;
  /** #581 — the inputs that differ from the previous Generate's; empty on the first run. */
  changedSinceLast: EngraveInputKey[];
  /** #581 — the previous Generate's oracle verdict, so a ✓↔× flip can say what changed. */
  previousVerdict: boolean | null;
  /**
   * #1132 — how long the last Generate took on this job (ms), measured by the generate action.
   * The Cut card's honest cost ("about N min (last Generate on this job)") reads it; null until a
   * Generate has completed in this browser.
   */
  lastGenerateMs: number | null;
  /** A thrown failure from any stage that is not already a finding (generate, load, oracle). */
  error: string | null;
  /** #785 — the current stage's words while a run works ("roughing level 41 of 112"), else null. */
  progress: EngraveProgress | null;
  /**
   * #1123 item 4 — EVERY STAGE TICK OF THIS RUN, with its timestamp and duration (`runLog.ts`).
   * The log fold beside the progress line reads it, and the run's `<job>-run.log` is serialized
   * from it; a new run resets it.
   */
  log: RunLogEntry[];
  /**
   * #830 — WHICH PROGRAM OF THE SWEEP IS RUNNING while `phase === 'simulating'`: the simulation's
   * own stage, so the panel never shows a bare "Working…" through a multi-program sweep.
   */
  simProgram: { index: number; count: number } | null;
  /**
   * #830 review — the run stopped because the SIMULATION PROCESS itself ended (its worker died or
   * went silent), so no program was ever judged. This is a STOP, not a failed simulation: the
   * panel states it once beside Generate, and the checklist's simulation row reads "stopped before
   * it finished" rather than a cross. False for a sweep that ran and found errors, and for every
   * failure of the other stages.
   */
  simStopped: boolean;
  /** Run the whole pipeline for the job as it is NOW. `surface` (#608) re-posts against a tilt. */
  /**
   * #1046 — `restLadder` asks the OWNED plan to measure the standard rungs on this run (the run
   * sheet's press); absent, the run is byte-identical to the pre-#1046 one.
   */
  generate: (
    surface?: SurfacePostFit | null,
    opts?: {
      restLadder?: boolean;
      /**
       * #1123 item 52 — the press probe's warning, recorded as the run log's first line: the line
       * is cleared from beside Generate when the run ends, so the Log is where it lives after.
       */
      memoryWarning?: string | null;
    },
  ) => Promise<void>;
  /** #893 — simulate and check the program already generated, without generating again. */
  simulate: () => Promise<void>;
  /**
   * #1191 — THIS BUILD CHECKS A RESTORED RUN'S BYTES. On a cross-build restore the stored
   * programs are re-verified by this build's verifier and then re-swept/checked by the
   * simulate-only path — the checks, never the planner. Load stays off (`restoreChecking`) until
   * the caller's promise settles; a verifier refusal leaves the run blocked with the finding.
   */
  recheckRestoredRun: (
    restored: Pick<EngraveRunState, 'generated' | 'inputs'>,
  ) => Promise<void>;
  /**
   * #1191 — compare this build's plan for the job with the restored run, in the background, when
   * no program of the restored package has been cut. The restored run is never touched; a
   * different plan is a CHOICE (`buildCompare`), and keeping is the default.
   */
  compareRestoredPlan: () => Promise<void>;
  /** #1191 — keep the restored programs (the default): drop the compare's offer. */
  keepRestoredPlan: () => void;
  /**
   * #785 — CANCEL a run in flight. The worker is terminated (the only reliable stop for a wasm
   * call), the in-flight result is orphaned, and the panel returns to the phase it was in before
   * the run — the last generated result is still on screen, marked as before.
   */
  cancelGenerate: () => void;
  setAcknowledged: (v: boolean) => void;
  /** #797 — the one statement, given for `hash` (the package the tick covers). */
  acknowledgeProgram: (hash: string) => void;
  /**
   * #490 — record a diagnostic that did not come from a sim stage: the panel's error boundary
   * writes a render crash here, into the same list the run sheet reads, so a panel that threw
   * still leaves a sentence the report can carry. Kept on the run, not on the job.
   */
  reportDiagnostic: (diagnostic: SimDiagnostic) => void;
  /** Forget the run (and the staleness). Does not touch the job. */
  reset: () => void;
}

/**
 * #830 review — THE SWEEP STOPPED WITHOUT A VERDICT. Raised by the sweep adapter when the
 * simulation could not finish (the worker stopped, or a call was cut off): there is no result to
 * attribute to the program that happened to be loaded, so the failure leaves the sweep as a STOP.
 * The run blocks with the worker's own words, and no error finding is invented for a program that
 * was never judged — so the run's error count carries no sentence about work that never happened.
 */
class SimulationStopped extends Error {}

let seq = 0;
/**
 * #1076 — THE GENERATOR WATCHDOG'S SENTENCE, as the app actually knows things. A sweep that goes
 * quiet is inside one synchronous geometry call: the sentence names the checkpoint the stream was
 * in (when the stream has one) and says the worker is alive, rather than guessing it stopped.
 * Silence alone cannot prove a fault; a genuinely dead worker rejects its pending call by name.
 */
export function generatorStallSentence(
  stallMs: number,
  during: EngraveRunPhase,
  sim: { phase: string | null; progress: { done: number; total: number } | null },
  lastStage: string | null = null,
): string {
  const seconds = Math.round(stallMs / 1000);
  // #830 review — a silence while the CAM generates is said without the simulation's frame.
  // #1076 (the review gate) — and it names the last stage the recorder heard, as a fact, and
  // says the worker is alive: a synchronous plan call is not a dead worker.
  if (during !== 'simulating' && during !== 'checking') {
    return `the generator reported nothing for ${seconds} s${lastStage === null ? '' : ` — its last stage was "${lastStage}"`}; the worker is alive`;
  }
  if (during === 'checking') return `the goal check has reported nothing for ${seconds} s; the worker is alive`;
  const at =
    sim.phase === 'sweep' && sim.progress !== null && sim.progress.total > 0 && sim.progress.done < sim.progress.total
      ? ` — checkpoint ${sim.progress.done + 1} of ${sim.progress.total} is inside one geometry call`
      : '';
  return `no checkpoint completed in ${seconds} s${at}; the worker is alive`;
}

/**
 * #1191 — THE CROSS-BUILD PLAN COMPARISON of a restored run whose job has not started cutting.
 *
 * The restored programs are kept while this runs (the default is KEEP); it only says whether this
 * build would plan the job differently, so the operator can choose. `different` counts programs
 * whose hash is absent from the other plan (order-insensitive, multiplicity-aware).
 */
export interface BuildCompare {
  /** `kept` is the silent end: the operator kept the programs, or the compare could not run. */
  status: 'checking' | 'same' | 'different' | 'kept';
  changed: number;
  total: number;
}

/** #785 — the loaded client (so Cancel can terminate the worker without a second import). */
let activeClient: EngraveRunClient | null = null;
/** #785 — the phase the panel was in before this run, restored on Cancel. */
let phaseBeforeRun: EngraveRunPhase = 'idle';
/** #785 — the last stage the recorder heard, so a stage change is a stage crumb, not progress. */
let lastStage: string | null = null;
/** #1076 — whether THIS run's own progress has been heard yet (the queue clock's switch). */
let heardGenerateProgress = false;
/** #1123 item 4 — when THIS run started, so the log's first tick's duration is the run's own clock. */
let logStartedAt = 0;

export const useEngraveRunStore = create<EngraveRunState>()((set, get) => {
  const empty = {
    oracle: null,
    oraclePrograms: [] as ProgramOracle[],
    simDiagnostics: [] as SimDiagnostic[],
    simStatus: null as SimStatus | null,
    pathOnly: false,
    simEngine: null as 'exact' | 'column' | null,
    simGridPitchMm: null as number | null,
    simPrograms: [] as ProgramSweepSummary[],
    // #1068 — the mount this run derived, so the sheet can name the fixture the sweep was handed.
    runMount: null as MountObstacles | null,
    acknowledged: false,
    acknowledgedFor: null as string | null,
    staleSince: null as number | null,
    staleReason: null as EngraveInputKey | null,
    inputs: null as EngraveRunInputs | null,
    shopSignature: null as string | null,
    restoreNote: null as string | null,
    restoreChecking: false,
    buildCompare: null as BuildCompare | null,
    changedSinceLast: [] as EngraveInputKey[],
    previousVerdict: null as boolean | null,
    error: null as string | null,
    progress: null as EngraveProgress | null,
    log: [] as RunLogEntry[],
    simProgram: null as { index: number; count: number } | null,
    simStopped: false,
  };

  /**
   * #893 — WHICH run owns the preview store's hold. A run stopped by Cancel keeps its awaited call
   * pending forever (the worker is terminated, nothing rejects it), so its `finally` may never
   * fire; the cancel releases the hold itself, and this token stops a late `finally` from
   * releasing a NEWER run's hold.
   */
  let runHold: symbol | null = null;

  // #986 (E's review) — THE ON-DEMAND PRESS re-runs the background comparison with the SAME
  // arguments the run used. Held here, beside the run hold, so the press needs no re-plumbing of
  // the job through the panel.
  let idealLastRequest: (() => void) | null = null;
  // The EPOCH a run belongs to: incremented when a run starts, captured by the ideal it kicks off.
  // `runHold` is the wrong token here — the run's own `finally` clears it when the program posts,
  // long before the ideal (minutes later) resolves, so the ideal would always be dropped.
  let runEpoch = 0;

  async function run(
    surface: SurfacePostFit | null = null,
    opts: { simulateOnly?: boolean; restLadder?: boolean; memoryWarning?: string | null } = {},
  ): Promise<void> {
    // #893 — SIMULATE ONLY: the program is already this job's, so the run starts at the sweep.
    // A stale program (or one that never posted) has nothing this press can honestly check.
    const simulateOnly = opts.simulateOnly === true;
    const priorGenerated = get().generated;
    if (simulateOnly && (priorGenerated === null || priorGenerated.nc === null || get().staleSince !== null)) return;
    const job = useEngraveJobStore.getState().job;
    const mine = ++seq;
    // #581 — WHAT THE RUN BEFORE THIS ONE SAW, captured before the reset below clears the result.
    // The verdict is the comparison point; the inputs are what the new run's stamp is diffed
    // against, so a disagreement can name the input that moved.
    const before = get();
    phaseBeforeRun = before.phase;
    lastStage = null;
    // #787 — the heavy work starts: its facts go to the flight recorder, and the marker says what
    // was running if this tab dies before the next crumb.
    noteWorkStart('generate', generateFacts(job));
    const previousVerdict = before.oracle === null ? null : before.oracle.ok;
    const previousInputs = before.inputs;
    // #1123 item 4 — a SIMULATE-ONLY press re-checks the program an earlier Generate posted, so
    // its log CONTINUES that run's rather than erasing the stages that made the program.
    const priorLog = simulateOnly ? get().log : [];
    logStartedAt = Date.now();
    // #1123 item 52 — the press warning is the run's FIRST log line (the panel's line beside
    // Generate clears when the run ends; the Log keeps what the run was told).
    const memoryWarning = opts.memoryWarning ?? null;
    const openingLog = simulateOnly
      ? appendRunLog(priorLog, 'simulating the existing program', logStartedAt, logStartedAt)
      : appendRunLog([], 'starting the worker', logStartedAt, logStartedAt);
    set({
      ...empty,
      phase: simulateOnly ? 'simulating' : 'generating',
      generated: get().generated,
      // #1191 — A RESTORED RUN'S RE-CHECK IS A SIMULATE-ONLY PASS. It must keep the origin line
      // ("These programs were generated by build …") and stay unverified until the sweep finishes;
      // the caller that asked for the re-check owns clearing the latter.
      ...(simulateOnly ? { restoreNote: get().restoreNote, restoreChecking: get().restoreChecking } : {}),
      // #785 — a name from the FIRST frame: the worker's own first stage can be seconds away (the
      // module and its wasm load), and "Working…" with no words is the complaint this issue is.
      progress: simulateOnly ? null : { stage: 'prepare', label: 'starting the worker' },
      // #1123 item 4 — the log opens with the first tick so the fold is never blank mid-run.
      log: memoryWarning === null ? openingLog : [{ at: logStartedAt, ms: 0, label: memoryWarning }, ...openingLog],
    });

    // ONE machine per run (#297): the saved frame is read once, here, and handed to the generator
    // (post, verify, frame file) and to the simulation load below. Two reads could straddle a change
    // to the saved frame and leave the gate and the sim judging different machines for one .nc.
    const calibration = useSettingsStore.getState().machineCalibration ?? null;

    // The job's depth thresholds, resolved ONCE here too (#345). The worker cannot see
    // `useSettingsStore`, and this is the run: the margin that gates the program has to be the one
    // the house setting and the job's own record say, not the shipped default the worker falls back
    // to. Read from the same settings snapshot as the calibration above, for the same reason —
    // a re-read after the await could straddle an edit and gate a different job than it reports.
    const margins = effectiveMargins(job, useSettingsStore.getState().margins);

    // The engrave pipeline's shop defaults (#451), read ONCE here beside the margins and for the same
    // reason: the worker cannot see the location, and these numbers gate the program it posts —
    // the warn ratio decides which items fail `item-detail-lost`, the peck clearance decides the
    // Z each drill's re-entry rapid stops at, and the whole location crosses as `defaults` so the
    // worker can read the `thread.*` set (#445 D6) without a second IPC. Reading them before the
    // await keeps the run's inputs one snapshot.
    const shopDefaults = useShopDefaultsStore.getState().defaults;
    // #442's #427 item — the mount's obstacles, resolved HERE for the same reason the shop defaults
    // are: the bracket's sizes live in the location's defaults and the worker must not import the
    // defaults client. `null` in the vise, and then the verifier and the sweep are exactly what
    // they were before #427. The same object gates the program AND loads the simulation below, so
    // the verifier and the sweep check one set of boxes.
    //
    // #1068 — the derivation itself is `jobMountObstacles`, the SAME function the command line
    // calls, so the two doors cannot check a bracket job against different boxes (the CLI used to
    // check none at all). It folds in #707 BM-1's own clamp places and the job's own obstacle
    // boxes (a hole in the blank, screwed down).
    const mount = jobMountObstacles(job, shopDefaults);
    // #1068 — captured like the sim results: the sheet names the fixture THIS run was swept
    // against, not one re-derived after the location might have changed.
    set({ runMount: mount });
    // #712 — the bed's through-cut facts, resolved HERE for the same reason the mount is: the
    // active bed profile lives in the location, and the worker must not read it. The need is the
    // job's own (`breakthrough + 1`), so a board the sentence names is one that really passes.
    // #730 — the JOB's machine, not the house's first: `machineId` is its profile id.
    const bed = bedUnderFacts(machineForJob(useLocationStore.getState().location, job.machineId), shopDefaults, job.breakthrough + 1, {
    length: job.stock.length,
    width: job.stock.width,
  });
    // #922 — THE ONE SHOP BUILDER. `engraveShopOpts` (`engine/cnc/engrave/feeds.ts`) is the builder
    // the CLI's door uses, so the app's Generate and `casemaker cut` cannot send different shop
    // numbers; the per-job facts the builder deliberately omits (the mount's obstacles, the bed's
    // through-cut facts, the fitted surface) are added here.
    const shop: EngraveShopOpts = {
      ...engraveShopOpts(shopDefaults),
      mount,
      bed,
      // #608 — the fitted tilt the Cut step re-posts against, when it re-generates after a
      // registration measured one. Absent/null posts flat, byte-for-byte as before.
      surface: surface === null ? undefined : { plane: surface.plane, z0: surface.z0 },
    };

    // The cutter, resolved ONCE on this side (#305): the sim worker cannot see the registry, so
    // it is sent the `Tool` — and the same object then loads the simulation below, so the gate
    // and the sweep cannot judge the job with two different cutters.
    const tool = jobTool(job);

    // Makera's feed rows, read here for the same reason (#324): `feeds.ts` keeps them as module
    // state this realm owns, the worker's copy of that state is always empty, and the `.nc` and the
    // run sheet are both posted from the worker's resolution. Without this the panel showed the
    // catalogue's S/F while the program carried the starting table's — the operator reading one set
    // of numbers and the machine running another.
    const catalogue = feedCatalogueRows();
    // (`shop.feeds` was read above, in the same snapshot: the worker's `feedsFor` resolves against
    // the shop's table, and the panel's main-thread `feedsFor` reads the same installed rows.)

    // #581 — the run's own stamp, from the values read above (no second read): what the NEXT
    // Generate compares against, so a disagreement between two runs can name the input that moved.
    // `previousVerdict` is carried with it — the row only needs the reason when the verdict flips.
    const inputs = runInputs({
      job,
      margins,
      calibration,
      shopDefaults,
      feeds: shop.feeds ?? [],
      catalogue,
      tools: shop.tools ?? [],
      conditions: shop.conditions ?? new Map(),
      surface,
    });
    set({
      inputs,
      shopSignature: runShopSignature(),
      // #1191 — A SIMULATE-ONLY PASS KEEPS THE RESTORED RUN'S ORIGIN LINE. The cross-build
      // re-check runs the stored bytes through this path; clearing the note here made the one-line
      // 'These programs were generated by build …' vanish the moment the re-check started. Only a
      // Generate (a new run) clears it.
      restoreNote: simulateOnly ? get().restoreNote : null,
      changedSinceLast: previousInputs === null ? [] : changedInputs(previousInputs, inputs),
      previousVerdict,
    });

    let client: EngraveRunClient;
    let generated: EngraveGenerated;
    // #830 — THE SILENCE WATCHDOG. A worker that DIES is caught below (its pending calls reject);
    // a worker that stops ANSWERING cannot be probed while it is inside one wasm call, so the only
    // signal is time. No stage for the shop's `sim.stallMs` (three minutes by default) and the run
    // is stopped and REPORTED, the worker is killed, and the panel offers Try again. The stage
    // crumbs in the flight recorder say what it was doing when it went quiet.
    const stallMs = shopDefault('sim.stallMs').value;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const clearStall = (): void => {
      if (stallTimer !== null) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    const armStall = (): void => {
      clearStall();
      stallTimer = setTimeout(() => {
        if (mine !== seq) return;
        const seconds = Math.round(stallMs / 1000);
        // #830 review — WHAT went quiet decides what the panel says. A silence while the SWEEP
        // runs is a stopped simulation (no verdict for any program); a silence while the CAM
        // generates is the generator stopping, and is said without that frame.
        if (!heardGenerateProgress) {
          // #1076 — A QUEUED GENERATE IS NOT A DEAD WORKER. The sim worker is shared with the
          // preview and the measured pick; a generate pressed while they run waits its turn in
          // silence. While that work is provably in flight, say the wait and keep the clock
          // running — the fault window starts once the generate itself has spoken.
          // #1076 — THE OCCUPANT IS READ FROM THE CALL IN FLIGHT. The press itself clears the
          // pick's `measuredStatus` (`holdMeasurement`) while the pick's worker call keeps running
          // to its next candidate boundary, and a superseded preview's status can read "loading"
          // after its call ended; both statuses misname the worker's state at this instant, so the
          // preview store counts its own calls and answers from those.
          const occupant = useEngravePreviewStore.getState().workerOccupant();
          if (occupant !== null) {
            set({ progress: { stage: 'prepare', label: `waiting for ${occupant} to finish — the worker is busy` } });
            recordCrumb({ kind: 'progress', data: { source: 'generate-queue', message: `waiting for ${occupant}` } });
            armStall();
            return;
          }
        }
        const during = get().phase;
        const inSimulation = during === 'simulating' || during === 'checking';
        // #1076 — WHAT THE SIM STREAM LAST SAID. A sweep that goes quiet is inside one
        // synchronous geometry call; the sentence names the checkpoint it was in (when the
        // stream has one) and says the worker is alive, instead of guessing that it stopped.
        const sim = useSimStore.getState();
        recordCrumb({
          kind: 'error',
          data: { source: 'generate-stall', message: `no stage for ${seconds} s (last: ${lastStage ?? 'the press'})` },
        });
        activeClient?.cancelGenerate?.();
        activeClient = null;
        noteWorkEnd('generate', 'failed');
        set({
          ...empty,
          generated: get().generated,
          phase: 'blocked',
          simStopped: inSimulation,
          error: generatorStallSentence(stallMs, during, { phase: sim.phase, progress: sim.progress }, lastStage),
        });
      }, stallMs);
    };
    try {
      // #1126/#1175 — the house's planner when the service can run one, else the page's worker.
      // A simulate-only pass never generates, so it keeps the plain client.
      client = simulateOnly ? await clientLoader() : await clientForGenerate();
      activeClient = client;
      if (simulateOnly) {
        // #893 — nothing to generate: the program the row shows is this job's own.
        generated = priorGenerated as EngraveGenerated;
      } else {
      heardGenerateProgress = false;
      armStall();
      // #785 — every stage report is BOTH the panel's progress and a flight-recorder crumb: one
      // event stream, two readers. A stage change is a crumb of its own (the marker moves with it);
      // a count inside a stage is progress. #830 — every report re-arms the silence watchdog.
      const onProgress = (progress: EngraveProgress): void => {
        heardGenerateProgress = true;
        armStall();
        if (mine === seq) {
          // #1123 item 4 — every stage tick is also a log line (one per stage; a percentage of
          // the same stage appends nothing — `appendRunLog`'s own dedupe).
          set({ progress, log: appendRunLog(get().log, progress.label, Date.now(), logStartedAt) });
        }
        if (lastStage !== progress.stage) {
          lastStage = progress.stage;
          noteStage('generate', progress.stage, progress.label);
        } else if (progress.done !== undefined && progress.total !== undefined) {
          // #896 — the worker's heap rides with its progress into the report.
          noteFlightProgress(
            'generate',
            progress.stage,
            progress.done,
            progress.total,
            progress.label,
            progress.memoryMB === undefined || progress.memoryMB === null ? undefined : { memoryMB: progress.memoryMB },
          );
        }
      };
      try {
        // #961 — the ideal plan's candidate set: the app's own tool library (the same list every
        // picker shows, the house `cat:` rows included). The worker cannot see it from its realm.
        generated = await client.engraveGenerate(
          job, tool, catalogue, calibration, margins, shop, onProgress,
          getTools().map((entry) => entry.tool),
          // #1151 (#1134(c)) — the cut never waits on the comparison; the ideal is started below.
          true,
          // #1046 — the run sheet's press asks the owned plan to measure the ladder.
          opts.restLadder === true,
        );
      } finally {
        clearStall();
      }
      }
    } catch (e) {
      clearStall();
      if (mine === seq) {
        set({
          phase: 'blocked',
          error: e instanceof Error ? e.message : String(e),
          log: appendRunLog(get().log, `stopped: ${e instanceof Error ? e.message : String(e)}`, Date.now(), logStartedAt),
        });
      }
      noteWorkEnd('generate', 'failed');
      activeClient = null;
      return;
    }
    if (mine !== seq) return;

    // The job may have been edited while generating: the result already describes an older job. So
    // may the machine's saved frame (#301), and so may the depth margins (#345): the program above
    // was gated against the one read at the top. All three compare the #581 FOLLOW-UP rule — the
    // run's own STAMPS, never the objects: a write that lands on the same numbers is not a change.
    // The registration's origin write is exactly that (a new job object through `setStock`, its
    // `stock.flatness` and provenance excluded from `jobFingerprint` since #621/#627), and so is a
    // re-read of the frame the machine already had; either must not stale a result that still
    // describes them. The margins were already compared by value (a job carrying its own record
    // keeps them whatever the house setting does); they stay that way.
    const nowJob = useEngraveJobStore.getState().job;
    const nowCalibration = useSettingsStore.getState().machineCalibration ?? null;
    const nowMargins = effectiveMargins(nowJob, useSettingsStore.getState().margins);
    const changedJob = jobFingerprint(nowJob) !== inputs.job;
    const changedMachine = machineKey(nowCalibration) !== inputs.machine;
    // #642 — the margins are compared by their STAMP (both numbers), not `boundaryMargin` alone:
    // `inputs.margins` carries `zTolerance` too, and it can move on its own.
    const changedMargins = marginsKey(nowMargins) !== inputs.margins;
    // #893 — a simulate-only pass checks the program that is already this job's; it cannot stale itself.
    const stale = !simulateOnly && (changedJob || changedMachine || changedMargins);
    if (stale) {
      // #581 — name which one moved; the generic sentence is only for a caller that cannot know.
      set({
        generated,
        phase: 'blocked',
        staleSince: Date.now(),
        staleReason: changedJob ? 'job' : changedMachine ? 'machine' : 'margins',
      });
      noteWorkEnd('generate', 'done');
      activeClient = null;
      return;
    }

    set({ generated, progress: null });
    // #1049 — THE TRADEOFF IS GENERATE'S OWN. Generate plans both outcomes and carries the line on
    // its result (`planIdeal`/`planTradeoff`); the store reads it here instead of re-planning both
    // halves in the sim worker. The card lights the moment the result lands, and the worker stays
    // free for the run's own sweep — the ~900 s second plan on the tray is gone. No ideal on the
    // result (no goal, no catalogue, or the ideal added no cutter): nothing to compare.
    // #1151 — a deferred result is the owned plan, final: the comparison has not run and the line
    // says so until it does.
    const deferredIdeal = generated.idealDeferred === true;
    set({
      idealPlan: deferredIdeal
        ? { status: 'comparing', tradeoff: null }
        : generated.planIdeal !== undefined && generated.planIdeal !== null
          ? { status: 'ready', tradeoff: generated.planTradeoff ?? null }
          : { status: 'idle', tradeoff: null },
    });
    if (
      generated.ok &&
      generated.nc !== null &&
      job.targetObject !== undefined &&
      (client.engravePlanIdeal !== undefined || client.engravePlanIdealOnItsOwnWorker !== undefined)
    ) {
      const idealClient = client;
      const idealJob = job;
      const idealTool = tool as Tool;
      const idealShop = shop;
      const fireIdealCompare = (): void => {
        // #986 (E's review) — THE STALE-RUN RACE: the ideal path has no run of its own, so a slow
        // ideal from run A could resolve after run B started and write A's tradeoff under B's
        // program. The store's own run token is the guard: the result lands only while the run that
        // asked for it still owns the hold.
        const idealEpoch = runEpoch;
        set({ idealPlan: { status: 'comparing', tradeoff: null } });
        // #1049 — THE OWNED OUTCOME IS REUSED ONLY WHILE THE RUN IS CURRENT. `staleSince` is the
        // store's own marker that the job, shop or inventory moved after Generate; the held plan
        // then no longer describes the job, so the press passes none and the worker plans both
        // halves again rather than comparing against a stale plan.
        const held = get().staleSince === null ? get().generated?.plan?.outcome ?? null : null;
        // #1151 — its OWN worker when the client has one: the shared sim worker stays free for the
        // sweep, so the comparison cannot queue the simulation behind it.
        const planIdeal = idealClient.engravePlanIdealOnItsOwnWorker ?? idealClient.engravePlanIdeal;
        void planIdeal!(idealJob, idealJob.targetObject!, idealTool, idealShop, getTools().map((entry) => entry.tool), held, catalogue)
          .then((answer) => {
            if (runEpoch === idealEpoch) set({ idealPlan: { status: 'ready', tradeoff: answer.tradeoff } });
          })
          .catch(() => {
            if (runEpoch === idealEpoch) set({ idealPlan: { status: 'idle', tradeoff: null } });
          });
      };
      // The press repeats the SAME computation on demand (E's review, item 3) — never just the
      // recorded choice.
      idealLastRequest = fireIdealCompare;
      // #1151 — Generate deferred the comparison: start it now, with the owned result in hand.
      if (deferredIdeal) fireIdealCompare();
    }
    // #787 — every finding the run raised, small enough for the report to carry.
    for (const f of generated.findings) noteFinding(f);
    if (!generated.ok || generated.nc === null) {
      set({ phase: 'blocked' });
      noteWorkEnd('generate', 'refused');
      activeClient = null;
      return;
    }

    if (!tool) {
      set({ phase: 'blocked', error: 'the job has no usable cutter' });
      noteWorkEnd('generate', 'refused');
      activeClient = null;
      return;
    }

    set({
      phase: 'simulating',
      progress: null,
      log: appendRunLog(get().log, 'simulating the programs in cut order', Date.now(), logStartedAt),
    });

    // #744 — ONE SWEEP PER PROGRAM, IN CUT ORDER, ON THE STOCK THE EARLIER ONES LEFT. The walk is
    // the command line's own (`engine/cnc/engrave/programSweep.ts`, #733 item 4 extracted, so the
    // two realms cannot disagree). This adapter supplies what is THIS realm's: the worker load,
    // the setup, the machine and the package's frame and floor, and the oracle while the first
    // engraving program is still the session's live one.
    const setup = toSetup(job, jobMachine(job, calibration), mount?.fixture, bed, undefined, shop.defaults ?? null);
    // #723 P2-2b-ii — each program's own setup work frame, for carrying the remaining stock
    // between sides. A saved setup's rotation is the planner's own (`orient`), over the stock's
    // bounds; a setup the mount cannot hold has no frame, and the carry then refuses by name
    // rather than seeding a flipped side the wrong way round.
    const stockSize = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
    const stockBounds = {
      min: [0, 0, 0] as [number, number, number],
      max: [stockSize.x, stockSize.y, stockSize.z] as [number, number, number],
    };
    const carryFrames: (CarrySetup | null)[] = jobSetups(job).map((s) => {
      const o = orient(s.orientation.top, s.mount, stockSize);
      return o.ok ? { rotation: o.matrix, bounds: stockBounds } : null;
    });
    /** The setup each cumulative prior-removal mesh came from, aligned with the walk's list. */
    const seedSources: number[] = [];
    /** #723 P2-2b — the last FLAT field a column-swept program left, for the next setup's floor. */
    let lastFlat: { setupIndex: number; field: FlatField } | null = null;
    /**
     * #1034 — THE CARRIED FLOOR BELONGS TO THE SETUP, NOT THE FIRST PROGRAM OF IT. It is computed
     * once at the boundary (from the last field of a DIFFERENT setup) and handed to every program
     * of the new setup, so a same-setup successor keeps the floor state it is judged on.
     */
    let carriedFor: { setupIndex: number; carried: CarriedField } | null = null;
    /**
     * #1034 — THIS SETUP'S OWN EARLIER PROGRAMS' REMAINING TOPS. The sweep's own `priorFields`
     * accumulate across setups and a field carries no affine map, so the store keeps them per
     * setup: a program seeds from its predecessor when that predecessor is in ITS setup. This is
     * the per-predecessor rule; the old all-chain test dropped the field path for the rest of a
     * flipped setup once any cross-setup mesh appeared in the chain.
     */
    const fieldsBySetup = new Map<number, CarriedField[]>();
    /** #1034 — the label of the last program that ran in each setup, named as the next seed. */
    const lastProgramBySetup = new Map<number, string>();
    const firstEngravingIndex = generated.programs.findIndex((p) => (p.kind ?? 'engrave') !== 'facing');
    // #743 P-5 — A BOARD IS JUDGED BY ITS COPPER'S TOPOLOGY, on the WHOLE run's swept stock. The
    // volumetric comparison is program 1's own; a board's isolation, holes and outline are three
    // programs, and a short is only visible after all of them have cut.
    //
    // #743 P-8 — ONE CHECK PER FACE. A two-sided board's isolation frames live in different setups
    // and different work frames, so each side is read on the LAST program of ITS setup (the sweep
    // then holds every cut that side took), against that side's own copper. The run report carries
    // the per-face verdicts and the sum, so the gate and the sheet state both.
    const pcbSides = pcbCopperTopologyInputs(job, shop.defaults ?? null);
    const lastIndexOfSetup = new Map<number, number>();
    generated.programs.forEach((program, index) => lastIndexOfSetup.set(program.setupIndex, index));
    // #743 P-8 — THE CHECK READS THE PROGRAM THAT DREW THE SEPARATION. The design's last-program
    // reading assumed the earlier programs' material is carried into it, but a board's isolation
    // is a cone, and the column engine (which sweeps a cone) hands back no removal mesh — so the
    // later programs' sweeps hold none of the isolation, and a last-program check would read the
    // board's copper uncut. The isolation's OWN program is the sweep that contains the cut, on
    // both sides; the drills and the cut-out remove material the copper check does not ask about.
    // #1032 — THE SAME CUTTER, BY ANY OF ITS IDENTITIES. A result stored before the posted
    // header carried registry keys stamps the tool's id or name; the side names its own registry
    // key. Compare the bench's answers, not the strings, so the old and the new header find the
    // same program.
    const sameCutter = (postedKey: string, cutterKey: string): boolean => {
      if (postedKey === cutterKey) return true;
      const posted = benchCutterFor(postedKey);
      return posted !== null && posted === benchCutterFor(cutterKey);
    };
    const isolationIndexOf = (side: (typeof pcbSides)[number]): number => {
      const cutterKey = side.cutterKey;
      const at =
        cutterKey === null
          ? -1
          : generated.programs.findIndex((p) => p.setupIndex === side.setupIndex && sameCutter(p.toolKey, cutterKey));
      return at >= 0 ? at : (lastIndexOfSetup.get(side.setupIndex) ?? -1);
    };
    const copperSides: CopperSideReport[] = [];
    // #445 §4 — the thread facts belong to the first engraving program, the one
    // `generated.threads` describes; a facing pass or a later program states none.
    // #848 — a program that carries its OWN thread plans is swept with them: a boss cut before its
    // thread makes the thread mill program 2. A result stored before the field keeps the old rule.
    const threadsFor = (index: number) => {
      const own = generated.programs[index]?.threads;
      if (own !== undefined) return own === null ? [] : own.flatMap((t) => t.simThreads);
      return index === firstEngravingIndex ? (generated.threads?.flatMap((t) => t.simThreads) ?? []) : [];
    };
    // #844 — ONE VERDICT PER PROGRAM, collected by the walk's `afterLoad` while each program is
    // still the session's live one. `copperReport` is the board's own combined check, which spans
    // several programs and stays the run-level verdict it was.
    const oracles: { index: number; report: OracleReport }[] = [];
    let copperReport: OracleReport | null = null;
    // #955/V2-2 — the edge-break allowance's GATE parameters, from the job's own edgeBreak and the
    // tools this run posts (never from the CAM's plan, A's R3). No edge break → no allowance.
    const goalEdge = goalEdgeBreakOptions(
      job,
      // #1032 — the three-identity resolver (`benchCutterFor`): a posted key is not always a
      // registry key (the built-in tier stamps an id or a name), and both sites must read the
      // same rule the command line's bench sweep does.
      (key) => (key === job.toolKey ? tool : benchCutterFor(key)),
      generated.programs.map((p) => p.toolKey),
    );
    let outcome: ProgramSweepOutcome;
    try {
      outcome = await sweepPrograms<SweepProgram & { setupIndex: number }>({
        programs: generated.programs,
        // The sim store applies the shop's `drill.pointAngleDeg` when a program states no point,
        // so this realm's fallback is null (the command line reads the shop itself).
        shopDrillPoint: null,
        cutterFor: (program) =>
          program.toolKey === job.toolKey ? tool : benchCutterFor(program.toolKey),
        load: async ({ program, index, cutter, drillPoint, priorRemoval, priorExactRemoval, fromBlank }) => {
          // #830 — the simulation's own stage: which program of the sweep is being simulated, so
          // the panel never shows a bare "Working…" through a multi-program sweep.
          if (mine === seq) {
            set({
              simProgram: { index: index + 1, count: generated.programs.length },
              log: appendRunLog(get().log, `simulating program ${index + 1} of ${generated.programs.length}`, Date.now(), logStartedAt),
            });
          }
          // #896 — AND IT IS IN THE FLIGHT RECORDER, which logged nothing during a simulation: a
          // crash report could not say which program was sweeping, or how far it got.
          const label = programLabel(generated.programs, index);
          noteStage('generate', 'simulate', `sweeping ${label}`, index + 1, generated.programs.length);
          try {
            // #723 P2-2b-ii — CARRY THE SIDES. The walk hands us the earlier programs' remaining
            // solids in the frame of the program that cut them; a program in a later setup starts
            // from them in ITS frame. A same-setup rest pass passes the mesh straight through.
            const priorList: readonly NodeMeshOutput[] = priorRemoval ?? [];
            const seeds = carrySeedsForSetup(
              priorList.map((mesh, k) => ({ mesh, setupIndex: seedSources[k] ?? program.setupIndex })),
              program.setupIndex,
              carryFrames,
            );
            // #723 P2-2b — the CARRIED FIELD. A column-swept program (a ball finish is one) takes
            // the other side's remaining stock as each column's floor; the maps come from the two
            // setups' frames. A side setup declines the carry and simulates from its own stock.
            // #1034 — computed at the SETUP BOUNDARY and kept for the whole later setup: a
            // same-setup successor (side 2's finish after side 2's rough) is judged on the same
            // carried floor state as the setup's first program, never a bare blank.
            let carried: CarriedField | null = null;
            if (carriedFor !== null && carriedFor.setupIndex === program.setupIndex) {
              carried = carriedFor.carried;
            } else if (lastFlat !== null && lastFlat.setupIndex !== program.setupIndex) {
              const from = carryFrames[lastFlat.setupIndex - 1] ?? null;
              const to = carryFrames[program.setupIndex - 1] ?? null;
              if (from !== null && to !== null) {
                const maps = carriedMaps(from, to);
                if (maps.ok) {
                  carried = { ...lastFlat.field, ...maps.maps };
                  carriedFor = { setupIndex: program.setupIndex, carried };
                }
              }
            }
            // #1034 — THE SEED IS THE PREDECESSOR'S, when that predecessor is in this setup.
            // C's review: ON A RETRY THE LOAD IS THE SWEEP'S BLANK. `fromBlank` clears every
            // same-setup seed and the label with it — the engine already refused that material,
            // and a retry that quietly kept the fields would read as seeded while the sweep and
            // the panel say it restarted from the blank (#948's exactRun reset reads the same
            // absence). The carried floor is NOT a same-setup seed; it stays by design (#1032).
            const setupFields = fromBlank ? null : (fieldsBySetup.get(program.setupIndex) ?? null);
            const seedFrom =
              setupFields === null ? null : (lastProgramBySetup.get(program.setupIndex) ?? null);
            const seedEarlier = setupFields === null ? 0 : Math.max(0, setupFields.length - 1);
            if (!seeds.ok) {
              return {
                ok: false as const,
                pathOnly: false,
                diagnostics: [
                  {
                    source: 'sweep' as const,
                    severity: 'error' as const,
                    code: 'sim-error',
                    message: `${programLabel(generated.programs, index)}: ${seeds.message}`,
                  },
                ],
              };
            }
            // #1050 — WHICH ROUTE SEEDED THIS LOAD, so the panel can name it. The field route is
            // the one `seedFrom` already names; the exact route is a load handed the earlier
            // programs' removal meshes with no field to point at, and it used to fall through every
            // sentence. A blank restart is neither. A program with BOTH says 'field' (#1034's
            // wording wins, unchanged).
            const seedRoute: 'field' | 'removal' | null =
              fromBlank === true ? null : seedFrom !== null ? 'field' : seeds.meshes.length > 0 ? 'removal' : null;
            const result = await useSimStore.getState().loadProgram(
              program.nc,
              // #725 B7 — the wasteboard is the setup's under-board for a bed job: a through cut
              // may enter it, and the sweep's bed floor is the board's underside.
              setup,
              cutter,
              job.machineId,
              calibration,
              threadsFor(index),
              // #434 — THIS program's planned point; the store falls back to the shop's for null.
              drillPoint,
              // #506 — this load belongs to the engrave run, not the Simulate panel. Both share
              // `simStore` (so the viewport shows the sweep); the origin is what stops the panel
              // presenting this finished Result under its own empty file row.
              'engrave',
              // #623 — the package's OWN frame, not the `surface` argument this call was made with.
              generated.surface ?? null,
              // #629 — the ramp the column engine should name, for THIS cutter.
              rampThresholdMm(generated.predicted, cutter),
              // #734 — the floor the CAM posted a through move against.
              job.breakthrough,
              // #744 — the cumulative stock the earlier programs left.
              // #723 P2-2b-ii — carried into THIS program's setup frame.
              seeds.meshes.length === 0 ? null : seeds.meshes,
              carried,
              // #817/#1034 — the column programs' remaining tops from THIS setup's own earlier
              // programs (a field carries no affine map between setups); kept per setup so a
              // flipped setup's later programs seed from their own predecessor.
              setupFields,
              priorExactRemoval ?? null,
              // #1040 — the walk's from-blank retry is still THIS run: keep the run-wide goal fold.
              fromBlank === true,
            );
            if (result !== null) {
              // Keep the frame bookkeeping aligned with the walk's own list: only a load that
              // actually produced a removal mesh is appended there.
              if (result.ok && result.meshes.removal !== null) seedSources.push(program.setupIndex);
              if (result.ok) {
                // A column sweep hands back its final top field; a later setup starts from it.
                if (result.flatField != null) lastFlat = { setupIndex: program.setupIndex, field: result.flatField };
                // #1034 — this setup's chain keeps its own remaining tops, and its predecessor's
                // label is what the next program's panel sentence names.
                if (result.removalField != null) {
                  const own = fieldsBySetup.get(program.setupIndex) ?? [];
                  fieldsBySetup.set(program.setupIndex, [...own, result.removalField]);
                  // The label names the program whose field is the LATEST in the seed list; the
                  // earlier ones are counted (`seedEarlier`) so the sentence never understates.
                  lastProgramBySetup.set(program.setupIndex, label);
                }
              }
              // #1032 (6b's review) — SAY WHAT THE RESTART KEPT. A program that can only sweep
              // from the blank still had the earlier setup's carried floor; the panel must not
              // read as "the carry was lost". #1034 — and a program seeded from its own setup's
              // predecessor names that predecessor.
              return result.ok ? { ...result, carriedFloor: carried !== null, seedFrom, seedEarlier, seedRoute } : result;
            }
            const sim = useSimStore.getState();
            // null means this load no longer owns the session (a newer run/panel load stopped it),
            // and the walk stops quietly. A WORKER that failed is different: the sweep cannot go
            // on, and nothing about this program was judged — so it leaves as a STOP carrying the
            // worker's own words, never as a finding against the program that happened to be
            // loading. #830 review: a stopped simulation is not a failed one.
            if (sim.status !== 'error') return null;
            throw new SimulationStopped(sim.error ?? 'the simulation worker stopped');
          } catch (e) {
            // Every other throw from a load is the same kind of fact — no verdict was reached
            // (a cut-off call, the time budget) — so it is a stop too, in the worker's words.
            throw e instanceof SimulationStopped ? e : new SimulationStopped(e instanceof Error ? e.message : String(e));
          }
        },
        afterLoad: async ({ index, program }) => {
          // THE ORACLE RUNS WHILE THE PROGRAM IT JUDGES IS STILL THE SESSION'S LIVE ONE — the walk
          // awaits this hook before loading the next.
          // #896 — the check is a stage of its own in the recorder, per program.
          noteStage('generate', 'check', `checking ${programLabel(generated.programs, index)} against the design`);
          if (pcbSides.length > 0) {
            // #743 P-5 — the board's own check, on the sweep that has finished drawing this side.
            const side = pcbSides.find((s) => isolationIndexOf(s) === index);
            if (side !== undefined) {
              const report = await client.simOracle([], side.input);
              if (report.copper !== undefined) {
                copperSides.push({ face: side.faceUp, ...report.copper });
                const copper = combineCopperSides(copperSides);
                copperReport = { ...report, copper, ok: report.ok && copper.ok };
              }
            }
          }
          // #844 — EVERY PROGRAM JUDGES ITS OWN FILE. A result stored before the field existed
          // carries no per-program list: program 1 then falls back to the top-level `predicted`
          // (exactly what today did), and a later program with nothing predicted is not compared.
          const isFirst = index === firstEngravingIndex;
          const predicted = program.predicted ?? (isFirst ? generated.predicted : undefined);
          // #948 — A GOAL PROGRAM IS JUDGED AGAINST ITS GOAL, not only against the plan: the
          // worker samples the goal's heightfield and pairs it with this program's live sweep.
          // #966 — THE GATE IS THE JOB'S OWN SHAPE, NOT WHICH ENGINE CUT IT. `generated.surface3d`
          // used to be a safe proxy for "this is a goal program" because only the heightfield path
          // ever set it; the model-engine path (#966) posts a goal job's programs with a real
          // `verify` and no `surface3d`, which read as an item job under the old proxy and silently
          // skipped the goal check. `pureGoalObject(job)` is the document's own test (`jobKind.ts`)
          // and answers the same question directly, for either engine — an item job sends nothing
          // and runs exactly as before.
          // #948 — AND EVERY PROGRAM OF A GOAL JOB IS JUDGED, predicted items or not. A goal
          // job's rest pass posts a file with no predicted regions (there is no 2.5D plan
          // comparison for it), and the old early return skipped the oracle — so the run judged
          // the finish program's sweep alone, and the run's one goal field (the page stamps every
          // program onto it) never received the rest pass's cuts.
          const rotaryGoalMap = rotaryMapOf(job, liveShopDefaults());
          const goal = goalCheckForProgram(
            job,
            pureGoalObject(job) !== null,
            {
              passCoverage: goalPassCoverage(shopDefaults),
              // #1207 — the shop's own three goal bands ride the check with the pass line.
              leftoverBandsMm: [
                readDefault(shopDefaults ?? null, 'acceptance.leftoverBand1Mm').value,
                readDefault(shopDefaults ?? null, 'acceptance.leftoverBand2Mm').value,
                readDefault(shopDefaults ?? null, 'acceptance.leftoverBand3Mm').value,
              ],
              // #1064 (d) — the plan's own bevel prediction, stated beside the measurement.
              ...(generated.plan?.outcome?.predictedCutIntoMm == null
                ? {}
                : { predictedCutIntoMm: generated.plan.outcome.predictedCutIntoMm }),
              ...goalEdge,
            },
            // #1083 — a rotary goal is judged on the map; the store holds the job, so the map's
            // own radius and section ride along (goalCheckInput must not import the CAM).
            rotaryGoalMap === null ? null : { radius: rotaryGoalMap.radius, section: rotaryGoalMap.section },
          );
          const goalOnly = goal !== undefined && (predicted === undefined || predicted.length === 0);
          if (predicted === undefined && !goalOnly) return;
          if (!isFirst && predicted !== undefined && predicted.length === 0 && !goalOnly) return;
          // #924 activation — the program's own raw design items ride the same call `predicted`
          // does, so the app's OWN Generate runs the design-side check (#924) against this file's
          // sweep. Read off the generated program rather than the walk's `SweepProgram` view (which
          // carries only what the loader needs); same fallback as `predicted` above — a result
          // stored before the per-program field existed hands program 1 the run's top-level list —
          // and a program with no items runs exactly as it did before (the check is only defined
          // for V-carve/flat engrave items).
          const designItems =
            generated.programs[index]?.designItems ?? (isFirst ? generated.designItems : undefined);
          // #948 — the pass line is the SHOP's `goal.passCoverage`, read here and handed over with
          // the goal, so the worker's check judges against the number the page's checker reads.
          const report = await client.simOracle([...(predicted ?? [])], undefined, designItems, goal);
          if (mine !== seq) return;
          oracles.push({ index, report });
        },
        aborted: () => mine !== seq,
      });
    } catch (e) {
      // #830 review — a sweep that threw reached NO verdict: the worker stopped, or a call was cut
      // off. The run blocks with the worker's own words (the panel frames them as the simulation
      // stopping) and the checklist reads "stopped before it finished", never a failed check. A
      // throw from anywhere else in the walk is a generation failure and keeps its own sentence.
      if (mine === seq) {
        set({
          phase: 'blocked',
          error: e instanceof Error ? e.message : String(e),
          ...(e instanceof SimulationStopped ? { simStopped: true } : {}),
        });
      }
      noteWorkEnd('generate', 'failed');
      activeClient = null;
      return;
    }
    if (mine !== seq) return;

    // The unattributed facts first, then the one projection the gate reads. In a MULTI-program run
    // every diagnostic carries its program's label, so Save/Upload/Release return the failing
    // program's own sentence; a single-program run keeps exactly the text it has always had.
    const summaries: ProgramSweepSummary[] = outcome.sweeps.map(sweepSummary);
    if (!outcome.ok && outcome.failed !== null) {
      const failure: ProgramSweepFailure = outcome.failed;
      if (failure.sweep !== null) {
        summaries.push(sweepSummary(failure.sweep));
      } else {
        // The program that stopped the walk produced no sweep. Its refusal is still a reason, and
        // the gate has to name the program — so a refusal with no error text gains one.
        const diagnostics =
          simErrors(failure.diagnostics).length > 0
            ? failure.diagnostics
            : [
                ...failure.diagnostics,
                { source: 'sweep' as const, severity: 'error' as const, code: 'simulation-refused', message: 'the simulation refused this program' },
              ];
        summaries.push(refusalSummary({ ...failure, diagnostics }));
      }
    }
    // #744 — the attribution rule is the shared one (`programSweep.attributedDiagnostics`), so the
    // run row, the run sheet and the command line number a program's sentence the same way. The
    // count is the RUN's files, not the results: a walk stopped at its first program still names it.
    const simDiagnostics = attributedDiagnostics(summaries, generated.programs.length > 1);
    const firstSwept = summaries.find((s) => s.index === firstEngravingIndex) ?? summaries[0] ?? null;

    // #1048 — THE SWEEP WALK IS DONE; the worker is free. Now the background ideal may have it.

    if (!outcome.ok) {
      set({
        phase: 'blocked',
        simPrograms: summaries,
        simDiagnostics,
        // A sweep that RAN with errors is 'ready' — the gate reads the errors; anything else here
        // is the simulator's own refusal of a program it was given. A dead worker never reaches
        // this branch: it stops the walk with `SimulationStopped`, so there is no verdict to
        // record and the panel states the stop once, beside Generate.
        simStatus: outcome.failed?.kind === 'diagnostics' ? 'ready' : 'refused',
        pathOnly: outcome.failed?.pathOnly ?? false,
        simEngine: firstSwept?.engine ?? null,
        simGridPitchMm: firstSwept?.gridPitchMm ?? null,
      });
      noteWorkEnd('generate', 'refused');
      activeClient = null;
      return;
    }

    set({
      phase: 'checking',
      log: appendRunLog(get().log, 'checking the result against the goal and the design', Date.now(), logStartedAt),
      simStatus: 'ready',
      simDiagnostics,
      pathOnly: false,
      simEngine: firstSwept?.engine ?? null,
      simGridPitchMm: firstSwept?.gridPitchMm ?? null,
      simPrograms: summaries,
    });
    // #535 — THE CHECK RECORDS THE SWEEP THAT RAN, PER PROGRAM. Each surface program states the dexel
    // grid ITS OWN sweep used (a later program can be a different engine from the first).
    if (generated.programs.some((p) => p.surfaceCheck != null)) {
      const pitch = new Map(summaries.map((s) => [s.index, s.gridPitchMm] as const));
      set({
        generated: {
          ...generated,
          programs: generated.programs.map((p, i) =>
            p.surfaceCheck == null ? p : { ...p, surfaceCheck: { ...p.surfaceCheck, gridPitchMm: pitch.get(i) ?? null } },
          ),
        },
      });
    }

    try {
      // The walk ran each program's oracle while that program was live. A run with no first
      // engraving program cannot reach here (`generated.nc` IS that program), but say so rather
      // than compare the wrong session.
      if (oracles.length === 0 && copperReport === null) throw new Error('the prediction was not checked');
      const oracle = combineOracles(oracles.map((o) => o.report), copperReport);
      // #1035 — the last goal-carrying program is the one whose coverage decides the run; every
      // earlier goal program's coverage is deferred to it, and its evidence says so.
      const lastGoalIndex = oracles.reduce<number>(
        (last, o, i) => (o.report.goalCutInto === undefined ? last : i),
        -1,
      );
      const oraclePrograms: ProgramOracle[] = oracles.map((o, i) => ({
        index: o.index,
        label: programLabel(generated.programs, o.index),
        report: o.report,
        goalCoverageDeferred: goalCoverageDeferred(o.report, i === lastGoalIndex),
      }));
      if (mine !== seq) return;
      set({ oracle, oraclePrograms, phase: oracle.ok ? 'ready' : 'blocked' });
    } catch (e) {
      if (mine === seq) set({ phase: 'blocked', error: e instanceof Error ? e.message : String(e) });
    }
    noteWorkEnd('generate', 'done');
    activeClient = null;
  }

  return {
    generated: null,
    idealPlan: { status: 'idle', tradeoff: null },
    oracle: null,
    oraclePrograms: [],
    simDiagnostics: [],
    simStatus: null,
    pathOnly: false,
    simEngine: null,
    simGridPitchMm: null,
    simPrograms: [],
    runMount: null,
    phase: 'idle',
    acknowledged: false,
    acknowledgedFor: null,
    staleSince: null,
    staleReason: null,
    inputs: null,
    shopSignature: null,
    restoreNote: null,
    restoreChecking: false,
    buildCompare: null as BuildCompare | null,
    changedSinceLast: [],
    previousVerdict: null,
    lastGenerateMs: null,
    error: null,
    progress: null,
    log: [] as RunLogEntry[],
    simProgram: null,
    simStopped: false,
    // #893 — THE RUN HOLDS THE MEASURED PICK: it writes the cutter plan into the job, and a job
    // that changes mid-run makes the run stale the moment it finishes (the maintainer's elephant
    // goal stopped at "generated · not checked yet" for exactly this). Held for the run, released
    // for the next edit — the preview keeps drawing.
    // #986 (E's review) — the press re-runs the computation, not just the choice.
    comparePlans: () => {
      idealLastRequest?.();
    },
    generate: async (surface?: SurfacePostFit | null, opts?: { restLadder?: boolean }) => {
      const startedAt = Date.now();
      const token = Symbol('generate');
      runHold = token;
      runEpoch += 1;
      useEngravePreviewStore.getState().holdMeasurement();
      try {
        await run(surface ?? null, opts === undefined ? {} : { ...opts });
      } finally {
        // A newer run (or a cancel) may own the hold by now: only its owner releases it.
        if (runHold === token) {
          runHold = null;
          useEngravePreviewStore.getState().releaseMeasurement();
        }
        // #1132 — the honest cost the Cut card quotes for a regenerate.
        set({ lastGenerateMs: Date.now() - startedAt });
      }
    },
    /** #893 — re-run the sweep and the check for the program already on screen. */
    simulate: async () => {
      await run(null, { simulateOnly: true });
    },
    /** #1191 — a restored run made by another build: this build's verifier, then the sweep. */
    recheckRestoredRun: async (restored) => {
      const generated = restored.generated;
      if (generated === null) return;
      // A new Generate (or another restore) replaced the run this check was asked about.
      if (get().generated !== generated) return;
      const job = useEngraveJobStore.getState().job;
      const calibration = useSettingsStore.getState().machineCalibration ?? null;
      const machine = jobMachine(job, calibration);
      const shopDefaults = useShopDefaultsStore.getState().defaults;
      const mount = jobMountObstacles(job, shopDefaults);
      const bed = bedUnderFacts(
        machineForJob(useLocationStore.getState().location, job.machineId),
        shopDefaults,
        job.breakthrough + 1,
        { length: job.stock.length, width: job.stock.width },
      );
      const check = recheckStoredPrograms({
        job,
        generated,
        machine,
        mount,
        setup: toSetup(job, machine, mount?.fixture, bed, undefined, shopDefaults),
      });
      set({ generated: check.generated });
      if (check.errors.length > 0) {
        // THE BYTES FAIL THIS BUILD: say which program and what it found; Load is off because the
        // gate's verifier rows now carry the error, and Generate is the way forward.
        const first = check.errors[0]!;
        set({
          phase: 'blocked',
          error:
            `This build's verifier refused the stored program ${first.programIndex + 1}` +
            `${first.frame ? "'s frame file" : ''}: ${first.finding.message}`,
        });
        return;
      }
      // THE SWEEP AND THE DESIGN/GOAL CHECK, on the stored bytes: the same simulate-only path the
      // Cut step's "Simulate again" press uses. The planner never runs.
      await get().simulate();
    },
    /**
     * #1191 — A NOT-YET-STARTED JOB MAY BE COMPARED. With no program finished, this build plans
     * the job in the BACKGROUND and compares program hashes with the restored run. The restored
     * run is never modified: identical says nothing; different is the operator's choice, and
     * keeping is the default.
     */
    compareRestoredPlan: async () => {
      const restored = get().generated;
      if (restored === null || restored.programs.length === 0) return;
      if (get().staleSince !== null) return;
      if (get().buildCompare?.status === 'checking') return;
      const job = useEngraveJobStore.getState().job;
      set({ buildCompare: { status: 'checking', changed: 0, total: restored.programs.length } });
      try {
        // The same inputs the Generate press would resolve (see `run`): the comparison must plan
        // the job the operator has, not a second reading of it.
        const calibration = useSettingsStore.getState().machineCalibration ?? null;
        const margins = effectiveMargins(job, useSettingsStore.getState().margins);
        const shopDefaults = useShopDefaultsStore.getState().defaults;
        const mount = jobMountObstacles(job, shopDefaults);
        const bed = bedUnderFacts(
          machineForJob(useLocationStore.getState().location, job.machineId),
          shopDefaults,
          job.breakthrough + 1,
          { length: job.stock.length, width: job.stock.width },
        );
        const shop: EngraveShopOpts = { ...engraveShopOpts(shopDefaults), mount, bed };
        const tool = jobTool(job);
        if (tool === null) {
          set({ buildCompare: { status: 'kept', changed: 0, total: restored.programs.length } });
          return;
        }
        const client = await clientForGenerate();
        const fresh = await client.engraveGenerate(
          job,
          tool,
          feedCatalogueRows(),
          calibration,
          margins,
          shop,
          undefined,
          getTools().map((entry) => entry.tool),
          true,
        );
        // The run was replaced while this planned (a press, another restore): say nothing.
        if (get().generated !== restored) return;
        if (!fresh.ok || fresh.programs.length === 0) {
          set({ buildCompare: { status: 'kept', changed: 0, total: restored.programs.length } });
          return;
        }
        const before = restored.programs.map((program) => program.programHash);
        // Multiplicity-aware: a hash the new plan lost or gained counts once per occurrence.
        const counts = new Map<string, number>();
        for (const program of fresh.programs) counts.set(program.programHash, (counts.get(program.programHash) ?? 0) + 1);
        let changed = 0;
        for (const hash of before) {
          const left = counts.get(hash) ?? 0;
          if (left === 0) changed++;
          else counts.set(hash, left - 1);
        }
        for (const left of counts.values()) changed += left;
        set({
          buildCompare:
            changed === 0
              ? { status: 'same', changed: 0, total: before.length }
              : { status: 'different', changed, total: before.length },
        });
      } catch {
        // A comparison that could not run says NOTHING — never a false "this build plans it
        // differently" from a worker that never answered. `kept` also stops the surface asking
        // again, so a broken worker cannot loop.
        set({ buildCompare: { status: 'kept', changed: 0, total: restored.programs.length } });
      }
    },
    /** #1191 — the default is KEEP: the restored programs stay, and the offer goes. */
    keepRestoredPlan: () =>
      set((state) =>
        state.buildCompare === null
          ? {}
          : { buildCompare: { ...state.buildCompare, status: 'kept' } },
      ),
    cancelGenerate: () => {
      const phase = get().phase;
      if (phase !== 'generating' && phase !== 'simulating' && phase !== 'checking') return;
      // #893 — the cancelled run may never reach its own `finally` (its awaited worker call is
      // orphaned, not rejected): release the preview hold here, and leave a newer run's alone.
      if (runHold !== null) {
        runHold = null;
        useEngravePreviewStore.getState().releaseMeasurement();
      }
      // Orphan the in-flight run FIRST, so its late result (if any) can never write state...
      seq += 1;
      // ...then kill the worker. A synchronous wasm call cannot hear a message; termination is the
      // one stop that works, and the next call recreates the worker.
      activeClient?.cancelGenerate?.();
      activeClient = null;
      noteWorkEnd('generate', 'cancelled');
      set({
        ...empty,
        generated: get().generated,
        // Back to what the panel showed before the press — not a blank slate the operator has to
        // reconstruct. A phase that was itself a run state reads as idle.
        phase:
          phaseBeforeRun === 'generating' || phaseBeforeRun === 'simulating' || phaseBeforeRun === 'checking'
            ? 'idle'
            : phaseBeforeRun,
      });
    },
    setAcknowledged: (v) => set(v ? { acknowledged: true } : { acknowledged: false, acknowledgedFor: null }),
    acknowledgeProgram: (hash) => set({ acknowledged: true, acknowledgedFor: hash }),
    reportDiagnostic: (diagnostic) =>
      set((state) => ({ simDiagnostics: [...state.simDiagnostics, diagnostic] })),
    reset: () => {
      seq += 1; // orphan any run in flight
      if (runHold !== null) {
        runHold = null;
        useEngravePreviewStore.getState().releaseMeasurement();
      }
      set({ generated: null, ...empty, lastGenerateMs: null, phase: 'idle' });
    },
  };
});

// Any edit to the job after a Generate makes the result stale (#206). This is the whole
// "subscribe to engraveJobStore" requirement; nothing else may clear `staleSince` but a
// fresh Generate.
//
// #425 — NOT every document write is an edit. Freezing a package (`setPackage`) and recording a
// run outcome (`appendRunLog`) replace the job object but change neither its fingerprint nor a
// single program: the package's own staleness check excludes both blocks for the same reason. A
// naive reference check here would mark the Generate stale the instant Cut froze its own package,
// so the run would refuse itself before the first upload. Compare fingerprints instead.
useEngraveJobStore.subscribe((state, prev) => {
  if (state.job === prev.job) return;
  // #581 follow-up — compare the job to the RUN'S OWN stamp, not to the previous object: an origin
  // write (a new object whose `jobFingerprint` is unchanged, #621/#627) must not stale the result.
  const run = useEngraveRunStore.getState();
  if (run.inputs === null) return;
  if (jobFingerprint(state.job) === run.inputs.job) return;
  markStale('job');
});

// So does a change to the machine's saved frame (#301). The program was posted, verified and
// simulated against the frame read when Generate started (#297); a DIFFERENT FRAME is a different
// machine, and Save and Upload must not carry on offering the old result. The comparison is the
// #581 stamp of the frame (`machineKey` — machineId, frame, soft endstop), not the read: saving a
// new read of the same numbers is not a different machine.
//
// #642 — and so do the depth margins, the settings store's other stamped input: they gate the
// program (`effectiveMargins`), and a change to `zTolerance` alone used to go unnoticed.
useSettingsStore.subscribe((state, prev) => {
  const run = useEngraveRunStore.getState();
  if (run.inputs === null) return;
  if (state.machineCalibration !== prev.machineCalibration && machineKey(state.machineCalibration ?? null) !== run.inputs.machine) {
    markStale('machine');
  }
  if (state.margins !== prev.margins) {
    staleIfMoved('margins', marginsKey(effectiveMargins(useEngraveJobStore.getState().job, state.margins)));
  }
});

/** #581 — the mark carries WHICH input moved, so the row can say "the job changed" and not guess. */
function markStale(reason: EngraveInputKey): void {
  const s = useEngraveRunStore.getState();
  if (s.generated && s.staleSince === null) useEngraveRunStore.setState({ staleSince: Date.now(), staleReason: reason });
}

/**
 * #1123 — THE SHOP'S IDENTITY AT THE PRESS. The house's own validators are the reference (a
 * 304-re-read is the same shop); the statuses are part of it because a page that could not reach
 * the house ('absent') is a different shop from one that read it ('present'), even when both
 * carry no validator. Stored with the run, compared after a reload by `store/runPersistence`.
 */
export function runShopSignature(): string {
  const location = useLocationStore.getState();
  const tools = useToolRegistryStore.getState();
  return [
    `location:${location.status}:${location.etag ?? ''}`,
    `tools:${tools.status}:${tools.etag ?? ''}`,
    `feeds:${tools.feedEtag ?? ''}`,
    `inventory:${tools.inventoryEtag ?? ''}`,
  ].join('|');
}

/**
 * #1123 — RECHECK A RESTORED RUN. The watchers above fire on store CHANGES; after a reload the
 * stores are already settled, so nothing would fire and a restored run would read as matching
 * even when its margins, machine frame, shop, feeds, catalogue, cutters or fitted surface moved
 * while the app was closed. Compare every input now, and mark the first that moved stale (the
 * same marks, with the same first-reason rule).
 *
 * `current` is a spec seam: the caller may state the stamps instead of making the stores produce
 * them (the persistence spec compares a fabricated run against a changed feeds stamp).
 */
export function currentRunInputStamps(): EngraveRunInputs {
  const job = useEngraveJobStore.getState().job;
  const settings = useSettingsStore.getState();
  return runInputs({
    job,
    margins: effectiveMargins(job, settings.margins),
    calibration: settings.machineCalibration ?? null,
    shopDefaults: useShopDefaultsStore.getState().defaults,
    feeds: resolvedFeedsTable().table,
    catalogue: feedCatalogueRows(),
    tools: dedupeCutterEntries(getTools()),
    conditions: inventoryConditions(),
    surface: useEngraveRegistrationStore.getState().records[job.id]?.surface ?? null,
  });
}

/**
 * #1123/#1132 — every input the run stamped that no longer matches the stores as they stand now,
 * in `RUN_INPUT_ORDER`. This is the precise "did anything the program depends on move?" test; the
 * restore's recheck and the registration-only re-freeze both read it.
 */
export function movedRunInputs(current?: EngraveRunInputs): EngraveInputKey[] {
  const run = useEngraveRunStore.getState();
  if (run.inputs === null) return [];
  const stamps = current ?? currentRunInputStamps();
  return RUN_INPUT_ORDER.filter((key) => stamps[key] !== run.inputs![key]);
}

export function recheckRunInputs(current?: EngraveRunInputs): void {
  const run = useEngraveRunStore.getState();
  if (run.inputs === null || run.generated === null) return;
  const moved = movedRunInputs(current);
  if (moved[0] !== undefined) markStale(moved[0]);
}

/**
 * #642 — SUBSCRIBE TO WHAT THE STAMP STAMPS. The gates read the #581 stamp, but only the job and the
 * machine frame were watched: the shop defaults, the feeds table, the synced catalogue, the cutters'
 * conditions and the registration's fitted surface could all move after Generate and leave Save and
 * Upload green. Each watcher recomputes ITS input's stamp from the same values the run hashed (the
 * `*Key` functions `runInputs` itself uses) and marks the run stale with that input named. The
 * comparisons are STAMPS, never object identity, like the two subscriptions above: a re-read of the
 * same numbers is not a change.
 */
function staleIfMoved(key: EngraveInputKey, current: string): void {
  const run = useEngraveRunStore.getState();
  if (run.inputs === null) return;
  if (current === run.inputs[key]) return;
  markStale(key);
}

useShopDefaultsStore.subscribe((state, prev) => {
  // A re-read of the same document is a new object with the same values; `shopKey` settles it.
  if (state.defaults === prev.defaults) return;
  staleIfMoved('shop', shopKey(state.defaults));
});

useFeedTableStore.subscribe((state, prev) => {
  // `rows` is the source; a busy flag or a notice is not a table. The engine's snapshot is installed
  // by the store's read (`setLocatedFeedTable`), so it already holds the rows this state describes.
  if (state.rows === prev.rows) return;
  staleIfMoved('feeds', feedsKey(resolvedFeedsTable().table));
});

useToolRegistryStore.subscribe((state, prev) => {
  // Any refresh can replace the tool list, the catalogue snapshot or the inventory's conditions; the
  // engine snapshots are installed before the store's set, so they are read here as they now stand.
  if (state.entries === prev.entries && state.feedCount === prev.feedCount && state.items === prev.items) return;
  staleIfMoved('catalogue', catalogueKey(feedCatalogueRows()));
  // #1123 — the RUN stamped `cutters` from the deduped list `engraveShopOpts` hands the worker;
  // comparing the raw registry here marked every restored run stale for a list the run never saw.
  staleIfMoved('cutters', cuttersKey(dedupeCutterEntries(getTools()), inventoryConditions()));
});

useEngraveRegistrationStore.subscribe((state, prev) => {
  // The Cut step re-posts against the FIRST registration's fitted surface; a new registration is a new
  // frame to post against. Read the CURRENT job's record: after a job switch the job subscription has
  // already marked the run stale, and `markStale` keeps the first reason.
  if (state.records === prev.records) return;
  const job = useEngraveJobStore.getState().job;
  staleIfMoved('surface', surfaceKey(state.records[job.id]?.surface ?? null));
});

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
import { create } from 'zustand';
import type { EngraveJob, EngraveMargins } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';
import type { EngraveGenerated, EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { OraclePredicted, OracleReport } from '@/engine/cnc/engrave/oracle';
import type { SimDiagnostic } from '@/workers/sim/session';
import type { SimStatus } from './simStore';
import { clampPlacementsFor, jobMount, jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { bracketMount } from '@/engine/cnc/mounts/bracket';
import { bedUnderFacts, machineForJob } from '@/platform/bedProfiles';
import { useLocationStore } from './locationStore';
import { isVShape } from '@/engine/cnc/vProfile';
import { feedCatalogueRows, resolvedFeedsTable } from '@/engine/cnc/feeds';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { jobMachine } from '@/engine/cnc/calibration';
import { getTools, entryFor } from '@/engine/cnc/toolRegistry';
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
  shopKey,
  surfaceKey,
  type EngraveInputKey,
  type EngraveRunInputs,
} from '@/engine/cnc/engrave/runInputs';
import type { SurfacePostFit } from '@/engine/cnc/engrave/surfaceSpread';
import { useSettingsStore } from './settingsStore';
import { useEngraveJobStore } from './engraveJobStore';
import { useSimStore } from './simStore';
import { shopDefault, useShopDefaultsStore } from './shopDefaultsStore';
import { useFeedTableStore } from './feedTableStore';
import { useToolRegistryStore } from './toolRegistryStore';
import { useEngraveRegistrationStore } from './engraveRegistrationStore';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import type { EngraveRunPhase } from './engraveRunGate';
import {
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

/** The two worker calls the run needs. */
export type EngraveRunClient = {
  engraveGenerate: (
    job: EngraveJob,
    tool: Tool | null,
    catalogue: readonly FeedCatalogueRow[],
    calibration: MachineCalibration | null,
    margins: EngraveMargins,
    /** The engrave pipeline's shop defaults (#451) — see `run` for why they are read here. */
    shop?: EngraveShopOpts,
  ) => Promise<EngraveGenerated>;
  simOracle: (predicted: OraclePredicted[]) => Promise<OracleReport>;
};

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

export interface EngraveRunState {
  /** The last generated result — kept on screen while a newer run builds. */
  generated: EngraveGenerated | null;
  oracle: OracleReport | null;
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
  phase: EngraveRunPhase;
  /** The clearance acknowledgement (see `ACKNOWLEDGE_CODES`), reset on every Generate. */
  acknowledged: boolean;
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
  /** #581 — the inputs that differ from the previous Generate's; empty on the first run. */
  changedSinceLast: EngraveInputKey[];
  /** #581 — the previous Generate's oracle verdict, so a ✓↔× flip can say what changed. */
  previousVerdict: boolean | null;
  /** A thrown failure from any stage that is not already a finding (generate, load, oracle). */
  error: string | null;
  /** Run the whole pipeline for the job as it is NOW. `surface` (#608) re-posts against a tilt. */
  generate: (surface?: SurfacePostFit | null) => Promise<void>;
  setAcknowledged: (v: boolean) => void;
  /**
   * #490 — record a diagnostic that did not come from a sim stage: the panel's error boundary
   * writes a render crash here, into the same list the run sheet reads, so a panel that threw
   * still leaves a sentence the report can carry. Kept on the run, not on the job.
   */
  reportDiagnostic: (diagnostic: SimDiagnostic) => void;
  /** Forget the run (and the staleness). Does not touch the job. */
  reset: () => void;
}

let seq = 0;

export const useEngraveRunStore = create<EngraveRunState>()((set, get) => {
  const empty = {
    oracle: null,
    simDiagnostics: [] as SimDiagnostic[],
    simStatus: null as SimStatus | null,
    pathOnly: false,
    simEngine: null as 'exact' | 'column' | null,
    simGridPitchMm: null as number | null,
    simPrograms: [] as ProgramSweepSummary[],
    acknowledged: false,
    staleSince: null as number | null,
    staleReason: null as EngraveInputKey | null,
    inputs: null as EngraveRunInputs | null,
    changedSinceLast: [] as EngraveInputKey[],
    previousVerdict: null as boolean | null,
    error: null as string | null,
  };

  async function run(surface: SurfacePostFit | null = null): Promise<void> {
    const job = useEngraveJobStore.getState().job;
    const mine = ++seq;
    // #581 — WHAT THE RUN BEFORE THIS ONE SAW, captured before the reset below clears the result.
    // The verdict is the comparison point; the inputs are what the new run's stamp is diffed
    // against, so a disagreement can name the input that moved.
    const before = get();
    const previousVerdict = before.oracle === null ? null : before.oracle.ok;
    const previousInputs = before.inputs;
    set({ ...empty, phase: 'generating', generated: get().generated });

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
    const mount = bracketMount(
      { x: job.stock.length, y: job.stock.width, z: job.stock.thickness },
      jobMount(job),
      shopDefaults,
      job.sacrificial.under?.thickness ?? 0,
      // #707 BM-1 — the job's OWN clamps. The default pair is only the starting place a new
      // bracket job is given, never what an edited job is checked against.
      clampPlacementsFor(job),
    );
    // #712 — the bed's through-cut facts, resolved HERE for the same reason the mount is: the
    // active bed profile lives in the location, and the worker must not read it. The need is the
    // job's own (`breakthrough + 1`), so a board the sentence names is one that really passes.
    // #730 — the JOB's machine, not the house's first: `machineId` is its profile id.
    const bed = bedUnderFacts(machineForJob(useLocationStore.getState().location, job.machineId), shopDefaults, job.breakthrough + 1, {
    length: job.stock.length,
    width: job.stock.width,
  });
    const shop: EngraveShopOpts = {
      lostDetailWarnRatio: shopDefault('engrave.lostDetailWarnRatio').value,
      peckClearanceMm: shopDefault('drill.peckClearanceMm').value,
      defaults: shopDefaults,
      // #450 slice 3 — the table the worker's `feedsFor` resolves against. Read from this realm,
      // like the catalogue below and for the same reason: the worker cannot see the location, and
      // a program built on the compiled rows would disagree with the panel's.
      feeds: resolvedFeedsTable().table,
      // #432 slice 2 — the cutter list the facing pass chooses from, sent for the same reason the
      // catalogue is (the worker's registry is empty). The snapshotted list, not a re-read after the
      // await: the facing tool must be one the picker this run was started from shows.
      tools: getTools(),
      // #432 review R10 — the bench's condition summaries, read in the SAME snapshot as the cutter
      // list and for the same worker-realm reason: `toolCondition`'s map is main-thread state, and
      // the worker's copy is empty. A broken cutter must be skipped by the pick the worker makes,
      // not only by the one the panel shows.
      conditions: inventoryConditions(),
      mount,
      bed,
      // #472 — the rest pass's two numbers, read from the location in the SAME snapshot as the
      // others. The worker cannot import the defaults client (`houseClient` drags the transport
      // into that realm), so the resolved values and their sources cross as plain data; absent,
      // the generator uses its labelled fallback pair.
      rest: {
        overlap: shopDefault('rest.overlapMm'),
        thirdToolPct: shopDefault('rest.thirdToolPct'),
      },
      // #250 — the finish pass's allowance, from the SAME snapshot and for the same worker-realm
      // reason. The worker splits each flat region into a roughing pass that leaves this much on the
      // walls and floor and a finishing pass at full depth; the source travels so the run sheet can
      // say where the number came from. This line is what makes the shipped app use the finish pass;
      // a caller that omits it (a preview, a direct-engine test) cuts in one pass as before.
      finish: {
        stockToLeaveMm: shopDefault('finish.stockToLeaveMm'),
      },
      // #535 — the goal operation's heightfield pitch, from the SAME snapshot and for the same
      // worker-realm reason. A pure goal job samples its heightfield at this pitch unless the
      // operation states its own; the source travels so the row and the run sheet print where the
      // number came from. Absent, the CAM's labelled `DEFAULT_GRID_PITCH_MM`.
      surfaceGrid: {
        pitchMm: shopDefault('sim.columnFlatPitchYMm'),
      },
      // #434 — the drill numbers (`drill.peckDiameters`, `drill.peckClearanceMm`,
      // `drill.pointAngleDeg`, `drill.plungeFeed`, `drill.spindleRpm`) from the SAME snapshot,
      // with each one's source. A drill program's plan and its depth findings read this reading
      // rather than re-resolving the location in the worker.
      drill: drillSettings(shopDefaults),
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
      changedSinceLast: previousInputs === null ? [] : changedInputs(previousInputs, inputs),
      previousVerdict,
    });

    let client: EngraveRunClient;
    let generated: EngraveGenerated;
    try {
      client = await clientLoader();
      generated = await client.engraveGenerate(job, tool, catalogue, calibration, margins, shop);
    } catch (e) {
      if (mine === seq) set({ phase: 'blocked', error: e instanceof Error ? e.message : String(e) });
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
    const stale = changedJob || changedMachine || changedMargins;
    if (stale) {
      // #581 — name which one moved; the generic sentence is only for a caller that cannot know.
      set({
        generated,
        phase: 'blocked',
        staleSince: Date.now(),
        staleReason: changedJob ? 'job' : changedMachine ? 'machine' : 'margins',
      });
      return;
    }

    set({ generated });
    if (!generated.ok || generated.nc === null) {
      set({ phase: 'blocked' });
      return;
    }

    if (!tool) {
      set({ phase: 'blocked', error: 'the job has no usable cutter' });
      return;
    }

    set({ phase: 'simulating' });

    // #744 — ONE SWEEP PER PROGRAM, IN CUT ORDER, ON THE STOCK THE EARLIER ONES LEFT. The walk is
    // the command line's own (`engine/cnc/engrave/programSweep.ts`, #733 item 4 extracted, so the
    // two realms cannot disagree). This adapter supplies what is THIS realm's: the worker load,
    // the setup, the machine and the package's frame and floor, and the oracle while the first
    // engraving program is still the session's live one.
    const setup = toSetup(job, jobMachine(job, calibration), mount?.fixture, bed);
    const firstEngravingIndex = generated.programs.findIndex((p) => (p.kind ?? 'engrave') !== 'facing');
    const multiProgram = generated.programs.length > 1;
    // #445 §4 — the thread facts belong to the first engraving program, the one
    // `generated.threads` describes; a facing pass or a later program states none.
    const threadsFor = (index: number) =>
      index === firstEngravingIndex ? (generated.threads?.flatMap((t) => t.simThreads) ?? []) : [];
    // A holder, not a `let`: the assignment happens inside the walk's `afterLoad` callback, which
    // TypeScript's control-flow analysis cannot see through.
    const oracleBox: { report: OracleReport | null } = { report: null };
    let outcome: ProgramSweepOutcome;
    try {
      outcome = await sweepPrograms<SweepProgram>({
        programs: generated.programs,
        // The sim store applies the shop's `drill.pointAngleDeg` when a program states no point,
        // so this realm's fallback is null (the command line reads the shop itself).
        shopDrillPoint: null,
        cutterFor: (program) =>
          program.toolKey === job.toolKey ? tool : (entryFor(program.toolKey)?.tool ?? null),
        load: async ({ program, index, cutter, drillPoint, priorRemoval }) => {
          try {
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
              priorRemoval,
            );
            if (result !== null) return result;
            const sim = useSimStore.getState();
            // null means this load no longer owns the session: a newer run/panel load stopped it
            // (the walk stops quietly), or the worker failed (block, naming this program).
            if (sim.status !== 'error') return null;
            return {
              ok: false as const,
              pathOnly: false,
              diagnostics: [
                {
                  source: 'sweep' as const,
                  severity: 'error' as const,
                  code: 'sim-error',
                  message: `${programLabel(generated.programs, index)}: ${sim.error ?? 'the simulation failed'}`,
                },
              ],
            };
          } catch (e) {
            return {
              ok: false as const,
              pathOnly: false,
              diagnostics: [
                {
                  source: 'sweep' as const,
                  severity: 'error' as const,
                  code: 'sim-error',
                  message: `${programLabel(generated.programs, index)}: ${e instanceof Error ? e.message : String(e)}`,
                },
              ],
            };
          }
        },
        afterLoad: async ({ index }) => {
          // THE PREDICTION IS THE FIRST ENGRAVING PROGRAM'S. The oracle compares it against the
          // sweep of THAT program, so it runs while that program is still the session's live one —
          // the walk awaits this hook before loading the next.
          if (index === firstEngravingIndex) oracleBox.report = await client.simOracle(generated.predicted);
        },
        aborted: () => mine !== seq,
      });
    } catch (e) {
      if (mine === seq) set({ phase: 'blocked', error: e instanceof Error ? e.message : String(e) });
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
    const attribute = (summary: ProgramSweepSummary): SimDiagnostic[] => {
      const load = multiProgram
        ? summary.diagnostics.map((d) => ({
            ...d,
            // A diagnostic that already names its program (the walk's `no-cutter` sentence) is not
            // given the label a second time.
            message: d.message.startsWith(summary.label) ? d.message : `${summary.label}: ${d.message}`,
          }))
        : summary.diagnostics;
      // The from-blank note names its program itself; prefixing it would say it twice.
      return [...load, ...summary.notes];
    };
    const simDiagnostics = summaries.flatMap(attribute);
    const firstSwept = summaries.find((s) => s.index === firstEngravingIndex) ?? summaries[0] ?? null;
    const sim = useSimStore.getState();

    if (!outcome.ok) {
      set({
        phase: 'blocked',
        simPrograms: summaries,
        simDiagnostics,
        // A sweep that RAN with errors is 'ready' — the gate reads the errors. Only a refusal (or a
        // worker failure) is anything else, exactly as the single-program run has always read it.
        simStatus: outcome.failed?.kind === 'diagnostics' ? 'ready' : sim.status === 'error' ? 'error' : 'refused',
        pathOnly: outcome.failed?.pathOnly ?? false,
        simEngine: firstSwept?.engine ?? null,
        simGridPitchMm: firstSwept?.gridPitchMm ?? null,
        error: sim.status === 'error' ? sim.error : null,
      });
      return;
    }

    set({
      phase: 'checking',
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
      // The walk ran the oracle while program 1 was live. A run with no first engraving program
      // cannot reach here (`generated.nc` IS that program), but say so rather than compare the
      // wrong session.
      if (oracleBox.report === null) throw new Error('the prediction was not checked');
      const oracle = oracleBox.report;
      if (mine !== seq) return;
      set({ oracle, phase: oracle.ok ? 'ready' : 'blocked' });
    } catch (e) {
      if (mine === seq) set({ phase: 'blocked', error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    generated: null,
    oracle: null,
    simDiagnostics: [],
    simStatus: null,
    pathOnly: false,
    simEngine: null,
    simGridPitchMm: null,
    simPrograms: [],
    phase: 'idle',
    acknowledged: false,
    staleSince: null,
    staleReason: null,
    inputs: null,
    changedSinceLast: [],
    previousVerdict: null,
    error: null,
    generate: run,
    setAcknowledged: (v) => set({ acknowledged: v }),
    reportDiagnostic: (diagnostic) =>
      set((state) => ({ simDiagnostics: [...state.simDiagnostics, diagnostic] })),
    reset: () => {
      seq += 1; // orphan any run in flight
      set({ generated: null, ...empty, phase: 'idle' });
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
  staleIfMoved('cutters', cuttersKey(getTools(), inventoryConditions()));
});

useEngraveRegistrationStore.subscribe((state, prev) => {
  // The Cut step re-posts against the FIRST registration's fitted surface; a new registration is a new
  // frame to post against. Read the CURRENT job's record: after a job switch the job subscription has
  // already marked the run stale, and `markStale` keeps the first reason.
  if (state.records === prev.records) return;
  const job = useEngraveJobStore.getState().job;
  staleIfMoved('surface', surfaceKey(state.records[job.id]?.surface ?? null));
});

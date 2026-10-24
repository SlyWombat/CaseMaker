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
import { jobMount, jobTool, toSetup } from '@/engine/cnc/engrave/jobSetup';
import { bracketMount } from '@/engine/cnc/mounts/bracket';
import { feedCatalogueRows, resolvedFeedsTable } from '@/engine/cnc/feeds';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import { jobMachine } from '@/engine/cnc/calibration';
import { getTools } from '@/engine/cnc/toolRegistry';
import { inventoryConditions } from '@/engine/cnc/toolCondition';
import type { MachineCalibration } from '@/engine/cnc';
import { effectiveMargins } from '@/engine/cnc/engrave/depthBounds';
import { jobFingerprint } from '@/engine/cnc/engrave/package';
import type { SurfacePostFit } from '@/engine/cnc/engrave/surfaceSpread';
import { useSettingsStore } from './settingsStore';
import { useEngraveJobStore } from './engraveJobStore';
import { useSimStore } from './simStore';
import { shopDefault, useShopDefaultsStore } from './shopDefaultsStore';
import { drillSettings } from '@/engine/cnc/cam/drillBit';
import type { EngraveRunPhase } from './engraveRunGate';

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
  uploadBlocker,
  releaseBlocker,
  oracleSentence,
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
  if (!featureSim) throw new Error('the engrave run is not enabled in this build');
  return import('@/engine/jobs/simClient');
};
let clientLoader: () => Promise<EngraveRunClient> = loadClient;
/** For tests: swap the (lazy) client for a fake. */
export function setEngraveRunClientLoader(fn: (() => Promise<EngraveRunClient>) | null): void {
  clientLoader = fn ?? loadClient;
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
  phase: EngraveRunPhase;
  /** The clearance acknowledgement (see `ACKNOWLEDGE_CODES`), reset on every Generate. */
  acknowledged: boolean;
  /** Set when the job changed after a Generate; null while the result still matches. */
  staleSince: number | null;
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
    acknowledged: false,
    staleSince: null as number | null,
    error: null as string | null,
  };

  async function run(surface: SurfacePostFit | null = null): Promise<void> {
    const job = useEngraveJobStore.getState().job;
    const mine = ++seq;
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
    );
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
    // was gated against the one read at the top. The margins are compared by VALUE rather than by
    // the settings object, because a job carrying its own record keeps them whatever the house
    // setting does — comparing the setting would block a run the user did not change.
    const nowMargins = effectiveMargins(useEngraveJobStore.getState().job, useSettingsStore.getState().margins);
    const stale =
      useEngraveJobStore.getState().job !== job ||
      (useSettingsStore.getState().machineCalibration ?? null) !== calibration ||
      nowMargins.boundaryMargin !== margins.boundaryMargin;
    if (stale) {
      set({ generated, phase: 'blocked', staleSince: Date.now() });
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
    try {
      await useSimStore
        .getState()
        .loadProgram(
          generated.nc,
          toSetup(job, jobMachine(job, calibration), mount?.fixture),
          tool,
          job.machineId,
          calibration,
          // The threads this program mills (#445 §4): plain dimensions the column engine can state
          // the annular band from. Empty for every non-thread job, leaving today's behaviour.
          generated.threads?.flatMap((t) => t.simThreads) ?? [],
          // #434 — the point angle the drill PLAN used, when this program is a drill bit's: the
          // column engine sweeps the point the CAM planned instead of re-reading the setting.
          generated.drill?.simDrillPoint ?? null,
          // #506 — this load belongs to the engrave run, not the Simulate panel. Both share
          // `simStore` (so the viewport shows the sweep); the origin is what stops the panel
          // presenting this finished Result under its own empty file row.
          'engrave',
        );
    } catch (e) {
      if (mine === seq) set({ phase: 'blocked', error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (mine !== seq) return;

    const sim = useSimStore.getState();
    if (sim.status !== 'ready') {
      set({ phase: 'blocked', simStatus: sim.status, simDiagnostics: sim.diagnostics, pathOnly: sim.pathOnly, error: sim.status === 'error' ? sim.error : null });
      return;
    }
    set({ phase: 'checking', simStatus: sim.status, simDiagnostics: sim.diagnostics, pathOnly: sim.pathOnly, simEngine: sim.info?.stats.engine ?? null });

    try {
      const oracle = await client.simOracle(generated.predicted);
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
    phase: 'idle',
    acknowledged: false,
    staleSince: null,
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
  if (jobFingerprint(state.job) === jobFingerprint(prev.job)) return;
  markStale();
});

// So does a change to the machine's saved frame (#301). The program was posted, verified and
// simulated against the frame read when Generate started (#297); a different frame is a different
// machine, and Save and Upload must not carry on offering the old result.
useSettingsStore.subscribe((state, prev) => {
  if (state.machineCalibration === prev.machineCalibration) return;
  markStale();
});

function markStale(): void {
  const s = useEngraveRunStore.getState();
  if (s.generated && s.staleSince === null) useEngraveRunStore.setState({ staleSince: Date.now() });
}

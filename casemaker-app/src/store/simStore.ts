/**
 * Simulation state (#182 step 8b): plain data and mesh buffers, nothing else.
 *
 * Deliberately NOT entries in `jobStore.nodes`. `applyResult` replaces that whole map on every
 * case rebuild, and the node-id namespace is enumerated by export, `FloatersBanner`,
 * `PartsMenu` and `PartThumbnail` — a sim mesh there would leak into exported STLs. This store
 * holds no wasm handle either: meshes arrive as transferred ArrayBuffers.
 *
 * There is no UI yet (it waits on a mockup). The client is reached by a dynamic `import()`
 * behind `featureSim` (#343), so a build with the flag off contains neither it nor the worker.
 */

import { featureSim } from '@/platform/features';
import { create } from 'zustand';
import type { MachineCalibration, PausePoint, Setup } from '@/engine/cnc';
import { resolveMachine } from '@/engine/cnc/calibration';
import { MACHINES } from '@/engine/cnc/machine';
// The one statement of the simulation's safety rule (#393). Safe in the web bundle: it imports a
// TYPE from the worker session, nothing else.
import { simulationProblem } from '@/engine/cnc/simGate';
import { useSettingsStore } from '@/store/settingsStore';
import { shopDefault } from '@/store/shopDefaultsStore';
import { stepAtTime, timeAtStep, totalTime } from '@/engine/cnc/playbackClock';
import { generateRestart as buildRestart, stockFromSetup, type RestartResult } from '@/engine/cnc/restart';
import type { Tool } from '@/engine/cnc/tool';
import { checkpointAtStep } from '@/components/viewport/simGeometry';
import type { SimDesign, SimDiagnostic, SimFrame, SimLoadOk, SimLoadResult, SimPath } from '@/workers/sim/session';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
// Type-only: erased at build time, so it does not pull the worker client into the graph.
import type { SimLoadPhase } from '@/engine/jobs/simClient';
// Type-only, like `SimLoadPhase`: the thread dimensions travel as plain numbers (#445 §4).
import type { SimThreadSpec } from '@/engine/cnc/cam/threadMill';
// `SimStatus` lives in `types/simStatus.ts` so a headless caller can name the type without pulling
// this store (and through it the browser-only sim client and worker) into the scripts graph (#544).
import type { SimStatus } from '@/types/simStatus';

export type { SimStatus } from '@/types/simStatus';

/**
 * Who started the current session (#506). The Simulate panel and the engrave run's verify stage
 * share this one store — the engrave run legitimately drives it so the viewport shows its sweep —
 * so a session has to remember whose it is. Only the panel presents a session as the result of the
 * file in its own form; a `'engrave'` load is shown in the viewport and reported through
 * `engraveRunStore`, never as this panel's Result.
 */
export type SimSessionOrigin = 'panel' | 'engrave';

/** The playback speed multipliers the transport offers (#198): a wall-clock multiplier. */
export const SIM_SPEEDS = [1, 5, 20, 100] as const;
export type SimSpeed = (typeof SIM_SPEEDS)[number];
/**
 * The default speed. DECISION (#198 left it silent): 20×, matching the approved mockup (#195).
 * At the DISPLAY rapid rate a real job would otherwise take minutes before the first cut.
 *
 * #451: the value is the shop's `sim.playbackSpeed`, read when a session starts; this constant is
 * its labelled no-service fallback (`defaultsClient.ts` restates the same number).
 */
const DEFAULT_SPEED: SimSpeed = 20;

/** The speed a session starts at (#451): the shop's, or the labelled fallback. */
function startingSpeed(): SimSpeed {
  const n = shopDefault('sim.playbackSpeed').value;
  return (SIM_SPEEDS as readonly number[]).includes(n) ? (n as SimSpeed) : DEFAULT_SPEED;
}

/** Which viewport layers the simulation draws (#197). Stock and gouges are always drawn. */
export interface SimLayers {
  /** The removed volume so far, as a translucent ghost. */
  removed: boolean;
  /** The cutting part of the path (kind 1 and 2). */
  path: boolean;
  /** The rapid moves, dashed. */
  rapids: boolean;
  /** The tool at the current step. */
  tool: boolean;
  /** The fixture (vise jaws) boxes, when the setup models them. */
  fixture: boolean;
  /** The sacrificial material as cut so far (#213 §4), when the job has any. */
  sacrificial: boolean;
  /**
   * #519 item 1 — the registration's touches: a dot per reading on the stock, coloured by verdict
   * (`registrationTouchesStore`). Independent of every other layer; stays on as a record after the
   * registration so the spread the sheet reports can be seen.
   */
  touches: boolean;
}

/** All layers on: a fresh load shows the finished part with the whole path. */
export const DEFAULT_SIM_LAYERS: SimLayers = { removed: true, path: true, rapids: true, tool: true, fixture: true, sacrificial: true, touches: true };

/** True when the simulation owns the viewport: a completed load, or a path-only one (#194). */
export const isSimSceneActive = (s: Pick<SimState, 'status' | 'pathOnly'>): boolean =>
  s.status === 'ready' || (s.status === 'refused' && s.pathOnly);

/** Everything in a successful load except what has its own field. */
export type SimLoadInfo = Omit<SimLoadOk, 'ok' | 'diagnostics' | 'meshes'>;

/** Checkpoints swept so far on the load in progress (#194). */
export interface SimProgress {
  done: number;
  total: number;
}

/**
 * Wall-clock limit a load starts with, ms (#194). Written out rather than imported from
 * `simClient`: that module is reached only by dynamic import so the worker stays out of the
 * production graph, and importing a constant from it here would pull it in. `simClient`'s
 * `SIM_BUDGET_MS` is the counterpart — keep the two equal. Both are the LABELLED no-service
 * fallback for the ONE seed `sim.budgetMs` (#451): each reads the location at use time.
 */
export const DEFAULT_SIM_BUDGET_MS = 60_000;

/**
 * The budget a fresh session starts with (#451): the shop's `sim.budgetMs`, or the fallback.
 * A retry doubles whatever the session is running on; a NEW session reads the seed again.
 */
function startingBudgetMs(): number {
  return shopDefault('sim.budgetMs').value;
}

export interface SimState {
  status: SimStatus;
  /**
   * Who started this session (#506): the Simulate panel or the engrave run. The two share this
   * store, so this is what stops one's finished run being presented as the other's.
   */
  origin: SimSessionOrigin | null;
  /**
   * The program text this session was loaded with (#506), null while idle. The Simulate panel
   * compares it with the file open in its form: a Result belongs to the program it swept, not to
   * whichever `.nc` happens to be in the form afterwards.
   */
  loadedProgram: string | null;
  /** #726 W8 — when this session last took a program, ms (see `SimSetupState.openedAt`). */
  loadedAt: number | null;
  error: string | null;
  diagnostics: SimDiagnostic[];
  info: SimLoadInfo | null;
  meshes: SimLoadOk['meshes'] | null;
  /** The cutter this session was loaded with (#554), for the sim's tool-head layer. */
  tool: Tool | null;
  /** The frame on screen, and the checkpoint it is for. */
  frame: SimFrame | null;
  k: number;
  /**
   * #716 slice 2 — how the material is drawn: the rod in the chuck (`stock`, default) or the same
   * columns unrolled onto the map (`map`, Unroll). A view, not a document value.
   */
  design: SimDesign;
  /** The whole path with kinds and times, fetched once per load (#197). */
  path: SimPath | null;
  /**
   * The current program step (#197). Defaults to the LAST step, so a fresh load shows the
   * finished part; the transport (#198) and the scrubber move it via `setStep`.
   */
  step: number;
  /** Total program steps (`summary.steps`): the scrubber's upper bound and `step N / M` (#198). */
  stepCount: number;
  /** The program's pause points (#198): the scrubber's only markers and the clock's stop set. */
  pauses: PausePoint[];
  /** True while the transport's clock is running (#198). */
  playing: boolean;
  /** Wall-clock multiplier for playback (#198). */
  speed: SimSpeed;
  /** Program time in seconds at the current position (#198). */
  seconds: number;
  /** The pause the clock stopped at, for the callout; null otherwise (#198). */
  stoppedAt: PausePoint | null;
  /** Which viewport layers the simulation draws (#197). */
  layers: SimLayers;
  /** Sweep progress while `status === 'loading'`, null otherwise (#194). */
  progress: SimProgress | null;
  /**
   * Which stage of a load is running while `status === 'loading'` (#224): `sweep` for the
   * sweep, `playback` while the anchor chain is warmed up. null when not loading.
   */
  phase: SimLoadPhase | null;
  /** True when the runner succeeded and only the sweep refused: the path is drawable, no material (#194). */
  pathOnly: boolean;
  /**
   * The last restart generated for the loaded program (#249), or null. Cleared by every load so
   * a restart always belongs to the program on screen. The generated `.nc` is not stored here —
   * only what the panel needs to show it.
   */
  restart: RestartResult | null;
  /** The limit the next `loadProgram` uses, ms; `retryWithLongerBudget` doubles it (#194). */
  budgetMs: number;
  /**
   * `calibration` is the saved frame the caller already resolved its OWN machine with (#297). Omit it
   * and the store reads the settings itself, once; pass it (including `null`, meaning "none") and that
   * exact answer is the one simulated, so a caller that also generated against it cannot be split.
   */
  loadProgram(
    gcodeText: string,
    setup: Setup,
    tool: Tool,
    machineId: string | null,
    calibration?: MachineCalibration | null,
    /** The threads the program mills (#445 §4), as the CAM planned them; plain data, consumed by the sweep. */
    threads?: readonly SimThreadSpec[],
    /**
     * #434 — the drill point default the PROGRAM was planned with, so the column engine sweeps the
     * point the CAM used instead of re-reading the setting. Omitted/null keeps the shop read
     * (`drill.pointAngleDeg`), which is what every non-drill program does.
     */
    drillPointDefault?: { deg: number; source: string } | null,
    /**
     * #506 — who started this session. The engrave run passes `'engrave'`; the panel (and the QA
     * harness that drives the panel's path) takes the default. The panel only presents a session
     * it started, so a shared store cannot show the engrave verification as the panel's Result.
     */
    origin?: SimSessionOrigin,
    /**
     * #623 — the fitted surface the program was posted against (`EngraveGenerated.surface`), when the
     * Cut step re-posted against a measured tilt. The session seats the swept stock on that plane
     * and judges the oracle in the same frame. Omitted/null: a flat post, unchanged.
     */
    surface?: SurfaceFrame | null,
    /**
     * #629 — half the job's smallest level step, mm, passed to the column engine so it names a ramp
     * that can cross a level. Omitted/null: the ramp check is off.
     */
    rampThresholdMm?: number | null,
    /**
     * #734 — how far the job's through cuts may reach below the blank, mm (the engrave document's
     * `breakthrough`), so the sweep's floor is the floor the CAM posted against. Omitted/null: the
     * blank's bottom, unchanged for every non-engrave load.
     */
    breakthroughMm?: number | null,
    /**
     * #744 — the material earlier programs of this run left, one removal mesh each. Every program
     * after the first is swept on the stock the earlier ones left; the session unions the list.
     * Omitted/null/empty: the blank. The RETURNED result is what the multi-program walk reads;
     * `null` means this load no longer owned the session (a newer load superseded it).
     */
    priorRemoval?: NodeMeshOutput | readonly NodeMeshOutput[] | null,
  ): Promise<SimLoadResult | null>;
  /** Run the last load again with twice the time limit (#194). No-op when nothing has been loaded. */
  retryWithLongerBudget(): Promise<void>;
  /**
   * Generate a restart `.nc` for the loaded program, resuming at `step` (default: the current
   * step). Refuses when the resume state cannot be re-established, and — like every other
   * producer of a file — when the loaded program failed the simulation (#395); the result is
   * stored in `restart` (#249). No-op when nothing has been loaded.
   */
  generateRestart(opts?: { step?: number; baseName?: string }): void;
  /** Discard the generated restart (#249). */
  clearRestart(): void;
  /** Show checkpoint k (-1 = uncut). Coalesced by the client. */
  seek(k: number): void;
  /**
   * #716 slice 2 — switch Stock | Unroll. Re-asks the client for the SAME checkpoint in the new
   * frame; nothing about the session, the program or the checkpoint changes.
   */
  setDesign(design: SimDesign): void;
  /**
   * Move the current step (#197): sets `step`, derives the checkpoint `k = checkpointAtStep(...)`
   * and seeks to it ONLY when `k` changed, so scrubbing within one checkpoint costs no seek.
   * Also snaps `seconds` to the step's program time (#198) and clears any pause callout.
   */
  setStep(step: number): void;
  /** Start playing from the current position (#198). At the end, restarts from the beginning. */
  play(): void;
  /** Stop the clock without changing the position (#198). */
  pause(): void;
  /** Set the wall-clock multiplier (#198). */
  setSpeed(n: SimSpeed): void;
  /**
   * Set the program time (#198), moving the step to the last vertex at or before it. The one
   * action the playback loop calls per frame: it keeps sub-step time, where `setStep` snaps.
   */
  seekSeconds(s: number): void;
  /** Move the current step by ±1, clamped to the program (#198). */
  stepBy(delta: number): void;
  /** Jump to the first step at time 0 (#198). */
  toStart(): void;
  /** Jump to the last step, so the final `meshes.result` is shown (#198). */
  toEnd(): void;
  /** Take the clock into a stopped state: `pause` for a named pause point, `null` for the end (#198). */
  halt(pause: PausePoint | null): void;
  /** Toggle one viewport layer (#197). */
  toggleLayer(layer: keyof SimLayers): void;
  dispose(): Promise<void>;
}

export type SimClient = typeof import('@/engine/jobs/simClient');

const loadClient = async (): Promise<SimClient> => {
  if (!featureSim) throw new Error('the simulation is not enabled in this build');
  return import('@/engine/jobs/simClient');
};
let clientLoader: () => Promise<SimClient> = loadClient;
/** For tests: swap the (lazy) client for a fake. */
export function setSimClientLoader(fn: (() => Promise<SimClient>) | null): void {
  clientLoader = fn ?? loadClient;
}

const EMPTY = {
  status: 'idle' as SimStatus,
  origin: null as SimSessionOrigin | null,
  loadedProgram: null as string | null,
  /** #726 W8 — when this session last took a program, ms (see `SimSetupState.openedAt`). */
  loadedAt: null as number | null,
  error: null,
  diagnostics: [] as SimDiagnostic[],
  info: null,
  meshes: null,
  tool: null as Tool | null,
  frame: null,
  k: -1,
  design: 'stock' as SimDesign,
  path: null,
  step: -1,
  stepCount: 0,
  pauses: [] as PausePoint[],
  playing: false,
  speed: DEFAULT_SPEED,
  seconds: 0,
  stoppedAt: null,
  layers: DEFAULT_SIM_LAYERS,
  progress: null,
  phase: null,
  pathOnly: false,
  restart: null as RestartResult | null,
};
let loadSeq = 0;
/**
 * The arguments of the most recent load, so `retryWithLongerBudget` can run it again (#194), and
 * so `generateRestart` verifies against the same machine (#279).
 *
 * `calibration` is read from the settings store ONCE, at the load, and kept for the later restart
 * for the same reason `machine` is: a restart has to be lowered through the profile the job was
 * simulated on, and re-reading a setting mid-session could silently swap the frame underneath it.
 */
interface LoadArgs {
  gcodeText: string;
  setup: Setup;
  tool: Tool;
  machineId: string | null;
  calibration: MachineCalibration | null;
  /** #506 — whose session this is, kept so a retry cannot change the presentation owner. */
  origin: SimSessionOrigin;
  /** The shop's `drill.pointAngleDeg`, read once at the load like `calibration` (#382). */
  drillPointDefault: { deg: number; source: string };
  /** The shop's `sim.columnFlatPitchYMm`, read once at the load for the same reason (#438). */
  flatPitchYMm: number;
  /** The shop's `sim.columnPitchXMm` and `sim.rotaryPitchDeg` (#451), read once at the load. */
  columnPitchXMm: number;
  rotaryPitchDeg: number;
  /** The shop's `sim.spindleOffProximityMm` (#451), read once at the load. */
  spindleOffProximityMm: number;
  /**
   * The threads the program mills (#445 §4), as plain data. Kept with the load so a retry (and
   * the restart's verify) sees the same threads, like the machine frame.
   */
  threads: readonly SimThreadSpec[];
  /**
   * #623/#628 — the fitted surface the program was posted against, kept so a retry un-lifts the
   * program into the same frame it was loaded with — the same rule the machine frame follows.
   */
  surface: SurfaceFrame | null;
  /**
   * #629 — half the job's smallest level step, mm, passed to the column engine so it names a ramp
   * that can cross a level. Kept with the load for the same reason `surface` is: a retry must judge
   * the same threshold. `null` for a job with one level (or none) and for a non-column job.
   */
  rampThresholdMm: number | null;
  /**
   * #734 — how far the job's through cuts may reach below the blank, mm. Kept with the load for
   * the same reason `surface` is: a retry must judge the same floor. `null` for every load that is
   * not an engrave job, which keeps the pre-#734 blank-bottom floor.
   */
  breakthroughMm: number | null;
  /**
   * #744 — the cumulative removal earlier programs of this run left, one mesh each. Kept with the
   * load for the same reason `surface` is: a retry judges the same stock the program was cut on.
   */
  priorRemoval: NodeMeshOutput[] | null;
}
let lastLoad: LoadArgs | null = null;

export const useSimStore = create<SimState>()((set, get) => {
  async function run(args: LoadArgs, budgetMs: number): Promise<SimLoadResult | null> {
    const mine = ++loadSeq;
    // A load starts the session's speed at the shop's seed, as it always reset to 20 before #451.
    set({ ...EMPTY, speed: startingSpeed(), status: 'loading', budgetMs, phase: 'sweep', origin: args.origin, loadedProgram: args.gcodeText, loadedAt: Date.now(), tool: args.tool });
    try {
      const client = await clientLoader();
      client.setSimSinks(
        (k, frame) => {
          if (mine === loadSeq) set({ frame, k });
        },
        (e) => {
          if (mine === loadSeq) set({ status: 'error', error: String(e), phase: null });
        },
      );
      const r = await client.loadSim(args.gcodeText, args.setup, args.tool, args.machineId, {
        budgetMs,
        onProgress: (done, total) => {
          if (mine === loadSeq) set({ progress: { done, total } });
        },
        onPhase: (phase) => {
          if (mine === loadSeq) set({ phase });
        },
        calibration: args.calibration,
        drillPointDefault: args.drillPointDefault,
        flatPitchYMm: args.flatPitchYMm,
        columnPitchXMm: args.columnPitchXMm,
        rotaryPitchDeg: args.rotaryPitchDeg,
        spindleOffProximityMm: args.spindleOffProximityMm,
        threads: args.threads,
        surface: args.surface,
        rampThresholdMm: args.rampThresholdMm,
        breakthroughMm: args.breakthroughMm,
        priorRemoval: args.priorRemoval,
      });
      if (mine !== loadSeq) return null; // superseded by a newer load or a dispose
      if (!r.ok) {
        set({ status: 'refused', diagnostics: r.diagnostics, pathOnly: r.pathOnly, progress: null, phase: null, info: null, design: 'stock' });
        // A path-only session owns no material but DOES own the timeline, so the path can be drawn
        // with no stock (#194). Fetch it after the state is set so the panel shows immediately.
        if (r.pathOnly) {
          const path = await client.simPath();
          if (mine !== loadSeq) return null;
          set({
            path,
            step: Math.max(0, (r.summary?.steps ?? 1) - 1),
            stepCount: r.summary?.steps ?? 1,
            pauses: r.pauses ?? [],
            seconds: totalTime(path),
          });
        }
        return r;
      }
      const { ok: _ok, diagnostics, meshes, ...info } = r;
      // One fetch of the whole path, once per load (#197). Fetched before `status: 'ready'` so the
      // first render already has it; the step defaults to the last one, i.e. the finished part.
      const path = await client.simPath();
      if (mine !== loadSeq) return null;
      const stepCount = info.summary.steps ?? 1;
      set({
        status: 'ready',
        diagnostics,
        info,
        meshes,
        path,
        step: Math.max(0, stepCount - 1),
        stepCount,
        pauses: info.pauses ?? [],
        seconds: totalTime(path),
        progress: null,
        phase: null,
        design: 'stock',
      });
      return r;
    } catch (e) {
      if (mine === loadSeq) set({ status: 'error', error: e instanceof Error ? e.message : String(e), progress: null, phase: null });
      return null;
    }
  }

  return {
    ...EMPTY,
    speed: startingSpeed(),
    budgetMs: startingBudgetMs(),
    async loadProgram(gcodeText, setup, tool, machineId, calibrationOverride, threads = [], drillPointDefault = null, origin = 'panel', surface = null, rampThresholdMm = null, breakthroughMm = null, priorRemoval = null) {
      // The saved read of the machine's own frame, if the user has one (#279). Resolved HERE so
      // every load path — a panel, the engrave run, the QA harness — simulates the same machine,
      // and so a retry or a restart cannot drift onto a different frame than the job was loaded on.
      const calibration =
        calibrationOverride !== undefined ? calibrationOverride : (useSettingsStore.getState().machineCalibration ?? null);
      // #434 — a drill program hands the point its PLAN used; any other load reads the shop's.
      const shopPoint = shopDefault('drill.pointAngleDeg');
      const point = drillPointDefault ?? { deg: shopPoint.value, source: shopPoint.source };
      const flatPitch = shopDefault('sim.columnFlatPitchYMm');
      // The rest of the sim's chosen numbers (#451), read at the same moment as the flat pitch:
      // the worker cannot read the location, so these are the caller's to send.
      const pitchX = shopDefault('sim.columnPitchXMm');
      const rotaryPitch = shopDefault('sim.rotaryPitchDeg');
      const proximity = shopDefault('sim.spindleOffProximityMm');
      // #451 — a FRESH session takes the shop's `sim.budgetMs`; a later load keeps the session's
      // budget, which a retry may have doubled. Reading the seed here (not at module import) means
      // a location that answered after this module loaded still applies to the first load.
      const fresh = lastLoad === null;
      lastLoad = {
        gcodeText,
        setup,
        tool,
        machineId,
        calibration,
        origin,
        drillPointDefault: { deg: point.deg, source: point.source },
        flatPitchYMm: flatPitch.value,
        columnPitchXMm: pitchX.value,
        rotaryPitchDeg: rotaryPitch.value,
        spindleOffProximityMm: proximity.value,
        threads,
        surface,
        rampThresholdMm,
        breakthroughMm,
        priorRemoval: priorRemoval === null ? null : Array.isArray(priorRemoval) ? [...priorRemoval] : [priorRemoval as NodeMeshOutput],
      };
      return run(lastLoad, fresh ? startingBudgetMs() : get().budgetMs);
    },
    async retryWithLongerBudget() {
      if (!lastLoad) return;
      await run(lastLoad, get().budgetMs * 2);
    },
    generateRestart(opts) {
      const s = get();
      if (!lastLoad || s.stepCount <= 0) return;
      // The sweep's own verdict outranks every check below (#395). `status: 'ready'` means the
      // sweep produced material, NOT that the program is safe (#393): a load whose cutter drove
      // into the fixed jaw comes back `ready` with its `tool-into-fixture` error sitting in
      // `diagnostics`. And a `pathOnly` refusal is the sweep refusing outright — the runner drew
      // the path, no material was cut. Either way the program is one the app would not run, so a
      // restart of it is a file the app would not write.
      //
      // This is the gate the restart's OWN verifier cannot stand in for: `buildRestart` verifies
      // against the STOCK's depth limit (`stockFromSetup`), and the gouge that matters is in the
      // FIXTURE — so a restart of a program that cut into the jaw verifies clean and, step for
      // step, repeats the moves that did it.
      const problem = simulationProblem(s.diagnostics);
      if (problem !== null || s.pathOnly) {
        // BOTH facts when both hold: a path-only refusal carries its errors too, and the codes are
        // the part that says what went wrong.
        const cause = `the loaded program is refused by the simulation${problem !== null ? ` (${problem})` : ''}`;
        const why = s.pathOnly ? `${cause}; only its path was drawn and no material was cut` : cause;
        set({
          restart: {
            ok: false,
            nc: null,
            fileName: null,
            resume: null,
            verify: null,
            errors: [`${why}, so a restart of it is refused too`],
            runSheet: [],
          },
        });
        return;
      }
      const at = Math.trunc(opts?.step ?? s.step);
      const stock = stockFromSetup(lastLoad.setup);
      if (stock === null) {
        set({
          restart: {
            ok: false,
            nc: null,
            fileName: null,
            resume: null,
            verify: null,
            errors: ['the simulated setup has no rectangular stock to verify the restart against'],
            runSheet: [],
          },
        });
        return;
      }
      // A restart re-lowers the ORIGINAL text through the same pure halves the verifier uses, so
      // it never needs the wasm sweep the client holds — only the text, the setup and the tool.
      //
      // The machine is NOT a default (#367): `session.load` resolves NO machine for a null id, so
      // this load ran with no macro steps and no envelope check, and a restart lowered through the
      // Z1 would carry tool changes, clearance moves, envelope errors and a `;@MKR|MACHINE` header
      // the run it restarts never had. Refused in the shape of the stock refusal above, for the same
      // reason: what the load did not have, the restart must not invent. An unknown id cannot reach
      // here — `session.load` refuses it before any frame, which leaves `stepCount` at 0.
      const base = lastLoad.machineId === null ? undefined : MACHINES[lastLoad.machineId];
      if (!base) {
        set({
          restart: {
            ok: false,
            nc: null,
            fileName: null,
            resume: null,
            verify: null,
            errors: ['the simulated load had no machine, so the restart cannot be lowered through one'],
            runSheet: [],
          },
        });
        return;
      }
      const machine = resolveMachine(base, lastLoad.calibration);
      set({
        restart: buildRestart({
          gcodeText: lastLoad.gcodeText,
          setup: lastLoad.setup,
          tool: lastLoad.tool,
          machine,
          step: at,
          stock,
          baseName: opts?.baseName,
        }),
      });
    },
    clearRestart() {
      set({ restart: null });
    },
    seek(k) {
      if (get().status !== 'ready') return;
      set({ k });
      void clientLoader().then((c) => c.requestFrame(k));
    },
    setDesign(design) {
      const s = get();
      if (s.design === design) return;
      set({ design });
      // The SAME checkpoint in a different frame — never a seek to another step.
      if (s.status === 'ready' && s.info !== null) {
        void clientLoader().then((c) => c.requestFrame(s.k, design));
      }
    },
    setStep(step) {
      const s = get();
      if (s.stepCount <= 0) return;
      const next = Math.max(0, Math.min(s.stepCount - 1, Math.trunc(step)));
      // Derive the checkpoint from the step and seek only when it changes (issue #197): moving
      // between steps inside one checkpoint must not cost a seek.
      const k = s.info ? checkpointAtStep(s.info.checkpoints, next) : -1;
      // #198 — a step is a program position, so the clock snaps to it and any pause callout is
      // dismissed by the move: `timeAtStep` is exact (t is non-decreasing and step increasing).
      const seconds = s.path && s.path.t.length > 0 ? timeAtStep(s.path, next) : s.seconds;
      set({ step: next, seconds, stoppedAt: null });
      if (k !== s.k) get().seek(k);
    },
    play() {
      const s = get();
      // At the end (or with no vertex left), play restarts from the beginning — the one way back
      // from "the finished part". Otherwise it resumes where the clock stands, and clearing
      // `stoppedAt` is what lets `advance` continue past the pause it stopped on (#198): a pause
      // whose time is not ahead of the clock is skipped.
      const last = s.stepCount > 0 ? s.stepCount - 1 : 0;
      const total = s.path ? totalTime(s.path) : 0;
      if (s.seconds >= total || s.step >= last) {
        get().toStart();
        set({ playing: true, stoppedAt: null });
        return;
      }
      set({ playing: true, stoppedAt: null });
    },
    pause() {
      // Stop the clock without moving: the position is exactly where the frame left it.
      set({ playing: false });
    },
    setSpeed(n) {
      set({ speed: n });
    },
    seekSeconds(seconds) {
      const s = get();
      const path = s.path;
      const total = path ? totalTime(path) : 0;
      const clamped = Math.max(0, Math.min(total, seconds));
      // No path (a load that refused before the runner) or no known vertex: keep the time only.
      if (!path || path.t.length === 0 || path.step.length === 0) {
        set({ seconds: clamped });
        return;
      }
      // Unlike `setStep`, this keeps the sub-step time the loop needs; the step is the last
      // vertex at or before the time. The checkpoint still decides whether a seek is due.
      const step = stepAtTime(path, clamped);
      const k = s.info ? checkpointAtStep(s.info.checkpoints, step) : -1;
      set({ seconds: clamped, step });
      if (k !== s.k) get().seek(k);
    },
    stepBy(delta) {
      get().setStep(get().step + delta);
    },
    toStart() {
      get().setStep(0);
    },
    toEnd() {
      // The last step is what makes the viewport show `meshes.result` (`SimMeshes`).
      get().setStep(get().stepCount - 1);
    },
    halt(pause) {
      set({ playing: false, stoppedAt: pause });
    },
    toggleLayer(layer) {
      set({ layers: { ...get().layers, [layer]: !get().layers[layer] } });
    },
    async dispose() {
      loadSeq++;
      lastLoad = null;
      set({ ...EMPTY, speed: startingSpeed(), budgetMs: startingBudgetMs() });
      const c = await clientLoader().catch(() => null);
      await c?.disposeSim();
    },
  };
});

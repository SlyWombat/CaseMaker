/**
 * Simulation state (#182 step 8b): plain data and mesh buffers, nothing else.
 *
 * Deliberately NOT entries in `jobStore.nodes`. `applyResult` replaces that whole map on every
 * case rebuild, and the node-id namespace is enumerated by export, `FloatersBanner`,
 * `PartsMenu` and `PartThumbnail` — a sim mesh there would leak into exported STLs. This store
 * holds no wasm handle either: meshes arrive as transferred ArrayBuffers.
 *
 * There is no UI yet (it waits on a mockup). The client is reached by a dynamic `import()`
 * behind `__FEATURE_SIM__`, so a build with the flag off contains neither it nor the worker.
 */

import { create } from 'zustand';
import type { PausePoint, Setup } from '@/engine/cnc';
import { MACHINES, Z1 } from '@/engine/cnc/machine';
import { stepAtTime, timeAtStep, totalTime } from '@/engine/cnc/playbackClock';
import { generateRestart as buildRestart, stockFromSetup, type RestartResult } from '@/engine/cnc/restart';
import type { Tool } from '@/engine/cnc/tool';
import { checkpointAtStep } from '@/components/viewport/simGeometry';
import type { SimDiagnostic, SimFrame, SimLoadOk, SimPath } from '@/workers/sim/session';
// Type-only: erased at build time, so it does not pull the worker client into the graph.
import type { SimLoadPhase } from '@/engine/jobs/simClient';

export type SimStatus = 'idle' | 'loading' | 'ready' | 'refused' | 'error';

/** The playback speed multipliers the transport offers (#198): a wall-clock multiplier. */
export const SIM_SPEEDS = [1, 5, 20, 100] as const;
export type SimSpeed = (typeof SIM_SPEEDS)[number];
/**
 * The default speed. DECISION (#198 left it silent): 20×, matching the approved mockup (#195).
 * At the DISPLAY rapid rate a real job would otherwise take minutes before the first cut.
 */
const DEFAULT_SPEED: SimSpeed = 20;

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
}

/** All layers on: a fresh load shows the finished part with the whole path. */
export const DEFAULT_SIM_LAYERS: SimLayers = { removed: true, path: true, rapids: true, tool: true, fixture: true, sacrificial: true };

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
 * `SIM_BUDGET_MS` is the counterpart — keep the two equal.
 */
export const DEFAULT_SIM_BUDGET_MS = 60_000;

export interface SimState {
  status: SimStatus;
  error: string | null;
  diagnostics: SimDiagnostic[];
  info: SimLoadInfo | null;
  meshes: SimLoadOk['meshes'] | null;
  /** The frame on screen, and the checkpoint it is for. */
  frame: SimFrame | null;
  k: number;
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
  loadProgram(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null): Promise<void>;
  /** Run the last load again with twice the time limit (#194). No-op when nothing has been loaded. */
  retryWithLongerBudget(): Promise<void>;
  /**
   * Generate a restart `.nc` for the loaded program, resuming at `step` (default: the current
   * step). Differs from the run only in refusing when the resume state cannot be re-established;
   * the result is stored in `restart` (#249). No-op when nothing has been loaded.
   */
  generateRestart(opts?: { step?: number; baseName?: string }): void;
  /** Discard the generated restart (#249). */
  clearRestart(): void;
  /** Show checkpoint k (-1 = uncut). Coalesced by the client. */
  seek(k: number): void;
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
  if (!__FEATURE_SIM__) throw new Error('the simulation is not enabled in this build');
  return import('@/engine/jobs/simClient');
};
let clientLoader: () => Promise<SimClient> = loadClient;
/** For tests: swap the (lazy) client for a fake. */
export function setSimClientLoader(fn: (() => Promise<SimClient>) | null): void {
  clientLoader = fn ?? loadClient;
}

const EMPTY = {
  status: 'idle' as SimStatus,
  error: null,
  diagnostics: [] as SimDiagnostic[],
  info: null,
  meshes: null,
  frame: null,
  k: -1,
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
/** The arguments of the most recent load, so `retryWithLongerBudget` can run it again (#194). */
let lastLoad: { gcodeText: string; setup: Setup; tool: Tool; machineId: string | null } | null = null;

export const useSimStore = create<SimState>()((set, get) => {
  async function run(args: { gcodeText: string; setup: Setup; tool: Tool; machineId: string | null }, budgetMs: number): Promise<void> {
    const mine = ++loadSeq;
    set({ ...EMPTY, status: 'loading', budgetMs, phase: 'sweep' });
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
      });
      if (mine !== loadSeq) return; // superseded by a newer load or a dispose
      if (!r.ok) {
        set({ status: 'refused', diagnostics: r.diagnostics, pathOnly: r.pathOnly, progress: null, phase: null, info: null });
        // A path-only session owns no material but DOES own the timeline, so the path can be drawn
        // with no stock (#194). Fetch it after the state is set so the panel shows immediately.
        if (r.pathOnly) {
          const path = await client.simPath();
          if (mine === loadSeq)
            set({
              path,
              step: Math.max(0, (r.summary?.steps ?? 1) - 1),
              stepCount: r.summary?.steps ?? 1,
              pauses: r.pauses ?? [],
              seconds: totalTime(path),
            });
        }
        return;
      }
      const { ok: _ok, diagnostics, meshes, ...info } = r;
      // One fetch of the whole path, once per load (#197). Fetched before `status: 'ready'` so the
      // first render already has it; the step defaults to the last one, i.e. the finished part.
      const path = await client.simPath();
      if (mine !== loadSeq) return;
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
      });
    } catch (e) {
      if (mine === loadSeq) set({ status: 'error', error: e instanceof Error ? e.message : String(e), progress: null, phase: null });
    }
  }

  return {
    ...EMPTY,
    budgetMs: DEFAULT_SIM_BUDGET_MS,
    async loadProgram(gcodeText, setup, tool, machineId) {
      lastLoad = { gcodeText, setup, tool, machineId };
      await run(lastLoad, get().budgetMs);
    },
    async retryWithLongerBudget() {
      if (!lastLoad) return;
      await run(lastLoad, get().budgetMs * 2);
    },
    generateRestart(opts) {
      const s = get();
      if (!lastLoad || s.stepCount <= 0) return;
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
      const machine = MACHINES[lastLoad.machineId ?? ''] ?? Z1;
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
      set({ ...EMPTY, budgetMs: DEFAULT_SIM_BUDGET_MS });
      const c = await clientLoader().catch(() => null);
      await c?.disposeSim();
    },
  };
});

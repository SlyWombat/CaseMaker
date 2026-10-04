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
import type { Setup } from '@/engine/cnc';
import type { Tool } from '@/engine/cnc/tool';
import { checkpointAtStep } from '@/components/viewport/simGeometry';
import type { SimDiagnostic, SimFrame, SimLoadOk, SimPath } from '@/workers/sim/session';

export type SimStatus = 'idle' | 'loading' | 'ready' | 'refused' | 'error';

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
}

/** All layers on: a fresh load shows the finished part with the whole path. */
export const DEFAULT_SIM_LAYERS: SimLayers = { removed: true, path: true, rapids: true, tool: true, fixture: true };

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
  /** Which viewport layers the simulation draws (#197). */
  layers: SimLayers;
  /** Sweep progress while `status === 'loading'`, null otherwise (#194). */
  progress: SimProgress | null;
  /** True when the runner succeeded and only the sweep refused: the path is drawable, no material (#194). */
  pathOnly: boolean;
  /** The limit the next `loadProgram` uses, ms; `retryWithLongerBudget` doubles it (#194). */
  budgetMs: number;
  loadProgram(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null): Promise<void>;
  /** Run the last load again with twice the time limit (#194). No-op when nothing has been loaded. */
  retryWithLongerBudget(): Promise<void>;
  /** Show checkpoint k (-1 = uncut). Coalesced by the client. */
  seek(k: number): void;
  /**
   * Move the current step (#197): sets `step`, derives the checkpoint `k = checkpointAtStep(...)`
   * and seeks to it ONLY when `k` changed, so scrubbing within one checkpoint costs no seek.
   */
  setStep(step: number): void;
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
  layers: DEFAULT_SIM_LAYERS,
  progress: null,
  pathOnly: false,
};
let loadSeq = 0;
/** The arguments of the most recent load, so `retryWithLongerBudget` can run it again (#194). */
let lastLoad: { gcodeText: string; setup: Setup; tool: Tool; machineId: string | null } | null = null;

export const useSimStore = create<SimState>()((set, get) => {
  async function run(args: { gcodeText: string; setup: Setup; tool: Tool; machineId: string | null }, budgetMs: number): Promise<void> {
    const mine = ++loadSeq;
    set({ ...EMPTY, status: 'loading', budgetMs });
    try {
      const client = await clientLoader();
      client.setSimSinks(
        (k, frame) => {
          if (mine === loadSeq) set({ frame, k });
        },
        (e) => {
          if (mine === loadSeq) set({ status: 'error', error: String(e) });
        },
      );
      const r = await client.loadSim(args.gcodeText, args.setup, args.tool, args.machineId, {
        budgetMs,
        onProgress: (done, total) => {
          if (mine === loadSeq) set({ progress: { done, total } });
        },
      });
      if (mine !== loadSeq) return; // superseded by a newer load or a dispose
      if (!r.ok) {
        set({ status: 'refused', diagnostics: r.diagnostics, pathOnly: r.pathOnly, progress: null, info: null });
        // A path-only session owns no material but DOES own the timeline, so the path can be drawn
        // with no stock (#194). Fetch it after the state is set so the panel shows immediately.
        if (r.pathOnly) {
          const path = await client.simPath();
          if (mine === loadSeq) set({ path, step: Math.max(0, (r.summary?.steps ?? 1) - 1) });
        }
        return;
      }
      const { ok: _ok, diagnostics, meshes, ...info } = r;
      // One fetch of the whole path, once per load (#197). Fetched before `status: 'ready'` so the
      // first render already has it; the step defaults to the last one, i.e. the finished part.
      const path = await client.simPath();
      if (mine !== loadSeq) return;
      set({ status: 'ready', diagnostics, info, meshes, path, step: Math.max(0, info.summary.steps - 1), progress: null });
    } catch (e) {
      if (mine === loadSeq) set({ status: 'error', error: e instanceof Error ? e.message : String(e), progress: null });
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
    seek(k) {
      if (get().status !== 'ready') return;
      set({ k });
      void clientLoader().then((c) => c.requestFrame(k));
    },
    setStep(step) {
      const s = get();
      // Derive the checkpoint from the step and seek only when it changes (issue #197): moving
      // between steps inside one checkpoint must not cost a seek.
      const k = s.info ? checkpointAtStep(s.info.checkpoints, step) : -1;
      set({ step });
      if (k !== s.k) get().seek(k);
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

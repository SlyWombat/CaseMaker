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
import type { SimDiagnostic, SimFrame, SimLoadOk } from '@/workers/sim/session';

export type SimStatus = 'idle' | 'loading' | 'ready' | 'refused' | 'error';

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

const EMPTY = { status: 'idle' as SimStatus, error: null, diagnostics: [] as SimDiagnostic[], info: null, meshes: null, frame: null, k: -1, progress: null, pathOnly: false };
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
        return;
      }
      const { ok: _ok, diagnostics, meshes, ...info } = r;
      set({ status: 'ready', diagnostics, info, meshes, progress: null });
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
    async dispose() {
      loadSeq++;
      lastLoad = null;
      set({ ...EMPTY, budgetMs: DEFAULT_SIM_BUDGET_MS });
      const c = await clientLoader().catch(() => null);
      await c?.disposeSim();
    },
  };
});

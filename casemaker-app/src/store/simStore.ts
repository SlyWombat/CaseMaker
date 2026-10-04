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

export interface SimState {
  status: SimStatus;
  error: string | null;
  diagnostics: SimDiagnostic[];
  info: SimLoadInfo | null;
  meshes: SimLoadOk['meshes'] | null;
  /** The frame on screen, and the checkpoint it is for. */
  frame: SimFrame | null;
  k: number;
  loadProgram(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null): Promise<void>;
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

const EMPTY = { status: 'idle' as SimStatus, error: null, diagnostics: [] as SimDiagnostic[], info: null, meshes: null, frame: null, k: -1 };
let loadSeq = 0;

export const useSimStore = create<SimState>()((set, get) => ({
  ...EMPTY,
  async loadProgram(gcodeText, setup, tool, machineId) {
    const mine = ++loadSeq;
    set({ ...EMPTY, status: 'loading' });
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
      const r = await client.loadSim(gcodeText, setup, tool, machineId);
      if (mine !== loadSeq) return; // superseded by a newer load or a dispose
      if (!r.ok) {
        set({ status: 'refused', diagnostics: r.diagnostics });
        return;
      }
      const { ok: _ok, diagnostics, meshes, ...info } = r;
      set({ status: 'ready', diagnostics, info, meshes });
    } catch (e) {
      if (mine === loadSeq) set({ status: 'error', error: e instanceof Error ? e.message : String(e) });
    }
  },
  seek(k) {
    if (get().status !== 'ready') return;
    set({ k });
    void clientLoader().then((c) => c.requestFrame(k));
  },
  async dispose() {
    loadSeq++;
    set({ ...EMPTY });
    const c = await clientLoader().catch(() => null);
    await c?.disposeSim();
  },
}));

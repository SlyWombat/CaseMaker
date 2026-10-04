/**
 * Main-thread side of the simulation worker (#182 step 8b). Lazy-init like `workerClient.ts`.
 *
 * Import this ONLY through a dynamic `import()` behind `__FEATURE_SIM__` (see `simStore.ts`), so
 * the worker never enters the production graph. Nothing here holds a wasm handle: only plain
 * data and ArrayBuffers cross the boundary. `terminateSim()` is the cancel — `sweepTimeline` is
 * synchronous and cannot be interrupted any other way.
 */

import * as Comlink from 'comlink';
import type { Setup } from '@/engine/cnc';
import type { Tool } from '@/engine/cnc/tool';
import type { SimWorkerApi, SimFrame, SimLoadResult } from '@/workers/sim.worker';
import { createFrameCoalescer } from './frameCoalescer';

let simWorker: Worker | null = null;
let simApi: Comlink.Remote<SimWorkerApi> | null = null;
let frameSink: ((k: number, frame: SimFrame) => void) | null = null;
let errorSink: ((e: unknown) => void) | null = null;

export function getSimApi(): Comlink.Remote<SimWorkerApi> {
  if (!simApi) {
    simWorker = new Worker(new URL('../../workers/sim.worker.ts', import.meta.url), { type: 'module', name: 'sim' });
    simApi = Comlink.wrap<SimWorkerApi>(simWorker);
  }
  return simApi;
}

const frames = createFrameCoalescer<SimFrame>({
  fetch: (k, gen) => getSimApi().simFrameAt(k, gen),
  deliver: (k, f) => frameSink?.(k, f),
  onError: (e) => errorSink?.(e),
});

/** Kill the worker (cancelling any load in progress) and forget its session. */
export function terminateSim(): void {
  frames.reset();
  simWorker?.terminate();
  simWorker = null;
  simApi = null;
}

/** Where frames and failures go. One sink each; the store sets them. */
export function setSimSinks(onFrame: ((k: number, frame: SimFrame) => void) | null, onError: ((e: unknown) => void) | null): void {
  frameSink = onFrame;
  errorSink = onError;
}

/**
 * Hard stop for one load, ms (#194). `sweepTimeline` is one synchronous call, so nothing can
 * interrupt it from the main thread: past this the only cancel is `terminateSim()`.
 */
export const SIM_BUDGET_MS = 60_000;

/**
 * How far the worker's own budget sits BELOW the hard stop (#194). The sweep checks its
 * deadline between checkpoints, so a budget below the stop lets it refuse cleanly — with a
 * "checkpoint N of M" message and without killing the worker — while the hard stop remains for
 * a single wasm call that overran in between. A decision taken where the issue was silent.
 */
const SIM_BUDGET_GRACE_MS = 5_000;

/** What `loadSim` accepts on top of its arguments (#194). */
export interface SimLoadOpts {
  /** Wall-clock limit for this load, ms. Defaults to `SIM_BUDGET_MS`. */
  budgetMs?: number;
  /** Checkpoints swept so far. Called from the worker as the sweep advances. */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Load a program. On success the anchor chain is warmed with ONE silent seek to the last
 * checkpoint, so the first real scrub does not pay for building it (§8.0).
 *
 * Raced against a timer (#194): the sim worker is the one place a wasm call can run for
 * minutes without yielding, so a load that overruns the budget is refused by terminating the
 * worker — which frees every handle it owned with it, so there is nothing to clean up here.
 */
export async function loadSim(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null, opts?: SimLoadOpts): Promise<SimLoadResult> {
  frames.reset();
  const budgetMs = opts?.budgetMs ?? SIM_BUDGET_MS;
  const sweepBudget = Math.max(1, budgetMs - SIM_BUDGET_GRACE_MS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<SimLoadResult>((resolve) => {
    timer = setTimeout(() => {
      terminateSim();
      resolve({
        ok: false,
        pathOnly: false,
        diagnostics: [
          {
            source: 'sweep',
            severity: 'error',
            code: 'sweep-budget-exceeded',
            message: `the simulation was stopped after ${Math.round(budgetMs / 1000)} s: this program is too slow to simulate at this size (/Simulation.md §4.4). Try again with a longer limit`,
          },
        ],
      });
    }, budgetMs);
  });
  try {
    const result = await Promise.race([
      getSimApi().simLoad(gcodeText, setup, tool, machineId, sweepBudget, opts?.onProgress ? Comlink.proxy(opts.onProgress) : undefined),
      expired,
    ]);
    if (result.ok && result.count > 0) frames.request(result.count - 1, { silent: true });
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** Ask for checkpoint k (-1 = uncut). Coalesced: at most one in flight, newest k wins. */
export function requestFrame(k: number): void {
  frames.request(k);
}

export async function disposeSim(): Promise<void> {
  frames.reset();
  if (simApi) await simApi.simDispose();
}

export const simStateAt = (step: number) => getSimApi().simStateAt(step);
export const simToolPath = (from: number, to: number) => getSimApi().simToolPath(from, to);

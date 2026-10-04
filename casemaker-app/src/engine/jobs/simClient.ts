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
 * Load a program. On success the anchor chain is warmed with ONE silent seek to the last
 * checkpoint, so the first real scrub does not pay for building it (§8.0).
 */
export async function loadSim(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null): Promise<SimLoadResult> {
  frames.reset();
  const result = await getSimApi().simLoad(gcodeText, setup, tool, machineId);
  if (result.ok && result.count > 0) frames.request(result.count - 1, { silent: true });
  return result;
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

/**
 * The simulation worker (#182 step 8b). Its own worker, NOT the geometry worker, for two reasons:
 *
 *  1. `sweepTimeline` is synchronous and takes seconds (6.6 s on ACRYLIC-Balloon.nc), so the
 *     geometry worker's `currentGeneration` guard cannot interrupt it and a case rebuild would
 *     queue behind it. Here `terminate()` IS the cancel.
 *  2. A `Playback` holds live wasm handles, which cannot cross Comlink. Everything this worker
 *     returns is plain data or transferred ArrayBuffers; the handles never leave it.
 *
 * All the logic is in `sim/session.ts` (headless, tested in Node). This file only adapts it to
 * Comlink and transfers every mesh buffer, as `geometry.worker.ts` does. One session per worker.
 */

import * as Comlink from 'comlink';
import type { Setup } from '@/engine/cnc';
import type { Tool } from '@/engine/cnc/tool';
import { getToplevel } from './geometry/ManifoldRuntime';
import type { NodeMeshOutput } from './geometry/meshOutput';
import { createSimSession, type SimFrame, type SimLoadResult, type SimSession } from './sim/session';

let session: SimSession | null = null;
async function getSession(): Promise<SimSession> {
  session ??= createSimSession(await getToplevel());
  return session;
}

function buffersOf(meshes: (NodeMeshOutput | null | undefined)[]): Transferable[] {
  const out: Transferable[] = [];
  for (const m of meshes) if (m) out.push(m.positions.buffer, m.indices.buffer);
  return out;
}

const api = {
  /** Disposes any existing session first; a refused load leaves none. */
  async simLoad(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null): Promise<SimLoadResult> {
    const result = (await getSession()).load(gcodeText, setup, tool, machineId);
    if (!result.ok) return result;
    const m = result.meshes;
    return Comlink.transfer(result, buffersOf([m.stock, m.result, m.removal, ...m.gouges.map((g) => g.mesh)]));
  },
  /** The stock and the removal so far at checkpoint `k`; null if `gen` is stale or nothing is loaded. */
  async simFrameAt(k: number, gen: number): Promise<SimFrame | null> {
    const f = (await getSession()).frameAt(k, gen);
    return f ? Comlink.transfer(f, buffersOf([f.stock, f.removalSoFar])) : null;
  },
  async simStateAt(step: number) {
    return (await getSession()).stateAt(step);
  },
  async simToolPath(fromStep: number, toStep: number): Promise<Float32Array> {
    const p = (await getSession()).toolPath(fromStep, toStep);
    return Comlink.transfer(p, [p.buffer]);
  },
  async simDispose(): Promise<void> {
    session?.dispose();
  },
};

export type SimWorkerApi = typeof api;
export type { SimFrame, SimLoadResult };

Comlink.expose(api);

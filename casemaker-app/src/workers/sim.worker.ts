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
import type { EngraveJob } from '@/types/engraveJob';
import { ensureFontsLoaded, fontKeysForLabels } from '@/engine/fonts/registry';
import { getToplevel } from './geometry/ManifoldRuntime';
import type { NodeMeshOutput } from './geometry/meshOutput';
import { createSimSession, type SimFrame, type SimLoadOpts, type SimLoadResult, type SimPath, type SimSession } from './sim/session';
import { createEngravePreviewer, type EngravePreview, type EngravePreviewer } from './sim/engravePreview';
import { engraveGenerate as runEngraveGenerate, type EngraveGenerated } from './sim/engraveGenerate';
import type { OraclePredicted, OracleReport } from '@/engine/cnc/engrave/oracle';

let session: SimSession | null = null;
async function getSession(): Promise<SimSession> {
  session ??= createSimSession(await getToplevel());
  return session;
}

// The engrave preview (#205) lives in the same worker as the simulation — see the module doc
// of `sim/engravePreview.ts` for why it is not the geometry worker. Its own toplevel-backed
// object, independent of any loaded program.
let previewer: EngravePreviewer | null = null;
async function getPreviewer(): Promise<EngravePreviewer> {
  previewer ??= createEngravePreviewer(await getToplevel());
  return previewer;
}

function buffersOf(meshes: (NodeMeshOutput | null | undefined)[]): Transferable[] {
  const out: Transferable[] = [];
  for (const m of meshes) if (m) out.push(m.positions.buffer, m.indices.buffer);
  return out;
}

const api = {
  /**
   * Disposes any existing session first. A refused load leaves none — except when the runner
   * succeeded and only the sweep refused, in which case the session is PATH-ONLY: `toolPath`
   * works and `simFrameAt` returns null (#194).
   *
   * `onProgress` must arrive as a `Comlink.proxy` AND as its own argument. The sweep is one
   * synchronous call, but each callback it makes posts a message immediately, so the main thread
   * sees them as they happen — and Comlink cannot carry a proxy nested inside `opts`, because
   * `toWireValue` does not recurse (comlink.mjs:310, see `simClient.loadSim`).
   *
   * `opts.calibration` (#279) is a plain record and crosses the boundary by structured clone —
   * it is data about a machine, not a handle.
   */
  async simLoad(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null, opts?: SimLoadOpts, onProgress?: (done: number, total: number) => void): Promise<SimLoadResult> {
    const result = (await getSession()).load(gcodeText, setup, tool, machineId, { ...opts, onProgress });
    if (!result.ok) return result;
    const m = result.meshes;
    return Comlink.transfer(result, buffersOf([m.stock, m.result, m.removal, ...m.gouges.map((g) => g.mesh)]));
  },
  /** The stock and the removal so far at checkpoint `k`; null if `gen` is stale or nothing is loaded. */
  async simFrameAt(k: number, gen: number): Promise<SimFrame | null> {
    const f = (await getSession()).frameAt(k, gen);
    return f ? Comlink.transfer(f, buffersOf([f.stock, f.removalSoFar])) : null;
  },
  /**
   * Build the playback anchor chain now (#224). Awaiting this is the "preparing playback…" part
   * of a load: it may take seconds on a large program, and afterwards the first scrub is cheap.
   */
  async simWarmup(): Promise<void> {
    (await getSession()).warmup();
  },
  async simStateAt(step: number) {
    return (await getSession()).stateAt(step);
  },
  async simToolPath(fromStep: number, toStep: number): Promise<Float32Array> {
    const p = (await getSession()).toolPath(fromStep, toStep);
    return Comlink.transfer(p, [p.buffer]);
  },
  /** The whole path with kinds and times; every buffer is transferred (#197, #198). */
  async simPath(): Promise<SimPath> {
    const p = (await getSession()).simPath();
    return Comlink.transfer(p, [p.xyz.buffer, p.step.buffer, p.kind.buffer, p.t.buffer, ...(p.line ? [p.line.buffer] : [])]);
  },
  async simDispose(): Promise<void> {
    session?.dispose();
  },
  /**
   * The engrave preview (#205): the stock cut to each label's depth, the pocket floors, the
   * vise jaws and the sacrificial material (#213). `null` when `gen` is stale. Every mesh
   * buffer is transferred.
   */
  async engravePreview(job: EngraveJob, gen: number): Promise<EngravePreview | null> {
    // Issue #180 — the preview typesets labels through the synchronous `resolveFont`, and the
    // bundled faces are static assets now, so load the keys this job's enabled labels need
    // first. A shapes-only job (or one with every label disabled/empty) passes `[]`.
    await ensureFontsLoaded(fontKeysForLabels(job.labels, job.customFonts ?? []));
    const p = (await getPreviewer()).engravePreview(job, gen);
    if (!p) return null;
    return Comlink.transfer(p, buffersOf([p.stock, ...p.floors.map((f) => f.mesh), ...p.fixture.map((f) => f.mesh), ...p.sacrificial.map((s) => s.mesh)]));
  },
  /**
   * Generate → verify, headless (#206). Typesets labels through the synchronous `resolveFont`,
   * so the keys this job's enabled labels need are loaded first (#180), exactly as
   * `engravePreview` does. Returns the exact `.nc` text plus the opened regions the oracle needs.
   */
  async engraveGenerate(job: EngraveJob): Promise<EngraveGenerated> {
    await ensureFontsLoaded(fontKeysForLabels(job.labels, job.customFonts ?? []));
    return runEngraveGenerate(await getToplevel(), job);
  },
  /**
   * The volumetric oracle (#206 §3) against the program CURRENTLY loaded in the session. The
   * session owns the removal solid, so only the worker can run this. Throws when no swept
   * program is loaded; the main thread only calls it after a successful load.
   */
  async simOracle(predicted: OraclePredicted[]): Promise<OracleReport> {
    return (await getSession()).oracle(predicted);
  },
};

export type SimWorkerApi = typeof api;
export type { SimFrame, SimLoadResult, SimPath, EngravePreview, EngraveGenerated };

Comlink.expose(api);

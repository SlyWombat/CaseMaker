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
import type { Setup, MachineCalibration } from '@/engine/cnc';
import type { Tool } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { EngraveJob, EngraveMargins } from '@/types/engraveJob';
import { ensureFontsLoaded, fontKeysForLabels } from '@/engine/fonts/registry';
import { getToplevel } from './geometry/ManifoldRuntime';
import type { NodeMeshOutput } from './geometry/meshOutput';
import { createSimSession, type SimDesign, type SimFrame, type SimLoadOpts, type SimLoadResult, type SimPath, type SimSession } from './sim/session';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import { createEngravePreviewer, type EngravePreview, type EngravePreviewer } from './sim/engravePreview';
import type { ProbeResiduals } from '@/engine/cnc/probePlan';
import { engraveGenerate as runEngraveGenerate, type EngraveGenerated, type EngraveShopOpts } from './sim/engraveGenerate';
import { evaluatePlan } from './sim/planEvaluate';
import { runSmartPick, type EngravePickSummary } from './sim/smartPickRun';
import type { OraclePredicted, OracleReport } from '@/engine/cnc/engrave/oracle';
import { readDesign } from '@/engine/import/design3mf';
import { parsePrusaThreeMf } from '@/engine/import/prusa3mf';
import { sha256Hex } from '@/engine/import/meshStock';
import { designJobFor, type DesignJobPatch, type DesignReadingDirection } from '@/engine/cnc/engrave/fromDesign';

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

/**
 * #766 D — THE NEWEST EDIT'S GENERATION, shared by the preview and the background measured pick.
 *
 * The panel numbers every job edit (`engravePreviewStore`'s `seq`) and sends the same number with
 * the preview it asks for and with the search. A search compares this against the generation it
 * started under: a newer edit — whose preview request is served between the search's plan
 * evaluations — makes `latestEditGen` larger and the search stops at its next step. Only the
 * PREVIEW request advances it on an edit; the search does not move it, so a search cannot cancel
 * itself.
 */
let latestEditGen = Number.NEGATIVE_INFINITY;

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
  async simFrameAt(k: number, gen: number, design?: SimDesign): Promise<SimFrame | null> {
    const f = (await getSession()).frameAt(k, gen, design);
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
   *
   * `tools` is the caller's tool registry snapshot (#305), `catalogue` its Makera feed rows
   * (#324) and `conditions` the inventory's condition summaries by registry key (#442); all
   * cross by structured clone, like the `Tool` `simLoad` takes: the worker cannot see the app's
   * module state, so the list it measures and recommends from, the feed rows its recommendation
   * filters on, and the broken and worn copies it passes over, have to be sent to it.
   *
   * `shop` is the engrave shop defaults the caller read from the location (#451) — here only
   * `engrave.lostDetailWarnRatio`, the bar the findings and the recommendation share.
   *
   * `residuals` is the shop's five registration residuals (#451), read on the caller's side for
   * the same reason: the worker cannot see the location, and the registration band must draw the
   * tolerance the location would use rather than a compiled one.
   */
  async engravePreview(
    job: EngraveJob,
    tools: readonly ToolLibraryEntry[],
    catalogue: readonly FeedCatalogueRow[],
    gen: number,
    margins: EngraveMargins,
    conditions: ReadonlyMap<string, ConditionSummary>,
    shop?: EngraveShopOpts,
    residuals?: ProbeResiduals,
  ): Promise<EngravePreview | null> {
    // #766 D — an edit's generation, seen before the build: a measured search running in this
    // worker stops at its next step (see `latestEditGen`).
    if (gen > latestEditGen) latestEditGen = gen;
    // Issue #180 — the preview typesets labels through the synchronous `resolveFont`, and the
    // bundled faces are static assets now, so load the keys this job's enabled labels need
    // first. A shapes-only job (or one with every label disabled/empty) passes `[]`.
    await ensureFontsLoaded(fontKeysForLabels(job.labels, job.customFonts ?? []));
    const p = (await getPreviewer()).engravePreview(job, tools, catalogue, gen, margins, conditions, shop, residuals);
    if (!p) return null;
    return Comlink.transfer(
      p,
      buffersOf([
        p.stock,
        // §5.7 — the design ↔ as-cut slider's cumulative states. Their buffers travel with the
        // preview exactly like the stock's: a stage held back would arrive as a detached or empty
        // mesh once the worker's copy went away.
        ...p.stages.map((s) => s.mesh),
        ...p.floors.map((f) => f.mesh),
        // §5.7 — the lost layer's slivers (slice 1) travel the same way; without the transfer they
        // would be structured-cloned, leaving the worker holding a second copy of every buffer.
        ...p.lost.map((l) => l.mesh),
        ...p.fixture.map((f) => f.mesh),
        ...p.sacrificial.map((s) => s.mesh),
      ]),
    );
  },
  /**
   * #766 D — THE MEASURED PICK, behind the panel's provisional answer. Runs slice B's search with
   * slice A's evaluator in this worker, yielding to the message queue between plans so a newer
   * edit's `engravePreview` is served (and cancels this run) instead of waiting behind it.
   *
   * `gen` is the caller's edit generation, the SAME number its preview requests carry: when a
   * newer preview request arrives, `latestEditGen` moves past it and the search returns null at
   * its next step. A null answer means "the caller owns a newer request (or the job has nothing to
   * measure)"; it is not an error.
   *
   * `tools`, `catalogue`, `conditions` and `shop` are the caller's snapshots for the reasons
   * `engravePreview` documents — this realm cannot see the app's stores, and the plan must be
   * measured against exactly the cutters, feed rows and shop numbers the panel shows.
   */
  async engraveSmartPick(
    job: EngraveJob,
    tools: readonly ToolLibraryEntry[],
    catalogue: readonly FeedCatalogueRow[],
    gen: number,
    conditions: ReadonlyMap<string, ConditionSummary>,
    shop: EngraveShopOpts,
  ): Promise<EngravePickSummary | null> {
    await ensureFontsLoaded(fontKeysForLabels(job.labels, job.customFonts ?? []));
    const tl = await getToplevel();
    const ctx = { tl, tools, catalogue, shop, calibration: null, conditions, table: shop.feeds ?? null };
    return runSmartPick(
      { job, tools, catalogue, conditions, shop, table: shop.feeds ?? null },
      (plan, level) => evaluatePlan(job, plan, ctx, { level }),
      () => latestEditGen > gen,
    );
  },
  /**
   * Generate → verify, headless (#206). Typesets labels through the synchronous `resolveFont`,
   * so the keys this job's enabled labels need are loaded first (#180), exactly as
   * `engravePreview` does. Returns the exact `.nc` text plus the opened regions the oracle needs.
   *
   * `tool` is the RESOLVED cutter (#305), sent from the main thread for the same reason `tools`
   * is above: no store and no registry is visible in here. `null` stops the pipeline at the
   * feeds stage with the same message `tool-missing` produces, so a caller that got it wrong
   * hears about it rather than getting a program cut with a phantom cutter.
   *
   * `catalogue` is Makera's feed rows, sent for the same reason and with more at stake (#324):
   * resolving feeds in here against the module state this realm owns would post the starting
   * table's numbers while the panel showed the catalogue's.
   *
   * `shop` carries the caller's engrave shop defaults (#451): `engrave.lostDetailWarnRatio` for the
   * findings and `drill.peckClearanceMm` for the peck re-entry height. Omitted, the pipeline uses
   * its labelled fallbacks, exactly as a headless run with no location does.
   */
  async engraveGenerate(
    job: EngraveJob,
    tool: Tool | null,
    catalogue: readonly FeedCatalogueRow[],
    calibration: MachineCalibration | null,
    margins: EngraveMargins,
    shop?: EngraveShopOpts,
  ): Promise<EngraveGenerated> {
    await ensureFontsLoaded(fontKeysForLabels(job.labels, job.customFonts ?? []));
    return runEngraveGenerate(await getToplevel(), job, tool, catalogue, calibration, margins, shop);
  },
  /**
   * The volumetric oracle (#206 §3) against the program CURRENTLY loaded in the session. The
   * session owns the removal solid, so only the worker can run this. Throws when no swept
   * program is loaded; the main thread only calls it after a successful load.
   */
  async simOracle(predicted: OraclePredicted[]): Promise<OracleReport> {
    return (await getSession()).oracle(predicted);
  },
  /**
   * Read a PrusaSlicer project (.3mf) as a blank-and-items patch (#410 item 4's second entry
   * point). The work is `readDesign` + `designJobFor`, both of which need a ManifoldToplevel to
   * slice the file's meshes, which is why this is here rather than in the panel: it is the same
   * toplevel the engrave preview slices the stock with, and `readDesign` is a synchronous,
   * second-scale wasm call exactly like the ones this worker exists to keep off the main thread.
   *
   * `bytes` is the whole file. The RESULT is plain data — no handle crosses, the same rule every
   * other method here follows — so the panel can hand it straight to the job store.
   *
   * The bytes are hashed here, once, and stamped on the patch as its `source` (#437): the Title
   * names the design, the hash says whether a re-import is the same bytes or an edit. Hashing in
   * the worker keeps the digest off the main thread and out of the panel's test seam.
   */
  async readDesign3mf(bytes: ArrayBuffer, direction: DesignReadingDirection): Promise<DesignJobPatch> {
    const design = readDesign(await getToplevel(), parsePrusaThreeMf(bytes));
    const source = { name: design.name, sha256: await sha256Hex(bytes) };
    return designJobFor(design, { direction, source });
  },
};

export type SimWorkerApi = typeof api;
export type { SimDesign, SimFrame, SimLoadResult, SimPath, EngravePreview, EngraveGenerated };

Comlink.expose(api);

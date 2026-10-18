/**
 * Main-thread side of the simulation worker (#182 step 8b). Lazy-init like `workerClient.ts`.
 *
 * Import this ONLY through a dynamic `import()` behind `featureSim` (#343) (see `simStore.ts`), so
 * the worker never enters the production graph. Nothing here holds a wasm handle: only plain
 * data and ArrayBuffers cross the boundary. `terminateSim()` is the cancel — `sweepTimeline` is
 * synchronous and cannot be interrupted any other way.
 */

import * as Comlink from 'comlink';
import type { MachineCalibration, Setup } from '@/engine/cnc';
import type { Tool } from '@/engine/cnc/tool';
import type { SimThreadSpec } from '@/engine/cnc/cam/threadMill';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { EngraveJob, EngraveMargins } from '@/types/engraveJob';
import type { SimWorkerApi, SimFrame, SimLoadResult, SimPath, EngravePreview, EngraveGenerated } from '@/workers/sim.worker';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { OraclePredicted, OracleReport } from '@/engine/cnc/engrave/oracle';
import type { DesignJobPatch, DesignReadingDirection } from '@/engine/cnc/engrave/fromDesign';
import { liveShopDefaults, readDefault } from '@/platform/defaultsClient';
import type { ProbeResiduals } from '@/engine/cnc/probePlan';
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
 *
 * #451: the value is the shop's `sim.budgetMs`, read when a load starts; this constant is its
 * LABELLED no-service fallback and `simStore`'s `DEFAULT_SIM_BUDGET_MS` is the counterpart — keep
 * the two equal. This module is main-thread side (it CREATES the worker), so it may read the live
 * location through `defaultsClient`; the worker itself never does.
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
  /** Wall-clock limit for this load, ms. Defaults to the shop's `sim.budgetMs` (#451). */
  budgetMs?: number;
  /** Checkpoints swept so far. Called from the worker as the sweep advances. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Which stage of the load is running (#224): `sweep` while the sweep runs, then `playback`
   * while the anchor chain is built up front. The UI shows the latter as "preparing playback…".
   */
  onPhase?: (phase: SimLoadPhase) => void;
  /**
   * The machine's own coordinate frame, if one has been read from it (#279). The runner puts the
   * predicted tool-length probe where THIS machine says the sensor is rather than the vendor's
   * position. A record for a different machine is ignored by `resolveMachine`.
   */
  calibration?: MachineCalibration | null;
  /**
   * The shop's `drill.pointAngleDeg` and its source, for a drill that states no point angle (#382).
   * The worker cannot read the location, so the caller sends what it read.
   */
  drillPointDefault?: { deg: number; source: string } | null;
  /** The shop's `sim.columnFlatPitchYMm` (#438): the flat column grid's Y pitch, mm. Read by the caller, like the drill point. */
  flatPitchYMm?: number | null;
  /** The shop's `sim.columnPitchXMm` (#451): the column grid's X pitch, mm. Read by the caller, like the drill point. */
  columnPitchXMm?: number | null;
  /** The shop's `sim.rotaryPitchDeg` (#451): the rotary column grid's θ pitch, degrees. Read by the caller. */
  rotaryPitchDeg?: number | null;
  /** The shop's `sim.spindleOffProximityMm` (#451): the spindle-off move's clearance to material or the bed, mm. Read by the caller. */
  spindleOffProximityMm?: number | null;
  /**
   * The threads this program mills (#445 §4), as the CAM planned them: plain numbers, so the
   * column engine can state the annular band and the over-removal instead of a cylinder.
   */
  threads?: readonly SimThreadSpec[] | null;
}

/** The two stages of a load (#224). */
export type SimLoadPhase = 'sweep' | 'playback';

/**
 * Load a program. The anchor chain is warmed up front (#224): after the sweep the worker builds
 * every playback anchor while this promise is still pending, so the caller can show it as part
 * of loading and the first real scrub does not pay for it.
 *
 * Raced against a timer (#194): the sim worker is the one place a wasm call can run for
 * minutes without yielding, so a load that overruns the budget is refused by terminating the
 * worker — which frees every handle it owned with it, so there is nothing to clean up here.
 */
export async function loadSim(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null, opts?: SimLoadOpts): Promise<SimLoadResult> {
  frames.reset();
  // #451 — the one seed, read at the load: the caller's explicit budget, else the shop's.
  const budgetMs = opts?.budgetMs ?? readDefault(liveShopDefaults(), 'sim.budgetMs').value;
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
            message: `the simulation was stopped after ${Math.round(budgetMs / 1000)} s: this program is too slow to simulate at this size. Try again with a longer limit`,
          },
        ],
      });
    }, budgetMs);
  });
  try {
    const result = await Promise.race([
      getSimApi()
        .simLoad(
          gcodeText,
          setup,
          tool,
          machineId,
          // The DATA travels in one object; the callback does not. `Comlink.proxy` marks a function
          // so `toWireValue` can swap it for a message port — but that function is not recursive
          // (comlink.mjs:310), so a proxy nested in a plain object is never recognised, falls
          // through as RAW, and the raw function reaches `postMessage`: "could not be cloned".
          // Only a TOP-LEVEL argument can carry a proxy, which is why `onProgress` is its own.
          {
            budgetMs: sweepBudget,
            calibration: opts?.calibration ?? null,
            drillPointDefault: opts?.drillPointDefault ?? null,
            flatPitchYMm: opts?.flatPitchYMm ?? null,
            columnPitchXMm: opts?.columnPitchXMm ?? null,
            rotaryPitchDeg: opts?.rotaryPitchDeg ?? null,
            spindleOffProximityMm: opts?.spindleOffProximityMm ?? null,
            threads: opts?.threads ?? null,
          },
          opts?.onProgress ? Comlink.proxy(opts.onProgress) : undefined,
        )
        .then(async (r) => {
          // #224: the warm-up is part of the load, not the first scrub. Awaiting `simWarmup`
          // keeps this promise pending (so the UI stays "loading") until the anchor chain is
          // built; only then does the caller go ready and accept scrubs.
          if (r.ok && r.count > 0) {
            opts?.onPhase?.('playback');
            await getSimApi().simWarmup();
          }
          return r;
        }),
      expired,
    ]);
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

/**
 * The whole path, with kinds and times, fetched once per load (#197). The four buffers are
 * transferred, so the copy lives in the main thread from here on.
 */
export const simPath = (): Promise<SimPath> => getSimApi().simPath();

/**
 * The engrave preview (#205): the stock cut to each label's depth, its pocket floors and the
 * vise jaws. `null` when `gen` is older than one the worker has already answered; mesh buffers
 * are transferred. Independent of any loaded simulation program.
 *
 * `tools` is the resolved registry snapshot (#305), `catalogue` the Makera feed rows (#324),
 * `margins` the job's depth thresholds (#345) and `conditions` the inventory's condition summaries
 * (#442): the worker cannot read the app's module state, so the list it resolves and recommends
 * from — and the rows that recommendation filters on, the margins its void limits are drawn to, and
 * the broken and worn copies it passes over — are all sent with the job. Plain data, like the `Tool`
 * `simLoad` takes.
 *
 * `shop` is the engrave shop defaults (#451) — here `engrave.lostDetailWarnRatio`, read from the
 * location on this side because the worker cannot see it. Omitted, the worker keeps its labelled
 * fallback, so a caller with no location still previews the shipped default's way.
 *
 * `residuals` is the shop's five registration residuals (#451), read here for the same reason:
 * the preview worker cannot see the location, and the registration band must draw the tolerance
 * the location would use. Omitted, the worker draws its labelled fallbacks.
 */
export const engravePreview = (
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  gen: number,
  margins: EngraveMargins,
  conditions: ReadonlyMap<string, ConditionSummary>,
  shop?: EngraveShopOpts,
  residuals?: ProbeResiduals,
): Promise<EngravePreview | null> =>
  getSimApi().engravePreview(job, tools, catalogue, gen, margins, conditions, shop, residuals);

/**
 * Generate → verify, headless, in the sim worker (#206). Returns the exact `.nc` text and the
 * opened regions the oracle compares the simulation against. No wasm handle crosses: the result
 * is plain data.
 *
 * `tool` is the caller's resolved cutter (#305) — `jobTool(job)` on this side, because the
 * worker cannot resolve it. The same object is what the caller then loads the simulation with,
 * so the gate and the sweep judge one cutter and not two.
 *
 * `catalogue` is the caller's Makera feed rows (#324), for the same reason: the `.nc` and the run
 * sheet are posted from the worker's `feedsFor`, and that realm's own copy of the snapshot is
 * always empty.
 *
 * `margins` is the caller's resolved depth thresholds (#345) — `effectiveMargins(job, settings)`
 * on this side, because the house setting lives in `useSettingsStore` and the worker cannot see
 * it. It gates the program, so sending it is not optional: the fallback the worker would otherwise
 * use is the shipped default, and a run gated to a different margin than the sheet prints is
 * exactly the disagreement #345 exists to remove.
 *
 * `shop` is the engrave pipeline's shop defaults (#451), read on this side for the same reason as
 * `margins`: `engrave.lostDetailWarnRatio` decides which items the findings warn about and
 * `drill.peckClearanceMm` where each peck's re-entry rapid stops. Omitted, the worker keeps both
 * labelled fallbacks — the program a headless run without a location would cut.
 */
export const engraveGenerate = (
  job: EngraveJob,
  tool: Tool | null,
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null,
  margins: EngraveMargins,
  shop?: EngraveShopOpts,
): Promise<EngraveGenerated> =>
  getSimApi().engraveGenerate(job, tool, catalogue, calibration, margins, shop);

/**
 * The volumetric oracle (#206 §3) over the program CURRENTLY loaded in the worker's session.
 * Throws when no swept program is loaded — only call after a load that reported `ok`.
 */
export const simOracle = (predicted: OraclePredicted[]): Promise<OracleReport> =>
  getSimApi().simOracle(predicted);

/**
 * Read a PrusaSlicer project (.3mf) as a blank-and-items patch (#410 item 4's second entry point).
 * The parsing and the frame turn happen in the worker, which owns the ManifoldToplevel they need;
 * what comes back is plain data for the job store, so no handle crosses.
 *
 * `bytes` is COPIED by structured clone, not transferred: the caller's `ArrayBuffer` is the only
 * copy of the user's file in this realm, and a transferred one would leave the panel holding a
 * detached buffer if the read failed.
 */
export const readDesign3mf = (
  bytes: ArrayBuffer,
  direction: DesignReadingDirection,
): Promise<DesignJobPatch> => getSimApi().readDesign3mf(bytes, direction);

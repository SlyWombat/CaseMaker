/**
 * Main-thread side of the simulation worker (#182 step 8b). Lazy-init like `workerClient.ts`.
 *
 * Import this ONLY through a dynamic `import()` behind `featureSim` (#343) (see `simStore.ts`), so
 * the worker never enters the production graph. Nothing here holds a wasm handle: only plain
 * data and ArrayBuffers cross the boundary. `terminateSim()` is the cancel — `sweepTimeline` is
 * synchronous and cannot be interrupted any other way.
 */

import * as Comlink from 'comlink';
import { noteStage } from '@/platform/flightRecorder';
import type { MachineCalibration, Setup } from '@/engine/cnc';
import type { Tool } from '@/engine/cnc/tool';
import type { SimThreadSpec } from '@/engine/cnc/cam/threadMill';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { EngraveJob, EngraveMargins, EngraveTargetObject } from '@/types/engraveJob';
import type { PlanTradeoff } from '@/engine/cnc/cam/model/tradeoff';
import type { PlanOutcome } from '@/engine/cnc/cam/model/plan';
import type { SimWorkerApi, SimFrame, SimLoadResult, SimPath, EngravePreview, EngraveGenerated } from '@/workers/sim.worker';
import type { SimDesign } from '@/workers/sim/session';
import type { EngraveProgress, EngraveShopOpts } from '@/workers/sim/engraveGenerate';
import type { EngravePickSummary } from '@/workers/sim/smartPickRun';
import type { OraclePredicted, OracleReport } from '@/engine/cnc/engrave/oracle';
import type { DesignCheckItem } from '@/engine/cnc/engrave/designCheck';
import type { SimGoalCheck } from '@/engine/cnc/engrave/goalCheckInput';
import type { PcbCopperTopologyInput } from '@/engine/cnc/engrave/pcbTopology';
import type { SurfaceFrame } from '@/engine/cnc/engrave/surfacePlane';
import type { NodeMeshOutput } from '@/workers/geometry/meshOutput';
import type { CarriedField } from '@/workers/geometry/carriedField';
import type { DesignJobPatch, DesignReadingDirection } from '@/engine/cnc/engrave/fromDesign';
import { liveShopDefaults, readDefault } from '@/platform/defaultsClient';
import { recordCrumb } from '@/platform/flightRecorder';
import type { ProbeResiduals } from '@/engine/cnc/probePlan';
import { createFrameCoalescer } from './frameCoalescer';

let simWorker: Worker | null = null;
let simApi: Comlink.Remote<SimWorkerApi> | null = null;
let frameSink: ((k: number, frame: SimFrame) => void) | null = null;
let errorSink: ((e: unknown) => void) | null = null;

/**
 * #830 — THE WORKER CAN DIE, AND ITS PENDING CALLS USED TO HANG FOREVER. A wasm trap, an OOM kill
 * or a terminated worker leaves every Comlink promise pending: the panel then shows "Working…" with
 * nothing behind it, which is the hang the maintainer saw before the tab crashed. One deferred
 * failure per worker is raced against every call; `failWorker` rejects it, writes the error into the
 * flight recorder (so the crash report carries it) and forgets the worker, so the next call starts
 * a fresh one.
 */
interface WorkerFailure {
  promise: Promise<never>;
  reject: (e: Error) => void;
}

let failure: WorkerFailure | null = null;

function newFailure(): WorkerFailure {
  let reject!: (e: Error) => void;
  const promise = new Promise<never>((_, rej) => {
    reject = rej;
  });
  // A crash while nothing is in flight must not surface as an unhandled rejection.
  promise.catch(() => undefined);
  return { promise, reject };
}

function ensureFailure(): WorkerFailure {
  failure ??= newFailure();
  return failure;
}

/** Keep the worker's failure (or null) around a call, so a dead worker rejects instead of hanging. */
function guarded<T>(call: Promise<T>): Promise<T> {
  return failure === null ? call : Promise.race([call, failure.promise]);
}

/**
 * #830 — the worker stopped: record WHY in the flight recorder, fail every pending call with it,
 * and forget the worker so the next call creates a new one.
 */
function failWorker(message: string): void {
  recordCrumb({ kind: 'error', data: { source: 'sim-worker', message } });
  const f = failure;
  failure = null;
  frames.reset();
  simWorker?.terminate();
  simWorker = null;
  simApi = null;
  f?.reject(new Error(message));
}

/**
 * #830 — the worker is gone without a cancel (`terminateSim` is the app's own stop; this is the
 * crash path, e.g. killed by the browser). Exposed so a test can prove the panel reports it.
 */
export function killSimWorkerForTest(message = 'the simulation worker stopped'): void {
  failWorker(message);
}

export function getSimApi(): Comlink.Remote<SimWorkerApi> {
  if (!simApi) {
    simWorker = new Worker(new URL('../../workers/sim.worker.ts', import.meta.url), { type: 'module', name: 'sim' });
    // #1048 — the worker's own existence, timestamped: a load whose 'accepted' phase never comes
    // can now be told apart from a worker that was never created.
    noteStage('simulate', 'worker-spawn', 'simulation worker created');
    ensureFailure();
    simWorker.onerror = (event) => {
      // The browser has already logged it; the page's record must carry the worker's words.
      event.preventDefault?.();
      failWorker(event.message !== '' ? event.message : 'the simulation worker stopped with an error');
    };
    simWorker.onmessageerror = () => failWorker('the simulation worker sent a message the page could not read');
    simApi = Comlink.wrap<SimWorkerApi>(simWorker);
  }
  return simApi;
}

/**
 * #716 slice 2 — which frame the next `simFrameAt` asks for (Stock or Unroll). A view state, so
 * it lives beside the coalescer rather than in any request: the request still names only the
 * checkpoint, and the newest view wins even while a request is in flight.
 */
let frameDesign: SimDesign = 'stock';

const frames = createFrameCoalescer<SimFrame>({
  fetch: (k, gen) => getSimApi().simFrameAt(k, gen, frameDesign),
  deliver: (k, f) => frameSink?.(k, f),
  onError: (e) => errorSink?.(e),
});

/** Kill the worker (cancelling any load in progress) and forget its session. */
export function terminateSim(): void {
  frames.reset();
  frameDesign = 'stock';
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
 * #895 — HOW LONG A LOAD MAY RUN WITHOUT A PROGRESS CHECKPOINT, ms. `sweepTimeline` is one
 * synchronous call, so nothing can interrupt it from the main thread: the watchdog's only stop is
 * `terminateSim()`. The window RESETS on every checkpoint, so a healthy sweep runs as long as it
 * takes; only silence is a fault.
 *
 * #451/#895: the value is the shop's `sim.loadStallMs`, read when a load starts; this constant is
 * its LABELLED no-service fallback and `simStore`'s `DEFAULT_SIM_STALL_MS` is the counterpart —
 * keep the two equal. This module is main-thread side (it CREATES the worker), so it may read the
 * live location through `defaultsClient`; the worker itself never does.
 */
export const SIM_LOAD_STALL_MS = 30_000;

/**
 * #871/#895 — THE SWEEP'S PROJECTED TOTAL TIME, from its measured rate: `elapsed / done × total`,
 * measured from the FIRST checkpoint (worker startup and parsing are a fixed cost, not the sweep's
 * rate), and only trusted after a floor of {@link SIM_PROJECTION_MIN_MS} and
 * {@link SIM_PROJECTION_MIN_SHARE} of the checkpoints. It INFORMS — the progress line's "about N
 * left" — and never stops the run (#895): a long projection is stated up front and the sweep keeps
 * going.
 */
const SIM_PROJECTION_MIN_MS = 4_000;
const SIM_PROJECTION_MIN_SHARE = 0.05;

/**
 * #871 — the sweep's projected total time from its measured rate, ms; null while the sample is too
 * early to trust. Pure, so the rule can be tested without a worker.
 */
export function sweepProjectionMs(elapsedMs: number, done: number, total: number): number | null {
  if (!(done > 0) || !(total > 0) || elapsedMs < SIM_PROJECTION_MIN_MS) return null;
  if (done < Math.max(1, Math.ceil(total * SIM_PROJECTION_MIN_SHARE))) return null;
  return (elapsedMs / done) * total;
}

/**
 * #895 — THE PROGRESS WATCHDOG. `arm()` (re)starts the window; it fires ONCE after `windowMs` with
 * no arm in between. A sweep that keeps reporting checkpoints therefore runs as long as it takes,
 * and only silence is a fault. Exported so a spec can pin both rules without a worker; `loadSim`
 * arms it at the start and on every checkpoint, and stops it when the load settles.
 */
export function stallWatchdog(windowMs: number, onStall: () => void): { arm: () => void; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;
  const fire = (): void => {
    if (fired) return;
    fired = true;
    timer = null;
    onStall();
  };
  return {
    arm: () => {
      if (fired) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(fire, windowMs);
    },
    stop: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      fired = true;
    },
  };
}

/**
 * #1048 — THE LOAD'S TWO CLOCKS. The sim worker is shared with the background ideal plan, so a
 * load can QUEUE behind it for minutes; the old single window, armed at the call, read that queue
 * time as silence and terminated a healthy worker. The QUEUE clock runs until the worker says
 * anything for this load (a phase boundary or a checkpoint); a queue expiry reports "waiting",
 * never a fault, and re-arms. Once the worker has spoken, the STALL clock applies: silence from a
 * load the thread actually started is the fault #895 means, and it terminates.
 */
export function loadStallPolicy(
  queueMs: number,
  stallMs: number,
  onWaiting: () => void,
  onStalled: () => void,
): { start: () => void; heard: () => void; stop: () => void } {
  let switched = false;
  let stopped = false;
  let queueTimer: ReturnType<typeof setTimeout> | null = null;
  const stall = stallWatchdog(stallMs, () => {
    if (!stopped && switched) onStalled();
  });
  // The queue clock REPEATS (a load may wait out many windows); `stallWatchdog` fires once by
  // design, so this one is its own timer.
  const armQueue = (): void => {
    if (stopped || switched) return;
    queueTimer = setTimeout(() => {
      queueTimer = null;
      if (stopped || switched) return;
      onWaiting();
      armQueue();
    }, queueMs);
  };
  return {
    start: armQueue,
    /** Any message for THIS load: switch to the stall clock and (re-)arm it. */
    heard: () => {
      if (stopped) return;
      if (!switched) {
        switched = true;
        if (queueTimer !== null) clearTimeout(queueTimer);
        queueTimer = null;
      }
      stall.arm();
    },
    stop: () => {
      stopped = true;
      if (queueTimer !== null) clearTimeout(queueTimer);
      queueTimer = null;
      stall.stop();
    },
  };
}

/** #895 — THE STALL SENTENCE: what happened, where it stopped, and that it is the app's fault. */
export function sweepStallMessage(
  stallMs: number,
  done: number,
  total: number,
  phase: 'sweep' | 'air' | 'air-done' = 'sweep',
): string {
  // #1056 (6b's ruled wording) — WHAT THE APP KNOWS is that nothing was reported for the window,
  // and the sentence says exactly that, naming the place it last heard from. It never claims a
  // fault: silence alone cannot prove one, and on a worker that is stuck-but-alive the cause is
  // the app's to find.
  const seconds = Math.round(stallMs / 1000);
  const where =
    phase === 'air-done'
      ? ' after the rapid-move check finished'
      : phase === 'air' && total > 0
        ? ` after checking rapid move ${done} of ${total}`
        : total > 0
          ? done >= total
            ? ' after the last checkpoint'
            : ` after checkpoint ${done} of ${total}`
          : '';
  return `the simulation reported nothing for ${seconds} s${where}.`;
}

/** #1056 — the current load's own stop, so a superseded load's stall cannot terminate its worker. */
let activeStop: (() => void) | null = null;

/** What `loadSim` accepts on top of its arguments (#194). */
export interface SimLoadOpts {
  /**
   * #895 — how long the load may run WITHOUT a progress checkpoint, ms. Resets on every
   * checkpoint. Defaults to the shop's `sim.loadStallMs`.
   */
  stallMs?: number;
  /**
   * #1048 — how long the load may QUEUE before it states `waiting`, ms. The clock repeats and
   * never faults (a crash is the worker-error race's own); the stall window above starts at the
   * worker's first message. Defaults to the shop's `sim.stallMs`.
   */
  queueMs?: number;
  /**
   * Checkpoints swept so far. Called from the worker as the sweep advances; #896 adds the
   * worker's own JS heap (MB) so a long goal sweep can say which worker holds the memory.
   */
  onProgress?: (done: number, total: number, memoryMB?: number | null) => void;
  /**
   * #895 — the sweep's own projection of the total load, ms, whenever the sample is good enough
   * to trust ({@link sweepProjectionMs}). It INFORMS the progress line ("about N left") and never
   * stops the run: a long projection is stated, and the sweep keeps going while it advances.
   */
  onProjection?: (projectedMs: number, done: number, total: number) => void;
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
  /**
   * #623/#628 — the fitted surface the program was posted against, when a registration measured a
   * tilt and the Cut step re-posted. The session UN-LIFTS the program into that frame before the
   * sweep, so a correctly lifted file is the flat program the job really is and gives the flat
   * post's own verdict. Absent/null: a flat post, judged in the work frame exactly as before.
   */
  surface?: SurfaceFrame | null;
  /**
   * #629 — half the job's smallest level step, mm, passed to the column engine so it names a ramp
   * that can cross a level. Absent/null: the ramp check is off.
   */
  rampThresholdMm?: number | null;
  /**
   * #734 — how far a THROUGH cut may reach below the blank's underside, mm (the engrave job's
   * `breakthrough`). The column engine's floor is `base − breakthroughMm`, the same floor the CAM
   * posted the through moves against (#218), so a correct through cut is judged against the
   * material it really removes instead of the blank's bottom face. Absent/null: the floor is the
   * blank's bottom, the pre-#734 reading every non-engrave load keeps.
   */
  breakthroughMm?: number | null;
  /**
   * #744 — the material earlier programs of THIS run left, one removal mesh each, so this program
   * is swept on the stock they left rather than the blank. The session unions the list; an empty
   * list is no seed. The meshes are structured-cloned (not transferred), because the caller keeps
   * them for the later programs' seeds.
   */
  priorRemoval?: NodeMeshOutput | readonly NodeMeshOutput[] | null;
  /**
   * #723 P2-2b — the other side's remaining stock as a field, with the maps into this program's
   * work frame. Taken by a column-swept program; an exact-swept one uses `priorRemoval`.
   */
  carried?: CarriedField | null;
  /** #817 — the earlier column programs' remaining tops, in this program's own frame. */
  priorFields?: readonly CarriedField[] | null;
  /** #817 — which of `priorRemoval` an exact program made; a column seed cannot use them. */
  priorExactRemoval?: readonly NodeMeshOutput[] | null;
  /** #1040 — this load continues the run already in flight (a from-blank retry inside it). */
  continueRun?: boolean;
}

// #1048 — the load's own boundaries are declared where the worker's load lives; re-exported here,
// where the panels and the store have always read the type from.
import type { SimLoadPhase } from '@/workers/sim/session';
export type { SimLoadPhase };

/**
 * Load a program. The anchor chain is warmed up front (#224): after the sweep the worker builds
 * every playback anchor while this promise is still pending, so the caller can show it as part
 * of loading and the first real scrub does not pay for it.
 *
 * Raced against a STALL WATCHDOG (#194, #895): the sim worker is the one place a wasm call can run
 * for minutes without yielding, so a load that has stopped reporting checkpoints is refused by
 * terminating the worker — which frees every handle it owned with it, so there is nothing to clean
 * up here. The window RESETS on every checkpoint: a healthy sweep runs as long as it needs, and
 * only silence is a fault.
 */
export async function loadSim(gcodeText: string, setup: Setup, tool: Tool, machineId: string | null, opts?: SimLoadOpts): Promise<SimLoadResult> {
  frames.reset();
  frameDesign = 'stock'; // a new session opens on the rod, whatever the last one was showing
  // #451/#895 — the one seed, read at the load: the caller's explicit window, else the shop's.
  const stallMs = opts?.stallMs ?? readDefault(liveShopDefaults(), 'sim.loadStallMs').value;
  let settled = false;
  // What the last checkpoint said, so a stall can name where it stopped.
  let lastDone = 0;
  let lastTotal = 0;
  let resolveStall: (result: SimLoadResult) => void = () => undefined;
  const stalled = new Promise<SimLoadResult>((resolve) => {
    resolveStall = resolve;
  });
  const phaseDown = opts?.onPhase;
  // #1048 — the QUEUE clock's own allowance: the shop's generated-window seed (three minutes),
  // because that is the same "one stage of a large job can be a long pass" fact, now said for
  // waiting behind another task instead of for silence inside one.
  const queueMs = opts?.queueMs ?? readDefault(liveShopDefaults(), 'sim.stallMs').value;
  // #1056 — A NEW LOAD SUPERSEDES AN OLDER ONE'S WATCHDOG. A load whose promise was orphaned (the
  // app cancels by terminating; a test leaves one pending) kept its clocks armed, and its late
  // stall would TERMINATE whatever worker is current — killing a fresh, healthy load. Only the
  // load that is still current may act on its own stall.
  activeStop?.();
  let myStop: (() => void) | null = null;
  const clocks = loadStallPolicy(
    queueMs,
    stallMs,
    () => phaseDown?.('waiting'),
    () => {
      if (settled || myStop === null || activeStop !== myStop) return;
      settled = true;
      terminateSim();
      resolveStall({
        ok: false,
        pathOnly: false,
        diagnostics: [
          {
            source: 'sweep',
            severity: 'error',
            code: 'sweep-stalled',
            message: sweepStallMessage(stallMs, lastDone, lastTotal, lastPhase),
            ...(lastTotal > 0 ? { checkpoint: lastDone } : null),
          },
        ],
      });
    },
  );
  myStop = () => clocks.stop();
  activeStop = myStop;
  clocks.start();
  // #1048 — THE WORKER'S OWN PHASES (the air phase) are messages too: they reach the caller and
  // re-arm the silence clock, exactly as a checkpoint does.
  let lastPhase: 'sweep' | 'air' | 'air-done' = 'sweep';
  const workerPhase = (phase: SimLoadPhase): void => {
    if (phase === 'air') lastPhase = 'air';
    else if (phase === 'air-done') lastPhase = 'air-done';
    phaseDown?.(phase);
    clocks.heard();
  };
  // #871/#895 — the projection INFORMS and never stops. The clock starts at the FIRST checkpoint,
  // so worker startup and parsing (a fixed cost on every load) are not charged to the sweep's rate.
  const forward = opts?.onProgress;
  const report = opts?.onProjection;
  let rateSince: number | null = null;
  const onProgress = (done: number, total: number, memoryMB?: number | null): void => {
    forward?.(done, total, memoryMB);
    lastDone = done;
    lastTotal = total;
    // #1048 — the worker's FIRST message for this load is the switch: before it the load is
    // queued (waiting), after it silence is the stall the watchdog means.
    clocks.heard();
    if (report === undefined) return;
    rateSince ??= performance.now();
    const ms = sweepProjectionMs(performance.now() - rateSince, done, total);
    if (ms !== null) report(ms, done, total);
  };
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
            stallMs,
            calibration: opts?.calibration ?? null,
            drillPointDefault: opts?.drillPointDefault ?? null,
            flatPitchYMm: opts?.flatPitchYMm ?? null,
            columnPitchXMm: opts?.columnPitchXMm ?? null,
            rotaryPitchDeg: opts?.rotaryPitchDeg ?? null,
            spindleOffProximityMm: opts?.spindleOffProximityMm ?? null,
            threads: opts?.threads ?? null,
            surface: opts?.surface ?? null,
            rampThresholdMm: opts?.rampThresholdMm ?? null,
            breakthroughMm: opts?.breakthroughMm ?? null,
            priorRemoval: opts?.priorRemoval ?? undefined,
            carried: opts?.carried ?? undefined,
            priorFields: opts?.priorFields ?? undefined,
            priorExactRemoval: opts?.priorExactRemoval ?? undefined,
            // #1040 — the walk's from-blank retry continues the run's goal fold. This payload is a
            // WHITELIST, not a spread of `opts`: a field left out here never reaches the session,
            // and the app's run would reset the fold exactly as the command line no longer does.
            continueRun: opts?.continueRun ?? undefined,
          },
          Comlink.proxy(onProgress),
          Comlink.proxy(workerPhase),
        )
        .then(async (r) => {
          // #224: the warm-up is part of the load, not the first scrub. Awaiting `simWarmup`
          // keeps this promise pending (so the UI stays "loading") until the anchor chain is
          // built; only then does the caller go ready and accept scrubs.
          if (r.ok && r.count > 0) {
            // #1056 (6b's latent hole) — THE LOAD IS DONE, SO THE SILENCE CLOCK HAS NOTHING LEFT
            // TO BOUND: it used to stay armed through the playback warm-up and could fire on a
            // healthy, silent warm-up. The warm-up has its own progress; stop the clocks here.
            clocks.stop();
            phaseDown?.('playback');
            await getSimApi().simWarmup();
          }
          return r;
        }),
      stalled,
      // #830 — a worker that died mid-sweep fails this load AT ONCE, with its own words, rather
      // than letting the budget timer report a misleading "too slow" a minute later.
      ...(failure === null ? [] : [failure.promise]),
    ]);
    return result;
  } finally {
    clocks.stop();
    if (activeStop === myStop) activeStop = null;
  }
}

/** Ask for checkpoint k (-1 = uncut). Coalesced: at most one in flight, newest k wins. */
export function requestFrame(k: number, design?: SimDesign): void {
  if (design !== undefined) frameDesign = design;
  frames.request(k);
}

export async function disposeSim(): Promise<void> {
  frames.reset();
  if (simApi) await guarded(simApi.simDispose());
}

export const simStateAt = (step: number) => guarded(getSimApi().simStateAt(step));
export const simToolPath = (from: number, to: number) => guarded(getSimApi().simToolPath(from, to));

/**
 * The whole path, with kinds and times, fetched once per load (#197). The four buffers are
 * transferred, so the copy lives in the main thread from here on.
 */
export const simPath = (): Promise<SimPath> => guarded(getSimApi().simPath());

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
  guarded(getSimApi().engravePreview(job, tools, catalogue, gen, margins, conditions, shop, residuals));

/**
 * #766 D — the measured cutter pick, in the background. Same `gen` as the preview: the worker
 * stops the search at its next plan evaluation once a newer preview request has arrived. `null`
 * means the run was superseded (or the job has nothing to measure) — the caller owns a newer
 * answer, or leaves the rule's provisional one standing.
 */
/**
 * #896 — STOP the measured pick in the worker, without asking for a preview: a renderer starting a
 * run must not have the pick computing beside it, and a goal preview would rebuild the mesh
 * volume the run is already spending. `gen` is the preview store's generation; its next request
 * (a higher gen) resumes measuring.
 */
export const cancelEngravePick = (gen: number): void => {
  if (simApi === null) return;
  void guarded(getSimApi().cancelEngravePick(gen)).catch(() => undefined);
};

export const engraveSmartPick = (
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  gen: number,
  conditions: ReadonlyMap<string, ConditionSummary>,
  shop: EngraveShopOpts,
  /** #785 — the search's candidate counts; its own argument for the Comlink.proxy rule. */
  onProgress?: (p: { level: 'coarse' | 'full'; done: number; total: number }) => void,
): Promise<EngravePickSummary | null> =>
  guarded(
    getSimApi().engraveSmartPick(
      job,
      tools,
      catalogue,
      gen,
      conditions,
      shop,
      onProgress === undefined ? undefined : Comlink.proxy(onProgress),
    ),
  );

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
/** #986 (the ruling) — THE ON-DEMAND IDEAL: the second plan's outcome and the tradeoff line,
 * computed on the press. Posts nothing; returns nulls when there is no ideal. #1049 — the owned
 * outcome Generate produced rides along, so the press plans the ideal half alone; `null` (a stale
 * run) runs both as before. */
export const engravePlanIdeal = (
  job: EngraveJob,
  goal: EngraveTargetObject,
  tool: Tool,
  shop?: EngraveShopOpts,
  catalogueTools?: readonly Tool[],
  ownedOutcome?: PlanOutcome | null,
  catalogue?: readonly FeedCatalogueRow[],
): Promise<{ tradeoff: PlanTradeoff | null; owned: PlanOutcome | null; ideal: PlanOutcome | null }> =>
  guarded(getSimApi().engravePlanIdeal(job, goal, tool, shop ?? {}, catalogueTools ?? [], ownedOutcome ?? null, catalogue ?? []));

export const engraveGenerate = (
  job: EngraveJob,
  tool: Tool | null,
  catalogue: readonly FeedCatalogueRow[],
  calibration: MachineCalibration | null,
  margins: EngraveMargins,
  shop?: EngraveShopOpts,
  /**
   * #785 — stage progress ("roughing level 41 of 112") for the panel and the flight recorder.
   * Its OWN argument and wrapped in `Comlink.proxy`, for the reason `simLoad`'s comment states:
   * a function nested inside a plain object is not recognised as callable and cannot be cloned.
   */
  onProgress?: (progress: EngraveProgress) => void,
  /**
   * #961 — the ideal plan's candidate set: the app's tool library (built-ins, the house service's
   * `cat:` rows and the shop's inventory), read on this side because the worker cannot see the
   * stores. Absent means no ideal — `planIdeal` stays null and only the owned plan is run.
   */
  catalogueTools?: readonly Tool[],
  /**
   * #1151 — owned plan first. True returns as soon as the owned plan has posted, with
   * `idealDeferred`; the caller owes the comparison (`engravePlanIdealOnItsOwnWorker`). The plain
   * CLI leaves it off: today's two-plan run, and its receipt, are unchanged.
   */
  deferIdeal?: boolean,
  /** #1046 — the virtual ladder, on demand (the run-sheet press). Off/absent: unchanged bytes. */
  restLadder?: boolean,
): Promise<EngraveGenerated> =>
  guarded(
    getSimApi().engraveGenerate(
      job,
      tool,
      catalogue,
      calibration,
      margins,
      shop,
      onProgress === undefined ? undefined : Comlink.proxy(onProgress),
      catalogueTools,
      deferIdeal,
      restLadder,
    ),
  );

/**
 * #1151 (#1134(c)'s ruling) — THE IDEAL COMPARISON ON ITS OWN WORKER. The panel's sim worker is a
 * singleton, and the sweep uses it; the ideal half takes ~15 minutes on the set B top, so running
 * it there would queue the simulation behind a comparison. This worker is created for the compare
 * and terminated in the `finally`, whatever the answer. It is the same worker entry and the same
 * `engravePlanIdeal` method the press uses, so the numbers cannot differ; only the realm is new.
 */
export const engravePlanIdealOnItsOwnWorker = (
  job: EngraveJob,
  goal: EngraveTargetObject,
  tool: Tool,
  shop?: EngraveShopOpts,
  catalogueTools?: readonly Tool[],
  ownedOutcome?: PlanOutcome | null,
  catalogue?: readonly FeedCatalogueRow[],
): Promise<{ tradeoff: PlanTradeoff | null; owned: PlanOutcome | null; ideal: PlanOutcome | null }> => {
  const worker = new Worker(new URL('../../workers/sim.worker.ts', import.meta.url), { type: 'module', name: 'sim-ideal' });
  let rejectCrash: (e: Error) => void = () => {};
  const crashed = new Promise<never>((_, reject) => {
    rejectCrash = reject;
  });
  // A crash with nobody awaiting it must not surface as an unhandled rejection (the singleton's
  // own failure object does the same).
  crashed.catch(() => undefined);
  worker.onerror = (event) => {
    event.preventDefault?.();
    rejectCrash(new Error(event.message !== '' ? event.message : 'the ideal-comparison worker stopped with an error'));
  };
  worker.onmessageerror = () => rejectCrash(new Error('the ideal-comparison worker sent a message the page could not read'));
  const api = Comlink.wrap<SimWorkerApi>(worker);
  return Promise.race([
    api.engravePlanIdeal(job, goal, tool, shop ?? {}, catalogueTools ?? [], ownedOutcome ?? null, catalogue ?? []),
    crashed,
  ]).finally(() => worker.terminate());
};

/**
 * #785 — CANCEL a Generate. The sim worker is the one place a wasm call can run for minutes
 * without yielding, so the only reliable stop is to TERMINATE it: the run's pending promise never
 * resolves into state (the store has already orphaned it), and the next call recreates the worker.
 * The same seam `loadSim`'s budget uses.
 */
export const cancelGenerate = (): void => terminateSim();

/**
 * The volumetric oracle (#206 §3) over the program CURRENTLY loaded in the worker's session.
 * Throws when no swept program is loaded — only call after a load that reported `ok`.
 */
export const simOracle = (
  predicted: OraclePredicted[],
  /**
   * #743 P-5 — the board's copper, when the run is a PCB: the topology check reads the SAME loaded
   * simulation at the copper's underside and folds its verdict into the report.
   */
  pcb?: PcbCopperTopologyInput | null,
  /** #924 activation — the generator's own raw design items; additive, plain serializable data. */
  designItems?: DesignCheckItem[],
  /**
   * #948 — the goal this program makes, when it is a goal program: the worker samples the goal at
   * the check's 0.1 mm grid (cached per session) and pairs it with the live sweep's top, so the
   * report carries `goalCutInto`. Absent/`null` on every non-goal run, exactly as before.
   */
  goal?: SimGoalCheck | null,
): Promise<OracleReport> => guarded(getSimApi().simOracle(predicted, pcb ?? null, designItems, goal ?? null));

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
): Promise<DesignJobPatch> => guarded(getSimApi().readDesign3mf(bytes, direction));

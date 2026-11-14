/**
 * #1126 — GENERATE ON THE HOUSE.
 *
 * The panel's Generate asks the house service to run the CLI (`casemaker cut`, the same engine the
 * browser's worker runs) and follows the run: submit, stream the CLI's progress frames, poll the
 * snapshot for the settled state, then read the run's generated document — the plain-data result
 * the worker would have returned. The caller (the run store) hands the result to the same code that
 * settles an in-page run, so persistence, the package, the staleness rules and the Cut step do not
 * know which path produced it.
 *
 * THE CHOICE IS A RUNTIME FACT. `houseGenerationAvailable()` asks `/api/v1/health`; a service that
 * cannot spawn its CLI (no Node, no scripts, a build-time default that is not installed there)
 * reports `runs: false` and the panel takes the in-page path exactly as before. A probe that fails
 * is "absent", never an error: the browser is the fallback, by design.
 *
 * THE SHOP ETAG IS A SUBMIT-TIME PRECONDITION. The page sends the version it read; a service whose
 * location has moved refuses with 412 and the panel says so instead of planning against a shop that
 * changed. The run is keyed `(jobSha, build)` on the service side, never on the ETag.
 */

import { probeHouse, type HouseFailure } from './houseClient';
import {
  cancelRun,
  readRun,
  readRunGenerated,
  streamRunEvents,
  submitRun,
  type RunEvent,
} from './runsClient';
import { useLocationStore } from '@/store/locationStore';
import type { EngraveJob } from '@/types/engraveJob';
import type { Tool } from '@/engine/cnc/tool';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { EngraveMargins } from '@/types/engraveJob';
import type {
  EngraveGenerated,
  EngraveProgress,
  EngraveShopOpts,
} from '@/workers/sim/engraveGenerate';

/** The stages the engine's own progress objects use; anything else is relayed as a note. */
const ENGINE_STAGES: readonly EngraveProgress['stage'][] = [
  'prepare',
  'items',
  'plan',
  'sample',
  'rough',
  'finish',
  'post',
  'verify',
  'done',
];

/** Between two snapshot reads while a run is in flight. A house run takes minutes; a second is
 * frequent enough for the panel's clock and idle enough to leave the service alone. */
const POLL_MS = 1000;
let pollMs = POLL_MS;

/** Test seam: shrink the snapshot poll so a spec follows a run without waiting on the clock. */
export function setHouseRunPollMs(ms: number): void {
  pollMs = Math.max(1, ms);
}

/** The run this page last submitted, for the store's stall/cancel path. */
let activeRunId: string | null = null;

/** Whether this service can run generation. An absent or unhappy service is simply `false`. */
export async function houseGenerationAvailable(): Promise<boolean> {
  const probe = await probeHouse();
  return probe.kind === 'present' && probe.health.runs === true;
}

/**
 * #1293 — WHICH SIDE PLANS, in one sentence for the run's progress line. Never a silent fallback:
 * a house that cannot run says why, in the service's own words, and a missing house says so.
 */
export async function houseGenerationStatus(): Promise<{
  available: boolean;
  sentence: string;
  /** The service's own sentence (the Node path, the setting to change), for the run's Log. */
  detail?: string;
}> {
  const probe = await probeHouse();
  if (probe.kind === 'present' && probe.health.runs === true) {
    return { available: true, sentence: 'Planning on the house.' };
  }
  if (probe.kind !== 'present') {
    return { available: false, sentence: 'Planning in this page — no house answered.' };
  }
  const { runsReasonCode: code, runsReason: reason } = probe.health;
  if (code === undefined || code === '') {
    return { available: false, sentence: "Planning in this page — the house can't run jobs yet." };
  }
  return {
    available: false,
    sentence: "Planning in this page — this house's install cannot plan jobs.",
    ...(reason === undefined || reason.trim() === '' ? {} : { detail: reason.trim() }),
  };
}

/** Cancel the run this page is following, if any. Fire-and-forget: the caller is a stall path. */
export function cancelActiveHouseRun(): void {
  const id = activeRunId;
  activeRunId = null;
  if (id !== null) void cancelRun(id);
}

/** One plain sentence for a failed request. The service writes these for the user. */
export function houseFailureSentence(failure: HouseFailure): string {
  switch (failure.kind) {
    case 'refused':
      return failure.message;
    case 'absent':
      return failure.reason;
    case 'error':
      return failure.detail;
  }
}

/**
 * Map one CLI frame onto the panel's progress language. The engine's frames ARE `EngraveProgress`
 * objects; a `note` frame (a pick word, an advisory) keeps the stage it was emitted in, so the run
 * log reads in order without inventing a stage.
 */
function progressReporter(onProgress: ((progress: EngraveProgress) => void) | undefined): {
  report: (event: RunEvent) => void;
} {
  let lastStage: EngraveProgress['stage'] = 'prepare';
  return {
    report(event: RunEvent): void {
      if (onProgress === undefined) return;
      if (event.stage === 'note') {
        onProgress({ stage: lastStage, label: event.label ?? '' });
        return;
      }
      if (!ENGINE_STAGES.includes(event.stage as EngraveProgress['stage'])) return;
      lastStage = event.stage as EngraveProgress['stage'];
      onProgress({
        stage: lastStage,
        label: event.label ?? '',
        ...(event.done === undefined ? {} : { done: event.done }),
        ...(event.total === undefined ? {} : { total: event.total }),
      });
    },
  };
}

export interface HouseGenerateArgs {
  job: EngraveJob;
  tool: Tool | null;
  catalogue: readonly FeedCatalogueRow[];
  calibration: MachineCalibration | null;
  margins: EngraveMargins;
  shop?: EngraveShopOpts;
  onProgress?: (progress: EngraveProgress) => void;
  /**
   * #1175 — THE IDEAL PLAN'S CANDIDATE SET, exactly as the browser's Generate passes it: the
   * app's whole tool library (`getTools().map((entry) => entry.tool)`). Forwarded to the service,
   * which hands the CLI a `--tools` file — without it the CLI plans the ideal from its own
   * location/catalogue snapshot, which is a different list read at a different time.
   */
  catalogueTools?: readonly Tool[];
  /** #1175 — the run sheet's ladder press (#1046): the service passes the CLI `--rest-ladder`. */
  restLadder?: boolean;
}

/**
 * Submit a job to the house and follow it to a settled result.
 *
 * Throws with the service's own sentence when the submit is refused (a full queue, a moved shop, a
 * service that cannot spawn), and with the run's stated finding when the run fails or is killed.
 * Progress arrives on the SSE stream; the snapshot poll is both the state authority and the
 * fallback when a stream is lost — a lost stream is not a lost run.
 */
export async function houseEngraveGenerate(args: HouseGenerateArgs): Promise<EngraveGenerated> {
  const shopEtag = useLocationStore.getState().etag;
  const submitted = await submitRun({
    job: args.job,
    ...(shopEtag === null ? {} : { shopEtag }),
    // #1175 — the two inputs the browser's Generate passes that are not in the job document: the
    // ideal's candidate set and the ladder press. Only written when asked for, so an ordinary
    // Generate's submit body is byte-identical to a pre-#1175 one.
    ...(args.catalogueTools === undefined ? {} : { tools: args.catalogueTools }),
    ...(args.restLadder === true ? { restLadder: true } : {}),
  });
  if (submitted.kind !== 'ok') throw new Error(houseFailureSentence(submitted));
  const id = submitted.runId;
  activeRunId = id;

  const { report } = progressReporter(args.onProgress);
  const controller = new AbortController();
  // The stream carries the engine's frames as they happen; it never decides the outcome.
  void streamRunEvents(id, report, { signal: controller.signal });

  // A QUEUED RUN IS NOT A SILENT ONE. The store's silence watchdog times a run by its last stage
  // report; a house run can wait behind another job before any stage exists, so the wait itself is
  // reported — once at submit and on every poll while the service says `queued`. The label is the
  // same sentence each time, so the run log keeps one line.
  const queued = (position: number | undefined): void => {
    args.onProgress?.({
      stage: 'prepare',
      label:
        position === undefined || position < 1
          ? 'queued on the house'
          : `queued on the house — position ${position}`,
    });
  };
  if (submitted.queuePosition >= 1) queued(submitted.queuePosition);

  try {
    for (;;) {
      const read = await readRun(id);
      if (read.kind !== 'ok') {
        // A dropped snapshot request is not a lost run: keep the last state and ask again.
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const run = read.run;
      if (run.state === 'queued') queued(run.queuePosition);
      if (run.state === 'done') {
        const result = await readRunGenerated(id);
        if (result.kind !== 'ok') throw new Error(houseFailureSentence(result));
        return result.generated as EngraveGenerated;
      }
      if (run.state === 'failed') {
        throw new Error(run.finding ?? 'the house run failed, and did not say why');
      }
      if (run.state === 'cancelled') throw new Error('the house run was cancelled');
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    controller.abort();
    if (activeRunId === id) activeRunId = null;
  }
}

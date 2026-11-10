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
  });
  if (submitted.kind !== 'ok') throw new Error(houseFailureSentence(submitted));
  const id = submitted.runId;
  activeRunId = id;

  const { report } = progressReporter(args.onProgress);
  const controller = new AbortController();
  // The stream carries the engine's frames as they happen; it never decides the outcome.
  void streamRunEvents(id, report, { signal: controller.signal });

  try {
    for (;;) {
      const read = await readRun(id);
      if (read.kind !== 'ok') {
        // A dropped snapshot request is not a lost run: keep the last state and ask again.
        await new Promise((resolve) => setTimeout(resolve, pollMs));
        continue;
      }
      const run = read.run;
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

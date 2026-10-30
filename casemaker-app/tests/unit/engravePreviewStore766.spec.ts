// #766 D — THE BACKGROUND MEASURED SEARCH in the preview store. The panel must draw at once with
// the #211 rule answer (labelled provisional), then ask the sim worker for the measured pick on a
// one-second debounce; any further edit cancels or supersedes that run; and a completed answer is
// kept across edits a measure cannot see — in particular the write-back of the answer into the
// job, which changes the tool key and the setups but no geometry.
//
// The worker side is `smartPickRun.ts` (its cancellation is pinned in `smartPickRun.spec.ts`);
// this drives the store with a client whose `engraveSmartPick` resolves only when the test says so.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ENGRAVE_PICK_DEBOUNCE_MS,
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { applyCutterPlanToJob, measureFingerprint, smartPickKey } from '@/engine/cnc/engrave/measuredPick';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngravePickSummary } from '@/workers/sim/smartPickRun';
import type { FeedCatalogueRow } from '@/engine/cnc/feeds';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import type { ConditionSummary } from '@/engine/cnc/toolCondition';
import type { EngraveShopOpts } from '@/workers/sim/engraveGenerate';

interface PendingCall {
  job: EngraveJob;
  gen: number;
  resolve: () => void;
}

function summaryFor(
  job: EngraveJob,
  tools: readonly ToolLibraryEntry[],
  catalogue: readonly FeedCatalogueRow[],
  conditions: ReadonlyMap<string, ConditionSummary>,
  shop: EngraveShopOpts,
): EngravePickSummary {
  return {
    jobKey: smartPickKey(job, { tools, catalogue, conditions, shop }),
    cutters: [{ key: 'flat-1.0', items: [job.labels[0]!.id], source: 'owned' }],
    words: {
      plan: '⌀1',
      verdict: `Chosen by simulation for ${job.labels[0]!.text}.`,
      cutters: [],
      runnerUp: null,
      buyThis: null,
      difference: null,
      notes: [],
    },
    worstFidelity: 0.9,
    toolChanges: 0,
    seconds: 30,
    considered: 2,
  };
}

let calls: PendingCall[] = [];

function fakeClient(): EngravePreviewClient {
  return {
    engravePreview: async () => null,
    engraveSmartPick: (job, tools, catalogue, gen, conditions, shop) =>
      new Promise((resolve) => {
        const summary = summaryFor(job, tools, catalogue, conditions, shop);
        calls.push({ job, gen, resolve: () => resolve(summary) });
      }),
  };
}

/** A job whose only difference from `defaultEngraveJob` is the first label's text. */
function jobWith(text: string): EngraveJob {
  const job = defaultEngraveJob();
  job.labels = [{ ...job.labels[0]!, text }];
  job.toolKey = '';
  delete job.sources;
  return job;
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  setEngravePreviewClientLoader(async () => fakeClient());
  useEngravePreviewStore.getState().dispose();
});

afterEach(() => {
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
  vi.useRealTimers();
});

describe('#766 D the store’s background measured search', () => {
  it('shows the rule answer as provisional at once, and the measured answer replaces it', async () => {
    const job = jobWith('CASE');
    useEngravePreviewStore.getState().request(job);
    // Immediately — before any timer, before the worker answers — the panel has a provisional
    // answer to draw (the preview's own #211 recommendation stands; only its label changes).
    expect(useEngravePreviewStore.getState().measuredStatus).toBe('measuring');
    expect(useEngravePreviewStore.getState().measured).toBeNull();

    await vi.advanceTimersByTimeAsync(ENGRAVE_PICK_DEBOUNCE_MS);
    expect(calls.length).toBe(1);
    calls[0]!.resolve();
    await flush();

    const state = useEngravePreviewStore.getState();
    expect(state.measuredStatus).toBe('ready');
    expect(state.measured?.words.plan).toBe('⌀1');
    expect(state.measuredJob).toBe(measureFingerprint(job));
  });

  it('an edit mid-search supersedes the run and starts a new one; the old answer is dropped', async () => {
    const first = jobWith('CASE');
    useEngravePreviewStore.getState().request(first);
    await vi.advanceTimersByTimeAsync(ENGRAVE_PICK_DEBOUNCE_MS);
    expect(calls.length).toBe(1);
    expect(calls[0]!.job.labels[0]!.text).toBe('CASE');

    // The user edits while the search is still running.
    const second = jobWith('MAKER');
    useEngravePreviewStore.getState().request(second);
    expect(useEngravePreviewStore.getState().measuredStatus).toBe('measuring');
    expect(useEngravePreviewStore.getState().measured).toBeNull();
    await vi.advanceTimersByTimeAsync(ENGRAVE_PICK_DEBOUNCE_MS);
    expect(calls.length).toBe(2);
    expect(calls[1]!.job.labels[0]!.text).toBe('MAKER');

    // The superseded run's answer arrives late and must not be shown.
    calls[0]!.resolve();
    await flush();
    expect(useEngravePreviewStore.getState().measured).toBeNull();
    expect(useEngravePreviewStore.getState().measuredStatus).toBe('measuring');

    // The run for the edited job is what lands.
    calls[1]!.resolve();
    await flush();
    const state = useEngravePreviewStore.getState();
    expect(state.measuredStatus).toBe('ready');
    expect(state.measured?.words.verdict).toContain('MAKER');
    expect(state.measuredJob).toBe(measureFingerprint(second));
  });

  it('keeps the measured answer when the answer itself is written into the job', async () => {
    const job = jobWith('CASE');
    useEngravePreviewStore.getState().request(job);
    await vi.advanceTimersByTimeAsync(ENGRAVE_PICK_DEBOUNCE_MS);
    calls[0]!.resolve();
    await flush();
    const measured = useEngravePreviewStore.getState().measured;
    expect(measured).not.toBeNull();

    // The panel writes the measured plan back — the tool key, one setup, `sources.tool` — exactly
    // as 'Use the recommendation' and Generate do.
    const applied = applyCutterPlanToJob(job, { cutters: [{ key: 'flat-1.0', items: [job.labels[0]!.id] }] });
    applied.sources = { ...(applied.sources ?? {}), tool: 'computed' };
    expect(measureFingerprint(applied)).toBe(measureFingerprint(job));

    useEngravePreviewStore.getState().request(applied);
    // Still the same answer — a write-back is not an edit — and no new search is scheduled.
    expect(useEngravePreviewStore.getState().measuredStatus).toBe('ready');
    expect(useEngravePreviewStore.getState().measured).toBe(measured);
    await vi.advanceTimersByTimeAsync(ENGRAVE_PICK_DEBOUNCE_MS * 2);
    expect(calls.length).toBe(1);
  });

  it('does not search a job with several saved setups — the search judges ONE setup', async () => {
    // `applyCutterPlanToJob` writes the whole plan into setup 0; judging a multi-setup job would
    // collapse the others, so the rule's answer stands unlabelled instead.
    const job = jobWith('CASE');
    job.setups = [{ id: 'a' }, { id: 'b' }] as unknown as EngraveJob['setups'];
    useEngravePreviewStore.getState().request(job);
    expect(useEngravePreviewStore.getState().measuredStatus).toBe('idle');
    await vi.advanceTimersByTimeAsync(ENGRAVE_PICK_DEBOUNCE_MS * 2);
    expect(calls.length).toBe(0);
    expect(await useEngravePreviewStore.getState().measureNow(job)).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('measureNow runs the search at once for a Generate pressed before the debounce, and reuses it', async () => {
    const job = jobWith('CASE');
    useEngravePreviewStore.getState().request(job);
    const pending = useEngravePreviewStore.getState().measureNow(job);
    await flush();
    expect(calls.length).toBe(1);
    calls[0]!.resolve();
    const pick = await pending;
    expect(pick?.words.plan).toBe('⌀1');

    // A second press for the same job answers from what is already measured.
    const again = await useEngravePreviewStore.getState().measureNow(job);
    expect(again).toBe(pick);
    expect(calls.length).toBe(1);
  });
});

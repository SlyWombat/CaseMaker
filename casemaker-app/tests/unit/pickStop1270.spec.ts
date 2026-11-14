// #1270 — WHAT A STOP DOES TO THE MEASURED PICK, pinned (analyst ruling, 2026-11-14: nothing to
// build; the pick the press waits on IS the background measurement every edit starts).
//
// The fake client models the worker's own rule (`runSmartPick`): a pick checks its generation at a
// BOUNDARY (between plan evaluations) and returns null when a newer request or `cancelEngravePick`
// has moved the latest generation past it; `step()` is one evaluation. Each test steps it by hand.
//
//  (a) Stop during the pick → the earlier phase, the measurement still in flight.
//  (b) a second press JOINS the same pick: one worker call, progress carries on from candidate k.
//  (c) an edit makes the old pick return null at its next boundary, and a new one starts.
//  (d) Generate holds the measurement: the pick ends within one evaluation.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { smartPickKey } from '@/engine/cnc/engrave/measuredPick';
import { pickUnderProgress } from '@/store/generatePick';
import {
  ENGRAVE_PICK_DEBOUNCE_MS,
  setEngravePreviewClientLoader,
  useEngravePreviewStore,
  type EngravePreviewClient,
} from '@/store/engravePreviewStore';
import { setEngraveRunClientLoader, useEngraveRunStore } from '@/store/engraveRunStore';
import type { EngraveJob } from '@/types/engraveJob';
import type { EngravePickSummary } from '@/workers/sim/smartPickRun';

const TOTAL = 5;

interface FakePick {
  gen: number;
  done: number;
  settled: 'pending' | 'summary' | 'null';
  /** One plan evaluation: stale → the pick returns null; otherwise one more candidate, the last one answers. */
  step: () => 'stale' | 'ran';
}

let latestGen = 0;
let picks: FakePick[] = [];

function fakeClient(): EngravePreviewClient {
  return {
    engravePreview: async (_job, _tools, _catalogue, gen) => {
      latestGen = Math.max(latestGen, gen);
      return null;
    },
    cancelEngravePick: (gen) => {
      if (gen + 1 > latestGen) latestGen = gen + 1;
    },
    engraveSmartPick: (job, tools, catalogue, gen, conditions, shop, onProgress) =>
      new Promise<EngravePickSummary | null>((resolve) => {
        const pick: FakePick = {
          gen,
          done: 0,
          settled: 'pending',
          step: () => {
            if (latestGen > pick.gen) {
              pick.settled = 'null';
              resolve(null);
              return 'stale';
            }
            pick.done += 1;
            onProgress?.({ level: 'coarse', done: pick.done, total: TOTAL });
            if (pick.done === TOTAL) {
              pick.settled = 'summary';
              resolve({
                jobKey: smartPickKey(job, { tools, catalogue, conditions, shop }),
                cutters: [{ key: 'flat-1.0', items: [job.labels[0]!.id], source: 'owned' }],
                words: { plan: '⌀1', verdict: 'chosen', fallback: null, cutters: [], runnerUp: null, buyThis: null, difference: null, notes: [] },
                worstFidelity: 0.9,
                toolChanges: 0,
                seconds: 30,
                considered: TOTAL,
              });
            }
            return 'ran';
          },
        };
        picks.push(pick);
      }),
  };
}

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

/** The store counts its worker calls at module level: end every call a test left in flight. */
async function settleAll(): Promise<void> {
  latestGen = Number.MAX_SAFE_INTEGER;
  for (const p of picks) if (p.settled === 'pending') p.step();
  await flush();
}
const press = (job: EngraveJob) => pickUnderProgress(() => useEngravePreviewStore.getState().measureNow(job));

beforeEach(() => {
  vi.useFakeTimers();
  latestGen = 0;
  picks = [];
  setEngravePreviewClientLoader(async () => fakeClient());
  useEngravePreviewStore.getState().dispose();
  useEngraveRunStore.getState().reset();
});
afterEach(async () => {
  await settleAll();
  useEngraveRunStore.getState().reset();
  useEngravePreviewStore.getState().dispose();
  setEngravePreviewClientLoader(null);
  setEngraveRunClientLoader(null);
  vi.useRealTimers();
});

describe('#1270 — a Stop during the measured pick', () => {
  it('(a) returns the run to its earlier phase while the measurement carries on in the worker', async () => {
    const outcome = press(jobWith('CASE'));
    await flush();
    expect(useEngraveRunStore.getState().phase).toBe('generating');
    expect(picks).toHaveLength(1);
    picks[0]!.step();

    useEngraveRunStore.getState().cancelGenerate();
    expect(useEngraveRunStore.getState().phase).toBe('idle');
    expect(picks[0]!.settled).toBe('pending');
    expect(useEngravePreviewStore.getState().workerOccupant()).toBe('the measured pick');

    // The press reports itself stopped when the pick returns; the pick itself is not killed.
    while (picks[0]!.settled === 'pending') picks[0]!.step();
    expect(await outcome).toMatchObject({ started: true, cancelled: true });
  });

  it('(b) a second press joins the same pick where it is — one worker call, progress from candidate k', async () => {
    const job = jobWith('CASE');
    const first = press(job);
    await flush();
    picks[0]!.step();
    picks[0]!.step(); // two candidates done
    useEngraveRunStore.getState().cancelGenerate();

    const second = press(job);
    await flush();
    expect(picks).toHaveLength(1); // joined, not restarted
    expect(useEngraveRunStore.getState().phase).toBe('generating');
    picks[0]!.step(); // candidate 3 — the new press's line shows it, not "1 of 5"
    expect(useEngraveRunStore.getState().progress).toMatchObject({ label: 'choosing the cutter — candidate 3 of 5', done: 3, total: TOTAL });

    while (picks[0]!.settled === 'pending') picks[0]!.step();
    expect(await second).toMatchObject({ started: true, cancelled: false });
    expect((await first).started).toBe(true);
  });
});

describe('#1270 — an edit and a Generate meet the pick at its next boundary', () => {
  it('(c) an edit makes the old pick return null at its next evaluation, and a new one starts', async () => {
    const store = useEngravePreviewStore.getState();
    void store.measureNow(jobWith('CASE'));
    await flush();
    expect(picks).toHaveLength(1);
    picks[0]!.step();

    store.request(jobWith('CASES'));
    await vi.advanceTimersByTimeAsync(ENGRAVE_PICK_DEBOUNCE_MS);
    expect(picks[0]!.settled).toBe('pending'); // still running until its boundary
    expect(picks[0]!.step()).toBe('stale');
    expect(picks[0]!.settled).toBe('null');
    await vi.advanceTimersByTimeAsync(ENGRAVE_PICK_DEBOUNCE_MS);
    expect(picks.length).toBeGreaterThanOrEqual(2);
    expect(picks[picks.length - 1]!.settled).toBe('pending');
  });

  it('(d) Generate holds the measurement: the pick ends after at most one more evaluation', async () => {
    void useEngravePreviewStore.getState().measureNow(jobWith('CASE'));
    await flush();
    picks[0]!.step();
    setEngraveRunClientLoader(async () => ({ engraveGenerate: () => new Promise(() => {}) }) as never);
    void useEngraveRunStore.getState().generate(null, {});
    await flush();

    expect(picks[0]!.settled).toBe('pending'); // not killed mid-evaluation …
    expect(picks[0]!.step()).toBe('stale'); // … but gone at its next boundary
    expect(picks[0]!.settled).toBe('null');
    await flush(); // the store's own `finally` runs a microtask after the pick settles
    expect(useEngravePreviewStore.getState().workerOccupant()).toBeNull();
    useEngraveRunStore.getState().cancelGenerate();
  });
});

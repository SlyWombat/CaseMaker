/**
 * #1048 — THE LOAD'S TWO CLOCKS. The sim worker is shared with the background ideal plan, so a
 * load can queue behind it for minutes; the old single window armed at the call read that queue
 * as silence and terminated a healthy worker. Before the worker's first message the load is
 * WAITING (never a fault); after it, silence is the stall #895 means.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadStallPolicy } from '@/engine/jobs/simClient';

describe('#1048 — the load waits out the queue before it may call a stall', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('silence before the worker’s first message is WAITING, re-armed, never a stall', () => {
    let waiting = 0;
    let stalled = 0;
    const clocks = loadStallPolicy(180_000, 30_000, () => waiting++, () => stalled++);
    clocks.start();
    vi.advanceTimersByTime(180_000);
    expect(waiting, 'one waiting report per queue window').toBe(1);
    expect(stalled, 'a queued load is never a stall').toBe(0);
    vi.advanceTimersByTime(180_000);
    expect(waiting).toBe(2);
    expect(stalled).toBe(0);
    clocks.stop();
  });

  it('after the worker speaks, silence IS a stall; every message re-arms it', () => {
    let waiting = 0;
    let stalled = 0;
    const clocks = loadStallPolicy(180_000, 30_000, () => waiting++, () => stalled++);
    clocks.start();
    clocks.heard();
    vi.advanceTimersByTime(29_999);
    expect(stalled, 'one millisecond short is not a stall').toBe(0);
    clocks.heard();
    vi.advanceTimersByTime(29_999);
    expect(stalled, 'the second message re-armed the window').toBe(0);
    vi.advanceTimersByTime(1);
    expect(stalled).toBe(1);
    expect(waiting, 'the queue clock never fired once the worker spoke').toBe(0);
    clocks.stop();
  });

  it('stop closes both clocks', () => {
    let waiting = 0;
    let stalled = 0;
    const clocks = loadStallPolicy(180_000, 30_000, () => waiting++, () => stalled++);
    clocks.start();
    clocks.heard();
    clocks.stop();
    vi.advanceTimersByTime(1_000_000);
    expect(waiting + stalled).toBe(0);
  });
});

// ── #1048 (the Manager's follow-up) — WHILE THE LOAD WAITS ────────────────────────────────────
// Option (a): the wait is shown with its elapsed time, and Stop stays available. A liveness ping
// cannot tell a queue from a wasm call that will never return (the ping itself queues behind it),
// so no ping is added; a CRASHED worker is already caught by the client's worker-error race.
import { setSimClientLoader, useSimStore, type SimClient } from '@/store/simStore';
import { flatEndMill } from '@/engine/cnc/tool';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';

describe('#1048 — a load waiting on the worker is shown as waiting, with its elapsed time', () => {
  it('the first waiting report starts the clock; a checkpoint ends it', async () => {
    let phase: ((p: 'waiting' | 'sweep' | 'playback') => void) | null = null;
    let progress: ((done: number, total: number) => void) | null = null;
    const client = {
      setSimSinks: () => undefined,
      loadSim: async (..._a: unknown[]) => {
        const opts = _a[4] as
          | { onPhase?: (p: 'waiting' | 'sweep' | 'playback') => void; onProgress?: (done: number, total: number) => void }
          | undefined;
        phase = opts?.onPhase ?? null;
        progress = opts?.onProgress ?? null;
        return new Promise(() => undefined);
      },
      requestFrame: () => undefined,
      simPath: async () => null,
      disposeSim: async () => undefined,
    } as unknown as SimClient;
    setSimClientLoader(async () => client);
    try {
      const job = defaultEngraveJob();
      const pending = useSimStore.getState().loadProgram('G0 X0 Y0\n', { stock: {} } as never, flatEndMill(3.175, { name: 'x' }), null);
      await Promise.resolve();
      expect(useSimStore.getState().phase).toBe('sweep');
      expect(useSimStore.getState().waitingSince).toBeNull();
      phase!('waiting');
      const since = useSimStore.getState().waitingSince;
      expect(useSimStore.getState().phase).toBe('waiting');
      expect(since, 'the wait started being timed').not.toBeNull();
      phase!('waiting');
      expect(useSimStore.getState().waitingSince, 'each re-arm keeps the FIRST timestamp').toBe(since);
      progress!(1, 35);
      expect(useSimStore.getState().waitingSince, 'the first checkpoint ends the wait').toBeNull();
      // A's finding (#1048): the phase must leave 'waiting' too, or the panel keeps the wait
      // sentence over the whole sweep instead of the swept/time-left line.
      expect(useSimStore.getState().phase, 'the sweep stage resumes at the first checkpoint').toBe('sweep');
      void pending;
      void job;
    } finally {
      setSimClientLoader(null);
    }
  });
});

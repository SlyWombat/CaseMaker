// #895 — THE SIMULATION STOPS ON A STALL, NOT ON A CLOCK. The maintainer, 2026-11-01: "as long as
// I see progress happening there is no need to timeout". A sweep that keeps reporting checkpoints
// runs as long as it takes; only silence is a fault. The projection (#871) still informs the
// progress line — it no longer stops anything.
//
// The watchdog is exported so both rules can be pinned without a worker: steady progress past the
// old 60 s limit is not stopped, and a sweep that goes quiet is stopped after the window.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SIM_LOAD_STALL_MS, stallWatchdog, sweepProjectionMs, sweepStallMessage } from '@/engine/jobs/simClient';
import { KNOWN_DEFAULTS, RETIRED_DEFAULTS, readDefault } from '@/platform/defaultsClient';
import { DEFAULT_SIM_STALL_MS } from '@/store/simStore';

afterEach(() => {
  vi.useRealTimers();
});

describe('#895 — the progress watchdog', () => {
  it('a sweep that keeps reporting runs past the old 60 s limit without being stopped', () => {
    vi.useFakeTimers();
    const stalls: number[] = [];
    const watchdog = stallWatchdog(30_000, () => stalls.push(Date.now()));
    watchdog.arm();
    // Ten minutes of a checkpoint every 20 s — every one of them re-arms the window.
    for (let i = 0; i < 30; i++) {
      vi.advanceTimersByTime(20_000);
      watchdog.arm();
    }
    expect(stalls).toEqual([]);
    watchdog.stop();
  });

  it('a sweep that goes quiet is stopped after the window, naming what it was doing', () => {
    vi.useFakeTimers();
    let fired = 0;
    const watchdog = stallWatchdog(30_000, () => {
      fired += 1;
    });
    watchdog.arm();
    vi.advanceTimersByTime(29_999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    // It fires ONCE, and an arm after the fact does nothing.
    watchdog.arm();
    vi.advanceTimersByTime(120_000);
    expect(fired).toBe(1);
  });

  it('a finished load disarms the window: no stall is reported after it settled', () => {
    vi.useFakeTimers();
    let fired = 0;
    const watchdog = stallWatchdog(30_000, () => {
      fired += 1;
    });
    watchdog.arm();
    watchdog.stop();
    vi.advanceTimersByTime(120_000);
    expect(fired).toBe(0);
  });

  it('#1056 (6b’s wording) — what the app knows: nothing was reported for the window, and where it last heard from', () => {
    expect(sweepStallMessage(30_000, 7, 35)).toBe(
      'the simulation reported nothing for 30 s after checkpoint 7 of 35.',
    );
    // The last checkpoint is its own place: there are none after it.
    expect(sweepStallMessage(30_000, 35, 35)).toBe(
      'the simulation reported nothing for 30 s after the last checkpoint.',
    );
    // The rapid-move check is its own phase, mid-check and (the ruled first sentence) once done.
    expect(sweepStallMessage(30_000, 12, 35, 'air')).toBe(
      'the simulation reported nothing for 30 s after checking rapid move 12 of 35.',
    );
    expect(sweepStallMessage(30_000, 35, 35, 'air-done')).toBe(
      'the simulation reported nothing for 30 s after the rapid-move check finished.',
    );
    // Before any report there is no place to name.
    expect(sweepStallMessage(30_000, 0, 0)).toBe('the simulation reported nothing for 30 s.');
  });
});

describe('#895 — the projection informs and never stops', () => {
  it('still projects elapsed ÷ done × total once the sample is worth trusting', () => {
    expect(sweepProjectionMs(10_000, 10, 100)).toBe(100_000);
    // Under the 4 s floor: the first checkpoints are parsing and warm-up, not a rate.
    expect(sweepProjectionMs(1_000, 50, 100)).toBeNull();
    // Under 5 % of the checkpoints: a rate read from one or two of a hundred is noise.
    expect(sweepProjectionMs(10_000, 2, 1000)).toBeNull();
    expect(sweepProjectionMs(10_000, 1, 10)).toBe(100_000);
    expect(sweepProjectionMs(10_000, 0, 100)).toBeNull();
    expect(sweepProjectionMs(10_000, 10, 0)).toBeNull();
  });
});

describe('#895 — the shop key', () => {
  it('seeds the stall window at 30 s, and the two no-service fallbacks agree', () => {
    expect(KNOWN_DEFAULTS['sim.loadStallMs']!.fallback).toBe(30_000);
    expect(SIM_LOAD_STALL_MS).toBe(30_000);
    expect(DEFAULT_SIM_STALL_MS).toBe(30_000);
    expect(readDefault(null, 'sim.loadStallMs')).toEqual({ value: 30_000, source: 'fallback' });
  });

  it('RETIRES sim.budgetMs: a stored total-time budget is not read as a stall window', () => {
    expect(RETIRED_DEFAULTS['sim.budgetMs']).toContain('retired');
    // A location that still carries the old key gets the 30 s window, not its 10-minute budget.
    const legacy = {
      'sim.budgetMs': { value: 600_000, source: 'chosen' as const, setAt: null, unit: 'ms', note: null },
    };
    expect(readDefault(legacy, 'sim.loadStallMs')).toEqual({ value: 30_000, source: 'fallback' });
  });
});

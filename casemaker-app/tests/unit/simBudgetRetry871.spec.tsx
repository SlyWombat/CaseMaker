// @vitest-environment jsdom
/**
 * #871 — A SWEEP THAT CANNOT FINISH IS SAID UP FRONT, AND THE CUT STEP CAN ANSWER IT.
 *
 * The maintainer's job on k3 (a 1 mm flat, estimated at about 79 h of cutting) swept for the whole
 * 60 s limit and then died with "Try again with a longer limit" — an instruction whose only control
 * lived in the Simulate panel, not on the Cut screen they were on. Two pure rules carry the fix's
 * judgement, and the session's limit is raised by a button beside the sentence:
 *
 *   1. the sweep's own rate (`elapsed / done × total`) is trusted only after a floor of time and a
 *      share of the checkpoints, and is called over only with headroom (a noisy first sample must
 *      not stop a program that would have finished);
 *   2. the sentence names the sample it came from, the projection and the limit.
 *
 * The panel's button itself is pinned in `engravePanel.spec.tsx` (it needs the panel's harness).
 */
import { describe, expect, it } from 'vitest';

import {
  sweepProjectionMessage,
  sweepProjectionMs,
  sweepProjectionOverLimit,
} from '@/engine/jobs/simClient';
import { useSimStore } from '@/store/simStore';

describe('#871 the sweep’s own projection', () => {
  it('projects elapsed ÷ done × total once the sample is worth trusting', () => {
    expect(sweepProjectionMs(10_000, 10, 100)).toBe(100_000);
  });

  it('says nothing from a sample that is too early', () => {
    // Under the 4 s floor: the first checkpoints are parsing and warm-up, not a rate.
    expect(sweepProjectionMs(1_000, 50, 100)).toBeNull();
    // Under 5 % of the checkpoints: a rate read from one or two of a hundred is noise.
    expect(sweepProjectionMs(10_000, 2, 1000)).toBeNull();
    // A total of 10 makes the 5 % share one checkpoint, and the floor is time.
    expect(sweepProjectionMs(10_000, 1, 10)).toBe(100_000);
    // Nonsense projects nothing.
    expect(sweepProjectionMs(10_000, 0, 100)).toBeNull();
    expect(sweepProjectionMs(10_000, 10, 0)).toBeNull();
  });

  it('calls the sweep over only with the margin’s headroom', () => {
    // A 60 s limit: a 75 s projection is exactly the 1.25 margin and is NOT over; a hair past it is.
    expect(sweepProjectionOverLimit(10_000, 10, 75, 60_000)).toBeNull();
    expect(sweepProjectionOverLimit(10_001, 10, 75, 60_000)).toBeCloseTo(75_007.5, 3);
    // Well over: 10 checkpoints of 100 at 1 s each → 100 s against a 60 s limit.
    expect(sweepProjectionOverLimit(10_000, 10, 100, 60_000)).toBe(100_000);
    // The same ratio against a raised limit is not over any more — the retry's whole point.
    expect(sweepProjectionOverLimit(10_000, 10, 100, 120_000)).toBeNull();
  });

  it('states its sample, its projection and the limit in one sentence', () => {
    expect(sweepProjectionMessage(10, 100, 100_000, 60_000)).toBe(
      'the simulation is too slow to finish: at the rate it has run (10 of 100 checkpoints) it ' +
        'projects about 1 min 40 s, and the limit is 60 s. Try again with a longer limit',
    );
    // A huge projection is in the words the program's own cut estimate uses ("78 h 53 min"), not
    // in raw seconds: the maintainer's job was shown "about 78 h 56 min" before the run.
    expect(sweepProjectionMessage(10, 100, 284_000_000, 60_000)).toContain('projects about 78 h 53 min');
  });
});

describe('#871 raising the session’s limit', () => {
  it('doubles the limit the next load uses, and returns it', () => {
    const before = useSimStore.getState().budgetMs;
    const next = useSimStore.getState().raiseBudget();
    expect(next).toBe(before * 2);
    // The state is what `loadProgram` reads for a session that has already loaded once.
    expect(useSimStore.getState().budgetMs).toBe(before * 2);
  });

  it('honours a caller’s factor, and a nonsense one falls back to the double', () => {
    const before = useSimStore.getState().budgetMs;
    expect(useSimStore.getState().raiseBudget(1.5)).toBe(Math.round(before * 1.5));
    const after = useSimStore.getState().budgetMs;
    expect(useSimStore.getState().raiseBudget(0)).toBe(after * 2);
    expect(useSimStore.getState().raiseBudget(Number.NaN)).toBe(after * 4);
    expect(useSimStore.getState().raiseBudget(-3)).toBe(after * 8);
  });
});

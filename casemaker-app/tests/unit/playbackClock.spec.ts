// The transport clock (#198, `/Simulation.md` §8.0): pure arithmetic between program TIME and
// program STEP. No React, no timers — every function is a binary search, and every case here is
// hand-built so the expectation is the maths, not a session's output.
//
// The path below is deliberately awkward: its `t` is non-decreasing (a zero-duration move repeats
// a value) and its `step` strictly increases, which is what `SimPath` guarantees.

import { describe, it, expect } from 'vitest';
import { advance, lineAtStep, stepAtTime, timeAtStep, totalTime, type ClockInput } from '@/engine/cnc/playbackClock';

/**
 * Four vertices, in order:
 *
 *   i   step   t (s)   note
 *   0    0     0       first move
 *   1    2     1       arrives at 1 s
 *   2    4     1       a zero-duration move: step advances, time does not
 *   3    6     3       sits at t = 3 s
 */
const path: ClockInput = {
  t: Float32Array.from([0, 1, 1, 3]),
  step: Uint32Array.from([0, 2, 4, 6]),
  line: Uint32Array.from([10, 11, 12, 13]),
};

/** A longer clock, for the speed test: total 20 s, so 10 s of program time is not the end. */
const longPath: ClockInput = {
  t: Float32Array.from([0, 5, 20]),
  step: Uint32Array.from([0, 100, 200]),
};

describe('playbackClock: step and time (#198)', () => {
  it('totalTime is the last vertex time, and 0 for an empty path', () => {
    expect(totalTime(path)).toBe(3);
    expect(totalTime({ t: new Float32Array(0), step: new Uint32Array(0) })).toBe(0);
  });

  it('timeAtStep is the t of the last vertex at or before the step', () => {
    expect(timeAtStep(path, 0)).toBe(0);
    expect(timeAtStep(path, 1)).toBe(0); // before the first move that landed at step 2
    expect(timeAtStep(path, 2)).toBe(1);
    expect(timeAtStep(path, 3)).toBe(1);
    expect(timeAtStep(path, 4)).toBe(1); // the zero-duration vertex
    expect(timeAtStep(path, 6)).toBe(3);
    expect(timeAtStep(path, 999)).toBe(3); // clamped to the last vertex
    expect(timeAtStep(path, -1)).toBe(0);
  });

  it('stepAtTime is the step of the last vertex at or before the time — a zero-duration move resolves to the LAST of its vertices', () => {
    expect(stepAtTime(path, 0)).toBe(0);
    expect(stepAtTime(path, 0.5)).toBe(0);
    // Both vertices 1 and 2 sit at t = 1; "what step is shown at 1 s" is the later one (step 4),
    // never the earlier (step 2), because the machine has already made both moves.
    expect(stepAtTime(path, 1)).toBe(4);
    expect(stepAtTime(path, 2)).toBe(4);
    expect(stepAtTime(path, 3)).toBe(6);
    expect(stepAtTime(path, 99)).toBe(6);
    expect(stepAtTime(path, -1)).toBe(0); // before the first vertex: the first step is shown
  });

  it('round-trips every vertex through timeAtStep, and stepAtTime back through non-zero runs', () => {
    const steps = Array.from(path.step);
    const ts = Array.from(path.t);
    for (let i = 0; i < steps.length; i++) {
      expect(timeAtStep(path, steps[i]!)).toBeCloseTo(ts[i]!, 6);
    }
    // The reverse direction is exact except inside a zero-duration run, where time cannot name
    // which of the repeated vertices is meant: it names the last.
    expect(stepAtTime(path, 0)).toBe(steps[0]);
    expect(stepAtTime(path, 3)).toBe(steps[3]);
  });

  it('an empty path is 0 everywhere, not a throw', () => {
    const empty: ClockInput = { t: new Float32Array(0), step: new Uint32Array(0) };
    expect(stepAtTime(empty, 5)).toBe(0);
    expect(timeAtStep(empty, 5)).toBe(0);
    expect(totalTime(empty)).toBe(0);
  });

  it('lineAtStep is the source line of the last vertex at or before the step, null without line data', () => {
    expect(lineAtStep(path, 0)).toBe(10);
    expect(lineAtStep(path, 3)).toBe(11);
    expect(lineAtStep(path, 4)).toBe(12);
    expect(lineAtStep(path, 6)).toBe(13);
    expect(lineAtStep(path, -1)).toBeNull();
    expect(lineAtStep({ t: path.t, step: path.step }, 4)).toBeNull(); // a hand-built path may omit it
  });
});

describe('playbackClock: advance (#198)', () => {
  it('speed 100 over 0.1 s of wall time advances 10 s of program time', () => {
    const r = advance(longPath, 0, 0.1, 100, []);
    expect(r.seconds).toBeCloseTo(10, 6);
    expect(r.stop).toBeNull();
  });

  it('crossing a pause stops AT the pause step, with the reason, not after it', () => {
    // From 0, target 1 s; the pause at step 3 completes at t = 1 s.
    const r = advance(path, 0, 1, 1, [3]);
    expect(r.stop).toEqual({ reason: 'pause', step: 3 });
    expect(r.seconds).toBe(1); // the time the machine would have reached, not the target
  });

  it('stops at the FIRST pause when two lie inside one interval, whatever the argument order', () => {
    // Target 3 s: both step 3 and step 5 (each completing at t = 1 s) are inside (0, 6].
    const r = advance(path, 0, 3, 1, [5, 3]);
    expect(r.stop).toEqual({ reason: 'pause', step: 3 });
    expect(r.seconds).toBe(1);
  });

  it('a pause at or behind the clock is skipped, so play continues past it (a resume)', () => {
    // nowSeconds is exactly the pause's time: the pause is behind, not ahead.
    const r = advance(path, 1, 1, 1, [3]);
    expect(r.stop).toBeNull();
    expect(r.seconds).toBeCloseTo(2, 6);
  });

  it('past the end clamps to totalTime with reason end', () => {
    const r = advance(path, 2, 5, 1, []);
    expect(r.stop).toEqual({ reason: 'end' });
    expect(r.seconds).toBe(totalTime(path));
  });

  it('an empty path advances to 0 and stops as ended', () => {
    const r = advance({ t: new Float32Array(0), step: new Uint32Array(0) }, 0, 1, 1, []);
    expect(r).toEqual({ seconds: 0, stop: { reason: 'end' } });
  });

  it('zero wall time does not move the clock', () => {
    const r = advance(path, 1.5, 0, 100, []);
    expect(r.seconds).toBe(1.5);
    expect(r.stop).toBeNull();
  });
});

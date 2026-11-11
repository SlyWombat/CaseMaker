// #1145 — THE RUN'S CLOCK IS OURS. The controller's `P:` field 3 was read as "elapsed seconds"
// from one air-program trace; the 2026-11-09 bench samples (P:3202,54,1776 then P:5986,99,4641 on
// the SAME ~5-minute program) prove it is not seconds. So nothing reads it as time any more:
// elapsed is the wall time since the run watch first saw the `P:` field (minus paused stretches),
// and the time left is that elapsed scaled by (100 − percent) / percent. Field 1 (the line) and the
// percent are unchanged.
import { describe, expect, it } from 'vitest';
import {
  MIN_ELAPSED_FOR_ESTIMATE_S,
  remainingSeconds,
  runClockSeconds,
  runRemainingSeconds,
  runningProgramWords,
  type RunClock,
} from '@/engine/cnc/engrave/runProgress';

const at = (firstProgressAt: number | null, over: Partial<RunClock> = {}): RunClock => ({
  firstProgressAt,
  pausedMs: 0,
  pausedAt: null,
  ...over,
});

describe('#1145 — the run clock', () => {
  it('says nothing before the controller has reported a `P:` reading', () => {
    expect(runClockSeconds(at(null), 1_000_000)).toBeNull();
    expect(runClockSeconds(null, 1_000_000)).toBeNull();
  });

  it('is the wall time since the first P:, in seconds', () => {
    expect(runClockSeconds(at(1_000_000), 1_060_000)).toBe(60);
    expect(runClockSeconds(at(1_000_000), 1_000_500)).toBeCloseTo(0.5, 3);
  });

  it('excludes a completed pause', () => {
    // 120 s since the first P:, 30 s of it suspended.
    expect(runClockSeconds(at(1_000_000, { pausedMs: 30_000 }), 1_120_000)).toBe(90);
  });

  it('freezes while the job is suspended', () => {
    const clock = at(1_000_000, { pausedAt: 1_040_000 });
    expect(runClockSeconds(clock, 1_200_000)).toBe(40);
    expect(runClockSeconds(clock, 1_300_000)).toBe(40);
  });

  it('never reports a negative clock', () => {
    expect(runClockSeconds(at(2_000), 1_000)).toBe(0);
  });
});

describe('#1145 — the time left comes from our clock, never from P: field 3', () => {
  it('scales OUR elapsed by the percent still to run', () => {
    expect(remainingSeconds(20, 60)).toBe(240);
    expect(remainingSeconds(50, 60)).toBe(60);
    expect(remainingSeconds(null, 60)).toBeNull();
    expect(remainingSeconds(20, null)).toBeNull();
    expect(remainingSeconds(0, 60)).toBeNull();
    expect(remainingSeconds(100, 60)).toBeNull();
  });

  it('ignores a third field that would be absurd as seconds', () => {
    // Exactly the 2026-11-09 bench reading on a ~5-minute program: percent 99, field 3 = 4,641
    // (77 minutes, impossible). Field 3 is not a parameter of the words at all; our clock says 60 s.
    const controllerThirdField = 4641;
    const words = runningProgramWords({ active: 2, total: 5, percent: 50, elapsedS: 60 });
    expect(words).toBe('Program 2 of 5 is 50 % done — about 1 min left.');
    expect(words).not.toContain('77 min');
    expect(words).not.toContain(String(controllerThirdField));
  });

  it('states no time until the clock has run long enough to mean anything', () => {
    expect(MIN_ELAPSED_FOR_ESTIMATE_S).toBe(10);
    expect(runningProgramWords({ active: 1, total: 2, percent: 20, elapsedS: 4 })).toBe(
      'Program 1 of 2 is 20 % done.',
    );
    expect(runningProgramWords({ active: 1, total: 2, percent: 20, elapsedS: null })).toBe(
      'Program 1 of 2 is 20 % done.',
    );
    expect(runningProgramWords({ active: 1, total: 2, percent: 20, elapsedS: 10 })).toBe(
      'Program 1 of 2 is 20 % done — about 40 s left.',
    );
  });

  it('keeps item 42’s honest edges: no percentage yet, 100 % finishing, paused says when the time applies', () => {
    expect(runningProgramWords({ active: 1, total: 2, percent: null, elapsedS: null })).toBe(
      'Program 1 of 2 is running — the machine has not reported a percentage yet.',
    );
    expect(runningProgramWords({ active: 1, total: 2, percent: null, elapsedS: null, paused: true })).toBe(
      'Program 1 of 2 is paused — the machine has not reported a percentage yet.',
    );
    expect(runningProgramWords({ active: 2, total: 5, percent: 100, elapsedS: 60 })).toBe(
      'Program 2 of 5 is 100 % done — the machine is finishing.',
    );
    expect(runningProgramWords({ active: 2, total: 5, percent: 20, elapsedS: 60, paused: true })).toBe(
      'Program 2 of 5 is paused at 20 % — about 4 min left when it resumes.',
    );
    expect(runningProgramWords({ active: 2, total: 5, percent: 20, elapsedS: 5, paused: true })).toBe(
      'Program 2 of 5 is paused at 20 %.',
    );
  });
});


// #1145 × #1123 item 42 — THE WHOLE RUN'S TIME LEFT for a multi-program job: the run's own total
// (#1193) less what has run, or — with no total — our clock plus the programs not started.
describe('#1145 — the whole run’s time left', () => {
  it('takes the run total, less the finished programs and OUR clock', () => {
    expect(
      runRemainingSeconds({ runTotalS: 3600, doneS: 600, elapsedS: 120, programLeftS: 480, queuedS: 1080 }),
    ).toBe(2880);
  });

  it('falls back to what is left when no total (or no finished time) is stated', () => {
    expect(
      runRemainingSeconds({ runTotalS: null, doneS: 600, elapsedS: 120, programLeftS: 480, queuedS: 1080 }),
    ).toBe(1560);
    expect(
      runRemainingSeconds({ runTotalS: 3600, doneS: null, elapsedS: 120, programLeftS: 480, queuedS: 1080 }),
    ).toBe(1560);
    expect(
      runRemainingSeconds({ runTotalS: 3600, doneS: 600, elapsedS: null, programLeftS: 480, queuedS: 1080 }),
    ).toBe(1560);
  });

  it('a total the run has already passed is spent, not a negative time', () => {
    expect(
      runRemainingSeconds({ runTotalS: 600, doneS: 600, elapsedS: 120, programLeftS: 480, queuedS: 1080 }),
    ).toBe(1560);
  });

  it('says nothing when neither basis can be stated', () => {
    expect(
      runRemainingSeconds({ runTotalS: null, doneS: null, elapsedS: null, programLeftS: null, queuedS: null }),
    ).toBeNull();
    // The program playing has no clock yet: showing only the later programs would omit it.
    expect(
      runRemainingSeconds({ runTotalS: null, doneS: null, elapsedS: null, programLeftS: null, queuedS: 1080 }),
    ).toBeNull();
  });
});

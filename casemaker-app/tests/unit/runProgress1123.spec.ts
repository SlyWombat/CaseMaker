// #1123-42 — THE RUNNING PROGRAM'S PROGRESS, from the run watch's own status line.
//
// While a program runs, the Cut step says how far it is (the `P:` percentage), how long the percent
// and elapsed imply is left, and which program needs the next cutter — the change the operator must
// stand at the machine for. Nothing here is an estimate of its own: the percentage and clock are the
// controller's, and the next cutter is the release list's own cut order.
import { describe, expect, it } from 'vitest';
import {
  nextBitChange,
  remainingSeconds,
  runningProgramWords,
  type RunProgressReading,
} from '@/engine/cnc/engrave/runProgress';

const at = (over: Partial<RunProgressReading> = {}): RunProgressReading => ({
  state: 'Run',
  line: 10,
  percent: 20,
  elapsedS: 5,
  ...over,
});

describe('#1123-42 — the running program’s percent and time left', () => {
  it('states the percent and the time the percent and elapsed imply', () => {
    expect(runningProgramWords({ active: 2, total: 5, progress: at() })).toBe(
      'Program 2 of 5 is 20 % done — about 20 s left.',
    );
    expect(remainingSeconds(at())).toBe(20);
  });

  it('does not invent a time before the machine reports a percentage', () => {
    expect(runningProgramWords({ active: 1, total: 2, progress: null })).toBe(
      'Program 1 of 2 is running — the machine has not reported a percentage yet.',
    );
    expect(runningProgramWords({ active: 1, total: 2, progress: at({ percent: null }) })).toContain(
      'has not reported a percentage',
    );
  });

  it('rounds the percent and never divides by zero or a finished count', () => {
    expect(remainingSeconds(at({ percent: 0, elapsedS: 5 }))).toBeNull();
    expect(remainingSeconds(at({ percent: 100, elapsedS: 60 }))).toBeNull();
    expect(remainingSeconds(null)).toBeNull();
    expect(runningProgramWords({ active: 1, total: 1, progress: at({ percent: 33.4, elapsedS: 60 }) })).toBe(
      'Program 1 of 1 is 33 % done — about 2 min left.',
    );
  });

  it('reads 100 % as finishing, never as a time still to come', () => {
    expect(runningProgramWords({ active: 2, total: 5, progress: at({ percent: 100, elapsedS: 60 }) })).toBe(
      'Program 2 of 5 is 100 % done — the machine is finishing.',
    );
  });

  it('says paused, and says the time is what is left when it resumes', () => {
    expect(runningProgramWords({ active: 2, total: 5, progress: at(), paused: true })).toBe(
      'Program 2 of 5 is paused at 20 % — about 20 s left when it resumes.',
    );
    expect(runningProgramWords({ active: 2, total: 5, progress: null, paused: true })).toBe(
      'Program 2 of 5 is paused — the machine has not reported a percentage yet.',
    );
  });
});

describe('#1123-42 — the next bit change', () => {
  const files = [
    { index: 1, toolKey: 'flat-1', done: false, filename: 'p1.nc' },
    { index: 2, toolKey: 'flat-1', done: false, filename: 'p2.nc' },
    { index: 3, toolKey: 'ball-2', done: false, filename: 'p3.nc' },
    { index: 4, toolKey: 'ball-2', done: false, filename: 'p4.nc' },
  ];

  it('names the next program that needs a different cutter, skipping programs that share this one', () => {
    expect(nextBitChange(files, 1)).toEqual({ kind: 'change', file: files[2] });
    expect(nextBitChange(files, 2)).toEqual({ kind: 'change', file: files[2] });
    expect(nextBitChange(files, 3)).toEqual({ kind: 'last' });
  });

  it('skips programs this machine already finished', () => {
    const skipped = [files[0]!, { ...files[1]!, done: true }, files[2]!];
    expect(nextBitChange(skipped, 1)).toEqual({ kind: 'change', file: files[2] });
  });

  it('says nothing before a program is running, or when the list does not hold it', () => {
    expect(nextBitChange(files, null)).toBeNull();
    expect(nextBitChange([], 1)).toBeNull();
    expect(nextBitChange(files, 9)).toBeNull();
  });

  it('is the last cutter when every later program shares it', () => {
    expect(nextBitChange([files[0]!, files[1]!], 1)).toEqual({ kind: 'last' });
  });
});

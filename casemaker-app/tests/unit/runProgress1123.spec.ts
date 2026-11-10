// #1123-42 — THE RUNNING PROGRAM'S PROGRESS, from the run watch's own status line.
//
// While a program runs, the Cut step says how far it is (the `P:` percentage), how long is left and
// which program needs the next cutter — the change the operator must stand at the machine for. The
// percent is the controller's; the time left is OUR clock's (#1145), not `P:`'s third field, whose
// unit the 2026-11-09 bench samples disproved as seconds. The next cutter is the release list's own
// cut order.
import { describe, expect, it } from 'vitest';
import { nextBitChange, runningProgramWords } from '@/engine/cnc/engrave/runProgress';

describe('#1123-42 — the running program’s percent and the time left from our clock (#1145)', () => {
  it('states the percent and the time our clock and the percent imply', () => {
    expect(runningProgramWords({ active: 2, total: 5, percent: 20, elapsedS: 60 })).toBe(
      'Program 2 of 5 is 20 % done — about 4 min left.',
    );
  });

  it('does not invent a time before the machine reports a percentage', () => {
    expect(runningProgramWords({ active: 1, total: 2, percent: null, elapsedS: 60 })).toBe(
      'Program 1 of 2 is running — the machine has not reported a percentage yet.',
    );
  });

  it('rounds the percent and never divides by zero or a finished count', () => {
    expect(runningProgramWords({ active: 1, total: 1, percent: 33.4, elapsedS: 60 })).toBe(
      'Program 1 of 1 is 33 % done — about 2 min left.',
    );
  });

  it('reads 100 % as finishing, never as a time still to come', () => {
    expect(runningProgramWords({ active: 2, total: 5, percent: 100, elapsedS: 60 })).toBe(
      'Program 2 of 5 is 100 % done — the machine is finishing.',
    );
  });

  it('says paused, and says the time is what is left when it resumes', () => {
    expect(runningProgramWords({ active: 2, total: 5, percent: 20, elapsedS: 60, paused: true })).toBe(
      'Program 2 of 5 is paused at 20 % — about 4 min left when it resumes.',
    );
    expect(runningProgramWords({ active: 2, total: 5, percent: null, elapsedS: null, paused: true })).toBe(
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

// #1179 slice A — THE RESTART SENTENCE. The machine's finished-run records are compared with the
// package the Cut step holds: the same plan is today's ✓/resume and needs no sentence; a different
// plan for the SAME job speaks from the record and starts at program 1; a record that cannot name
// its plan says only what is still true; and hashes with no record at all say the machine has cut
// before — never that THIS blank was cut by THIS job.
import { describe, expect, it } from 'vitest';

import { restartNotice } from '@/engine/cnc/engrave/restart';
import type { FinishedRun } from '@/platform/locationClient';

const RUN: FinishedRun = {
  hash: 'a1b2c3d4',
  jobId: 'job-1',
  packageKey: 'old-package',
  key8: 'old-pack',
  programIndex: 1,
  programCount: 20,
  programName: '6 mm flat · roughing',
  finishedAt: '2026-11-09T18:30:00.000Z',
};

const base = {
  jobId: 'job-1',
  packageKey: 'new-package',
  packageHashes: ['11111111', '22222222', '33333333'],
  programCount: 17,
  machineHashes: ['11111111'],
};

describe('#1179 the Cut-step restart sentence', () => {
  it('says nothing for the same package — the ✓ rows and resume are the answer', () => {
    expect(restartNotice({ ...base, runs: [{ ...RUN, packageKey: 'new-package' }] })).toBeNull();
  });

  it('a different package for THIS job: what was cut, and that the plan changed', () => {
    expect(restartNotice({ ...base, runs: [RUN] })).toEqual({
      kind: 'changed',
      sentence:
        'This blank was partly cut on 9 Nov: program 1 of 20 (6 mm flat · roughing). The plan has changed since (17 programs now), so cutting starts again at program 1; it passes over what is already cut.',
    });
  });

  it('a partial record states only the facts it has', () => {
    const bare: FinishedRun = { hash: 'a1b2c3d4', jobId: 'job-1', packageKey: 'old-package' };
    expect(restartNotice({ ...base, runs: [bare] })?.sentence).toBe(
      'This blank was partly cut. The plan has changed since (17 programs now), so cutting starts again at program 1; it passes over what is already cut.',
    );
    const indexed: FinishedRun = { ...bare, programIndex: 4 };
    expect(restartNotice({ ...base, runs: [indexed] })?.sentence).toContain(': program 4.');
  });

  it('the newest record of the job is the one quoted', () => {
    const older: FinishedRun = { ...RUN, packageKey: 'older-package', programIndex: 7, finishedAt: '2026-11-08T10:00:00.000Z' };
    const notice = restartNotice({ ...base, runs: [older, RUN] });
    expect(notice?.sentence).toContain('program 1 of 20');
  });

  it('a record that cannot name its plan says only what is still true', () => {
    const bare: FinishedRun = { hash: 'a1b2c3d4', jobId: 'job-1' };
    expect(restartNotice({ ...base, runs: [bare] })).toEqual({
      kind: 'unknown',
      sentence:
        'An earlier plan cut on this machine, and the record does not say which. Cutting starts at program 1; it passes over what is already cut.',
    });
  });

  it('hashes with no record: the machine has cut before, and that is all it says', () => {
    expect(restartNotice({ ...base, runs: [], machineHashes: ['5343dd8c', '1e4e7ef9'] })).toEqual({
      kind: 'machine',
      sentence: 'An earlier plan cut on this machine.',
    });
    // Every finished hash belongs to this package: today's ✓ handles them, no sentence.
    expect(restartNotice({ ...base, runs: [], machineHashes: ['11111111'] })).toBeNull();
    expect(restartNotice({ ...base, runs: [], machineHashes: [] })).toBeNull();
  });

  it('another job’s record never becomes this blank’s sentence', () => {
    const other: FinishedRun = { ...RUN, jobId: 'job-2', packageKey: 'other-package' };
    // Its hashes are not this package's, so the machine line stands — the weak, always-true one.
    expect(restartNotice({ ...base, runs: [other], machineHashes: ['5343dd8c'] })).toEqual({
      kind: 'machine',
      sentence: 'An earlier plan cut on this machine.',
    });
  });

  it('a changed package with every recorded hash matching is still a changed plan', () => {
    // The package key is the plan's identity; a hash coincidence must not hide a new plan.
    expect(
      restartNotice({ ...base, runs: [{ ...RUN, hash: '11111111' }], machineHashes: ['11111111'] })?.kind,
    ).toBe('changed');
  });
});

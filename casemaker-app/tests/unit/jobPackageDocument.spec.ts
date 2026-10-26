// @vitest-environment jsdom
// The package block and run log as DOCUMENT data (#425, R8): integrity on reload, the prune that
// keeps progress honest across a re-freeze, the resume point, and the two writes the document
// owner exposes. No localStorage package cache is involved anywhere here.

import { beforeEach, describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import {
  freezePackage,
  packageHash,
  pruneRunLog,
  resumeAtSetup,
  validatePackage,
  type PackageProgramInput,
} from '@/engine/cnc/engrave/package';
import { programHash } from '@/engine/cnc/programHash';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import type { EngraveJob, FrozenPackage, JobRunLogEntry } from '@/types/engraveJob';

const AT = '2026-10-17T09:00:00.000Z';
const NC = 'G21\nM331\nG0 X0\nM332\nM2\n';

function program(nc: string, over: Partial<PackageProgramInput> = {}): PackageProgramInput {
  return {
    setupIndex: 0,
    setupId: 'setup-implicit',
    toolKey: 'flat-1.0',
    nc,
    frameNc: null,
    programHash: programHash(nc),
    ...over,
  };
}

function frozen(job: EngraveJob = defaultEngraveJob()): FrozenPackage {
  const made = freezePackage(job, [program(NC)], AT);
  if (!made.ok) throw new Error(made.reason);
  return made.package;
}

function entry(over: Partial<JobRunLogEntry> = {}): JobRunLogEntry {
  return {
    programHash: programHash(NC),
    setupIndex: 0,
    setupId: 'setup-implicit',
    toolKey: 'flat-1.0',
    at: AT,
    outcome: 'finished',
    ...over,
  };
}

describe('a stored package is checked for integrity, not only for staleness (#425)', () => {
  it('accepts the block a freeze wrote', () => {
    expect(validatePackage(frozen())).toEqual({ ok: true, reason: null });
  });

  it('refuses a program text that no longer matches its FNV key', () => {
    const pkg = frozen();
    const tampered: FrozenPackage = {
      ...pkg,
      programs: [{ ...pkg.programs[0]!, nc: `${pkg.programs[0]!.nc}G0 X9 Y9\n` }],
    };
    expect(validatePackage(tampered)).toEqual({
      ok: false,
      reason: 'the saved program does not match what was verified; it will not be offered for a run',
    });
  });

  it('refuses a frame text that no longer matches its key', () => {
    const job = defaultEngraveJob();
    const made = freezePackage(job, [program(NC, { frameNc: 'G0 X1 Y1\n' })], AT);
    if (!made.ok) throw new Error(made.reason);
    const pkg = made.package;
    expect(validatePackage(pkg).ok).toBe(true);
    const tampered: FrozenPackage = {
      ...pkg,
      programs: [{ ...pkg.programs[0]!, frameNc: 'G0 X2 Y2\n' }],
    };
    expect(validatePackage(tampered).ok).toBe(false);
    expect(validatePackage(tampered).reason).toContain('does not match what was verified');
  });

  it('refuses a package whose own key does not match its programs', () => {
    const pkg = frozen();
    expect(validatePackage({ ...pkg, hash: packageHash('other-fingerprint', pkg.programs) })).toEqual({
      ok: false,
      reason: 'the frozen plan does not match its own fingerprint',
    });
  });

  it('refuses a program that names a setup the package does not carry', () => {
    const pkg = frozen();
    const tampered: FrozenPackage = {
      ...pkg,
      programs: [{ ...pkg.programs[0]!, setupId: 'setup-gone' }],
    };
    const verdict = validatePackage(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('a setup it does not carry');
  });
});

describe('the run log and the resume point (#425 §6)', () => {
  it('prunes outcomes for programs the package no longer carries, and keeps the rest', () => {
    const pkg = frozen();
    const kept = entry();
    const stale = entry({ programHash: programHash('a program that was re-posted away') });
    expect(pruneRunLog([stale, kept], pkg.programs)).toEqual([kept]);
    // Absent stays absent: a job with no log does not gain an empty one.
    expect(pruneRunLog(undefined, pkg.programs)).toBeUndefined();
  });

  it('resumes at the first program with no finished entry', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), package: frozen() };
    expect(resumeAtSetup(job)).toEqual({
      setupIndex: 0,
      setupId: 'setup-implicit',
      programHash: programHash(NC),
    });
    expect(resumeAtSetup({ ...job, runLog: [entry()] })).toBeNull();
  });

  it('a stopped or failed program is not done and is resumed again', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), package: frozen() };
    for (const outcome of ['stopped', 'failed'] as const) {
      expect(resumeAtSetup({ ...job, runLog: [entry({ outcome })] })).toEqual({
        setupIndex: 0,
        setupId: 'setup-implicit',
        programHash: programHash(NC),
      });
    }
  });

  it('has no resume point without a package', () => {
    expect(resumeAtSetup(defaultEngraveJob())).toBeNull();
  });
});

describe('the document owner writes the package and the log (#425)', () => {
  beforeEach(() => {
    useEngraveJobStore.getState().reset();
  });

  it('setPackage writes the block and appendRunLog appends to the document', () => {
    const job = useEngraveJobStore.getState().job;
    const pkg = frozen(job);
    useEngraveJobStore.getState().setPackage(pkg);
    expect(useEngraveJobStore.getState().job.package).toEqual(pkg);

    useEngraveJobStore.getState().appendRunLog(entry());
    useEngraveJobStore.getState().appendRunLog(entry({ outcome: 'stopped' }));
    expect(useEngraveJobStore.getState().job.runLog?.map((e) => e.outcome)).toEqual([
      'finished',
      'stopped',
    ]);
  });

  it('writing a NEW package prunes outcomes for programs it no longer has', () => {
    const job = useEngraveJobStore.getState().job;
    const pkg = frozen(job);
    useEngraveJobStore.getState().setPackage(pkg);
    useEngraveJobStore.getState().appendRunLog(entry());
    useEngraveJobStore.getState().appendRunLog(entry({ programHash: 'program-from-the-old-cut' }));

    const next = frozen({
      ...job,
      package: undefined,
      labels: job.labels.map((label, i) => (i === 0 ? { ...label, depth: label.depth + 0.1 } : label)),
    });
    useEngraveJobStore.getState().setPackage(next);
    expect(useEngraveJobStore.getState().job.runLog?.map((e) => e.programHash)).toEqual([
      entry().programHash,
    ]);
  });

  it('ignores a package frozen for another job, and null clears the key', () => {
    const job = useEngraveJobStore.getState().job;
    const other = frozen({ ...defaultEngraveJob(), id: 'job-elsewhere' });
    useEngraveJobStore.getState().setPackage(other);
    expect(useEngraveJobStore.getState().job.package).toBeUndefined();

    useEngraveJobStore.getState().setPackage(frozen(job));
    expect(useEngraveJobStore.getState().job.package).toBeDefined();
    useEngraveJobStore.getState().setPackage(null);
    expect('package' in useEngraveJobStore.getState().job).toBe(false);
  });
});

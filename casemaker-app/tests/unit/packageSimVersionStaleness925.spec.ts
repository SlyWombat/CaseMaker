// @vitest-environment jsdom
// #925 — a sweep/oracle/verify fix must stale a frozen package even though the job and the program
// bytes never moved. Gate statement 10: a package reads current only when job, registration,
// program bytes AND simulator version all match — a package frozen before the simulator was
// versioned cannot show that match, so it is stale too, with its own sentence (one re-simulation
// each, intentionally). This file mocks the constant to 6, one past the shipped 5, to exercise a
// future bump, isolated from `engravePackage.spec.ts` so every other package test keeps seeing the
// real value.

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/workers/geometry/simVersion', () => ({ SIMULATOR_VERSION: 6 }));

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { freezePackage, packageHash, packageStaleness, validatePackage, type PackageProgramInput } from '@/engine/cnc/engrave/package';
import { programHash } from '@/engine/cnc/programHash';

const AT = '2026-10-17T09:00:00.000Z';

function program(nc: string, over: Partial<PackageProgramInput> = {}): PackageProgramInput {
  return { setupIndex: 0, setupId: 'setup-implicit', toolKey: 'flat-1.0', nc, frameNc: null, programHash: programHash(nc), ...over };
}

describe('packageStaleness/#925 under a bumped simulator (mocked SIMULATOR_VERSION = 6)', () => {
  it('a package frozen under THIS (mocked) current version is not stale', () => {
    const job = defaultEngraveJob();
    const made = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);
    expect(packageStaleness(made.package, job)).toEqual({ stale: false, reason: null });
    expect(validatePackage(made.package)).toEqual({ ok: true, reason: null });
  });

  it('a package frozen one version back (v5) reads stale, named by the simulator — and is NOT tampered', () => {
    const job = defaultEngraveJob();
    const made = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);
    const pkg = made.package;
    const frozenUnderV5 = { ...pkg, hash: packageHash(pkg.jobHash, pkg.programs, 5) };

    const stale = packageStaleness(frozenUnderV5, job);
    expect(stale).toEqual({ stale: true, reason: 'the simulator changed since it was frozen' });

    // Staleness and tampering are different questions (package.ts's own header comment): an
    // outdated-but-intact package must not ALSO be refused as tampered, or Cut could never show
    // the operator a re-freeze offer for it.
    expect(validatePackage(frozenUnderV5)).toEqual({ ok: true, reason: null });
  });

  it('a package frozen before #925 (no version term in its hash at all) reads stale, with its own sentence — and is NOT tampered', () => {
    const job = defaultEngraveJob();
    const made = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);
    const pkg = made.package;
    const predatesTheCheck = { ...pkg, hash: packageHash(pkg.jobHash, pkg.programs) };

    // Gate statement 10: current only when job, registration, program bytes AND simulator version
    // all match. An unversioned package cannot show that match, so it is NOT grandfathered in —
    // one re-simulation, intentionally, for every package frozen before this existed.
    expect(packageStaleness(predatesTheCheck, job)).toEqual({
      stale: true,
      reason: 'frozen before the simulator was versioned — simulate again',
    });
    // Stale is not the same question as tampered: an intact pre-#925 package still validates.
    expect(validatePackage(predatesTheCheck)).toEqual({ ok: true, reason: null });
  });

  it('a package whose hash matches no version at all is tampered, not merely "simulator changed"', () => {
    const job = defaultEngraveJob();
    const made = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);
    const pkg = made.package;
    const edited = { ...pkg, programs: [{ ...pkg.programs[0]!, nc: `${pkg.programs[0]!.nc}G0 X9 Y9\n` }] };

    // The program text itself no longer matches its own FNV key — caught before the fingerprint
    // comparison even runs.
    expect(validatePackage(edited).ok).toBe(false);
  });
});

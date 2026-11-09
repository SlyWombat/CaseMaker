// @vitest-environment jsdom
// #1132 — a registration approved after Generate must not cost a 12-minute re-plan.
//
// Red-first behaviours:
//   - the only change since the run is the registration (the job's program fingerprint and every
//     planner input are unchanged) → Generate re-freezes the existing programs with the new
//     registration and starts no planner worker;
//   - the re-frozen package carries the new registration, is no longer stale, and its program
//     bytes (nc + hashes) are exactly the existing run's — the same bytes a full regenerate for
//     the same registration would post;
//   - a moved planner input (feeds) still re-plans: the re-freeze predicate is false.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { freezePackage, packageStaleness, type PackageProgramInput } from '@/engine/cnc/engrave/package';
import { programHash } from '@/engine/cnc/programHash';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { useEngraveRunStore, currentRunInputStamps, registrationOnlyRefreeze } from '@/store/engraveRunStore';
import { resetEngravePackageStore, useEngravePackageStore } from '@/store/engravePackageStore';
import type { EngraveGenerated, EngraveProgram } from '@/workers/sim/engraveGenerate';
import type { EngraveJob } from '@/types/engraveJob';

const engraveGenerateSpy = vi.hoisted(() => vi.fn());
vi.mock('@/engine/jobs/simClient', () => ({ engraveGenerate: engraveGenerateSpy }));

const AT = '2026-11-09T18:00:00.000Z';
const NC = 'M331\nG0 X0 Y0\nG1 Z-1 F300\nM332\nM02\n';
const VERIFY = {
  ok: true,
  findings: [],
  stats: { lines: 1, cuttingMoves: 1, deepestZ: -1, bbox: { min: [0, 0, -1] as [number, number, number], max: [1, 1, 0] as [number, number, number] } },
};

/** The generator's program, structurally a `PackageProgramInput` too. */
function program(setupId: string): EngraveProgram {
  return {
    setupIndex: 1,
    setupId,
    toolKey: 'flat-1.0',
    nc: NC,
    verify: VERIFY,
    frameNc: null,
    frameVerify: null,
    programHash: programHash(NC),
    cam: null,
  };
}

function generated(programs: EngraveProgram[]): EngraveGenerated {
  return { ok: true, stage: 'done', findings: [], feeds: null, threads: null, cam: null, nc: NC, verify: null, frameNc: null, frameVerify: null, programs } as unknown as EngraveGenerated;
}

/** The same job with its first setup's registration approved (#574's fixture shape). */
function withRegistration(job: EngraveJob): EngraveJob {
  const setup = jobSetups(job)[0]!;
  return {
    ...job,
    setups: [
      { ...setup, registration: { method: 'vise' as const, plan: { mount: 'vise' as const, scans: [] }, expected: null } },
    ] as unknown as NonNullable<EngraveJob['setups']>,
  };
}

let jobApproved: EngraveJob;
let programs: EngraveProgram[];
let frozenHash: string;

beforeEach(() => {
  engraveGenerateSpy.mockClear();
  resetEngravePackageStore();
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  const setup = jobSetups(job)[0]!;
  const sansPlan: EngraveJob = { ...job, setups: [{ ...setup }] as NonNullable<EngraveJob['setups']> };
  jobApproved = withRegistration(job);
  programs = [program(setup.id)];
  const made = freezePackage(sansPlan, programs as unknown as PackageProgramInput[], AT);
  if (!made.ok) throw new Error(made.reason);
  frozenHash = made.package.hash;
  // The document now carries the approval AND the package frozen before it.
  useEngraveJobStore.setState({ job: { ...jobApproved, package: made.package } });
  // The stamps a Generate would take right now; the branch compares these to the run's own.
  const stamps = currentRunInputStamps();
  useEngraveRunStore.setState({
    generated: generated(programs),
    oracle: null,
    oraclePrograms: [],
    simDiagnostics: [],
    simStatus: null,
    pathOnly: false,
    simEngine: null,
    simGridPitchMm: null,
    simPrograms: [],
    runMount: null,
    phase: 'ready',
    acknowledged: false,
    acknowledgedFor: null,
    staleSince: null,
    staleReason: null,
    inputs: stamps,
    shopSignature: 'shop',
    restoreNote: null,
    restoreChecking: false,
    changedSinceLast: [],
    previousVerdict: null,
    error: null,
    progress: null,
    simProgram: null,
    simStopped: false,
  });
});

afterEach(() => {
  useEngraveRunStore.getState().reset();
  resetEngravePackageStore();
});

describe('#1132 — a registration-only change re-freezes instead of re-planning', () => {
  it('is the registration-only case, and a moved input makes it a full re-plan again', () => {
    const run = useEngraveRunStore.getState();
    const openJob = useEngraveJobStore.getState().job;
    expect(registrationOnlyRefreeze(openJob, run)).toBe(true);
    expect(registrationOnlyRefreeze(openJob, run, { ...run.inputs!, feeds: 'fed-changed' })).toBe(false);
  });

  it('Generate re-freezes: no planner worker, the new registration, not stale, same bytes', async () => {
    const before = useEngraveRunStore.getState().generated;
    await useEngraveRunStore.getState().generate();

    // 1. The planner worker was never started.
    expect(engraveGenerateSpy).not.toHaveBeenCalled();
    // 2. The run is untouched — it was not re-planned or re-simulated.
    const run = useEngraveRunStore.getState();
    expect(run.generated).toBe(before);
    expect(run.phase).toBe('ready');

    // 3. The package now carries the approved registration and is current.
    const job = useEngraveJobStore.getState().job;
    const pkg = job.package!;
    expect(pkg).toBeDefined();
    expect(pkg.setups).toEqual(jobSetups(job));
    expect(pkg.setups[0]!.registration).toEqual(jobSetups(job)[0]!.registration);
    expect(packageStaleness(pkg, job)).toEqual({ stale: false, reason: null });

    // 4. The posted bytes are exactly the run's own: the same program texts and keys, and the
    //    same package key a full regenerate for this registration would freeze.
    expect(pkg.programs.map((p) => [p.nc, p.hash])).toEqual(
      programs.map((p) => [p.nc, programHash(p.nc)]),
    );
    expect(pkg.hash).toBe(frozenHash);
  });

  it('a stale-for-another-reason package is not re-frozen by this path', () => {
    // A job edit that changes the program fingerprint: the package is stale for the JOB, not for
    // the registration, so the predicate must refuse and Generate must plan again.
    const edited: EngraveJob = { ...useEngraveJobStore.getState().job, name: 'a different design' };
    useEngraveJobStore.setState({ job: edited });
    expect(registrationOnlyRefreeze(edited, useEngraveRunStore.getState())).toBe(false);
    expect(useEngravePackageStore.getState().packageFor(edited.id)).not.toBeNull();
  });
});

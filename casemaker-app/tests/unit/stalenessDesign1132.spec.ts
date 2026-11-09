// @vitest-environment jsdom
// #1132 design (maintainer, 2026-11-09) — A PROGRAM IS STALE ONLY WHEN ITS BYTES ARE.
//
// Non-byte changes (any setup's registration/approval, re-planning, the plan choice, Cut-strip
// toggles) never stale a package; they re-freeze its setups in place at the write, with no worker.
// Byte changes (stock, items, cutters, facing, hold, …) do stale it, and the Cut card names the
// changed thing with an honest cost.
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobVise } from '@/engine/cnc/fixture';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import {
  freezePackage,
  jobFingerprint,
  legacyJobFingerprint,
  packageHash,
  packageStaleness,
  setupApprovalDrift,
  type PackageProgramInput,
} from '@/engine/cnc/engrave/package';
import { SIMULATOR_VERSION } from '@/workers/geometry/simVersion';
import { programHash } from '@/engine/cnc/programHash';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { resetEngravePackageStore } from '@/store/engravePackageStore';
import type { EngraveJob } from '@/types/engraveJob';

const AT = '2026-11-09T18:00:00.000Z';
const NC = 'M331\nG0 X0 Y0\nG1 Z-1 F300\nM332\nM02\n';

function program(): PackageProgramInput {
  return { setupIndex: 1, setupId: 'setup-implicit', toolKey: 'flat-1.0', nc: NC, frameNc: null, programHash: programHash(NC) };
}

function baseJob(): EngraveJob {
  const job = defaultEngraveJob();
  job.toolKey = 'flat-1.0';
  return job;
}

function firstSetup(job: EngraveJob) {
  return jobSetups(job)[0]!;
}

const planV1 = { mount: 'vise' as const, scans: [] };
const planV2 = { mount: 'vise' as const, scans: [{ edge: 'left' as const, along: 10 }] };

function withRegistration(job: EngraveJob, plan: unknown = planV1): EngraveJob {
  return {
    ...job,
    setups: [
      { ...firstSetup(job), registration: { method: 'vise' as const, plan: plan as never, expected: 'a test plan' } },
    ] as NonNullable<EngraveJob['setups']>,
  };
}

beforeEach(() => {
  resetEngravePackageStore();
});

describe('#1132 — non-byte changes never stale the program', () => {
  const NON_BYTE: [string, (job: EngraveJob) => EngraveJob][] = [
    ['approve setup 1’s registration plan', (job) => withRegistration(job)],
    ['re-plan setup 1’s registration', (job) => withRegistration(job, planV2)],
    [
      'approve setup 2’s registration (the flip never reads it)',
      (job) => ({
        ...job,
        setups: [
          { ...(job.setups ?? [firstSetup(job)])[0]! },
          {
            ...(job.setups ?? [firstSetup(job)])[1]!,
            registration: { method: 'vise' as const, plan: planV1 as never, expected: 'a test plan' },
          },
        ] as NonNullable<EngraveJob['setups']>,
      }),
    ],
    ['choose the ideal plan', (job) => ({ ...job, planChoice: 'ideal' as const })],
    ['toggle the spindle blower (a Cut-strip switch)', (job) => ({ ...job, blowWithVacuum: false })],
    [
      'tick the cutter checklist (#1127, landing with E)',
      (job) =>
        ({
          ...job,
          cutterChecklist: { 'pkg-hash': { 'flat-1.0': { state: 'located', at: AT } } },
        }) as unknown as EngraveJob,
    ],
  ];

  it.each(NON_BYTE)('%s: the package stays current', (_name, change) => {
    // Two setups exist from the start where the change is about setup 2 (the job had both before
    // the approval; only the registration is written).
    const base = baseJob();
    const job: EngraveJob = _name.startsWith('approve setup 2')
      ? ({
          ...base,
          setups: [{ ...firstSetup(base) }, { ...firstSetup(base), id: 'setup-2' }],
        } as unknown as EngraveJob)
      : base;
    const made = freezePackage(job, [program()], AT);
    if (!made.ok) throw new Error(made.reason);
    const changed = change(job);
    expect(packageStaleness(made.package, changed)).toEqual({ stale: false, reason: null });
  });

  it('a registration change is DETECTED as approval drift, so the setups are re-frozen', () => {
    const job = baseJob();
    const made = freezePackage(job, [program()], AT);
    if (!made.ok) throw new Error(made.reason);
    expect(setupApprovalDrift(made.package, withRegistration(job))).toBe(true);
    expect(setupApprovalDrift(made.package, job)).toBe(false);
    // The plan choice and the blower toggle are not approval drift either.
    expect(setupApprovalDrift(made.package, { ...job, planChoice: 'ideal' })).toBe(false);
    expect(setupApprovalDrift(made.package, { ...job, blowWithVacuum: false })).toBe(false);
  });

  it('the approval write itself re-freezes the package’s setups — no Cut screen involved', async () => {
    const job = baseJob();
    const made = freezePackage(job, [program()], AT);
    if (!made.ok) throw new Error(made.reason);
    useEngraveJobStore.setState({ job: { ...job, package: made.package } });
    const approved = withRegistration(job);

    useEngraveJobStore.getState().setSetups(approved.setups!);
    // The eager re-freeze starts with the store write; let its microtasks land.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const open = useEngraveJobStore.getState().job;
    expect(open.package).toBeDefined();
    expect(setupApprovalDrift(open.package!, open)).toBe(false);
    expect(open.package!.setups).toEqual(jobSetups(open));
    expect(packageStaleness(open.package!, open)).toEqual({ stale: false, reason: null });
    // The programs are untouched: the same package key.
    expect(open.package!.hash).toBe(made.package.hash);
  });
});

describe('#1132 — byte changes still stale the program', () => {
  const BYTE: [string, (job: EngraveJob) => EngraveJob][] = [
    ['stock', (job) => ({ ...job, stock: { ...job.stock, length: job.stock.length + 1 } })],
    [
      'an item',
      (job) => ({
        ...job,
        labels: [...job.labels, { ...job.labels[0]!, id: 'extra-label-for-the-byte-change' }],
      }),
    ],
    ['the cutter', (job) => ({ ...job, toolKey: 'flat-3.175x12-metal' })],
    ['facing', (job) => ({ ...job, facing: { enabled: true, depth: 0.5 } })],
    ['the hold (a turned stock)', (job) => ({ ...job, workholding: { kind: 'vise' as const, vise: { ...jobVise(job), stockProud: 2 } } })],
  ];

  it.each(BYTE)('%s: the package is stale', (_name, change) => {
    const job = baseJob();
    const made = freezePackage(job, [program()], AT);
    if (!made.ok) throw new Error(made.reason);
    expect(packageStaleness(made.package, change(job)).stale).toBe(true);
  });
});


describe('#1132 migration — a package frozen under the old fingerprint stays current and upgrades on open', () => {
  /** The fixture whose hash was captured on the pre-#1132 build (da9a7c600): `aa7181a2`. */
  const LEGACY_FIXTURE_HASH = '8ec66ccc';

  function migrationFixture(): EngraveJob {
    const job = defaultEngraveJob();
    job.id = 'migration-fixture';
    job.name = 'migration fixture';
    job.labels = [];
    job.shapes = [];
    job.combined = [];
    job.traces = [];
    job.vectors = [];
    job.drills = [];
    job.threads = [];
    job.primitives = [];
    job.cutouts = [];
    job.chamfers = [];
    job.keepOuts = [];
    job.targetObjects = [];
    job.targetObject = undefined;
    job.customFonts = [];
    job.setups = undefined;
    return job;
  }

  it('reproduces the old build’s hash and treats its packages as current', () => {
    const job = migrationFixture();
    expect(legacyJobFingerprint(job)).toBe(LEGACY_FIXTURE_HASH);
    expect(jobFingerprint(job)).not.toBe(LEGACY_FIXTURE_HASH);

    const made = freezePackage(job, [program()], AT);
    if (!made.ok) throw new Error(made.reason);
    const legacyPkg = {
      ...made.package,
      jobHash: LEGACY_FIXTURE_HASH,
      hash: packageHash(LEGACY_FIXTURE_HASH, made.package.programs, SIMULATOR_VERSION),
    };
    expect(packageStaleness(legacyPkg, job)).toEqual({ stale: false, reason: null });
  });

  it('upgrades the stored hash on open, with the same programs and no worker', async () => {
    const job = migrationFixture();
    const made = freezePackage(job, [program()], AT);
    if (!made.ok) throw new Error(made.reason);
    const legacyPkg = {
      ...made.package,
      jobHash: LEGACY_FIXTURE_HASH,
      hash: packageHash(LEGACY_FIXTURE_HASH, made.package.programs, SIMULATOR_VERSION),
    };
    useEngraveJobStore.setState({ job: { ...job, package: legacyPkg } });
    // The open's refresh starts from the store write; let its microtasks land.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const open = useEngraveJobStore.getState().job;
    const newHash = jobFingerprint(open);
    expect(open.package!.jobHash).toBe(newHash);
    expect(open.package!.hash).toBe(packageHash(newHash, made.package.programs, SIMULATOR_VERSION));
    expect(open.package!.programs).toEqual(made.package.programs);
    expect(packageStaleness(open.package!, open)).toEqual({ stale: false, reason: null });
  });
});

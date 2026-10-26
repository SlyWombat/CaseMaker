// @vitest-environment jsdom
// The package (#419 §4): what Cut freezes, how it is known to be stale, and the blank it holds.
//
// Two halves, tested together because they are one promise: the pure engine (`package.ts`) decides
// the identity, and the store takes the stock and persists the texts so both survive a reload.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setHouseClientLoader, type HouseCall, type HouseClient } from '@/platform/houseClient';
import { StockItemSchema } from '@/platform/stockClient';
import { resetStockStore, useStockStore } from '@/store/stockStore';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { jobSetups } from '@/engine/cnc/engrave/jobSetup';
import { programHash } from '@/engine/cnc/programHash';
import {
  canonicalJson,
  freezePackage,
  jobFingerprint,
  packageHash,
  packageStaleness,
  type PackageProgramInput,
} from '@/engine/cnc/engrave/package';
import { surfaceRepostBlocker } from '@/store/engraveRunGate';
import { resetEngravePackageStore, useEngravePackageStore } from '@/store/engravePackageStore';
import { useEngraveJobStore } from '@/store/engraveJobStore';
import { parseEngraveJob } from '@/store/engraveJobSchema';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHELF = (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { stock: unknown[] })
  .stock;
const AT = '2026-10-17T09:00:00.000Z';

/** A stock entry for a shelf pick — the job's stock, which the freeze reserves. */
const shelfStock = (shelfId: string | null) =>
  ({ kind: 'shelf', shelfId, file: null, form: 'plate', finish: 'finished', conductive: false }) as const;

/** The job's programme as the generator hands it over; `programHash` is always the text's own. */
function program(nc: string, over: Partial<PackageProgramInput> = {}): PackageProgramInput {
  return {
    setupIndex: 1,
    setupId: 'setup-implicit',
    toolKey: 'flat-1.0',
    nc,
    frameNc: null,
    programHash: programHash(nc),
    ...over,
  };
}

describe('the package engine (#419 §4)', () => {
  it('canonicalises by key order and drops undefined, so the document, not its spelling, is hashed', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1, c: undefined })).toBe('{"a":2,"b":1}');
    expect(canonicalJson([{ z: 1 }, null])).toBe('[{"z":1},null]');
    const one = { ...defaultEngraveJob(), name: 'A' };
    const other = Object.fromEntries(Object.entries(one).reverse()) as unknown as EngraveJob;
    expect(jobFingerprint(other)).toBe(jobFingerprint(one));
  });

  it('freezes the texts, their FNV keys, the frame’s key and the setups', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), stockEntry: shelfStock('stock-plate1') };
    const made = freezePackage(job, [program('G21\nM331\nG0 X0\nM332\nM2\n', { frameNc: 'G0 X1 Y1\n' })], AT);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const pkg = made.package;
    expect(pkg.jobId).toBe(job.id);
    expect(pkg.frozenAt).toBe(AT);
    expect(pkg.stockEntryId).toBe('stock-plate1');
    expect(pkg.programs[0]!.hash).toBe(programHash(pkg.programs[0]!.nc));
    expect(pkg.programs[0]!.frameHash).toBe(programHash('G0 X1 Y1\n'));
    expect(pkg.setups.map((s) => s.id)).toEqual(jobSetups(job).map((s) => s.id));
    expect(pkg.hash).toBe(packageHash(pkg.jobHash, pkg.programs));
  });

  it('refuses a package with no program — there is nothing to approve', () => {
    const made = freezePackage(defaultEngraveJob(), [], AT);
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.reason).toContain('no generated program');
  });

  it('#608 — the package records the fitted plane it was posted against, or null when flat', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), stockEntry: shelfStock(null) };
    const tilt = { plane: { offset: -55, slopeX: -0.012202, slopeY: -0.005139 }, z0: -55.505 };
    const posted = freezePackage(job, [program('G21\nM2\n')], AT, tilt);
    if (!posted.ok) throw new Error(posted.reason);
    expect(posted.package.surface).toEqual({ plane: { offset: -55, slopeX: -0.012202, slopeY: -0.005139 }, z0: -55.505 });
    // A flat post (omitted) is recorded as null, so the gate reads "flat" and does not refuse.
    const flat = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!flat.ok) throw new Error(flat.reason);
    expect(flat.package.surface).toBeNull();
  });

  it('#608 — the release refuses a flat package once a registration has measured a tilt', () => {
    const tilt = { plane: { offset: -55, slopeX: -0.012202, slopeY: -0.005139 }, z0: -55.505 };
    // No registration, or no tilt on it: nothing to refuse.
    expect(surfaceRepostBlocker({ surface: null }, null)).toBeNull();
    expect(surfaceRepostBlocker({ surface: null }, { surface: null })).toBeNull();
    // A tilted registration against a flat package: refuse before the flat program is uploaded.
    const blocker = surfaceRepostBlocker({ surface: null }, { surface: tilt });
    expect(blocker).toBe('re-post against the tilt first — the frozen program is flat but the blank is tilted');
    // Once the package has been re-posted against the SAME fit, the gate lifts.
    expect(surfaceRepostBlocker({ surface: tilt }, { surface: tilt })).toBeNull();
    // #635 — a DIFFERENT fit is a mismatch in the other direction too: the package follows one
    // tilt, the blank now measures another, so the program must be re-posted, not shipped.
    const other = { plane: { offset: -55, slopeX: 0.001, slopeY: 0 }, z0: -55.505 };
    expect(surfaceRepostBlocker({ surface: tilt }, { surface: other })).toBe(
      're-post against the new tilt — the frozen program follows a different tilt than the blank measures now',
    );
    // #635 — and a package posted against a tilt does NOT stay uploadable after the blank is
    // re-seated and measures NO tilt (a dome or a flat): the lifted program would cut the colour
    // plane off by the old tilt.
    expect(surfaceRepostBlocker({ surface: tilt }, { surface: null })).toBe(
      're-generate flat — the frozen program follows a tilt, and the blank measures none now',
    );
    // With no registration at all there is nothing to compare, and nothing to refuse.
    expect(surfaceRepostBlocker({ surface: tilt }, null)).toBeNull();
  });

  it('is stale exactly when the job’s data changed, by value, so a reload cannot hide a change', () => {
    const job: EngraveJob = { ...defaultEngraveJob(), stockEntry: shelfStock(null) };
    const made = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);
    expect(packageStaleness(made.package, job)).toEqual({ stale: false, reason: null });

    // A deep edit — the first label's depth — reaches the fingerprint through the schema's data.
    const edited: EngraveJob = {
      ...job,
      labels: job.labels.map((l, i) => (i === 0 ? { ...l, depth: l.depth + 0.1 } : l)),
    };
    expect(packageStaleness(made.package, edited).stale).toBe(true);
    expect(packageStaleness(made.package, edited).reason).toContain('changed');

    // The fingerprint is data, not identity: a copy with the same values is not stale, a copy with
    // the job's id changed is.
    expect(packageStaleness(made.package, structuredClone(job)).stale).toBe(false);
    expect(packageStaleness(made.package, { ...job, id: 'job-other' }).stale).toBe(true);
  });

  it('a registration-plan change stales the package but not the program fingerprint (#574)', () => {
    // F6: approving the registration plan after Generate. The plan lives in the setups'
    // `registration`; the cutting program does not depend on it, so the Generate must stay current
    // while the frozen package goes stale — letting the Cut screen offer a re-freeze, not a
    // dead-end "changed since generated".
    const job = defaultEngraveJob();
    const setup = jobSetups(job)[0]!;
    const sansPlan: EngraveJob = { ...job, setups: [{ ...setup }] as NonNullable<EngraveJob['setups']> };
    const approved: EngraveJob = {
      ...job,
      setups: [
        { ...setup, registration: { method: 'vise' as const, plan: { mount: 'vise' as const, scans: [] }, expected: null } },
      ] as unknown as NonNullable<EngraveJob['setups']>,
    };

    // The program fingerprint ignores the probe choreography.
    expect(jobFingerprint(approved)).toBe(jobFingerprint(sansPlan));

    // …but the package frozen from the unplanned job is stale against the approved one, and the
    // reason names the plan.
    const made = freezePackage(sansPlan, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);
    const st = packageStaleness(made.package, approved);
    expect(st.stale).toBe(true);
    expect(st.reason).toContain('the registration changed');
  });

  it('#621 — the measured flatness (the registration’s outcome) does not stale the package', () => {
    const job = defaultEngraveJob();
    const made = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);

    // The registration writes the measured bow onto the stock; that is its outcome, not a change to
    // the cutting program, so a found position must not invalidate the frozen package.
    const measured: EngraveJob = {
      ...job,
      stock: {
        ...job.stock,
        flatness: { xMm: 0.1, yMm: 0.2, source: 'measured', touchCount: 5, measuredAt: '2026-10-24T16:50:00.000Z' },
      },
    };

    expect(jobFingerprint(measured)).toBe(jobFingerprint(job));
    expect(packageStaleness(made.package, measured).stale).toBe(false);
  });

  it('#627 — the ordinary origin write (the measured bow AND its provenance) does not stale the package', () => {
    const job = defaultEngraveJob();
    const made = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);

    // The ordinary Write-the-origin path runs the same registration, which writes the measured bow
    // onto the stock AND stamps `sources.stock.flatness: 'measured'` beside it (the registration's
    // `setStock`). Neither is a change to the cutting program, so an origin write must not
    // invalidate the frozen package.
    const written: EngraveJob = {
      ...job,
      stock: {
        ...job.stock,
        flatness: { xMm: 0.1, yMm: 0.2, source: 'measured', touchCount: 5, measuredAt: '2026-10-24T16:50:00.000Z' },
      },
      sources: {
        ...(job.sources ?? {}),
        stock: { ...(job.sources?.stock ?? {}), flatness: 'measured' as const },
      },
    };

    expect(jobFingerprint(written)).toBe(jobFingerprint(job));
    expect(packageStaleness(made.package, written).stale).toBe(false);
  });

  it('#627 — a change to the job’s machine (its calibration frame) still stales the package', () => {
    const job = defaultEngraveJob();
    const made = freezePackage(job, [program('G21\nM2\n')], AT);
    if (!made.ok) throw new Error(made.reason);

    // The calibration frame is the machine's (`machine.calibration.frame`, read through
    // `jobMachine(job, calibration)` keyed by `machineId`); a job pointed at a different machine is
    // a different program, and must still stale. Stripping the flatness provenance above must not
    // loosen this.
    const otherMachine: EngraveJob = { ...job, machineId: 'a-different-mill' };

    expect(jobFingerprint(otherMachine)).not.toBe(jobFingerprint(job));
    expect(packageStaleness(made.package, otherMachine).stale).toBe(true);
  });

  it('the package hash follows the job and the programs', () => {
    const job = defaultEngraveJob();
    const a = freezePackage(job, [program('G21\nM2\n')], AT);
    const same = freezePackage(job, [program('G21\nM2\n')], '2026-10-18T00:00:00.000Z');
    const b = freezePackage(job, [program('G21\nM3\n')], AT);
    const c = freezePackage({ ...job, name: 'renamed' }, [program('G21\nM2\n')], AT);
    if (!a.ok || !same.ok || !b.ok || !c.ok) throw new Error('freeze refused');
    // The SAME job and programs hash the same whenever they are frozen — the time is not identity.
    expect(same.package.hash).toBe(a.package.hash);
    expect(same.package.frozenAt).not.toBe(a.package.frozenAt);
    expect(b.package.hash).not.toBe(a.package.hash);
    expect(c.package.hash).not.toBe(a.package.hash);
  });
});

describe('the package store (#419 §4): freeze takes the blank, and keeps it while stale', () => {
  /** The same guarded fake the shelf's own spec uses — one entry replaced through PATCH. */
  function fakeShelf(items: unknown[]) {
    const calls: string[] = [];
    let version = 1;
    const etag = () => `"s-${version}"`;
    const client = {
      call: async (method: string, path: string, body?: unknown, opts?: { ifMatch?: string | null }): Promise<HouseCall> => {
        calls.push(`${method} ${path}`);
        if (method === 'GET' && path === '/stock') return { kind: 'ok', text: JSON.stringify(items), etag: etag() };
        const id = decodeURIComponent(path.replace('/stock/', ''));
        if (opts?.ifMatch !== etag()) return { kind: 'refused', status: 412, message: 'the stock shelf changed since you read it' };
        if (method === 'PATCH') {
          const i = items.findIndex((e) => (e as { id: string }).id === id);
          items[i] = body;
        }
        version += 1;
        return { kind: 'ok', text: '' };
      },
    } as unknown as HouseClient;
    setHouseClientLoader(async () => client);
    return { calls, items: () => items };
  }

  const entry = (id: string) =>
    (useStockStore.getState().items.find((i) => i.id === id) ?? null)!;

  const shelfJob = () => {
    // The document is the owner (#425), so a freeze writes into the OPEN job. Build the shelf job
    // from the store's own document and put it back, so the ids agree.
    const job: EngraveJob = { ...useEngraveJobStore.getState().job, stockEntry: shelfStock('stock-plate1') };
    useEngraveJobStore.getState().replace(job);
    return job;
  };

  beforeEach(() => {
    localStorage.clear();
    useEngraveJobStore.getState().reset();
    resetEngravePackageStore();
    resetStockStore();
  });
  afterEach(() => {
    setHouseClientLoader(null);
    vi.resetModules();
  });

  it('freezes into the JOB DOCUMENT, holds the blank, and writes no browser package cache', async () => {
    fakeShelf(SHELF.map((s) => StockItemSchema.parse(s)));
    const job = shelfJob();
    const res = await useEngravePackageStore.getState().freeze(job, [program('G21\nM331\nM332\nM2\n')]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reservation.kind).toBe('held');

    // The document owns it (#425 R8): the block is in the open job, and the old cache key is gone.
    expect(useEngraveJobStore.getState().job.package).toEqual(res.package);
    expect(useEngravePackageStore.getState().packageFor(job.id)?.hash).toBe(res.package.hash);
    expect(localStorage.getItem('casemaker.packages.v1')).toBeNull();

    const plate = entry('stock-plate1');
    expect(plate.reservations.map((r) => r.jobId).sort()).toEqual(['job-1', job.id].sort());
  });

  it('a stale package keeps its reservation, and the frozen text is what is still held', async () => {
    const svc = fakeShelf(SHELF.map((s) => StockItemSchema.parse(s)));
    const job = shelfJob();
    const frozenNc = 'G21\nM331\nM332\nM2\n';
    const res = await useEngravePackageStore.getState().freeze(job, [program(frozenNc)]);
    if (!res.ok) throw new Error(res.reason);

    const edited: EngraveJob = { ...job, name: 'Renamed after freezing' };
    const stored = useEngravePackageStore.getState().packageFor(job.id)!;
    expect(packageStaleness(stored, edited).stale).toBe(true);

    // Nothing was written to the shelf since the freeze: a stale package is not a released one.
    expect(entry('stock-plate1').reservations.map((r) => r.jobId)).toContain(job.id);
    expect(stored.programs[0]!.nc).toBe(frozenNc);
    expect(svc.calls.filter((c) => c === 'PATCH /stock/stock-plate1')).toHaveLength(1);
  });

  it('re-freezing the same job replaces its package and does not double its hold', async () => {
    fakeShelf(SHELF.map((s) => StockItemSchema.parse(s)));
    const job = shelfJob();
    const first = await useEngravePackageStore.getState().freeze(job, [program('G21\nM2\n')]);
    const second = await useEngravePackageStore.getState().freeze(job, [program('G21\nM3\n')]);
    if (!first.ok || !second.ok) throw new Error('freeze refused');

    expect(useEngravePackageStore.getState().packages).toHaveLength(1);
    expect(useEngravePackageStore.getState().packageFor(job.id)?.hash).toBe(second.package.hash);
    expect(entry('stock-plate1').reservations.filter((r) => r.jobId === job.id)).toHaveLength(1);
  });

  it('a re-freeze onto a different shelf entry releases the old blank', async () => {
    const items = SHELF.map((s) => StockItemSchema.parse(s));
    // A second, free entry of the same shape.
    items.push({ ...StockItemSchema.parse(SHELF[0]), id: 'stock-plate2', reservations: [] });
    fakeShelf(items);
    const job = shelfJob();
    await useEngravePackageStore.getState().freeze(job, [program('G21\nM2\n')]);
    const moved: EngraveJob = { ...job, stockEntry: shelfStock('stock-plate2') };
    const res = await useEngravePackageStore.getState().freeze(moved, [program('G21\nM2\n')]);
    expect(res.ok).toBe(true);

    expect(entry('stock-plate1').reservations.map((r) => r.jobId)).not.toContain(job.id);
    expect(entry('stock-plate2').reservations.map((r) => r.jobId)).toContain(job.id);
  });

  it('a job whose stock is not a shelf entry freezes without holding anything', async () => {
    const svc = fakeShelf(SHELF.map((s) => StockItemSchema.parse(s)));
    const res = await useEngravePackageStore.getState().freeze(
      { ...defaultEngraveJob(), stockEntry: shelfStock(null) },
      [program('G21\nM2\n')],
    );
    expect(res.ok && res.reservation.kind).toBe('none');
    expect(svc.calls.filter((c) => c.startsWith('PATCH'))).toEqual([]);
  });

  it('a refused shelf does not refuse the freeze — the package exists, the reservation says why', async () => {
    // stock-blank1 is at zero (consumed by job-12): reserve refuses with the consuming job named.
    fakeShelf(SHELF.map((s) => StockItemSchema.parse(s)));
    const job: EngraveJob = { ...useEngraveJobStore.getState().job, stockEntry: shelfStock('stock-blank1') };
    useEngraveJobStore.getState().replace(job);
    const res = await useEngravePackageStore.getState().freeze(job, [program('G21\nM2\n')]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.reservation.kind).toBe('refused');
    expect(res.reservation.text).toContain('job-12');
    expect(useEngravePackageStore.getState().packageFor(job.id)).not.toBeNull();
  });

  it('release lets the blank go', async () => {
    fakeShelf(SHELF.map((s) => StockItemSchema.parse(s)));
    const job = shelfJob();
    await useEngravePackageStore.getState().freeze(job, [program('G21\nM2\n')]);
    expect(await useEngravePackageStore.getState().release(job.id)).toBe(true);
    expect(entry('stock-plate1').reservations.map((r) => r.jobId)).not.toContain(job.id);
  });

  it('survives a reload through the document’s own autosave, not a package cache', async () => {
    const job = shelfJob();
    const nc = 'G21\nM331\nG0 X1\nM332\nM2\n';
    const res = await useEngravePackageStore.getState().freeze(job, [program(nc)]);
    if (!res.ok) throw new Error(res.reason);

    // What Save/Open reads: the serialized v3 document, parsed back through the real schema.
    const text = JSON.stringify(useEngraveJobStore.getState().job);
    const parsed = parseEngraveJob(JSON.parse(text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.package?.hash).toBe(res.package.hash);
    expect(parsed.job.package?.programs[0]?.nc).toBe(nc);

    // …and a fresh store module hydrates that same document from the v3 autosave slot.
    vi.resetModules();
    const fresh = await import('@/store/engravePackageStore');
    const back = fresh.useEngravePackageStore.getState().packageFor(job.id);
    expect(back?.hash).toBe(res.package.hash);
    expect(back?.programs[0]?.nc).toBe(nc);
    // ...and a changed job is still stale against the package read back, not merely empty.
    expect(packageStaleness(back!, { ...job, name: 'changed' }).stale).toBe(true);
  });
});

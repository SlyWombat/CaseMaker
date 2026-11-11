// #1102 — separate what HOLDS the blank from what LOCATES it. The bracket can be a FENCE (the
// blank taped to the bed and pushed into the bracket's corner): `tape` + `fence`. A bracket with
// no clamps is exactly that setup said from the wrong side, so the schema refuses it and the one
// stored shape that used to be allowed — the vendor tray's side 2 — migrates on load.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { planRegistrationAttempt } from '@/components/panels/registrationAttempt';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import { registrationTouches } from '@/engine/cnc/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';
import type { Setup } from '@/engine/cnc/setups';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { defaultBracketHold, defaultTapeHold, jobMount, workholdingFor } from '@/engine/cnc/engrave/jobSetup';
import { implicitSetupFor } from '@/engine/cnc/registration/implicitSetup';
import { footprintInputFor } from '@/engine/cnc/registration/footprintJob';
import { engraveJobDocumentSchema, parseEngraveJob } from '@/store/engraveJobSchema';
import { ShopDefaultsSchema, type ShopDefaults } from '@/platform/defaultsClient';
import { validateJob } from '@/engine/cnc/engrave/jobSetup';
import type { BedFence, EngraveJob, JobWorkholding } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const TRAY_SIDE_2 = join(HERE, '..', 'e2e', 'fixtures', 'm1trayB', 'm1trayB-bottom.cutjob.json');

const FENCE: BedFence = { kind: 'bracket', anchor: 1, variant: 'thin', edges: 'corner' };
const REFUSAL = "a bracket with no clamps is a fence — say 'taped, located against the bracket'";

function jobWith(workholding: JobWorkholding): EngraveJob {
  return { ...defaultEngraveJob(), workholding };
}
const parse = (job: unknown) => parseEngraveJob(JSON.parse(JSON.stringify(job)));

describe('#1102 the fence: tape holds, the bracket locates', () => {
  it('tape + fence (anchor 1, corner) is accepted, with where null and squareTo fence', () => {
    const tape = { ...defaultTapeHold(), where: null, squareTo: 'fence' as const, fence: FENCE };
    const parsed = parse(jobWith({ kind: 'tape', tape }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.workholding).toEqual({ kind: 'tape', tape });
  });

  it('tape without a fence is still the stored shape it was (fence absent, squareTo front)', () => {
    const parsed = parse(jobWith({ kind: 'tape', tape: defaultTapeHold() }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.workholding).toEqual({ kind: 'tape', tape: defaultTapeHold() });
    expect('fence' in (parsed.job.workholding as { tape: object }).tape).toBe(false);
  });

  it('a fence that names more than the corner is refused (a one-arm fence is not proven)', () => {
    const tape = { ...defaultTapeHold(), squareTo: 'fence' as const, fence: { ...FENCE, edges: 'left-arm' } };
    expect(parse(jobWith({ kind: 'tape', tape: tape as never })).ok).toBe(false);
  });

  it('a bracket with clamps: [] is refused with the sentence, by the document schema and by a parse', () => {
    const noClamps: JobWorkholding = { kind: 'bracket', bracket: { ...defaultBracketHold({ x: 100, y: 60, z: 6 }, null), clamps: [] } };
    const parsed = parse(jobWith(noClamps));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join('\n')).toContain(REFUSAL);
    const direct = engraveJobDocumentSchema.safeParse(JSON.parse(JSON.stringify(jobWith(noClamps))));
    expect(direct.success).toBe(false);
    if (!direct.success) expect(direct.error.issues.map((i) => i.message)).toContain(REFUSAL);
  });

  it('a bracket with clamps still parses', () => {
    expect(parse(jobWith({ kind: 'bracket', bracket: defaultBracketHold({ x: 100, y: 60, z: 6 }, null) })).ok).toBe(true);
  });
});

describe('#1102 the migration: the vendor tray’s side 2 is tape + fence', () => {
  it('rewrites the zero-clamp bracket under a taped board, and nothing else in the job changes', () => {
    const raw = JSON.parse(readFileSync(TRAY_SIDE_2, 'utf8')) as {
      workholding: { kind: string; bracket: { anchor: 1 | 2; variant: string; placement?: 'anchored' | 'placed'; obstacles?: unknown[] } };
    };
    expect(raw.workholding.kind).toBe('bracket');
    const migrated = parseEngraveJob(raw);
    expect(migrated.ok).toBe(true);
    if (!migrated.ok) return;

    const b = raw.workholding.bracket;
    const fence: BedFence = {
      kind: 'bracket',
      anchor: b.anchor,
      placement: b.placement,
      variant: b.variant,
      edges: 'corner',
      obstacles: b.obstacles as BedFence['obstacles'],
    };
    const explicit = { ...raw, workholding: { kind: 'tape', tape: { ...defaultTapeHold(), where: null, squareTo: 'fence', fence } } };
    const expected = parseEngraveJob(JSON.parse(JSON.stringify(explicit)));
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    const strip = (j: EngraveJob) => ({ ...j, id: undefined, setups: undefined });
    expect(migrated.job.workholding).toEqual(expected.job.workholding);
    expect(strip(migrated.job)).toEqual(strip(expected.job));
  });
});


// ---------------------------------------------------------------------------------------------------
// Registration: with a fence the datum is the bracket corner from the anchor record.

const LOCATION = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  machines: { calibration: MachineCalibration }[];
};
const CALIBRATION = LOCATION.machines[0]!.calibration;
const PROBE: ProbeSpec = {
  id: 'fx-probe-1',
  variant: 'wired-touch',
  instrument: 'z-only',
  tip: { diameterMm: 2, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25 },
};
const SETTINGS = registrationSettings(null, PROBE).settings;

function trayJob(workholding: JobWorkholding): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: '1102 registration',
    stock: { ...base.stock, length: 160, width: 126, thickness: 25, material: 'hardwood' },
    labels: [],
    shapes: [
      { id: 'tray-pocket', name: 'Tray', kind: 'rect', position: { x: 77.34, y: 63 }, rotation: 0, width: 100, height: 90, depth: 6, cornerRadius: 3, enabled: true },
    ],
    workholding,
  };
}

function attemptFor(job: EngraveJob, mountKind: 'tape' | 'bracket') {
  clearTargetObjectMeshCache();
  const setup = {
    index: 0,
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    stockBefore: { bounds: { min: [0, 0, -job.stock.thickness], max: [job.stock.length, job.stock.width, 0] }, cuts: [] },
  } as unknown as Setup;
  return planRegistrationAttempt({
    job,
    setup,
    mount: { kind: mountKind, board: true },
    mountDatum: null,
    mountDatumMismatch: null,
    mountDatumMismatchName: null,
    surfaceTopZ: null,
    bracketSeat: { value: -85.788, what: 'bracket seat', measuredAt: '2026-11-09T17:00:00.000Z', probeRefZ: -76.063 },
    probe: PROBE,
    probeName: 'Makera Wired Probe V2',
    mountTap: null,
    defaults: null,
    calibration: CALIBRATION,
    settings: SETTINGS,
  });
}

describe('#1102 registration with the fence', () => {
  it('a taped + fenced job plans no edge find and one top touch, XY from the anchor', () => {
    const job = trayJob({ kind: 'tape', tape: { ...defaultTapeHold(), where: null, squareTo: 'fence', fence: FENCE } });
    const attempt = attemptFor(job, 'tape');
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.scans).toEqual([]);
    expect(attempt.plan.corner).toBeUndefined();
    expect(registrationTouches({ ok: true, plan: attempt.plan })).toBe(1);
    expect(attempt.plan.bracketOrigin!.from).toContain('anchor');
    expect(attempt.plan.bracketOrigin!.x).toBeCloseTo(CALIBRATION.frame.anchor1[0], 3);
  });

  it('unfenced tape is still refused with its sentence', () => {
    const attempt = attemptFor(trayJob({ kind: 'tape', tape: defaultTapeHold() }), 'tape');
    expect(attempt.kind).toBe('refused');
    if (attempt.kind !== 'refused') return;
    expect(attempt.reason).toBe('registration on tape has not been run on this machine yet — hold the blank in the vise');
  });
});


describe('#1102 one mount for a fenced job: every reader sees the bracket', () => {
  const fencedJob = () => trayJob({ kind: 'tape', tape: { ...defaultTapeHold(), where: null, squareTo: 'fence', fence: FENCE } });
  // The same setup said from the bracket's side (hand-built: the schema refuses it, which is the point).
  const bracketTwin = () => trayJob({ kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [], source: 'default' } });

  it('the job’s mount, its derived setup and its planner hold are the bracket’s', () => {
    expect(jobMount(fencedJob())).toBe('bracket');
    expect(jobMount(trayJob({ kind: 'tape', tape: defaultTapeHold() }))).toBe('tape');
    expect(implicitSetupFor(fencedJob())?.mount.kind).toBe('bracket');
    expect(workholdingFor(fencedJob())).toEqual({ kind: 'anchor-bracket', anchor: 1, offset: [0, 0] });
  });

  it('the registration plan is the bracket twin’s, whichever mount the caller names', () => {
    const fromTape = attemptFor(fencedJob(), 'tape');
    const fromBracket = attemptFor(bracketTwin(), 'bracket');
    expect(fromTape.kind).toBe('plan');
    expect(fromBracket.kind).toBe('plan');
    if (fromTape.kind !== 'plan' || fromBracket.kind !== 'plan') return;
    expect(fromTape.plan).toEqual(fromBracket.plan);
  });

  it('the footprint input is the twin’s', () => {
    const args = (job: EngraveJob, kind: 'tape' | 'bracket') => ({
      job,
      mount: { kind, board: true } as const,
      calibration: CALIBRATION,
      defaults: null,
      probe: PROBE,
      bracketSeat: { value: -85.788, what: 'bracket seat', measuredAt: '2026-11-09T17:00:00.000Z', probeRefZ: -76.063 },
    });
    const a = footprintInputFor(args(fencedJob(), 'tape'));
    const b = footprintInputFor(args(bracketTwin(), 'bracket'));
    expect(a.ok, JSON.stringify(a)).toBe(true);
    expect(a).toEqual(b);
  });
});


// ---------------------------------------------------------------------------------------------------
// The clamp count is a shop setting (`clamps.maxCount`, #1207), not a literal in the schema.

describe('#1102 the most clamps is the shop’s setting', () => {
  const shop = (maxCount?: number): ShopDefaults => {
    const base = (JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: Record<string, unknown> }).defaults;
    const defaults = { ...base };
    if (maxCount !== undefined) defaults['clamps.maxCount'] = { value: maxCount, source: 'chosen', setAt: '2026-11-11T00:00:00.000Z', unit: 'clamps' };
    return ShopDefaultsSchema.parse(defaults);
  };
  const clampsJob = (n: number): EngraveJob =>
    jobWith({
      kind: 'bracket',
      bracket: {
        anchor: 1,
        variant: 'thin',
        clamps: Array.from({ length: n }, (_, i) => ({ edge: 'back' as const, at: 12 + i * 22 })),
        source: 'default',
      },
    });
  const findingCodes = (job: EngraveJob, d: ShopDefaults) => validateJob(job, null, { defaults: d }).map((f) => f.code);

  it('the schema states no count of its own: five clamps parse', () => {
    expect(parse(clampsJob(5)).ok).toBe(true);
  });

  it('a 5th clamp is refused by the setting (4), as a stated finding', () => {
    const findings = validateJob(clampsJob(5), null, { defaults: shop() });
    const f = findings.find((x) => x.code === 'too-many-clamps');
    expect(f?.severity).toBe('error');
    expect(f?.message).toMatch(/5 clamps.*4/);
  });

  it('four clamps are fine, and five are allowed when the setting is 5', () => {
    expect(findingCodes(clampsJob(4), shop())).not.toContain('too-many-clamps');
    expect(findingCodes(clampsJob(5), shop(5))).not.toContain('too-many-clamps');
  });
});

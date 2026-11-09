/**
 * #1070 — THE CUT STEP PLANS A BED-HELD JOB'S REGISTRATION (the maintainer's rule: the program
 * registers; nobody hand-drives).
 *
 * RED at the pre-change tree: `planRegistrationAttempt` refuses every bracket job by name ("the
 * bracket's registration has not been run on this machine yet — hold the blank in the vise"), so
 * the Cut step lists no touches and the Run press has nothing to send. GREEN here: the bracket
 * job's attempt is a `plan` whose touches are the cut region's footprint — two per bounding edge
 * at the region's extents, the far edges once, one Z touch per region corner — every position in
 * machine coordinates inside the machine's soft endstop, and the origin the two touched edge lines
 * derive.
 *
 * The numbers are read off the JOB (the region from its cut extents, the seed from the anchor-1
 * bracket datum, the margin from its own `edgeMargin`), not restated here.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';
import type { Setup } from '@/engine/cnc/setups';
import { planRegistrationAttempt } from '@/components/panels/registrationAttempt';
import { footprintInputFor, seatSeekFor, sheetRegistrationPlan } from '@/engine/cnc/registration/footprintJob';
import { planFootprintRegistration } from '@/engine/cnc/registration/footprint';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
import { isSeatPlan, seatTapArgs } from '@/engine/cnc/registration/seatPress';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
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

/** The tray job's shape: a 160 × 126 × 25 blank in the bracket with one real cut region. */
function bracketJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'cut-step footprint 1070',
    stock: { ...base.stock, length: 160, width: 126, thickness: 25, material: 'hardwood' },
    labels: [],
    shapes: [
      {
        id: 'tray-pocket',
        name: 'Tray',
        kind: 'rect',
        position: { x: 90, y: 63 },
        rotation: 0,
        width: 100,
        height: 90,
        depth: 6,
        cornerRadius: 3,
        enabled: true,
      },
    ],
    workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [{ edge: 'back', at: 63 }], source: 'default' } },
  };
}

/** The minimals planRegistrationAttempt reads from a derived setup (rotation + stock bounds). */
function setupFor(job: EngraveJob): Setup {
  return {
    index: 0,
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    stockBefore: {
      bounds: { min: [0, 0, -job.stock.thickness], max: [job.stock.length, job.stock.width, 0] },
      cuts: [],
    },
  } as unknown as Setup;
}

function baseArgs(job: EngraveJob) {
  return {
    job,
    setup: setupFor(job),
    mountDatum: null,
    mountDatumMismatch: null,
    mountDatumMismatchName: null,
    surfaceTopZ: null,
    bracketSeat: { value: -51.69, what: 'bracket seat' as const, measuredAt: '2026-11-07T20:00:00.000Z' },
    probe: PROBE,
    probeName: 'Makera Wired Probe V2',
    mountTap: null,
    defaults: null,
    calibration: CALIBRATION,
    settings: SETTINGS,
  };
}

function attemptFor(job: EngraveJob) {
  return planRegistrationAttempt({ ...baseArgs(job), mount: { kind: 'bracket', board: true } });
}

describe('#1070 the seat is the board the blank rests on (the gate’s ruling, C8)', () => {
  /** The tray job as delivered: a 6 mm under-board fixed with screws. */
  const withUnder = (job: EngraveJob): EngraveJob => ({
    ...job,
    sacrificial: { ...job.sacrificial, under: { thickness: 6, overhang: { left: 0, right: 0, front: 0, back: 0 }, attach: 'screws' } },
  });

  it('a seat that SAYS it is the surface the stock rests on does not add the under again', () => {
    const job = withUnder(bracketJob());
    const seat = { value: -85.75, what: 'bracket seat' as const, measuredAt: '2026-11-08T00:00:00.000Z', restsOnStock: true };
    const input = footprintInputFor({ ...baseArgs(job), mount: { kind: 'bracket', board: true }, bracketSeat: seat });
    if (!input.ok) throw new Error(input.reason);
    // The seat press measured the wasteboard the blank stands on: −85.75 + the stock's 25 = −60.75.
    // The job's 6 mm under IS that board — adding it again would expect −54.75 and miss by 6 mm.
    expect(input.input.expectedSurface.machineZ).toBe(-60.75);
  });

  it('a legacy seat with no statement keeps the under-board (seat = the bed, a board on top)', () => {
    const job = withUnder(bracketJob());
    const seat = { value: -85.75, what: 'surface top' as const, measuredAt: '2026-11-08T00:00:00.000Z' };
    const input = footprintInputFor({ ...baseArgs(job), mount: { kind: 'bracket', board: true }, bracketSeat: seat });
    if (!input.ok) throw new Error(input.reason);
    expect(input.input.expectedSurface.machineZ).toBe(-54.75); // −85.75 + 6 + 25
  });
});

describe('#1070 a PLACED bracket (the gate’s ruling, C8)', () => {
  const placedJob = (): EngraveJob => {
    const job = bracketJob();
    if (job.workholding.kind !== 'bracket') throw new Error('the fixture is a bracket job');
    (job.workholding.bracket as { placement?: 'anchored' | 'placed' }).placement = 'placed';
    return job;
  };
  const gridSeed = { x: -190.89, y: -193.829, by: 'grid' as const, measuredAt: '2026-11-08T00:00:00.000Z', at: null, probe: null };
  const touchSeed = { x: -182.0, y: -194.6, by: 'touch' as const, measuredAt: '2026-11-08T00:00:00.000Z', at: [-182.0, -194.6] as [number, number], probe: 'fx-probe-1' };

  it('a stored GRID seed plans from it, the origin not measured', () => {
    const attempt = planRegistrationAttempt({ ...baseArgs(placedJob()), mount: { kind: 'bracket', board: true }, placedSeed: gridSeed });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.bracketOrigin).toMatchObject({ x: -190.89, y: -193.829, offsetMeasured: false });
    expect(attempt.plan.bracketOrigin!.from).toContain('hole grid');
  });

  it('a stored TOUCH seed plans from the measured origin', () => {
    const attempt = planRegistrationAttempt({ ...baseArgs(placedJob()), mount: { kind: 'bracket', board: true }, placedSeed: touchSeed });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.bracketOrigin).toMatchObject({ x: -182.0, y: -194.6, offsetMeasured: true });
    expect(attempt.plan.bracketOrigin!.from).toContain('measured');
  });

  it('no stored seed refuses by name, naming the bed profile’s placement', () => {
    const attempt = planRegistrationAttempt({ ...baseArgs(placedJob()), mount: { kind: 'bracket', board: true }, placedSeed: null });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('refused');
    if (attempt.kind === 'refused') {
      expect(attempt.reason).toContain('bed profile');
      expect(attempt.reason).toContain('placement');
    }
  });
});

describe('#1070 the Cut step plans a bracket job on its cut region', () => {
  // #1133 — SUPERSEDED FOR THE CUT STEP: a bracket hold fixes X, Y and rotation, so the plan is
  // ONE top touch — no edge scans, no corner derivation. #1070's footprint planner still exists
  // (and is covered below through `footprintInputFor`/`planFootprintRegistration`), but the
  // Register card no longer plans it; the bench's four-edge proposal was this mount's wrong plan.
  it('a bracket job is a PLAN with one top touch and no edge finds (#1133)', () => {
    const attempt = attemptFor(bracketJob());
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.scans).toEqual([]);
    expect(attempt.plan.corner).toBeUndefined();
    expect(attempt.plan.mountTap).toBeNull();
    expect(attempt.plan.bracketOrigin?.offsetMeasured).toBe(false);
    expect(attempt.summary).toContain('bracket fixes X and Y');
    expect(attempt.expected).toContain('XY from the bracket');
  });

  it('the plan’s one touch is inside the soft endstop (#1133: no scans to check)', () => {
    const attempt = attemptFor(bracketJob());
    if (attempt.kind !== 'plan') throw new Error(JSON.stringify(attempt));
    const plan = attempt.plan;
    expect(plan.scans).toEqual([]);
    const lim = CALIBRATION.softEndstop;
    expect(lim.enabled).toBe(true);
    // The anchor-1 seed places the machine coordinates: work (0,0) is machine (−190.89, −193.83).
    expect(plan.bracketOrigin!.x + plan.surfacePoint.x).toBeGreaterThanOrEqual(lim.xMin);
    expect(plan.bracketOrigin!.y + plan.surfacePoint.y).toBeGreaterThanOrEqual(lim.yMin);
    expect(plan.seek.band.min).toBeGreaterThanOrEqual(lim.zMin);
  });

  it('a tape job keeps its named refusal — the tape footprint path is not wired yet', () => {
    const job = bracketJob();
    const attempt = planRegistrationAttempt({ ...baseArgs(job), mount: { kind: 'tape' } });
    expect(attempt.kind).toBe('refused');
    if (attempt.kind === 'refused') expect(attempt.reason).toContain('registration on tape');
  });

  it('a PLACED bracket with no stated placement is refused by name — and the refusal says where to state it', () => {
    const job = bracketJob();
    if (job.workholding.kind !== 'bracket') throw new Error('the fixture is a bracket job');
    // The field lives on land7's BracketHold; read defensively so this line typechecks alone.
    (job.workholding.bracket as { placement?: 'anchored' | 'placed' }).placement = 'placed';
    const attempt = attemptFor(job);
    expect(attempt.kind, JSON.stringify(attempt)).toBe('refused');
    if (attempt.kind === 'refused') {
      expect(attempt.reason).toContain('bed profile');
      expect(attempt.reason).toContain('placement');
    }
  });
});

describe('#1070 the sheet’s §6 prints the footprint plan', () => {
  it('the footprint section: the region’s scans and corners with machine coordinates, not the blank edges', () => {
    const job = bracketJob();
    const input = footprintInputFor({ ...baseArgs(job), mount: { kind: 'bracket', board: true }, mountObstacles: [] });
    if (!input.ok) throw new Error(input.reason);
    const planned = planFootprintRegistration(input.input);
    if (!planned.ok) throw new Error(planned.reason);
    const stub = { findings: [], feeds: null, cam: null, nc: '', verify: null, frameNc: null } as unknown as Parameters<typeof buildRunSheet>[1];
    const sheet = buildRunSheet(job, stub, null, new Date('2026-11-08T00:00:00Z'), undefined, { footprint: planned.plan });
    const text = sheet.sections.flatMap((s) => s.steps.map((step) => step.text)).join('\n');
    expect(text).toContain("Registration is planned on the cut region's footprint");
    expect(text).toContain('machine X');
    expect(text).toContain('this gives the edge line and its rotation where the cut is');
    expect(text).toContain('the surface for the Z band');
    expect(text).toContain('inside the machine’s soft endstop');
    expect(text).not.toContain('already references');
  });
});

describe('#1070 the first seat is measured by the program (6b’s ruling)', () => {
  it('with no seat datum the press plans ONE bounded Z seek on the wasteboard beside the blank (#1133 chooses the point)', () => {
    const attempt = planRegistrationAttempt({ ...baseArgs(bracketJob()), mount: { kind: 'bracket', board: true }, bracketSeat: null });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    const plan = attempt.plan;
    expect(plan.mountTap?.reference).toBe('bracket-seat');
    // The reading IS the seat: no datum offset.
    expect(plan.mountTap?.datumOffsetMm).toBe(0);
    expect(plan.mountTap?.expectZ).toBe(-85.75);
    expect(plan.seek.band).toEqual({ min: -87.25, max: -84.25 });
    // Starts above the band.
    expect(plan.seek.fromMachineZ).toBe(-81.25);
    // The point: chosen on open board, clear of the stock and every fixture by the head envelope.
    expect(plan.mountTap!.x).toBeGreaterThan(CALIBRATION.softEndstop.xMin);
    expect(plan.mountTap!.y).toBeGreaterThan(CALIBRATION.softEndstop.yMin);
    // The bound: no further than the band's floor less the scan reach, inside the soft endstop.
    expect(plan.seek.travelMm).toBeCloseTo(-81.25 - (-92.25), 3);
    expect(-92.25).toBeGreaterThan(CALIBRATION.softEndstop.zMin);
    const notes = plan.notes.join('\n');
    expect(notes).toContain('derived from the 2026-11-07 touch');
    expect(notes).toContain('valid only for the probe fitting');
    expect(notes).toContain('measures every session');
    expect(notes).toContain('arm top 15');
  });
});

describe('#1070 the sheet names the seat seek as the first touch of the day', () => {
  it('the app sheet’s one seam: the shared plan for the tray job and house prints the seat block', () => {
    const job = bracketJob();
    // The app's call site resolves the same four inputs the Cut card plans from (calibration,
    // probe, defaults, seat): on this house the datum is not usable by the checked-out probe, so
    // the card — and now the sheet — take the seat branch.
    const reg = sheetRegistrationPlan({ job, calibration: CALIBRATION, defaults: null, probe: PROBE, bracketSeat: null });
    expect(reg.footprint).toBeUndefined();
    expect(reg.seatSeek?.band).toEqual({ min: -87.25, max: -84.25 });
    const stub = { findings: [], feeds: null, cam: null, nc: '', verify: null, frameNc: null } as unknown as Parameters<typeof buildRunSheet>[1];
    const sheet = buildRunSheet(job, stub, null, new Date('2026-11-08T00:00:00Z'), undefined, { ...reg });
    const text = sheet.sections.flatMap((s2) => s2.steps.map((step) => step.text)).join('\n');
    expect(text).toContain('THE FIRST TOUCH OF THE DAY');
    expect(text).toContain('bounded Z seek with the wired probe on the wasteboard beside the blank');
  });

  it('no seat datum: §6 opens with the one bounded seek, then says to plan again', () => {
    const job = bracketJob();
    const seat = seatSeekFor({ job, calibration: CALIBRATION, defaults: null, probe: PROBE });
    if (!seat.ok) throw new Error(seat.reason);
    const stub = { findings: [], feeds: null, cam: null, nc: '', verify: null, frameNc: null } as unknown as Parameters<typeof buildRunSheet>[1];
    const sheet = buildRunSheet(job, stub, null, new Date('2026-11-08T00:00:00Z'), undefined, { seatSeek: seat.seek });
    const text = sheet.sections.flatMap((s2) => s2.steps.map((step) => step.text)).join('\n');
    expect(text).toContain('THE FIRST TOUCH OF THE DAY');
    expect(text).toContain('bounded Z seek with the wired probe on the wasteboard beside the blank');
    expect(text).toContain('valid only for the probe fitting');
    expect(text).toContain('press Plan registration again');
  });
});

describe('#1070 the seat press hands the tap its plan bound (A’s executor aea758abf)', () => {
  it('the seat tap is bounded at −92.25 (band floor less reach), not the envelope floor', () => {
    const attempt = planRegistrationAttempt({ ...baseArgs(bracketJob()), mount: { kind: 'bracket', board: true }, bracketSeat: null });
    if (attempt.kind !== 'plan') throw new Error(JSON.stringify(attempt));
    expect(isSeatPlan(attempt.plan)).toBe(true);
    const args = seatTapArgs(attempt.plan);
    expect(args, 'a seat plan hands the tap args').not.toBeNull();
    // 11 mm of travel below the start: the tap floor is −81.25 − 11 = −92.25, never the envelope's.
    expect(args!.planTravelMm).toBeCloseTo(11, 3);
    expect(args!.fromMachineZ - args!.planTravelMm!).toBeCloseTo(-92.25, 3);
    expect(args!.fromMachineZ - args!.planTravelMm!).toBeGreaterThan(CALIBRATION.softEndstop.zMin);
    expect(args!.reference).toBe('bracket-seat');
    expect(args!.datumOffsetMm).toBe(0);
  });

  it('the measured-seat plan is not a seat plan and hands no tap args (#1133: no tap at all)', () => {
    const attempt = planRegistrationAttempt({ ...baseArgs(bracketJob()), mount: { kind: 'bracket', board: true } });
    if (attempt.kind !== 'plan') throw new Error(JSON.stringify(attempt));
    expect(isSeatPlan(attempt.plan)).toBe(false);
    expect(seatTapArgs(attempt.plan)).toBeNull();
  });
});

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
import { footprintInputFor, seatSeekFor } from '@/engine/cnc/registration/footprintJob';
import { planFootprintRegistration } from '@/engine/cnc/registration/footprint';
import { buildRunSheet } from '@/engine/cnc/engrave/runSheet';
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
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
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

describe('#1070 the Cut step plans a bracket job on its cut region', () => {
  it('a bracket job is a PLAN, not the "hold the blank in the vise" refusal', () => {
    const attempt = attemptFor(bracketJob());
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    // The touches: two per bounding edge at the REGION's extents, then the far edges once each.
    const extents = attempt.plan.scans.filter((s) => s.edge === 'front' || s.edge === 'left');
    expect(extents.map((s) => [s.edge, s.along])).toEqual([
      ['front', 40],
      ['front', 140],
      ['left', 18],
      ['left', 108],
    ]);
    expect(attempt.plan.scans.map((s) => s.edge)).toEqual(['front', 'front', 'left', 'left', 'right', 'back']);
    // #525 — the origin is the corner the two touched edge lines intersect at.
    expect(attempt.plan.corner).toEqual({ id: 'front-left', xEdge: 'left', yEdge: 'front' });
    expect(attempt.plan.bracketOrigin?.offsetMeasured).toBe(false);
    expect(attempt.summary).toContain('bracket');
  });

  it('every planned touch is in machine coordinates inside the soft endstop', () => {
    const attempt = attemptFor(bracketJob());
    if (attempt.kind !== 'plan') throw new Error(JSON.stringify(attempt));
    const plan = attempt.plan;
    // The anchor-1 seed places the machine coordinates: work (0,0) is machine (−190.89, −193.83).
    const x0 = plan.bracketOrigin!.x;
    const y0 = plan.bracketOrigin!.y;
    const lim = CALIBRATION.softEndstop;
    expect(lim.enabled).toBe(true);
    for (const s of plan.scans) {
      const at = (v: number): [number, number] => (s.edge === 'left' || s.edge === 'right' ? [x0 + v, y0 + s.along] : [x0 + s.along, y0 + v]);
      for (const [x, y] of [at(s.start), at(s.limit)]) {
        expect(x, `${s.edge} scan X ${x} past the endstop`).toBeGreaterThanOrEqual(lim.xMin);
        expect(y, `${s.edge} scan Y ${y} past the endstop`).toBeGreaterThanOrEqual(lim.yMin);
      }
    }
    expect(plan.seek.band.min).toBeGreaterThanOrEqual(lim.zMin);
  });

  it('a tape job keeps its named refusal — the tape footprint path is not wired yet', () => {
    const job = bracketJob();
    const attempt = planRegistrationAttempt({ ...baseArgs(job), mount: { kind: 'tape' } });
    expect(attempt.kind).toBe('refused');
    if (attempt.kind === 'refused') expect(attempt.reason).toContain('registration on tape');
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
  it('with no seat datum the press plans ONE bounded Z seek on the wasteboard beside the front arm', () => {
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
    // The point: the wasteboard past the front arm's free end, in front of the stock.
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
  it('no seat datum: §6 opens with the one bounded seek, then says to plan again', () => {
    const job = bracketJob();
    const seat = seatSeekFor({ job, calibration: CALIBRATION, defaults: null, probe: PROBE });
    if (!seat.ok) throw new Error(seat.reason);
    const stub = { findings: [], feeds: null, cam: null, nc: '', verify: null, frameNc: null } as unknown as Parameters<typeof buildRunSheet>[1];
    const sheet = buildRunSheet(job, stub, null, new Date('2026-11-08T00:00:00Z'), undefined, { seatSeek: seat.seek });
    const text = sheet.sections.flatMap((s2) => s2.steps.map((step) => step.text)).join('\n');
    expect(text).toContain('THE FIRST TOUCH OF THE DAY');
    expect(text).toContain('bounded Z seek with the wired probe on the wasteboard beside the bracket’s front arm');
    expect(text).toContain('valid only for the probe fitting');
    expect(text).toContain('press Plan registration again');
  });
});

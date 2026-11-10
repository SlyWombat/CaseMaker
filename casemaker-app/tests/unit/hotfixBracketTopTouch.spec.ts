/**
 * HOTFIX (bench 2026-11-09) — A BRACKET JOB'S REGISTRATION IS ONE TOP TOUCH.
 *
 * On a575c26e the Register card proposed #1070's footprint find: the bracket plan probed the
 * arm-side edges from the waste band, read an old bore or the clamp, and refused at "corner
 * 27.606° out of square" — while the wording said "right/back" and the probe worked left/front.
 * A bracket hold fixes X, Y and rotation, so the plan is ONE surface touch at the cut area's
 * centre; XY is the anchor plus the bracket's offset.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clearTargetObjectMeshCache } from '@/engine/import/targetObject';
import { registrationTouches } from '@/engine/cnc/plan';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { planRegistrationAttempt } from '@/components/panels/registrationAttempt';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';
import type { Setup } from '@/engine/cnc/setups';
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

/** The bench job: 160 × 126 × 25 hardwood in the bracket, cut area centred at (77.34, 63). */
function benchJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'hotfix bracket top touch',
    stock: { ...base.stock, length: 160, width: 126, thickness: 25, material: 'hardwood' },
    labels: [],
    shapes: [
      {
        id: 'tray-pocket',
        name: 'Tray',
        kind: 'rect',
        position: { x: 77.34, y: 63 },
        rotation: 0,
        width: 100,
        height: 90,
        depth: 6,
        cornerRadius: 3,
        enabled: true,
      },
    ],
    workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [{ edge: 'back', at: 27.75 }], source: 'default' } },
  };
}

function setupFor(job: EngraveJob): Setup {
  return {
    index: 0,
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    stockBefore: { bounds: { min: [0, 0, -job.stock.thickness], max: [job.stock.length, job.stock.width, 0] }, cuts: [] },
  } as unknown as Setup;
}

describe('HOTFIX — a bracket job plans exactly one top touch', () => {
  it('one touch at the cut area’s centre: no scans, no corner, XY from the bracket', () => {
    clearTargetObjectMeshCache();
    const job = benchJob();
    const attempt = planRegistrationAttempt({
      job,
      setup: setupFor(job),
      mount: { kind: 'bracket', board: true },
      mountDatum: null,
      mountDatumMismatch: null,
      mountDatumMismatchName: null,
      surfaceTopZ: null,
      bracketSeat: { value: -85.788, what: 'bracket seat', measuredAt: '2026-11-09T17:00:00.000Z' },
      probe: PROBE,
      probeName: 'Makera Wired Probe V2',
      mountTap: null,
      defaults: null,
      calibration: CALIBRATION,
      settings: SETTINGS,
    });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    const plan = attempt.plan;
    // ONE top touch at the cut area's centre — the whole plan.
    expect(plan.scans).toEqual([]);
    expect(plan.corner).toBeUndefined();
    expect(plan.mountTap).toBeNull();
    expect(registrationTouches({ ok: true, plan })).toBe(1);
    expect(plan.surfacePoint).toEqual({ x: 77.34, y: 63 });
    // XY is the anchor plus the bracket's offset — and a bracket whose offset is NOT measured still
    // plans: the confirming edge find that used to be demanded was the bench failure.
    expect(plan.bracketOrigin!.from).toContain('anchor');
    expect(plan.bracketOrigin!.x).toBeCloseTo(CALIBRATION.frame.anchor1[0], 3);
    expect(plan.bracketOrigin!.y).toBeCloseTo(CALIBRATION.frame.anchor1[1], 3);
    // #1123 item 29 + #1133 — a no-scan plan narrates the touch and no scan (the old clause read
    // as a garbled instruction).
    expect(attempt.summary).toContain("touch the surface at the cut area's centre");
    expect(attempt.summary).not.toContain('then scan');
    expect(attempt.expected).toContain('XY from the bracket');
  });

  it('the touch stays clear of the back-edge clamp and inside the blank', () => {
    clearTargetObjectMeshCache();
    const job = benchJob();
    const attempt = planRegistrationAttempt({
      job,
      setup: setupFor(job),
      mount: { kind: 'bracket', board: true },
      mountDatum: null,
      mountDatumMismatch: null,
      mountDatumMismatchName: null,
      surfaceTopZ: null,
      bracketSeat: { value: -85.788, what: 'bracket seat', measuredAt: '2026-11-09T17:00:00.000Z' },
      probe: PROBE,
      probeName: 'Makera Wired Probe V2',
      mountTap: null,
      defaults: null,
      calibration: CALIBRATION,
      settings: SETTINGS,
    });
    if (attempt.kind !== 'plan') throw new Error(JSON.stringify(attempt));
    const { x, y } = attempt.plan.surfacePoint;
    expect(x).toBeGreaterThan(0);
    expect(y).toBeGreaterThan(0);
    expect(x).toBeLessThan(job.stock.length);
    expect(y).toBeLessThan(job.stock.width);
    // The plan's own obstacle check did not refuse it (the clamp is on the back edge, ~27.75 + 15).
    expect(attempt.plan.mountObstacles.length).toBeGreaterThan(0);
  });
});

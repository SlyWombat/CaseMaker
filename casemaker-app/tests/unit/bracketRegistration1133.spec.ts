/**
 * #1133 — A BRACKET HOLD IS REGISTERED ON A TOP TOUCH, NOT THE VISE'S FIND.
 *
 * Bench, 2026-11-09 13:1x: after the seat datum was written, the Register card proposed
 * "left, front, right and back edges, then the top face · 37 touches". A bracket hold fixes X, Y
 * and rotation (repeat 0.05 mm, fit 0.1 mm), so the plan is a Z (top) touch plus, at most, one arm
 * check — never an edge find. And the seat tap point must be chosen so the HEAD clears the stock
 * and every fixture: the maintainer refused the old point 7.5 mm in front of the blank because the
 * head would hit the taller wood, and probed on the open board instead.
 *
 * The head envelope is a Z1 product constant (every Z1 is the same unit), read from Makera's own
 * public model (`Makera-Z1_Simplified_4Axis.step`, sha256 b7df28bc…) — see `machine.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import { clampPlacementsFor } from '@/engine/cnc/engrave/jobSetup';
import { bracketObstacles, bracketSettings, clampObstacles, defaultClampPlacements } from '@/engine/cnc/mounts/bracket';
import { headEnvelopeOf, Z1 } from '@/engine/cnc/machine';
import { jobMachine } from '@/engine/cnc/calibration';
import { registrationSettings } from '@/engine/cnc/registration/settings';
import { registrationTouches } from '@/engine/cnc/plan';
import { seatSeekFor } from '@/engine/cnc/registration/footprintJob';
import { planRegistrationAttempt } from '@/components/panels/registrationAttempt';
import type { MachineCalibration } from '@/engine/cnc/calibration';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';
import type { Setup } from '@/engine/cnc/setups';
import type { ShopDefaults } from '@/platform/defaultsClient';
import type { EngraveJob } from '@/types/engraveJob';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCATION = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
  machines: { calibration: MachineCalibration }[];
  defaults: ShopDefaults;
};
const CALIBRATION = LOCATION.machines[0]!.calibration;

const PROBE: ProbeSpec = {
  id: 'fx-probe-1',
  variant: 'wired-touch',
  instrument: 'z-only',
  tip: { diameterMm: 2, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25 },
};
const SETTINGS = registrationSettings(null, PROBE).settings;

/** The set B tray blanket in the bracket: 160 × 126 × 25 (the #1070 fixture's shape). */
function bracketJob(): EngraveJob {
  const base = defaultEngraveJob();
  return {
    ...base,
    name: 'bracket registration 1133',
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
    workholding: { kind: 'bracket', bracket: { anchor: 1, variant: 'thin', clamps: [{ edge: 'back', at: 55.5 }], source: 'default' } },
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

function attemptFor(
  job: EngraveJob,
  seat: { value: number; what: 'bracket seat'; measuredAt: string; probeRefZ?: number | null } | null,
  over: Partial<Parameters<typeof planRegistrationAttempt>[0]> = {},
) {
  return planRegistrationAttempt({
    job,
    setup: setupFor(job),
    mount: { kind: 'bracket', board: true },
    mountDatum: null,
    mountDatumMismatch: null,
    mountDatumMismatchName: null,
    surfaceTopZ: null,
    bracketSeat: seat,
    probe: PROBE,
    probeName: 'Makera Wired Probe V2',
    mountTap: null,
    defaults: null,
    calibration: CALIBRATION,
    settings: SETTINGS,
    ...over,
  });
}

const MEASURED_SEAT = { value: -85.788, what: 'bracket seat' as const, measuredAt: '2026-11-09T17:00:00.000Z', probeRefZ: -76.063 };

describe('#1133 a bracket hold plans one top touch', () => {
  it('with a measured seat: one Z touch, no edge finds, and no tap at all', () => {
    const job = bracketJob();
    const attempt = attemptFor(job, MEASURED_SEAT);
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    const plan = attempt.plan;
    // The whole of the plan: the surface seek. No scans, no corner derivation, no mount tap.
    expect(plan.scans).toEqual([]);
    expect(plan.corner).toBeUndefined();
    expect(plan.mountTap).toBeNull();
    expect(registrationTouches({ ok: true, plan })).toBeLessThanOrEqual(2);
    // X and Y are the bracket's own — the plan says so instead of touching for them.
    expect(plan.bracketOrigin).not.toBeNull();
    expect(attempt.expected).toContain('XY from the bracket');
    // #1123 item 29 + #1133 — no scans means the sentence names none.
    expect(attempt.summary).toContain("touch the surface at the cut area's centre");
    expect(attempt.summary).not.toContain('then scan');
  });

  it('the Z1 states a head envelope with its provenance (a product constant, not a knob)', () => {
    const env = headEnvelopeOf(Z1);
    expect(env).not.toBeNull();
    expect(env!.radiusMm).toBe(28.5);
    expect(env!.source).toContain('Makera-Z1_Simplified_4Axis.step');
    expect(env!.source).toContain('b7df28bc');
  });

  it('with no seat: the seat seek point clears the stock and every fixture by the head envelope + 2 mm', () => {
    const job = bracketJob();
    const seek = seatSeekFor({ job, calibration: CALIBRATION, defaults: null, probe: PROBE });
    expect(seek.ok, JSON.stringify(seek)).toBe(true);
    if (!seek.ok) return;
    const point = seek.seek;
    const head = headEnvelopeOf(Z1)!.radiusMm;
    const clearance = head + 2;
    // The point is on the seat plane beside the bracket and in WORK coordinates; the stock is
    // 0..x × 0..y and every fixture box is stated the same way.
    const distance = (box: { min: [number, number]; max: [number, number] }): number => {
      const dx = Math.max(box.min[0] - point.workX, 0, point.workX - box.max[0]);
      const dy = Math.max(box.min[1] - point.workY, 0, point.workY - box.max[1]);
      return Math.hypot(dx, dy);
    };
    const stock = { min: [0, 0] as [number, number], max: [job.stock.length, job.stock.width] as [number, number] };
    expect(distance(stock), `stock clearance at work (${point.workX}, ${point.workY})`).toBeGreaterThanOrEqual(clearance);
    const sizes = bracketSettings(null);
    const stockSize = { x: job.stock.length, y: job.stock.width, z: job.stock.thickness };
    const obstacles = [
      ...clampObstacles(stockSize, clampPlacementsFor(job) ?? defaultClampPlacements(stockSize, sizes.settings), sizes.settings),
      ...bracketObstacles(stockSize, sizes.settings, job.sacrificial.under?.thickness ?? 0),
    ];
    for (const o of obstacles) {
      expect(distance(o), `${o.label} clearance at work (${point.workX}, ${point.workY})`).toBeGreaterThanOrEqual(clearance);
    }
    // Inside the machine's soft limits, and the touch is on the board the bracket seat sits on.
    const lim = CALIBRATION.softEndstop;
    expect(point.x).toBeGreaterThanOrEqual(lim.xMin);
    expect(point.y).toBeGreaterThanOrEqual(lim.yMin);
    expect(point.band.min).toBeGreaterThanOrEqual(lim.zMin);
  });

  // #1133 review — THE ACCEPTANCE CASE, in numbers. On the set B tray stock with the bench's
  // clamp, the maintainer's own probe point (0f: machine −175, −35 — work (15.89, 158.83), 32.8 mm
  // behind the blank's back edge) must be ACCEPTED by the rule, the chosen point must be at least
  // as close as it, and the old 7.5 mm-in-front point must be REJECTED.
  it('0f’s bench point is accepted, the chosen point is at least as close, and the old in-front point is rejected', () => {
    const job = bracketJob();
    const seek = seatSeekFor({ job, calibration: CALIBRATION, defaults: null, probe: PROBE });
    expect(seek.ok, JSON.stringify(seek)).toBe(true);
    if (!seek.ok) return;
    const head = headEnvelopeOf(Z1)!.radiusMm;
    const need = head + 2;
    const distance = (wx: number, wy: number): number => {
      const box: { min: [number, number]; max: [number, number] } = { min: [0, 0], max: [job.stock.length, job.stock.width] };
      return Math.hypot(Math.max(box.min[0] - wx, 0, wx - box.max[0]), Math.max(box.min[1] - wy, 0, wy - box.max[1]));
    };
    // 0f's point, in work coordinates under the bench's anchor: clear by 32.83 mm — inside the rule.
    const zeroF = { x: -175 - CALIBRATION.frame.anchor1[0], y: -35 - CALIBRATION.frame.anchor1[1] };
    expect(distance(zeroF.x, zeroF.y)).toBeGreaterThanOrEqual(need);
    // The chosen point is no farther from the blank than 0f's: with the height-filtered envelope the
    // app does not over-clear the way the 46 mm reading did.
    const chosen = seek.seek;
    expect(distance(chosen.workX, chosen.workY)).toBeLessThanOrEqual(distance(zeroF.x, zeroF.y) + 1e-9);
    expect(chosen.workY).toBeLessThanOrEqual(zeroF.y + 1e-9);
    // The old point — armWidth/2 (5 mm) in front of the blank at the arm's end — is REJECTED by the
    // same rule: the head would sit over the taller stock.
    const sizes = bracketSettings(null);
    const oldPoint = { x: sizes.settings.armLengthX + SETTINGS.tipRadiusMm + 5, y: -sizes.settings.armWidth / 2 };
    expect(distance(oldPoint.x, oldPoint.y)).toBeLessThan(need);
    // And the chosen point is the seat the plan would touch (machine coordinates land on the board).
    expect(chosen.x).toBeCloseTo(CALIBRATION.frame.anchor1[0] + chosen.workX, 6);
    expect(chosen.y).toBeCloseTo(CALIBRATION.frame.anchor1[1] + chosen.workY, 6);
  });

  it('the arm check is dropped with one plain line when the arm cannot host a head-clearing point', () => {
    const job = bracketJob();
    const seek = seatSeekFor({ job, calibration: CALIBRATION, defaults: null, probe: PROBE });
    expect(seek.ok).toBe(true);
    if (!seek.ok) return;
    expect(seek.seek.notes.join(' ')).toContain('the arm is too narrow for the head to touch it beside this stock');
  });
});

describe('#1179 B — a later setup’s check points are its OWN face’s (analyst, 2026-11-10)', () => {
  /** A serpentine fill: parallel G1 lines across x at `step`, at Z −depth. */
  const fillNc = (x0: number, x1: number, y0: number, y1: number, step: number, depth: number): string => {
    const lines = ['G90', 'G0 Z5', `G0 X${x0} Y${y0}`, `G1 Z${-depth} F100`];
    let y = y0;
    for (let i = 0; y <= y1 + 1e-9; i++, y += step) {
      lines.push(`G1 X${i % 2 === 0 ? x1 : x0} Y${Number(y.toFixed(3))} F300`);
    }
    lines.push('G0 Z5');
    return lines.join('\n');
  };

  /**
   * A two-setup package on the 160 × 126 blank: setup 1 faces the WHOLE top at depth 3 (0.5 mm
   * step-over under the 1 mm flat end, so every cell is a 3 mm floor) and is FINISHED; setup 2
   * cuts one band near the corner and has not run. The programs' own `setupIndex` is the seam.
   */
  function twoSetupJob(): EngraveJob {
    const job = bracketJob();
    return {
      ...job,
      package: {
        jobId: job.id,
        frozenAt: '2026-11-10T09:00:00.000Z',
        hash: 'pkg-1179-b',
        jobHash: 'job-1179-b',
        programs: [
          {
            setupIndex: 1,
            setupId: 'setup-1',
            toolKey: 'flat-1.0',
            nc: fillNc(0, 160, 0, 126, 0.5, 3),
            hash: 'finished-setup-1',
            frameNc: null,
            frameHash: null,
          },
          {
            setupIndex: 2,
            setupId: 'setup-2',
            toolKey: 'flat-1.0',
            nc: fillNc(20, 60, 20, 40, 0.5, 3),
            hash: 'setup-2-program',
            frameNc: null,
            frameHash: null,
          },
        ],
        setups: [],
        stockEntryId: null,
      },
    };
  }

  // The probe records its tip and body, so a 3 mm floor is a candidate at all (#1179 B: a floor
  // deeper than the tip's length is entered by the body, and an unrecorded one is never offered).
  const RECORDED_PROBE: ProbeSpec = { ...PROBE, tipLengthMm: 1, bodyDiameterMm: 4 };

  it('setup 1 reads its own finished facing pass as a known 3 mm floor', () => {
    const attempt = attemptFor(twoSetupJob(), MEASURED_SEAT, {
      cutBlank: true,
      finishedHashes: ['finished-setup-1'],
      setupIndex: 1,
      probe: RECORDED_PROBE,
    });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.surfaceChecksUnknown).toBeUndefined();
    expect(attempt.plan.surfaceChecks?.length).toBeGreaterThanOrEqual(2);
    for (const check of attempt.plan.surfaceChecks ?? []) expect(check.depthMm).toBeCloseTo(3, 6);
  });

  it('setup 2 does not take setup 1’s footprint as this face’s — its cuts are unknown here', () => {
    const attempt = attemptFor(twoSetupJob(), MEASURED_SEAT, {
      cutBlank: true,
      // Setup 1's program IS finished, but it is not setup 2's program: it must not become a floor.
      finishedHashes: ['finished-setup-1'],
      setupIndex: 2,
      probe: RECORDED_PROBE,
    });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    // The earlier setup's cuts are not recorded for this face, and the card says so.
    expect(attempt.plan.surfaceChecksUnknown).toBe(true);
    expect(attempt.plan.surfaceChecks?.length).toBeGreaterThanOrEqual(2);
    // No floor of setup 1's 3 mm depth is offered; every point is uncut top of THIS setup's view.
    for (const check of attempt.plan.surfaceChecks ?? []) expect(check.depthMm).toBe(0);
    // And the points are not kept out of setup 1's footprint: that footprint faces the other way.
    // Setup 1 covered the whole top, so every point lies inside it — if the un-mirrored footprint
    // had been taken as the exclusion, there would have been no point at all.
    const stock = attempt.plan.stock;
    for (const check of attempt.plan.surfaceChecks ?? []) {
      expect(check.x).toBeGreaterThan(stock.xMin);
      expect(check.x).toBeLessThan(stock.xMax);
      expect(check.y).toBeGreaterThan(stock.yMin);
      expect(check.y).toBeLessThan(stock.yMax);
    }
  });
});

// #1201 — NO TRUSTED SEAT IS NOT A BLOCKER. The top is measured ON THE BLANK, as Makera does:
// two touches inside the stock footprint (the machining area's path origin, inset, and the area's
// centre), a guarded seek from the machine's clearance that accepts contact above the bed's known
// floor + a margin. The seat is a BED-SETUP datum; a job plan never taps it.
describe('#1201 a bracket hold with no trusted seat measures the top on the blank', () => {
  it('with NO seat: a guarded seek, two points on the stock, and no seat tap', () => {
    const job = bracketJob();
    const attempt = attemptFor(job, null);
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    const plan = attempt.plan;
    // The guarded contract: no expected top, no mount tap, no scans.
    expect(plan.guarded, 'the plan is not a guarded top seek').toBeDefined();
    expect(plan.guarded!.seatIgnored).toBe('absent');
    expect(plan.mountTap).toBeNull();
    expect(plan.scans).toEqual([]);
    // TWO touches at depth 0, both strictly inside the stock footprint.
    const checks = plan.surfaceChecks ?? [];
    expect(checks).toHaveLength(2);
    for (const c of checks) {
      expect(c.depthMm).toBe(0);
      expect(c.x).toBeGreaterThan(0);
      expect(c.x).toBeLessThan(job.stock.length);
      expect(c.y).toBeGreaterThan(0);
      expect(c.y).toBeLessThan(job.stock.width);
    }
    // The first is the machining area's path origin, inset by the edge margin + the tip; the
    // second is the area's centre. The area is the tray shape's rectangle: x 40..140, y 18..108.
    const inset = Math.max(1, SETTINGS.tipRadiusMm + job.edgeMargin);
    expect(checks[0]!.x).toBeCloseTo(40 + inset, 3);
    expect(checks[0]!.y).toBeCloseTo(18 + inset, 3);
    expect(checks[1]!.x).toBeCloseTo(90, 3);
    expect(checks[1]!.y).toBeCloseTo(63, 3);
    // The guarded band: contact is accepted above the bed's known floor + margin, up to the
    // machine's clearance less the park height.
    const floor = jobMachine(job, CALIBRATION).envelope.z.min;
    expect(plan.guarded!.floorMachineZ).toBeCloseTo(floor, 3);
    expect(plan.seek.band.min).toBeCloseTo(floor + plan.guarded!.marginMm, 3);
    expect(plan.seek.band.max).toBeCloseTo(plan.seek.fromMachineZ - SETTINGS.parkAboveSurfaceMm, 3);
  });

  // #1207 — the guarded seek's floor margin is a REGISTRY value, read at the call site: a location
  // that raises it moves the band's floor. Before the registry change it was the literal `1`, and
  // this test fails against it. (The check points' edge inset is D's shared `topTouchEdgeMarginMm`,
  // not a second default here.)
  it('reads the floor margin from the shop defaults (#1207)', () => {
    const job = bracketJob();
    const tuned: ShopDefaults = {
      ...LOCATION.defaults,
      'registration.guardedFloorMarginMm': { ...LOCATION.defaults['registration.guardedFloorMarginMm']!, value: 2.5 },
    };
    const attempt = attemptFor(job, null, { defaults: tuned });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    const plan = attempt.plan;
    const floor = jobMachine(job, CALIBRATION).envelope.z.min;
    expect(plan.guarded!.marginMm).toBeCloseTo(2.5, 3);
    expect(plan.seek.band.min).toBeCloseTo(floor + 2.5, 3);
  });

  it('with a LEGACY seat: still guarded, and the seat is stated as not used', () => {
    const job = bracketJob();
    const attempt = attemptFor(job, { value: -85.788, what: 'bracket seat', measuredAt: '2026-11-01T00:00:00.000Z', probeRefZ: null });
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.guarded).toBeDefined();
    expect(attempt.plan.guarded!.seatIgnored).toBe('legacy');
    // The legacy reading can only LOWER the floor bound; it never certifies a top.
    expect(attempt.plan.guarded!.floorMachineZ).toBeCloseTo(-85.788, 3);
    expect(attempt.summary).toContain('TOP OF THE BLANK');
  });

  it('with a trusted seat: unchanged — the tight band, one touch, no guarded seek', () => {
    const attempt = attemptFor(bracketJob(), MEASURED_SEAT);
    expect(attempt.kind, JSON.stringify(attempt)).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.guarded).toBeUndefined();
    expect(attempt.plan.surfaceChecks).toBeUndefined();
    expect(attempt.plan.seek.band.max).toBeCloseTo(MEASURED_SEAT.value + 25 + SETTINGS.surfaceToleranceMm, 3);
  });
});

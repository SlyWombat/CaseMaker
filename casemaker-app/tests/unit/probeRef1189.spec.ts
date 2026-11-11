// #1189 — A PROBED DATUM IS A RAW MACHINE Z: refit the probe and every expected surface shifts by
// the seating difference. The bench (2026-11-10): M491 read the probe at −9.094; the bracket seat
// on file was measured with the probe seated 1.145 mm further in, so the first check read 1.145 mm
// above the expected top and stopped a good blank.
//
// Plus the two #1179 B amendments from the same bench run (comment 6779883065): a check reading
// ABOVE the band is a reading (chips), not a stop unless it is clamp-sized; and the first check
// points are chosen away from the stock's edges and corners.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { ShopDefaultsSchema } from '@/platform/defaultsClient';
import type { ConsoleSendResult } from '@/platform/machineConsole';
import { MachineRecordSchema } from '@/platform/locationClient';
import { PROBE_OPEN_REPLY, sentReply as reply } from './helpers/registrationFixtures';
import {
  planRegistration,
  registrationSettings,
  runRegistration,
  type PlanInput,
  type RegistrationPlan,
} from '@/engine/cnc/registration';
import { cutterZ0 } from '@/engine/cnc/registration/outcome';
import { correctedPlanForProbe, shiftedRecordedTopMachineZ } from '@/engine/cnc/registration/probeShift';
import { cutBlankCandidates } from '@/engine/cnc/registration/cutBlank';
import { bracketSeatDatumFor } from '@/engine/cnc/registration/mountContext';
import { bracketExpectedSurface } from '@/engine/cnc/mounts/bracket';
import { registrationFor } from '@/engine/cnc/setups';
import { planRegistrationAttempt } from '@/components/panels/registrationAttempt';
import { defaultEngraveJob } from '@/engine/cnc/engrave/defaults';
import type { ProbeSpec } from '@/engine/cnc/registration/plan';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as { defaults: unknown };
const { settings: S } = registrationSettings(ShopDefaultsSchema.parse(DOC.defaults));

/** The bench's numbers, 2026-11-10. */
const SEAT = -85.788;
const THICKNESS = 25;
const TOP = -60.788; // seat + stock
const REF_THEN = -9.094; // the seat was measured at this M491
const REFIT = 1.145; // the probe now sits this much further out
const CUTTER_REF = -12.5; // the cutter's own M491, unchanged by the probe's seating

function bracketPlan(
  input: Partial<PlanInput> & { surfaceChecks?: { x: number; y: number; depthMm: number }[] } = {},
): RegistrationPlan {
  const { surfaceChecks, ...planInput } = input;
  const planned = planRegistration(
    {
      stock: { xMin: 0, yMin: 0, xMax: 100, yMax: 60, cornerRadius: 0 },
      mount: 'bracket',
      expectedSurface: { machineZ: TOP, from: 'the seat + the stock' },
      seekFromMachineZ: -20,
      stockThicknessMm: THICKNESS,
      bracketOrigin: { x: -200, y: -200, from: 'anchor 1', offsetMeasured: true },
      mountObstacles: [],
      mountTap: null,
      probe: null,
      // #1199 field 7 — the hold's placement figures the planner now requires.
      holdUncertainty: { xMm: 0, yMm: 0 },
      ...planInput,
    },
    S,
  );
  if (!planned.ok) throw new Error(planned.reason);
  // `planRegistration` builds the plan; the attempt attaches the checks (registrationAttempt).
  return surfaceChecks === undefined ? planned.plan : { ...planned.plan, surfaceChecks };
}

/** A fake Z1: `M491` answers `refZ`; the surface answers `surfaceAt` (machine XY → Z or null). */
function fakeConsole(refZ: number, surfaceAt: (x: number, y: number) => number | null) {
  let mode: 'G90' | 'G91' = 'G90';
  const pos = { x: -200, y: -200, z: -20 };
  const lines: string[] = [];
  function touch(): ConsoleSendResult {
    const travel = /^G38\.3 Z-([\d.]+)/.exec(lines.at(-1)!);
    if (travel === null) throw new Error('not a probe line');
    const target = Math.round((pos.z - Number(travel[1])) * 1000) / 1000;
    const hit = surfaceAt(pos.x, pos.y);
    if (hit !== null && hit >= target && hit <= pos.z) {
      pos.z = hit;
      return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${hit.toFixed(3)}:1]\nok`);
    }
    pos.z = target;
    return reply(`[PRB:${pos.x.toFixed(3)},${pos.y.toFixed(3)},${target.toFixed(3)}:0]\nok`);
  }
  const console = {
    async send(line: string): Promise<ConsoleSendResult> {
      lines.push(line);
      if (line === '?') return reply('<Idle|MPos:0,0,0>');
      if (line === '$H') return (pos.x = -1), (pos.y = -1), (pos.z = -1), reply('ok');
      if (line === 'G54' || line === 'G92.1' || line === 'M831' || line === 'M832') return reply('ok');
      if (line === 'M119') return reply(PROBE_OPEN_REPLY);
      if (line === 'M491') return reply(`[PRB:-9,-12,${refZ}:1]\nok\n[PRB:-9,-12,${refZ}:1]\nDone ATC`);
      if (line === 'G90' || line === 'G91') return (mode = line), reply('ok');
      let m = /^G53 G0 Z(-?[\d.]+)$/.exec(line);
      if (m) return (pos.z = Number(m[1])), reply('ok');
      m = /^G53 G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) return (pos.x = Number(m[1])), (pos.y = Number(m[2])), reply('ok');
      m = /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(line);
      if (m) {
        if (mode === 'G91') (pos.x += Number(m[1])), (pos.y += Number(m[2]));
        else (pos.x = Number(m[1])), (pos.y = Number(m[2]));
        return reply('ok');
      }
      m = /^G0 Z(-?[\d.]+)$/.exec(line);
      if (m && mode === 'G91') return (pos.z += Number(m[1])), reply('ok');
      if (line.startsWith('G38.3 Z-')) return touch();
      return reply('ok');
    },
  };
  return { console, lines };
}

const yes = async () => true;

function deps(console: { send(line: string): Promise<ConsoleSendResult> }) {
  return {
    console,
    // #1199 — the live machine clearance every executor now requires; this file's plans seek from −20.
    liveClearanceZ: -20,
    operator: async (step: { kind: string }) => (step.kind === 'fit-probe' || step.kind === 'confirm-mount' ? true : yes()),
  };
}

describe('#1189 the probe seating shift', () => {
  it('corrects the expected top by today’s M491 less the datum’s, and says so', () => {
    const plan = bracketPlan({ probeRefZ: REF_THEN, probeRefLabel: 'the seat' });
    const corrected = correctedPlanForProbe(plan, REF_THEN + REFIT);
    expect(corrected.shiftMm).toBeCloseTo(REFIT, 3);
    expect(corrected.plan.seek.band.min).toBeCloseTo(plan.seek.band.min + REFIT, 3);
    expect(corrected.plan.seek.band.max).toBeCloseTo(plan.seek.band.max + REFIT, 3);
    expect(corrected.notes.join(' ')).toContain('1.145 mm further out');
    expect(corrected.notes.join(' ')).toContain('the seat');
    expect(corrected.notes.join(' ')).toContain('expected top to -59.643');
    // Pure: the approved plan keeps its numbers.
    expect(plan.seek.band.max).toBeCloseTo(TOP + S.surfaceToleranceMm, 3);
  });

  it('leaves a plan with no reference exactly as approved', () => {
    const plan = bracketPlan();
    const corrected = correctedPlanForProbe(plan, REF_THEN + REFIT);
    expect(corrected.shiftMm).toBeNull();
    expect(corrected.notes).toEqual([]);
    expect(corrected.plan).toBe(plan);
  });

  it('a refit run measures the same origin as the first seating — the cutter Z0 is unchanged', async () => {
    const surfaceZ = (refZ: number) => TOP + (refZ - REF_THEN);
    const first = fakeConsole(REF_THEN, () => surfaceZ(REF_THEN));
    const runFirst = await runRegistration(
      bracketPlan({ probeRefZ: REF_THEN, probeRefLabel: 'the seat' }),
      deps(first.console),
    );
    expect(runFirst.ok).toBe(true);
    if (!runFirst.ok) return;
    const after = fakeConsole(REF_THEN + REFIT, () => surfaceZ(REF_THEN + REFIT));
    const plan = bracketPlan({ probeRefZ: REF_THEN, probeRefLabel: 'the seat' });
    const runAfter = await runRegistration(plan, deps(after.console));
    expect(runAfter.ok).toBe(true);
    if (!runAfter.ok) return;
    // The raw readings differ by the refit; the origin the cutter will cut to does not.
    expect(runAfter.outcome.surfaceZ - runFirst.outcome.surfaceZ).toBeCloseTo(REFIT, 3);
    expect(cutterZ0(runAfter.outcome, CUTTER_REF)).toBeCloseTo(cutterZ0(runFirst.outcome, CUTTER_REF), 3);
    expect(runAfter.outcome.notes.join(' ')).toContain('1.145 mm further out');
  });

  it('a fresh job in one seating has a byte-identical transcript to before the key existed', async () => {
    const fake = fakeConsole(REF_THEN, () => TOP);
    const withKey = await runRegistration(bracketPlan({ probeRefZ: REF_THEN, probeRefLabel: 'the seat' }), deps(fake.console));
    const fake2 = fakeConsole(REF_THEN, () => TOP);
    const withoutKey = await runRegistration(bracketPlan(), deps(fake2.console));
    expect(withKey.ok && withoutKey.ok).toBe(true);
    if (!withKey.ok || !withoutKey.ok) return;
    expect(withKey.transcript.map((t) => t.line)).toEqual(withoutKey.transcript.map((t) => t.line));
  });

  it('a recorded top without a reference is not trusted across a fitting', () => {
    expect(shiftedRecordedTopMachineZ(-60.487, null, REF_THEN + REFIT)).toBeNull();
    expect(shiftedRecordedTopMachineZ(-60.487, REF_THEN, REF_THEN + REFIT)).toBeCloseTo(-59.342, 3);
  });

  it('the datum and the expected surface carry the reference through the bed profile', () => {
    const doc = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
      machines: Record<string, unknown>[];
    };
    const raw = JSON.parse(JSON.stringify(doc.machines[0]!)) as {
      activeBedProfileId: string;
      bedProfiles: { id: string; datums: Record<string, unknown> }[];
    };
    const profile = raw.bedProfiles.find((p) => p.id === raw.activeBedProfileId)!;
    // The seat, as the bench measured it on 2026-11-09 — with the M491 it was measured at.
    profile.datums['surfaceTopZ'] = null;
    profile.datums['bracketSeatZ'] = {
      value: SEAT,
      measuredAt: '2026-11-09T00:00:00.000Z',
      by: 'fx-probe-1',
      at: [3.5, 3.5],
      restsOnStock: true,
      probeRefZ: REF_THEN,
    };
    const machine = MachineRecordSchema.parse(raw);
    const seat = bracketSeatDatumFor(machine);
    expect(seat?.probeRefZ).toBe(REF_THEN);
    const expected = bracketExpectedSurface(null, THICKNESS, 0, seat);
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(expected.expectedSurface.probeRefZ).toBe(REF_THEN);
  });

  it('the vise’s surface-top and jaw-top datums are corrected by their own references', () => {
    const plan = registrationFor(
      {
        index: 1,
        faceUp: 'top',
        rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
        stockBefore: { bounds: { min: [0, 0, 0], max: [100, 60, 25] }, cuts: [] },
      } as never,
      { kind: 'vise' } as never,
      {
        seekFromMachineZ: -20,
        cornerRadius: 0,
        // The stock stands 2 mm proud of the jaws: the seek's floor is the jaw top (its own ref).
        mountDatum: { jawTopZ: TOP - 2, measuredAt: '2026-11-09T00:00:00.000Z', by: 'fx-probe-1', probeRefZ: REF_THEN },
        surfaceTopZ: { value: TOP, probeRefZ: REF_THEN + 0.3 },
        probe: null,
        mountTap: null,
        // #1199 field 7 — the hold's placement figures.
        holdUncertainty: { xMm: 0, yMm: 0 },
        cutCentre: { x: 50, y: 30 },
      },
      S,
    ).plan;
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.ok).toBe(true);
    // The surface top sets the expected top (its reference); the jaw top is the floor's datum.
    expect(plan.plan.probeRefZ).toBeCloseTo(REF_THEN + 0.3, 3);
    expect(plan.plan.floorProbeRefZ).toBe(REF_THEN);
    const corrected = correctedPlanForProbe(plan.plan, REF_THEN + REFIT);
    expect(corrected.plan.seek.band.max).toBeCloseTo(plan.plan.seek.band.max + REFIT - 0.3, 3);
    expect(corrected.plan.mountDatum?.jawTopZ).toBeCloseTo(TOP - 2 + REFIT, 3);
  });
});

describe('#1189 the Register card and a legacy datum', () => {
  const PROBE: ProbeSpec = {
    id: 'fx-probe-1',
    variant: 'wired-touch',
    instrument: 'z-only',
    tip: { diameterMm: 2, rimOffsetMm: 0.7, rimOffsetUncertaintyMm: 0.25 },
  };
  const doc = JSON.parse(readFileSync(join(HERE, 'fixtures', 'location-doc.json'), 'utf8')) as {
    machines: { calibration: unknown }[];
  };
  const base = defaultEngraveJob();
  const job = {
    ...base,
    stock: { ...base.stock, length: 160, width: 126, thickness: 25 },
    labels: [],
    shapes: [],
    workholding: {
      kind: 'bracket' as const,
      bracket: { anchor: 1 as const, variant: 'thin', clamps: [{ edge: 'back', at: 63 }], source: 'default' },
    },
  };
  const setup = {
    index: 0,
    rotation: [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ],
    stockBefore: { bounds: { min: [0, 0, -25], max: [160, 126, 0] }, cuts: [] },
  } as never;
  const args = (
    seat: { value: number; what: 'bracket seat'; measuredAt: string; probeRefZ?: number | null; at?: [number, number] | null } | null,
  ) => ({
    job: job as never,
    setup,
    mount: { kind: 'bracket' as const, board: true },
    mountDatum: null,
    surfaceTopZ: null,
    bracketSeat: seat,
    probe: PROBE,
    mountTap: null,
    defaults: null,
    calibration: doc.machines[0]!.calibration as never,
    settings: S,
  });

  it('#1201 — a seat measured before the probe was last fitted is NOT used: the top is measured on the blank', () => {
    const attempt = planRegistrationAttempt(
      args({ value: SEAT, what: 'bracket seat', measuredAt: '2026-11-09T00:00:00.000Z', at: [-175, -35] }),
    );
    // #1201 supersedes #1189 field 3: the legacy seat is a bed-setup datum to re-measure later,
    // never a job-time press. The card plans the guarded top seek on the stock.
    expect(attempt.kind).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.guarded?.seatIgnored).toBe('legacy');
    expect(attempt.plan.mountTap).toBeNull();
    expect(attempt.plan.seatRemeasure).toBeUndefined();
    expect(attempt.summary).toContain('TOP OF THE BLANK');
    expect(attempt.plan.notes.join(' ')).toContain('measured before the probe’s last fitting and is not used');
    // After the seat is re-measured at BED SETUP (the reference written), the same card plans the
    // ordinary trusted-seat registration.
    const fresh = planRegistrationAttempt(
      args({ value: SEAT, what: 'bracket seat', measuredAt: '2026-11-10T00:00:00.000Z', probeRefZ: REF_THEN, at: [-175, -35] }),
    );
    expect(fresh.kind).toBe('plan');
    if (fresh.kind !== 'plan') return;
    expect(fresh.plan.probeRefZ).toBe(REF_THEN);
    expect(fresh.plan.guarded).toBeUndefined();
  });

  it('#1201 — with no seat at all the plan is the same guarded top seek, and no tap', () => {
    const attempt = planRegistrationAttempt(args(null));
    expect(attempt.kind).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.guarded?.seatIgnored).toBe('absent');
    expect(attempt.plan.mountTap).toBeNull();
    expect(attempt.plan.surfaceChecks).toHaveLength(2);
  });

  it('a jaw top measured before the probe was last fitted no longer asks — the top is measured on the blank', () => {
    // #1199 field 7 (e) — no dead end: an untrusted (pre-refit) jaw datum falls into the guarded
    // top-touch plan; nothing taps the jaw and nothing is asked.
    const attempt = planRegistrationAttempt({
      ...args(null),
      mount: { kind: 'vise' as const },
      mountDatum: { jawTopZ: TOP - 2, measuredAt: '2026-11-09T00:00:00.000Z', by: 'fx-probe-1' },
      mountTap: { x: -150, y: -160, fromMachineZ: -20, label: 'the vise fixed-jaw top' },
    });
    expect(attempt.kind).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.guarded).toBeDefined();
    expect(attempt.plan.mountTap).toBeNull();
    expect(attempt.plan.surfaceChecks).toHaveLength(2);
  });

  it('a trusted-datum vise job plans with NO mountTap — the datum is used as it is', () => {
    // #1199 field 7 (e) field 1: planners emit no job mountTap. The frame is present (the tap point
    // is the frame's presence signal here); the plan itself must carry none.
    const attempt = planRegistrationAttempt({
      ...args(null),
      mount: { kind: 'vise' as const },
      mountDatum: { jawTopZ: -56.82, measuredAt: '2026-11-09T00:00:00.000Z', by: 'fx-probe-1', probeRefZ: -80 },
      mountTap: { x: -150, y: -160, fromMachineZ: -20, label: 'the vise fixed-jaw top' },
    });
    expect(attempt.kind).toBe('plan');
    if (attempt.kind !== 'plan') return;
    expect(attempt.plan.mountTap).toBeNull();
  });

  // #1199 field 7 (e) — the guarded top touch's inset: the MAX of the job's edge margin and the
  // shared probe/hold inset (a floor, not a sum), and the HOLD figure is the JOB'S OWN MOUNT's —
  // the analyst's B ruling runs this path for vise jobs, so a hard-coded bracket fit is wrong.
  const guardedVise = (over: { edgeMargin?: number; alongJawsMm?: number } = {}) => {
    const attempt = planRegistrationAttempt({
      ...args(null),
      mount: { kind: 'vise' as const },
      mountTap: { x: -150, y: -160, fromMachineZ: -20, label: 'the vise fixed-jaw top' },
      job: { ...job, edgeMargin: over.edgeMargin ?? 0 } as never,
      ...(over.alongJawsMm === undefined ? {} : { settings: { ...S, visePlacementAlongJawsMm: over.alongJawsMm } }),
    });
    expect(attempt.kind).toBe('plan');
    return attempt.kind === 'plan' ? attempt.plan.surfaceChecks![0]! : { x: NaN, y: NaN, depthMm: 0 };
  };

  it('the guarded inset is the MAX of the job’s edge margin and the hold’s — never their sum', () => {
    const tight = guardedVise({ edgeMargin: 0 });
    const wide = guardedVise({ edgeMargin: 12 });
    // The vise's across-jaws margin is 3 (the registry floor): the 12 mm margin replaces it.
    expect(wide.x - tight.x).toBeCloseTo(9, 3);
  });

  it('the guarded inset uses the VISE’s placement keys, not the bracket’s fit', () => {
    const a = guardedVise({ alongJawsMm: 0 });
    const b = guardedVise({ alongJawsMm: 10 });
    // margins.y = max(3, tip 0.7 + the unit's stated lateral uncertainty 0 + along): 3 at 0,
    // 10.7 at 10.
    expect(b.y - a.y).toBeCloseTo(7.7, 3);
  });

  it('a mounted vise whose hold figure is unstated REFUSES the guarded plan', () => {
    const attempt = planRegistrationAttempt({
      ...args(null),
      mount: { kind: 'vise' as const },
      mountTap: { x: -150, y: -160, fromMachineZ: -20, label: 'the vise fixed-jaw top' },
      settings: { ...S, visePlacementAlongJawsMm: undefined },
    });
    expect(attempt.kind).toBe('refused');
    if (attempt.kind === 'refused') expect(attempt.reason).toContain('placement uncertainty is not stated');
  });
});

describe('#1179 amendment — above-band readings at a check point', () => {
  const checks = [
    { x: 20, y: 20, depthMm: 0 },
    { x: 80, y: 20, depthMm: 0 },
    { x: 50, y: 45, depthMm: 0 },
  ];
  /** A surface that answers each check point differently; machine XY = origin (−200) + work XY. */
  const surfaceFrom = (zs: (number | null)[]) => (x: number, y: number) => {
    const wx = Math.round((x + 200) * 1000) / 1000;
    const wy = Math.round((y + 200) * 1000) / 1000;
    const i = checks.findIndex((c) => Math.abs(c.x - wx) < 0.6 && Math.abs(c.y - wy) < 0.6);
    return i === -1 ? null : zs[i]!;
  };

  it('a check above the band is a READING: the pair still proves the top and the high one is listed', async () => {
    // The first check +1.1 above the band's ceiling (the bench's chip pile); the other two agree.
    const fake = fakeConsole(REF_THEN, surfaceFrom([TOP + S.surfaceToleranceMm + 1.1, TOP, TOP]));
    const result = await runRegistration(bracketPlan({ surfaceChecks: checks }), deps(fake.console));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.surfaceZ).toBeCloseTo(TOP, 3);
    const first = result.outcome.surfaceChecks?.[0];
    expect(first?.aboveBandMm).toBeCloseTo(1.1, 3);
    expect(result.outcome.notes.join(' ')).toContain('above the expected top');
    expect(result.outcome.notes.join(' ')).not.toContain('could not be proved');
  });

  it('all checks above the band stop with “clear the top and register again”', async () => {
    const fake = fakeConsole(REF_THEN, surfaceFrom([TOP + S.surfaceToleranceMm + 1, TOP + S.surfaceToleranceMm + 1.2, TOP + S.surfaceToleranceMm + 0.9]));
    const result = await runRegistration(bracketPlan({ surfaceChecks: checks }), deps(fake.console));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('something is lying on the blank at');
    expect(result.reason).toContain('clear the top and register again');
  });

  it('an obstruction beyond the stated limit still stops the run', async () => {
    // 8 mm above the band is a clamp, not chips (the amendment's own case).
    const fake = fakeConsole(REF_THEN, surfaceFrom([TOP + S.surfaceToleranceMm + 8, TOP, TOP]));
    const result = await runRegistration(bracketPlan({ surfaceChecks: checks }), deps(fake.console));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('outside the expected');
  });

  it('the first three candidates are inset from the edges and not the three corners', () => {
    const raster = { xMin: 0, yMin: 0, xMax: 100, yMax: 60, pitchMm: 1, nx: 100, ny: 60 };
    const { points } = cutBlankCandidates({ shrinkMm: 3, holdUncertainty: { xMm: 0, yMm: 0 },
      raster,
      programs: [],
      probe: { tipRadiusMm: 0.7, tipLengthMm: null, bodyDiameterMm: null },
      fallbackRadiusMm: 1,
      obstacles: [],
      earlierCutsUnknown: true,
    });
    expect(points.length).toBeGreaterThanOrEqual(3);
    for (const p of points.slice(0, 3)) {
      expect(Math.min(p.x - 0, 100 - p.x, p.y - 0, 60 - p.y)).toBeGreaterThanOrEqual(10 - 1e-9);
    }
    const corners = points.slice(0, 3).filter(
      (p) => Math.min(p.x, 100 - p.x) <= 15 && Math.min(p.y, 60 - p.y) <= 15,
    );
    expect(corners.length).toBeLessThan(3);
  });
});

// #1201 — THE EXECUTOR'S GUARDED TOP SEEK. No expected surface: the reading is the top, proved by
// two agreeing touches above the bed's floor; #1166's derived-top question is never asked.
describe('#1201 a guarded top seek in the executor', () => {
  const checks = [
    { x: 20, y: 20, depthMm: 0 },
    { x: 50, y: 30, depthMm: 0 },
  ];
  /** Machine XY = the bracket origin (−200) + work XY. */
  const at = (x: number, y: number, wx: number, wy: number): boolean =>
    Math.abs(x - (-200 + wx)) < 0.6 && Math.abs(y - (-200 + wy)) < 0.6;
  const agreeing = (x: number, y: number): number | null => {
    if (at(x, y, 20, 20)) return TOP;
    if (at(x, y, 50, 30)) return TOP - 0.03;
    return null;
  };
  const guarded = () =>
    bracketPlan({
      guarded: { floorMachineZ: SEAT, marginMm: 1, seatIgnored: 'absent' },
      surfaceChecks: checks,
      seekFromMachineZ: -3,
    });

  it('two agreeing touches above the floor are the top, and the derived-top question is never asked', async () => {
    const fake = fakeConsole(REF_THEN, agreeing);
    const askTop = vi.fn();
    const result = await runRegistration(guarded(), {
      ...deps(fake.console),
      hasFinishedPrograms: true,
      askTop,
    });
    expect(result.ok, result.ok ? '' : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.surfaceZ).toBeCloseTo(TOP, 3);
    // #1201 — the guarded plan has no expected surface, so #1166 must not offer a derived top.
    expect(askTop).not.toHaveBeenCalled();
    expect(result.outcome.notes.join(' ')).toContain('the top on the blank was proved');
    expect(result.outcome.notes.join(' ')).not.toContain('cut blank');
  });

  it('two touches that do not agree stop with the blank sentence, never a derived top', async () => {
    const disagreeing = (x: number, y: number): number | null => {
      if (at(x, y, 20, 20)) return TOP;
      if (at(x, y, 50, 30)) return TOP + 1;
      return null;
    };
    const fake = fakeConsole(REF_THEN, disagreeing);
    const result = await runRegistration(guarded(), deps(fake.console));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('the top on the blank could not be proved');
    expect(result.reason).toContain('above the bed’s floor');
  });
});

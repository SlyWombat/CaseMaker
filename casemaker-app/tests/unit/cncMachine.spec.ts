// The machine profile (#184, decision 25). The numbers are READINGS of Makera's database
// row and the shipped firmware config, not measurements; the tests pin them so a change is
// deliberate, and pin the one internal consistency check available without the machine.

import { describe, it, expect } from 'vitest';
import { jobMachine } from '@/engine/cnc/calibration';
import {
  Z1,
  MACHINES,
  MILL_MODELS,
  CARVERA,
  CARVERA_AIR,
  MACHINE_FRAME_UNREAD,
  ALL_MACHINES,
  PRINTER_PROFILES,
  ASSUMED_NOZZLE,
  clampToMachine,
  insideEnvelope,
  machineFrameProblem,
  machineFrameProblemById,
  machineSchema,
  millModelById,
  millModelSchema,
  millProfileSchema,
  printerProfileSchema,
  CLAMP_REFUSE_FRACTION_FALLBACK,
  type Machine,
} from '@/engine/cnc/machine';

describe('the Z1 profile', () => {
  it('is one of the framed mills — the Z1 and the Carvera Air carry a frame (#773)', () => {
    // #183 scoped the file to the Z1; #773 adds the Carvera Air (framed) and the Carvera (a row
    // with no frame, deliberately NOT in `MACHINES`). What a job may be written for is exactly
    // the framed pair: no id lookup here can hand back a machine whose positions are unknown.
    expect(Object.keys(MACHINES)).toEqual(['Z1', 'CA1']);
  });

  it('carries the database row: 200 x 200 x 100, 1200 mm/min, 13 000 RPM, no ATC', () => {
    const e = Z1.envelope;
    expect(e.x.max - e.x.min).toBe(200);
    expect(e.y.max - e.y.min).toBe(200);
    expect(e.z.max - e.z.min).toBe(100);
    expect(Z1.maxCutFeed).toBe(1200);
    expect(Z1.maxRpm).toBe(13000);
    expect(Z1.hasATC).toBe(false);
    expect(Z1.toolSlots).toBe(0);
  });

  it('machine coordinates run NEGATIVE: the Z1 homes to max and loads 0 there', () => {
    expect(Z1.envelope.x).toEqual({ min: -200, max: 0 });
    expect(Z1.envelope.z).toEqual({ min: -100, max: 0 });
  });

  it('has NO rapid ceiling: a rapid carries no F and a guessed field is worse than none', () => {
    expect('maxRapid' in Z1).toBe(false);
    expect('maxSeek' in Z1).toBe(false);
  });

  it('carries the cycle estimate’s rapid model as SOURCED data, not as a ceiling (#281)', () => {
    // The estimate needs a rate to time rapids at; the machine must not gain a `maxRapid` to give it
    // one. So the numbers live in `rapidEstimate` — same shape as every other sourced group, and
    // deliberately NOT named after a limit, because nothing here clamps a move.
    expect(Z1.rapidEstimate).toMatchObject({
      xyMmPerMin: 1200,
      zMmPerMin: 600,
      accelMmPerS2: 150,
      // The decided sentence (#281, review of 62fa025): both halves of the evidence, and neither of
      // them claiming to be a measurement of the machine.
      source: 'config read 2026-10-07 + stopwatch 2026-10-08',
    });
    // Z alone is slower than X/Y: the config's `gamma_max_rate` is half `alpha_max_rate`.
    expect(Z1.rapidEstimate.zMmPerMin).toBeLessThan(Z1.rapidEstimate.xyMmPerMin);
    // Values, not ceilings: `maxCutFeed` is the only number that bounds a move.
    for (const n of [Z1.rapidEstimate.xyMmPerMin, Z1.rapidEstimate.zMmPerMin, Z1.rapidEstimate.accelMmPerS2]) {
      expect(n).toBeGreaterThan(0);
    }
  });

  it('states what it does not have as FLAGS, not silence', () => {
    expect(Z1.capabilities.laser).toBe(false);
    expect(Z1.capabilities.rotary).toBe(true);
    // #283 — the two accessory flags say which surface our post drives, and on a Z1 that surface
    // is the vacuum: `M331`/`M332` were observed working from our own console on 2026-10-12. `air`
    // is false because the machine ANSWERS `M7`/`M9` and blows nothing — it is not an absence of
    // the capability, it is the observation that the word does nothing (the blowing mode is the
    // family's `M331.1`, which this app does not drive).
    expect(Z1.capabilities.vacuum).toBe(true);
    expect(Z1.capabilities.air).toBe(false);
    // #564 — the antistatic (static-removal) device is mounted: `M331.4`/`M332.4` were confirmed
    // live at the bench, so the flag is a fact, not a guess.
    expect(Z1.capabilities.antistatic).toBe(true);
  });

  it('dialect flags match the firmware and the vendor FreeCAD definition', () => {
    expect(Z1.dialect).toEqual({ acceptsArcs: true, cannedCycles: false, grblMode: true, axisPrecision: 3, feedPrecision: 2 });
  });

  it('the change position is NOT the clearance position — they coincide only on a stock machine (#279)', () => {
    // ATCHandler parks at anchor1 + toolrack_offset + (132, 0); the config separately lists
    // clearance_x/y = (-11.6, -14.6). Under the shipped defaults the two land 0.2 mm apart, and an
    // earlier version of this test read that as a cross-check. It is not one: the agreement is a
    // COINCIDENCE. `clearance` and `anchor1` are the two OPPOSITE CORNERS of the work area
    // (`fill_Autoclean_scripts` sweeps between them), so nothing requires the arithmetic to reach
    // the same place. `clearance_x` is hardware-confirmed (C1 watched `G28` stop at X -11.600) —
    // that confirms clearance, not this sum.
    //
    // On the bench machine, whose anchor1 has moved 1.51 mm on X, the two DIVERGE by 1.5/1.8 mm,
    // which is what a calibration record is for (#279; the drift assertions live in
    // cncCalibration.spec.ts). The two are separate numbers that happen to sit close together here.
    expect(Z1.toolChange.changePosition[0]).toBeCloseTo(-11.6, 1);
    expect(Z1.toolChange.changePosition[1]).toBeCloseTo(-14.6, 1);
    expect(Z1.toolChange.changePosition).not.toEqual(Z1.toolChange.clearanceXY);
  });

  it('clearance Z is MEASURED, not read from the shipped config (#208 B6, #276)', () => {
    // `coordinate.clearance_z` reads -3.0 on the machine; this profile carried -1.0 from a
    // reading of configZ1.default, and the group was miscredited to `atc.*` as well. Two
    // independent confirmations: C1 sent `G28` and the head stopped at machine Z -3.000, and
    // -1.0 is also the post-homing rest Z (B4) — a clearance of -1.0 would have meant `G28`
    // did not move Z at all, and it moved 2 mm.
    expect(Z1.toolChange.clearanceZ).toBe(-3.0);
    expect(Z1.toolChange.clearanceXY).toEqual([-11.6, -14.6]);
  });

  it('the tool-length sensor is anchor1 + 181 on each axis, inside the envelope', () => {
    expect(Z1.toolChange.sensor).toEqual([Z1.anchor1[0] + 181, Z1.anchor1[1] + 181]);
    expect(insideEnvelope(Z1, [Z1.toolChange.sensor[0], Z1.toolChange.sensor[1], Z1.toolChange.safeZ])).toBe(true);
    expect(insideEnvelope(Z1, [Z1.toolChange.changePosition[0], Z1.toolChange.changePosition[1], Z1.toolChange.clearanceZ])).toBe(true);
  });

  it('records the soft endstops as MEASURED and ENABLED, past the vendor figure (#192 q5, #208 B2)', () => {
    // Read off the machine, not the shipped default. `config-get` said `enable true` and
    // `x_min −207.00`, where configZ1.default said `false` and `-206.0` — so the config has
    // been changed on this machine or drifted from the default it was read from.
    expect(Z1.softEndstop).toEqual({
      enabled: true,
      xMin: -207.0,
      yMin: -206.0,
      zMin: -102.0,
      source: expect.stringContaining('2026-10-06'),
    });
    expect(Z1.softEndstop.xMin).toBeLessThan(Z1.envelope.x.min);
    expect(Z1.softEndstop.zMin).toBeLessThan(Z1.envelope.z.min);
    // Measured data only: it does not move the envelope the simulator refuses at.
    expect(Z1.envelope.x.min).toBe(-200);
  });

  it('the collet nut is NOT measured yet (#208): holder is null, and that is deliberate', () => {
    // #208 calipers the real nut. Filling this in is a MEASUREMENT, not a tidy-up, so it must
    // touch this test: a filled holder changes the fixture check from "cannot be proven" to a
    // geometric test, and the number has to be someone's.
    expect(Z1.holder).toBeNull();
  });

  it('states the 4th axis as SOURCED data, one string per field (#237 R-0, #238, /Rotary.md §3.5)', () => {
    // The rotary profile exists so the A-axis numbers are data with provenance, not constants
    // typed at a call site. It is not a measurement: `sources` says where each number came from —
    // and the fields do NOT share a source, which is the whole point of the map (#238): the rates
    // were read off this machine's config and steps/homing are still the shipped file, so R-1
    // replaces them one at a time.
    expect(Z1.rotary).toBeDefined();
    expect(Z1.rotary).toMatchObject({ axis: 'A', parent: 'y', homing: 'home_to_min', unwind: 'G92.4 A S' });
    expect(Z1.rotary?.stepsPerDegree).toBeCloseTo(88.888889, 6);
    expect(Z1.rotary?.envelope).toEqual({ diameter: 80, length: 150 });
    // Every sourced field has a non-empty string: no silent gap for R-1 to fill in later.
    for (const s of Object.values(Z1.rotary?.sources ?? {})) expect(s.length).toBeGreaterThan(0);
    expect(Object.keys(Z1.rotary?.sources ?? {}).sort()).toEqual([
      'acceleration',
      'envelope',
      'homing',
      'maxRate',
      'stepsPerDegree',
      'unwind',
    ]);
    // The rates are a config READ off the machine (B9), which is still not a measurement.
    expect(Z1.rotary?.sources.maxRate).toMatch(/config-get|config read/);
    expect(Z1.rotary?.sources.maxRate).toContain('config read');
    expect(Z1.rotary?.sources.acceleration).toContain('config read');
    // Steps and homing are still the shipped default, and must SAY so until R-1 measures them.
    expect(Z1.rotary?.sources.stepsPerDegree).toContain('configZ1.default');
    expect(Z1.rotary?.sources.stepsPerDegree).toMatch(/unverified/i);
    expect(Z1.rotary?.sources.homing).toMatch(/unverified/i);
    // The envelope is Makera's database row, not the device.
    expect(Z1.rotary?.sources.envelope).toContain('t_MachineType');
  });

  it('the heights the head actually goes to are within travel; the probe TARGET is not, and that is recorded', () => {
    const { clearanceZ, safeZ, sensorZ } = Z1.toolChange;
    for (const z of [clearanceZ, safeZ]) {
      expect(z).toBeLessThanOrEqual(0);
      expect(z).toBeGreaterThanOrEqual(Z1.envelope.z.min);
    }
    expect(clearanceZ).toBeGreaterThan(safeZ);
    // The probe is commanded TOWARD -108 and stops at contact. -108 is below the Z1's travel:
    // the shipped config carries Carvera-Air boilerplate (its worksize_x says 300 too). Pinned
    // so that a "fix" to -100 is a deliberate decision, not a tidy-up.
    expect(sensorZ).toBe(-108);
    expect(sensorZ).toBeLessThan(Z1.envelope.z.min);
    expect(safeZ).toBeGreaterThan(sensorZ);
  });
});

describe('clampToMachine: the single choke point', () => {
  it('passes values within the ceiling untouched, and null through as null', () => {
    expect(clampToMachine(1000, 10000, Z1)).toEqual({ feed: 1000, rpm: 10000, diagnostics: [] });
    expect(clampToMachine(null, null, Z1)).toEqual({ feed: null, rpm: null, diagnostics: [] });
    expect(clampToMachine(1200, 13000, Z1).diagnostics).toEqual([]); // exactly at the limit is fine
  });

  it("clamps a modest overage and says so: Makera's own 15 000 RPM rows on a 13 000 RPM spindle", () => {
    // The 32 rows in t_MakeraCutterProperties above the Z1's ceiling are +15 %: a table
    // written for a Carvera, not garbage. Clamp, warn.
    const r = clampToMachine(null, 15000, Z1);
    expect(r.rpm).toBe(13000);
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'warning', code: 'rpm-clamped' });
  });

  it('REFUSES a gross overage rather than clamping it: wrong tool, wrong material, or corruption', () => {
    const r = clampToMachine(1200 * (1 + CLAMP_REFUSE_FRACTION_FALLBACK) + 1, 24000, Z1);
    expect(r.feed).toBeNull();
    expect(r.rpm).toBeNull();
    expect(r.diagnostics.map((d) => [d.severity, d.code])).toEqual([
      ['error', 'feed-refused'],
      ['error', 'rpm-refused'],
    ]);
  });

  it('refuses the garbage Studio writes into its own files (1e61, NaN, Infinity)', () => {
    for (const bad of [9.255963134931783e61, NaN, Infinity]) {
      const r = clampToMachine(bad, bad, Z1);
      expect(r.feed, String(bad)).toBeNull();
      expect(r.rpm, String(bad)).toBeNull();
      expect(r.diagnostics.every((d) => d.severity === 'error')).toBe(true);
    }
  });

  it('the refuse threshold is one named fallback constant', () => {
    expect(CLAMP_REFUSE_FRACTION_FALLBACK).toBe(0.5);
  });
});

describe('insideEnvelope', () => {
  it('checks only known axes', () => {
    expect(insideEnvelope(Z1, [null, null, null])).toBe(true);
    expect(insideEnvelope(Z1, [-100, null, -50])).toBe(true);
    expect(insideEnvelope(Z1, [5, null, null])).toBe(false); // +X is beyond home
    expect(insideEnvelope(Z1, [-295, -205, -3])).toBe(false); // goto-pack-pos.nc: a Carvera envelope
  });
});

describe('one machine abstraction, two processes (#184, #228)', () => {
  it('discriminates mills and printers by `process`, and both are a Machine', () => {
    const machines: Machine[] = [Z1, ...PRINTER_PROFILES];
    expect(machines.every((m) => m.process === 'mill' || m.process === 'fdm')).toBe(true);
    // #773 — three mills (Z1, Carvera Air, Carvera) beside the printer presets.
    expect(ALL_MACHINES).toHaveLength(3 + PRINTER_PROFILES.length);
    // The mill's spindle facts hang off the mill subtype only: a printer has no maxRpm.
    expect('maxRpm' in PRINTER_PROFILES[0]!).toBe(false);
  });

  it('carries the six printer presets, ids and names unchanged, now with a nozzle', () => {
    expect(PRINTER_PROFILES.map((p) => p.id)).toEqual([
      'a1-mini',
      'prusa-mini',
      'ender-3',
      'prusa-mk4',
      'bambu-256',
      'prusa-xl',
    ]);
    for (const p of PRINTER_PROFILES) {
      expect(p.process).toBe('fdm');
      expect(p.buildVolume.x).toBeGreaterThan(0);
      expect(p.buildVolume.y).toBeGreaterThan(0);
      expect(p.buildVolume.z).toBeGreaterThan(0);
      expect(p.nozzle).toBe(ASSUMED_NOZZLE);
    }
  });

  it('keeps the assumed nozzle on the profile, where the acceptance grep finds it alone', () => {
    expect(ASSUMED_NOZZLE).toBe(0.4);
  });
});

describe('profile schemas (#184 work item 1)', () => {
  it('round-trips the Z1 through its schema, and through the discriminated union', () => {
    const parsed: Machine = millProfileSchema.parse(Z1);
    expect(parsed).toEqual(Z1);
    expect(machineSchema.parse(Z1)).toEqual(Z1);
  });

  it('#530 round-trips the camera endpoint, and refuses one without a port, a path or a source', () => {
    // The camera is what the pane offers: a profile that loses it in a parse would have a machine
    // that serves a stream the app no longer knows about.
    expect(millProfileSchema.parse(Z1).camera).toEqual(Z1.camera);
    // Optional: a machine with no camera parses without one and stays without one.
    const { camera: _camera, ...noCamera } = Z1;
    expect(millProfileSchema.parse(noCamera).camera).toBeUndefined();
    for (const bad of [
      { ...Z1, camera: { ...Z1.camera, port: 0 } },
      { ...Z1, camera: { ...Z1.camera, path: 'ws_video' } },
      { ...Z1, camera: { ...Z1.camera, source: '' } },
    ]) {
      expect(millProfileSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parses every printer profile', () => {
    for (const p of PRINTER_PROFILES) {
      expect(printerProfileSchema.parse(p)).toEqual(p);
      expect(machineSchema.parse(p)).toEqual(p);
    }
  });

  it('refuses a mill missing the sourced soft endstops, or stating a half tool change', () => {
    const noEndstop = Object.fromEntries(Object.entries(Z1).filter(([k]) => k !== 'softEndstop'));
    expect(millProfileSchema.safeParse(noEndstop).success).toBe(false);
    // #773 — hasATC and toolSlots are one fact: a changer with no slots names no tool it can
    // hold, and a manual machine that lists slots claims a change it cannot make.
    expect(millProfileSchema.safeParse({ ...Z1, hasATC: true }).success).toBe(false);
    expect(millProfileSchema.safeParse({ ...Z1, toolSlots: 6 }).success).toBe(false);
  });

  it('refuses a mill whose rapid model is missing, non-positive, or unsourced (#281)', () => {
    const { rapidEstimate: _rapid, ...noRapid } = Z1;
    expect(millProfileSchema.safeParse(noRapid).success).toBe(false);
    // A zero rate would make a rapid instantaneous — a claim about the machine, not an estimate.
    expect(millProfileSchema.safeParse({ ...Z1, rapidEstimate: { ...Z1.rapidEstimate, xyMmPerMin: 0 } }).success).toBe(false);
    expect(millProfileSchema.safeParse({ ...Z1, rapidEstimate: { ...Z1.rapidEstimate, accelMmPerS2: -1 } }).success).toBe(false);
    expect(millProfileSchema.safeParse({ ...Z1, rapidEstimate: { ...Z1.rapidEstimate, source: '' } }).success).toBe(false);
  });

  it('carries the rotary profile as optional sourced data (#237, #238)', () => {
    // Optional: a flat mill states no 4th axis. Present: every field is a sourced literal.
    const { rotary: _rotary, ...flat } = Z1;
    expect(millProfileSchema.safeParse(flat).success).toBe(true);
    expect(millProfileSchema.safeParse(Z1).success).toBe(true);
    expect(millProfileSchema.safeParse({ ...Z1, rotary: { ...Z1.rotary, axis: 'B' } }).success).toBe(false);
    // #238 — provenance is per field, so a rate without a source does not parse: it would be a
    // number typed at a call site wearing the block's name.
    const noSources = { ...Z1.rotary };
    delete (noSources as { sources?: unknown }).sources;
    expect(millProfileSchema.safeParse({ ...Z1, rotary: noSources }).success).toBe(false);
    const blank = { ...Z1.rotary, sources: { ...Z1.rotary?.sources, maxRate: '' } };
    expect(millProfileSchema.safeParse({ ...Z1, rotary: blank }).success).toBe(false);
  });
});

// #773 — THE CARVERA FAMILY BESIDE THE Z1. The Air is a framed profile: the vendor's database row
// plus Makera's own shipped controller settings. The Carvera is the SAME KIND of vendor row with
// NO frame — nothing positional has ever been read from one — and it is deliberately not a
// `MillProfile`, so no caller can be handed one and quietly use the Z1's positions.
describe('#773 the Carvera Air is framed, and the Carvera is a row with no frame', () => {
  it('the Air carries the database row and the Carvera Controller’s shipped settings', () => {
    expect(CARVERA_AIR).toMatchObject({
      id: 'CA1',
      name: 'Makera Carvera Air',
      frameState: 'read',
      maxCutFeed: 3000,
      maxRpm: 13000,
      hasATC: false,
      toolSlots: 0,
      // The shipped user-settings file states rates but not steps: null, never the Z1's.
      axisSteps: null,
    });
    expect(CARVERA_AIR.envelope).toEqual({
      x: { min: -300, max: 0 },
      y: { min: -200, max: 0 },
      z: { min: -130, max: 0 },
    });
    expect(CARVERA_AIR.rapidEstimate).toMatchObject({ xyMmPerMin: 3000, zMmPerMin: 2000, accelMmPerS2: 150 });
    expect(CARVERA_AIR.softEndstop).toMatchObject({ enabled: true, xMin: -302, yMin: -212, zMin: -121 });
    expect(CARVERA_AIR.rotary).toMatchObject({ envelope: { diameter: 92, length: 200 }, maxRate: 2400, acceleration: 360 });
    // The accessory words this app emits are the Z1's; a Carvera's vacuum is M801/M802, so the
    // flags are false rather than speaking a dialect this app does not model.
    expect(CARVERA_AIR.capabilities).toEqual({ rotary: true, laser: false, air: false, vacuum: false, antistatic: false });
    for (const value of Object.values(CARVERA_AIR.sources)) expect(value.length).toBeGreaterThan(20);
    expect(CARVERA_AIR.sources.maxCutFeed).toContain('t_MachineType');
    expect(CARVERA_AIR.sources.sensorOffsetFromAnchor1).toContain('CARVERA_AIR');
  });

  it('the Air’s positions come from its frame and the firmware’s own model constants', () => {
    // anchor1 (-287.51, -202.11); anchor2 = anchor1 + (88.5, 45); the manual probe parks at
    // anchor1 + (280, 196) for this model (ATCHandler.cpp's CARVERA_AIR arm); the change position
    // adds the same (132, 0) on top of the toolrack offset every model does.
    expect(CARVERA_AIR.anchor1).toEqual([-287.51, -202.11]);
    const near = (got: readonly number[], want: readonly number[]): void => {
      expect(got).toHaveLength(want.length);
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 6));
    };
    near(CARVERA_AIR.anchor2, [-199.01, -157.11]);
    near(CARVERA_AIR.toolChange.sensor, [-7.51, -6.11]);
    near(CARVERA_AIR.toolChange.changePosition, [-29.51, -6.11]);
    expect(CARVERA_AIR.toolChange.sensorZ).toBe(-108);
    expect(CARVERA_AIR.toolChange.probeRetract).toBe(2); // the Z1's is 1
  });

  it('the Carvera is a vendor row with no frame, and the sentence names the fix', () => {
    expect(CARVERA).toMatchObject({
      id: 'C1',
      name: 'Makera Carvera',
      frameState: 'unread',
      maxCutFeed: 3000,
      maxRpm: 15000,
      hasATC: true,
      toolSlots: 6,
      rotaryEnvelope: { diameter: 92, length: 240 },
    });
    expect(CARVERA.envelope).toEqual({
      x: { min: -320, max: 0 },
      y: { min: -240, max: 0 },
      z: { min: -140, max: 0 },
    });
    // NOT a framed profile: no id lookup a job path uses may answer with one.
    expect(MACHINES.C1).toBeUndefined();
    expect(Object.keys(MACHINES)).toEqual(['Z1', 'CA1']);
    expect(Object.keys(MILL_MODELS)).toEqual(['Z1', 'CA1', 'C1']);
    expect(millModelById('C1')).toBe(CARVERA);
    expect(millModelById('CA1')).toBe(CARVERA_AIR);
    expect(millModelById('nope')).toBeUndefined();
    expect(machineFrameProblem(CARVERA)).toBe(MACHINE_FRAME_UNREAD);
    expect(machineFrameProblem(CARVERA_AIR)).toBeNull();
    expect(machineFrameProblemById('C1')).toBe(MACHINE_FRAME_UNREAD);
    expect(machineFrameProblemById('CA1')).toBeNull();
    expect(machineFrameProblemById('nope')).toBeNull();
    expect(MACHINE_FRAME_UNREAD).toBe(
      "This Carvera's frame has not been read from the machine yet; connect it once.",
    );
  });

  it('jobMachine refuses an unframed machine rather than answering with the Z1', () => {
    // A parsed job cannot name one — the schema refuses it — so this is the guard behind that
    // refusal. An id this build does not know keeps the documented Z1 fallback.
    expect(() => jobMachine({ machineId: 'C1' })).toThrow(MACHINE_FRAME_UNREAD);
    expect(jobMachine({ machineId: 'CA1' })).toBe(CARVERA_AIR);
    expect(jobMachine({ machineId: 'nope' })).toBe(Z1);
  });

  it('every model parses through its own schema, and the mixed kind does not', () => {
    expect(machineSchema.parse(Z1)).toEqual(Z1);
    expect(machineSchema.parse(CARVERA_AIR)).toEqual(CARVERA_AIR);
    expect(machineSchema.parse(CARVERA)).toEqual(CARVERA);
    expect(millProfileSchema.safeParse(CARVERA).success).toBe(false);
    expect(millModelSchema.safeParse(CARVERA_AIR).success).toBe(false);
    // The half tool change is refused on the row too.
    expect(millModelSchema.safeParse({ ...CARVERA, toolSlots: 0 }).success).toBe(false);
    expect(millModelSchema.safeParse({ ...CARVERA, hasATC: false }).success).toBe(false);
  });
});

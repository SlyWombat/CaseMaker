// The machine profile (#184, decision 25). The numbers are READINGS of Makera's database
// row and the shipped firmware config, not measurements; the tests pin them so a change is
// deliberate, and pin the one internal consistency check available without the machine.

import { describe, it, expect } from 'vitest';
import {
  Z1,
  MACHINES,
  ALL_MACHINES,
  PRINTER_PROFILES,
  ASSUMED_NOZZLE,
  clampToMachine,
  insideEnvelope,
  machineSchema,
  millProfileSchema,
  printerProfileSchema,
  CLAMP_REFUSE_FRACTION,
  type Machine,
} from '@/engine/cnc/machine';

describe('the Z1 profile', () => {
  it('is the only supported machine (#183: Z1 only, no Carvera, no plugin API)', () => {
    expect(Object.keys(MACHINES)).toEqual(['Z1']);
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

  it('states what it does not have as FLAGS, not silence', () => {
    expect(Z1.capabilities.laser).toBe(false);
    expect(Z1.capabilities.vacuum).toBe(false);
    expect(Z1.capabilities.rotary).toBe(true);
    expect(Z1.capabilities.air).toBe(true);
  });

  it('dialect flags match the firmware and the vendor FreeCAD definition', () => {
    expect(Z1.dialect).toEqual({ acceptsArcs: true, cannedCycles: false, grblMode: true, axisPrecision: 3, feedPrecision: 2 });
  });

  it('CONSISTENCY CHECK: the tool-change position computed from anchor1 + toolrack offsets lands on the config\'s own clearance_x/y', () => {
    // ATCHandler parks at anchor1 + toolrack_offset + (132, 0); configZ1.default separately
    // lists clearance_x/y = (-11.6, -14.6). They agree to the config's rounding, which is the
    // one cross-check available without the machine.
    expect(Z1.toolChange.changePosition[0]).toBeCloseTo(-11.6, 1);
    expect(Z1.toolChange.changePosition[1]).toBeCloseTo(-14.6, 1);
  });

  it('the tool-length sensor is anchor1 + 181 on each axis, inside the envelope', () => {
    expect(Z1.toolChange.sensor).toEqual([Z1.anchor1[0] + 181, Z1.anchor1[1] + 181]);
    expect(insideEnvelope(Z1, [Z1.toolChange.sensor[0], Z1.toolChange.sensor[1], Z1.toolChange.safeZ])).toBe(true);
    expect(insideEnvelope(Z1, [Z1.toolChange.changePosition[0], Z1.toolChange.changePosition[1], Z1.toolChange.clearanceZ])).toBe(true);
  });

  it('records the soft endstops as SOURCED and DISABLED, past the vendor figure (#192 q5, #208 B2)', () => {
    // The shipped config's limit, not one the controller enforces. `envelope` stays the
    // conservative 200/200/100 because the band (-206, -200] is unverified without the machine.
    expect(Z1.softEndstop).toEqual({
      enabled: false,
      xMin: -206.0,
      yMin: -206.0,
      zMin: -102.0,
      source: expect.stringContaining('#208 B2'),
    });
    expect(Z1.softEndstop.xMin).toBeLessThan(Z1.envelope.x.min);
    expect(Z1.softEndstop.zMin).toBeLessThan(Z1.envelope.z.min);
    // Sourced data only: it does not move the envelope the simulator refuses at.
    expect(Z1.envelope.x.min).toBe(-200);
  });

  it('the collet nut is NOT measured yet (#208): holder is null, and that is deliberate', () => {
    // #208 calipers the real nut. Filling this in is a MEASUREMENT, not a tidy-up, so it must
    // touch this test: a filled holder changes the fixture check from "cannot be proven" to a
    // geometric test, and the number has to be someone's.
    expect(Z1.holder).toBeNull();
  });

  it('states the 4th axis as SOURCED data, flagged shipped-default (#237 R-0, /Rotary.md §3.5)', () => {
    // The rotary profile exists so the A-axis numbers are data with provenance, not constants
    // typed at a call site. It is not a measurement: `source` says where each number came from.
    expect(Z1.rotary).toBeDefined();
    expect(Z1.rotary).toMatchObject({ axis: 'A', parent: 'y', homing: 'home_to_min', unwind: 'G92.4 A S' });
    expect(Z1.rotary?.stepsPerDegree).toBeCloseTo(88.888889, 6);
    expect(Z1.rotary?.envelope).toEqual({ diameter: 80, length: 150 });
    expect(Z1.rotary?.source).toContain('configZ1.default');
    expect(Z1.rotary?.source).toMatch(/unverified/i);
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
    const r = clampToMachine(1200 * (1 + CLAMP_REFUSE_FRACTION) + 1, 24000, Z1);
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

  it('the refuse threshold is one named constant', () => {
    expect(CLAMP_REFUSE_FRACTION).toBe(0.5);
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
    expect(ALL_MACHINES).toHaveLength(1 + PRINTER_PROFILES.length);
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

  it('parses every printer profile', () => {
    for (const p of PRINTER_PROFILES) {
      expect(printerProfileSchema.parse(p)).toEqual(p);
      expect(machineSchema.parse(p)).toEqual(p);
    }
  });

  it('refuses a mill missing the sourced soft endstops, or claiming an ATC', () => {
    const noEndstop = Object.fromEntries(Object.entries(Z1).filter(([k]) => k !== 'softEndstop'));
    expect(millProfileSchema.safeParse(noEndstop).success).toBe(false);
    // hasATC is a literal false on the type (#183, Z1-only): a profile with an ATC is not one.
    expect(millProfileSchema.safeParse({ ...Z1, hasATC: true }).success).toBe(false);
  });

  it('carries the rotary profile as optional sourced data (#237)', () => {
    // Optional: a flat mill states no 4th axis. Present: every field is a sourced literal.
    const { rotary: _rotary, ...flat } = Z1;
    expect(millProfileSchema.safeParse(flat).success).toBe(true);
    expect(millProfileSchema.safeParse(Z1).success).toBe(true);
    expect(millProfileSchema.safeParse({ ...Z1, rotary: { ...Z1.rotary, axis: 'B' } }).success).toBe(false);
  });
});

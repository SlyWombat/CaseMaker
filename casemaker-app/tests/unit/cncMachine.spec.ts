// The machine profile (#184, decision 25). The numbers are READINGS of Makera's database
// row and the shipped firmware config, not measurements; the tests pin them so a change is
// deliberate, and pin the one internal consistency check available without the machine.

import { describe, it, expect } from 'vitest';
import { Z1, MACHINES, clampToMachine, insideEnvelope, CLAMP_REFUSE_FRACTION } from '@/engine/cnc/machine';

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

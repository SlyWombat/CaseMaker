// #607 — the rotary tap's record point and its write-back: the datum gains the measured radius,
// and the point straddles the axis estimate by the nominal radius plus a margin.

import { describe, expect, it } from 'vitest';
import { rotarySearchMm, rotaryTapPoint } from '@/engine/cnc/mounts/rotary';
import { withRotaryAxisDatum } from '@/platform/bedProfiles';
import type { MachineRecord } from '@/platform/locationClient';

const RECORD = { axisY: -180, nominalRadiusMm: 40 };

describe('#607 the rotary tap point', () => {
  it('sits on the chuck mid-length at the axis estimate, and the search straddles it', () => {
    expect(rotaryTapPoint(RECORD, -150)).toEqual({ x: -150, y: -180 });
    expect(rotarySearchMm(RECORD)).toBe(50);
  });
});

describe('#607 withRotaryAxisDatum', () => {
  it('writes the axis Z, the axis line’s Y and the measured radius onto the active profile', () => {
    const machine = {
      id: 'm1',
      activeBedProfileId: 'bed-1',
      bedProfiles: [{ id: 'bed-1', datums: { surfaceTopZ: null, viseJawTopZ: null, bracketSeatZ: null, rotaryAxis: null }, history: [] }],
    } as unknown as MachineRecord;
    const next = withRotaryAxisDatum(machine, { axisZ: -50.2, axisY: -179.9, radiusMm: 40.3, atX: -150 }, 'fx-probe-3d', '2026-10-31T00:00:00.000Z');
    const datum = next.bedProfiles!.find((p) => p.id === 'bed-1')!.datums.rotaryAxis!;
    expect(datum.value).toBeCloseTo(-50.2, 6);
    expect(datum.at).toEqual([-150, -179.9]);
    expect(datum.radiusMm).toBeCloseTo(40.3, 6);
    expect(datum.by).toBe('fx-probe-3d');
    expect(next.bedProfiles!.find((p) => p.id === 'bed-1')!.history.at(-1)?.what).toContain('rotary axis measured');
  });
});

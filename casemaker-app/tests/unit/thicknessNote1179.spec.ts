// #1179 D — THE THICKNESS NOTE. A registration measures the blank's top; the job states a thickness
// and the plan's expected top derives from it. When the measured top implies a thickness more than
// 0.1 mm from the job's, the Register step says so — both numbers and the difference — and the job
// is NOT edited. The measured top is what the blank's record keeps (F's `finishedRuns` registration:
// `measuredTopMachineZ`, `impliedThicknessMm`, `measuredAt`, `planExpectedTopMachineZ`).
import { describe, expect, it } from 'vitest';

import {
  THICKNESS_NOTE_MM,
  expectedTopOf,
  thicknessNote,
} from '@/engine/cnc/registration/thicknessNote';

/** The tray's numbers: a 25 mm job, its top expected at machine Z 12, measured 25.30 mm thick. */
const TRAY = { statedThicknessMm: 25, expectedTopMachineZ: 12, measuredTopMachineZ: 12.3 };

describe('#1179 D the thickness note', () => {
  it('names both numbers and the difference when the blank is thicker than the job says', () => {
    const note = thicknessNote(TRAY);
    expect(note).not.toBeNull();
    expect(note!.check.statedThicknessMm).toBe(25);
    expect(note!.check.measuredTopMachineZ).toBe(12.3);
    expect(note!.check.expectedTopMachineZ).toBe(12);
    expect(note!.check.deltaMm).toBeCloseTo(0.3, 9);
    expect(note!.check.impliedThicknessMm).toBeCloseTo(25.3, 9);
    expect(note!.check.over).toBe(true);
    // The operator's sentence: the job's number, the blank's number, the difference, and that the
    // job is not changed (a job edit would move every program's bytes).
    expect(note!.text).toContain('25 mm');
    expect(note!.text).toContain('25.30 mm');
    expect(note!.text).toContain('0.30 mm more');
    expect(note!.text).toContain('not changed');
  });

  it('says "less" when the measured top implies a thinner blank', () => {
    const note = thicknessNote({ statedThicknessMm: 25, expectedTopMachineZ: 12, measuredTopMachineZ: 11.8 });
    expect(note!.check.impliedThicknessMm).toBeCloseTo(24.8, 9);
    expect(note!.text).toContain('24.80 mm');
    expect(note!.text).toContain('0.20 mm less');
  });

  it('is silent at or inside 0.1 mm — the threshold is "more than"', () => {
    expect(thicknessNote({ ...TRAY, measuredTopMachineZ: 12.05 })).toBeNull();
    expect(thicknessNote({ ...TRAY, measuredTopMachineZ: 12.1 })).toBeNull();
    expect(thicknessNote({ ...TRAY, measuredTopMachineZ: 11.9 })).toBeNull();
  });

  it('does not fire on floating-point noise that rounds onto the line', () => {
    // 12.4 − 12.3 is 0.10000000000000142 in binary; to the thousandth it is the threshold itself.
    expect(thicknessNote({ statedThicknessMm: 25, expectedTopMachineZ: 12.3, measuredTopMachineZ: 12.4 })).toBeNull();
  });

  it('fires just past the threshold in either direction', () => {
    expect(thicknessNote({ ...TRAY, measuredTopMachineZ: 12.101 })!.check.over).toBe(true);
    expect(thicknessNote({ ...TRAY, measuredTopMachineZ: 11.899 })!.check.over).toBe(true);
  });

  it('has no note when the job does not state a thickness', () => {
    expect(thicknessNote({ ...TRAY, statedThicknessMm: 0 })).toBeNull();
    expect(thicknessNote({ ...TRAY, statedThicknessMm: Number.NaN })).toBeNull();
  });

  it('never mutates its input', () => {
    const input = Object.freeze({ ...TRAY });
    expect(() => thicknessNote(input)).not.toThrow();
  });

  it('the threshold is the issue’s 0.1 mm, and it is a plain constant today', () => {
    expect(THICKNESS_NOTE_MM).toBe(0.1);
  });
});

describe('#1179 D the plan’s expected top', () => {
  it('is the seek band’s ceiling less the surface tolerance (the derived path’s own arithmetic)', () => {
    expect(expectedTopOf({ seek: { band: { max: 13.5 } }, settings: { surfaceToleranceMm: 1.5 } })).toBe(12);
  });

  it('reads the same plan the executor holds — three decimals, no drift', () => {
    expect(expectedTopOf({ seek: { band: { max: 12.001 } }, settings: { surfaceToleranceMm: 1.5 } })).toBe(10.501);
  });
});

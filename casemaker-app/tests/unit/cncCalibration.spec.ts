/**
 * Issue #279 — the machine's own coordinate frame as a saved record.
 *
 * The fixture is not invented: it is the transcript of #208 B6/B7, read off `Makera_Z1_010290`
 * through `config-get sd` on 2026-10-06, key by key. That is the whole point of the issue — the
 * values exist, they differ from the vendor's shipped defaults, and the machine's own read has
 * to be able to reach a profile.
 *
 * These assert PHYSICAL positions rather than restating the derivation: that a calibrated
 * profile aims the tool-length probe where the machine says the sensor is, that it leaves every
 * limit it was never a measurement of alone, and that a read which is not complete is refused
 * whole rather than half-applied.
 */

import { describe, it, expect } from 'vitest';
import { Z1, Z1_FRAME, MACHINES, deriveCoordinateFrame } from '@/engine/cnc/machine';
import {
  CALIBRATION_KEYS,
  CALIBRATION_KEY_LIST,
  calibrationFromReplies,
  machineCalibrationNotice,
  parseMachineCalibration,
  readSource,
  resolveMachine,
  resolvedMachineById,
  type MachineCalibration,
} from '@/engine/cnc/calibration';
import { Z1_FRAME_REPLIES } from './fixtures/z1Frame';

const READ_OPTS = { machineId: 'Z1', measuredAt: '2026-10-06T13:01:11.000Z', host: '192.168.10.43' };

function readMachine(overrides: Record<string, string | undefined> = {}): MachineCalibration {
  const replies = new Map<string, string>(Object.entries(Z1_FRAME_REPLIES));
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) replies.delete(key);
    else replies.set(key, value);
  }
  const read = calibrationFromReplies(replies, READ_OPTS);
  if (!read.ok) {
    throw new Error(`the read should have succeeded: missing ${read.missing}, malformed ${read.malformed}`);
  }
  return read.calibration;
}

describe('the shipped frame (#279, the default half)', () => {
  it('has the vendor anchors and derives every position from them by one formula', () => {
    const d = deriveCoordinateFrame(Z1_FRAME);
    expect(Z1_FRAME.anchor1).toEqual([-192.4, -194.3]);
    expect(Z1.anchor1).toEqual(Z1_FRAME.anchor1);
    expect(Z1.anchor2).toEqual(d.anchor2);
    expect(Z1.toolChange.changePosition).toEqual(d.changePosition);
    expect(Z1.toolChange.sensor).toEqual(d.sensor);
    // The two Z values the vendor file cannot supply honestly are this repo's own machine
    // reads, and they are read from the frame rather than typed into the profile.
    expect(Z1.toolChange.clearanceZ).toBe(Z1_FRAME.clearanceZ);
    expect(Z1.toolChange.sensorZ).toBe(Z1_FRAME.toolrackZ);
  });

  it('keeps the anchors the VENDOR\'s: one machine\'s calibration is not every machine\'s profile', () => {
    // Option 2 (paste this machine's read into the shipped profile) was rejected. If that ever
    // happens by accident, every other Z1 aims its probe 1.5 mm off, and this is the assertion
    // that catches it.
    expect(Z1_FRAME.anchor1).not.toEqual([-190.89, -193.83]);
  });
});

describe('reading a machine (#279, the override half)', () => {
  it('turns the controller\'s answers into a frame, numbered as it answered', () => {
    const cal = readMachine();
    expect(cal.frame.anchor1).toEqual([-190.89, -193.83]);
    expect(cal.frame.toolrackOffset).toEqual([48.8, 181]);
    expect(cal.frame.clearanceXY).toEqual([-11.6, -14.6]);
    expect(cal.softEndstop).toEqual({
      enabled: true,
      xMin: -207.0,
      yMin: -206.0,
      zMin: -102.0,
      source: 'config-get sd on 192.168.10.43',
    });
    expect(cal.source).toBe('config-get sd on 192.168.10.43');
    expect(cal.measuredAt).toBe(READ_OPTS.measuredAt);
  });

  it('refuses the read WHOLE when a key did not answer, and names the keys', () => {
    // A key the controller does not carry is a key that is absent from the map, and the whole
    // read fails: a frame with one vendor value left in it is a machine of its own.
    const replies = new Map<string, string>(Object.entries(Z1_FRAME_REPLIES));
    replies.delete(CALIBRATION_KEYS.toolrackZ);
    replies.delete(CALIBRATION_KEYS.softEndstopXMin);
    const missing = calibrationFromReplies(replies, READ_OPTS);
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.missing.sort()).toEqual([CALIBRATION_KEYS.softEndstopXMin, CALIBRATION_KEYS.toolrackZ].sort());
    expect(missing.malformed).toEqual([]);
  });

  it('refuses a value it cannot read, rather than defaulting it to zero', () => {
    const replies = new Map<string, string>(Object.entries(Z1_FRAME_REPLIES));
    replies.set(CALIBRATION_KEYS.anchor1X, 'not a number');
    const read = calibrationFromReplies(replies, READ_OPTS);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.malformed).toEqual([CALIBRATION_KEYS.anchor1X]);
    expect(read.missing).toEqual([]);
  });

  it('names the source with and without an address', () => {
    expect(readSource({ host: '192.168.10.43' })).toBe('config-get sd on 192.168.10.43');
    expect(readSource({})).toContain('config-get sd');
    expect(readSource({ host: '   ' })).toBe(readSource({}));
  });

  it('asks for every key it needs, and nothing it does not', () => {
    expect(new Set(CALIBRATION_KEY_LIST).size).toBe(CALIBRATION_KEY_LIST.length);
    for (const key of CALIBRATION_KEY_LIST) expect(key).toMatch(/^(coordinate|soft_endstop)\./);
    // The frame's six values, and the four endstop values. A key added without a parser would
    // silently never be read.
    expect(CALIBRATION_KEY_LIST).toHaveLength(14);
  });
});

describe('a saved calibration payload', () => {
  it('survives JSON, which is how it reaches storage', () => {
    const cal = readMachine();
    const parsed = parseMachineCalibration(JSON.parse(JSON.stringify(cal)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.calibration).toEqual(cal);
  });

  it('is dropped whole when anything is wrong, with a reason a human reads', () => {
    const cal = JSON.parse(JSON.stringify(readMachine())) as Record<string, unknown>;
    const frame = cal.frame as Record<string, unknown>;
    const broken: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...cal, machineId: undefined }, /machine id/],
      [{ ...cal, source: '' }, /source/],
      [{ ...cal, measuredAt: undefined }, /date/],
      [{ ...cal, frame: undefined }, /coordinate frame/],
      [{ ...cal, frame: { ...frame, anchor1: [-192.4] } }, /anchor1/],
      [{ ...cal, frame: { ...frame, anchor1: [-192.4, 'x'] } }, /anchor1\[1\]/],
      [{ ...cal, frame: { ...frame, clearanceZ: null } }, /clearanceZ/],
      [{ ...cal, softEndstop: undefined }, /soft endstop/i],
      [{ ...cal, softEndstop: { ...(cal.softEndstop as object), enabled: 'yes' } }, /true or false/],
      [{ ...cal, softEndstop: { ...(cal.softEndstop as object), xMin: undefined } }, /softEndstop\.xMin/],
    ];
    for (const [payload, re] of broken) {
      const parsed = parseMachineCalibration(payload);
      expect(parsed.ok, JSON.stringify(payload).slice(0, 80)).toBe(false);
      if (!parsed.ok) expect(parsed.reason).toMatch(re);
    }
    for (const notAnObject of [null, undefined, 42, 'calibration', []]) {
      expect(parseMachineCalibration(notAnObject).ok).toBe(false);
    }
  });
});

/** A position, to within floating-point noise — every one of these is a sum of read values. */
function expectAt(actual: readonly number[] | undefined, expected: readonly [number, number]): void {
  expect(actual).toBeDefined();
  expect(actual![0]).toBeCloseTo(expected[0], 6);
  expect(actual![1]).toBeCloseTo(expected[1], 6);
}

describe('resolving a profile against a calibration', () => {
  it('aims the tool-length probe where THIS machine says the sensor is', () => {
    const cal = readMachine();
    const resolved = resolveMachine(Z1, cal);

    // anchor1 + 181 on each axis, with the machine's anchor — the move #208 B6 says is 1.5 mm
    // from the profile's on X. This is the functional reason the issue exists.
    expectAt(resolved.toolChange.sensor, [-9.89, -12.83]);
    expectAt(Z1.toolChange.sensor, [-11.4, -13.3]);
    expectAt(resolved.toolChange.changePosition, [-10.09, -12.83]);
    expectAt(resolved.anchor2, [-102.39, -148.83]);
    expectAt(resolved.anchor1, [-190.89, -193.83]);

    // ...and it moves by exactly the recorded drift, so the fixture and the reasoning agree:
    // 0.47 mm of anchor in Y, plus the 1.26 mm `toolrack_offset_y` moved (179.74 → 181).
    expect(resolved.toolChange.changePosition[1] - Z1.toolChange.changePosition[1]).toBeCloseTo(1.73, 6);
    expect(resolved.toolChange.sensor[0] - Z1.toolChange.sensor[0]).toBeCloseTo(1.51, 6);
  });

  it('carries the machine\'s soft endstops, and leaves the ENVELOPE the conservative one', () => {
    const resolved = resolveMachine(Z1, readMachine());
    expect(resolved.softEndstop).toEqual(readMachine().softEndstop);
    // The endstops are RECORDED, not enforced: the declared work area is untouched, and a
    // calibration must not be able to move a limit it was never a measurement of.
    expect(resolved.envelope).toEqual(Z1.envelope);
  });

  it('leaves everything that is not the frame alone', () => {
    const resolved = resolveMachine(Z1, readMachine());
    for (const field of ['envelope', 'maxCutFeed', 'maxRpm', 'hasATC', 'toolSlots', 'dialect', 'capabilities'] as const) {
      expect(resolved[field], field).toEqual(Z1[field]);
    }
    // The probe feeds and the safe height are the machine MODEL's, not its calibration's.
    expect(resolved.toolChange.safeZ).toBe(Z1.toolChange.safeZ);
    expect(resolved.toolChange.probeFastFeed).toBe(Z1.toolChange.probeFastFeed);
    expect(resolved.toolChange.probeSlowFeed).toBe(Z1.toolChange.probeSlowFeed);
    expect(resolved.toolChange.probeRetract).toBe(Z1.toolChange.probeRetract);
    expect(resolved.id).toBe(Z1.id);
    expect(resolved.name).toBe(Z1.name);
  });

  it('does not mutate the shipped profile it resolves from', () => {
    const before = JSON.parse(JSON.stringify(Z1));
    resolveMachine(Z1, readMachine());
    expect(JSON.parse(JSON.stringify(Z1))).toEqual(before);
  });

  it('is the shipped profile when there is nothing saved', () => {
    expect(resolveMachine(Z1)).toBe(Z1);
    expect(resolveMachine(Z1, null)).toBe(Z1);
  });

  it('refuses to apply a calibration read from a DIFFERENT machine', () => {
    const other: MachineCalibration = { ...readMachine(), machineId: 'Z1-other' };
    expect(resolveMachine(Z1, other)).toBe(Z1);
  });

  it('resolves by id, and answers nothing for an id we do not know', () => {
    expectAt(resolvedMachineById('Z1', readMachine())!.toolChange.sensor, [-9.89, -12.83]);
    expect(resolvedMachineById('Z1')).toEqual(MACHINES.Z1);
    expect(resolvedMachineById('carvera')).toBeUndefined();
  });
});

describe('saying which frame is in force', () => {
  it('warns that the vendor\'s defaults are in use when nothing has been read', () => {
    const notice = machineCalibrationNotice(Z1);
    expect(notice.code).toBe('machine-vendor-frame');
    expect(notice.severity).toBe('warning');
    expect(notice.message).toMatch(/#279/);
  });

  it('says when the numbers came from this machine, and when', () => {
    const notice = machineCalibrationNotice(Z1, readMachine());
    expect(notice.code).toBe('machine-calibrated-frame');
    expect(notice.severity).toBe('info');
    expect(notice.message).toContain('192.168.10.43');
    expect(notice.message).toContain('2026-10-06');
  });

  it('says so out loud when a saved calibration is being ignored', () => {
    const other: MachineCalibration = { ...readMachine(), machineId: 'Z1-other' };
    const notice = machineCalibrationNotice(Z1, other);
    expect(notice.code).toBe('machine-calibration-ignored');
    expect(notice.severity).toBe('warning');
    expect(notice.message).toContain('Z1-other');
  });
});

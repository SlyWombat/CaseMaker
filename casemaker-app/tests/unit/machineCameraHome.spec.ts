// #770 — Camera to home: one fixed move to the machine's own clearance pose. The orchestration
// under test is the real one (attachConsole → `?` → the two lines → close); only the socket is
// faked, so what runs is the same guard the work light and the vacuum switch use. The assertions
// that matter are the safety ones: a machine that is not Idle receives NO motion line, and a line
// that fails is named rather than silently skipped.

import { describe, it, expect, afterEach } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend } from '@/platform/machineConsole';
import { fakeConsoleSession } from './helpers/fakeConsole';
import { Z1 } from '@/engine/cnc/machine';
import {
  cameraHomeLiftProblem,
  cameraHomeLines,
  cameraHomeWords,
  runCameraHome,
  type CameraHomePose,
} from '@/platform/machineCameraHome';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';

/** The shipped Z1 pose, as the panel resolves it from the profile. */
const POSE: CameraHomePose = {
  x: Z1.toolChange.clearanceXY[0],
  y: Z1.toolChange.clearanceXY[1],
  z: Z1.toolChange.clearanceZ,
};


/** `?` answers the given status; motion lines answer `ok` unless a `fail` predicate says otherwise. */
const status = (
  text: string,
  fail?: (line: string) => ConsoleSend | null,
): ((line: string) => ConsoleSend) => (line) => {
  if (line === '?') return { ok: true, line, text, frames: 1, elapsedMs: 30 };
  const refused = fail?.(line) ?? null;
  if (refused !== null) return refused;
  return { ok: true, line, text: 'ok', frames: 1, elapsedMs: 12 };
};

describe('#770 the camera-home move', () => {
  it('#1199 — the pose is PROVEN at or above the machine clearance; a lower one refuses and builds no lines', () => {
    expect(cameraHomeLiftProblem(POSE, Z1.toolChange.clearanceZ)).toBeNull();
    const below = { ...POSE, z: Z1.toolChange.clearanceZ - 5 };
    expect(cameraHomeLiftProblem(below, Z1.toolChange.clearanceZ)).toContain('below the machine');
    // The same shape as the bench accident is refused before a line exists.
    expect(() => cameraHomeLines(below, Z1.toolChange.clearanceZ)).toThrow('below the machine');
  });

  it('is two machine-coordinate lines: lift in Z, then X and Y at that height', () => {
    const lines = cameraHomeLines(POSE, Z1.toolChange.clearanceZ);
    expect(lines).toEqual(['G53 G0 Z-3', 'G53 G0 X-11.6 Y-14.6']);
    // The lift comes FIRST: X/Y at the current Z could drag the cutter through the work.
    expect(lines[0]!.startsWith('G53 G0 Z')).toBe(true);
    expect(lines[1]!.startsWith('G53 G0 X')).toBe(true);
  });

  it('states the config keys and the numbers behind the pose, by frame', () => {
    const shipped = cameraHomeWords(POSE, 'profile', 'Makera Z1');
    expect(shipped).toContain('coordinate.clearance_x/y/z');
    expect(shipped).toContain('X -11.6, Y -14.6, Z -3');
    expect(shipped).toContain('no calibration is saved');
    const calibrated = cameraHomeWords(POSE, 'calibration', 'Makera Z1');
    expect(calibrated).toContain('saved calibration');
    const unknown = cameraHomeWords(POSE, 'unknown-machine', 'Makera Z1');
    expect(unknown).toContain('did not identify itself');
  });
});

describe('#770 the camera-home press', () => {
  it('moves an idle machine: asks, lifts, traverses, and closes the connection', async () => {
    const z1 = fakeConsoleSession(status(IDLE));
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE, Z1.toolChange.clearanceZ));
    expect(r.kind).toBe('moved');
    expect(z1.sent).toEqual(['?', 'G53 G0 Z-3', 'G53 G0 X-11.6 Y-14.6']);
    expect(z1.opens).toBe(1);
    expect(z1.closes).toBe(1);
  });

  it('names the line that failed, and does not send the next one', async () => {
    const z1 = fakeConsoleSession(
      status(IDLE, (line) => (line.startsWith('G53 G0 Z') ? { ok: false, reason: 'timeout', line, text: '', detail: 'the controller did not answer' } : null)),
    );
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE, Z1.toolChange.clearanceZ));
    expect(r.kind).toBe('failed');
    expect(r.kind === 'failed' && r.detail).toContain('the lift line');
    expect(z1.sent).toEqual(['?', 'G53 G0 Z-3']);
  });

  it('names the XY line when the traverse is the one that fails', async () => {
    const z1 = fakeConsoleSession(
      status(IDLE, (line) => (line.startsWith('G53 G0 X') ? { ok: false, reason: 'timeout', line, text: '', detail: 'the controller did not answer' } : null)),
    );
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE, Z1.toolChange.clearanceZ));
    expect(r.kind).toBe('failed');
    expect(r.kind === 'failed' && r.detail).toContain('the XY line');
    expect(z1.sent).toEqual(['?', 'G53 G0 Z-3', 'G53 G0 X-11.6 Y-14.6']);
  });

  it('sends nothing for an empty move and opens no connection', async () => {
    const z1 = fakeConsoleSession(status(IDLE));
    const r = await runCameraHome(TARGET, []);
    expect(r.kind).toBe('failed');
    expect(z1.opens).toBe(0);
  });
});

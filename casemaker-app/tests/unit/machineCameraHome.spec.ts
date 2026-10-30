// #770 — Camera to home: one fixed move to the machine's own clearance pose. The orchestration
// under test is the real one (attachConsole → `?` → the two lines → close); only the socket is
// faked, so what runs is the same guard the work light and the vacuum switch use. The assertions
// that matter are the safety ones: a machine that is not Idle receives NO motion line, and a line
// that fails is named rather than silently skipped.

import { describe, it, expect, afterEach } from 'vitest';

import { setMachineConsoleLoader, type ConsoleSend, type MachineConsoleSession } from '@/platform/machineConsole';
import { Z1 } from '@/engine/cnc/machine';
import {
  cameraHomeLines,
  cameraHomeWords,
  runCameraHome,
  type CameraHomePose,
} from '@/platform/machineCameraHome';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };
const IDLE = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128>';
const RUNNING = '<Run|MPos:1.0000,2.0000,-1.0000|Bf:14,128|S:12031|P:389,90,88>';
const MID_JOB = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128|S:12031|P:389,90,88>';
const ALARM = '<Alarm|MPos:0.0000,0.0000,0.0000>';

/** The shipped Z1 pose, as the panel resolves it from the profile. */
const POSE: CameraHomePose = {
  x: Z1.toolChange.clearanceXY[0],
  y: Z1.toolChange.clearanceXY[1],
  z: Z1.toolChange.clearanceZ,
};

function fakeSession(answer: (line: string) => ConsoleSend) {
  const sent: string[] = [];
  const counters = { closes: 0, opens: 0 };
  const session: MachineConsoleSession = {
    async send(line) {
      sent.push(line);
      return answer(line);
    },
    async close() {
      counters.closes += 1;
    },
  };
  setMachineConsoleLoader(async () => ({
    async open() {
      counters.opens += 1;
      return session;
    },
  }));
  return {
    sent,
    get closes() {
      return counters.closes;
    },
    get opens() {
      return counters.opens;
    },
  };
}

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
  it('is two machine-coordinate lines: lift in Z, then X and Y at that height', () => {
    const lines = cameraHomeLines(POSE);
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
    const z1 = fakeSession(status(IDLE));
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE));
    expect(r.kind).toBe('moved');
    expect(z1.sent).toEqual(['?', 'G53 G0 Z-3', 'G53 G0 X-11.6 Y-14.6']);
    expect(z1.opens).toBe(1);
    expect(z1.closes).toBe(1);
  });

  it('refuses a running machine without sending a motion line', async () => {
    const z1 = fakeSession(status(RUNNING));
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE));
    expect(r.kind).toBe('busy');
    expect(r.kind === 'busy' && r.detail).toContain('Run');
    expect(z1.sent).toEqual(['?']);
    expect(z1.closes).toBe(1);
  });

  it('refuses an idle machine whose program has not finished', async () => {
    const z1 = fakeSession(status(MID_JOB));
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE));
    expect(r.kind).toBe('busy');
    expect(r.kind === 'busy' && r.detail).toContain('90%');
    expect(z1.sent).toEqual(['?']);
  });

  it('refuses an alarm without sending anything', async () => {
    const z1 = fakeSession(status(ALARM));
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE));
    expect(r.kind).toBe('busy');
    expect(r.kind === 'busy' && r.detail).toContain('alarm');
    expect(z1.sent).toEqual(['?']);
  });

  it('names the line that failed, and does not send the next one', async () => {
    const z1 = fakeSession(
      status(IDLE, (line) => (line.startsWith('G53 G0 Z') ? { ok: false, reason: 'timeout', line, text: '', detail: 'the controller did not answer' } : null)),
    );
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE));
    expect(r.kind).toBe('failed');
    expect(r.kind === 'failed' && r.detail).toContain('the lift line');
    expect(z1.sent).toEqual(['?', 'G53 G0 Z-3']);
  });

  it('names the XY line when the traverse is the one that fails', async () => {
    const z1 = fakeSession(
      status(IDLE, (line) => (line.startsWith('G53 G0 X') ? { ok: false, reason: 'timeout', line, text: '', detail: 'the controller did not answer' } : null)),
    );
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE));
    expect(r.kind).toBe('failed');
    expect(r.kind === 'failed' && r.detail).toContain('the XY line');
    expect(z1.sent).toEqual(['?', 'G53 G0 Z-3', 'G53 G0 X-11.6 Y-14.6']);
  });

  it('refuses an unreadable status line before moving', async () => {
    const z1 = fakeSession(status('not a status line'));
    const r = await runCameraHome(TARGET, cameraHomeLines(POSE));
    expect(r.kind).toBe('error');
    expect(z1.sent).toEqual(['?']);
  });

  it('sends nothing for an empty move and opens no connection', async () => {
    const z1 = fakeSession(status(IDLE));
    const r = await runCameraHome(TARGET, []);
    expect(r.kind).toBe('failed');
    expect(z1.opens).toBe(0);
  });
});

// #1180 S4 — THE IDLE GUARD, ONCE. The work light (#422), the accessory modes (#289), the vacuum
// (#390) and camera-home (#770) are four one-press controls that open the same console, ask `?`,
// and refuse unless the answer is an explicit finished `Idle`. Each module spec carried its own
// copy of the same four guard tests — running, a mid-job `Idle`, an alarm, an unreadable line —
// four times over. This is the one table: one test per rule, each looping the four controls and
// naming the control in every assertion message.
//
// The behaviours that are NOT copies stay in their own specs: the vacuum's two #386 alarm-carried
// cases, each module's codes and state lines, the camera-home line naming, every panel's rendering.

import { afterEach, describe, expect, it } from 'vitest';

import { setMachineConsoleLoader } from '@/platform/machineConsole';
import { toggleLight } from '@/platform/machineLight';
import { toggleAccessory } from '@/platform/machineAccessory';
import { toggleVacuum } from '@/platform/machineVacuum';
import { cameraHomeLines, runCameraHome, type CameraHomePose } from '@/platform/machineCameraHome';
import { Z1 } from '@/engine/cnc/machine';
import { fakeConsoleSession, statusOnly } from './helpers/fakeConsole';

afterEach(() => setMachineConsoleLoader(null));

const TARGET = { host: '192.168.10.43', port: 2222 };
const RUNNING = '<Run|MPos:1.0000,2.0000,-1.0000|Bf:14,128|S:12031|P:389,90,88>';
/** The mid-job `Idle`: the state word says Idle, the `P:` percent says the program still runs. */
const MID_JOB = '<Idle|MPos:-1.0000,-1.0000,-1.0000|Bf:14,128|S:12031|P:389,90,88>';
const ALARM = '<Alarm|MPos:0.0000,0.0000,0.0000>';
const UNREADABLE = 'not a status line';

/** The shipped Z1 pose, as the panel resolves it from the profile. */
const POSE: CameraHomePose = {
  x: Z1.toolChange.clearanceXY[0],
  y: Z1.toolChange.clearanceXY[1],
  z: Z1.toolChange.clearanceZ,
};

/** What each guard returns, as the matrix reads it: a kind, and the refusal's sentence when any. */
type Answer = { kind: string; detail?: string | null };

interface Operation {
  name: string;
  press: () => Promise<Answer>;
}

/** One press per control, all on the same fake console seam. */
const OPERATIONS: readonly Operation[] = [
  { name: 'the work light', press: () => toggleLight(TARGET, true) },
  { name: 'a spindle fan', press: () => toggleAccessory(TARGET, 'spindle-fan', true) },
  { name: 'the vacuum', press: () => toggleVacuum(TARGET, true) },
  { name: 'camera home', press: () => runCameraHome(TARGET, cameraHomeLines(POSE)) },
];

describe('#1180 the idle guard — every one-press control, one table', () => {
  it('refuses a running machine, sending only the status ask', async () => {
    for (const operation of OPERATIONS) {
      const wire = fakeConsoleSession(statusOnly(RUNNING));
      const r = await operation.press();
      expect(r.kind, operation.name).toBe('busy');
      expect(r.detail ?? '', operation.name).toContain('Run');
      // The ask went out; the code or motion line did NOT.
      expect(wire.sent, operation.name).toEqual(['?']);
      expect(wire.closes, operation.name).toBe(1);
    }
  });

  it('refuses a mid-job Idle at 90 %, sending only the status ask', async () => {
    for (const operation of OPERATIONS) {
      const wire = fakeConsoleSession(statusOnly(MID_JOB));
      const r = await operation.press();
      expect(r.kind, operation.name).toBe('busy');
      expect(r.detail ?? '', operation.name).toContain('90%');
      expect(wire.sent, operation.name).toEqual(['?']);
    }
  });

  it('refuses an alarm, sending only the status ask', async () => {
    for (const operation of OPERATIONS) {
      const wire = fakeConsoleSession(statusOnly(ALARM));
      const r = await operation.press();
      expect(r.kind, operation.name).toBe('busy');
      expect(wire.sent, operation.name).toEqual(['?']);
    }
  });

  it('treats an unreadable status line as an error, sending only the status ask', async () => {
    for (const operation of OPERATIONS) {
      const wire = fakeConsoleSession(statusOnly(UNREADABLE));
      const r = await operation.press();
      expect(r.kind, operation.name).toBe('error');
      expect(wire.sent, operation.name).toEqual(['?']);
    }
  });
});

/**
 * What `Makera_Z1_010290` answered to `config-get sd <key>`, key by key, on 2026-10-06 (#208 B6/B7).
 *
 * A real transcript rather than an invented one, because the whole point of #279 is that these
 * numbers EXIST, differ from the vendor's `configZ1.default`, and have to be able to reach a
 * profile. Two specs need them — the saved record itself (`cncCalibration.spec.ts`) and the check
 * that reads one off a machine (`machineProbe.spec.ts`) — so they live in one place rather than
 * being typed twice and drifting.
 *
 * Keyed by `CALIBRATION_KEYS`, so adding a key there makes both specs answer it nowhere and fail
 * loudly, rather than silently producing a read that is missing a value.
 */

import { CALIBRATION_KEYS, calibrationFromReplies, type MachineCalibration } from '@/engine/cnc/calibration';

export const Z1_FRAME_REPLIES: Record<string, string> = {
  [CALIBRATION_KEYS.anchor1X]: '-190.89',
  [CALIBRATION_KEYS.anchor1Y]: '-193.83',
  [CALIBRATION_KEYS.anchor2OffsetX]: '88.5',
  [CALIBRATION_KEYS.anchor2OffsetY]: '45.0',
  [CALIBRATION_KEYS.toolrackOffsetX]: '48.8',
  [CALIBRATION_KEYS.toolrackOffsetY]: '181',
  [CALIBRATION_KEYS.clearanceX]: '-11.6',
  [CALIBRATION_KEYS.clearanceY]: '-14.6',
  [CALIBRATION_KEYS.clearanceZ]: '-3.0',
  [CALIBRATION_KEYS.toolrackZ]: '-108',
  [CALIBRATION_KEYS.softEndstopEnable]: 'true',
  [CALIBRATION_KEYS.softEndstopXMin]: '-207.00',
  [CALIBRATION_KEYS.softEndstopYMin]: '-206.0',
  [CALIBRATION_KEYS.softEndstopZMin]: '-102.0',
};

/**
 * The record those answers produce, exactly as a read off the bench machine would make it (#279).
 *
 * Throws at import when the transcript does not add up to a whole frame — which is the behaviour
 * under test in `cncCalibration.spec.ts`, so a broken transcript fails there with a message rather
 * than quietly handing `undefined` calibration to every spec that resolves a profile with it.
 */
export const Z1_BENCH_CALIBRATION: MachineCalibration = (() => {
  const read = calibrationFromReplies(new Map(Object.entries(Z1_FRAME_REPLIES)), {
    machineId: 'Z1',
    measuredAt: '2026-10-06T13:01:11.000Z',
    host: '192.168.10.43',
  });
  if (!read.ok) {
    throw new Error(
      `the Z1 frame fixture is not a whole frame: missing ${read.missing}, malformed ${read.malformed}`,
    );
  }
  return read.calibration;
})();

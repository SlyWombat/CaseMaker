/**
 * #289 — THE MACHINE'S OTHER ACCESSORY MODES: spindle fan, power fan, external output and the
 * wireless-probe charge, beside the vacuum (#390), the antistatic (#564) and the work light (#422).
 *
 * THE CODES ARE THE Z1 FIRMWARE'S OWN, read from `src/configZ1.default` in
 * `MakeraInc/MakeraZ1Firmware` — each is a `switch.<name>` instance with an on/off command pair:
 *
 * | key                    | on   | off  | what the machine calls it          |
 * |------------------------|------|------|-------------------------------------|
 * | `switch.spindlefan`    | M811 | M812 | the spindle's cooling fan (HWPWM, default 50 %) |
 * | `switch.powerfan`      | M801 | M802 | the power board's fan (HWPWM, default 30 %)     |
 * | `switch.extendout`     | M851 | M852 | the external output (HWPWM)         |
 * | `switch.probecharger`  | M841 | M842 | the wireless probe's charger       |
 *
 * NO AIR, AND THE MACHINE SAYS SO. `switch.air` is COMMENTED OUT in the Z1's config, and `M7`/`M9`
 * are answered `ok` while blowing nothing (bench 2026-10-12; `millProfile.capabilities.air` is
 * `false` for the same observation). Its blowing mode is `M331.1`, part of the vacuum family this
 * app does not drive (#283) — so the panel states the fact instead of offering a switch that does
 * nothing. {@link AIR_SENTENCE} is that sentence, in one place.
 *
 * THE GUARD IS THE WORK-LIGHT SWITCH'S (#422), in the same order and on one connection per press:
 * ask `?`, refuse an alarm, refuse anything that is not a readable `Idle`, refuse an `Idle` whose
 * program is still finishing (#390), and only then send. The fans are ALSO temperature-switched
 * (`temperatureswitch.spindle.switch = spindlefan`, `…power.switch = powerfan`), so a manual press
 * sets the fan now and the controller's own temperature control can move it again — the panel's
 * words say that rather than implying a state it cannot read back.
 */

import { alarmLine, controllerState, jobProgressPercent } from './machineUpload';
import { attachConsole, type MachineConsoleTarget } from './machineConsole';

export type AccessoryId = 'spindle-fan' | 'power-fan' | 'external-output' | 'wp-charge';

/** One Z1 accessory: the firmware's switch, its two codes, and the words the panel prints. */
export interface AccessorySpec {
  id: AccessoryId;
  /** The panel's label — Studio's own words (Parity §7), with the firmware's key in the hint. */
  name: string;
  /** `switch.<name>` in `configZ1.default` — the provenance of the two codes. */
  vendorKey: string;
  on: string;
  off: string;
  /** What it is and what a press does, in the panel's hint. */
  meaning: string;
}

export const ACCESSORIES: readonly AccessorySpec[] = [
  {
    id: 'spindle-fan',
    name: 'Spindle fan',
    vendorKey: 'switch.spindlefan',
    on: 'M811',
    off: 'M812',
    meaning:
      'The spindle’s cooling fan. The machine’s temperature control also drives it; a manual press sets it now (M811 on at the configured 50 %), and the controller can move it again.',
  },
  {
    id: 'power-fan',
    name: 'Power fan',
    vendorKey: 'switch.powerfan',
    on: 'M801',
    off: 'M802',
    meaning:
      'The power board’s fan. The machine’s temperature control also drives it; a manual press sets it now (M801 on at the configured 30 %), and the controller can move it again.',
  },
  {
    id: 'external-output',
    name: 'External output',
    vendorKey: 'switch.extendout',
    on: 'M851',
    off: 'M852',
    meaning: 'The machine’s external output (M851 on, M852 off) — the port for an accessory wired to it.',
  },
  {
    id: 'wp-charge',
    name: 'WP charge',
    vendorKey: 'switch.probecharger',
    on: 'M841',
    off: 'M842',
    meaning: 'The wireless probe’s charger (M841 on, M842 off). It is on at power-up; the status line does not report it.',
  },
];

/** The spec for one accessory. Throws only for a caller that typed an id this build does not know. */
export function accessory(id: AccessoryId): AccessorySpec {
  const spec = ACCESSORIES.find((a) => a.id === id);
  if (spec === undefined) throw new Error(`unknown accessory ${id}`);
  return spec;
}

/** The console line for one state, in one place: the panel and its tests agree on the code. */
export function accessoryLine(id: AccessoryId, on: boolean): string {
  const spec = accessory(id);
  return on ? spec.on : spec.off;
}

/**
 * Why the panel offers no air switch, in the operator's words. The capability is the profile's
 * (`capabilities.air === false`), and this is the fact behind it.
 */
export const AIR_SENTENCE =
  'No air switch: this machine’s M7/M9 air output blows nothing (the firmware’s switch.air is commented out and the codes answer ok), and its blowing mode, M331.1, is not driven here.';

/**
 * What one press did: `toggled` (the controller took the code), `busy` (not Idle / mid-job / an
 * alarm — nothing sent), or one of the socket outcomes the console reports.
 */
export type AccessoryOutcome =
  | { kind: 'toggled'; id: AccessoryId; on: boolean; status: string }
  | { kind: 'busy'; id: AccessoryId; detail: string; status: string }
  | { kind: 'refused'; id: AccessoryId; detail: string }
  | { kind: 'timeout'; id: AccessoryId; detail: string }
  | { kind: 'error'; id: AccessoryId; detail: string }
  | { kind: 'unavailable'; id: AccessoryId; detail: string };

/**
 * Ask the machine to switch one accessory on or off. Never throws; the guards are the work light's,
 * in the same order, on the one connection a press opens.
 */
export async function toggleAccessory(
  target: MachineConsoleTarget,
  id: AccessoryId,
  on: boolean,
): Promise<AccessoryOutcome> {
  const session = attachConsole(target);
  try {
    const ask = await session.send('?');
    switch (ask.kind) {
      case 'unavailable':
        return { kind: 'unavailable', id, detail: ask.detail };
      case 'error':
        return { kind: 'error', id, detail: ask.detail };
      case 'timeout':
        return { kind: 'timeout', id, detail: ask.detail };
      case 'refused':
        return { kind: 'refused', id, detail: ask.detail };
      case 'sent':
        break;
    }
    const alarm = alarmLine(ask.text) ?? alarmLine(ask.carried?.text ?? null);
    if (alarm !== null) {
      return {
        kind: 'busy',
        id,
        detail: `the controller is in an alarm (\`${alarm}\`), so nothing was sent — clear it at the machine first`,
        status: ask.text,
      };
    }
    const state = controllerState(ask.text);
    if (state === null) {
      return { kind: 'error', id, detail: `could not confirm the machine is idle before switching: its status line was not readable (${ask.text})` };
    }
    if (state.toLowerCase() !== 'idle') {
      return {
        kind: 'busy',
        id,
        detail: `it reports ${state} rather than Idle — a press mid-job fights the operator at the machine, so nothing was sent`,
        status: ask.text,
      };
    }
    const percent = jobProgressPercent(ask.text);
    if (percent !== null && percent < 100) {
      return {
        kind: 'busy',
        id,
        detail: `it reports Idle, but its status line says a program is ${percent}% through — the job has not finished, so nothing was sent`,
        status: ask.text,
      };
    }
    const result = await session.send(accessoryLine(id, on));
    switch (result.kind) {
      case 'sent':
        return { kind: 'toggled', id, on, status: ask.text };
      case 'refused':
        return { kind: 'refused', id, detail: result.detail };
      case 'timeout':
        return { kind: 'timeout', id, detail: result.detail };
      case 'error':
        return { kind: 'error', id, detail: result.detail };
      case 'unavailable':
        return { kind: 'unavailable', id, detail: result.detail };
    }
  } finally {
    await session.close();
  }
}

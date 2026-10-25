/**
 * The work-light switch (#422) — the machine's own light on or off, one press at a time.
 *
 * WHY THIS IS THE VACUUM SWITCH'S SHAPE (#390), not a new one. It is a single mode command on the
 * console seam (`attachConsole`), answered in outcomes rather than exceptions, and it asks the
 * machine what it is doing before it sends anything: a press during a job fights the operator's own
 * hands at the machine, and the card's controls all follow `uploadProgram`'s #296 rule — only an
 * explicit `Idle` is switched. `Idle` at a `P:` percent below 100 is a job still running (the
 * `M05` spin-down window, #390) and refuses too.
 *
 * NO READ-BACK, SO NO CLAIM. The status line does not report the light, so the panel remembers only
 * what it last sent this connection and says `unknown` until it has sent anything — the same honest
 * state the vacuum switch keeps. `M821`/`M822` are the firmware's work-light codes; the bench check
 * that makes them a product feature is on `#422`, and until then the switch itself is the test.
 *
 * AN ALARM REFUSES. `M821`/`M822` are lifts like any other, and a locked controller answers a lift
 * with `error:Alarm lock`; the alarm is read across the reply and the carried frames exactly as the
 * vacuum switch reads it, through `alarmLine` — one parser, no second rule.
 */

import { alarmLine, controllerState, jobProgressPercent } from './machineUpload';
import { attachConsole, type MachineConsoleTarget } from './machineConsole';

/** The work light's two codes — "light on" / "light off" (`Z1-Firmware-Dialect.md`, #422). */
export const LIGHT_ON = 'M821';
export const LIGHT_OFF = 'M822';

/** The console line for one state, in one place: the switch and its tests agree on the code. */
export function lightLine(on: boolean): string {
  return on ? LIGHT_ON : LIGHT_OFF;
}

/**
 * What one press did: `toggled` (the controller took the code), `busy` (not Idle / mid-job / in an
 * alarm — nothing sent), `refused`, `timeout`/`error` (the socket failed; the mode is UNKNOWN after
 * it belongs in the panel), `unavailable` (this build cannot reach a machine).
 */
export type LightOutcome =
  | { kind: 'toggled'; on: boolean; status: string }
  | { kind: 'busy'; detail: string; status: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'unavailable'; detail: string };

/**
 * Ask the machine to switch its work light on or off. Never throws; the guards are the vacuum
 * switch's, in the same order: ask `?`, refuse anything that is not a readable `Idle`, refuse an
 * alarm and a mid-job percent, and only then send the code — on the one connection a press opens.
 */
export async function toggleLight(target: MachineConsoleTarget, on: boolean): Promise<LightOutcome> {
  const session = attachConsole(target);
  try {
    const ask = await session.send('?');
    switch (ask.kind) {
      case 'unavailable':
        return { kind: 'unavailable', detail: ask.detail };
      case 'error':
        return { kind: 'error', detail: ask.detail };
      case 'timeout':
        return { kind: 'timeout', detail: ask.detail };
      case 'refused':
        return { kind: 'refused', detail: ask.detail };
      case 'sent':
        break;
    }
    const alarm = alarmLine(ask.text) ?? alarmLine(ask.carried?.text ?? null);
    if (alarm !== null) {
      return {
        kind: 'busy',
        detail: `the controller is in an alarm (\`${alarm}\`), so nothing was sent — clear it at the machine first`,
        status: ask.text,
      };
    }
    const state = controllerState(ask.text);
    if (state === null) {
      return {
        kind: 'error',
        detail: `could not confirm the machine is idle before switching the light: its status line was not readable (${ask.text})`,
      };
    }
    if (state.toLowerCase() !== 'idle') {
      return {
        kind: 'busy',
        detail: `it reports ${state} rather than Idle — a press mid-job fights the operator at the machine, so nothing was sent`,
        status: ask.text,
      };
    }
    const percent = jobProgressPercent(ask.text);
    if (percent !== null && percent < 100) {
      return {
        kind: 'busy',
        detail: `it reports Idle, but its status line says a program is ${percent}% through — the job has not finished, so nothing was sent`,
        status: ask.text,
      };
    }
    const result = await session.send(lightLine(on));
    switch (result.kind) {
      case 'sent':
        return { kind: 'toggled', on, status: ask.text };
      case 'refused':
        return { kind: 'refused', detail: result.detail };
      case 'timeout':
        return { kind: 'timeout', detail: result.detail };
      case 'error':
        return { kind: 'error', detail: result.detail };
      case 'unavailable':
        return { kind: 'unavailable', detail: result.detail };
    }
  } finally {
    await session.close();
  }
}

/**
 * #770 — CAMERA TO HOME: the vendor Studio control that puts the head where the machine's camera
 * sees the bed, as ONE fixed move.
 *
 * NOT A JOG (R-10 stands). The console refuses free motion by hand; a fixed, repeatable pose is a
 * different thing: it is the machine's own clearance pose, the one `G28` and the end of a tool
 * change drive to, sent as machine-coordinate lines the operator can read. No axis word is typed
 * by a person and no step is offered.
 *
 * THE POSE IS THE MACHINE'S OWN CONFIG, not a number this module invents: `coordinate.clearance_x`
 * / `_y` (where `G28` and a completed change put X and Y) and `coordinate.clearance_z` (the Z the
 * head lifts to before any clearance traverse) — read from the machine's saved calibration when it
 * has one, and from the profile's shipped frame otherwise. The caller resolves that
 * (`resolvedMachineById(id, calibration)`); this module only turns the pose into lines and says
 * which frame supplied it, so the panel can print the provenance rather than imply one.
 *
 * WHY THIS IS THE CAMERA'S POSE. The Z1's camera module is mounted on the frame looking at the
 * bed; a head parked at the clearance corner, at the safe travel height, is out of the picture.
 * That is the pose the operator wants when the pane asks "what is on the bed right now?".
 *
 * THE GUARDS ARE THE WORK-LIGHT SWITCH'S (#422), in the same order: ask `?`, refuse an alarm and
 * anything that is not a readable `Idle`, refuse a mid-job percent (an `Idle` still spinning down,
 * #390), and only then send — on the one connection a press opens, closed in a `finally`.
 */

import { alarmLine, controllerState, jobProgressPercent } from './machineUpload';
import { attachConsole, type MachineConsoleTarget } from './machineConsole';
import { zText } from './machineLaser';

/** The clearance pose, mm, in MACHINE coordinates (the frame `G53` moves in). */
export interface CameraHomePose {
  x: number;
  y: number;
  z: number;
}

/** Where the pose's numbers came from, for the sentence beside the button. */
export type CameraHomeBasis = 'calibration' | 'profile' | 'unknown-machine';

/**
 * The move, as console lines: lift in machine Z first, then X/Y at that height. Both in `G53`
 * (machine coordinates), so the pose means the same thing whatever work offset is active — the
 * clearance keys are the controller's own machine-frame numbers.
 */
export function cameraHomeLines(pose: CameraHomePose): string[] {
  return [`G53 G0 Z${zText(pose.z)}`, `G53 G0 X${zText(pose.x)} Y${zText(pose.y)}`];
}

/**
 * The provenance sentence shown with the button. It names the config keys, the numbers and the
 * frame they were read from, so an operator can tell a calibrated machine from the shipped default
 * — decision 28's rule, the same one the calibration notice follows.
 */
export function cameraHomeWords(pose: CameraHomePose, basis: CameraHomeBasis, machineName: string): string {
  const where = `X ${zText(pose.x)}, Y ${zText(pose.y)}, Z ${zText(pose.z)}`;
  if (basis === 'calibration') {
    return `The machine's clearance pose from its saved calibration — coordinate.clearance_x/y/z = ${where}, where G28 parks the head.`;
  }
  if (basis === 'profile') {
    return `The ${machineName} profile's clearance pose — coordinate.clearance_x/y/z = ${where}, the shipped frame (no calibration is saved for this machine), where G28 parks the head.`;
  }
  return `The shipped Z1 clearance pose — coordinate.clearance_x/y/z = ${where} — because this machine did not identify itself, so no machine of its own could be asked.`;
}

/**
 * What one press did: `moved` (both lines were answered), `busy` (nothing sent — not Idle, an
 * alarm, or a job still finishing), `failed` (a line was not answered, with the machine's own
 * reason), or one of the socket outcomes the console reports.
 */
export type CameraHomeOutcome =
  | { kind: 'moved'; status: string }
  | { kind: 'busy'; detail: string; status: string }
  | { kind: 'failed'; detail: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'unavailable'; detail: string };

/** Which line a failure belongs to, in the operator's words. */
const lineName = (index: number, total: number): string =>
  total === 2 && index === 0 ? 'the lift line' : total === 2 ? 'the XY line' : `line ${index + 1}`;

/**
 * Run the fixed move. Never throws. Refuses BEFORE opening a console when the lines are empty,
 * and sends nothing at all unless the machine answers `?` as an idle machine with no job.
 */
export async function runCameraHome(target: MachineConsoleTarget, lines: readonly string[]): Promise<CameraHomeOutcome> {
  if (lines.length === 0) return { kind: 'failed', detail: 'nothing was sent: the pose produced no motion lines' };
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
        detail: `could not confirm the machine is idle before moving it: its status line was not readable (${ask.text})`,
      };
    }
    if (state.toLowerCase() !== 'idle') {
      return {
        kind: 'busy',
        detail: `it reports ${state} rather than Idle — a fixed move mid-job fights the operator at the machine, so nothing was sent`,
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
    for (const [index, line] of lines.entries()) {
      const result = await session.send(line);
      if (result.kind === 'sent') continue;
      const detail = `${lineName(index, lines.length)} (\`${line}\`) was not answered: ${result.detail}`;
      return result.kind === 'unavailable' ? { kind: 'unavailable', detail } : { kind: 'failed', detail };
    }
    return { kind: 'moved', status: ask.text };
  } finally {
    await session.close();
  }
}

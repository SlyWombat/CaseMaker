/**
 * The probe laser as a user option (#431) — the laser frame, off by default.
 *
 * Maintainer decision Q21 (2026-10-15): the laser frame and the laser point-to-origin are user
 * options, off by default, and there is no camera work. The laser is the 3D probe's own red pointer:
 * `M831` on, `M832` off (from Studio's `interface_config.json`, `sw_ProbeLaser`; observed from our
 * console on 2026-10-15, frames in `docs/bench/img/2026-10-15-laser-*.jpg`). It needs the probe in
 * the spindle — it is a pointer, not a sensor.
 *
 * THE FRAME traces the program's XY extent at a safe height with the laser on, so the operator sees
 * where the job will land before anything cuts. One command per line (the console's #386 rule), the
 * head lifted in machine coordinates first, the corners in the active work offset, then the laser
 * off and a home — the bench rule is to home when an activity is done. The laser is switched off in
 * a `finally` once `M831` has gone out, whatever happened in between.
 *
 * Point-to-origin (jog the dot onto a corner, then set XY) needs a jog control and is a later slice
 * of #431; its option exists so the setting is stable, and it draws nothing yet.
 */

import { alarmLine, controllerState, jobProgressPercent } from './machineUpload';
import { attachConsole, type MachineConsoleTarget } from './machineConsole';

export const LASER_ON = 'M831';
export const LASER_OFF = 'M832';
/** The lift before any XY move: machine Z −3, the height the bench routine travels at. */
export const LASER_SAFE_Z_MACHINE = -3;

export interface XYBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** The program's XY extent, or null when the report holds no points. */
export function frameBounds(bbox: { min: readonly number[]; max: readonly number[] }): XYBounds | null {
  const [minX, minY] = bbox.min;
  const [maxX, maxY] = bbox.max;
  const all = [minX, minY, maxX, maxY];
  if (!all.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { minX: minX as number, minY: minY as number, maxX: maxX as number, maxY: maxY as number };
}

/** The frame's motion lines, pure: lift, the four corners in the work offset, and back to the first. */
export function laserFrameLines(b: XYBounds): string[] {
  const f = (n: number) => Number(n.toFixed(3)).toString();
  const corners: Array<[number, number]> = [
    [b.minX, b.minY],
    [b.maxX, b.minY],
    [b.maxX, b.maxY],
    [b.minX, b.maxY],
    [b.minX, b.minY],
  ];
  return [
    `G53 G0 Z${LASER_SAFE_Z_MACHINE}`,
    'G90',
    ...corners.map(([x, y]) => `G0 X${f(x)} Y${f(y)}`),
  ];
}

export type LaserFrameOutcome =
  | { kind: 'framed'; homed: boolean }
  | { kind: 'busy'; detail: string }
  | { kind: 'failed'; detail: string; laserOff: boolean }
  | { kind: 'unavailable'; detail: string };

/** Run the laser frame. Never throws. Refuses unless the machine is Idle with no program and no alarm. */
export async function runLaserFrame(target: MachineConsoleTarget, bounds: XYBounds): Promise<LaserFrameOutcome> {
  const session = attachConsole(target);
  let laserMaybeOn = false;
  /** A failure after the laser may be on switches it off first, and says whether that was answered. */
  const fail = async (detail: string): Promise<LaserFrameOutcome> => {
    if (!laserMaybeOn) return { kind: 'failed', detail, laserOff: true };
    const off = await session.send(LASER_OFF);
    return { kind: 'failed', detail, laserOff: off.kind === 'sent' };
  };
  try {
    const ask = await session.send('?');
    if (ask.kind === 'unavailable') return { kind: 'unavailable', detail: ask.detail };
    if (ask.kind !== 'sent') return fail(ask.detail);
    const alarm = alarmLine(ask.text) ?? alarmLine(ask.carried?.text ?? null);
    if (alarm !== null) return { kind: 'busy', detail: `the controller is in an alarm (\`${alarm}\`) — clear it at the machine first` };
    const state = controllerState(ask.text);
    const percent = jobProgressPercent(ask.text);
    if (state?.toLowerCase() !== 'idle' || (percent !== null && percent < 100)) {
      return {
        kind: 'busy',
        detail: `it reports ${state ?? 'no readable state'}${percent !== null ? ` at ${percent}%` : ''}, not an idle machine — nothing was sent`,
      };
    }
    const [lift, ...moves] = laserFrameLines(bounds);
    // Lift before the laser goes on, so the dot is never shown while the head could still be low.
    const up = await session.send(lift as string);
    if (up.kind !== 'sent') return fail(`lift: ${up.detail}`);
    laserMaybeOn = true;
    const on = await session.send(LASER_ON);
    if (on.kind !== 'sent') return fail(`laser on: ${on.detail}`);
    for (const line of moves) {
      const r = await session.send(line);
      if (r.kind !== 'sent') return fail(`${line}: ${r.detail}`);
    }
    const off = await session.send(LASER_OFF);
    if (off.kind !== 'sent') return fail(`laser off: ${off.detail}`);
    laserMaybeOn = false;
    const home = await session.send('$H');
    return { kind: 'framed', homed: home.kind === 'sent' };
  } finally {
    await session.close();
  }
}

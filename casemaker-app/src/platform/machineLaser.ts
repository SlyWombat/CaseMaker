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
 * POINT-TO-ORIGIN (#431 slice 2, {@link LaserPointSession}): lift, laser on, the operator jogs the dot
 * onto the stock's corner — X and Y only, one `G91 G0` line per step and straight back to `G90` — and
 * presses Set; after a confirmation the app writes `G10 L2 P1 X Y` from the machine position the
 * controller reports. Z0 is not touched (no Z word). The laser is switched off on EVERY way out. A home
 * follows only what the operator pressed — Finish, or Set: a failure, or the panel going away (a tab
 * switch, a selection, a form error — #423's finding), switches the laser off and MOVES NOTHING; the
 * panel then records that a home is owed and offers it as a button (`store/laserHomeStore.ts`). Its accuracy is the shop default
 * `laser.originUncertaintyMm` (±1, chosen, not measured — the dot's offset from the spindle axis is not
 * measured either and is inside that figure), and it is refused for a job whose edge margin is tighter.
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

// ---------------------------------------------------------------------------------------------------
// Point-to-origin (#431 slice 2).

/** The jog steps offered, mm. Nothing finer: the dot itself is only good to about a millimetre. */
export const LASER_JOG_STEPS = [10, 1, 0.1] as const;
export type JogStep = (typeof LASER_JOG_STEPS)[number];

/** The machine position from a status line's `MPos:x,y,z`, or null. */
export function machinePosition(text: string | null): { x: number; y: number; z: number } | null {
  const m = /MPos:(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/.exec(text ?? '');
  if (!m) return null;
  const [x, y, z] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return [x, y, z].every(Number.isFinite) ? { x, y, z } : null;
}

/** Whether point-to-origin may be offered for a job: its edge margin must be no tighter than the dot. */
export function pointToOriginAllowed(jobMarginMm: number, uncertaintyMm: number): { ok: true } | { ok: false; reason: string } {
  return jobMarginMm >= uncertaintyMm
    ? { ok: true }
    : {
        ok: false,
        reason: `the job keeps only ${jobMarginMm} mm from the stock's edge, tighter than the laser dot's ±${uncertaintyMm} mm (laser.originUncertaintyMm) — register with the probe instead`,
      };
}

export type PointStep = { ok: true; detail: string } | { ok: false; detail: string; homeOwed?: boolean };

/**
 * One point-to-origin session on a machine: `begin` (Idle check, lift, laser on), `jog` (X/Y only),
 * `set` (after confirmation: `G10 L2 P1 X Y` from the reported machine position), `end` (laser off,
 * home — always; safe to call twice). One command at a time: a press while one is in flight is refused.
 */
export class LaserPointSession {
  private session: ReturnType<typeof attachConsole> | null = null;
  private laserMaybeOn = false;
  private lifted = false;
  private busy = false;
  private ended = false;

  private readonly target: MachineConsoleTarget;

  constructor(target: MachineConsoleTarget) {
    this.target = target;
  }

  get active(): boolean {
    return this.lifted && !this.ended;
  }

  private async one<T>(work: () => Promise<T>, refused: T): Promise<T> {
    if (this.busy) return refused;
    this.busy = true;
    try {
      return await work();
    } finally {
      this.busy = false;
    }
  }

  /** The machine must be Idle, with no program and no alarm. Then the lift, then the laser. */
  begin(): Promise<PointStep> {
    return this.one(async () => {
      if (this.ended || this.session !== null) return { ok: false, detail: 'this session has already started' };
      this.session = attachConsole(this.target);
      const ask = await this.session.send('?');
      if (ask.kind !== 'sent') return this.abort(ask.kind === 'unavailable' ? ask.detail : `status: ${ask.detail}`);
      const alarm = alarmLine(ask.text) ?? alarmLine(ask.carried?.text ?? null);
      if (alarm !== null) return this.abort(`the controller is in an alarm (\`${alarm}\`) — clear it at the machine first`);
      const state = controllerState(ask.text);
      const percent = jobProgressPercent(ask.text);
      if (state?.toLowerCase() !== 'idle' || (percent !== null && percent < 100)) {
        return this.abort(`it reports ${state ?? 'no readable state'}${percent !== null ? ` at ${percent}%` : ''}, not an idle machine — nothing was sent`);
      }
      const up = await this.session.send(`G53 G0 Z${LASER_SAFE_Z_MACHINE}`);
      if (up.kind !== 'sent') return this.abort(`lift: ${up.detail}`);
      this.lifted = true;
      this.laserMaybeOn = true;
      const on = await this.session.send(LASER_ON);
      if (on.kind !== 'sent') return this.abort(`laser on: ${on.detail}`);
      return { ok: true, detail: `Lifted to machine Z ${LASER_SAFE_Z_MACHINE}, laser on. Jog the dot onto the stock's corner.` };
    }, { ok: false, detail: 'another command is still going' });
  }

  /** One step in X or Y — never Z — as one relative line, then straight back to absolute. */
  jog(axis: 'X' | 'Y', step: number): Promise<PointStep> {
    return this.one(async () => {
      if (!this.active || this.session === null) return { ok: false, detail: 'not started: lift and switch the laser on first' };
      if (!(LASER_JOG_STEPS as readonly number[]).includes(Math.abs(step))) return { ok: false, detail: `${step} mm is not one of the jog steps` };
      const rel = await this.session.send('G91');
      if (rel.kind !== 'sent') return this.abort(`G91: ${rel.detail}`);
      const move = await this.session.send(`G0 ${axis}${Number(step.toFixed(3))}`);
      const back = await this.session.send('G90');
      if (move.kind !== 'sent') return this.abort(`jog: ${move.detail}`);
      if (back.kind !== 'sent') return this.abort(`G90: ${back.detail}`);
      return { ok: true, detail: `Jogged ${axis} ${step > 0 ? '+' : ''}${step} mm.` };
    }, { ok: false, detail: 'another command is still going — wait for it' });
  }

  /**
   * Write the XY origin where the dot is: only after `confirmed`, only when the machine reads Idle, from
   * the MACHINE position it reports. No Z word: Z0 is unchanged.
   */
  set(confirmed: boolean): Promise<PointStep & { x?: number; y?: number }> {
    return this.one(async (): Promise<PointStep & { x?: number; y?: number }> => {
      if (!this.active || this.session === null) return { ok: false, detail: 'not started' };
      if (confirmed !== true) return { ok: false, detail: 'the origin is written only after you confirm it' };
      const ask = await this.session.send('?');
      if (ask.kind !== 'sent') return this.abort(`status: ${ask.detail}`);
      if (controllerState(ask.text)?.toLowerCase() !== 'idle') return { ok: false, detail: `the machine reads ${controllerState(ask.text) ?? 'no state'}, not Idle — wait for the jog to finish` };
      const p = machinePosition(ask.text);
      if (p === null) return { ok: false, detail: 'the status line gave no machine position, so nothing was written' };
      const f = (n: number) => n.toFixed(3);
      const line = `G10 L2 P1 X${f(p.x)} Y${f(p.y)}`;
      const w = await this.session.send(line);
      if (w.kind !== 'sent' || /error|alarm/i.test(w.text)) return this.abort(`${line}: ${w.kind === 'sent' ? w.text.trim() : w.detail}`);
      return { ok: true, detail: `Wrote ${line} — X and Y only; Z0 is unchanged.`, x: p.x, y: p.y };
    }, { ok: false, detail: 'another command is still going — wait for it' });
  }

  /**
   * Laser off, then — only when `home` (the operator pressed Finish or Set) — home, then close. Always
   * safe; a second call does nothing. `lifted` says whether a home is owed when none was sent.
   */
  async end(opts: { home: boolean }): Promise<{ laserOff: boolean; homed: boolean; lifted: boolean }> {
    if (this.ended) return { laserOff: !this.laserMaybeOn, homed: false, lifted: this.lifted };
    this.ended = true;
    const s = this.session;
    if (s === null) return { laserOff: true, homed: false, lifted: false };
    try {
      let laserOff = !this.laserMaybeOn;
      if (this.laserMaybeOn) {
        const off = await s.send(LASER_OFF);
        laserOff = off.kind === 'sent';
        if (laserOff) this.laserMaybeOn = false;
      }
      const home = this.lifted && opts.home ? await s.send('$H') : null;
      return { laserOff, homed: home !== null && home.kind === 'sent', lifted: this.lifted };
    } finally {
      await s.close();
    }
  }

  /** A failure: laser off (if it may be on) — NO motion — and say so; a lifted head owes a home. */
  private async abort(detail: string): Promise<PointStep> {
    const r = await this.end({ home: false });
    const laser = this.lifted ? (r.laserOff ? ' The laser is off.' : ' The laser may still be on — send M832 or switch it off at the machine.') : '';
    return { ok: false, detail: `${detail}.${laser}${this.lifted ? ' Home the machine before the next step.' : ''}`, homeOwed: this.lifted };
  }
}

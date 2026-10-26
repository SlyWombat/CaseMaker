/**
 * #693 — the machine's half of the change-the-machine wizard: the three questions step 2 asks with
 * command lines, and the state the controller answers with.
 *
 * THE ONE CLIENT IS `machineConsole`'s. `attachConsole` is the seam the registration executor, the
 * Stop button and the console panel already use; a second way to open a socket to the machine would
 * be a second set of guards, timeouts and failure words. `toggleLight` is `machineLight.ts`'s own
 * implementation — the work light already has one home (#422), and it asks the machine before it
 * sends anything.
 *
 * WHAT "HOMED" MEANS HERE. The controller's status line has no homed flag. What it has is the state
 * word and `MPos`: after `$H` the Z1 reports `Idle` at its homed rest, `MPos:-1.0000,-1.0000,-1.0000`
 * (bench, 2026-10-12 and every night since; the same reading the status strip prints on hover). So a
 * machine is read as homed when it is `Idle` AND its machine position is the homed rest. `Idle`
 * alone is not enough — the machine is Idle at the end of a program away from home — and that is why
 * the wizard polls for the pair after `$H` rather than trusting the macro's first reply.
 *
 * NO SOCKET IN A TEST. `setMachineConsoleLoader` (`machineConsole.ts`) swaps only the transport: the
 * guard, the poll loop and the reading of each status line are the real code in every test.
 */

import { STATUS_POLL_TIMING, attachConsole, type ConsoleTiming } from './machineConsole';
import { alarmLine, controllerState } from './machineUpload';

/** One status line, read for the three things step 2 needs. */
export interface MachineRest {
  /** The controller's line, verbatim (for the transcript and the hover). */
  text: string;
  /** The state word (`Idle`, `Home`, `Alarm`…), or null when the line was not readable. */
  state: string | null;
  /** `MPos` X/Y/Z, mm, as the line reports them; null when the field is absent. */
  x: number | null;
  y: number | null;
  z: number | null;
  /** `Idle` at the controller's homed rest, which is the machine's own answer to "home". */
  homed: boolean;
}

/**
 * The homed rest the Z1 reports after `$H`, mm — the controller's own position, not a shop setting:
 * the firmware homes to its minimums and reports −1 on every axis (`docs/bench/2026-10-bench-day-1.md`
 * §B4). The tolerance only absorbs the fourth decimal.
 */
const HOMED_REST_MM = -1;
const HOMED_REST_TOLERANCE_MM = 0.01;

/** `KEY:value` out of a status line, or null — the fields are `|`-separated. */
function statusField(text: string, key: string): string | null {
  const m = new RegExp(`(?:^|\\|)${key}:([^|>]*)`).exec(text);
  return m === null ? null : (m[1] ?? null);
}

function axis(parts: readonly string[], i: number): number | null {
  const raw = parts[i]?.trim();
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

/**
 * Read one `?` answer. Null when the text carries no state word at all: an unreadable line is not
 * "Idle" and never becomes a tick. Kept beside `readStatusLine` (`desktop/protocol.ts`, the desktop
 * module) on purpose — this module is in the web bundle — and `machineChangeRun.spec.ts` runs both
 * over the bench's own lines so the two readings cannot drift.
 */
export function readMachineRest(text: string | null): MachineRest | null {
  if (text === null) return null;
  const state = controllerState(text);
  if (state === null) return null;
  const parts = (statusField(text, 'MPos') ?? '').split(',');
  const x = axis(parts, 0);
  const y = axis(parts, 1);
  const z = axis(parts, 2);
  const atRest =
    x !== null &&
    y !== null &&
    z !== null &&
    Math.abs(x - HOMED_REST_MM) <= HOMED_REST_TOLERANCE_MM &&
    Math.abs(y - HOMED_REST_MM) <= HOMED_REST_TOLERANCE_MM &&
    Math.abs(z - HOMED_REST_MM) <= HOMED_REST_TOLERANCE_MM;
  return { text, state, x, y, z, homed: state === 'Idle' && atRest };
}

/** What one status check concluded. */
export type MachineAnswer =
  | { kind: 'ok'; rest: MachineRest; text: string }
  | { kind: 'no'; detail: string };

/** Ask the machine what it is doing, on one connection, and close it. */
export async function checkMachine(
  target: { host: string; port: number },
  timing: ConsoleTiming = STATUS_POLL_TIMING,
): Promise<MachineAnswer> {
  const session = attachConsole(target);
  try {
    const r = await session.send('?', timing);
    if (r.kind !== 'sent') return { kind: 'no', detail: r.detail };
    const alarm = alarmLine(r.text) ?? alarmLine(r.carried?.text ?? null);
    if (alarm !== null) return { kind: 'no', detail: `the controller is in an alarm (${alarm})` };
    const rest = readMachineRest(r.text);
    if (rest === null) return { kind: 'no', detail: 'its status line was not readable' };
    return { kind: 'ok', rest, text: r.text };
  } finally {
    await session.close();
  }
}

/** What asking the machine to home came to. */
export type HomeAnswer =
  | { kind: 'homed'; rest: MachineRest; text: string }
  | { kind: 'failed'; detail: string };

export interface HomeOptions {
  /** Status polls to wait for Idle-at-rest after `$H`. Default 30. */
  polls?: number;
  /** Wait between those polls, ms. Default 2000 — the status poll floor (`MIN_STATUS_POLL_MS`). */
  pollMs?: number;
}

export const HOME_POLLS = 30;
export const HOME_POLL_MS = 2000;

const sleep = (ms: number): Promise<void> => (ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)));

/** The sentence for a machine that did not report home within the window. */
function notHomed(last: MachineRest | null): string {
  if (last === null) return 'the machine did not answer a readable status line while homing';
  if (last.state !== 'Idle') return `the machine reads ${last.state ?? 'no state'} rather than Idle`;
  const at = [last.x, last.y, last.z].map((v) => (v === null ? '—' : String(Number(v.toFixed(3))))).join(', ');
  return `the machine is Idle at ${at}, not at its homed rest`;
}

/**
 * Home the machine and wait for its own answer: ask `?` first (nothing homes a machine that is
 * running or alarmed), `$H` only from `Idle`, then `?` until the state is `Idle` at the homed rest.
 * A macro's reply can arrive before the head has finished moving, so the poll is the answer — not
 * the command's acknowledgement.
 */
export async function homeMachine(
  target: { host: string; port: number },
  opts: HomeOptions = {},
): Promise<HomeAnswer> {
  const polls = Number.isInteger(opts.polls) && opts.polls! >= 1 ? opts.polls! : HOME_POLLS;
  const pollMs = Number.isFinite(opts.pollMs) ? Math.max(0, opts.pollMs!) : HOME_POLL_MS;
  const session = attachConsole(target);
  try {
    // The registration executor's order (#430): a status line must read Idle before anything moves.
    const ask = await session.send('?', STATUS_POLL_TIMING);
    if (ask.kind !== 'sent') return { kind: 'failed', detail: ask.detail };
    const alarmFirst = alarmLine(ask.text) ?? alarmLine(ask.carried?.text ?? null);
    if (alarmFirst !== null) return { kind: 'failed', detail: `the controller is in an alarm (${alarmFirst})` };
    const before = readMachineRest(ask.text);
    if (before === null) return { kind: 'failed', detail: 'its status line was not readable' };
    if (before.state !== 'Idle') {
      return { kind: 'failed', detail: `the machine reads ${before.state} rather than Idle — home it once it has stopped` };
    }
    if (before.homed) return { kind: 'homed', rest: before, text: ask.text };

    const sent = await session.send('$H');
    if (sent.kind === 'refused' || sent.kind === 'unavailable' || sent.kind === 'error') {
      return { kind: 'failed', detail: sent.detail };
    }
    const alarm = alarmLine(sent.text) ?? alarmLine(sent.carried?.text ?? null);
    if (alarm !== null) return { kind: 'failed', detail: `the controller is in an alarm (${alarm})` };
    // A macro that answered inside the quiet window may already show the finished rest.
    const first = readMachineRest(sent.text);
    if (first !== null && first.homed) return { kind: 'homed', rest: first, text: sent.text };

    let last: MachineRest | null = first;
    for (let i = 0; i < polls; i++) {
      await sleep(pollMs);
      const r = await session.send('?', STATUS_POLL_TIMING);
      if (r.kind !== 'sent') {
        // A dropped poll is not the end: the socket may be between replies, and the window is the
        // caller's. Keep the last reading and try the next poll.
        continue;
      }
      const more = alarmLine(r.text) ?? alarmLine(r.carried?.text ?? null);
      if (more !== null) return { kind: 'failed', detail: `the controller is in an alarm (${more})` };
      const rest = readMachineRest(r.text);
      if (rest === null) continue;
      last = rest;
      if (rest.homed) return { kind: 'homed', rest, text: r.text };
    }
    return { kind: 'failed', detail: notHomed(last) };
  } finally {
    await session.close();
  }
}

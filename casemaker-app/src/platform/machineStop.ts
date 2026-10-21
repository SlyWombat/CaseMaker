/**
 * The Stop button (#424) — `abort` for a running program, labelled for what it is.
 *
 * WHAT IT SENDS AND WHY THAT WORD. `abort` is what Studio's own grey Stop sends, observed on the
 * bench and already the harness's Ctrl-C (`tools/z1/z1.mjs run`, docs/cnc-guide.md §2). The
 * controller stops the spindle at once, then finishes the moves it had already queued (~18 s on
 * 2026-10-12, #303) before it answers. So this is NOT an emergency stop: the machine's own red button
 * is, and the label says so (maintainer decision Q16, 2026-10-15). #303 refines it once Studio's
 * other stops are recorded.
 *
 * WHAT IT DOES AFTER. An aborted program never reaches its own `M332`, so the vacuum it switched on
 * stays on. Once the controller reads `Idle` again, this sends `M332` itself — the one line it adds
 * that the program did not ask for, exactly as the harness does. If the controller never comes back
 * to `Idle` within the polls, `M332` is NOT sent and the outcome says the vacuum is still on.
 *
 * Homing afterwards is offered by the panel as its own press, never sent from here: it is motion,
 * and the person who pressed Stop decides when the head moves again.
 *
 * WHEN IT ABORTS, AND WHEN IT DOES NOT (#423 review). Anything but a machine at rest is aborted: a
 * status line with a `P:` percent below 100, AND a `Run` line with no `P:` or with `P:` at 100 (the
 * trip home after a program's end) — a machine that is moving is never read as finished. Only
 * `Idle` with no program in progress is "not running", and gets nothing: sending `abort` there would
 * be a line with no purpose. An alarm is reported, not acted on — a locked controller needs the
 * machine. Its status polls use the short status window and keep the 2 s floor (#386).
 *
 * `stopOnSession` is the same stop on a session the caller holds — the run screen's (#423), which
 * stops the program it is watching on its own connection.
 */

import { alarmLine, controllerState, jobProgressPercent } from './machineUpload';
import {
  attachConsole,
  STATUS_POLL_TIMING,
  statusPollTimingFrom,
  type ConsoleHandle,
  type ConsoleTiming,
  type MachineConsoleTarget,
} from './machineConsole';
import { ANTISTATIC_OFF, VACUUM_OFF } from './machineVacuum';
import { readDefault, type ShopDefaults } from './defaultsClient';

export const ABORT_LINE = 'abort';

/**
 * After `abort` is answered: polls for `Idle`, and the wait between them (the harness's numbers). The
 * labelled NO-SERVICE FALLBACKS of the shop's `stop.idlePolls` / `stop.idlePollMs` (#449).
 */
export const STOP_IDLE_POLLS = 3;
export const STOP_IDLE_POLL_MS = 5000;
/**
 * How long `abort` itself is given to answer — the labelled NO-SERVICE FALLBACK of the shop's
 * `stop.abortReplyMs` (#449). The controller stops the spindle at once, then drains the moves already
 * queued (~18 s observed, #303) before it answers, so 60 s is where the app's Stop always sat (the
 * console's own first-reply window). The maintainer, 2026-10-16: the app reads the shop's number too,
 * so it and the bench harness share one.
 */
export const STOP_ABORT_REPLY_MS = 60_000;
/** The status poll's floor after the abort (#386: never faster than 2 s). Compiled; a setting only raises it. */
export const STOP_POLL_FLOOR_MS = 2000;

/** What a stop polls with (#449): the shop's `stop.*` and the status-poll window. */
export interface StopSettings {
  idlePolls: number;
  idlePollMs: number;
  /** The `abort` reply window (#449): `stop.abortReplyMs`. */
  abortReplyMs: number;
  statusTiming: ConsoleTiming;
}

export const STOP_FALLBACK: Readonly<StopSettings> = {
  idlePolls: STOP_IDLE_POLLS,
  idlePollMs: STOP_IDLE_POLL_MS,
  abortReplyMs: STOP_ABORT_REPLY_MS,
  statusTiming: STATUS_POLL_TIMING,
};

/** The stop's settings from the shop's defaults — the labelled fallbacks with no location. */
export function stopSettings(defaults: ShopDefaults | null): StopSettings {
  return {
    idlePolls: readDefault(defaults, 'stop.idlePolls').value,
    idlePollMs: readDefault(defaults, 'stop.idlePollMs').value,
    abortReplyMs: readDefault(defaults, 'stop.abortReplyMs').value,
    statusTiming: statusPollTimingFrom(defaults),
  };
}

/**
 * The settings as a stop USES them, whatever was passed: a whole number of polls, at least one (a
 * stop never gives up without asking once), never a wait under the 2 s floor (#386), and a finite
 * `abort` window (a hand-built setting with none falls back to the compiled one).
 */
function safeStop(s: StopSettings): StopSettings {
  return {
    idlePolls: Number.isInteger(s.idlePolls) && s.idlePolls >= 1 ? s.idlePolls : STOP_IDLE_POLLS,
    idlePollMs: Number.isFinite(s.idlePollMs) ? Math.max(STOP_POLL_FLOOR_MS, s.idlePollMs) : STOP_IDLE_POLL_MS,
    abortReplyMs: Number.isFinite(s.abortReplyMs) ? s.abortReplyMs : STOP_ABORT_REPLY_MS,
    // Never a shorter reply window than the compiled one (#449 review): the FIRST `?` decides whether
    // `abort` is sent at all, and a timeout there returns without sending it.
    statusTiming: {
      ...s.statusTiming,
      firstReplyMs: Math.max(STATUS_POLL_TIMING.firstReplyMs, s.statusTiming.firstReplyMs),
      maxMs: Math.max(STATUS_POLL_TIMING.maxMs, s.statusTiming.maxMs),
    },
  };
}

/**
 * What one press did:
 *   - `stopped` — `abort` was answered and the controller came back to `Idle`. `vacuumOff` says
 *     whether the follow-up `M332` was answered too.
 *   - `draining` — `abort` went out but `Idle` was not seen in time: the spindle is stopping, the
 *     queue may still be running, and `M332` has NOT been sent.
 *   - `not-running` — no program is running, so nothing was sent.
 *   - `alarm` — the controller is in an alarm; nothing was sent.
 *   - `timeout` / `error` / `unavailable` — the socket failed or this build cannot reach a machine.
 */
export type StopOutcome =
  | { kind: 'stopped'; vacuumOff: boolean; antistaticOff?: boolean; status: string }
  | { kind: 'draining'; detail: string }
  | { kind: 'not-running'; status: string }
  | { kind: 'alarm'; detail: string; status: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'unavailable'; detail: string };

/** True when a status line says a program is running: a `P:` percent below 100. */
export function programRunning(status: string): boolean {
  const percent = jobProgressPercent(status);
  return percent !== null && percent < 100;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Stop the running program. Never throws: every failure is an outcome. `sleep` is injectable so a
 * test does not wait the real 5 s between polls.
 */
export async function stopProgram(
  target: MachineConsoleTarget,
  sleep: (ms: number) => Promise<void> = realSleep,
  settings: StopSettings = STOP_FALLBACK,
): Promise<StopOutcome> {
  const session = attachConsole(target);
  try {
    return await stopOnSession(session, sleep, settings);
  } finally {
    await session.close();
  }
}

/**
 * The stop itself, on a session the caller already holds (#423): the run screen stops the program
 * it is watching on its OWN connection, at a poll boundary, rather than opening a second one beside
 * it. Same rule as {@link stopProgram}: `?` first, abort only a running program, refuse an alarm, and
 * `M332` only after a poll reads `Idle`. `antistatic` (#564) also sends `M332.4` there, when the run
 * that was stopped is a plastic job whose antistatic the run switched on.
 */
export async function stopOnSession(
  session: Pick<ConsoleHandle, 'send'>,
  sleep: (ms: number) => Promise<void> = realSleep,
  settings: StopSettings = STOP_FALLBACK,
  antistatic: boolean = false,
): Promise<StopOutcome> {
  const { idlePolls, idlePollMs, abortReplyMs, statusTiming } = safeStop(settings);
  const ask = await session.send('?', statusTiming);
  if (ask.kind !== 'sent') {
    return ask.kind === 'refused' ? { kind: 'error', detail: ask.detail } : { kind: ask.kind, detail: ask.detail };
  }
  const alarm = alarmLine(ask.text) ?? alarmLine(ask.carried?.text ?? null);
  if (alarm !== null) {
    return {
      kind: 'alarm',
      detail: `the controller is in an alarm (\`${alarm}\`), so nothing was sent — use the machine's own button`,
      status: ask.text,
    };
  }
  // NOT RUNNING means Idle with no program in progress (#423 review). A `Run` line with no `P`, or with
  // `P` at 100 (the trip home after the program's end), is a machine that is moving: it is aborted like
  // a program, never treated as finished.
  const askState = controllerState(ask.text);
  if (askState !== null && askState.toLowerCase() === 'idle' && !programRunning(ask.text)) {
    return { kind: 'not-running', status: ask.text };
  }

  // `abort` is answered only once the queue it already had has drained, so it gets the shop's
  // `stop.abortReplyMs`, not a console line's window (#449; the harness's `run` gives it the same).
  const aborted = await session.send(ABORT_LINE, { firstReplyMs: abortReplyMs, maxMs: abortReplyMs });
  if (aborted.kind !== 'sent' && aborted.kind !== 'timeout') {
    return aborted.kind === 'refused'
      ? { kind: 'error', detail: aborted.detail }
      : { kind: aborted.kind, detail: aborted.detail };
  }
  // An unanswered `abort` is not a failed one: the controller answers only once its queue drains.
  // Either way, `Idle` on a status poll is what lets `M332` go out.
  for (let i = 0; i < idlePolls; i++) {
    // The status floor holds here too (#386): never a `?` within 2 s of the line before it.
    if (i === 0) await sleep(STOP_POLL_FLOOR_MS);
    const poll = await session.send('?', statusTiming);
    if (poll.kind === 'sent') {
      const state = controllerState(poll.text);
      if (state !== null && state.toLowerCase() === 'idle' && !programRunning(poll.text)) {
        const off = await session.send(VACUUM_OFF);
        const antiOff = antistatic ? await session.send(ANTISTATIC_OFF) : null;
        return {
          kind: 'stopped',
          vacuumOff: off.kind === 'sent',
          ...(antiOff === null ? {} : { antistaticOff: antiOff.kind === 'sent' }),
          status: poll.text,
        };
      }
    }
    if (i + 1 < idlePolls) await sleep(idlePollMs);
  }
  return {
    kind: 'draining',
    detail:
      '`abort` went out and the spindle is stopping, but the controller has not reported Idle yet — the vacuum is ' +
      'still on (`M332` was not sent). Wait for the head to stop, then switch the vacuum off.',
  };
}

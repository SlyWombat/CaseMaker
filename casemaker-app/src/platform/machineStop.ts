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
 * WHEN IT REFUSES. Only a running program is stopped: a status line with a `P:` percent below 100.
 * An `Idle` line with no `P:` has nothing to abort, and sending `abort` there would be a line with
 * no purpose. An alarm is reported, not acted on — a locked controller needs the machine.
 */

import { alarmLine, controllerState, jobProgressPercent } from './machineUpload';
import { attachConsole, type MachineConsoleTarget } from './machineConsole';
import { VACUUM_OFF } from './machineVacuum';

export const ABORT_LINE = 'abort';

/** After `abort` is answered: polls for `Idle`, and the wait between them (the harness's numbers). */
export const STOP_IDLE_POLLS = 3;
export const STOP_IDLE_POLL_MS = 5000;

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
  | { kind: 'stopped'; vacuumOff: boolean; status: string }
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
): Promise<StopOutcome> {
  const session = attachConsole(target);
  try {
    const ask = await session.send('?');
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
    if (!programRunning(ask.text)) return { kind: 'not-running', status: ask.text };

    const aborted = await session.send(ABORT_LINE);
    if (aborted.kind !== 'sent' && aborted.kind !== 'timeout') {
      return aborted.kind === 'refused'
        ? { kind: 'error', detail: aborted.detail }
        : { kind: aborted.kind, detail: aborted.detail };
    }
    // An unanswered `abort` is not a failed one: the controller answers only once its queue drains.
    // Either way, `Idle` on a status poll is what lets `M332` go out.
    for (let i = 0; i < STOP_IDLE_POLLS; i++) {
      const poll = await session.send('?');
      if (poll.kind === 'sent') {
        const state = controllerState(poll.text);
        if (state !== null && state.toLowerCase() === 'idle' && !programRunning(poll.text)) {
          const off = await session.send(VACUUM_OFF);
          return { kind: 'stopped', vacuumOff: off.kind === 'sent', status: poll.text };
        }
      }
      if (i + 1 < STOP_IDLE_POLLS) await sleep(STOP_IDLE_POLL_MS);
    }
    return {
      kind: 'draining',
      detail:
        '`abort` went out and the spindle is stopping, but the controller has not reported Idle yet — the vacuum is ' +
        'still on (`M332` was not sent). Wait for the head to stop, then switch the vacuum off.',
    };
  } finally {
    await session.close();
  }
}

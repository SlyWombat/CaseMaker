/**
 * The vacuum switch (#390) — the machine's own extraction on or off, one press at a time.
 *
 * WHY THIS IS NOT JUST TWO LINES FROM THE CONSOLE PANEL. The program already turns the vacuum on
 * for every cut (#283: the post writes `M331` at the start and `M332` at the end), and the
 * maintainer's other half is a control for CLEANING — "the hose can be used to clean out the unit or
 * parts" — with no job running. It is a command to the machine, so it belongs on the same seam the
 * console uses (`attachConsole`), is gated the same way, and answers in outcomes rather than
 * exceptions, exactly as `machineUpload.ts` and `machineProbe.ts` do.
 *
 * THE ONE RULE: ONLY AN IDLE MACHINE IS SWITCHED. This is `uploadProgram`'s rule (#296), asked the
 * same way and for a sharper reason here: a program OWNS the vacuum while it runs — it wrote its own
 * `M331` and will write its own `M332` — so a switch pressed mid-job fights the program for the same
 * mode. The machine is therefore asked what it is doing first, and only an explicit `Idle` passes.
 * Busy, silence and an unreadable status line all refuse, because "I could not tell" is not
 * permission. The state word is read with `controllerState`, the one parser for a status line, and
 * not with a second one written here.
 *
 * AND IDLE ALONE IS NOT ENOUGH (#390). The state word reads `Idle` MID-JOB — for the ~4 s spin-down at
 * `M05`, before the head goes home (`Z1-Bridge-Protocol.md` §6) — so an `Idle` with a `P:` percent
 * below 100 is a job that is still running, and a press there would send `M331` after the program's
 * own `M332` had already gone out: the vacuum would stay on with nothing left to switch it off. The
 * percent is read off the same line, by `jobProgressPercent`, beside the state word and in the same
 * module, so there is still exactly one parser for a status line.
 *
 * WHAT A REFUSAL COSTS. The ask is one line (`?`) on the session's own connection; a refusal sends
 * nothing further and the connection is closed (the `finally`). So a press on a running machine
 * costs one poll and no command, and a press on an idle one is `?` then `M331`/`M332` on the SAME
 * connection — one connect per press, which is also why this does not lean on the panel's own
 * console handle: a control that opens and closes its own socket cannot interleave with the console's
 * replies, and one command channel (`Z1-Bridge-Protocol.md` §1) is not shared between two senders.
 *
 * AND AN ALARM REFUSES, wherever its words appear. A locked controller answers a lift with
 * `error:Alarm lock` (`Z1-Firmware-Dialect.md` §11.9), and the words do not always sit in the state
 * word: the 2026-10-12 trace has `ALARM: Probe fail` as a line of its own, and `M491`'s tail —
 * `ERROR: Probe dead or not set…` — arrives with no line in flight at all (#386 item 3). The ask is
 * therefore read for an alarm across the reply AND the carried frames, and either one refuses. That
 * is the whole of the carried rule here: it changes where text is SHOWN, never whether it is acted
 * on.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not remember anything: "what did I last send" is the panel's
 * fact, not the socket's, because there is no read-back — the status line does not report the vacuum
 * mode (bench, 2026-10-12), so no amount of polling could recover it. It also does not run a job;
 * the MANUAL switch stays the bare `M331`/`M332` pair. The antistatic's `M331.4`/`M332.4` are
 * exported as constants here (#564) but only the run drives them; the rest of the `M331.x` family
 * (blowing, bed cleaning) stays unmodelled (`Z1-Firmware-Dialect.md` §11.3, #283).
 */

import { alarmLine, controllerState, jobProgressPercent } from './machineUpload';
import { attachConsole, type MachineConsoleTarget } from './machineConsole';

/** The machine's bare `M331`/`M332` — "turning extend out mode on/off", the vacuum (#283). */
export const VACUUM_ON = 'M331';
export const VACUUM_OFF = 'M332';

/**
 * The `M331.4`/`M332.4` sub-codes — "turning static electricity removal mode on/off", the antistatic
 * (static-removal) device (#564, `/Z1-Firmware-Dialect.md` §11.3). A separable mode in the same
 * accessory family, independent of the bare vacuum above. The run emits them for plastic jobs
 * (`machineRun.ts`); the manual vacuum switch stays the bare pair and never touches these.
 */
export const ANTISTATIC_ON = 'M331.4';
export const ANTISTATIC_OFF = 'M332.4';

/** The console line for one state, in one place: the switch and any test agree on the code. */
export function vacuumLine(on: boolean): string {
  return on ? VACUUM_ON : VACUUM_OFF;
}

/**
 * What one press did. Six answers, and the split is what the panel renders:
 *
 *   - `toggled` — the machine took the code. `on` is the state now, and `status` is the idle line
 *     that let it start (verbatim, as `uploadProgram` carries it).
 *   - `busy` — the machine answered and a program still owns the vacuum: a state word that is not
 *     `Idle`, an `Idle` line whose `P:` percent says the job has not finished (see below), or a
 *     controller that is in an alarm. Nothing was sent; `status` is its line.
 *   - `refused` — the guards refused the line (never the case for `M331`/`M332` today, mapped rather
 *     than asserted away so a divergence is an answer and not a crash).
 *   - `timeout` / `error` — the socket failed, or the exchange went where the protocol does not
 *     allow. The mode is UNKNOWN afterwards: the ask or the code may have gone out.
 *   - `unavailable` — nothing was attempted: this build cannot reach a machine at all.
 */
export type VacuumOutcome =
  | { kind: 'toggled'; on: boolean; status: string }
  | { kind: 'busy'; detail: string; status: string }
  | { kind: 'refused'; detail: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'unavailable'; detail: string };

/**
 * Ask the machine to switch its vacuum on or off. Never throws: every failure is one of the six
 * outcomes, because the panel has to render a failure as readily as a success.
 *
 * The order is the safety rule: ask `?` first, refuse anything that is not a readable `Idle`, and
 * only then send the code. A running program is thereby left alone.
 */
export async function toggleVacuum(target: MachineConsoleTarget, on: boolean): Promise<VacuumOutcome> {
  return guardedMode(target, on ? VACUUM_ON : VACUUM_OFF, 'vacuum');
}

/**
 * #564/#648 — the antistatic (static-removal) device, the same guarded seam and the same rule as the
 * vacuum: `M331.4` on, `M332.4` off, only on an explicit Idle with no program running, an alarm
 * refusing before anything is sent. One implementation (`guardedMode`), so the two modes cannot
 * drift apart in what they will accept.
 */
export async function toggleAntistatic(target: MachineConsoleTarget, on: boolean): Promise<VacuumOutcome> {
  return guardedMode(target, on ? ANTISTATIC_ON : ANTISTATIC_OFF, 'antistatic device');
}

/** The guard + send every mode command shares. `what` names the mode in the refusal sentences. */
async function guardedMode(target: MachineConsoleTarget, code: string, what: string): Promise<VacuumOutcome> {
  const session = attachConsole(target);
  try {
    // 1. What is the machine doing NOW? `uploadProgram`'s rule, over the console's own connection
    //    rather than a second one, because the console is how a line reaches the controller here.
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
    // 1a. AN ALARM REFUSES, and it is asked over BOTH halves of what came back: the reply's own text
    //     and anything that arrived with no line in flight (the session hands the second back as
    //     `carried`, #386 item 3). A machine that has locked itself — `ALARM: Probe fail`, the `M491`
    //     tail's `ERROR: Probe dead or not set…` — refuses a lift with `error:Alarm lock`
    //     (`Z1-Firmware-Dialect.md` §11.9), and switching the vacuum is no more welcome. Carrying
    //     only changes where that text is SHOWN, never whether it is acted on, so the same test runs
    //     over both and the sentence quotes the machine's own line.
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
        detail: `could not confirm the machine is idle before switching ${what}: its status line was not readable (${ask.text})`,
      };
    }
    if (state.toLowerCase() !== 'idle') {
      return {
        kind: 'busy',
        detail: `it reports ${state} rather than Idle — a program owns the ${what} while it runs, so nothing was sent`,
        status: ask.text,
      };
    }
    // 1b. IDLE IS NOT ENOUGH, and this is the window the state word hides (#390). The line reads
    //     `<Idle|…|S:12031…|P:389,90,88>` for the ~4 s spin-down at `M05`, before the head goes home —
    //     Idle at 90 %, the spindle still turning, the program not finished (`Z1-Bridge-Protocol.md` §6,
    //     traces `docs/bench/traces/2026-10-12-poll*.log`). A `P:` field is present only while a program
    //     is running, so a percent below 100 means one is, whatever the state word says. Sending
    //     `M331` here would leave the vacuum ON after the job: the program's own `M332` is written
    //     before the `M05` that produced this very line, so nothing later will turn it off.
    const percent = jobProgressPercent(ask.text);
    if (percent !== null && percent < 100) {
      return {
        kind: 'busy',
        detail: `it reports Idle, but its status line says a program is ${percent}% through — the job has not finished with ${what} yet, so nothing was sent`,
        status: ask.text,
      };
    }

    // 2. Now the code. The mode has no read-back, so the answer is the controller's own `ok`, and a
    //    socket failure leaves the state UNKNOWN rather than assumed: the line may have gone out.
    const result = await session.send(code);
    switch (result.kind) {
      case 'sent':
        return { kind: 'toggled', on: code === VACUUM_ON || code === ANTISTATIC_ON, status: ask.text };
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
    // One press, one connection. Closing is idempotent, and it is what keeps this control from
    // holding a socket beside the console's (the `finally` also runs on the refusals above).
    await session.close();
  }
}

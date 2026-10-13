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
 * WHAT A REFUSAL COSTS. The ask is one line (`?`) on the session's own connection; a refusal sends
 * nothing further and the connection is closed (the `finally`). So a press on a running machine
 * costs one poll and no command, and a press on an idle one is `?` then `M331`/`M332` on the SAME
 * connection — one connect per press, which is also why this does not lean on the panel's own
 * console handle: a control that opens and closes its own socket cannot interleave with the console's
 * replies, and one command channel (`Z1-Bridge-Protocol.md` §1) is not shared between two senders.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not remember anything: "what did I last send" is the panel's
 * fact, not the socket's, because there is no read-back — the status line does not report the vacuum
 * mode (bench, 2026-10-12), so no amount of polling could recover it. It also does not run a job;
 * `M331`/`M332` are the whole surface, and the `M331.x` family (blowing, bed cleaning, static
 * removal) stays unmodelled (`Z1-Firmware-Dialect.md` §11.3, #283).
 */

import { controllerState } from './machineUpload';
import { attachConsole, type MachineConsoleTarget } from './machineConsole';

/** The machine's bare `M331`/`M332` — "turning extend out mode on/off", the vacuum (#283). */
export const VACUUM_ON = 'M331';
export const VACUUM_OFF = 'M332';

/** The console line for one state, in one place: the switch and any test agree on the code. */
export function vacuumLine(on: boolean): string {
  return on ? VACUUM_ON : VACUUM_OFF;
}

/**
 * What one press did. Six answers, and the split is what the panel renders:
 *
 *   - `toggled` — the machine took the code. `on` is the state now, and `status` is the idle line
 *     that let it start (verbatim, as `uploadProgram` carries it).
 *   - `busy` — the machine answered, and it was not Idle. Nothing was sent; `status` is its line.
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
    const state = controllerState(ask.text);
    if (state === null) {
      return {
        kind: 'error',
        detail: `could not confirm the machine is idle before switching the vacuum: its status line was not readable (${ask.text})`,
      };
    }
    if (state.toLowerCase() !== 'idle') {
      return {
        kind: 'busy',
        detail: `it reports ${state} rather than Idle — a program owns the vacuum while it runs, so nothing was sent`,
        status: ask.text,
      };
    }

    // 2. Now the code. The mode has no read-back, so the answer is the controller's own `ok`, and a
    //    socket failure leaves the state UNKNOWN rather than assumed: the line may have gone out.
    const result = await session.send(vacuumLine(on));
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
    // One press, one connection. Closing is idempotent, and it is what keeps this control from
    // holding a socket beside the console's (the `finally` also runs on the refusals above).
    await session.close();
  }
}

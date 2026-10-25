/**
 * Clear-alarm (#644) — the one `$X` the app sends, and only to a machine that says it is alarmed.
 *
 * WHY A BUTTON AND WHY THIS GUARD. `$X` is the firmware's "clear the alarm lock"; the registration
 * executor already sends it on recovery and it can be typed in the console. The matrix's row B asks
 * for the Control card's Unlock, and the safety rule is the state word: `$X` is offered ONLY when
 * the controller reports `Alarm` (#588). An Idle, Run, Hold or unreadable machine gets a refusal
 * and no line — this is not a general "send a command" button, and it never homes or moves.
 *
 * THE ANSWER IS NOT THE CLEARING. `$X` returning `ok` means the controller accepted the CODE, not
 * that the alarm is gone (a probe-fail alarm can clear and re-arm). So the press asks again and
 * reports what the machine says now: `cleared` only when the state word is no longer `Alarm`, and
 * `still-alarmed` when it is. A socket failure is `timeout`/`error` like every other card control,
 * because the line may or may not have arrived.
 *
 * What this does NOT do: it does not touch registration's own recovery, and it is not a licence to
 * send `$X` from anywhere else — one caller, one guard, one module.
 */

import { alarmLine, controllerState } from './machineUpload';
import { attachConsole, type MachineConsoleTarget } from './machineConsole';

/** The firmware's alarm unlock (`Z1-Firmware-Dialect.md` §11.9). */
export const UNLOCK = '$X';

/** Is this status line an alarmed controller? The state word, or an alarm line anywhere in it. */
export function readsAlarm(text: string | null): boolean {
  const state = controllerState(text);
  if (state !== null && state.toLowerCase() === 'alarm') return true;
  return alarmLine(text) !== null;
}

/**
 * What one press did:
 *
 *  - `cleared` — `$X` went out and the machine no longer reports Alarm;
 *  - `still-alarmed` — `$X` went out and it still reports Alarm (the alarm re-armed, or the code
 *    did not take): the operator is at the machine for a reason, and the sentence says so;
 *  - `not-alarmed` — the guard refused: nothing was sent (the state word was not Alarm);
 *  - `timeout` / `error` — the socket failed; the line may have gone out;
 *  - `unavailable` — this build cannot reach a machine.
 */
export type UnlockOutcome =
  | { kind: 'cleared'; status: string }
  | { kind: 'still-alarmed'; detail: string; status: string }
  | { kind: 'not-alarmed'; detail: string; status: string }
  | { kind: 'timeout'; detail: string }
  | { kind: 'error'; detail: string }
  | { kind: 'unavailable'; detail: string };

/** Ask the machine to clear its alarm lock, if — and only if — it says it is alarmed. */
export async function unlockMachine(target: MachineConsoleTarget): Promise<UnlockOutcome> {
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
        return { kind: 'not-alarmed', detail: ask.detail, status: '' };
      case 'sent':
        break;
    }
    if (!readsAlarm(ask.text) && !readsAlarm(ask.carried?.text ?? null)) {
      const state = controllerState(ask.text) ?? 'an unreadable state';
      return {
        kind: 'not-alarmed',
        detail: `it reports ${state} rather than Alarm, so nothing was sent — the unlock is only for a locked machine`,
        status: ask.text,
      };
    }
    const sent = await session.send(UNLOCK);
    switch (sent.kind) {
      case 'refused':
        return { kind: 'not-alarmed', detail: sent.detail, status: ask.text };
      case 'timeout':
        return { kind: 'timeout', detail: sent.detail };
      case 'error':
        return { kind: 'error', detail: sent.detail };
      case 'unavailable':
        return { kind: 'unavailable', detail: sent.detail };
      case 'sent':
        break;
    }
    // The answer is what the machine says NOW, not that `$X` was accepted.
    const after = await session.send('?');
    if (after.kind !== 'sent') {
      return { kind: 'error', detail: `the unlock was sent, but the machine's state could not be read back (${after.kind})` };
    }
    if (readsAlarm(after.text) || readsAlarm(after.carried?.text ?? null)) {
      return {
        kind: 'still-alarmed',
        detail: 'the unlock was accepted, but the controller still reports Alarm — check the machine before anything else',
        status: after.text,
      };
    }
    return { kind: 'cleared', status: after.text };
  } finally {
    await session.close();
  }
}

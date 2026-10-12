/**
 * What the console refuses (#302, `/Fabrication.md` §8) — as one predicate, in one place.
 *
 * ONE LINE, TYPED BY A PERSON, SENT BY AN EXPLICIT PRESS. `Makera-Parity.md` R10 and §8 used to say
 * "no jog, MDI or console in the app" — a scoping decision made before the bridge existed, reopened
 * by the maintainer on 2026-10-08. What did NOT change is the safety rule: nothing is sent without an
 * explicit user action, and motion needs a person at the machine. These clauses are what a line may
 * not be; whether anyone is standing at the machine is the caller's to establish, not this
 * predicate's.
 *
 * WHY THE RULES LIVE IN `engine/`. Two callers ask them and must never disagree:
 *
 *   - `platform/desktop/protocol.ts` — the sink. Every line that reaches a socket passes through it,
 *     so the bench harness and the app panel get the same answer to "may this line be sent".
 *   - `platform/machineConsole.ts` — the app's panel, which asks BEFORE it reaches for the desktop
 *     bridge. A refused line is then answered with a sentence and no socket at all, which is the
 *     honest difference between "this line is not allowed" and "the send failed".
 *
 * The second caller is in the WEB bundle, and `protocol.ts` is not (it owns sockets). So this module
 * holds the clauses and `protocol.ts` imports them — the same split, for the same reason, as
 * `programUploadProblem` in `uploadGate.ts`. A copy of these five clauses on the web side would be a
 * second statement of a safety rule, which is the one kind of duplicate guaranteed to go stale.
 */

/** One printable-ASCII line. No control characters, so a newline can never end the command early. */
const CONSOLE_LINE = /^[\x20-\x7e]{1,200}$/;

/**
 * Lines refused outright. They are the ways a console line writes to the machine's configuration or
 * its card, or reaches the firmware rather than the job — "nothing in this repo may change a value on
 * the machine" (the harness's own rule) still stands. Motion, spindle, probe and status lines are NOT
 * here: those are what a console is for, and the person at the machine is the safeguard.
 */
const CONSOLE_DENY: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^\s*config-set\b/i, why: 'it changes a configuration value on the machine' },
  { pattern: /^\s*(rm|mv|format|mkdir|truncate)\b/i, why: 'it changes the machine’s card' },
  { pattern: /^\s*(reset|dfu|flash|upgrade|reboot|restart)\b/i, why: 'it resets or reflashes the controller' },
  { pattern: /^\s*(upload|download)\b/i, why: 'transfers go through the verified-program upload, not the console' },
  // The realtime bytes travel on their own and are deliberately unwired (§8): the physical stop is the stop.
  { pattern: /^\s*[!~]\s*$/, why: 'realtime hold/resume bytes are not wired (Z1-Bridge-Protocol.md §8)' },
];

/** Why a line may not be sent, or null when it may. Pure, so a UI can ask before it connects. */
export function consoleProblem(line: string): string | null {
  if (!CONSOLE_LINE.test(line)) {
    return 'a console line is one line of printable ASCII, 1 to 200 characters';
  }
  for (const rule of CONSOLE_DENY) {
    if (rule.pattern.test(line)) return `refusing ${JSON.stringify(line)}: ${rule.why}`;
  }
  return null;
}

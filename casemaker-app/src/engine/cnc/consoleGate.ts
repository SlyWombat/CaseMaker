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
 * ONE LINE IS ONE COMMAND (#386). `Z1-Bridge-Protocol.md` §8 and the bench of 2026-10-12: feeding an
 * air program through the console line by line, with `?` every 0.6 s, raised `ALARM: Mainboard did
 * not receive a status response from the CTRL (RX error)` and froze the status in `Run` with the
 * spindle turning — the front button did nothing and the plug was the only stop. The console input is
 * a single-line box, so a pasted program arrives as ONE line, joined with spaces; the firmware cuts a
 * line into commands by LETTER and runs each of them, so that one line is the whole program. Hence
 * `dispatchedCommands`: a line the dispatcher would run as more than one command is refused, and the
 * answer is the same whether it was pasted, typed, or piped (#386 also limits a PIPED session to the
 * status poll — see `consolePipedProblem`).
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
 * `programUploadProblem` in `uploadGate.ts`. A copy of these clauses on the web side would be a
 * second statement of a safety rule, which is the one kind of duplicate guaranteed to go stale.
 *
 * The one import is the lexer, and it is imported with its extension because `tools/z1/z1.mjs` runs
 * `protocol.ts` under Node, which resolves no `@/` alias (protocol.ts's own note). The lexer is pure
 * text and imports nothing that needs a socket, a worker or a DOM.
 */

import { classifyLine, codeParts, parseWords, splitCommands } from './gcode/lexer.ts';

/** One printable-ASCII line. No control characters, so a newline can never end the command early. */
const CONSOLE_LINE = /^[\x20-\x7e]{1,200}$/;

/**
 * The letters the firmware prefixes the modal motion to (`interpreter.ts`, from `Gcode.cpp`): a line
 * that starts with one of these is a bare move whose command letter is supplied by the modal state.
 * The count below needs that prefix because the dispatcher works on the prefixed text.
 */
const BARE_MOTION = 'XYZAF';

/**
 * How many commands one line dispatches (#386).
 *
 * NOT a count of `G`/`M` words. The firmware cuts a line into commands BY LETTER, so `G1X10Y20` is
 * one command and `T1 M6` is one while `G0 X10 M3 S1000` is two — and `gcode/lexer.ts` is a reading
 * of `GcodeDispatch.cpp` that already answers exactly this. It is asked rather than re-invented: a
 * word count would refuse the first two and pass the third.
 *
 * Two things are then added, both from the interpreter's own dispatch loop, because a slice is not
 * always a dispatch:
 *
 *   - a bare `X…`/`F…` line is dispatched with the modal motion prefixed, so it is split that way;
 *   - `G53` followed on the same line by `G0`/`G1` is ONE command — G53 is that move's machine-
 *     coordinate prefix, not a second command (interpreter.ts `handleG53`). `G53 G0 X-50 Y-50` is a
 *     shape this repo sends and `cncProbePlan`'s job uses; counting slices would refuse it.
 *
 * `text` is the line as `classifyLine` returns it for a code line: leading blanks already removed.
 */
function dispatchedCommands(text: string): number {
  const prefixed = BARE_MOTION.includes(text[0] ?? '') ? `G0 ${text}` : text;
  const commands = splitCommands(prefixed);
  let dispatches = 0;
  for (let i = 0; i < commands.length; i++) {
    dispatches++;
    const words = parseWords(commands[i] as string, 0, []);
    const g = words.find((w) => w.letter === 'G');
    if (g === undefined || codeParts(g.text).code !== 53) continue;
    const next = commands[i + 1];
    const ng = next === undefined ? undefined : parseWords(next, 0, []).find((w) => w.letter === 'G');
    // `G53` with no following G0/G1 is its own command (it reuses the modal motion); with one, that
    // move is the G53's and the pair is dispatched once.
    if (ng !== undefined && codeParts(ng.text).code <= 1) i++;
  }
  return dispatches;
}

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
  // #386 — the streaming rule, and only for lines the G-code DISPATCHER runs. A lowercase line (or
  // `$…`) is the controller's shell's, where a G word means nothing, and the harness's reads are
  // built from a path or a key alone.
  const kind = classifyLine(line);
  if (kind.kind === 'code') {
    const n = dispatchedCommands(kind.text);
    if (n > 1) {
      return (
        `refusing ${JSON.stringify(line)}: the firmware runs each command word separately and this one line is ` +
        `${n} commands — streaming a program through the console is what faulted the controller on 2026-10-12 ` +
        '(ALARM: Mainboard did not receive a status response from the CTRL). Send one command per line, or upload ' +
        'the program and start it with `play`.'
      );
    }
  }
  return null;
}

/**
 * Why a line may not be sent from a PIPED console (#386) — nobody at the keyboard.
 *
 * The status poll and nothing else. Streaming a program is the fault this exists to prevent, and no
 * other piped use needs the console: every read the bench asks of the machine already has its own
 * harness subcommand that builds the one command itself (`status`, `config`, `md5`, `read`,
 * `identify`). Keeping that list of reads out of here is deliberate — a table of "which shell verbs
 * are safe" would be a second statement of rules the harness already enforces, and it would rot.
 *
 * Not applied to a typed line: a person at the keyboard can see the machine, which is the whole
 * reason a console is allowed at all.
 */
export function consolePipedProblem(line: string): string | null {
  if (classifyLine(line).kind === 'blank') return null;
  if (line.trim() === '?') return null;
  return (
    `refusing ${JSON.stringify(line)}: a piped console sends the status poll (?) and nothing else — a line ` +
    'from a script has nobody at the machine to watch it, and streaming a program through the console is what ' +
    'faulted the controller on 2026-10-12 (#386). Type this line at the keyboard, send it with `send … ' +
    '--i-am-at-the-machine`, or upload the program and start it with `play`.'
  );
}


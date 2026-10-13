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
 * That count is the dispatcher's OWN reading, which the review of 2026-10-12 sharpened twice: a
 * prefix word (`G53`, and the modal-only `G90`/`G91`/`G20`/`G21`) is part of the command it prefixes
 * rather than a second one, and an `N` line number is stripped first — a numbered line whose command
 * is G/M/T/S does nothing on this machine at all (#385). See `dispatchedCommands`.
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
 * The G words that are a PREFIX on the command that follows, never a command of their own (#386
 * review, 2026-10-12).
 *
 * `G53` is a machine-coordinate prefix on its move (`interpreter.ts` `handleG53`), and the four
 * modal-only words set a mode that belongs to the next command: `G91 G38.2 Z-8 F300` is the probe
 * line this bench sends, `G91 G0 Z1` is §11.7's cycle and `G91 G0 X10` is the runbook's, and all
 * three were refused as two commands. The alternative the review named — splitting them into two
 * console lines — risks a line that leaves relative mode on, which is worse than the refusal.
 */
const PREFIX_G = new Set([53, 90, 91, 20, 21]);

/**
 * The line's body after an `N` line number, or `null` when a number means the whole line does
 * NOTHING (#386 review item 3, `interpreter.ts` `n-line-ignored`, #385).
 *
 * The firmware strips the number and keeps testing the ORIGINAL first character, `N`, which matches
 * none of its G/M/T/S branches — `N10 M5` answered `ok - ignore: [M5]` on the bench on 2026-10-12
 * and the spindle stayed on. Only a remainder that begins with a BARE AXIS survives, and it survives
 * by being re-dispatched with the modal motion prefixed, so that is what is counted here:
 * `N10 X0 G1 X10` is TWO commands and `N10 M5` is none.
 *
 * `splitCommands` falls through on a leading `N` and reports the whole line as one slice, which is
 * how a numbered two-command line passed the gate before this.
 */
function afterLineNumber(text: string): string | null {
  if (text[0] !== 'N') return text;
  let i = 0;
  while (i < text.length && 'N0123456789.,- '.includes(text[i] as string)) i++;
  const rest = text.slice(i);
  if (rest === '') return '';
  return BARE_MOTION.includes(rest[0] as string) ? rest : null;
}

/**
 * How many commands one line dispatches (#386).
 *
 * NOT a count of `G`/`M` words. The firmware cuts a line into commands BY LETTER, so `G1X10Y20` is
 * one command and `T1 M6` is one while `G0 X10 M3 S1000` is two — and `gcode/lexer.ts` is a reading
 * of `GcodeDispatch.cpp` that already answers exactly this. It is asked rather than re-invented: a
 * word count would refuse the first two and pass the third.
 *
 * Three things are then added, all from the interpreter's own dispatch loop, because a slice is not
 * always a dispatch:
 *
 *   - an `N`-numbered line is read first (`afterLineNumber`): a number whose command is G/M/T/S
 *     makes the line do nothing at all, and a bare-axis remainder is counted without its number;
 *   - a bare `X…`/`F…` line is dispatched with the modal motion prefixed, so it is split that way;
 *   - a slice carrying ONLY prefix G words (`PREFIX_G`) is that next command's prefix, not a
 *     command: `G53 G0 X-50 Y-50`, `G91 G38.2 Z-8 F300` and `G21 G90` are each ONE command. A
 *     prefix slice with nothing after it is the whole line (`G91` alone is legitimate) and counts.
 *
 * `text` is the line as `classifyLine` returns it for a code line: leading blanks already removed.
 */
function dispatchedCommands(text: string): number {
  const body = afterLineNumber(text);
  if (body === null || body === '') return 0;
  const prefixed = BARE_MOTION.includes(body[0] as string) ? `G0 ${body}` : body;
  const commands = splitCommands(prefixed);
  let dispatches = 0;
  for (let i = 0; i < commands.length; i++) {
    const slice = commands[i] as string;
    const codes = parseWords(slice, 0, []).filter((w) => w.letter === 'G' || w.letter === 'M');
    const isPrefix =
      codes.length > 0 &&
      codes.every((w) => w.letter === 'G' && PREFIX_G.has(codeParts(w.text).code));
    if (isPrefix && i + 1 < commands.length) continue;
    dispatches++;
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


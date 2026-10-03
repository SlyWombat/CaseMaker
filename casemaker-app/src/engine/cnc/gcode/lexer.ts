/**
 * Lexing for the Makera Z1's G-code dialect (#174).
 *
 * This is NOT an RS274 lexer. It models what the machine's firmware does with a line,
 * because the firmware is what runs: lines are cut into commands by LETTER, not by
 * whitespace; `T1 M6` is one command; a `(` comment swallows the rest of the line;
 * `G90`/`G91` are hoisted before the comment is removed. Every rule below is a reading
 * of `GcodeDispatch.cpp` and `Gcode.cpp` and is written up, with its provenance and its
 * hazards, in `/Z1-Firmware-Dialect.md`. None of it is verified on hardware.
 *
 * Where the firmware is sloppy, this is deliberately STRICTER, and reports the
 * difference. The firmware parses numbers with `strtof`, which accepts exponents, `nan`,
 * `inf` and hex (hex is not detected here; see FIRMWARE_ACCEPTS), and finds a word by scanning for its letter, which reads `YY20` as
 * `Y20`. Studio is known to write uninitialised garbage into its own settings
 * (`/Makera-Parity.md` §8); a lexer that quietly agreed with the firmware would
 * reproduce that garbage as geometry.
 */

import type { Diagnostic } from './types';

/** One parsed word: a letter and its value, with the number as it was written. */
export interface Word {
  letter: string;
  value: number;
  /** The numeric text, e.g. `38.2`. Kept so G/M subcodes need no float arithmetic. */
  text: string;
}

export type LineKind =
  | { kind: 'blank' }
  | { kind: 'percent' }
  | { kind: 'comment'; header: boolean }
  | { kind: 'shell'; echo: boolean }
  | { kind: 'code'; text: string };

/** Split on CRLF, LF or bare CR. The corpus has CRLF files. */
export function splitLines(source: string): string[] {
  return source.split(/\r\n|\n|\r/);
}

/**
 * Classify a line by its first character, as the dispatcher does.
 *
 * `;@MKR|` is a header record. Any other `;` or `(` start is a comment. A lowercase
 * first letter (or `$`) is a SHELL command, ignored by the G-code dispatcher — which is
 * what makes `echo …` lines harmless, and also what makes `g1 x5` silently do nothing.
 */
export function classifyLine(raw: string): LineKind {
  let i = 0;
  while (i < raw.length && (raw.charCodeAt(i) === 32 || raw.charCodeAt(i) === 9)) i++;
  if (i >= raw.length) return { kind: 'blank' };
  const c = raw.charCodeAt(i);
  if (c === 59 /* ; */) {
    return { kind: 'comment', header: raw.startsWith(';@MKR|', i) };
  }
  if (c === 40 /* ( */) return { kind: 'comment', header: false };
  if (c === 37 /* % */) return { kind: 'percent' };
  if (c === 36 /* $ */) return { kind: 'shell', echo: false };
  if (c >= 97 && c <= 122) {
    return { kind: 'shell', echo: raw.startsWith('echo', i) };
  }
  return { kind: 'code', text: i === 0 ? raw : raw.slice(i) };
}

export interface CommentStrip {
  /** The text with the comment removed — what the firmware actually executes. */
  code: string;
  /** Text the firmware DISCARDS that a standards-reading would have executed. */
  droppedAfterParen: string | null;
  unterminatedParen: boolean;
}

/**
 * Remove a comment the way the firmware does: cut at the FIRST `;` or `(`, and nothing
 * resumes after a `)`.
 *
 * In RS274, `G0 (hop) X5` still moves to X5. Here the `X5` is gone. `droppedAfterParen`
 * reports what was lost so the interpreter can flag it, because a post-processor that
 * relied on the standard reading has silently produced a different program.
 */
export function stripComment(text: string): CommentStrip {
  let cut = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 59 || c === 40) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return { code: text, droppedAfterParen: null, unterminatedParen: false };
  const code = text.slice(0, cut);
  if (text.charCodeAt(cut) === 59) {
    return { code, droppedAfterParen: null, unterminatedParen: false };
  }
  const close = text.indexOf(')', cut + 1);
  if (close < 0) return { code, droppedAfterParen: null, unterminatedParen: true };
  // What follows the first comment, after discarding further comments and whitespace.
  let tail = text.slice(close + 1);
  for (;;) {
    tail = tail.trimStart();
    if (tail.startsWith(';')) {
      tail = '';
    } else if (tail.startsWith('(')) {
      const c2 = tail.indexOf(')');
      tail = c2 < 0 ? '' : tail.slice(c2 + 1);
    } else {
      break;
    }
  }
  return { code, droppedAfterParen: tail.length > 0 ? tail : null, unterminatedParen: false };
}

function findFrom(s: string, chars: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (chars.indexOf(s[i] as string) !== -1) return i;
  }
  return -1;
}

/**
 * Cut one line into the commands the dispatcher would dispatch.
 *
 * A direct port of the firmware's rule, including its start-at-index-2 search. It cuts at
 * the next command letter, and which letters count depends on how the command begins:
 *
 *   G…  cut at G, M or T — or G, M, S or T if the line also has an S AND an M after index 2
 *   M…  cut at G or M          (so `M3 S12000` is one command: S is M3's parameter)
 *   T… / S…  cut at the first M, then at the next G, M, S or T after it
 *                              (so `T1 M6` is ONE command: T is M6's parameter)
 *
 * Callers must pass text that begins with G, M, T or S.
 */
export function splitCommands(input: string): string[] {
  const out: string[] = [];
  let rest = input;
  while (rest.length > 0) {
    const first = rest[0];
    let cut = -1;
    if (first === 'G') {
      const hasS = findFrom(rest, 'S', 2) !== -1;
      const hasM = findFrom(rest, 'M', 2) !== -1;
      cut = hasS && hasM ? findFrom(rest, 'GMST', 2) : findFrom(rest, 'GMT', 2);
    } else if (first === 'M') {
      cut = findFrom(rest, 'GM', 2);
    } else if (first === 'T' || first === 'S') {
      cut = findFrom(rest, 'M', 2);
      cut = cut === -1 ? findFrom(rest, 'GST', 2) : findFrom(rest, 'GMST', cut + 2);
    } else {
      // Defensive: the caller guarantees G/M/T/S, and every remainder after a cut starts
      // at one of those letters. Take the rest whole rather than loop.
      out.push(rest);
      break;
    }
    if (cut === -1) {
      out.push(rest);
      break;
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return out;
}

/** Strict number grammar: no exponent, no `nan`/`inf`/hex. Accepts `6.` and `.5`. */
const NUMBER_RE = /[+-]?(?:\d+\.?\d*|\.\d+)/y;

/**
 * What the firmware's `strtof` would accept but we refuse: an exponent, or `nan`/`inf`.
 *
 * HEX (`0x10`) is deliberately NOT detected. `strtof` does accept it, but a detector cannot
 * tell `X0x5` from `G0X5`: the second is on nearly every line of Makera's own samples, and
 * a naive check would flag it. A hex literal in a coordinate would have to be written by
 * hand; the cost of the false positive is far higher than the cost of missing it.
 */
const FIRMWARE_ACCEPTS = /^(?:[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?\d|[+-]?(?:nan|inf))/i;
const NAN_INF = /^[+-]?(?:nan|inf(?:inity)?)/i;

/**
 * Parse a command into letter/number words.
 *
 * Whitespace between words is optional (`G1X0.1F2000S0.8`). Anything that is not a
 * letter followed by a strict number is reported and skipped, so one typo does not hide
 * the rest of the line.
 */
export function parseWords(
  command: string,
  line: number,
  diagnostics: Diagnostic[],
): Word[] {
  const words: Word[] = [];
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command.charCodeAt(i);
    if (ch === 32 || ch === 9) {
      i++;
      continue;
    }
    const isUpper = ch >= 65 && ch <= 90;
    if (!isUpper) {
      // Consume the WHOLE run up to the next uppercase letter and report it ONCE. The
      // firmware finds words by scanning for an uppercase letter, so `M332 # <text>` is a
      // perfectly good M332 with a trailing remark. Reporting per character turned one
      // such line into sixteen errors on a known-good vendor file (board-test.nc).
      let j = i;
      while (j < n) {
        const cj = command.charCodeAt(j);
        if (cj >= 65 && cj <= 90) break;
        j++;
      }
      const run = command.slice(i, j).trim();
      i = j;
      if (run === '') continue;
      // A lowercase letter immediately followed by a number looks like a word the author
      // meant (`x5`) and the firmware silently drops: that is an error. Anything else is
      // trailing text the firmware ignores: a warning.
      const wordLike = /^[a-z]\s*[+-]?[\d.]/.test(run);
      diagnostics.push({
        severity: wordLike ? 'error' : 'warning',
        code: wordLike ? 'lowercase-word' : 'ignored-text',
        line,
        message: wordLike
          ? `lowercase word '${run.slice(0, 12)}': the firmware matches letters case-sensitively, so this word is silently ignored`
          : `text '${run.slice(0, 24)}${run.length > 24 ? '…' : ''}' in a G-code command is ignored by the firmware`,
      });
      continue;
    }
    const letter = command[i] as string;
    i++;
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(command);
    if (!m) {
      const tail = command.slice(i, i + 12);
      const ni = NAN_INF.exec(command.slice(i));
      if (ni) {
        diagnostics.push({
          severity: 'error',
          code: 'bad-number',
          line,
          message: `'${letter}${ni[0]}' is a value the firmware's strtof would ACCEPT (nan or inf) but that is almost certainly corruption`,
        });
        i += ni[0].length; // skip the token so its letters do not cascade into stray-text errors
      } else {
        diagnostics.push({
          severity: 'error',
          code: 'stray-text',
          line,
          message: `letter '${letter}' is not followed by a number (found '${tail.trim() || 'end of command'}'); the firmware would hunt for a later '${letter}' instead of rejecting it`,
        });
      }
      continue;
    }
    const text = m[0];
    i += text.length;
    // An exponent glued onto a valid number: `1e61`. The strict match stopped before it.
    const next = command.charCodeAt(i);
    if (
      (next === 101 || next === 69) &&
      FIRMWARE_ACCEPTS.test(text + command.slice(i, i + 12))
    ) {
      diagnostics.push({
        severity: 'error',
        code: 'bad-number',
        line,
        message: `'${letter}${text}${command.slice(i, i + 6)}' has an exponent: the firmware's strtof would accept it, but it is almost certainly corruption`,
      });
      // Skip the exponent so the rest of the command still parses.
      i++;
      if (command[i] === '+' || command[i] === '-') i++;
      while (i < n && command.charCodeAt(i) >= 48 && command.charCodeAt(i) <= 57) i++;
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value)) {
      diagnostics.push({
        severity: 'error',
        code: 'bad-number',
        line,
        message: `'${letter}${text}' is not a finite number`,
      });
      continue;
    }
    words.push({ letter, value, text });
  }
  return words;
}

/** Split a G/M word's numeric text into its integer code and decimal subcode (`38.2` → 38, 2). */
export function codeParts(text: string): { code: number; sub: number } {
  const dot = text.indexOf('.');
  if (dot < 0) return { code: Number(text), sub: 0 };
  const frac = text.slice(dot + 1);
  return { code: Number(text.slice(0, dot) || '0'), sub: frac === '' ? 0 : Number(frac) };
}

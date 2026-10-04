/**
 * The modal state machine: lowers G-code text to an ordered event stream (#174, #182).
 *
 * One pass, one state. The emulator, the verifier and the post-processor's round-trip all
 * consume `GcodeEvent[]` and never re-read G-code, so the semantics live here once. The
 * rules are the Z1 firmware's, not RS274's — see `/Z1-Firmware-Dialect.md`, which records
 * each one with its source and its hazard.
 *
 * What this deliberately does NOT do, because it cannot know it from the file:
 *
 *  - Apply the WCS offset, the tool offset or the part's placement. Moves carry the frame
 *    they were written in. The WCS lives in the controller's EEPROM, not in the program.
 *  - Know the machine. Envelope, rapid-through-stock, spindle-off cutting, holder
 *    clearance and the dialect flags in the machine profile belong to the verifier and
 *    the emulator, consuming this stream.
 *  - Decide policy. `A` words are tracked and flagged, and a laser job is detected and
 *    flagged, but refusing either is the verifier's job.
 *
 * It never throws on bad input. Every problem is a `Diagnostic` with a line number and a
 * stable code, ALL of them are collected, and parsing continues, so one typo does not
 * hide the other forty.
 */

import { tessellateArc, type Plane } from './arcs';
import { classifyLine, codeParts, parseWords, splitCommands, splitLines, stripComment, type Word } from './lexer';
import { parseMkrRecord } from './mkrHeader';
import type { Diagnostic, Frame, GcodeEvent, MkrHeader, MkrRecord, MoveEvent, ParseResult, Pos } from './types';

const INCH = 25.4;

/** A radius mismatch above this is reported: the firmware accepts it and runs a circle on the start radius, then one jump to the target. */
const ARC_RADIUS_MISMATCH_WARN_MM = 0.01;

/** Codes with no geometric effect that appear in the reference corpus. */
const NO_EFFECT_M = new Set([
  106, 107, // fan
  220, 223, // feed / spindle override (change time, not geometry)
  331, 332, // auto vacuum
  497, // UI state flag, no motion
  801, 802, // vacuum (Carvera)
  811, 812, // spindle fan
  821, 822, // light
  831, 832, 841, 842, // accessories
  // Extended-port PWM. Makera's own FreeCAD post for the Z1 emits `M851 S<pct>` before `M7` and
  // `M852` before `M9` when its `ext_for_air` option is on, so a file from that post would
  // otherwise be refused for a code the vendor's own tooling writes.
  851, 852,
]);

/** `G40`, `G80` and `G94` are accepted and change nothing we model. */
const NO_EFFECT_G = new Set([40, 80, 94]);

const AXIS_INDEX: Record<string, 0 | 1 | 2> = { X: 0, Y: 1, Z: 2 };

class Interp {
  readonly events: GcodeEvent[] = [];
  readonly diagnostics: Diagnostic[] = [];
  readonly headerRecords: MkrRecord[] = [];

  // ---- modal state -------------------------------------------------------
  private scale = 1;
  private absolute = true;
  private plane: Plane = 'XY';
  /** Modal group 1. The firmware starts it at G0, not G1. */
  private motion: 0 | 1 | 2 | 3 = 0;
  private feed: number | null = null;
  private spindle: 'cw' | 'ccw' | 'off' = 'off';
  private rpm: number | null = null;
  private laser = false;
  private tool: number | null = null;
  private wcs = 0;
  private work: Pos = [null, null, null];
  private machine: Pos = [null, null, null];
  private a: number | null = null;

  // ---- once-per-file noise guards ---------------------------------------
  private warnedNoFeed = false;
  private warnedRotary = false;

  // ---- summary -----------------------------------------------------------
  lines = 0;
  codeLines = 0;
  moves = 0;
  rapids = 0;
  cuts = 0;
  toolChanges = 0;
  sawLaser = false;
  usesArcs = false;
  usesRotary = false;
  usesInches = false;

  private diag(severity: Diagnostic['severity'], code: string, line: number, message: string): void {
    this.diagnostics.push({ severity, code, line, message });
  }

  private unknownPosition(): void {
    this.work = [null, null, null];
    this.machine = [null, null, null];
  }

  // ---- line level --------------------------------------------------------

  handleLine(raw: string, lineNo: number): void {
    this.lines++;
    const kind = classifyLine(raw);
    switch (kind.kind) {
      case 'blank':
      case 'percent':
        return;
      case 'comment':
        if (kind.header) this.handleHeader(raw, lineNo);
        return;
      case 'shell':
        if (!kind.echo) {
          this.diag(
            'error',
            'console-line',
            lineNo,
            "a line starting with a lowercase letter or '$' is passed to the controller's console, not the G-code dispatcher: if this was meant as G-code the machine did nothing",
          );
        }
        return;
      case 'code':
        this.codeLines++;
        this.handleCode(kind.text, lineNo);
    }
  }

  private handleHeader(raw: string, lineNo: number): void {
    const rec = parseMkrRecord(raw, lineNo);
    if (!rec) return;
    this.headerRecords.push(rec);
    if (rec.tag === 'TOOLPATH_START') {
      const n = Number(rec.fields['toolpath_number']);
      this.events.push({
        kind: 'toolpath-start',
        line: lineNo,
        number: rec.fields['toolpath_number'] !== undefined && Number.isFinite(n) ? n : null,
      });
    }
  }

  private handleCode(text: string, lineNo: number): void {
    let s = text;

    // An N-numbered line. The firmware strips the number but keeps testing the ORIGINAL
    // first character ('N'), which matches none of its G/M/T/S branches. So a line like
    // `N10 G1 X5` falls through to "ignore" and does NOTHING. Only a remainder that starts
    // with X, Y, Z, A or F survives, via the bare-axis path. Read from GcodeDispatch.cpp;
    // no corpus file has an N word, so this is unverified on hardware.
    if (s.charCodeAt(0) === 78 /* N */) {
      let i = 0;
      while (i < s.length && 'N0123456789.,- '.indexOf(s[i] as string) !== -1) i++;
      s = s.slice(i);
      if (s === '') return;
      if ('XYZAF'.indexOf(s[0] as string) === -1) {
        this.diag(
          'error',
          'n-line-ignored',
          lineNo,
          `an N-numbered line whose command starts with '${s[0]}' is IGNORED by the firmware (it strips the number but keeps testing 'N'); the machine does nothing for this line`,
        );
        return;
      }
    }

    // Bare X/Y/Z/A/F lines inherit the last modal motion: the firmware prefixes `G<n> ` and
    // re-dispatches the line. A lone F is prefixed G1, and because that sets the modal motion,
    // it silently turns following bare lines into cuts. This happens BEFORE the hoist below,
    // on the line with its comment still attached, because that is the firmware's order — so
    // `X5 (G91 here)` is hoisted too (the review found the first version skipped it).
    {
      const c0 = s[0] as string;
      if ('XYZAF'.indexOf(c0) !== -1) {
        const g = c0 === 'F' ? 1 : this.motion;
        if (c0 === 'F' && this.motion !== 1) {
          this.diag(
            'warning',
            'lone-f-switches-g1',
            lineNo,
            `a line starting with F is prefixed G1 by the firmware, which makes G1 the modal motion${this.motion === 0 ? ' (it was G0: following bare X/Y/Z lines are now cutting moves)' : ''}`,
          );
        }
        s = `G${g} ${s}`;
      }
    }

    // G90/G91 are HOISTED to the front of a G line, and the search runs over the WHOLE line
    // including its comment, before the comment is removed. A comment that merely mentions
    // G91 therefore changes the distance mode on the real machine.
    if (s.charCodeAt(0) === 71 /* G */) {
      const full90 = s.indexOf('G90');
      const full91 = full90 < 0 ? s.indexOf('G91') : -1;
      const pos = full90 >= 0 ? full90 : full91;
      if (pos >= 0) {
        const hoisted = full90 >= 0 ? 'G90' : 'G91';
        const stripped = stripComment(s).code;
        if (stripped.indexOf(hoisted) < 0) {
          this.diag(
            'error',
            'comment-contains-g90-g91',
            lineNo,
            `a comment on this line contains '${hoisted}': the firmware hoists it out of the comment and applies it, changing the distance mode`,
          );
        }
        s = hoisted + s.slice(0, pos) + s.slice(pos + 3);
      }
    }

    const cs = stripComment(s);
    if (cs.droppedAfterParen !== null) {
      this.diag(
        'error',
        'paren-comment-truncates',
        lineNo,
        `text after a '(' comment is DISCARDED by the firmware, not executed as RS274 would: '${cs.droppedAfterParen.trim().slice(0, 40)}'`,
      );
    }
    if (cs.unterminatedParen) {
      this.diag('warning', 'unterminated-comment', lineNo, "'(' comment has no closing ')'");
    }
    let code = cs.code.trimEnd();
    if (code.trim() === '') return;
    code = code.trimStart();

    const c0 = code[0] as string;
    if ('GMTS'.indexOf(c0) === -1) {
      this.diag('warning', 'ignored-line', lineNo, `the firmware ignores a line starting with '${c0}'`);
      return;
    }

    const commands = splitCommands(code);
    for (let ci = 0; ci < commands.length; ci++) {
      const words = parseWords(commands[ci] as string, lineNo, this.diagnostics);
      if (words.length === 0) continue;
      const consumedNext = this.handleCommand(words, commands[ci + 1], lineNo);
      if (consumedNext) ci++;
    }
  }

  // ---- command level -----------------------------------------------------

  /** Returns true if it consumed the following command (the `G53 <motion>` form). */
  private handleCommand(words: Word[], nextText: string | undefined, line: number): boolean {
    const gw = words.find((w) => w.letter === 'G');
    const mw = words.find((w) => w.letter === 'M');
    if (gw && mw) {
      this.diag('error', 'multiple-codes', line, 'a command holds both a G and an M word');
      return false;
    }
    if (gw) return this.handleG(gw, words, nextText, line);
    if (mw) {
      this.handleM(mw, words, line);
      return false;
    }
    // Parameter-only: `S12000` or `T1` on their own.
    const sw = words.find((w) => w.letter === 'S');
    const tw = words.find((w) => w.letter === 'T');
    if (tw && !sw) {
      this.diag('warning', 't-without-m6', line, `'T${tw.text}' without M6 in the same command does nothing: the firmware only acts on a tool word attached to M6`);
    } else if (sw) {
      this.rpm = sw.value;
    }
    return false;
  }

  private word(words: Word[], letter: string): Word | undefined {
    return words.find((w) => w.letter === letter);
  }

  private handleG(gw: Word, words: Word[], nextText: string | undefined, line: number): boolean {
    const { code, sub } = codeParts(gw.text);
    switch (code) {
      case 0:
      case 1:
      case 2:
      case 3:
        this.doMotion(code, words, false, line);
        return false;
      case 4: {
        const p = this.word(words, 'P');
        const s = this.word(words, 'S');
        this.events.push({ kind: 'dwell', line, p: p ? p.value : null, s: s ? s.value : null });
        return false;
      }
      case 10: {
        // The firmware acts only on `G10 L2|L20 P..`; anything else falls through silently
        // (Robot.cpp: `has_letter('L') && (L == 2 || L == 20) && has_letter('P')`).
        const l = this.word(words, 'L');
        const p = this.word(words, 'P');
        if (!l || (l.value !== 2 && l.value !== 20)) {
          this.diag('warning', 'unsupported-g10', line, 'only G10 L2 / L20 (set a work offset) does anything on this firmware; ignored');
          return false;
        }
        if (!p) {
          this.diag('warning', 'g10-without-p', line, 'G10 without a P word is IGNORED by the firmware (P0 = the current offset, P1 = G54)');
          return false;
        }
        const vals: Pos = [null, null, null];
        for (const w of words) {
          const idx = AXIS_INDEX[w.letter];
          if (idx !== undefined) vals[idx] = w.value * this.scale;
        }
        this.events.push({ kind: 'wcs-set', line, l: l.value as 2 | 20, p: p.value, values: vals });
        // The offset changes the work↔machine mapping; the work position is now unknown.
        this.work = [null, null, null];
        return false;
      }
      case 17: this.plane = 'XY'; return false;
      case 18: this.plane = 'XZ'; return false;
      case 19: this.plane = 'YZ'; return false;
      case 20:
        this.scale = INCH;
        this.usesInches = true;
        return false;
      case 21: this.scale = 1; return false;
      case 28:
        this.events.push({ kind: 'home', line });
        this.unknownPosition();
        return false;
      case 38: {
        const target: Pos = [null, null, null];
        for (const w of words) {
          const idx = AXIS_INDEX[w.letter];
          if (idx !== undefined) target[idx] = w.value * this.scale;
        }
        this.events.push({ kind: 'probe', line, subcode: sub, target });
        // A probe stops where it touches: the commanded axes are no longer known.
        this.unknownPosition();
        return false;
      }
      case 53:
        return this.handleG53(words, nextText, line);
      case 54: case 55: case 56: case 57: case 58: case 59: {
        const n = code - 54 + (code === 59 && sub > 0 ? Math.min(sub, 3) : 0);
        this.events.push({ kind: 'wcs-select', line, wcs: n });
        if (n !== this.wcs) this.work = [null, null, null];
        this.wcs = n;
        return false;
      }
      case 90: this.absolute = true; return false;
      case 91: this.absolute = false; return false;
      case 92: {
        const vals: Pos = [null, null, null];
        let anyArg = false;
        for (const w of words) {
          if (w.letter === 'G') continue;
          anyArg = true;
          const idx = AXIS_INDEX[w.letter];
          if (idx !== undefined) vals[idx] = w.value * this.scale;
        }
        // Robot.cpp: `.1`, `.2` and a bare `G92` reset the offset; `.3` sets it raw; `.4` is
        // a manual homing that REDEFINES the machine position; `.5` is a laser offset; else
        // the offset is shifted so the current position reads as the given values.
        const reset = sub === 1 || sub === 2 || (sub === 0 && !anyArg);
        this.events.push({ kind: 'offset-set', line, subcode: sub, values: vals, reset });
        if (sub === 0 && anyArg) {
          // "The current position IS these values": those axes become known.
          for (const w of words) {
            const idx = AXIS_INDEX[w.letter];
            if (idx !== undefined) this.work[idx] = w.value * this.scale;
            else if (w.letter === 'A') this.a = w.value;
          }
        } else if (sub === 4) {
          this.diag('warning', 'g92-4-manual-home', line, 'G92.4 redefines the MACHINE position itself; nothing the emulator was told about the setup holds after it');
          this.unknownPosition();
        } else if (sub !== 5) {
          // The offset changed but the parser does not know the WCS, so the work position
          // it maps to is unknown now.
          this.work = [null, null, null];
        }
        return false;
      }
      default:
        if (NO_EFFECT_G.has(code)) return false;
        if (code === 93 || (code >= 81 && code <= 89)) {
          this.diag('error', 'unsupported-code', line, `G${gw.text} is recognised but not supported (inverse-time feed and canned cycles; the Z1 translates drill cycles instead)`);
        } else {
          this.diag('error', 'unknown-code', line, `unknown G code G${gw.text}`);
        }
        return false;
    }
  }

  /**
   * `G53` makes the NEXT motion use machine coordinates, on the same line. Either the next
   * command is `G0`/`G1`, or there is none and the G53 command's own axes use the last
   * modal motion — which the firmware lets be a G2/G3 (`modal_group_1 > 3` is its only
   * check), so a bare `G53 X.. Y..` after an arc is an arc in machine coordinates. An
   * explicit `G53 G2` on the same line is "Invalid G53" and ignored.
   */
  private handleG53(words: Word[], nextText: string | undefined, line: number): boolean {
    if (nextText !== undefined) {
      const nextWords = parseWords(nextText, line, this.diagnostics);
      const ng = nextWords.find((w) => w.letter === 'G');
      const nc = ng ? codeParts(ng.text).code : -1;
      if (!ng || nc > 1) {
        this.diag('error', 'g53-invalid', line, 'G53 must be followed on the same line by G0 or G1; the firmware ignores it otherwise');
        return true;
      }
      if (words.some((w) => AXIS_INDEX[w.letter] !== undefined)) {
        this.diag('warning', 'g53-params-ignored', line, "axis words on a G53 that is followed by G0/G1 are discarded");
      }
      this.doMotion(nc as 0 | 1, nextWords, true, line);
      return true;
    }
    // With nothing after it, G53 reuses the last modal motion — and the firmware allows a
    // modal G2/G3 here (its check is `modal_group_1 > 3`), so this can be an ARC in machine
    // coordinates. The first version refused it; the review read the source.
    this.doMotion(this.motion, words, true, line);
    return false;
  }

  // ---- motion ------------------------------------------------------------

  private doMotion(g: 0 | 1 | 2 | 3, words: Word[], mcs: boolean, line: number): void {
    this.motion = g;
    const fw = this.word(words, 'F');
    if (fw && g >= 1) {
      const f = fw.value * this.scale;
      if (!(f > 0)) {
        this.diag('error', 'bad-feed', line, `feed rate must be positive, got F${fw.text}`);
      } else {
        this.feed = f;
      }
    }
    // `S` on a motion line is laser power ONLY in laser mode; elsewhere the firmware does
    // not read it as a spindle speed, so it is not carried as one.
    const sw = this.word(words, 'S');
    const power = sw && this.laser ? sw.value : null;

    const frame: Frame = mcs ? 'machine' : 'work';
    const cur = (mcs ? this.machine : this.work).slice() as Pos;
    const target = cur.slice() as Pos;
    const commanded: boolean[] = [false, false, false];
    const values: Pos = [null, null, null];
    // Machine coordinates are absolute even under G91; so are work coordinates under G90.
    const relative = !mcs && !this.absolute;
    for (const w of words) {
      const idx = AXIS_INDEX[w.letter];
      if (idx === undefined) continue;
      commanded[idx] = true;
      const v = w.value * this.scale;
      values[idx] = v;
      if (relative) {
        const base = cur[idx];
        target[idx] = base === null ? null : (base as number) + v;
      } else {
        target[idx] = v;
      }
    }
    const aw = this.word(words, 'A');
    if (aw) {
      this.usesRotary = true;
      if (!this.warnedRotary) {
        this.warnedRotary = true;
        this.diag('info', 'rotary-axis', line, 'an A word appears: the rotary axis is tracked but not interpreted, and V1 does not simulate rotary work');
      }
      this.a = relative && this.a !== null ? this.a + aw.value : aw.value;
    }

    if (g >= 2) {
      this.doArc(g === 2, words, target, commanded, values, relative, cur, frame, power, line);
      return;
    }

    const anyAxis = commanded[0] || commanded[1] || commanded[2];
    if (!anyAxis && !aw) return; // `G0` / `G1` with no axes moves nothing.
    if (g === 1 && this.feed === null && !this.warnedNoFeed) {
      this.warnedNoFeed = true;
      this.diag('warning', 'no-feed', line, 'a G1 with no feed rate defined: the machine falls back to its own default');
    }
    this.pushMove(g === 0 ? 'rapid' : 'cut', frame, cur, target, power, false, line, {
      commanded: [commanded[0] as boolean, commanded[1] as boolean, commanded[2] as boolean],
      values,
      relative,
    });
    this.commit(frame, target, commanded);
  }

  private pushMove(
    mode: 'rapid' | 'cut',
    frame: Frame,
    from: Pos,
    to: Pos,
    power: number | null,
    fromArc: boolean,
    line: number,
    cmd: { commanded: [boolean, boolean, boolean]; values: Pos; relative: boolean },
  ): void {
    const ev: MoveEvent = {
      kind: 'move',
      line,
      mode,
      frame,
      from: [from[0], from[1], from[2]],
      to: [to[0], to[1], to[2]],
      a: this.a,
      feed: mode === 'cut' ? this.feed : null,
      power,
      fromArc,
      commanded: cmd.commanded,
      values: cmd.values,
      relative: cmd.relative,
    };
    this.events.push(ev);
    this.moves++;
    if (mode === 'rapid') this.rapids++;
    else this.cuts++;
  }

  /** After a move: the moved frame is `target`; the other frame loses the commanded axes. */
  private commit(frame: Frame, target: Pos, commanded: boolean[]): void {
    const other = frame === 'work' ? this.machine : this.work;
    for (let i = 0; i < 3; i++) if (commanded[i]) other[i] = null;
    if (frame === 'work') this.work = [target[0], target[1], target[2]];
    else this.machine = [target[0], target[1], target[2]];
  }

  private doArc(
    clockwise: boolean,
    words: Word[],
    target: Pos,
    commanded: boolean[],
    values: Pos,
    relative: boolean,
    cur: Pos,
    frame: Frame,
    power: number | null,
    line: number,
  ): void {
    this.usesArcs = true;
    const fallback = (): void => {
      this.pushMove('cut', frame, cur, target, power, false, line, {
        commanded: [commanded[0] as boolean, commanded[1] as boolean, commanded[2] as boolean],
        values,
        relative,
      });
      this.commit(frame, target, commanded);
    };
    if (this.feed === null) {
      if (!this.warnedNoFeed) {
        this.warnedNoFeed = true;
        this.diag('error', 'no-feed', line, 'an arc with no feed rate: the firmware raises "Alarm: Undefined feed rate"');
      }
    }
    if (this.word(words, 'R')) {
      this.diag('error', 'arc-r-unsupported', line, "the firmware has no radius-form (R) arcs: only I/J/K offsets are read, so an R arc is not an arc");
      fallback();
      return;
    }
    const off: [number, number, number] = [0, 0, 0];
    for (const w of words) {
      if (w.letter === 'I') off[0] = w.value * this.scale;
      else if (w.letter === 'J') off[1] = w.value * this.scale;
      else if (w.letter === 'K') off[2] = w.value * this.scale;
    }
    // The arc needs its two PLANE axes known at both ends. The linear axis (Z for G17) only
    // matters if the program commanded it; an XY arc at a Z the parser does not know — the
    // usual case right after a tool change — is still a perfectly good arc, and its points
    // carry Z as "not commanded" so a consumer that does know Z (the runner, told the
    // starting tool) keeps its own. The first version demanded all three and emitted a
    // straight chord after every no-op M6.
    const [a0, a1, lin] = this.plane === 'XY' ? [0, 1, 2] : this.plane === 'XZ' ? [0, 2, 1] : [1, 2, 0];
    const planeKnown = cur[a0] !== null && cur[a1] !== null && target[a0] !== null && target[a1] !== null;
    const linCommanded = commanded[lin] as boolean;
    if (!planeKnown || (linCommanded && (cur[lin] === null || target[lin] === null))) {
      this.diag('error', 'arc-from-unknown', line, 'an arc from or to a position the program has not established; emitted as a straight move with unknown axes');
      fallback();
      return;
    }
    const linStart = cur[lin];
    const linEnd = linCommanded ? (target[lin] as number) : linStart;
    const start: [number, number, number] = [0, 0, 0];
    const end: [number, number, number] = [0, 0, 0];
    start[a0] = cur[a0] as number; start[a1] = cur[a1] as number; start[lin] = linStart ?? 0;
    end[a0] = target[a0] as number; end[a1] = target[a1] as number; end[lin] = linEnd ?? 0;
    const res = tessellateArc({ start, end, offsets: off, plane: this.plane, clockwise });
    if ('error' in res) {
      this.diag('error', 'arc-zero-radius', line, 'an arc whose I/J/K offsets give a zero radius');
      fallback();
      return;
    }
    if (Math.abs(res.radiusStart - res.radiusEnd) > ARC_RADIUS_MISMATCH_WARN_MM) {
      this.diag(
        'warning',
        'arc-radius-mismatch',
        line,
        `start radius ${res.radiusStart.toFixed(4)} mm differs from end radius ${res.radiusEnd.toFixed(4)} mm: the firmware does not reject this; it runs a circle on the start radius and jumps to the target on the last segment`,
      );
    }
    let prev: Pos = [cur[0], cur[1], cur[2]];
    const cmd: [boolean, boolean, boolean] = [false, false, false];
    cmd[a0] = true; cmd[a1] = true; cmd[lin] = linCommanded;
    for (const p of res.points) {
      const to: Pos = [p[0], p[1], p[2]];
      if (!linCommanded) to[lin] = linStart ?? null; // not commanded: unchanged, possibly unknown
      // Tessellated points are resolved ABSOLUTE coordinates in the parser's own frame of
      // reference, so the plane axes count as commanded and nothing is relative; the linear
      // axis counts only if the program commanded it.
      this.pushMove('cut', frame, prev, to, power, true, line, {
        commanded: [cmd[0], cmd[1], cmd[2]],
        values: [cmd[0] ? to[0] : null, cmd[1] ? to[1] : null, cmd[2] ? to[2] : null],
        relative: false,
      });
      prev = to;
    }
    this.commit(frame, target, [cmd[0], cmd[1], cmd[2]]);
  }

  // ---- M codes -----------------------------------------------------------

  private handleM(mw: Word, words: Word[], line: number): void {
    const { code, sub } = codeParts(mw.text);
    switch (code) {
      case 2:
      case 30:
        this.programEnd(line);
        return;
      case 3:
      case 4: {
        const s = this.word(words, 'S');
        if (s) this.rpm = s.value;
        this.spindle = code === 3 ? 'cw' : 'ccw';
        this.events.push({ kind: 'spindle', line, state: this.spindle, rpm: this.rpm });
        return;
      }
      case 5:
        this.spindle = 'off';
        this.events.push({ kind: 'spindle', line, state: 'off', rpm: this.rpm });
        return;
      case 6:
        this.toolChange(words, line);
        return;
      case 7:
        this.events.push({ kind: 'air', line, on: true });
        return;
      case 9:
        this.events.push({ kind: 'air', line, on: false });
        return;
      case 321:
        this.laser = true;
        this.sawLaser = true;
        this.events.push({ kind: 'laser-mode', line, on: true });
        return;
      case 322:
        this.laser = false;
        this.events.push({ kind: 'laser-mode', line, on: false });
        return;
      case 323:
        this.sawLaser = true;
        return;
      case 490:
        if (sub === 1) this.events.push({ kind: 'pause', line, reason: 'M490.1' });
        else if (sub === 2) this.events.push({ kind: 'pause', line, reason: 'M490.2' });
        else this.diag('warning', 'atc-self-check', line, 'bare M490 is the ATC motor self-check, which a manual-change machine does not have');
        return;
      case 491:
        this.events.push({ kind: 'tlo-calibrate', line });
        this.unknownPosition();
        return;
      case 600:
        this.events.push({ kind: 'pause', line, reason: 'M600' });
        return;
      default:
        if (NO_EFFECT_M.has(code)) return;
        this.diag('error', 'unknown-code', line, `unknown M code M${mw.text}`);
    }
  }

  /**
   * `M2` / `M30`, as the firmware executes them. The Z1 runs in grbl mode (the CNC build
   * defaults it on), so `M30` is end-of-program, exactly like `M2`. The dispatcher issues
   * `M5` and `M9`, sets the modal motion to `G1`, and the robot resets the work offset to
   * G54 and the distance mode to absolute. Makera's concatenated samples depend on this:
   * `M30` ends one program and `T1M6` starts the next with no `M5` between.
   */
  private programEnd(line: number): void {
    if (this.spindle !== 'off') {
      this.spindle = 'off';
      this.events.push({ kind: 'spindle', line, state: 'off', rpm: this.rpm });
    }
    this.events.push({ kind: 'air', line, on: false });
    this.events.push({ kind: 'program-end', line });
    this.motion = 1;
    this.absolute = true;
    if (this.wcs !== 0) this.work = [null, null, null];
    this.wcs = 0;
  }

  /**
   * `M6`, as the firmware executes it. It needs its `T` in the SAME command; does nothing
   * if the tool is already active; and otherwise runs a macro that lifts, waits for the
   * operator, probes the tool-length sensor twice and saves the new offset — so it
   * CALIBRATES BY ITSELF and `M491` is not required after it.
   *
   * It does NOT halt on a running spindle. It turns the spindle off first and halts only
   * if the spindle is STILL running afterwards, which a program cannot cause. (An earlier
   * version of this parser, and the dialect document, said the opposite; that produced 7
   * false errors on 6 vendor files.)
   *
   * Afterwards the head returns to the SAVED X and Y at the machine's clearance Z, so X and
   * Y are still known and only Z is not (it is a machine constant, `clearance_z`).
   */
  private toolChange(words: Word[], line: number): void {
    const tw = this.word(words, 'T');
    if (!tw) {
      this.diag('error', 'm6-without-t', line, 'M6 with no T in the same command: the firmware only acts on M6 when a T word is attached, so this does nothing');
      return;
    }
    const tool = tw.value;
    const stoppedSpindle = this.spindle !== 'off';
    if (stoppedSpindle) {
      this.spindle = 'off';
      this.events.push({ kind: 'spindle', line, state: 'off', rpm: this.rpm });
    }
    const noOp = this.tool !== null && this.tool === tool;
    this.events.push({ kind: 'tool-change', line, tool, noOpIfActive: true, noOp, stoppedSpindle });
    this.toolChanges++;
    if (!noOp) {
      this.tool = tool;
      this.work[2] = null;
      this.machine[2] = null;
    }
  }
}

/** Lower a G-code program to events, collecting every diagnostic. Never throws. */
export function parseGcode(source: string): ParseResult {
  const it = new Interp();
  const lines = splitLines(source);
  for (let i = 0; i < lines.length; i++) it.handleLine(lines[i] as string, i + 1);
  const header: MkrHeader | null = it.headerRecords.length > 0 ? { records: it.headerRecords } : null;
  return {
    events: it.events,
    diagnostics: it.diagnostics,
    header,
    summary: {
      lines: it.lines,
      codeLines: it.codeLines,
      moves: it.moves,
      rapids: it.rapids,
      cuts: it.cuts,
      toolChanges: it.toolChanges,
      laser: it.sawLaser,
      usesArcs: it.usesArcs,
      usesRotary: it.usesRotary,
      usesInches: it.usesInches,
    },
  };
}

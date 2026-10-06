/**
 * The program verifier (#174): refuse unsafe output before it reaches the machine.
 *
 * THIS IS A CHECK ON THE ARTEFACT, NOT ON THE CODE THAT MADE IT. Unit tests on path
 * generation test the generator; this parses the emitted `.nc` and proves the FILE is safe.
 * The distinction is the repo's standing lesson (`/Fabrication.md` §9.3 item 10): a check
 * one level removed from the assertion is not evidence. The file is what the machine runs.
 *
 * It is deliberately CHEAP and EXACT — no wasm, no solids, no layer stack. The layer stack
 * is an injected `DepthLimit` function, because wood has no layer stack: CNC-2 passes
 * "thickness − minFloor inside the stock, 0 outside", CNC-3's badge passes #178's
 * `maxDepthAt`. Same verifier. The FIXTURE (the vise) is NOT checked here — that needs
 * solids and the simulation does it (#204). #206 requires both.
 *
 * THE PARSER AND THE RUNNER ARE CALLED, NEVER DUPLICATED: `parseGcode` lowers the file to
 * the event stream (#174's parser half, already landed), `buildTimeline` runs it and raises
 * the machine-state diagnostics (envelope, unknown position). This module adds the checks
 * nothing else does, and carries the runner's errors through.
 *
 * SCOPE. This verifies OUR OWN OUTPUT. The whitelist (check `not-our-dialect`) is strict
 * on purpose: our post-processor (#173) writes only a dozen words, so anything else means
 * the file is not ours or the post is broken. Third-party files are the simulator's
 * business (#196), not the verifier's. A file the verifier cannot fully parse is a FAILURE,
 * not a skip.
 *
 * Numbers are work-frame millimetres: X/Y are stock coordinates (0 at the top-front-left
 * corner), Z = 0 on the probed engraved face and every cut is negative. See `frames.ts` and
 * `/Fabrication.md` §7.2. `VerifyContext.minRapidZ` is the IR's `hopZ`.
 */

import type { Sacrificial } from '@/types/engraveJob';
import type { Vec3 } from '@/types/units';
import { parseGcode } from './gcode';
import { classifyLine, stripComment } from './gcode/lexer';
import type { MoveEvent, ParseResult, Pos } from './gcode/types';
import { applyEvent, buildTimeline, initialState, type MachineState } from './emulator/timeline';
import type { MillProfile } from './machine';
import { sacrificialBoxes, type SacrificialBox } from './sacrificial';
import type { Setup } from './setup';
import { cuttingRadiusForSweep, type Tool } from './tool';

/** Deepest permitted cut (positive mm below the top face) at a work-frame XY. 0 = no cutting allowed here. */
export type DepthLimit = (x: number, y: number) => number;

export interface VerifyContext {
  /** `toSetup(job, machine)` — #200. Carries the G54 origin and the starting tool. */
  setup: Setup;
  machine: MillProfile;
  tool: Tool;
  depthLimit: DepthLimit;
  /** Z at or above which XY rapids are allowed, work frame. The IR's hopZ. */
  minRapidZ: number;
}

export interface VerifyFinding {
  severity: 'error' | 'warning';
  code: string;
  line: number | null;
  message: string;
}

export interface VerifyReport {
  ok: boolean;
  findings: VerifyFinding[];
  stats: {
    lines: number;
    cuttingMoves: number;
    deepestZ: number;
    bbox: { min: Vec3; max: Vec3 };
  };
}

/**
 * The CNC-2 depth limit: `thickness − minFloor` inside the stock rectangle, `0` outside.
 * A positive return is the deepest permitted cut; 0 means no cutting is allowed at that
 * XY (outside the stock, or with no floor left).
 */
export function stockDepthLimit(stock: { length: number; width: number; thickness: number }, minFloor: number): DepthLimit {
  const limit = stock.thickness - minFloor;
  return (x, y) => (x >= 0 && x <= stock.length && y >= 0 && y <= stock.width ? limit : 0);
}

/** The stock a sacrificial setup is expressed against. Same shape `stockDepthLimit` takes. */
export interface StockDims {
  length: number;
  width: number;
  thickness: number;
}

export interface SacrificialLimitOptions {
  /** CNC-2's floor over the part: the deepest cut there is `thickness − minFloor`. */
  minFloor: number;
  /** The job's `breakthrough`, mm: how far a cut may pass below the part's underside (#213/#218). */
  breakthrough: number;
  /**
   * True where the item being checked cuts THROUGH the part (#218). The seam only: #218 passes
   * it; nothing generates through-cuts yet, so the default is false. Over the part it turns the
   * limit from `thickness − minFloor` into `thickness + breakthrough` when a board is present.
   */
  through?: boolean;
}

/** Is a work-frame XY inside an axis-aligned sacrificial box's XY footprint? Inclusive edges. */
function insideBox(b: SacrificialBox, x: number, y: number): boolean {
  return x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1];
}

/**
 * The verifier's `DepthLimit` for a job with sacrificial material (#213 §3). It is positive over
 * `supportedFootprint` and `0` over air, so check 5's `cut-outside-stock` — which asks whether
 * `depthLimit ≤ 0` at the tool's four edge points — means exactly "the cutter left the supported
 * region": it may run off the part onto sacrificial material, never into air.
 *
 * The table (#213 §3), all work-frame mm below the part's top face (Z = 0), `T` = part thickness:
 *
 *   over the part         `T − minFloor`, or `T + breakthrough` for a through-cut with a board;
 *   over a side strip     `T` — the strip's full height down to the part's underside, so cutting
 *                         the strip away is allowed — plus `breakthrough` where a board lies under
 *                         the point;
 *   over board overhang   `T + breakthrough` — the cutter is in air above the board down to the
 *                         part's underside, then may break through into the board;
 *   anywhere else         `0`.
 *
 * With `noneSacrificial()` this is exactly `stockDepthLimit(stock, minFloor)`. Pure data, no wasm:
 * every region here is an axis-aligned box, so containment is arithmetic and the verifier stays
 * cheap enough to run on the whole file (see the module comment).
 */
export function sacrificialDepthLimit(stock: StockDims, s: Sacrificial, opts: SacrificialLimitOptions): DepthLimit {
  const { length: L, width: W, thickness: T } = stock;
  const { minFloor, breakthrough } = opts;
  const through = opts.through ?? false;
  const partLimit = through && s.under !== null ? T + breakthrough : T - minFloor;

  const boxes = sacrificialBoxes(stock, s);
  const under = boxes.find((b) => b.id === 'under') ?? null;
  const sides = boxes.filter((b) => b.id !== 'under');

  return (x, y) => {
    if (x >= 0 && x <= L && y >= 0 && y <= W) return partLimit;
    for (const b of sides) {
      if (insideBox(b, x, y)) return T + (under !== null && insideBox(under, x, y) ? breakthrough : 0);
    }
    if (under !== null && insideBox(under, x, y)) return T + breakthrough;
    return 0;
  };
}

/** The words our post-processor (#173) may write. Anything else is `not-our-dialect`. */
const G_ALLOWED = new Set([0, 1, 21, 28, 90]);
const M_ALLOWED = new Set([2, 3, 5, 6, 7, 9]);
const PARAM_LETTERS = new Set(['T', 'S', 'F', 'X', 'Y', 'Z']);

interface SourceWord {
  letter: string;
  /** The numeric text after the letter, or '' for a bare letter. */
  text: string;
  /** 1-based source line. */
  line: number;
}

/** `12` / `02` / `90.1` → code and subcode; null when the text is not a plain number. */
function numParts(text: string): { code: number; sub: number } | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  return { code: Number(m[1]), sub: m[2] === undefined ? 0 : Number(m[2]) };
}

/**
 * Every code word in the program, in order, with its line — the whitelist, the preamble and
 * the ending all read the SOURCE, not the machine state. Comments (`;` and `(`) are stripped
 * the way the firmware strips them, and shell/blank/percent lines are skipped. A word is a
 * letter followed by an optional strict number; `T1M6` and `G00G53Z-3` split correctly
 * because the split is by letter, not whitespace (`/Z1-Firmware-Dialect.md` §1).
 */
function sourceWords(lines: string[]): SourceWord[] {
  const out: SourceWord[] = [];
  const word = /([A-Za-z])([+-]?(?:\d+\.?\d*|\.\d+)?)/g;
  lines.forEach((raw, i) => {
    const kind = classifyLine(raw);
    if (kind.kind !== 'code') return;
    const { code } = stripComment(kind.text);
    word.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = word.exec(code)) !== null) {
      out.push({ letter: m[1] as string, text: m[2] ?? '', line: i + 1 });
    }
  });
  return out;
}

const isG = (w: SourceWord, code: number): boolean => {
  if (w.letter !== 'G') return false;
  const c = numParts(w.text);
  return c !== null && c.sub === 0 && c.code === code;
};

const fmt = (v: number): string => v.toFixed(3);
const known3 = (p: Pos): p is [number, number, number] => p[0] !== null && p[1] !== null && p[2] !== null;

/**
 * Parse, run and check a program. Returns every finding; `ok` is
 * `findings.every(f => f.severity !== 'error')`.
 *
 * The order is the spec's: (1) parse errors, (2) the strict dialect whitelist, (3) every
 * error the runner raised, then the checks the runner does not do — (4) cut depth from the
 * injected limit, (5) the stock outline under the tool edge, (6) cutting with the spindle
 * off, (7) feed ceiling and missing feed, (8) spindle ceiling, (9) low XY rapids, (10) the
 * preamble, (11) the ending, (12) single tool.
 */
export function verifyProgram(text: string, ctx: VerifyContext): VerifyReport {
  const findings: VerifyFinding[] = [];
  const push = (code: string, line: number | null, message: string): void => {
    findings.push({ severity: 'error', code, line, message });
  };

  const parse: ParseResult = parseGcode(text);

  // ---- 1. parse-error. The verifier never passes a file it could not fully parse.
  for (const d of parse.diagnostics) {
    if (d.severity === 'error') push('parse-error', d.line, `${d.code}: ${d.message}`);
  }

  const lines = text.split(/\r\n|\n|\r/);
  const words = sourceWords(lines);

  // ---- 2. not-our-dialect. A strict whitelist: our post writes only these words.
  for (const w of words) {
    const shown = `${w.letter}${w.text}`;
    if (w.letter === 'G') {
      const c = numParts(w.text);
      if (c === null || c.sub !== 0 || !G_ALLOWED.has(c.code)) {
        push('not-our-dialect', w.line, `the word '${shown}' is not in the post's dialect (G0 G1 G21 G28 G90)`);
      }
    } else if (w.letter === 'M') {
      const c = numParts(w.text);
      if (c === null || c.sub !== 0 || !M_ALLOWED.has(c.code)) {
        push('not-our-dialect', w.line, `the word '${shown}' is not in the post's dialect (M2 M3 M5 M6 M7 M9)`);
      }
    } else if (!PARAM_LETTERS.has(w.letter)) {
      push('not-our-dialect', w.line, `the word '${shown}' is not in the post's dialect (only G, M, T, S, F, X, Y, Z words)`);
    }
  }

  // ---- 10/11 (source-based): the preamble and the ending, checked on the words.
  checkPreambleAndEnding(words, push);

  // ---- 3. runner-error. Run the file; carry every error the runner raised.
  let timeline: ReturnType<typeof buildTimeline> | null = null;
  try {
    timeline = buildTimeline(parse, ctx.setup, ctx.machine);
  } catch (err) {
    push('parse-error', null, `the program could not be lowered to moves: ${err instanceof Error ? err.message : String(err)}`);
  }

  let cuttingMoves = 0;
  let deepestZ = 0;
  const bboxMin: Vec3 = [Infinity, Infinity, Infinity];
  const bboxMax: Vec3 = [-Infinity, -Infinity, -Infinity];
  let sawAnyPoint = false;

  if (timeline !== null) {
    for (const d of timeline.diagnostics) {
      if (d.severity === 'error') push('runner-error', d.line, `${d.code}: ${d.message}`);
    }

    const toolRadius = toolRadiusOf(ctx.tool);
    const minRapidZ = ctx.minRapidZ;

    let state: MachineState = initialState(ctx.setup);
    let sawZ = false;
    let usedOpeningRapid = false;
    let seenCut = false;
    const toolNumbers = new Set<number>();

    for (const ev of timeline.events) {
      if (ev.kind === 'tool-change') {
        toolNumbers.add(ev.tool);
        if (seenCut) push('multi-tool', ev.line, `an M6 to T${ev.tool} appears after the first cutting move; V1 is single-tool`);
        state = applyEvent(state, ev, ctx.setup);
        continue;
      }
      if (ev.kind === 'spindle') {
        if (ev.rpm !== null && ev.rpm > ctx.machine.maxRpm) {
          push('rpm-too-high', ev.line, `a spindle speed of ${ev.rpm} RPM exceeds the ${ctx.machine.name}'s ${ctx.machine.maxRpm} RPM ceiling`);
        }
        state = applyEvent(state, ev, ctx.setup);
        continue;
      }
      if (ev.kind !== 'move') {
        state = applyEvent(state, ev, ctx.setup);
        continue;
      }

      // ---- A move. Resolve BOTH ends through the runner's own reducer, so the frames and
      // the offsets are the runner's, not a second implementation's (the runner sets both
      // `work` and `machine` on every move while the WCS is G54, which our dialect requires).
      const m: MoveEvent = ev;
      const after = applyEvent(state, m, ctx.setup);
      const fromW = state.work;
      const toW = after.work;
      const isCut = m.mode === 'cut' && state.spindle !== 'off';

      if (known3(fromW)) {
        collect(bboxMin, bboxMax, fromW);
        sawAnyPoint = true;
      }
      if (known3(toW)) {
        collect(bboxMin, bboxMax, toW);
        sawAnyPoint = true;
      }

      if (isCut) {
        cuttingMoves++;
        if (known3(toW)) deepestZ = Math.min(deepestZ, toW[2]);
        if (known3(fromW)) deepestZ = Math.min(deepestZ, fromW[2]);

        // ---- 4. cut-too-deep. The primary check: at both endpoints and the midpoint.
        const points: [number, number, number][] = [];
        if (known3(fromW)) points.push(fromW);
        if (known3(toW)) points.push(toW);
        if (known3(fromW) && known3(toW)) {
          points.push([(fromW[0] + toW[0]) / 2, (fromW[1] + toW[1]) / 2, (fromW[2] + toW[2]) / 2]);
        }
        let worst: { p: [number, number, number]; over: number } | null = null;
        for (const p of points) {
          const over = -p[2] - ctx.depthLimit(p[0], p[1]);
          if (over > 1e-6 && (worst === null || over > worst.over)) worst = { p, over };
        }
        if (worst !== null) {
          const [x, y, z] = worst.p;
          push(
            'cut-too-deep',
            m.line,
            `a cutting move reaches Z=${fmt(z)} at (${fmt(x)}, ${fmt(y)}), deeper than the ${fmt(ctx.depthLimit(x, y))} mm permitted there`,
          );
        }

        // ---- 5. cut-outside-stock. The tool EDGE, not just the centre: depthLimit must be
        // above 0 at the four points ±r in X and Y. With a sacrificial setup the limit is
        // `sacrificialDepthLimit`, positive over `supportedFootprint` (#213), so this is "the
        // cutter left the part onto air", not "it touched anything but the part".
        let outside: { x: number; y: number } | null = null;
        for (const p of [fromW, toW]) {
          if (p[0] === null || p[1] === null) continue;
          for (const [px, py] of [
            [p[0] + toolRadius, p[1]],
            [p[0] - toolRadius, p[1]],
            [p[0], p[1] + toolRadius],
            [p[0], p[1] - toolRadius],
          ] as [number, number][]) {
            if (ctx.depthLimit(px, py) <= 0) {
              outside = { x: px, y: py };
              break;
            }
          }
          if (outside !== null) break;
        }
        if (outside !== null) {
          push(
            'cut-outside-stock',
            m.line,
            `the ${fmt(toolRadius)} mm-radius cutter edge reaches (${fmt(outside.x)}, ${fmt(outside.y)}), outside the stock`,
          );
        }

        // ---- 7. feed-too-high / feed-missing.
        if (m.feed === null) {
          push('feed-missing', m.line, 'a cutting move has no feed rate set');
        } else if (m.feed > ctx.machine.maxCutFeed) {
          push('feed-too-high', m.line, `a cutting feed of ${m.feed} mm/min exceeds the ${ctx.machine.name}'s ${ctx.machine.maxCutFeed} mm/min ceiling`);
        }
      }

      // ---- 6. spindle-off-cut. A G1 below Z = 0 with the spindle off (the runner records
      // these as air moves of kind `feed-spindle-off`).
      if (m.mode === 'cut' && state.spindle === 'off') {
        const zs: number[] = [];
        if (fromW[2] !== null) zs.push(fromW[2]);
        if (toW[2] !== null) zs.push(toW[2]);
        if (zs.length > 0 && Math.min(...zs) < 0) {
          push('spindle-off-cut', m.line, `a feed move reaches Z=${fmt(Math.min(...zs))} with the spindle off`);
        }
      }

      // ---- 9. rapid-too-low. An XY rapid below minRapidZ. A pure-Z rapid is a retract and
      // is allowed at any height. The program's opening XY positioning move (before any Z
      // word) is the one exception — Studio's own files and our post open that way.
      if (m.mode === 'rapid') {
        const movedX = axisMoved(fromW[0], toW[0]);
        const movedY = axisMoved(fromW[1], toW[1]);
        if (movedX || movedY) {
          const zs: number[] = [];
          if (fromW[2] !== null) zs.push(fromW[2]);
          if (toW[2] !== null) zs.push(toW[2]);
          const zLow = zs.length > 0 ? Math.min(...zs) : null;
          if (zLow === null) {
            if (!sawZ && !usedOpeningRapid) {
              usedOpeningRapid = true;
            } else {
              push('rapid-too-low', m.line, 'an X/Y rapid runs at an unknown Z: the program never established where the tool is');
            }
          } else if (zLow < minRapidZ) {
            push('rapid-too-low', m.line, `an X/Y rapid runs at Z=${fmt(zLow)}, below the permitted rapid height Z=${fmt(minRapidZ)}`);
          }
        }
      }

      if (m.commanded[2] || m.values[2] !== null) sawZ = true;
      if (isCut) seenCut = true;
      state = after;
    }

    if (toolNumbers.size > 1) {
      push('multi-tool', null, `the program uses ${toolNumbers.size} distinct tools (${[...toolNumbers].sort((a, b) => a - b).join(', ')}); V1 is single-tool`);
    }
  }

  const bbox = sawAnyPoint
    ? { min: bboxMin, max: bboxMax }
    : { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3 };

  return {
    ok: findings.every((f) => f.severity !== 'error'),
    findings,
    stats: {
      lines: parse.summary.lines,
      cuttingMoves,
      deepestZ,
      bbox,
    },
  };
}

/** Did the resolved axis actually move? Unknown→known counts (we cannot disprove a move). */
function axisMoved(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return false;
  if (a === null || b === null) return true;
  return a !== b;
}

function collect(min: Vec3, max: Vec3, p: [number, number, number]): void {
  for (let i = 0; i < 3; i++) {
    const v = p[i] as number;
    if (v < (min[i] as number)) min[i] = v;
    if (v > (max[i] as number)) max[i] = v;
  }
}

/**
 * The cutter radius for the stock-outline check. V1 sweeps a flat end mill; the sweep's own
 * refusal (`cuttingRadiusForSweep`) is the authority. A tool it refuses has no usable
 * radius, so the edge test degenerates to the centre — the sweep will refuse the same job
 * for the same reason, so the verifier does not invent a second refusal code here.
 */
function toolRadiusOf(tool: Tool): number {
  const r = cuttingRadiusForSweep(tool);
  if (r.ok) return r.radius;
  const d = tool.tipDiameter ?? tool.diameter;
  return d === null || !(d > 0) ? 0 : d / 2;
}

/** Check 10 (preamble) and check 11 (ending) from the source words. */
function checkPreambleAndEnding(words: SourceWord[], push: (code: string, line: number | null, message: string) => void): void {
  // 10. bad-preamble: the first motion must be preceded by G90 and G21.
  let sawG90 = false;
  let sawG21 = false;
  for (const w of words) {
    if (w.letter === 'G') {
      if (isG(w, 90)) {
        sawG90 = true;
        continue;
      }
      if (isG(w, 21)) {
        sawG21 = true;
        continue;
      }
      const c = numParts(w.text);
      if (c !== null && (c.code === 0 || c.code === 1)) {
        if (!sawG90 || !sawG21) {
          const missing = [!sawG90 ? 'G90' : null, !sawG21 ? 'G21' : null].filter((v) => v !== null).join(' and ');
          push('bad-preamble', w.line, `the first motion is not preceded by ${missing}`);
        }
        break;
      }
      continue;
    }
    if (w.letter === 'X' || w.letter === 'Y' || w.letter === 'Z') {
      if (!sawG90 || !sawG21) {
        const missing = [!sawG90 ? 'G90' : null, !sawG21 ? 'G21' : null].filter((v) => v !== null).join(' and ');
        push('bad-preamble', w.line, `the first motion is not preceded by ${missing}`);
      }
      break;
    }
  }

  // 11. bad-ending: the last program-end word must be M2/M02 (or M30), preceded by the
  // spindle OFF. Our post writes `M05`, `G28`, `M02`, so the off word need not be adjacent.
  let lastEnd = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i] as SourceWord;
    if (w.letter !== 'M') continue;
    const c = numParts(w.text);
    if (c !== null && c.sub === 0 && (c.code === 2 || c.code === 30)) {
      lastEnd = i;
      break;
    }
  }
  if (lastEnd < 0) {
    push('bad-ending', null, 'the program does not end with M02: no program-end word');
    return;
  }
  for (let j = lastEnd - 1; j >= 0; j--) {
    const w = words[j] as SourceWord;
    if (w.letter !== 'M') continue;
    const c = numParts(w.text);
    if (c === null) continue;
    if (c.code === 5) return; // spindle OFF before M02 — the good ending.
    if (c.code === 3 || c.code === 4) {
      push('bad-ending', w.line, `the spindle is still on at M02 (the last spindle word before M02 is ${w.letter}${w.text})`);
      return;
    }
  }
  push('bad-ending', (words[lastEnd] as SourceWord).line, 'the program ends with M02 but never turns the spindle off (no M5/M05 before it)');
}

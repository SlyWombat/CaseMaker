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
 * solids and the simulation does it (#204). #206 requires both. The one exception is the bracket and
 * its top clamps (#427): their footprints are flat rectangles with a top, so `clamp-in-path` and
 * `bracket-in-path` are exact segment tests here (`mounts/inPath.ts`), when the caller passes them.
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
// inPath only (types from bracket): the verifier runs in workers and must not pull in the defaults client.
import { mountInPath, type PathSegment } from './mounts/inPath';
import type { MountObstacle } from './mounts/bracket';
import { cuttingDiameter, cuttingRadiusForSweep, traceRadiusAt, type Tool } from './tool';

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
  /**
   * WHY the limit is what it is at (x, y), as the tail of the `cut-too-deep` sentence — `— the
   * magnet pocket's ceiling`, say (#285, #345). A plane the cutter must stay clear of and the
   * stock's own floor are different failures with different fixes, and the number alone does not
   * tell them apart.
   *
   * OPTIONAL: the CNC-2 and restart paths compute their limit from the stock alone and pass
   * nothing, and the message then ends exactly where it always did.
   */
  limitReasonAt?: (x: number, y: number) => string;
  /**
   * #427 — the mount's obstacles: the bracket's arms and the top clamps, work frame, with the mount's
   * uncertainty. OPTIONAL: absent means this mount has none modelled, and nothing here changes.
   */
  mountObstacles?: { obstacles: MountObstacle[]; uncertainty: number };
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
const G_ALLOWED = new Set([0, 1, 21, 28, 53, 90]);
/**
 * `M331`/`M332` (bare) are the vacuum the post now writes (#283), and they are the ONLY accessory
 * our post drives. `M7`/`M9` stay accepted although the post no longer writes them: the machine
 * answers both `ok` (it blows nothing — #283), our own authored bench file
 * (`tests/e2e/fixtures/three-strokes.nc`) and Studio's own files carry them, and refusing a word
 * this controller runs without complaint is not this verifier's job. They are legacy in the
 * dialect, not wrong in it.
 *
 * The sub-coded forms of the family (`M331.1` blowing, `M331.2` bed cleaning, `M331.4` static
 * removal) are refused by the `sub !== 0` rule below, as they always were: we drive the bare mode
 * and nothing else.
 */
const M_ALLOWED = new Set([2, 3, 5, 6, 7, 9, 331, 332]);
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
 * The order is the spec's: (1) parse errors, (2) the strict dialect whitelist — with a numbered
 * line refused under its own code, because the machine will not run one (#385) — (3) every
 * error the runner raised, then the checks the runner does not do — (4) cut depth from the
 * injected limit, (5) the stock outline under the tool edge, (6) cutting with the spindle
 * off, (7) feed ceiling and missing feed, (8) spindle ceiling and a spindle start with no Z
 * established (#396), (9) low XY rapids, (10) the preamble, (11) the ending, (12) single tool.
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
        push('not-our-dialect', w.line, `the word '${shown}' is not in the post's dialect (G0 G1 G21 G28 G53 G90)`);
      }
    } else if (w.letter === 'M') {
      const c = numParts(w.text);
      if (c === null || c.sub !== 0 || !M_ALLOWED.has(c.code)) {
        push('not-our-dialect', w.line, `the word '${shown}' is not in the post's dialect (M2 M3 M5 M6 M7 M9 M331 M332)`);
      }
    } else if (w.letter === 'N') {
      // #385 — A NUMBERED LINE IS NOT A DIALECT QUESTION, IT IS A LINE THE MACHINE WILL NOT RUN.
      // `N10 M5` typed at our console answered `ok - ignore: [M5]` (bench 2026-10-12, runbook D1b,
      // `docs/bench/traces/2026-10-12-console.log`): the firmware strips the number but keeps
      // testing the ORIGINAL first character, `N`, which matches none of its G/M/T/S branches, so
      // the command after the number is dropped. A numbered program would therefore run as a
      // stream of silently skipped lines — the machine says `ok` to every one of them. Our post
      // writes no `N` word, so a file that carries one is not ours and is refused outright rather
      // than checked line by line.
      push(
        'numbered-line',
        w.line,
        `the word '${shown}' numbers this line, and the firmware executes NOTHING on a numbered line: it strips the number but keeps testing 'N', which matches none of its branches, and answers 'ok - ignore: [M5]' (bench 2026-10-12, #385). A numbered program runs as a stream of silently skipped lines`,
      );
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
  /** Every move with both ends known, for the mount's in-path test (#427). */
  const segments: PathSegment[] = [];
  /** Moves with an end the program never placed: the lowest Z known on them (null: none), and the line. */
  const unplaced: { line: number | null; lowZ: number | null }[] = [];

  if (timeline !== null) {
    for (const d of timeline.diagnostics) {
      if (d.severity === 'error') push('runner-error', d.line, `${d.code}: ${d.message}`);
    }

    const minRapidZ = ctx.minRapidZ;

    let state: MachineState = initialState(ctx.setup);
    let seenCut = false;
    const toolNumbers = new Set<number>();
    // #396 follow-up — A MACRO THE RUNNER COULD NOT RULE OUT IS NOT Z EVIDENCE. `T1 M6` with an
    // unstated starting tool is expanded because it cannot be ruled out; if the tool is already
    // active the firmware does nothing, the head never moves, and the clearance Z the macro ends
    // at is one the machine may never have reached. The runner marks that change (`speculative`,
    // set only when the Z was in doubt to begin with), and this flag carries it forward: it says
    // "the state knows a Z, but only because of that macro". An event that places the Z itself —
    // a move the PROGRAM wrote that commands Z, or a `G28`/`M491` (certain macros) — clears it,
    // and the two established-Z checks below read it alongside the state.
    let zUnproven = false;

    for (const ev of timeline.events) {
      if (ev.kind === 'tool-change') {
        toolNumbers.add(ev.tool);
        if (seenCut) push('multi-tool', ev.line, `an M6 to T${ev.tool} appears after the first cutting move; V1 is single-tool`);
        // A real change's macro places the head; a no-op forgets its Z outright (the reducer).
        zUnproven = ev.speculative === true;
        state = applyEvent(state, ev, ctx.setup);
        continue;
      }
      if (ev.kind === 'spindle') {
        if (ev.rpm !== null && ev.rpm > ctx.machine.maxRpm) {
          push('rpm-too-high', ev.line, `a spindle speed of ${ev.rpm} RPM exceeds the ${ctx.machine.name}'s ${ctx.machine.maxRpm} RPM ceiling`);
        }
        // ---- #396. A SPINDLE MUST NOT START AT A Z THE PROGRAM NEVER ESTABLISHED. After a manual
        // `M6` the head is wherever the last job left it — possibly inside the part — and our post
        // and restarts answer it the same way: a `G53 G0 Z<clearance>` lift in the MACHINE frame
        // (#384), BEFORE the spindle starts (#392), so a program of ours always states a Z first.
        // A file that does not — a hand-written one, or an import — spins the cutter up wherever
        // the head was left. The Z is ESTABLISHED when either frame knows it: a `G53` lift sets the
        // machine Z, and an absolute move sets the work Z (our dialect is all-absolute, `G90`).
        // Neither known means the program never placed the tool in Z at all. Read against the state
        // BEFORE the word, on EVERY start: the program's own `T1 M6` is a no-op when the tool is
        // already T1 (the operator changed it by hand), which is exactly the `#384` case where the
        // head sits wherever the last job left it.
        if (ev.state !== 'off' && (zUnproven || (state.work[2] === null && state.machine[2] === null))) {
          push(
            'spindle-at-unknown-z',
            ev.line,
            `the spindle starts with no Z established: nothing has placed the tool in Z first (a \`G53\` lift, or an absolute Z move), so it comes on wherever the head was left — possibly in the part${zUnproven ? "; the file's own `M6` may be a no-op (the starting tool is unstated), so the Z its macro ends at is not one the program established" : ''}`,
          );
        }
        state = applyEvent(state, ev, ctx.setup);
        continue;
      }
      if (ev.kind !== 'move') {
        // #396 follow-up — `G28` and `M491` are CERTAIN macros: the head really does go to the
        // clearance Z (#182), so they place the tool in Z whatever an earlier `M6` left in doubt.
        // SOURCE ONLY: the tool-change macro carries a synthetic `tlo-calibrate` step of its own,
        // and that one is exactly as uncertain as the change it belongs to.
        if ((ev.kind === 'home' || ev.kind === 'tlo-calibrate') && ev.synthetic === undefined) zUnproven = false;
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
      if (known3(fromW) && known3(toW)) segments.push({ line: m.line, mode: m.mode, from: fromW, to: toW });
      // A firmware macro's own steps travel at its clearance, and a line that commands no X or Y moves
      // straight up or down: neither sweeps sideways into a clamp. Anything else unplaced is recorded.
      else if (m.synthetic === undefined && (m.commanded[0] || m.commanded[1])) {
        const [za, zb] = [fromW[2], toW[2]];
        unplaced.push({ line: m.line, lowZ: za === null || zb === null ? null : Math.min(za, zb) });
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
          // #285 — name WHICH limit was broken when the caller can say. The trailing fragment is
          // passed through verbatim (it carries its own em dash) so this file needs no vocabulary
          // for voids, membranes or colour boundaries.
          const why = ctx.limitReasonAt?.(x, y);
          push(
            'cut-too-deep',
            m.line,
            `a cutting move reaches Z=${fmt(z)} at (${fmt(x)}, ${fmt(y)}), deeper than the ${fmt(ctx.depthLimit(x, y))} mm permitted there${why === undefined ? '' : ` ${why}`}`,
          );
        }

        // ---- 5. cut-outside-stock. The tool EDGE, not just the centre: depthLimit must be
        // above 0 at the four points ±r in X and Y. With a sacrificial setup the limit is
        // `sacrificialDepthLimit`, positive over `supportedFootprint` (#213), so this is "the
        // cutter left the part onto air", not "it touched anything but the part".
        //
        // The EDGE is the cutter's footprint at the DEEPEST point of the move, and for a V-bit
        // that is a function of the depth (#405): a 30° bit 1 mm down cuts a groove 0.418 mm
        // half-wide, where the tip alone is 0.15 — reading the tip would let the flank walk off the
        // stock by 0.27 mm unnoticed. The move's lowest point is the honest reading, so the depth
        // comes from the endpoints' own Z rather than from a bound taken over the whole file.
        let outside: { x: number; y: number; radius: number } | null = null;
        const deepestOfMove = Math.min(
          fromW[2] ?? 0,
          toW[2] ?? 0,
        );
        const edgeRadius = toolRadiusOf(ctx.tool, Math.max(0, -deepestOfMove));
        for (const p of [fromW, toW]) {
          if (p[0] === null || p[1] === null) continue;
          for (const [px, py] of [
            [p[0] + edgeRadius, p[1]],
            [p[0] - edgeRadius, p[1]],
            [p[0], p[1] + edgeRadius],
            [p[0], p[1] - edgeRadius],
          ] as [number, number][]) {
            if (ctx.depthLimit(px, py) <= 0) {
              outside = { x: px, y: py, radius: edgeRadius };
              break;
            }
          }
          if (outside !== null) break;
        }
        if (outside !== null) {
          push(
            'cut-outside-stock',
            m.line,
            `the ${fmt(outside.radius)} mm-radius cutter edge reaches (${fmt(outside.x)}, ${fmt(outside.y)}), outside the stock`,
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

      // ---- 9. rapid-too-low. An X/Y rapid whose PATH the program cannot place in Z. A pure-Z
      // rapid is a retract and is allowed at any height. There is NO exemption for the opening
      // positioning move: after a manual `M6` the head is wherever the last job left it, so an
      // XY rapid the file cannot place in Z is exactly the move that sends the tool through the
      // work. The file must establish Z first, and the only way it can do that from an unknown
      // work position is a MACHINE-frame lift — `G53 G0 Z<clearance>`, which the post writes and
      // which resolves to a known work Z through the setup's offset.
      //
      // #392 — WHERE IT ENDS IS NOT WHERE IT STARTS. This check used to take the LOWEST of the
      // Zs the move names, which let `G0 X10 Y8 Z5` through as a file's first motion: it names
      // Z=5, so the move looked placed, when in fact the tool travels to (10, 8) DIAGONALLY from
      // a height nobody knows, and the check could only fire when BOTH ends were unstated. So an
      // X/Y rapid now needs a Z ESTABLISHED AT ITS START; the end Z remains an extra bound.
      if (m.mode === 'rapid') {
        const movedX = axisMoved(fromW[0], toW[0]);
        const movedY = axisMoved(fromW[1], toW[1]);
        if (movedX || movedY) {
          // #396 follow-up — `zUnproven` gates the PROGRAM's rapids only. The steps of an expanded
          // macro are the FIRMWARE's moves: it traverses at its own clearance Z, which on the
          // branch where the macro runs it really reaches, so a macro step is never refused for
          // starting at a Z the FILE did not place.
          if (fromW[2] === null || (zUnproven && m.synthetic === undefined)) {
            const ends = toW[2] === null ? '' : ` (stating only where it ends, Z=${fmt(toW[2])}, places nothing: the tool travels to that end from wherever it was)`;
            push('rapid-too-low', m.line, `an X/Y rapid starts at a Z the program never established: nothing lifts the tool to a known height first, so the move runs diagonally from an unknown height${ends}`);
          } else {
            const zLow = toW[2] === null ? fromW[2] : Math.min(fromW[2], toW[2]);
            if (zLow < minRapidZ) {
              push('rapid-too-low', m.line, `an X/Y rapid runs at Z=${fmt(zLow)}, below the permitted rapid height Z=${fmt(minRapidZ)}`);
            }
          }
        }
      }

      // #396 follow-up — a move the PROGRAM wrote that commands Z places the tool itself, for the
      // events that FOLLOW it. The moves of an expanded macro are synthetic (the runner's own
      // steps), so they cannot clear it however much Z they appear to assert. Cleared HERE, after
      // the rapid check rather than before it: that check judges the move's own X/Y travel against
      // the Z it STARTS at, and a `G0 X5 Y5 Z5` runs those legs from wherever the head was left just
      // as a `G0 X5 Y5` does. Clearing first refused the Z-less form and passed the Z-on-the-line
      // form, which is the same hazard with a word that places nothing (review, 2026-10-13).
      if (m.synthetic === undefined && m.commanded[2] === true) zUnproven = false;

      if (isCut) seenCut = true;
      state = after;
    }

    // ---- 12. clamp-in-path / bracket-in-path (#427). The widest part of the tool that can pass
    // alongside a clamp is its body — the shank or the cutting diameter, whichever is larger.
    const mount = ctx.mountObstacles;
    if (mount && mount.obstacles.length > 0) {
      const widths = [ctx.tool.handleDiameter, ctx.tool.diameter, ctx.tool.tipDiameter, cuttingDiameter(ctx.tool)].filter(
        (d): d is number => d !== null && d > 0,
      );
      if (widths.length === 0) {
        push('clamp-unchecked', null, 'the tool states no diameter, so the clamps and the bracket could not be checked against the toolpath');
      } else {
        for (const f of mountInPath(segments, mount.obstacles, { radius: Math.max(...widths) / 2, uncertainty: mount.uncertainty })) {
          push(f.code, f.line, f.message);
        }
      }
      // A move with an end the program never placed cannot be clipped. It is safe only when both its ends
      // are known to be above every obstacle's top; otherwise it is reported, never silently left out.
      const highest = Math.max(...mount.obstacles.map((o) => o.topZ)) + mount.uncertainty;
      const blind = unplaced.filter((u) => u.lowZ === null || u.lowZ < highest);
      if (blind.length > 0) {
        push(
          'clamp-unchecked',
          blind[0]!.line,
          `${blind.length} move${blind.length === 1 ? '' : 's'} (the first here) ${blind.length === 1 ? 'has' : 'have'} a position the program never placed, below the clamps' tops at Z ${fmt(highest)}, so ${blind.length === 1 ? 'it' : 'they'} could not be checked against the clamps and the bracket`,
        );
      }
      // The collet nut rides `stickout` above the tip. If the deepest cut brings it below a clamp's top, the
      // nut's own clearance matters: checked with the machine's nut when it is known, said plainly when not.
      const stickout = ctx.tool.stickout;
      if (stickout !== null && stickout > 0 && segments.length > 0) {
        const lowestTip = Math.min(...segments.map((sg) => Math.min(sg.from[2], sg.to[2])));
        if (lowestTip + stickout < highest) {
          const nut = ctx.machine.holder;
          if (nut === null) {
            push(
              'clamp-unchecked',
              null,
              `the cutter sticks out ${fmt(stickout)} mm and reaches Z ${fmt(lowestTip)}, so its collet nut comes down to Z ${fmt(lowestTip + stickout)}, below the clamps' tops at Z ${fmt(highest)}; the nut's size is not recorded, so its clearance from the clamps could not be checked`,
            );
          } else {
            const raised = segments.map((sg) => ({
              ...sg,
              from: [sg.from[0], sg.from[1], sg.from[2] + stickout] as [number, number, number],
              to: [sg.to[0], sg.to[1], sg.to[2] + stickout] as [number, number, number],
            }));
            for (const f of mountInPath(raised, mount.obstacles, { radius: nut.nutDiameter / 2, uncertainty: mount.uncertainty })) {
              push(f.code, f.line, `the collet nut (${fmt(stickout)} mm above the tip): ${f.message}`);
            }
          }
        }
      }
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
 * The cutter radius for the stock-outline check at `depth` mm below the top face.
 *
 * A flat end mill's answer does not depend on the depth — the sweep's own contract
 * (`cuttingRadiusForSweep`) is the authority for one, and the verifier does not invent a second
 * refusal code for a tool it refuses. A V-BIT's does: its footprint is the groove's half-width at
 * the depth it is cutting, `tip + d·tan(halfAngle)`, and `traceRadiusAt` is the ONE statement of
 * that (#405). Reading the TIP instead (the `cuttingDiameter` fallback below) under-reads the
 * footprint of the very cutter this check exists for: a 30° bit 1 mm down cuts 0.418 mm half-wide,
 * not the 0.15 mm tip, so the flank could walk 0.27 mm off the stock with nothing said.
 *
 * A tool that can neither sweep nor trace (a ball nose, a bull nose) still falls back to its
 * cutting diameter: the sweep refuses the job for the same reason, so the degenerate reading is
 * never the one that decides anything.
 */
function toolRadiusOf(tool: Tool, depth: number): number {
  const r = cuttingRadiusForSweep(tool);
  if (r.ok) return r.radius;
  const v = traceRadiusAt(tool, depth);
  if (v !== null) return v;
  const d = cuttingDiameter(tool);
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

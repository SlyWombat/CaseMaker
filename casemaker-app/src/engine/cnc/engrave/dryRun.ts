/**
 * #547 — the dry-run transform: turn a verified CUTTING program into an AIR program that rehearses
 * the real XY path with the spindle off and every work-frame Z at or above a safe plane.
 *
 * THE RULE IT LIVES UNDER. A dry-run program is a DIFFERENT TEXT than the one the verifier passed,
 * so it must be verified itself before it is uploaded (the verified-only wall, `uploadGate.ts`).
 * It is produced by LIFTING the already-generated program — never by re-plumbing the CAM generators
 * — so the real toolpaths stay byte-identical and this module is a single, testable transformation.
 * `liftForDryRun` parses the `.nc`, drops the spindle and lifts the work-frame Z; `verifyDryRun`
 * re-checks that lifted text with the same parser/emulator the real program was checked with. The
 * X and Y words are never touched, so the head-follow in the viewport and the progress bar behave
 * exactly as they do on the real run.
 *
 * WHAT IT CHANGES, and what it does not:
 *
 *   - DROPS the spindle-on command (`S… M3` in our post; `M4` defensively). The spindle never
 *     spins — the issue's hard requirement. `M05` stays, so the ending still reads "spindle off
 *     before M02". Our post (#173) writes no spin-up dwell, so there is nothing to wait for.
 *   - LIFTS every work-frame Z below `safeZ` to `safeZ` (default the post's own final retract,
 *     15 mm above the probed top — clear of the stock, the vise jaws and the clamps). A
 *     machine-frame `G53` lift is left alone: its Z is a machine coordinate and already the
 *     tool-change clearance, not a work height to rewrite.
 *   - The vacuum words (`M331`/`M332`), the `T… M6` tool change and the `G28`/`M02` ending are
 *     untouched, so the FULL dry run still rehearses that choreography.
 *
 * The two LEVELS are a UI concern, not a transform concern: `'traverse'` plays one lifted program
 * for a fast head/progress rehearsal; `'full'` plays the whole lifted list through the ordinary
 * release flow (bit-change prompts included). Both use the same lifted text.
 */

import { classifyLine, parseWords, splitLines, stripComment, type Word } from '../gcode/lexer';
import type { Diagnostic } from '../gcode/types';
import { FINAL_RETRACT_Z } from '../post/z1';
import { HOP_Z } from '../cam/ir';
import { verifyProgram, type VerifyReport } from '../verify';
import type { Setup } from '../setup';
import type { MillProfile } from '../machine';
import type { Tool } from '../tool';
import { programHash } from '../programHash';

/** The plane a dry run flies at: the post's own final retract, above the stock, jaws and clamps. */
export const DRY_RUN_SAFE_Z = FINAL_RETRACT_Z;

/** The two rehearsals the issue names (#547): a minimal traverse, or the whole operator flow. */
export type DryRunLevel = 'traverse' | 'full';

/** A lifted program, with the fresh verifier report the upload gate demands. */
export interface DryRunProgram {
  nc: string;
  verify: VerifyReport;
  hash: string;
}

/** Format a Z word the way the post does (three decimals). */
const fmtZ = (v: number): string => v.toFixed(3);

function isG(w: Word, code: number): boolean {
  return w.letter === 'G' && w.value === code;
}

function isM(w: Word, code: number): boolean {
  return w.letter === 'M' && w.value === code;
}

/** Re-emit the parsed words in their original order, single-spaced; `liftedZ` replaces any Z word. */
function emit(words: readonly Word[], liftedZ: string | null): string {
  const parts: string[] = [];
  for (const w of words) {
    parts.push(w.letter === 'Z' && liftedZ !== null ? `Z${liftedZ}` : `${w.letter}${w.text}`);
  }
  return parts.join(' ');
}

/**
 * Lift one program into the air (#547): drop the spindle-on word(s), lift every work-frame Z below
 * `safeZ` to `safeZ`, and leave the XY path byte-for-byte alone.
 *
 * No modal Z needs tracking. Our post's sticky state reuses the last commanded Z, and every
 * work-frame Z it commands is either already at or above `safeZ`, or is lifted to `safeZ` here — so
 * a move that names no Z always runs at a Z that has already been lifted. The one exception is the
 * opening `G0 X.. Y..` after the `G53` machine-frame lift, which has no work Z at all: it rides the
 * tool-change clearance, which is safe and passed the real verifier, so it is left exactly as it was.
 *
 * Lines the transform does not understand (a parse error, or a comment the lexer could not strip)
 * are left untouched: the verifier will report them again, and a dry run must never corrupt a
 * program it could not read.
 */
export function liftForDryRun(nc: string, safeZ: number = DRY_RUN_SAFE_Z): string {
  const out: string[] = [];
  for (const raw of splitLines(nc)) {
    const kind = classifyLine(raw);
    if (kind.kind !== 'code') {
      out.push(raw);
      continue;
    }
    const stripped = stripComment(kind.text);
    if (stripped.droppedAfterParen !== null || stripped.unterminatedParen) {
      out.push(raw);
      continue;
    }
    const diagnostics: Diagnostic[] = [];
    const words = parseWords(stripped.code, 0, diagnostics);
    if (diagnostics.some((d) => d.severity === 'error')) {
      out.push(raw);
      continue;
    }
    // The spindle must never spin (#547, the hard requirement). `S… M3` is one line in our post, so
    // dropping the line drops both the speed and the on-word. `M4` is dropped defensively.
    if (words.some((w) => isM(w, 3) || isM(w, 4))) {
      continue;
    }
    // A machine-frame lift is already the tool-change clearance; its Z is a machine coordinate and
    // must not be rewritten as a work height.
    if (words.some((w) => isG(w, 53))) {
      out.push(raw);
      continue;
    }
    const zWord = words.find((w) => w.letter === 'Z');
    if (zWord !== undefined && zWord.value < safeZ) {
      out.push(emit(words, fmtZ(safeZ)));
    } else {
      out.push(raw);
    }
  }
  return out.join('\n');
}

/** The context `verifyDryRun` needs, minus the parts a dry run makes moot. */
export interface DryRunVerifyDeps {
  setup: Setup;
  machine: MillProfile;
  tool: Tool;
}

/**
 * Re-verify a LIFTED program (#547). The lifted text has no spindle and no cutting moves, so the
 * depth limit is vacuous (no cut is judged) and the mount obstacles are not consulted (the head
 * flies at `safeZ`, above them). The checks that remain — parse, the strict dialect, the preamble
 * and ending, the runner's envelope, the rapid floor and single-tool — are all still run.
 *
 * `minRapidZ` is `HOP_Z`, the floor the real program was checked against: the transform only ever
 * raises Z, so a lifted program's rapids are never lower than the original's.
 */
export function verifyDryRun(nc: string, deps: DryRunVerifyDeps): VerifyReport {
  return verifyProgram(nc, {
    setup: deps.setup,
    machine: deps.machine,
    tool: deps.tool,
    depthLimit: () => Number.POSITIVE_INFINITY,
    minRapidZ: HOP_Z,
  });
}

/** Lift AND verify one program, ready for the upload gate. */
export function dryRunProgramFor(nc: string, deps: DryRunVerifyDeps, safeZ: number = DRY_RUN_SAFE_Z): DryRunProgram {
  const lifted = liftForDryRun(nc, safeZ);
  return { nc: lifted, verify: verifyDryRun(lifted, deps), hash: programHash(lifted) };
}

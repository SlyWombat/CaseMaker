/**
 * #1202 — A MOTION ROUTINE'S IDENTITY.
 *
 * The 2026-11-10 bench pressed the bracket-seat routine through a build in which it had NEVER moved
 * that controller, and nothing on the card said so. This module makes "the same routine" a fact the
 * app can keep: a routine id plus the SHAPE of its line sequence — which moves, in which order, at
 * which NAMED heights — never the coordinates. A routine whose shape changes in a later build is a
 * different routine, and is marked again.
 *
 * WHAT IS NOT IN THE SHAPE: coordinates, feeds, speeds, dwell times, tool numbers. Two presses on
 * two different blanks are the same routine; a press whose third and fourth moves swapped is not.
 *
 * THE HEIGHTS ARE NAMED BY THE ROUTINE'S PLAN (e.g. "clearance", "approach", "seek", "retract").
 * A Z word that matches no named height is `unnamed` — the shape still carries the op and the axis,
 * but the module deliberately cannot call two unnamed Z values different: a numeric difference is a
 * coordinate difference, and this identity is not about coordinates.
 */

import { programHash } from '@/engine/cnc/programHash';

/**
 * The motion routines the guard covers. The id is the record's key; the shape is what makes a
 * changed sequence new. Kept in one list so a card, a record and a test cannot spell one differently.
 */
export const MOTION_ROUTINE_IDS = [
  'registration',
  'seat-press',
  'mount-tap',
  'surface-seek',
  'edge-scan',
  'centre-find',
  'flip-registration',
  'rotary-tap',
  'face-angle',
  'clean-walk',
  'air-walk',
  'tool-change',
] as const;

export type MotionRoutineId = (typeof MOTION_ROUTINE_IDS)[number];

/** The names a routine gives its own heights, machine Z in mm (or a travel distance for a probe). */
export type NamedHeights = Readonly<Record<string, number>>;

/** One line's shape: what it commands and, when it commands a Z, which named height that is. */
export interface RoutineLineShape {
  /** The command words, numbers stripped: `G53 G0`, `G38.3`, `$H`, `M491`. */
  op: string;
  /** The axes the line moves, in X, Y, Z, A order; empty for a line that moves none. */
  axis: string;
  /** The named height (or travel) this line's Z word is, or null when the line carries no Z. */
  height: string | null;
}

export interface RoutineIdentity {
  routine: MotionRoutineId;
  /** FNV-1a over the ordered shapes — the part that makes a changed sequence "new". */
  shape: string;
  /** The shapes themselves, for a card or a spec to say which move changed. */
  lines: RoutineLineShape[];
}

/** The tolerance a Z word is matched against a named height with: the plan states the same number. */
const HEIGHT_EPSILON = 1e-6;

/** A command word: a G/M/T code (with its number) or a `$` word. Parameters and axes are not. */
const COMMAND_WORD = /^(?:\$|[GMT]\d)/;

/**
 * One line's shape. The op is its leading command words (`G53 G0`, `G38.3`, `$H`, `M491`); the axes
 * are the axis letters present; the height is the Z word matched against the routine's named heights.
 */
export function lineShapeOf(line: string, heights: NamedHeights = {}): RoutineLineShape {
  const upper = line.trim().toUpperCase();
  const words = upper.split(/\s+/);
  const opWords: string[] = [];
  for (const word of words) {
    if (!COMMAND_WORD.test(word)) break;
    opWords.push(word);
  }
  const op = opWords.join(' ');
  const axis = (['X', 'Y', 'Z', 'A'] as const).filter((a) => new RegExp(`(?:^|\\s)${a}[-+]?\\d`).test(upper)).join('');
  let height: string | null = null;
  const z = /(?:^|\s)Z([-+]?\d+(?:\.\d+)?)/.exec(upper);
  if (z !== null) {
    const value = Number(z[1]);
    height = 'unnamed';
    for (const [name, at] of Object.entries(heights)) {
      if (Math.abs(at - value) <= HEIGHT_EPSILON) {
        height = name;
        break;
      }
    }
  }
  return { op, axis, height };
}

/** The ordered shapes of a routine's line sequence. */
export function routineShapeOf(lines: readonly string[], heights: NamedHeights = {}): RoutineLineShape[] {
  return lines.map((line) => lineShapeOf(line, heights));
}

/**
 * The identity of a routine's line sequence. `lines` is the sequence the routine WILL send (the
 * dry run's recorded list), in order — so what is checked before the press and what is sent after
 * it are the same list.
 */
export function routineIdentityOf(
  routine: MotionRoutineId,
  lines: readonly string[],
  heights: NamedHeights = {},
): RoutineIdentity {
  const shapes = routineShapeOf(lines, heights);
  const text = shapes.map((s) => `${s.op}|${s.axis}|${s.height ?? ''}`).join('\n');
  return { routine, shape: programHash(text), lines: shapes };
}

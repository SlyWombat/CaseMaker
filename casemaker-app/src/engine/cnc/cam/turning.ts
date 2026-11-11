/**
 * #1226 — TURNING ROUGHING PASSES (planner v3, step E3a).
 *
 * On the 4th axis the rod turns under the tool. The simplest useful cut is lathe-style roughing:
 * the rod turns continuously while the tool moves slowly along it at a fixed distance from the
 * axis, so the path on the rod is a HELIX; then the tool steps closer to the axis and does it
 * again, down to the shape wanted. Makera's own rotary roughing moves exactly like this
 * (`docs/design/planner-v3.md` §2.7, §4A.7).
 *
 * The shape wanted is a PROFILE: for each x along the rod, the radius to leave (a cell array;
 * `-Infinity` where there is no part). In a rotary program x is along the rod, y is always 0, z
 * is the tool tip's distance from the axis, and a is the rod's angle in degrees — unwound, and
 * counting DOWNWARD here (0, −30, −60 …) as Makera's programs do.
 *
 * NOTHING CALLS THIS YET: it is the roughing path alone (a finishing helix, grooves and part-off
 * are their own issues), and the caller states `xFrom`/`xTo` already inside the chuck/tailstock
 * keep-outs. Every number is an input; no shop setting is read here.
 */
import type { CamMove } from './ir';

export interface TurningInput {
  /** The radius to leave at each cell along the rod; -Infinity where there is no part. Cell i is at x0 + i * dx. */
  profile: Float64Array | readonly number[];
  x0: number;
  dx: number;
  /** The rod's own radius before cutting, mm. */
  stockRadiusMm: number;
  /** The cutter's radius, mm: how far along the rod the tool reaches either side of its centre. */
  cutterRadiusMm: number;
  /** How much closer to the axis each pass goes, mm. */
  stepDownMm: number;
  /** How far the tool moves along the rod in one full turn, mm. */
  pitchMmPerTurn: number;
  /** Extra material to leave on the profile for a finishing pass, mm. */
  allowanceMm: number;
  /** How far above the rod's own surface the tool travels between passes, mm. */
  clearanceMm: number;
  /** The tool never goes closer to the axis than this, mm. */
  floorRadiusMm: number;
  /** The part of the rod to cut: the tool centre stays between these, mm. xTo is where each pass starts. */
  xFrom: number;
  xTo: number;
  /** Degrees of turn per move. */
  degPerMove: number;
  feedMmPerMin: number;
  plungeFeedMmPerMin: number;
}

/**
 * The radius the tool tip may go down to with its centre at x: the highest profile value under
 * the cutter's width, plus the allowance, never below the floor.
 */
export function turningTargetAt(input: TurningInput, x: number): number {
  const { profile, x0, dx, cutterRadiusMm, allowanceMm, floorRadiusMm } = input;
  let m = -Infinity;
  for (let i = 0; i < profile.length; i++) {
    const xc = x0 + i * dx;
    if (Math.abs(xc - x) <= cutterRadiusMm + dx / 2 + 1e-9 && profile[i]! > m) m = profile[i]!;
  }
  if (m === -Infinity) return floorRadiusMm;
  return Math.max(m + allowanceMm, floorRadiusMm);
}

/**
 * The roughing moves: helical passes from the rod's surface down to the profile. Empty when there
 * is nothing to remove.
 *
 * Each pass starts at `xTo`, plunges to the pass's radius, and feeds toward `xFrom` while the rod
 * turns; where the profile is higher than the pass's radius the tool rides up over it. Between
 * passes it lifts clear and goes back to `xTo` without unwinding the angle.
 */
export function turningRoughMoves(input: TurningInput): CamMove[] {
  const {
    stockRadiusMm,
    stepDownMm,
    pitchMmPerTurn,
    dx,
    degPerMove,
    clearanceMm,
    xFrom,
    xTo,
    feedMmPerMin,
    plungeFeedMmPerMin,
  } = input;
  if (!(stepDownMm > 0) || !(pitchMmPerTurn > 0) || !(dx > 0) || !(degPerMove > 0)) {
    throw new Error('cam/turning: stepDownMm, pitchMmPerTurn, dx and degPerMove must be above 0');
  }
  if (xTo <= xFrom) return [];
  let lowest = Infinity;
  const cells = Math.floor((xTo - xFrom) / dx + 1e-9);
  for (let k = 0; k <= cells; k++) lowest = Math.min(lowest, turningTargetAt(input, xFrom + k * dx));
  lowest = Math.min(lowest, turningTargetAt(input, xTo));
  if (lowest >= stockRadiusMm - 1e-9) return [];

  const clearZ = stockRadiusMm + clearanceMm;
  const turns = (xTo - xFrom) / pitchMmPerTurn;
  const nSteps = Math.ceil((turns * 360) / degPerMove - 1e-9);
  let aStart = 0;
  let k = 0;
  const moves: CamMove[] = [];
  for (;;) {
    k += 1;
    const zk = Math.max(stockRadiusMm - k * stepDownMm, lowest);
    moves.push({ kind: 'rapid', x: xTo, y: 0, z: clearZ, a: aStart });
    moves.push({
      kind: 'feed',
      x: xTo,
      y: 0,
      z: Math.max(zk, turningTargetAt(input, xTo)),
      a: aStart,
      f: plungeFeedMmPerMin,
    });
    for (let s = 1; s <= nSteps; s++) {
      const frac = Math.min(1, (s * degPerMove) / (turns * 360));
      const x = xTo - frac * (xTo - xFrom);
      const a = aStart - frac * turns * 360;
      moves.push({ kind: 'feed', x, y: 0, z: Math.max(zk, turningTargetAt(input, x)), a, f: feedMmPerMin });
    }
    const last = moves[moves.length - 1]!;
    moves.push({ kind: 'rapid', x: last.x, y: 0, z: clearZ, a: last.a });
    aStart = last.a!;
    if (zk <= lowest + 1e-9) break;
  }
  return moves;
}

export interface TurningFinishInput extends TurningInput {
  /** How far the tool moves along the rod in one full turn while finishing, mm. */
  finishPitchMmPerTurn: number;
  /** The rod's angle when the pass starts, degrees: the last angle of the roughing, so the rod is never unwound. */
  aStartDeg: number;
}

/**
 * #1228 — THE FINISHING HELIX: ONE slow pass with the tip on the profile itself. It starts at
 * `xTo` at the angle the roughing ended on, follows `min(stockRadius, target)` to `xFrom` while the
 * rod turns, and lifts clear. Where the part is bigger than the rod the tip rides on the rod and
 * cuts nothing. Empty when the profile asks for no cut at all.
 */
export function turningFinishMoves(input: TurningFinishInput): CamMove[] {
  const {
    finishPitchMmPerTurn,
    aStartDeg,
    dx,
    degPerMove,
    stockRadiusMm,
    clearanceMm,
    xFrom,
    xTo,
    feedMmPerMin,
    plungeFeedMmPerMin,
  } = input;
  if (!(finishPitchMmPerTurn > 0) || !(dx > 0) || !(degPerMove > 0)) {
    throw new Error('cam/turning: finishPitchMmPerTurn, dx and degPerMove must be above 0');
  }
  if (xTo <= xFrom) return [];
  let lowest = Infinity;
  const cells = Math.floor((xTo - xFrom) / dx + 1e-9);
  for (let k = 0; k <= cells; k++) lowest = Math.min(lowest, turningTargetAt(input, xFrom + k * dx));
  lowest = Math.min(lowest, turningTargetAt(input, xTo));
  if (lowest >= stockRadiusMm - 1e-9) return [];

  const zAt = (x: number): number => Math.min(stockRadiusMm, turningTargetAt(input, x));
  const clearZ = stockRadiusMm + clearanceMm;
  const turns = (xTo - xFrom) / finishPitchMmPerTurn;
  const nSteps = Math.ceil((turns * 360) / degPerMove - 1e-9);
  const moves: CamMove[] = [];
  moves.push({ kind: 'rapid', x: xTo, y: 0, z: clearZ, a: aStartDeg });
  moves.push({ kind: 'feed', x: xTo, y: 0, z: zAt(xTo), a: aStartDeg, f: plungeFeedMmPerMin });
  for (let s = 1; s <= nSteps; s++) {
    const frac = Math.min(1, (s * degPerMove) / (turns * 360));
    const x = xTo - frac * (xTo - xFrom);
    const a = aStartDeg - frac * turns * 360;
    moves.push({ kind: 'feed', x, y: 0, z: zAt(x), a, f: feedMmPerMin });
  }
  const last = moves[moves.length - 1]!;
  moves.push({ kind: 'rapid', x: last.x, y: 0, z: clearZ, a: last.a });
  return moves;
}

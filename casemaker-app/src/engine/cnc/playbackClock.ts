/**
 * The transport clock (#198, `/Simulation.md` §8.0): the pure arithmetic that maps a
 * `SimPath` between program TIME and program STEP. No React, no timers, no store — every
 * function is a binary search, and all of them are exercised in `playbackClock.spec.ts`.
 *
 * The clock is indexed by PROGRAM STEP, not by checkpoint (§8.0): checkpoints are where the
 * material updates, and are deliberately not the scrubber's units. A path's `t` is
 * non-decreasing — a zero-duration move repeats the previous value — and its `step` is
 * strictly increasing, so `stepAtTime` (search on `t`) and `timeAtStep` (search on `step`)
 * are both exact.
 */

/**
 * The clock's view of a path: `SimPath` carries these three arrays, so a `SimPath` is
 * assignable. `line` is optional here so a hand-built path in a spec need not carry it.
 */
export interface ClockInput {
  /** Cumulative program seconds at each vertex (from `SimPath.t`). */
  t: Float32Array;
  /** The program step each vertex belongs to; strictly increasing (from `SimPath.step`). */
  step: Uint32Array;
  /** The 1-based source line each vertex's move came from (#198). */
  line?: Uint32Array;
}

/** What `advance` reports when the clock must stop. */
export type AdvanceStop = null | { reason: 'end' } | { reason: 'pause'; step: number };

/** The program step shown at `seconds` of program time: the last vertex with `t <= seconds`. */
export function stepAtTime(path: ClockInput, seconds: number): number {
  const n = path.t.length;
  if (n === 0) return 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((path.t[mid] as number) <= seconds) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  // Before the first vertex: the first step is still the position the clock is at step 0. A
  // path's first vertex may itself carry a non-zero step (leading non-move events), which is
  // the honest answer for "what step is shown".
  return path.step[i < 0 ? 0 : i] as number;
}

/**
 * Program time at which `step` completes: the `t` of the last vertex whose step is `<= step`.
 * A pause step is not a vertex (a pause is not a move), so this is the time of the last cut
 * before it — which is exactly the time the machine would have reached when it stopped.
 */
export function timeAtStep(path: ClockInput, step: number): number {
  const n = path.step.length;
  if (n === 0) return 0;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((path.step[mid] as number) <= step) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  return i < 0 ? 0 : (path.t[i] as number);
}

/** Total program time: `t[last]`, or 0 for an empty path. */
export function totalTime(path: ClockInput): number {
  return path.t.length === 0 ? 0 : (path.t[path.t.length - 1] as number);
}

/**
 * The source line of the current step: the line of the last vertex with `step <= step`, or
 * `null` when the path carries no line data (a hand-built path) or has no such vertex.
 */
export function lineAtStep(path: ClockInput, step: number): number | null {
  if (!path.line) return null;
  const n = path.step.length;
  if (n === 0) return null;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((path.step[mid] as number) <= step) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  return i < 0 ? null : ((path.line[i] as number | undefined) ?? null);
}

/**
 * Advance a playing clock by `dtWallSeconds * speed` of program time.
 *
 * Stops at the end of the program, or on the FIRST pause step that lies in
 * `(fromStep, toStep]` where `fromStep = stepAtTime(path, nowSeconds)` and `toStep` is the
 * step at the (clamped) target time. A pause is never skipped: crossing one clamps the new
 * time to that pause's `timeAtStep` and reports it.
 *
 * RESUMING PAST A PAUSE. When the caller stopped earlier at a pause, `nowSeconds` is exactly
 * that pause's time; the pause step is `> fromStep` (a pause is not a vertex), so a purely
 * step-based interval would re-trigger it forever. A pause whose time is `<= nowSeconds` is
 * therefore already behind the clock and is skipped — which is what "press play to continue
 * past it" means. Any pause strictly ahead in time still fires.
 */
export function advance(
  path: ClockInput,
  nowSeconds: number,
  dtWallSeconds: number,
  speed: number,
  pauseSteps: readonly number[],
): { seconds: number; stop: AdvanceStop } {
  const total = totalTime(path);
  const dt = Number.isFinite(dtWallSeconds) && dtWallSeconds > 0 ? dtWallSeconds : 0;
  const target = nowSeconds + dt * speed;
  const fromStep = stepAtTime(path, nowSeconds);
  const toStep = stepAtTime(path, Math.min(target, total));

  let firstPause: number | null = null;
  for (const p of pauseSteps) {
    if (p <= fromStep || p > toStep) continue;
    if (timeAtStep(path, p) <= nowSeconds) continue; // behind the clock (a resume)
    if (firstPause === null || p < firstPause) firstPause = p;
  }
  if (firstPause !== null) {
    return { seconds: timeAtStep(path, firstPause), stop: { reason: 'pause', step: firstPause } };
  }
  if (target >= total && total > 0) return { seconds: total, stop: { reason: 'end' } };
  if (total === 0) return { seconds: 0, stop: { reason: 'end' } };
  return { seconds: target, stop: null };
}

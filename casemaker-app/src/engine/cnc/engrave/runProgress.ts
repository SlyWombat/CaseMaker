/**
 * #1123-42 / #1145 — THE RUNNING PROGRAM'S PROGRESS, in the run watch's own words.
 *
 * The controller's status line carries the job's `P:` reading — the line being played and the
 * percent complete (`readJobProgress`, #386). The Cut step shows that as "Program 2 of 5 is 20 %
 * done — about 4 min left." and names the next program that needs a different cutter, because that
 * is the change the operator has to stand at the machine for.
 *
 * THE CLOCK IS OURS (#1145). `P:`'s THIRD field was read as "elapsed seconds" from one air-program
 * trace; the 2026-11-09 bench samples disprove it on a real program (1,776 at ~25 s in, 4,641 at
 * ~4 min, on a ~5-minute program), and its unit is still unresolved. So elapsed is the wall time
 * since the run watch FIRST SAW a `P:` reading — minus the stretches the job was suspended or
 * waiting on the operator's tool change — and the time left is that elapsed scaled by the fraction
 * still to run (`elapsed × (100 − percent) / percent`). Field 1 (the line) and the percent are read
 * exactly as before.
 *
 * HONEST EDGES. Before the machine reports a percentage there is no time to state; at 100 % the
 * program reads "finishing" rather than "0 s left" (the machine still has its trip home); and the
 * clock states no time at all until it has run {@link MIN_ELAPSED_FOR_ESTIMATE_S} seconds, because
 * a percent times a few hundred milliseconds is noise, not an estimate.
 *
 * THE NEXT BIT CHANGE IS THE RELEASE LIST'S ORDER, not a second schedule: the next program in cut
 * order that needs a different cutter from the one running, skipping programs this machine already
 * finished. Programs that share the running cutter are not a change; when no later program needs
 * another cutter, the job is cutting with its last one.
 */

import { formatDuration } from '@/engine/cnc/plan/format';

/**
 * The run watch's clock (#1145): when it first saw a `P:` reading, and the suspended stretches it
 * has to leave out. Wall-clock milliseconds; `RunEntry` in `machineRunStore` carries these fields.
 */
export interface RunClock {
  /** Wall-clock ms at the first `P:` reading; null/absent before one. */
  firstProgressAt?: number | null;
  /** Suspended (or operator tool-change) time already completed, ms. */
  pausedMs?: number | null;
  /** Wall-clock ms the current suspension began, or null when the job is not suspended. */
  pausedAt?: number | null;
}

/**
 * Seconds the program has been RUNNING: wall time since the first `P:` reading, less the completed
 * suspensions, frozen at the start of a suspension that is still on. Null before the first reading.
 */
export function runClockSeconds(clock: RunClock | null | undefined, nowMs: number): number | null {
  const first = clock?.firstProgressAt;
  if (first === null || first === undefined) return null;
  const stop = clock?.pausedAt ?? nowMs;
  const ms = stop - first - (clock?.pausedMs ?? 0);
  return ms <= 0 ? 0 : ms / 1000;
}

/**
 * No time estimate until the clock has run this long: a percent times a few hundred milliseconds is
 * noise, and the first poll of a program would otherwise read "about 0 s left" at its start.
 */
export const MIN_ELAPSED_FOR_ESTIMATE_S = 10;

/**
 * The time the percent and OUR elapsed imply is left, or null while there is nothing to divide: no
 * percentage, no clock, or 0/100 % (the second is the end-of-file trip home, not work left).
 */
export function remainingSeconds(percent: number | null, elapsedS: number | null): number | null {
  if (percent === null || elapsedS === null) return null;
  if (percent <= 0 || percent >= 100) return null;
  return Math.round((elapsedS * (100 - percent)) / percent);
}

/** One sentence for the program that is playing — the controller's percent, our clock. */
export function runningProgramWords(input: {
  /** The 1-based cut order of the program the machine plays. */
  active: number;
  /** How many programs the job has. */
  total: number;
  /** The controller's `P:` percent, or null before it reports one. */
  percent: number | null;
  /** OUR clock's seconds (#1145), or null before the first `P:` reading. */
  elapsedS: number | null;
  /** The run is paused: the clock will resume with the program. */
  paused?: boolean;
}): string {
  const where = `Program ${input.active} of ${input.total}`;
  const paused = input.paused === true;
  const shown = input.percent === null ? null : Math.round(input.percent);
  if (shown === null) {
    return paused
      ? `${where} is paused — the machine has not reported a percentage yet.`
      : `${where} is running — the machine has not reported a percentage yet.`;
  }
  if (shown >= 100) return `${where} is 100 % done — the machine is finishing.`;
  const left = remainingSeconds(input.percent, input.elapsedS);
  const time =
    left === null || (input.elapsedS ?? 0) < MIN_ELAPSED_FOR_ESTIMATE_S
      ? '.'
      : paused
        ? ` — about ${formatDuration(left)} left when it resumes.`
        : ` — about ${formatDuration(left)} left.`;
  if (paused) return `${where} is paused at ${shown} %${time}`;
  return `${where} is ${shown} % done${time}`;
}

/** Just enough of a release file to answer the cutter question. */
export interface ReleaseCutOrderItem {
  index: number;
  toolKey: string;
  done: boolean;
}

/**
 * The next program in cut order that needs a different cutter, skipping programs this machine has
 * already finished; `last` when no later program does. Null when no program is running or the
 * running index is not in the list.
 */
export function nextBitChange<T extends ReleaseCutOrderItem>(
  files: readonly T[],
  active: number | null,
): { kind: 'change'; file: T } | { kind: 'last' } | null {
  if (active === null) return null;
  const current = files.find((f) => f.index === active);
  if (current === undefined) return null;
  const later = files.filter((f) => f.index > active && !f.done).sort((a, b) => a.index - b.index);
  const next = later.find((f) => f.toolKey !== current.toolKey);
  return next === undefined ? { kind: 'last' } : { kind: 'change', file: next };
}

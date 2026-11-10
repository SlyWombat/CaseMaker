/**
 * #1123-42 — THE RUNNING PROGRAM'S PROGRESS, in the run watch's own words.
 *
 * The controller's status line carries the job's `P:` reading — the line being played, the percent
 * complete and the seconds elapsed (`readJobProgress`, #386). The Cut step shows that as "Program 2
 * of 5 is 20 % done — about 20 s left." and names the next program that needs a different cutter,
 * because that is the change the operator has to stand at the machine for.
 *
 * THE TIME LEFT IS THE CONTROLLER'S OWN ARITHMETIC, not an estimate of ours: it is the elapsed time
 * scaled by the fraction still to run (`elapsed × (100 − percent) / percent`), the same reading the
 * status strip draws. Before the machine reports a percentage there is no time to state, and at
 * 100 % the program reads "finishing" rather than "0 s left" — the machine still has its trip home.
 *
 * THE NEXT BIT CHANGE IS THE RELEASE LIST'S ORDER, not a second schedule: the next program in cut
 * order that needs a different cutter from the one running, skipping programs this machine already
 * finished. Programs that share the running cutter are not a change; when no later program needs
 * another cutter, the job is cutting with its last one.
 */

import { formatDuration } from '@/engine/cnc/plan/format';

/** The part of the status line this module reads — `platform/machineRun.ts`'s `Progress`, shared shape. */
export interface RunProgressReading {
  state: string | null;
  line: number | null;
  percent: number | null;
  elapsedS: number | null;
}

/**
 * The time the `P:` percent and elapsed imply is left, or null while there is nothing to divide:
 * no reading, no percentage, or 0/100 % (the second is the end-of-file trip home, not work left).
 */
export function remainingSeconds(progress: RunProgressReading | null): number | null {
  if (progress === null) return null;
  const { percent, elapsedS } = progress;
  if (percent === null || elapsedS === null || percent <= 0 || percent >= 100) return null;
  return Math.round((elapsedS * (100 - percent)) / percent);
}

/** One sentence for the program that is playing — positions and arithmetic only, never a guess. */
export function runningProgramWords(input: {
  /** The 1-based cut order of the program the machine plays. */
  active: number;
  /** How many programs the job has. */
  total: number;
  /** The run watch's last status reading for this machine. */
  progress: RunProgressReading | null;
  /** The run is paused: the clock will resume with the program. */
  paused?: boolean;
}): string {
  const where = `Program ${input.active} of ${input.total}`;
  const paused = input.paused === true;
  const percent = input.progress?.percent ?? null;
  if (percent === null) {
    return paused
      ? `${where} is paused — the machine has not reported a percentage yet.`
      : `${where} is running — the machine has not reported a percentage yet.`;
  }
  const shown = Math.round(percent);
  if (shown >= 100) return `${where} is 100 % done — the machine is finishing.`;
  const left = remainingSeconds(input.progress);
  const time =
    left === null
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

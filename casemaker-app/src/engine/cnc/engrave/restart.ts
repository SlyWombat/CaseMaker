/**
 * #1179 slice A — WHAT THE CUT STEP SAYS ABOUT A BLANK THAT HAS BEEN CUT BEFORE.
 *
 * The machine's finished-run records (`machines[].finishedRuns`, recorded by the finish-write) are
 * compared with the package the Cut step holds:
 *
 *  - SAME PLAN (`packageKey` equals this package's hash): today's ✓ rows and resume are the answer
 *    and the step says nothing extra.
 *  - A DIFFERENT PLAN FOR THIS JOB (`jobId` matches, `packageKey` differs): the blank was cut, and
 *    the plan has changed. The sentence is the issue's own, built only from what the record says —
 *    a partial record states only the facts it has. Cutting starts again at program 1 and passes
 *    over what is already cut (the plan's done rows are hash intersections, so a different plan's
 *    programs are never marked done).
 *  - A RECORD THAT CANNOT NAME ITS PLAN (a `jobId` match with no `packageKey`): only the weak claim
 *    is made — an earlier plan cut on this machine — because which plan cannot be said.
 *  - HASHES WITH NO RECORD (the pre-#1179 `finishedPrograms` entries): the machine has cut before.
 *    Never "this blank" and never "this job": a hash list cannot say either.
 *
 * The record list is machine-level and the newest entry is LAST (the append upserts newest-wins),
 * so the last record for the job is the one quoted.
 */

import type { FinishedRun } from '@/platform/locationClient';

export interface RestartNotice {
  kind: 'changed' | 'unknown' | 'machine';
  /** One sentence or two, in the operator's words — the Cut step prints it verbatim. */
  sentence: string;
}

export interface RestartInput {
  jobId: string;
  /** The frozen package's hash — the plan's own identity. */
  packageKey: string;
  /** Every program hash in the frozen package (the plan's own done intersection is unchanged). */
  packageHashes: readonly string[];
  /** Programs in the frozen package: "N programs now". */
  programCount: number;
  /** `finishedRunsFor(target)`, oldest first. */
  runs: readonly FinishedRun[];
  /** `finishedProgramsFor(target)` — the hashes, with or without a record. */
  machineHashes: readonly string[];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "9 Nov" from an ISO timestamp; null when the record has no readable date. Local day, as the
 *  operator experienced it. */
export function dayWords(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/** "program 4 of 20 (6 mm flat · roughing)" — each fragment only when the record states it. */
function cutDetail(record: FinishedRun): string | null {
  const program =
    record.programIndex === undefined
      ? null
      : record.programCount === undefined
        ? `program ${record.programIndex}`
        : `program ${record.programIndex} of ${record.programCount}`;
  const name = record.programName === undefined || record.programName.trim() === '' ? null : record.programName;
  if (program !== null && name !== null) return `${program} (${name})`;
  return program ?? name;
}

function changedSentence(record: FinishedRun, programCount: number): string {
  const when = dayWords(record.finishedAt);
  const detail = cutDetail(record);
  const cut = `This blank was partly cut${when === null ? '' : ` on ${when}`}${detail === null ? '' : `: ${detail}`}.`;
  const now = `${programCount} program${programCount === 1 ? '' : 's'} now`;
  return `${cut} The plan has changed since (${now}), so cutting starts again at program 1; it passes over what is already cut.`;
}

export function restartNotice(input: RestartInput): RestartNotice | null {
  const jobRuns = input.runs.filter((run) => run.jobId === input.jobId);
  const newest = jobRuns.length === 0 ? null : jobRuns[jobRuns.length - 1]!;
  if (newest !== null) {
    if (newest.packageKey === input.packageKey) return null;
    if (newest.packageKey !== undefined) {
      return { kind: 'changed', sentence: changedSentence(newest, input.programCount) };
    }
    return {
      kind: 'unknown',
      sentence:
        'An earlier plan cut on this machine, and the record does not say which. Cutting starts at program 1; it passes over what is already cut.',
    };
  }
  const own = new Set(input.packageHashes);
  if (input.machineHashes.some((hash) => !own.has(hash))) {
    return { kind: 'machine', sentence: 'An earlier plan cut on this machine.' };
  }
  return null;
}

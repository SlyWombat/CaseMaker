/**
 * #469 / #419 §3 — THE RELEASE STEP'S PURE HALF: what each program's file is called, which programs
 * this machine has already finished, and what is left to play.
 *
 * The run is a LIST (#419 J3): `EngraveGenerated.programs` is already in cut order, one program per
 * setup and cutter. The release step uploads every file in that list and plays the ones this machine
 * has not finished, in the same order. Nothing here reaches a store, a socket or a clock, so the
 * naming and the resume question can be tested as arithmetic rather than through a fake machine.
 *
 * THE FILE NAME IS THE PROGRAM'S IDENTITY ON THE CARD. It has to be stable across a regenerate: the
 * upload's `alreadyPresent` answer, and an operator's knowledge of which file they are watching, both
 * rest on the name meaning the same program next time. The cut-order position is that stable key —
 * a setup re-ordered is a different run — and it is what the release sheet shows beside the setup
 * number. A one-program job keeps the run sheet's own name (`<job>.nc`) exactly as before, so a
 * single-file job uploads under the name every existing surface already prints.
 */

import type { EngraveProgram } from '@/workers/sim/engraveGenerate';
import { runSheetFileName } from './runSheet';

/** The stem of a job's file names — `runSheetFileName` without its `.nc`. */
export function releaseStem(jobName: string): string {
  return runSheetFileName(jobName).replace(/\.nc$/i, '');
}

/**
 * The `.nc` name for program `index` (1-based, cut order) of `total`.
 *
 * ONE PROGRAM keeps `<job>.nc` (`runSheetFileName`), because that is the name the run sheet, Save and
 * the single-file upload all print, and a one-program job must not gain a suffix for no reason.
 * MORE THAN ONE gets `<job>-p<n>.nc`: the face/frame files already take `<job>-face.nc` and
 * `<job>-frame.nc`, so a program's own suffix cannot collide with either.
 */
export function releaseFileName(jobName: string, index: number, total: number): string {
  if (total <= 1) return runSheetFileName(jobName);
  return `${releaseStem(jobName)}-p${index}.nc`;
}

/** One program as the release step lists, names and plays it. */
export interface ReleaseProgram {
  /** 1-based cut order — the list's own order, not `setupIndex`. */
  index: number;
  total: number;
  setupIndex: number;
  toolKey: string;
  filename: string;
  hash: string;
  nc: string;
  verify: EngraveProgram['verify'];
  /** This machine has already finished this program cleanly (#419 §4.5). */
  done: boolean;
}

/**
 * The job's programs in cut order, each named and marked with whether this machine already finished
 * it. `finishedHashes` is exactly `RunPlanInput.finishedHashes` (`finishedProgramsFor(target)`), so
 * the release sheet and the plan answer "is this program new?" with one list.
 *
 * A finished program is KEPT in the list rather than removed: the operator has to see that program 2
 * of 3 is skipped and why, and the program's index in the job must not renumber when one is done.
 */
export function releasePrograms(
  jobName: string,
  programs: readonly EngraveProgram[],
  finishedHashes: readonly string[],
): ReleaseProgram[] {
  const total = programs.length;
  const done = new Set(finishedHashes);
  return programs.map((p, i) => ({
    index: i + 1,
    total,
    setupIndex: p.setupIndex,
    toolKey: p.toolKey,
    filename: releaseFileName(jobName, i + 1, total),
    hash: p.programHash,
    nc: p.nc,
    verify: p.verify,
    done: done.has(p.programHash),
  }));
}

/** The programs still to play, in cut order. */
export function releasePending(files: readonly ReleaseProgram[]): ReleaseProgram[] {
  return files.filter((f) => !f.done);
}

/**
 * The next program to play: the first one this machine has not finished, or null when the job is
 * done. A run resumed after a stop continues HERE (#419 §4.5) rather than replaying files that
 * already cut.
 */
export function releaseNext(files: readonly ReleaseProgram[]): ReleaseProgram | null {
  return releasePending(files)[0] ?? null;
}

/**
 * Does this program's text carry the vacuum's ON word (`M331`) as a command? Checked as a LINE, the
 * same reading `programOwnsVacuum` uses, so a word in a comment does not count.
 */
export function carriesVacuumOn(nc: string): boolean {
  return /^[ \t]*M331\b/im.test(nc);
}

/** Does this program's text carry the vacuum's OFF word (`M332`) as a command? */
export function carriesVacuumOff(nc: string): boolean {
  return /^[ \t]*M332\b/im.test(nc);
}

/**
 * This file's share of the run's vacuum span (#419 decision 4), read from its own text.
 *
 * `whole` — the job's only program, carrying both words;
 * `first` — `M331`, and a later program will carry `M332`;
 * `middle` — neither, because the first file turned it on and the last turns it off;
 * `last` — `M332`, because an earlier file turned it on;
 * `none` — no words at all (`air: false`, or a hand-made file), so the run must not invent a span.
 */
export type ProgramVacuumSpan = 'whole' | 'first' | 'middle' | 'last' | 'none';

export function programVacuumSpan(nc: string, anyWordsInJob: boolean): ProgramVacuumSpan {
  const on = carriesVacuumOn(nc);
  const off = carriesVacuumOff(nc);
  if (on && off) return 'whole';
  if (on) return 'first';
  if (off) return 'last';
  return anyWordsInJob ? 'middle' : 'none';
}

/** Whether any program of the list says a vacuum word — the job's own answer to "is this an air run?" */
export function jobCarriesVacuumWords(programs: readonly { nc: string }[]): boolean {
  return programs.some((p) => carriesVacuumOn(p.nc) || carriesVacuumOff(p.nc));
}

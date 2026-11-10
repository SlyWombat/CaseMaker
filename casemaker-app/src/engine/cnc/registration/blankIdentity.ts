/**
 * #1179 blank identity — WHICH BLANK IS ON THE BED, for the Register card's guard.
 *
 * The analyst's fields (issue #1179, comment 6776457695): the current blank for a job lives on the
 * MACHINE record (`currentBlank[jobId]`) and every finished run carries the `blankId` it was cut
 * on. This module is the ONE reading of those fields the card uses — the cut-blank trigger and
 * stage 2's candidate source both come from here, so the card cannot say "nothing has cut" and
 * then plan three touches.
 *
 * The rules, in order:
 *   - a job WITH a current id: only runs under THAT id count; legacy (id-less) entries and other
 *     blanks' runs are out of scope by construction (scoping, never rewriting history);
 *   - a job with NO id: the safe default — if the machine holds legacy finished entries (or the
 *     job's own run log says a program finished), the blank MAY have been cut → the unknown-cuts
 *     path, with the "This is a new blank" press offered; otherwise a fresh blank (single touch);
 *   - the registered setup's cut map is read from the newest record for this blank: `complete`
 *     gives stage 2 its floor cells; `unknown` or absent keeps the unknown-cuts path;
 *   - `packageFinishedUnderBlank` is the registration mint's condition: every program of the
 *     frozen package is already finished under the current id, and the job is being registered
 *     again.
 */
import type { FinishedCutMap, FinishedRun, MachineRecord } from '@/platform/locationClient';

/** One setup/face's map entry, as the record carries it (E's `FinishedSetupCutMap`). */
export interface SetupCutMapEntry {
  setupIndex: number;
  state: 'complete' | 'unknown';
  map?: FinishedCutMap;
  unknownReason?: string;
}

export interface BlankScope {
  /** The machine's current blank id for this job, or null when the job has none (legacy). */
  blankId: string | null;
  /** True: the next registration takes the cut-blank path (measured, three-to-five touches). */
  cutsOnThisBlank: boolean;
  /** Why — the card's sentence picks from this. */
  reason: 'blank-cut' | 'legacy-maybe-cut' | 'fresh';
  /** The newest finished run for this job under this blank; null on a fresh/legacy blank. */
  newestRun: FinishedRun | null;
  /** The registered setup's map entry from that record, when it carries one. */
  setupMap: SetupCutMapEntry | null;
  /** Every program of the frozen package is finished under this blank (the registration mint). */
  packageFinishedUnderBlank: boolean;
}

export interface BlankScopeInput {
  machine: MachineRecord | null;
  jobId: string;
  /** 1-based, the frozen programs' own numbering. */
  setupIndex: number;
  /** The frozen package's program hashes; empty when no package is frozen. */
  packageHashes: readonly string[];
  /** The job's own run log says a program finished — a legacy signal carrying no blank id. */
  runLogFinished: boolean;
}

/** The newest record by `finishedAt` (absent sorts oldest), ties keeping the later array entry. */
function newest(runs: readonly FinishedRun[]): FinishedRun | null {
  let best: FinishedRun | null = null;
  for (const run of runs) {
    if (best === null || (run.finishedAt ?? '') >= (best.finishedAt ?? '')) best = run;
  }
  return best;
}

export function blankScopeFor(input: BlankScopeInput): BlankScope {
  const { machine, jobId, setupIndex } = input;
  const blankId = machine?.currentBlank?.[jobId] ?? null;
  const runs = machine?.finishedRuns ?? [];
  const blankRuns = blankId === null ? [] : runs.filter((run) => run.jobId === jobId && run.blankId === blankId);
  const legacy = (machine?.finishedPrograms ?? []).length > 0 || input.runLogFinished;
  const cutsOnThisBlank = blankId === null ? legacy : blankRuns.length > 0;
  const reason: BlankScope['reason'] =
    blankId === null ? (legacy ? 'legacy-maybe-cut' : 'fresh') : blankRuns.length > 0 ? 'blank-cut' : 'fresh';
  const newestRun = newest(blankRuns);
  const setupMap =
    (newestRun?.cutMaps ?? []).find((entry) => entry.setupIndex === setupIndex) ?? null;
  const packageFinishedUnderBlank =
    input.packageHashes.length > 0 &&
    input.packageHashes.every((hash) => blankRuns.some((run) => run.hash === hash));
  return { blankId, cutsOnThisBlank, reason, newestRun, setupMap, packageFinishedUnderBlank };
}

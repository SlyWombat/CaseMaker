/**
 * The measured runs this build carries (#277, `/Makera-Parity.md` §14.1) — the read half of the run
 * record round trip, and the twin of `feeds.ts`'s `MEASURED_ROWS` region.
 *
 * `scripts/run-readback.ts` validates a filled `<job>-run.json` and writes the record into the
 * marked region below. Nothing hand-edits that region: a run is measured at the bench and recorded
 * in a file, and the region is where the file's answer is kept so the app can show it. Every record
 * in it has been through `parseRunRecord`, which refuses a reading with no date (#277's rule), so
 * being in this list already means a person dated the cut.
 *
 * The estimate reads `lastTimedRun` for the job on screen — a number shown BESIDE #242's cycle
 * estimate, never merged into it. The estimate stays the planning figure it is; this is one more
 * fact next to it.
 */

import { runSheetFileName } from '@/engine/cnc/engrave/runSheet';
import { isTimedRun, type RunRecord } from '@/engine/cnc/engrave/runRecord';

// <runs-measured>
// Machine-written by `scripts/run-readback.ts` (#277) from a filled run record. Do not hand-edit.
export const MEASURED_RUNS: readonly RunRecord[] = [];
// </runs-measured>

/**
 * Add a record to a list of measured runs, keyed by the `.nc` it describes. Re-running the readback
 * on the same record REPLACES its entry rather than appending a second copy — which is what makes
 * the readback idempotent, and what makes "last measured" mean the latest cut of that program
 * rather than a growing pile of them.
 */
export function mergeMeasuredRuns(existing: readonly RunRecord[], add: RunRecord): RunRecord[] {
  return [...existing.filter((r) => r.ncFile !== add.ncFile), add];
}

/**
 * The runs the app should consider: what this build ships, with anything the user opened in this
 * browser taking precedence over it. A record opened from a file is newer than a baked one — the
 * baked region is the last readback, and a file the operator just filled is the truth about the
 * run they just made.
 */
export function allRuns(imported: readonly RunRecord[]): RunRecord[] {
  const byFile = new Map<string, RunRecord>();
  for (const r of MEASURED_RUNS) byFile.set(r.ncFile, r);
  for (const r of imported) byFile.set(r.ncFile, r);
  return [...byFile.values()];
}

/**
 * The most recent measured run of the program a job will be cut as, or null. Matched on the `.nc`
 * name — the same key the readback merges on — so it is "the last time I cut this program", which
 * is exactly what the estimate wants beside it. Requires a wall-clock time: a dated record with no
 * minutes has no number to show. Same cut date on two records: the later one in the list wins,
 * which puts an imported record over a baked one.
 */
export function lastTimedRun(jobName: string, runs: readonly RunRecord[]): RunRecord | null {
  const ncFile = runSheetFileName(jobName);
  let best: RunRecord | null = null;
  for (const run of runs) {
    if (run.ncFile !== ncFile || !isTimedRun(run)) continue;
    if (best === null || (run.cutOn ?? '') >= (best.cutOn ?? '')) best = run;
  }
  return best;
}

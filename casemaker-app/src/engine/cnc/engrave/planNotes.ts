/**
 * #963 — WHAT THE PLAN COULD NOT CUT, in the operator's words: one sentence per step the engine
 * could not plan (`SequenceChoice.unplanned`, C's #961), and one when no freeing cut is posted
 * (`SequenceChoice.freeing === null`) — the part will not come off the stock.
 *
 * STUB: C is writing the pure sentence function for `unplanned` (the words agreed on #961:
 * `<region>: not cut — planning failed (<reason>)`). These functions carry the SAME signature it
 * will have, so swapping the bodies is one commit and no caller changes. Until then the panel and
 * the sheet print these.
 */

/** One step the ops could not plan — C's `SequenceStepFailure` (#961/#960). */
export interface PlanUnplannedStep {
  kind: string;
  cutterKey: string;
  regionIds: readonly string[];
  reason: string;
}

/** A plan's own account of what it could not cut — the slice of `SetupPlan` these words read. */
export interface PlanNotesInput {
  /** Absent on a plan that did not report failures (an older result); empty when all planned. */
  unplanned?: readonly PlanUnplannedStep[];
  /** C's freeing-cut pick; `null` means NO freeing step is posted (the part stays in the stock). */
  freeing?: unknown | null;
}

/**
 * One sentence per failed step, naming its regions. A failure that names no region is said by its
 * kind ("the contour: not cut …"), so a part never loses material without a line saying so.
 */
export function unplannedSentences(unplanned: readonly PlanUnplannedStep[]): string[] {
  return unplanned.flatMap((failure) => {
    const where = failure.regionIds.length === 0 ? [failure.kind] : failure.regionIds;
    return where.map((id) => `${id}: not cut — planning failed (${failure.reason})`);
  });
}

/** The line a part gets when the plan posts no freeing cut. Null when a freeing step exists. */
export function freeingSentence(freeing: PlanNotesInput['freeing']): string | null {
  return freeing === null ? 'The part is not freed — no freeing cut is posted.' : null;
}

/** Every plan note, in the order the operator should read it: what was missed, then freeing. */
export function planNoteLines(plan: PlanNotesInput): string[] {
  const lines = unplannedSentences(plan.unplanned ?? []);
  const freeing = freeingSentence(plan.freeing);
  if (freeing !== null) lines.push(freeing);
  return lines;
}

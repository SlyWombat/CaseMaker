/**
 * #960 — WHY A FEATURE IS NOT CUT, IN THE OPERATOR'S WORDS.
 *
 * Two kinds of finding reach the run sheet and the panel from the cutter sequence, and until now
 * each caller built its own sentence: a demanded feature no cutter can reach ("needs a cutter ≤
 * N mm") and a step whose op could not plan ("part not freed", "not cut"). This module is the ONE
 * place those words live: pure functions over plain data, no CAM plan and no engine import, so
 * the sheet, the panel and the receipt cannot say different things about the same finding.
 *
 * The input shapes are structural — `SequenceChoice.unplanned` (B's `cam/model`) matches
 * {@link UnplannedStepFinding} field for field, so the model package can call this without this
 * module depending on it.
 */

/** The op kinds a sequence posts; `SequenceStepFailure['kind']` matches this set. */
export type UnplannedKind = 'pocket' | 'contour' | 'rest' | 'rough' | 'finish' | 'pencil' | 'chamfer';

/**
 * One step the ops could not plan — `SequenceChoice.unplanned`'s entry, structurally. `reason` is
 * the op's own message (a thrown error) or the sequence's "planned nothing" sentence.
 */
export interface UnplannedStepFinding {
  kind: UnplannedKind;
  cutterKey: string;
  regionIds: readonly string[];
  reason: string;
}

/**
 * The sentence for one failed step. The freeing contour has its own words: a failed contour is
 * not "a pocket left uncut" — the part may still be held to the stock, so the operator reads
 * "part not freed". Everything else names its regions and what was going to be done to them.
 */
export function unplannedSentence(finding: UnplannedStepFinding): string {
  const ids = finding.regionIds.join(', ');
  if (finding.kind === 'contour') return `part not freed: ${finding.reason}`;
  const verb =
    finding.kind === 'rough' || finding.kind === 'finish' || finding.kind === 'pencil'
      ? 'not finished'
      : finding.kind === 'chamfer'
        ? 'rim not broken'
        : 'not cut';
  return ids === '' ? `${verb}: ${finding.reason}` : `${ids}: ${verb} — ${finding.reason}`;
}

/**
 * The sentence for a demanded feature no cutter in the set can reach (`SequenceChoice.
 * unreachable`): the limiting number when the tree measured one, `(house offers …)` for the set
 * the choice priced. `offered` is the caller's own list ("⌀6, ⌀3.175"); absent, the parentheses
 * are left off rather than inventing a set.
 */
export function unreachableSentence(featureId: string, narrowestMm: number | null, offered?: string): string {
  if (narrowestMm === null) return `${featureId}: not cut`;
  const set = offered === undefined || offered === '' ? '' : ` (house offers ${offered})`;
  return `${featureId}: not cut — needs a cutter ≤ ${narrowestMm.toFixed(2)} mm${set}`;
}

/**
 * The whole set of findings for a plan, in order: the unreachable features first (the plan's own
 * list), then the failed steps — each step's sentence, one line. Duplicates are kept: two failed
 * steps are two facts even when they name the same region.
 */
export function cutFindingSentences(
  unreachable: readonly string[],
  unplanned: readonly UnplannedStepFinding[],
): string[] {
  return [...unreachable, ...unplanned.map(unplannedSentence)];
}

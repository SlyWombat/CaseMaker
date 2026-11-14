/**
 * #1258 — THE TAB QUESTION'S WORDS. When tabs at full corner margins cannot bring every stretch of
 * outline under the shop's `tabs.maxSpanMm`, the plan stops and asks (`ModelPlanOutput.tabChoiceNeeded`).
 * One sentence states the question, each stretch states its two sets of numbers, and the two answers
 * are named as the CLI's flag values. The app draws the same facts as its own card; this text is
 * what a terminal, a log and the CLI's exit carry.
 */

import type { TabChoiceNeeded } from './plan';

/** The CLI's `--tab-choice` values and the plan input's `choice` they stand for. */
export const TAB_CHOICE_FLAG_VALUES = {
  'inside-margin': 'insideMargin',
  'longer-stretch': 'longerStretch',
} as const;

const mm = (v: number): string => String(Number(v.toFixed(1)));

/** The question's sentence, each stretch's numbers, and the flag values that answer it. */
export function tabChoiceSentence(needed: TabChoiceNeeded, stale = false): string {
  const lines = needed.stretches.map((s) => {
    const where = needed.stretches.length > 1 ? `stretch ${s.index + 1}: ` : '';
    const tab =
      s.candidate === null
        ? 'no place for a tab'
        : `a tab ${mm(s.candidate.fromCornerMm)} mm from the corner (margin ${mm(s.candidate.marginMm)} mm) leaves ${mm(s.candidate.leavesSpansMm[0])} mm and ${mm(s.candidate.leavesSpansMm[1])} mm`;
    return `${where}${mm(s.spanMm)} mm without a tab against the ${mm(needed.limitMm)} mm limit — ${tab}`;
  });
  return (
    (stale ? 'The answer on this job was for a different outline or different tab settings. ' : '') +
    "This part can't be held within both of the shop's tab rules. Choose one: " +
    '--tab-choice inside-margin (a tab closer to the corner than the margin) or ' +
    '--tab-choice longer-stretch (leave the longer unsupported stretch). ' +
    lines.join('; ')
  );
}

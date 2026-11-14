/**
 * #1258 — THE TAB QUESTION IN THE OPERATOR'S WORDS: the sentences of the card, of each outcome on the
 * run sheet, and of the Cut panel's Holding row. The wording is ruled (analyst, 2026-11-13); the
 * numbers come from the planner's `TabChoiceNeeded`, stretch by stretch. The CLI's own words are
 * `tabChoiceSentence` (engine side) — the same facts in a terminal's voice.
 *
 * ONE ANSWER APPLIES TO EVERY STRETCH. An operator who wants a different answer for one stretch
 * uses "Change the tabs myself".
 */

import type { TabChoiceNeeded } from '@/engine/cnc/cam/model/plan';

export type TabStretchOf = TabChoiceNeeded['stretches'][number];

/** The two answers; the third option changes the rules' inputs and is not an answer. */
export type TabChoiceAnswer = 'insideMargin' | 'longerStretch';

/** Whole millimetres, as the card and the sheet read them. */
export function mm(v: number): string {
  return `${Math.round(v)} mm`;
}

const mmOne = (v: number): string => String(Math.round(v * 10) / 10);

/** A stretch's number on the drawing and in the rows: 1-based, in the planner's order. */
export const stretchNumber = (s: TabStretchOf): number => s.index + 1;

export const TAB_QUESTION = "This part can't be held within both of the shop's tab rules. Choose one.";

export function stretchCountLine(n: number): string {
  return n === 1
    ? '1 stretch of this outline needs a choice.'
    : `${n} stretches of this outline need a choice — one answer applies to all of them.`;
}

/** Each option's cost, stated evenly (analyst ruling). */
export const COST_INSIDE_MARGIN =
  'A tab inside the margin is cut where the cutter changes direction and its load is highest.';
export const COST_LONGER_STRETCH = 'The stretch has no tab; the part may flex or lift along it.';

/** Option 1's sentence for one stretch — a row of the choice, at body size. */
export function insideMarginRow(s: TabStretchOf): string {
  const c = s.candidate;
  if (c === null) return `Stretch ${stretchNumber(s)}: no place for a tab — stays ${mm(s.spanMm)}.`;
  return `Stretch ${stretchNumber(s)}: a tab ${mm(c.fromCornerMm)} from the corner (margin ${mmOne(c.marginMm)} mm) leaves ${mm(c.leavesSpansMm[0])} and ${mm(c.leavesSpansMm[1])}.`;
}

/** Option 2's sentence for one stretch. */
export function longerStretchRow(s: TabStretchOf, limitMm: number): string {
  return `Stretch ${stretchNumber(s)}: ${mm(s.spanMm)} with no tab; the shop's limit is ${mm(limitMm)}.`;
}

/** Whether the first option can be offered: at least one stretch has a place for a tab. */
export function insideMarginOffered(n: TabChoiceNeeded): boolean {
  return n.stretches.some((s) => s.candidate !== null);
}

/** Why it is not, when it is not. */
export const NO_PLACE_LINE = 'No stretch has room for a tab, even inside the corner margin.';

/** The line the run sheet carries for a stretch under each answer (ruled wording; numbers from the plan). */
export function sheetSentence(choice: TabChoiceAnswer, s: TabStretchOf, limitMm: number, tabNumber?: number): string {
  if (choice === 'insideMargin' && s.candidate !== null) {
    const c = s.candidate;
    const longest = Math.max(c.leavesSpansMm[0], c.leavesSpansMm[1]);
    return `Tab${tabNumber === undefined ? '' : ` ${tabNumber}`} sits ${mm(c.fromCornerMm)} from a corner, closer than the shop's ${mmOne(c.marginMm)} mm margin — the operator's choice. Longest stretch without a tab: ${mm(longest)}.`;
  }
  return `${mm(s.spanMm)} of the outline has no tab; the shop's limit is ${mm(limitMm)} — the operator's choice.`;
}

/** The Cut panel's Holding row suffix, so the choice stays visible once the card is scrolled away. */
export function holdingChoiceSuffix(choice: TabChoiceAnswer, n: TabChoiceNeeded): string {
  if (choice === 'insideMargin') return `${n.stretches.filter((s) => s.candidate !== null).length} by your choice`;
  if (n.stretches.length === 1) return `${mm(n.stretches[0]!.spanMm)} stretch by your choice`;
  return `${n.stretches.length} stretches by your choice`;
}

/** The answered summary: a headline and one line of numbers. */
export function answeredSummary(choice: TabChoiceAnswer, n: TabChoiceNeeded): { headline: string; detail: string } {
  if (choice === 'insideMargin') {
    const placed = n.stretches.filter((s) => s.candidate !== null);
    const longest = Math.max(
      0,
      ...n.stretches.map((s) => (s.candidate === null ? s.spanMm : Math.max(...s.candidate.leavesSpansMm))),
    );
    const dists = placed.map((s) => mmOne(s.candidate!.fromCornerMm)).join(', ');
    const one = placed.length === 1;
    return {
      headline: one ? 'Holding: a tab inside the corner margin.' : `Holding: ${placed.length} tabs inside the corner margin.`,
      detail: `You chose it: ${one ? 'the tab sits' : 'the tabs sit'} ${dists} mm from a corner, closer than the edge's margin. The longest stretch left is ${mm(longest)}; the run sheet states this.`,
    };
  }
  const lens = n.stretches.map((s) => mm(s.spanMm));
  const list = lens.length <= 1 ? (lens[0] ?? '') : `${lens.slice(0, -1).join(', ')} and ${lens[lens.length - 1]}`;
  return {
    headline:
      n.stretches.length === 1
        ? `Holding: a stretch left longer than the shop's ${mm(n.limitMm)}.`
        : `Holding: ${n.stretches.length} stretches left longer than the shop's ${mm(n.limitMm)}.`,
    detail: `${list} ${lens.length === 1 ? 'has' : 'have'} no tab — your choice. The run sheet states this.`,
  };
}

export const TAB_AGAIN_LINE = 'The outline changed since you chose; choose again.';
export const TAB_BAR_HEADLINE = 'Action needed: choose how this part is held';
export const TAB_BAR_SUB = 'Generate has no programs until you choose.';
export const TAB_PAUSED_LINE = 'Generate is paused until you choose.';

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

/**
 * A stretch as the planner reports it. `cut` names the cut-out it belongs to, as the operation list
 * names it, when the engine says (several cut-outs can each have a stretch).
 */
export type TabStretchOf = TabChoiceNeeded['stretches'][number] & { cut?: { id: string; name: string } };

/**
 * The cut-out's 0-based position among the job's cut-out rows, from the id the planner mints
 * (`setup-S-cut-K`): the K-th ring of the centre path is the K-th cut-out. Null for an id not in
 * that form.
 */
export function cutPosition(s: { cut?: { id: string } }): number | null {
  const m = /cut-(\d+)$/.exec(s.cut?.id ?? '');
  return m === null ? null : Number(m[1]) - 1;
}

/** The question with each stretch's cut-out named as the operation list names it, when the job's row exists. */
export function withCutNames(needed: TabChoiceNeeded, cutNames: readonly string[]): TabChoiceNeeded {
  return {
    ...needed,
    stretches: needed.stretches.map((s) => {
      const k = cutPosition(s);
      const name = k === null ? undefined : cutNames[k];
      return name === undefined ? s : { ...s, cut: { ...s.cut, name } };
    }),
  };
}

/** "Lid outline — " before a row when the stretch's cut-out is known and there is more than one. */
function cutPrefix(s: TabStretchOf, several: boolean): string {
  return several && s.cut !== undefined ? `${s.cut.name} — ` : '';
}

/** Whether the stretches span more than one cut-out (each row then names its own). */
export function severalCuts(stretches: readonly TabStretchOf[]): boolean {
  return new Set(stretches.map((s) => s.cut?.id ?? '')).size > 1;
}

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

/** "2, 3 and 5": a short list in words. */
function listWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** Option 1's sentence for one stretch — a row of the choice, at body size. */
export function insideMarginRow(s: TabStretchOf, several = false): string {
  const head = `${cutPrefix(s, several)}Stretch ${stretchNumber(s)}`;
  const cs = s.candidates;
  if (cs.length === 0) return `${head}: no place for a tab — stays ${mm(s.spanMm)}.`;
  const still = s.stillOverLimit ? ` A stretch of ${mm(Math.max(...s.leavesSpansMm))} is still past the limit.` : '';
  if (cs.length === 1) {
    const c = cs[0]!;
    return `${head}: a tab ${mm(c.fromCornerMm)} from the corner (margin ${mmOne(c.marginMm)} mm) leaves ${listWords(s.leavesSpansMm.map(mm))}.${still}`;
  }
  return `${head}: ${cs.length} tabs, ${listWords(cs.map((c) => mm(c.fromCornerMm).replace(' mm', '')))} mm from their corners (margins ${listWords(cs.map((c) => mmOne(c.marginMm)))} mm), leave ${listWords(s.leavesSpansMm.map(mm))}.${still}`;
}

/** Option 2's sentence for one stretch. */
export function longerStretchRow(s: TabStretchOf, limitMm: number, several = false): string {
  return `${cutPrefix(s, several)}Stretch ${stretchNumber(s)}: ${mm(s.spanMm)} with no tab; the shop's limit is ${mm(limitMm)}.`;
}

/** Whether the first option can be offered: at least one stretch has a place for a tab. */
export function insideMarginOffered(n: TabChoiceNeeded): boolean {
  return n.stretches.some((s) => s.candidates.length > 0);
}

/** Why it is not, when it is not. */
export const NO_PLACE_LINE = 'No stretch has room for a tab, even inside the corner margin.';

/** The Cut panel's Holding row suffix, so the choice stays visible once the card is scrolled away. */
export function holdingChoiceSuffix(choice: TabChoiceAnswer, n: TabChoiceNeeded): string {
  if (choice === 'insideMargin') return `${n.stretches.reduce((t, s) => t + s.candidates.length, 0)} by your choice`;
  if (n.stretches.length === 1) return `${mm(n.stretches[0]!.spanMm)} stretch by your choice`;
  return `${n.stretches.length} stretches by your choice`;
}

/** The answered summary: a headline and one line of numbers. */
export function answeredSummary(choice: TabChoiceAnswer, n: TabChoiceNeeded): { headline: string; detail: string } {
  if (choice === 'insideMargin') {
    const cands = n.stretches.flatMap((s) => s.candidates);
    const longest = Math.max(0, ...n.stretches.map((s) => Math.max(...s.leavesSpansMm)));
    const dists = cands.map((c) => mmOne(c.fromCornerMm)).join(', ');
    const one = cands.length === 1;
    return {
      headline: one ? 'Holding: a tab inside the corner margin.' : `Holding: ${cands.length} tabs inside the corner margin.`,
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
/** Option 3: it is not an answer, and it goes to the cut-out's own tab settings. */
export const CHANGE_TABS_LINE =
  "Takes you to this cut-out's tab count and width. Generate asks again if the new tabs still leave a stretch too long.";
/** #1271 — the same option on a goal job, which states its tabs in its own row (below the card). */
export const CHANGE_TABS_GOAL_LINE =
  'Takes you to the tab count and width below. Generate asks again if the new tabs still leave a stretch too long.';
export const TAB_PAUSED_LINE = 'Generate is paused until you choose.';

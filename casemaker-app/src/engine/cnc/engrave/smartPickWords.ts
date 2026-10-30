/**
 * #766 slice C — THE WORDS: the search's answer in the operator's language.
 *
 * The pick must explain itself: what each cutter does, what the next-best alternative would lose
 * (with the measured number, not a proxy), and — when a catalogue cutter measures better than the
 * shop's own — what to buy. The sentences are built ONLY from slice A's evaluation, so a claim in
 * the panel, the wizard or the CLI is the same measurement the search ranked.
 *
 * The raised-text sentence is #765's: not "no cutter fits" but what separates and where the work
 * still touches — "2 pinch points stay joined, between S–o and t–w".
 */

import { statedCuttingSize } from '@/engine/cnc/tool';
import type { ToolLibraryEntry } from '@/engine/cnc/toolLibrary';
import { vCone } from '@/engine/cnc/vProfile';
import type { EvaluatedItem, PinchFact } from '@/workers/sim/planEvaluate';
import { planKey, type CandidatePlan, type ScoredPlan, type SmartPick } from './smartPick';

const dia = (entry: ToolLibraryEntry | undefined): string => {
  const d = entry === undefined ? null : statedCuttingSize(entry.tool);
  return d === null ? 'the cutter' : `⌀${Number(d.toFixed(3))} mm`;
};

/** One cutter of a plan in the operator's words: `⌀3.175`, or `⌀0.3 V rest` for a rest cutter. */
function cutterWord(cutter: { key: string; items: readonly string[] }, tools: readonly ToolLibraryEntry[]): string {
  const entry = tools.find((t) => t.key === cutter.key);
  const d = entry === undefined ? null : statedCuttingSize(entry.tool);
  const size = d === null ? 'the cutter' : `⌀${Number(d.toFixed(3))}`;
  if (cutter.items.length > 0) return size;
  return `${size} ${entry !== undefined && vCone(entry.tool) !== null ? 'V ' : ''}rest`;
}

/** A whole plan in the operator's words — the measured answer's own name (#766 D). */
export function planLabel(plan: Pick<CandidatePlan, 'cutters'>, tools: readonly ToolLibraryEntry[]): string {
  return plan.cutters.map((cutter) => cutterWord(cutter, tools)).join(' + ');
}

const pct = (v: number): string => `${Math.round(Math.max(0, Math.min(1, v)) * 100)} %`;

/** An item name as a sentence names it: a label already carries its quotes, an id does not. */
const quoted = (name: string): string => (name.startsWith('"') && name.endsWith('"') ? name : `"${name}"`);

/** The pinches that still join, as "S–o", "t–w". */
export function joinedPinchWords(item: EvaluatedItem): string[] {
  return item.pinches.filter((p) => !p.separated).map((p) => `${p.between[0]}–${p.between[1]}`);
}

/** One item's raised quote: what separates, what stays joined, and any V edge loss. */
function raisedWords(item: EvaluatedItem): string {
  const total = item.pinches.length;
  if (total === 0) return '';
  const joined = joinedPinchWords(item);
  const losses = item.pinches.filter((p) => p.separated && p.edgeLossMm > 0);
  const lossNote =
    losses.length === 0
      ? ''
      : ` (${losses.length === 1 ? 'one pinch' : `${losses.length} pinches`} lose up to ${Number(Math.max(...losses.map((p) => p.edgeLossMm)).toFixed(3))} mm per side to the V’s flank)`;
  if (joined.length === 0) return `every pinch point in ${item.name} separates${lossNote}`;
  const worst: PinchFact | null = item.pinches
    .filter((p) => !p.separated)
    .reduce<PinchFact | null>((w, p) => (w === null || p.gapMm < w.gapMm ? p : w), null);
  const list = joined.length <= 3 ? joined.join(', ') : `${joined.slice(0, 3).join(', ')} and ${joined.length - 3} more`;
  const gap = worst === null ? '' : ` (${Number(worst.gapMm.toFixed(3))} mm at the tightest)`;
  return `${joined.length} pinch${joined.length === 1 ? '' : 'es'} in ${item.name} stay${joined.length === 1 ? 's' : ''} joined${gap}, between ${list}${lossNote}`;
}

/**
 * One sentence per cutter of the chosen plan. `items` names come from the evaluation, so a rest
 * cutter says what IT changes (the pinches), not what the clearance cutter already did.
 */
export function cutterLines(pick: SmartPick, tools: readonly ToolLibraryEntry[]): string[] {
  const byId = new Map(pick.chosen.evaluation.items.map((i) => [i.id, i] as const));
  return pick.chosen.plan.cutters.map((cutter, index) => {
    const entry = tools.find((t) => t.key === cutter.key);
    if (cutter.items.length === 0) {
      // A rest cutter: its sentence is the raised measurement at ITS width — the whole point of
      // the second program (#760/#765).
      const raised = [...byId.values()].filter((i) => i.pinches.length > 0);
      const words = raised.map(raisedWords).filter((w) => w !== '');
      const what = index === 0 ? 'cuts first' : 'rest — re-cuts what the earlier cutter left';
      // #766 review/§6 — the operator's words, never the tool KEY: `flat-1.0` and `cat:…` are the
      // registry's names for a row, and the acceptance grammar forbids them in visible text.
      return `${dia(entry)} ${what}${words.length === 0 ? '' : `; ${words.join('; ')}`}.`;
    }
    const worst = pick.chosen.worstItem;
    const detail =
      worst === null || worst.fidelity >= 1
        ? 'keeps every item it owns at full fidelity'
        : `its worst item is ${worst.name} at ${pct(worst.fidelity)} fidelity${worst.charsLost > 0 ? `, ${worst.charsLost} character${worst.charsLost === 1 ? '' : 's'} lost` : ''}`;
    return `${dia(entry)} cuts ${cutter.items.length === 1 ? 'one item' : `${cutter.items.length} items`} and ${detail}.`;
  });
}

/** What the runner-up would lose, in measured words — the 'here is why not that cutter' line. */
export function runnerUpLine(pick: SmartPick, tools: readonly ToolLibraryEntry[]): string | null {
  const runner = pick.runnerUp;
  if (runner === null) return null;
  // The plan's own name in the operator's words (#766 review/§6): a key list is an internal id.
  const name = (p: ScoredPlan): string => planLabel(p.plan, tools);
  const joined = runner.evaluation.items.flatMap((item) => joinedPinchWords(item).map((w) => `${w} (${item.name})`));
  if (joined.length > 0) {
    return `The next-best plan (${name(runner)}) leaves ${joined.length} pinch${joined.length === 1 ? '' : 'es'} joined — ${joined.slice(0, 3).join(', ')}${joined.length > 3 ? ` and ${joined.length - 3} more` : ''} — so it measures ${pct(runner.worstFidelity)} where the chosen plan measures ${pct(pick.chosen.worstFidelity)}.`;
  }
  const lose = runner.evaluation.items.filter((i) => i.fidelity < 1).sort((a, b) => a.fidelity - b.fidelity)[0];
  if (lose === undefined) {
    return `The next-best plan (${name(runner)}) measures the same; the chosen one wins on ${pick.chosen.evaluation.toolChanges <= runner.evaluation.toolChanges ? 'tool changes' : 'time'}.`;
  }
  return `The next-best plan (${name(runner)}) loses ${pct(1 - lose.fidelity)} of ${lose.name}, so the chosen plan measures ${pct(pick.chosen.worstFidelity)} against its ${pct(runner.worstFidelity)}.`;
}

/** The 'buy this' line, when a catalogue cutter genuinely measures better than the shop's own. */
export function buyThisLine(pick: SmartPick, tools: readonly ToolLibraryEntry[]): string | null {
  const buy = pick.buyThis;
  if (buy === null) return null;
  const catalogue = buy.plan.cutters.filter((c) => buy.plan.source[c.key] === 'catalogue');
  // A purchase is a cutter, not a plan role: the diameter and nothing else (never its key).
  const keys = catalogue.map((c) => dia(tools.find((t) => t.key === c.key))).join(', ');
  const joined = buy.evaluation.items.flatMap((item) => joinedPinchWords(item).map((w) => `${w} (${item.name})`));
  const gain = `${pct(buy.worstFidelity)} against ${pct(pick.chosen.worstFidelity)}`;
  const why =
    joined.length === 0
      ? ''
      : ` It still leaves ${joined.length} pinch${joined.length === 1 ? '' : 'es'} joined (${joined.slice(0, 3).join(', ')}).`;
  return `Buy ${keys}: with it the plan measures ${gain} on its worst item.${why}`;
}

/**
 * #766 D — WHY THE MEASURED ANSWER IS NOT THE QUICK RULE'S, in one clause — or null when the two
 * plans agree. The subject is the RULE's plan and what it would do to the job, because the rule's
 * answer is what the panel showed while the search ran (the provisional label): "the quick rule's
 * ⌀1 rest would leave "Software" joined at 7 pinches". The panel prefixes it with the measured
 * plan, so the whole line reads `measured: ⌀3.175 + ⌀0.3 V rest — the quick rule's …`.
 */
export function ruleDifferenceLine(pick: SmartPick, tools: readonly ToolLibraryEntry[]): string | null {
  const rule = pick.rule;
  if (rule === null || planKey(rule.plan) === planKey(pick.chosen.plan)) return null;
  const culprit = rule.plan.cutters[rule.plan.cutters.length - 1];
  if (culprit === undefined) return null;
  const word = cutterWord(culprit, tools);
  const joined = rule.evaluation.items.flatMap((item) =>
    item.pinches.filter((pinch) => !pinch.separated).map((pinch) => ({ item, pinch })),
  );
  if (joined.length > 0) {
    // A label's item name is already the quoted text (`"Software"`); a cutaway's is its id. Quote
    // the latter, leave the former as the sentence's own subject.
    const names = [...new Set(joined.map((j) => quoted(j.item.name)))];
    return `the quick rule's ${word} would leave ${names.join(' and ')} joined at ${joined.length} pinch${joined.length === 1 ? '' : 'es'}`;
  }
  if (rule.worstFidelity < 1 - 1e-9) {
    const worst = rule.worstItem;
    return `the quick rule's ${word} would measure ${pct(rule.worstFidelity)} on ${worst === null ? 'its worst item' : quoted(worst.name)}`;
  }
  return `the quick rule's ${word} measures the same; the search chose on tool changes and time`;
}

/** The whole explanation, in order: the verdict, one line per cutter, the alternative, the buy. */
export interface SmartPickWords {
  /** The chosen plan's own name: '⌀3.175 + ⌀0.3 V rest'. */
  plan: string;
  verdict: string;
  /**
   * #766 fix — THE STRUCTURAL GUARD'S SENTENCE. The rule's kind plan is always a candidate, and
   * when it is the ONLY plan that posts the search hands it over and says so, rather than letting
   * an operator wonder why the measured answer is the rule's.
   */
  fallback: string | null;
  cutters: string[];
  runnerUp: string | null;
  buyThis: string | null;
  /** What the quick rule's plan would do differently, or null when it is the chosen plan. */
  difference: string | null;
  notes: string[];
}

/** The rule plan being the only one that posts; otherwise null. */
export function ruleFallbackLine(pick: SmartPick, tools: readonly ToolLibraryEntry[]): string | null {
  if (pick.runnable === null || pick.rule === null) return null;
  if (planKey(pick.rule.plan) !== planKey(pick.chosen.plan)) return null;
  if (pick.runnerUp !== null || pick.considered.length <= 1) return null;
  return `the measured search found no better posting plan; using the rule's plan, ${planLabel(pick.rule.plan, tools)}`;
}

export function explainSmartPick(pick: SmartPick, tools: readonly ToolLibraryEntry[]): SmartPickWords {
  const chosen = pick.chosen;
  const seconds = chosen.evaluation.seconds;
  const verdict = pick.runnable === null
    ? `No plan the search tried posts; the best-measured one (${pct(chosen.worstFidelity)} on the worst item) is refused: ${chosen.evaluation.refusal ?? 'the generator refuses it'}.`
    : `Chosen by simulation: ${pct(chosen.worstFidelity)} fidelity on the worst item, ${chosen.evaluation.toolChanges} tool change${chosen.evaluation.toolChanges === 1 ? '' : 's'}${seconds === null ? '' : `, about ${Math.round(seconds)} s`}.`;
  return {
    plan: planLabel(chosen.plan, tools),
    verdict,
    fallback: ruleFallbackLine(pick, tools),
    cutters: cutterLines(pick, tools),
    runnerUp: runnerUpLine(pick, tools),
    buyThis: buyThisLine(pick, tools),
    difference: ruleDifferenceLine(pick, tools),
    notes: pick.notes,
  };
}

/**
 * #963 — THE MODEL PLAN, IN THE OPERATOR'S WORDS. The rebuilt engine's `SetupPlan`
 * (`cam/model/plan.ts`, #956 §3.0) is the one place the app learns what the part IS (the
 * recognised features), what will cut it (the costed sequence) and how the passes are joined
 * (the linking facts). This module turns those facts into the sentences the goal row and the run
 * sheet print, so the panel, the sheet and F's parity harness (#964) read the same words.
 */
import type { SetupPlan } from '@/engine/cnc/cam/model/plan';
import type { PlannedOpKind } from '@/engine/cnc/cam/model/sequence';
import type { ModelPlanProgress } from '@/engine/cnc/cam/model/types';
import { formatDuration } from '@/engine/cnc/plan/format';

/** A pocket node's countable part: its children (A's `PocketNode.children`, #958). */
export interface PlanPocketLike {
  children?: readonly PlanPocketLike[];
}

/** The feature tree's countable parts, as the sentence needs them (A's `FeatureTree`, #958). */
export interface PlanFeaturesView {
  pockets: readonly PlanPocketLike[];
  /** Present on every tree (the outer contour); absent only in a test fixture that omits it. */
  contour?: unknown;
  remainder: readonly unknown[];
}

/**
 * One cutter in the chosen sequence, with the row's own label for it (the panel resolves the
 * key through the tool library) and the plan's own cost (B's `CycleCost`).
 */
export interface PlanSequenceEntryWords {
  label: string;
  /** The operator pinned this cutter; the plan honours it rather than costing it. */
  pinned?: boolean;
  cost: { totalSeconds: number };
}

/** Every pocket, roots and children: a slot inside a pocket is still a pocket to the operator. */
export function countPockets(nodes: readonly PlanPocketLike[]): number {
  let count = 0;
  for (const node of nodes) count += 1 + countPockets(node.children ?? []);
  return count;
}

/**
 * "6 pockets, 1 outer contour, 1 curved region" — what the engine recognised in the model. The
 * contour is always named (every recognised part has an outline); a count is omitted when it is
 * zero rather than printed as "0 curved regions".
 */
export function featureSentence(features: PlanFeaturesView): string {
  const parts: string[] = [];
  const pockets = countPockets(features.pockets);
  if (pockets > 0) parts.push(`${pockets} pocket${pockets === 1 ? '' : 's'}`);
  if (features.contour !== undefined) parts.push('1 outer contour');
  const remainder = features.remainder.length;
  if (remainder > 0) parts.push(`${remainder} curved region${remainder === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * "⌀6 flat (18 min) → ⌀3.175 flat (11 min) → ⌀6 ball (15 min) — about 47 min": the sequence the
 * engine priced, each cutter at its own cost (B's `CycleCost.totalSeconds`), a pinned cutter
 * marked as the operator's choice. Null for an empty sequence.
 */
export function sequenceSentence(
  sequence: readonly PlanSequenceEntryWords[],
  totalCostSeconds: number,
): string | null {
  if (sequence.length === 0) return null;
  const cutters = sequence.map((entry) => {
    const cost = formatDuration(entry.cost.totalSeconds);
    return entry.pinned === true ? `${entry.label} (${cost}, pinned)` : `${entry.label} (${cost})`;
  });
  return `${cutters.join(' → ')} — about ${formatDuration(totalCostSeconds)}`;
}

/**
 * "384 rapids, 12 hops, 3.2 % of the cycle in air": the linking facts the plan states. Stay-down
 * linking has no switch, so this is a report, never a setting (plan v2 §2, #962).
 */
export function linkingSentence(linking: SetupPlan['linking']): string {
  const count = (n: number, one: string, many: string): string =>
    `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  const air = Math.round(linking.airFractionPct * 10) / 10;
  return `${count(linking.rapidsCount, 'rapid', 'rapids')}, ${count(linking.hopsCount, 'hop', 'hops')}, ${air} % of the cycle in air`;
}

const OP_WORDS: Record<PlannedOpKind | 'features' | 'clSurface' | 'sequence' | 'linking', string> = {
  features: 'Recognising the features',
  clSurface: 'Building the cutter surface',
  sequence: 'Pricing the cutters',
  linking: 'Joining the passes',
  pocket: 'Cutting the pockets',
  contour: 'Cutting the outline',
  rough: 'Roughing',
  rest: 'Taking the rest',
  finish: 'Finishing',
  pencil: 'Following the creases',
  chamfer: 'Breaking the edges',
};

/**
 * "Roughing — 40 %": the plan's own progress report (B's `ModelPlanProgress`, #956 §3.0), the one
 * number the panel's progress line has to print while a multi-second plan runs. The stage name is
 * the engine's own word for the step, never the panel's guess.
 */
export function progressWords(progress: ModelPlanProgress): string {
  return `${OP_WORDS[progress.op]} — ${Math.round(progress.fraction * 100)} %`;
}

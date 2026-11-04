/**
 * #963 — THE MODEL PLAN, IN THE OPERATOR'S WORDS. The rebuilt engine's `SetupPlan` (#956 §3.0)
 * is the one place the app learns what the part IS (the recognised features), what will cut it
 * (the costed sequence) and how the passes are joined (the linking facts). This module turns
 * those facts into the sentences the goal row and the run sheet print, so the panel, the sheet
 * and F's parity harness (#964) all read the same words.
 *
 * The shapes are read STRUCTURALLY, not imported: `FeatureTree` is A's #958 shape and
 * `SetupPlan.sequence`/`.linking` are B's #956 interface, and a narrow view of each keeps this
 * module compiling before `cam/model/` lands and unchanged after it does.
 */
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

/** One cutter in the chosen sequence, with the row's own label for it (the panel resolves keys). */
export interface PlanSequenceEntryWords {
  label: string;
  /** The operator pinned this cutter; the plan honours it rather than costing it. */
  pinned?: boolean;
}

/** The linking facts the plan carries (#956 §3.0, C's #962). */
export interface PlanLinkingView {
  rapidsCount: number;
  hopsCount: number;
  airFractionPct: number;
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
 * "⌀6 flat → ⌀3.175 flat → ⌀6 ball → 90° chamfer — about 47 min": the sequence the engine priced,
 * with a pinned cutter marked as the operator's choice. Null for an empty sequence (a plan that
 * chose nothing has nothing to say).
 */
export function sequenceSentence(
  sequence: readonly PlanSequenceEntryWords[],
  totalCostSeconds: number,
): string | null {
  if (sequence.length === 0) return null;
  const cutters = sequence.map((entry) => (entry.pinned === true ? `${entry.label} (pinned)` : entry.label));
  return `${cutters.join(' → ')} — about ${formatDuration(totalCostSeconds)}`;
}

/**
 * "384 rapids, 12 hops, 3.2 % of the cycle in air": the linking facts the plan states. Stay-down
 * linking has no switch, so this is a report, never a setting (plan v2 §2, #962).
 */
export function linkingSentence(linking: PlanLinkingView): string {
  const count = (n: number, one: string, many: string): string =>
    `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
  const air = Math.round(linking.airFractionPct * 10) / 10;
  return `${count(linking.rapidsCount, 'rapid', 'rapids')}, ${count(linking.hopsCount, 'hop', 'hops')}, ${air} % of the cycle in air`;
}

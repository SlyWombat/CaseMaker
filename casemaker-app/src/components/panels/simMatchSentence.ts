/**
 * The sentence under the Simulate panel's Tool select (#316/#332), beside `simCoverage.ts` for the
 * same reason: a pure text builder keeps its own module rather than living in a component file.
 *
 * A component module may export components and nothing else — `react-refresh/only-export-components`
 * is the lint gate that keeps fast refresh honest — so this is where the sentence lives now that the
 * panel is its only caller.
 *
 * The rule that answered decides the phrase, not the fact that a key was stated: an unheld key falls
 * through to the id step or the shape step, and the sentence has to name the evidence it actually
 * has. A held key whose entry no longer measures what the file cut is the one case where the key is
 * right and `exact` is not.
 */
import type { MatchProvenance, MatchStrength } from '@/engine/cnc/headerMatch';
import { TIER_TAG, type ToolTier } from '@/engine/cnc/toolTiers';

export function matchSentence(
  match: MatchStrength | null,
  provenance: MatchProvenance | null,
  statedKey: string | null,
): string {
  if (provenance === 'key') {
    return match === 'exact'
      ? 'matched from the cutter the file names.'
      : `the file names the cutter "${statedKey}", but states a cutting diameter this house’s entry does not match — check it.`;
  }
  if (statedKey !== null) {
    return provenance === 'id'
      ? `the file names the cutter "${statedKey}", which this house does not have — closest by the vendor id it also states; check it.`
      : `the file names the cutter "${statedKey}", which this house does not have — closest by shape and diameter; check it.`;
  }
  return match === 'suggested'
    ? 'closest cutter by shape and diameter — the file does not confirm it; check it.'
    : 'matched from the file’s TOOL record.';
}

/**
 * The question, when the file's TOOL record answers as well for rows in two tiers (#316) — the one
 * case with no `toolKey` to build `matchSentence` from, which is why it is its own export.
 *
 * Each row is named with the word its TIER gets everywhere else (`TIER_TAG`, the Manage picker's own
 * tag), because the tier is the whole of what separates two rows that matched shape, diameter and
 * every length the file states: what the person is choosing between is the cutter they physically
 * own and the catalogue row it came from. Not "two" — a tier may hold several rows, and the sentence
 * has to be true of however many are on screen.
 */
export interface DescribedCandidate {
  /** The entry's name, as the Tool select and the Manage picker show it. */
  name: string;
  tier: ToolTier;
}

/** `**A** (catalogue) and **B** (owned)`. */
function nameCandidates(candidates: readonly DescribedCandidate[]): string {
  const named = candidates.map((c) => `**${c.name}** (${TIER_TAG[c.tier]})`);
  if (named.length <= 1) return named[0] ?? '';
  return `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
}

export function ambiguousSentence(candidates: readonly DescribedCandidate[]): string {
  return `this file matches more than one of your cutters — ${nameCandidates(candidates)}; pick the one it was cut with.`;
}

/**
 * After the pick (#316). It says what was applied AND that the file did not settle it, because a
 * bare "matched" would be the claim this whole path exists to avoid making: the row is the one the
 * person chose, and the sentence has to keep saying so on the next load, when they have forgotten.
 */
export function pickedSentence(candidate: DescribedCandidate): string {
  return `using **${candidate.name}** (${TIER_TAG[candidate.tier]}) — the one you picked; the file does not confirm which matching row it was.`;
}

/**
 * The sentence under a Tool select holding nothing (#332 review). Nothing matched, so the select is
 * empty and the file's own statement is the only thing left to say: a key the house does not hold is
 * a fact about the file, and printing a bare "required" would hide which cutter is missing.
 */
export function requiredToolSentence(statedKey: string | null): string {
  return statedKey === null
    ? 'required — choose the tool this program was written for.'
    : `required — the file names the cutter "${statedKey}", which this house does not have; choose the tool this program was written for.`;
}

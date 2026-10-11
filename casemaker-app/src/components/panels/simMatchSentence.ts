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
 * The sentence under a Tool select holding nothing (#332 review). Nothing matched, so the select is
 * empty and the file's own statement is the only thing left to say: a key the house does not hold is
 * a fact about the file, and printing a bare "required" would hide which cutter is missing.
 */
export function requiredToolSentence(statedKey: string | null): string {
  return statedKey === null
    ? 'required — choose the tool this program was written for.'
    : `required — the file names the cutter "${statedKey}", which this house does not have; choose the tool this program was written for.`;
}

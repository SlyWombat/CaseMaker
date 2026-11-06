/**
 * #786 slice 4c-2 — THE SUBSTITUTION SAID OUT LOUD, in one sentence shared by the finding and the
 * cutter line.
 *
 * The measured search may replace a cutter the operator chose when that cutter is missing or no
 * CAM here can use it. A replacement of someone's own choice is never silent: the job carries the
 * record ({@link EngraveJobSubstitution}) and this is the one wording both surfaces print, so the
 * line and the finding can never tell two different stories.
 */

import { MATERIAL_LABELS } from '@/engine/cnc/materials';
import type { EngraveJobSubstitution, EngraveSetupSubstitution } from '@/types/engraveJob';

/** The reason clause the record carries, in the one wording both sentences share. */
function why(s: EngraveJobSubstitution): string {
  return s.reason === 'missing'
    ? 'is not in the tool library'
    : s.reason === 'no-feeds'
      ? `has no feeds for ${s.material === undefined ? 'this material' : MATERIAL_LABELS[s.material]}`
      : 'cannot cut this job';
}

/** The record's lead: the operator's cutter, and — for a setup's — which setup it belongs to. */
function leadOf(where?: { setupNumber: number }): string {
  // #835 — a SETUP's substitution says which setup, so the same words can never be read as the
  // job's own cutter's: "Setup 2: your ⌀ 2 mm ball nose is not in the tool library; …".
  return where === undefined ? 'Your' : `Setup ${where.setupNumber}: your`;
}

/** "Your ⌀ 3.175 mm ball nose has no feeds for PLA; the ⌀ 3.175 mm flat end is used instead." */
export function substitutionSentence(s: EngraveJobSubstitution, where?: { setupNumber: number }): string {
  return `${leadOf(where)} ${s.fromName} ${why(s)}; the ${s.toName} is used instead.`;
}

/** One setup's substitution, in the same sentence, naming the setup it belongs to. */
export function setupSubstitutionSentence(s: EngraveSetupSubstitution): string {
  return substitutionSentence(s, { setupNumber: s.setupNumber });
}

/**
 * #1010 — THE OFFER, BEFORE THE PRESS. The same facts without claiming anything was done: the
 * measured answer is drawn beside the operator's cutter, and "is used instead" would be a lie
 * until they press it. "Setup 2: your inv:gone is not in the tool library — the 1 mm flat end
 * can cut it instead."
 */
export function substitutionOfferSentence(s: EngraveJobSubstitution, where?: { setupNumber: number }): string {
  return `${leadOf(where)} ${s.fromName} ${why(s)} — the ${s.toName} can cut it instead.`;
}

/** One setup's offered substitution, naming the setup it belongs to. */
export function setupSubstitutionOfferSentence(s: EngraveSetupSubstitution): string {
  return substitutionOfferSentence(s, { setupNumber: s.setupNumber });
}

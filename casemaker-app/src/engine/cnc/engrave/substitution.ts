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
import type { EngraveJobSubstitution } from '@/types/engraveJob';

/** "Your ⌀ 3.175 mm ball nose has no feeds for PLA; the ⌀ 3.175 mm flat end is used instead." */
export function substitutionSentence(s: EngraveJobSubstitution): string {
  const why =
    s.reason === 'missing'
      ? 'is not in the tool library'
      : s.reason === 'no-feeds'
        ? `has no feeds for ${s.material === undefined ? 'this material' : MATERIAL_LABELS[s.material]}`
        : 'cannot cut this job';
  return `Your ${s.fromName} ${why}; the ${s.toName} is used instead.`;
}

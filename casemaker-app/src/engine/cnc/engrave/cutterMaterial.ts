/**
 * The cutter/material metal-line PAIR check, shared by the worker's `metalLineFindings` and the
 * pick's fallback exemption (#573, #954). One predicate means the finding a job states and the
 * candidates the pick considers cannot disagree.
 *
 * The line is a property of the PAIR, not the cutter alone (#405): a metal-line cutter is only a
 * question on a blank that is not metal. Two carve-outs:
 *
 *   - #575 — an engraver/chamfer (a V-profile cone) is dual-use; the "(Metal)"/"for Metal" name is
 *     a false signal for it. It never carries the metal-line finding.
 *   - #732 — Makera's own catalogue has a feed row for this CUTTER on this MATERIAL (`covered`,
 *     direct or through a labelled `CATALOGUE_MATERIAL_ALIASES` mapping). The finding's premise is
 *     "no feed row was written for it on this material"; a vendor row is that premise disproved.
 *     The caller computes the coverage with `catalogueCoverageFor` — one statement of "the
 *     catalogue covers this pair" — and passes it in as a fact, so this module keeps knowing
 *     nothing about feed rows.
 *
 * #954 — THE LINE IS NOT A REFUSAL. It is read off the cutter's NAME (a `(Metal)` suffix, a
 * `for Metal` printed label, a `-M-` box code), never off geometry, coating or any material
 * property, so a cutter marketed for metal is not barred from wood or plastic. A metal-line pair
 * the catalogue does not rate is fed from the material's own starting band, labelled as a fallback
 * to measure (`feedsFor`'s `metalLineFallbackNote`); the finding states that, and the run refuses
 * only where the feeds have no band to stand in. #572's operator override is therefore inert: there
 * is no blocking state left to acknowledge.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { StockMaterial } from '@/types/engraveJob';
import { isMetalMaterial } from '@/engine/cnc/materials';
import { isMetalTool } from '@/engine/cnc/registerCutter';
import { isVShape } from '@/engine/cnc/vProfile';

/**
 * Whether the pair carries the metal-line finding at all — metal line on a non-metal blank, not
 * V-exempt, and not a pair Makera's catalogue rates.
 */
export function cutterOnMetalLine(
  tool: Tool | null,
  material: StockMaterial,
  catalogueCovered: boolean = false,
): boolean {
  if (tool === null) return false;
  if (catalogueCovered) return false;
  if (!isMetalTool(tool)) return false;
  if (isMetalMaterial(material)) return false;
  if (isVShape(tool)) return false;
  return true;
}

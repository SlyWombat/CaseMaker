/**
 * The cutter/material metal-line PAIR check, shared by the worker's `metalLineFindings` and the
 * guided flow's step-2 gate (#573). One predicate means the refusal a job sees in the panel can
 * never disagree with the gate the wizard shows.
 *
 * The line is a property of the PAIR, not the cutter alone (#405): a metal-line cutter is only a
 * problem on a blank that is not metal. Two carve-outs:
 *
 *   - #575 — an engraver/chamfer (a V-profile cone) is dual-use; the "(Metal)"/"for Metal" name is
 *     a false signal for it, and the feeds resolution already refuses the genuine "no row for this
 *     material" case. It never carries the metal-line finding.
 *   - #572 — the operator's double-confirmed override downgrades the finding from a blocking error
 *     to an acknowledged warning. `cutterRefusedOnMaterial` is false when it is set.
 */

import type { Tool } from '@/engine/cnc/tool';
import type { StockMaterial } from '@/types/engraveJob';
import { isMetalMaterial } from '@/engine/cnc/materials';
import { isMetalTool } from '@/engine/cnc/registerCutter';
import { isVShape } from '@/engine/cnc/vProfile';

/** Whether the pair carries the metal-line finding at all — metal line on a non-metal blank, not V-exempt. */
export function cutterOnMetalLine(tool: Tool | null, material: StockMaterial): boolean {
  if (tool === null) return false;
  if (!isMetalTool(tool)) return false;
  if (isMetalMaterial(material)) return false;
  if (isVShape(tool)) return false;
  return true;
}

/** Whether the pair is a BLOCKING metal-line refusal — on the line and not acknowledged (#572). */
export function cutterRefusedOnMaterial(
  tool: Tool | null,
  material: StockMaterial,
  metalLineOverride: boolean | undefined,
): boolean {
  return cutterOnMetalLine(tool, material) && metalLineOverride !== true;
}

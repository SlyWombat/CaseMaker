import type { ToolboxParams } from '@/types';
import { TOOLBOX_LID_H, toolboxParamsProblem } from '@/types/toolbox';
import type { PrinterVolume } from '@/types/printer';
import type { PlacementIssue } from './placementValidator';
import { validateFootprints, type PartFootprint } from './rackFit';

/**
 * Printer build-volume fit checking for the toolbox archetype (#155), the
 * third caller of the generic per-part check `rackFit.ts` extracted.
 *
 * Footprints are in each part's PRINT orientation, which for this archetype is
 * also its assembly orientation: a module is designed with `z = 0` as both the
 * seating plane and the print-bed face, so it prints right way up with nothing
 * to flip. That is why the print footprint of a module is simply its external
 * plan `width × depth` and its print height is `height` — no `+ FOOT_H`, since
 * the registration foot is *inside* that extent rather than hanging below it.
 *
 * The bin and the lid share a plan, so in practice one of them governs the bed
 * check and the other governs the height; both are reported, because "the lid
 * is the blocker" is a different fix from "the bin is".
 */
export function toolboxPartFootprints(p: ToolboxParams): PartFootprint[] {
  return [
    { id: 'toolbox-bin', label: 'bin', fx: p.width, fy: p.depth, fz: p.height },
    { id: 'toolbox-lid', label: 'lid', fx: p.width, fy: p.depth, fz: TOOLBOX_LID_H },
  ];
}

/**
 * Check the toolbox's two parts against the configured printer.
 *
 * A module bigger than the bed is not an error the compiler acts on — the
 * geometry still builds and still exports — it is the app telling the user
 * before they slice. Same contract as `validateRackFit`, and deliberately the
 * same message wording, because `validateFootprints` builds both.
 */
export function validateToolboxFit(
  p: ToolboxParams,
  printer?: PrinterVolume,
): PlacementIssue[] {
  const issues: PlacementIssue[] = [];
  if (!printer) return issues;

  // A size that reports a reason is a size that will not build at all, so
  // there is nothing to say about its bed fit on top of that.
  if (toolboxParamsProblem(p) !== null) return issues;

  issues.push(...validateFootprints(toolboxPartFootprints(p), printer));
  return issues;
}

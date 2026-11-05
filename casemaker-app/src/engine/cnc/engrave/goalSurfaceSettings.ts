/**
 * engrave/goalSurfaceSettings.ts — two goal-level surface settings extracted from `surface3d.ts`
 * (#966) as a PURE MOVE: same code, same behaviour, no tolerance or constant changed.
 *
 * Neither is part of the old heightfield engine's own PLANNING (`generateSurface3dIR`/
 * `generateSurface3dForGoal`, both retired by #966) — both have a real caller independent of
 * which CAM engine runs: `goalClearBand` is read by the CAM AND by the top-face measure
 * (`goalTopFace.ts`, #888) so the plan that is judged and the program that is cut cannot disagree
 * about what is cleared; `DEFAULT_PENCIL_CREASE_DEG` is a UI fallback for a goal's own
 * pencil-crease-angle control (`EngraveTargetObjectRow.tsx`), a job-level setting, not
 * old-engine-private. Both had to move before `surface3d.ts` itself could be deleted.
 */

import { isMold } from './goalHeightfield';
import type { EngraveTargetObject } from '@/types/engraveJob';

/**
 * #671 — the crease angle the PENCIL pass follows when the operation states none, degrees. The
 * mark is a change of slope across one grid cell sharper than this: a 90° wall's foot marks a
 * line; a cylinder, a dome and a ramp do not.
 */
export const DEFAULT_PENCIL_CREASE_DEG = 20;

/**
 * #764/#888 — THE CLEAR BAND A GOAL'S PROGRAM CUTS AROUND ITS FOOTPRINT, from the goal's own
 * settings. ONE reader, used by the CAM and by the top-face measure (#888), so the plan that is
 * judged and the program that is cut cannot disagree about what is cleared. `stepOverMm` widens
 * the ring as the CAM does; a caller that does not know it (the measure before a cutter is
 * resolved) passes none, which only makes the ring narrower — a top reads as surviving a little
 * more often, never less.
 */
export function goalClearBand(
  goal: Pick<EngraveTargetObject, 'format' | 'goalMode' | 'surface'>,
  opts: { toolDiameterMm?: number | null; stepOverMm?: number | null } = {},
): { clear: { kind: 'ring'; widthMm: number } | { kind: 'whole' } | null; ringWidthMm: number } {
  const settings = goal.surface ?? {};
  const clearAround = settings.clearAround ?? 'ring';
  const stepOver = opts.stepOverMm !== null && opts.stepOverMm !== undefined && opts.stepOverMm > 0 ? opts.stepOverMm : 0;
  const ringWidthMm = (opts.toolDiameterMm ?? 0) + stepOver;
  const clear =
    goal.format === 'png' || isMold(goal) || clearAround === 'none' || (clearAround === 'ring' && !(ringWidthMm > 0))
      ? null
      : clearAround === 'whole'
        ? ({ kind: 'whole' } as const)
        : ({ kind: 'ring', widthMm: ringWidthMm } as const);
  return { clear, ringWidthMm };
}

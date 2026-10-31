/**
 * #811 — the goal's DRAWING decisions, as plain data so a test can pin them without a canvas.
 *
 * Two things decide how the viewport draws a stated goal, and both used to be tangled into the
 * scene components: whether the stock is GHOSTED (a goal inside an opaque blank is a picture of
 * nothing — #723 R-3 did this for the rotary goal, #811 completes it for flat stock), and what the
 * two goal modes are called in the legend.
 *
 * The volumes themselves are built by the preview worker (`EngravePreview.goal`), from the same
 * parsed mesh and the same placed frame the CAM samples, so the picture and the cut cannot
 * describe different parts.
 */

import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

/** The ghosted stock's opacity — the value the rotary goal has used since #723 R-3. */
export const GOAL_GHOST_OPACITY = 0.22;

/** How the stock mesh is drawn: solid, or ghosted so a goal inside it reads through. */
export interface StockGhostStyle {
  transparent: boolean;
  opacity: number;
  depthWrite: boolean;
}

/**
 * The one rule both stock materials take (#162: a transparent mesh must not write depth — it
 * would hide exactly the volume it is ghosted to reveal).
 */
export function stockGhost(statedGoal: boolean): StockGhostStyle {
  return statedGoal
    ? { transparent: true, opacity: GOAL_GHOST_OPACITY, depthWrite: false }
    : { transparent: false, opacity: 1, depthWrite: true };
}

/**
 * The target object that is CUT — enabled and `role: 'goal'` — or null. A reference object is
 * drawn, never cut, and gets its own ghosted style instead of a goal's.
 */
export function statedGoalTarget(job: Pick<EngraveJob, 'targetObject'>): EngraveTargetObject | null {
  const target = job.targetObject;
  if (target === undefined || !target.enabled) return null;
  return (target.role ?? 'reference') === 'goal' ? target : null;
}

/** What the goal's legend line says, in the row's own words ("mold", the app's spelling). */
export function goalLegendWords(mode: 'item' | 'mold'): string {
  return mode === 'mold' ? 'Goal: a mold of the part' : 'Goal: the part, standing proud';
}

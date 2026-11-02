/**
 * #914 — THE REACH BAND AND ITS SEAM, ONE RULE FOR EVERY SIDE.
 *
 * A side of a multi-setup plan (a flat side of the stock, or — #915 — an indexed station of a
 * rotary job) can only cut the goal's surface within the chosen cutter's reach measured from THAT
 * side's top face. This module is the one place that turns a side's need and the cutter's known
 * reach into the band it cuts, the depth it leaves beyond the band, and the seam a plan must
 * overlap its neighbours by. The flat side plan (`goalFlipPlan`) and the rotary station plan call
 * the same function, so the two cannot state different numbers for the same rule.
 *
 * The clearance is #785's: the holder must stay above the work, so the USABLE reach is the
 * cutter's stated reach less {@link GOAL_BAND_CLEARANCE_MM}. A band past the need is the need; a
 * need past the band leaves a remainder that is stated, never silently dropped — the #910/#785
 * inform-don't-refuse rule.
 */

import { GOAL_BAND_CLEARANCE_MM } from './goalReach';

/** The seam's floor, mm: adjacent bands never meet exactly (one finishing step-over, or this). */
export const REACH_SEAM_MIN_MM = 0.5;

/**
 * #914 — the seam adjacent sides overlap by, mm: one finishing step-over, floored at
 * {@link REACH_SEAM_MIN_MM}. The same number for a flat plan's sides and a rotary station's bands,
 * so the two cannot state different joins for the same rule.
 */
export function reachSeamMm(finishStepOverMm?: number | null): number {
  const stepOver =
    finishStepOverMm != null && Number.isFinite(finishStepOverMm) && finishStepOverMm > 0 ? finishStepOverMm : 0;
  return Math.max(stepOver, REACH_SEAM_MIN_MM);
}

export interface ReachBandInput {
  /** How deep this side's own top face lies above the goal's deepest surface it must cut, mm. */
  needMm: number;
  /**
   * The chosen cutter's KNOWN reach (its stated shoulder, else flute, else Makera's catalogue row
   * for the same cutter), mm. Null/absent/unrecorded: no limit — the band is the need and the
   * caller's sentence states the assumption.
   */
  reachMm?: number | null;
  /** The finishing raster's step-over, mm; absent → the seam's floor stands. */
  finishStepOverMm?: number | null;
}

export interface ReachBand {
  /** The usable reach from this side's top face: the stated reach less the holder clearance. */
  usableReachMm: number | null;
  /** How deep this side cuts below its own top face, mm: `min(need, usable reach)`. */
  bandMm: number;
  /** What this side cannot reach: `need − band`, mm; 0 when it reaches all of it. */
  remainderMm: number;
  /** The seam adjacent sides overlap by where their bands meet, mm. */
  seamMm: number;
}

/**
 * #914 — one side's band. `reachMm` is the cutter's STATED reach, not the usable one: the clearance
 * is applied here, once, so every caller gets #785's margin without restating it.
 */
export function reachBand(input: ReachBandInput): ReachBand {
  const need = Math.max(0, Number.isFinite(input.needMm) ? input.needMm : 0);
  const seamMm = reachSeamMm(input.finishStepOverMm);
  const stated = input.reachMm != null && Number.isFinite(input.reachMm) && input.reachMm > 0 ? input.reachMm : null;
  if (stated === null) {
    return { usableReachMm: null, bandMm: need, remainderMm: 0, seamMm };
  }
  const usable = Math.max(0, stated - GOAL_BAND_CLEARANCE_MM);
  const bandMm = Math.min(need, usable);
  return { usableReachMm: usable, bandMm, remainderMm: Math.max(0, need - bandMm), seamMm };
}

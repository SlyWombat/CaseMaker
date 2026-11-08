/**
 * #948 — WHAT AN ORACLE CALL NEEDS TO JUDGE A GOAL, as plain data.
 *
 * The sim worker owns the swept top (the live column grid) and the goal's heightfield
 * (`sampleGoalHeightfield`, the same sampler the CAM cut the program against), so the main thread
 * hands it only the goal OBJECT: the fields the sampler reads, copied out of the job, plus the
 * mould flag. The worker samples once per session (the sampling is the expensive half) and pairs
 * the field with the live sweep's top before calling `session.oracle`.
 *
 * A caller that already knows the comparison cannot be made — a goal cut from several sides, whose
 * sweeps live in each side's own frame — passes `unchecked` with the reason instead. The oracle
 * then states the gap in its report (`goalCutIntoUnchecked`) rather than leaving the goal
 * unmentioned or reporting a check that did not run.
 */

import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';
import type { RotarySection } from '@/engine/cnc/rotary/wrap';
import { pureGoalObject } from './jobKind';
import type { GoalCutIntoOptions } from './designCheck';

/**
 * The goal object's own sampling fields — `sampleGoalHeightfield`'s `Pick` plus the mould flag.
 * Plain and serializable, exactly like `EngraveTargetObject`; no handle crosses the worker seam.
 */
export type GoalCheckTarget = Pick<
  EngraveTargetObject,
  | 'sha256'
  | 'format'
  | 'data'
  | 'position'
  | 'rotation'
  | 'rotationX'
  | 'rotationY'
  | 'size'
  | 'relief'
  | 'scale'
  | 'goalMode'
>;

/**
 * The goal check one oracle call carries: a target to sample, or the reason it cannot run — each
 * with the check's own options (`passCoverage`, #948), which the caller reads from the shop.
 */
export type SimGoalCheck =
  | {
      target: GoalCheckTarget;
      /**
       * #1083 — A ROTARY GOAL IS COMPARED ON THE MAP. The relief's material lives in (X, θ) with
       * radii, so the worker samples the goal's radial field at this radius and pairs it with the
       * live column grid; absent, the goal is the flat heightfield check it always was.
       */
      rotary?: { radius: number; section: RotarySection | null };
      opts?: GoalCutIntoOptions;
    }
  | { unchecked: string; opts?: GoalCutIntoOptions };

/**
 * The goal check a program's oracle call should carry, from the job and whether THIS program is a
 * goal program (`EngraveProgram.surface3d != null` — the goal path's own marker).
 *
 * Only a PURE goal job (`pureGoalObject`) is compared: one goal, one side, flat. A goal cut from
 * several sides is stated unchecked — side 2 is swept in the released, turned-over frame, and
 * comparing that sweep with the goal's document-frame heightfield would be a picture of a
 * comparison that did not happen. `undefined` for a program that is not a goal program at all: an
 * item job's oracle has no goal to compare with.
 */
export function goalCheckForProgram(
  job: EngraveJob,
  goalProgram: boolean,
  opts?: GoalCutIntoOptions,
  /**
   * #1083 — the job's rotary map, from the CALLER: this module is a #964 gate root and must not
   * value-import `rotary/wrap` (its chain reaches `cam/ir`). A caller with the CAM
   * (`engraveRunStore`, `planEvaluate`) passes `rotaryMapOf(job)`'s radius and section.
   */
  rotary?: { radius: number; section: RotarySection | null } | null,
): SimGoalCheck | undefined {
  if (!goalProgram) return undefined;
  const goal = pureGoalObject(job);
  if (goal === null) {
    return {
      unchecked:
        'this goal is cut from more than one side, and a side’s sweep lives in that side’s own frame, so the document-frame goal was not compared',
      ...(opts === undefined ? {} : { opts }),
    };
  }
  const { sha256, format, data, position, rotation, rotationX, rotationY, size, relief, scale, goalMode } = goal;
  // #1083 — a goal held in the rotary chuck is judged from the radial field against the map's own
  // column grid, so the sample's own frame facts ride along (the section names the stock's surface
  // between the flats, which a cell the relief never cuts keeps).
  return {
    target: { sha256, format, data, position, rotation, rotationX, rotationY, size, relief, scale, goalMode },
    ...(rotary === undefined || rotary === null ? {} : { rotary }),
    ...(opts === undefined ? {} : { opts }),
  };
}

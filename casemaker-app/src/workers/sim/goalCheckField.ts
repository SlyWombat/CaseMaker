/**
 * #948 — THE GOAL CHECK'S HEIGHTFIELD, sampled in the sim worker and cached.
 *
 * Both oracle callers that can judge a goal live in the sim worker — the run's own oracle
 * (`sim.worker.ts`) and the plan evaluation's full sweep (`planEvaluate.ts`) — and both need the
 * same two halves: the goal's top surface in the work frame, and the LIVE session's own swept top.
 * This module owns the first half so the two callers cannot sample different fields, and owns the
 * cache so a goal's rough and finish programs (or a plan search's candidates) pay for the sampling
 * once.
 *
 * The grid is the page's own checker's (`docs/bench/2026-10-28-z1-real-jobs/tools/goal-hf.mts`):
 * 0.1 mm, capped at 20 M cells. What the check does with the pair is `designCheck.ts`'s
 * `checkGoalCutInto`, ported from the same run's `goal_check.py`.
 *
 * #945 — ONE VERDICT, THE PAGE'S OWN POINT READ. `checkGoalCutInto` judges cut-into, the leftover
 * bands and the pass line off the exact stamp (`sweptPoint.ts`, handed over as `sweptTopExact`),
 * the same field the page's `goal_check.py` computes, and reports the conservative column read
 * beside it as a stated diagnostic (`GoalCutIntoReport.columnCutInto`). That read is the HIGHEST
 * of the four columns bracketing a cell (`session.sweptTop`): it is one column lenient — blind to
 * a gouge narrower than a cell — and it carries the half-cell slope bias the contact-point finish
 * no longer has, which showed up as a cliff-edge phantom when it was the verdict (the top-clamp
 * card's 1,930 cells, #948). `pitchMm` states the resolution; the positive controls pin a 0.2 mm
 * plunge (both reads) and a sub-column gouge (the stamp alone).
 */

import { isMold, moldHeightfield, sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';
import { placedSize } from '@/engine/cnc/engrave/targetScale';
import type { GoalCheckTarget, SimGoalCheck } from '@/engine/cnc/engrave/goalCheckInput';
import type { GoalCheckInput, SimSession } from './session';

/** The goal-check grid: the page's own checker samples at this pitch (`tools/goal-hf.mts`). */
export const GOAL_CHECK_PITCH_MM = 0.1;
/** The bench tool's own cell cap — a goal too large for 0.1 mm is coarsened, as it is there. */
export const GOAL_CHECK_MAX_CELLS = 20_000_000;

/**
 * The last goal heightfield this worker sampled, with the key it was sampled under. A goal job's
 * programs (a rough and a finish, #869) call the oracle once each, and the field is the same both
 * times: sampling is the expensive half of the check, the sweep's top is a read. Keyed on identity
 * AND placement, so a moved or rescaled goal is re-sampled, never served stale.
 */
let goalFieldCache: { key: string; field: GoalHeightfield } | null = null;

function goalFieldKey(target: GoalCheckTarget): string {
  return JSON.stringify([
    target.sha256,
    target.format,
    target.goalMode ?? 'item',
    target.position,
    target.rotation,
    target.rotationX ?? 0,
    target.rotationY ?? 0,
    target.size,
    target.scale ?? null,
    target.relief ?? null,
    GOAL_CHECK_PITCH_MM,
  ]);
}

/** The goal's top surface in the work frame, at the check's grid — sampled once per key. */
export function goalHeightfieldFor(target: GoalCheckTarget): GoalHeightfield {
  const key = goalFieldKey(target);
  if (goalFieldCache !== null && goalFieldCache.key === key) return goalFieldCache.field;
  const sampled = sampleGoalHeightfield(target, { pitchMm: GOAL_CHECK_PITCH_MM, maxCells: GOAL_CHECK_MAX_CELLS });
  // A mould is cut as the part turned over and sunk from the stock's top face, so the swept floor
  // is compared with THAT field — the same transform the CAM cuts (`moldHeightfield`).
  const field = isMold(target) ? moldHeightfield(sampled, target.position.y, target.position.z - placedSize(target).z) : sampled;
  goalFieldCache = { key, field };
  return field;
}

/**
 * The goal check an oracle call gets, from the plain input the main thread sent: the sampled
 * heightfield paired with the LIVE session's top. When no read exists at all the call says so
 * through `unchecked` — a rotary sweep keeps its radii in the map frame, a refused sweep owns no
 * material, and a target whose bytes are gone cannot be sampled. Never a silent pass.
 *
 * #964 — THE STAMP IS ROUTE-INDEPENDENT. A flat job the EXACT sweeper took (the tray/organizer
 * class: many moves, few Z levels) has no column grid, so `sweptTop()` is null; it still has the
 * program's own timeline, and the page's stamp (`sweptFieldExact`) answers on it exactly as it
 * does on a flat column. Such a job is CHECKED from the stamp alone — the conservative column
 * diagnostic is stated absent — rather than reading `unchecked` on the jobs the gate judges.
 */
export function goalInputFor(live: SimSession, goal: SimGoalCheck): GoalCheckInput {
  if ('unchecked' in goal) return { unchecked: goal.unchecked };
  // The sweep's capability first, before paying for the goal's sampling: a rotary or refused
  // session cannot stamp it at all (a flat column and an exact sweep both can).
  if (!live.canStampGoal()) {
    return {
      unchecked:
        'the live sweep cannot stamp the goal — a rotary column grid holds radii in the map frame and a refused sweep owns no material',
    };
  }
  const sweptTop = live.sweptTop();
  let heightfield: GoalHeightfield;
  try {
    heightfield = goalHeightfieldFor(goal.target);
  } catch (e) {
    return { unchecked: `the goal could not be sampled (${e instanceof Error ? e.message : String(e)})` };
  }
  // #948 — the page's own read of the same program, stamped onto the goal's grid: the verdict for
  // cut-into and the bands alike (since #945). On a flat column it sits beside the conservative
  // `sweptTop`; on an exact sweep it is the only read there is.
  const field = live.sweptFieldExact(heightfield);
  if (sweptTop === null && field === null) {
    return { unchecked: 'the live sweep produced no cut to stamp the goal with — no tool or no cutting move' };
  }
  const sweptTopExact =
    field === null
      ? null
      : (x: number, y: number): number | null => {
          const i = Math.round((x - heightfield.x0) / heightfield.pitch);
          const j = Math.round((y - heightfield.y0) / heightfield.pitch);
          if (i < 0 || j < 0 || i >= heightfield.nx || j >= heightfield.ny) return null;
          return field[j * heightfield.nx + i]!;
        };
  // #964 — THE EDGE-BREAK ALLOWANCE'S `who` RULE. When the job's allowance states the V bit's
  // tool number, the check excuses a cell only where that cutter left its deepest stamp; the
  // session's stamp carries the identity. Without a stated number the allowance stays
  // geometry-only (the synthetic fixtures' reading).
  const whoAt =
    goal.opts?.edgeBreak?.toolNumber === undefined ? null : live.sweptWhoExact(heightfield);
  return {
    heightfield,
    ...(sweptTop === null ? {} : { sweptTop }),
    ...(sweptTopExact === null ? {} : { sweptTopExact }),
    ...(goal.opts === undefined
      ? {}
      : { opts: whoAt === null ? goal.opts : { ...goal.opts, whoAt } }),
  };
}

/** Test hook: a goal replaced under the same key must not serve a stale field. */
export function clearGoalFieldCache(): void {
  goalFieldCache = null;
}

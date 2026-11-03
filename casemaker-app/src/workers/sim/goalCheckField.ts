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
 * LENIENT DIRECTION, STATED: the swept top for CUT-INTO is the HIGHEST of the four columns whose
 * centres bracket a goal cell (`session.sweptTop`), so a cell reads cut only when all four are
 * below the goal. A gouge up to one column (0.1 mm) wide is therefore NOT seen — a fine V-tip or
 * ball mark of one column's width leaves a neighbour at the goal's level and the cell reads
 * clean; a gouge two columns wide reads as one line of cells. `GoalCutIntoReport.pitchMm` states
 * the resolution it was judged at; the positive control is a cutter-footprint plunge, far wider.
 * (The LEFTOVER bands are read with the page's own stamp and carry no such band.)
 */

import { isMold, moldHeightfield, sampleGoalHeightfield, type GoalHeightfield } from '@/engine/cnc/cam/surface3d';
import { GOAL_LEFTOVER_BANDS_MM } from '@/engine/cnc/engrave/designCheck';
import { unionWholeSurface, type WholeSurfaceReach } from '@/engine/cnc/engrave/goalWholeSurface';
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
 * heightfield paired with the LIVE session's swept top. When either half is missing the call says
 * so through `unchecked` — a rotary sweep has no flat top, an exact-engine one has no grid, and a
 * target whose bytes are gone cannot be sampled. Never a silent pass.
 */
export function goalInputFor(live: SimSession, goal: SimGoalCheck): GoalCheckInput {
  if ('unchecked' in goal) return { unchecked: goal.unchecked };
  // The sweep first: when it has no flat top there is nothing to compare, and the goal does not
  // need sampling at all (a rotary job's heightfield is never paid for).
  const sweptTop = live.sweptTop();
  if (sweptTop === null) {
    return {
      unchecked:
        'the live sweep has no flat top to compare with — a rotary column grid holds radii and an exact-engine sweep holds no grid at all',
    };
  }
  let heightfield: GoalHeightfield;
  try {
    heightfield = goalHeightfieldFor(goal.target);
  } catch (e) {
    return { unchecked: `the goal could not be sampled (${e instanceof Error ? e.message : String(e)})` };
  }
  // #948 — the page's own read of the same sweep, stamped onto the goal's grid, for the leftover
  // bands and the pass line. The conservative `sweptTop` stays the cut-into judge.
  const field = live.sweptFieldExact(heightfield);
  const sweptTopExact =
    field === null
      ? null
      : (x: number, y: number): number | null => {
          const i = Math.round((x - heightfield.x0) / heightfield.pitch);
          const j = Math.round((y - heightfield.y0) / heightfield.pitch);
          if (i < 0 || j < 0 || i >= heightfield.nx || j >= heightfield.ny) return null;
          return field[j * heightfield.nx + i]!;
        };
  // #948 review §4.1 — THE WHOLE-SURFACE FIELD, from today's single top setup: the same page-rule
  // field the coverage is read from, turned into a reached mask (the surface stands within the
  // first leftover band). `unionWholeSurface` takes the shape the #945 setup interface will hand;
  // with one setup and no affine it is the identity, so the whole-surface reach IS the
  // top-surface number — the report states that (one top setup).
  const wholeSurface = field === null ? null : wholeSurfaceFor(heightfield, field);
  return {
    heightfield,
    sweptTop,
    ...(sweptTopExact === null ? {} : { sweptTopExact }),
    ...(wholeSurface === null ? {} : { wholeSurface }),
    ...(goal.opts === undefined ? {} : { opts: goal.opts }),
  };
}

/**
 * #948 review §4.1 — one setup's reached mask on the goal's grid: 1 where the sweep stands within
 * the first leftover band (0.1 mm) of the goal — the page's own coverage rule, cell for cell —
 * unioned into the document frame. Single top setup today; the #945 setup interface adds the
 * other setups' masks and their `toDocument` affines.
 */
function wholeSurfaceFor(goal: GoalHeightfield, field: Float32Array): WholeSurfaceReach | null {
  const grid = { nx: goal.nx, ny: goal.ny, x0: goal.x0, y0: goal.y0, pitch: goal.pitch };
  const reached = new Uint8Array(goal.nx * goal.ny);
  const band = GOAL_LEFTOVER_BANDS_MM[0]!;
  for (let k = 0; k < reached.length; k++) {
    if (goal.covered[k] !== 1) continue;
    if (field[k]! - (goal.z[k] as number) <= band) reached[k] = 1;
  }
  return unionWholeSurface(grid, [{ grid, covered: goal.covered, reached }]);
}

/** Test hook: a goal replaced under the same key must not serve a stale field. */
export function clearGoalFieldCache(): void {
  goalFieldCache = null;
}

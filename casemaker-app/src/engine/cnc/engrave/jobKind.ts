/**
 * What kind of job a document is: a pure goal job, or one with item work (#534, #535, #723).
 *
 * These two predicates read only the job document. They lived in `jobSetup.ts`, the job-planning
 * hub, which imports the CAM's cone (`vProfile`), its sweep (`partPlan`) and the 3D planner
 * through `primitiveSurface`. The goal check (`goalCheckInput.ts`) needs only `pureGoalObject`,
 * and importing it from `jobSetup.ts` pulled all of that CAM into the gate's value-import closure
 * (#956 R1, `tests/unit/gateImports.spec.ts`). They live here now. `jobSetup.ts` re-exports them,
 * so its importers are unchanged.
 *
 * Keep this module free of value imports: the gate's independence spec walks it.
 */

import type { EngraveJob, EngraveTargetObject } from '@/types/engraveJob';

/**
 * The goal object a PURE 3D-surfacing job carries (#534, #535), or `null`.
 *
 * A pure goal job carries an enabled `role: 'goal'` mesh and NO authoring items — no labels,
 * shapes, traces, drills, threads, cut-outs, primitives, vectors, combined shapes or keep-outs —
 * and no stated setups. Mixing a goal with ordinary item work stays on the item path (the item
 * program cuts; the goal keeps its `goal-object-no-toolpath` info). THE ONE DEFINITION: the
 * generate dispatch, `validateJob`'s work test and the setup bookkeeping all read this, so a job
 * cannot be "pure goal" to one and "empty" to another.
 */
export function pureGoalObject(job: EngraveJob): EngraveTargetObject | null {
  const t = job.targetObject;
  if (t === undefined || (t.role ?? 'reference') !== 'goal' || !t.enabled) return null;
  if (job.setups !== undefined) return null;
  return jobHasItems(job) ? null : t;
}

/** #723 P2-1b — whether the document holds any item work (the mixed-job test for a goal job). */
export function jobHasItems(job: EngraveJob): boolean {
  return (
    job.labels.length > 0 ||
    job.shapes.length > 0 ||
    (job.cutouts?.length ?? 0) > 0 ||
    (job.chamfers?.length ?? 0) > 0 ||
    (job.combined?.length ?? 0) > 0 ||
    (job.traces?.length ?? 0) > 0 ||
    (job.vectors?.length ?? 0) > 0 ||
    (job.keepOuts?.length ?? 0) > 0 ||
    (job.drills?.length ?? 0) > 0 ||
    (job.threads?.length ?? 0) > 0 ||
    (job.primitives?.length ?? 0) > 0
  );
}

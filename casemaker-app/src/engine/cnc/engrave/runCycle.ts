/**
 * #1123 item 6 — THE RUN'S CYCLE, ONE SOURCE.
 *
 * The bench note: the Job panel's Ready card said "about 1 h 22 min" while the Cut step's tradeoff
 * line said "cycle 122.8 → 63.1 min" — one run, two cycle figures on two screens. The card read the
 * FIRST program's `cam.estimatedSeconds`; the tradeoff compares the PLANS' own outcomes
 * (`PlanOutcome.cycleSeconds`: every program plus the plan's own tool changes). The app therefore
 * states a run's cycle from the plan outcome wherever it has one, and keeps the per-program
 * summary only as a fallback for a result that states no outcome (a refusal before the plan's
 * measurement, or an older result shape).
 */

/** The two shapes a result can state its cycle in — structural, so the store/tests can hand in either. */
export interface RunCycleSource {
  /** The model plan's own outcome (`ModelPlanOutput.outcome`), when one was measured. */
  plan?: { outcome?: { cycleSeconds: number } | null } | null;
  /** The first posted program's summary — the fallback. */
  cam?: { estimatedSeconds: number } | null;
}

/**
 * The run's cycle estimate, seconds — the PLAN outcome's number when the result carries one, else
 * the first program's summary. Null when neither states a positive number.
 */
export function runCycleSeconds(generated: RunCycleSource | null | undefined): number | null {
  const plan = generated?.plan?.outcome?.cycleSeconds;
  if (typeof plan === 'number' && Number.isFinite(plan) && plan > 0) return plan;
  const cam = generated?.cam?.estimatedSeconds;
  if (typeof cam === 'number' && Number.isFinite(cam) && cam > 0) return cam;
  return null;
}

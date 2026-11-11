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
 *
 * #1193 — A FLIP'S PLAN OUTCOME IS ONE SIDE. Where the result carries the seam's own run total
 * (`runCycle`, over every posted program — all setups plus the locating program, with the changes
 * between them), THAT is the run's cycle; the plan outcome is one setup's plan and is only the
 * fallback now. The tradeoff line remains a PLAN comparison and says whose cycle it is.
 */

import type { RunCycle } from './runTotals';

/** The two shapes a result can state its cycle in — structural, so the store/tests can hand in either. */
export interface RunCycleSource {
  /** #1193 — the run's own total over every posted program, when the seam computed one. */
  runCycle?: RunCycle | null;
  /** The model plan's own outcome (`ModelPlanOutput.outcome`), when one was measured. */
  plan?: { outcome?: { cycleSeconds: number } | null } | null;
  /** The first posted program's summary — the fallback. */
  cam?: { estimatedSeconds: number } | null;
}

/**
 * The run's cycle estimate, seconds — the seam's run total when the result carries one, else the
 * PLAN outcome's number, else the first program's summary. Null when none states a positive number.
 */
export function runCycleSeconds(generated: RunCycleSource | null | undefined): number | null {
  const run = generated?.runCycle?.totalSeconds;
  if (typeof run === 'number' && Number.isFinite(run) && run > 0) return run;
  const plan = generated?.plan?.outcome?.cycleSeconds;
  if (typeof plan === 'number' && Number.isFinite(plan) && plan > 0) return plan;
  const cam = generated?.cam?.estimatedSeconds;
  if (typeof cam === 'number' && Number.isFinite(cam) && cam > 0) return cam;
  return null;
}

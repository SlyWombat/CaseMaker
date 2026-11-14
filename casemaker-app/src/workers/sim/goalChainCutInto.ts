/**
 * #1252 (review 3) — THE SEAM'S TWO GUARDS, pure and testable.
 *
 * The plan's `input.goal` is typed as `GoalCellField`, a structural SUBSET of the sampled
 * `GoalHeightfield` (it lacks `topZ`, `minZ` and `coveredCount`, which the goal check reads). The
 * adjudication seam in `engraveGenerate.ts` needs the full heightfield. Rather than assert it with a
 * bare cast, the seam asks {@link asGoalHeightfield}: the full field comes back typed, or `null`
 * (the check did not run) when any field the check needs is absent or not a finite number. And a
 * cell count that is not finite is not an answer either ({@link adjudicatedCellCount}): `NaN === 0`
 * is false, so a non-finite count would set every chain aside and print `NaN` on the sheet.
 */
import type { GoalHeightfield } from '@/engine/cnc/engrave/goalHeightfield';

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The goal as the full sampled heightfield the check reads, or `null` when it is not one. */
export function asGoalHeightfield(goal: unknown): GoalHeightfield | null {
  if (typeof goal !== 'object' || goal === null) return null;
  const g = goal as Partial<Record<keyof GoalHeightfield, unknown>>;
  if (!finite(g.nx) || !finite(g.ny) || !finite(g.x0) || !finite(g.y0) || !finite(g.pitch)) return null;
  if (!finite(g.topZ) || !finite(g.minZ) || !finite(g.coveredCount)) return null;
  if (g.nx <= 0 || g.ny <= 0 || g.pitch <= 0 || g.coveredCount < 0) return null;
  if (!(g.z instanceof Float32Array) || !(g.covered instanceof Uint8Array)) return null;
  if (g.z.length !== g.nx * g.ny || g.covered.length !== g.nx * g.ny) return null;
  return goal as GoalHeightfield;
}

/**
 * The check's adjudicated cell count from its fraction and the covered count, or `null` when
 * either is not finite (an answer that is not a number is "the check did not run").
 */
export function adjudicatedCellCount(adjudicatedFraction: number, coveredCount: number): number | null {
  if (!finite(adjudicatedFraction) || !finite(coveredCount)) return null;
  const cells = Math.round(adjudicatedFraction * coveredCount);
  return Number.isFinite(cells) ? cells : null;
}

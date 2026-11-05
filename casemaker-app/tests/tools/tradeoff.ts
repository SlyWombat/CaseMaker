/**
 * #961/#975 — THE OWNED-VERSUS-IDEAL TRADEOFF LINE (the maintainer's 2026-11-05 ruling, #975;
 * `docs/design/cam-model-engine.md` §4).
 *
 * The ruling: state the tradeoff between the owned plan and the ideal plan **only when it is
 * material**, in OUTCOME terms, never tool terms ("a ⌀0.6 flat would give vertical walls", not
 * "use the ⌀0.6 flat"). "Should not bug the user if the difference is minor."
 *
 * The materiality threshold below is the manager's proposal (#975, comment on the ruling) as ONE
 * named constant for the maintainer to correct: two plans are the same outcome when they pass and
 * fail the same seven lines AND differ by no more than the bounds here.
 *
 * The comparison reads the two SCORED cards — the same `scoreSevenLines` output the page prints,
 * so the line cannot disagree with the lines beside it. Geometry is the cut-into depth the card
 * states (the deepest cut below the goal); walls and floor are plan geometry the card does not
 * carry as a number yet, so they are named in the ruling and measured by the plan comparison view,
 * not by this line (stated limit, not a silent one).
 */

import type { ProgramScore, SevenLineCard } from './sevenLines';

/** The materiality bounds — one constant, the manager's proposal (#975), the maintainer may change. */
export const PLAN_MATERIALITY = {
  /** Walls, floor, cut-into, leftover, mm — the goal check's cell tolerance. */
  geometryMm: 0.1,
  /** Coverage, percentage points. */
  coveragePoints: 0.5,
  /** Cycle, fraction of the slower plan (0.1 = 10 %). */
  cycleFraction: 0.1,
} as const;

export type TradeoffBound = keyof typeof PLAN_MATERIALITY;

export interface TradeoffDifference {
  bound: TradeoffBound | 'verdicts';
  /** What the operator would see, in outcome words. */
  reading: string;
  /** The owned plan's number, the ideal's, and the difference (absolute for geometry/coverage,
   *  the fraction of the slower plan for cycle); null for the verdicts row. */
  owned: number | null;
  ideal: number | null;
  amount: number | null;
  /** TRUE when this row alone makes the difference material. */
  material: boolean;
}

export interface PlanTradeoff {
  material: boolean;
  /**
   * ONE line naming the outcome that differs and by how much, or null when the difference is
   * minor. Never names a cutter (that is the ideal's own description elsewhere).
   */
  line: string | null;
  differences: TradeoffDifference[];
}

const pctPoints = (v: number): string => `${(v * 100).toFixed(2)} points`;

/**
 * Compare the OWNED plan's card with the IDEAL plan's for the same job.
 *
 * @param owned the scored card whose lines the page prints (the owned plan)
 * @param ideal the scored card of the ideal plan — its `vendor` is irrelevant here; only the two
 *              sides' own numbers and the seven-line verdicts are compared
 */
export function comparePlanOutcomes(
  owned: { score: ProgramScore; card: SevenLineCard },
  ideal: { score: ProgramScore; card: SevenLineCard },
  threshold: { geometryMm: number; coveragePoints: number; cycleFraction: number } = PLAN_MATERIALITY,
): PlanTradeoff {
  const differences: TradeoffDifference[] = [];

  // 1. The seven lines' verdicts: any line the two plans pass and fail differently is material,
  // whatever the numbers say — the operator is choosing between two outcomes, not two prices.
  const verdict = owned.card.lines
    .map((line) => {
      const other = ideal.card.lines.find((l) => l.key === line.key);
      return other === undefined || other.state === line.state ? null : `${line.key}: ${line.state} vs ${other.state}`;
    })
    .filter((s): s is string => s !== null);
  differences.push({
    bound: 'verdicts',
    reading: verdict.length === 0 ? 'the same verdict on every line' : verdict.join('; '),
    owned: null,
    ideal: null,
    amount: null,
    material: verdict.length > 0,
  });

  // 2. Geometry: the deepest cut below the goal the card states, mm.
  const ownedDepth = owned.score.cutInto.maxMm;
  const idealDepth = ideal.score.cutInto.maxMm;
  const depthDiff = Math.abs(ownedDepth - idealDepth);
  differences.push({
    bound: 'geometryMm',
    reading: `deepest cut ${ownedDepth.toFixed(2)} mm vs ${idealDepth.toFixed(2)} mm`,
    owned: ownedDepth,
    ideal: idealDepth,
    amount: depthDiff,
    material: depthDiff > threshold.geometryMm + 1e-9,
  });

  // 3. Coverage, percentage points.
  const ownedCov = owned.score.coverage;
  const idealCov = ideal.score.coverage;
  if (ownedCov !== null && idealCov !== null) {
    const covDiff = Math.abs(ownedCov - idealCov) * 100;
    differences.push({
      bound: 'coveragePoints',
      reading: `coverage ${pctPoints(ownedCov)} vs ${pctPoints(idealCov)}`,
      owned: ownedCov,
      ideal: idealCov,
      amount: covDiff,
      material: covDiff > threshold.coveragePoints + 1e-9,
    });
  }

  // 4. Cycle, a fraction of the slower plan.
  const slower = Math.max(owned.score.cycleSeconds, ideal.score.cycleSeconds);
  const cycleDiff = slower > 0 ? Math.abs(owned.score.cycleSeconds - ideal.score.cycleSeconds) / slower : 0;
  differences.push({
    bound: 'cycleFraction',
    reading: `cycle ${(owned.score.cycleSeconds / 60).toFixed(1)} min vs ${(ideal.score.cycleSeconds / 60).toFixed(1)} min`,
    owned: owned.score.cycleSeconds,
    ideal: ideal.score.cycleSeconds,
    amount: cycleDiff,
    material: cycleDiff > threshold.cycleFraction + 1e-9,
  });

  const materialRows = differences.filter((d) => d.material);
  const line =
    materialRows.length === 0
      ? null
      : `the ideal plan would change the outcome: ${materialRows.map((d) => d.reading).join('; ')}`;
  return { material: materialRows.length > 0, line, differences };
}

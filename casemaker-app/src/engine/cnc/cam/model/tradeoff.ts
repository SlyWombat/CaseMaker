/**
 * #961/#975 — THE OWNED-VERSUS-IDEAL TRADEOFF LINE (the maintainer's 2026-11-05 ruling, #975;
 * `docs/design/cam-model-engine.md` §4).
 *
 * The ruling: state the tradeoff between the owned plan and the ideal plan **only when it is
 * material**, in OUTCOME terms, never tool terms ("a ⌀0.6 flat would give vertical walls", not
 * "use the ⌀0.6 flat"). "Should not bug the user if the difference is minor."
 *
 * This module lives in `src` because the APP needs it (the job card prints the line and offers the
 * choice); until #961's wiring it lived only in `tests/tools/tradeoff.ts`, which now re-exports it
 * so the acceptance cards and the app read one definition. Its inputs are the two SCORED sides —
 * the same card `scoreSevenLines` prints — so the line cannot disagree with the lines beside it.
 * The types here are structural on purpose: the app carries its own outcome shape and the tests
 * carry `ProgramScore`/`SevenLineCard`, and both satisfy these without either importing the other.
 *
 * Geometry is the cut-into depth the card states (the deepest cut below the goal); walls and floor
 * are plan geometry the card does not carry as a number yet, so they are named in the ruling and
 * measured by the plan comparison view, not by this line (stated limit, not a silent one).
 */

/** The outcome readings the comparison needs — the shape a scored plan's numbers have. */
export interface PlanOutcomeScore {
  /** The whole-surface coverage, 0..1 (null when the run did not measure it). */
  coverage: number | null;
  cutInto: {
    /** The judged cut-into share, 0..1 (null when the checker did not adjudicate). */
    adjudicatedFraction: number | null;
    /** The deepest cut below the goal, mm — the RAW figure; NULL when the caller did not judge
     *  cut-into. Advisory: the superset gate gates on {@link adjudicatedMaxMm} below. */
    maxMm: number | null;
    /**
     * #1092 (0f's ruling, 2026-11-09) — the deepest cut among the ADJUDICATED cells, mm. The
     * deepest-cut row compares THIS: the raw maximum includes cells the goal check excludes by
     * proof (a wall cell, the wall shadow, an edge break), where a difference is a reading
     * artefact, not a worse plan. Null/absent when the source cannot adjudicate (a page-JSON
     * card) — the row then falls back to `maxMm` and states the raw reading.
     */
    adjudicatedMaxMm?: number | null;
    /**
     * #1092 — the class the RAW deepest cell was excused as, when the checker excluded it. The
     * raw pair is printed beside the judged pair with this class, never gated.
     */
    rawMaxExclusion?: string | null;
    /** #1092 — where the raw deepest cell is, when the source carries a coordinate. */
    maxAt?: { x: number; y: number } | null;
  };
  /** The plan's own cycle estimate, seconds. */
  cycleSeconds: number;
  /**
   * #1062 (defect 1) — the plan's PREDICTED lip bevel, mm (`depth × tan(half)` per side on a
   * floor-correct V pocket), when the plan carries one. A prediction, not the gate's measurement:
   * `cutInto` above stays null by contract, and no materiality row is built from this (the
   * statement in the plan's notes is what the operator reads).
   */
  predictedCutIntoMm?: number | null;
}

/** One seven-line verdict, as the card prints it. */
export interface PlanVerdictLine {
  key: string;
  state: string;
}

/** The verdict half of a scored side. */
export interface PlanVerdicts {
  lines: readonly PlanVerdictLine[];
}

/** One side of the comparison: the plan's numbers and its card's verdicts. */
export interface PlanTradeoffSide {
  score: PlanOutcomeScore;
  /**
   * The scored card's verdicts. OPTIONAL because the app's generation path has the plans'
   * measured OUTCOMES but not a seven-line scoring (that card is the acceptance's); absent, the
   * verdicts row is stated as not judged — never silently treated as "the same verdict".
   */
  card?: PlanVerdicts;
}

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

/**
 * #1089 — THE COMPARISON, AS PAPER AND THE RECEIPT STATE IT. One shape built from the one tradeoff
 * function, so the card, the run sheet and the CLI receipt cannot drift: the material line (with
 * both cycle estimates), the minor case (numbers, no line), and the two stated gaps — a deferred
 * comparison (the CLI's --defer-ideal) and one still running (the app's late ideal).
 */
export type PlanComparisonStatement =
  | { kind: 'material'; line: string; ownedSeconds: number; idealSeconds: number }
  | { kind: 'minor'; ownedSeconds: number; idealSeconds: number }
  | { kind: 'deferred' }
  | { kind: 'comparing' };

/**
 * #1089 — Map a computed tradeoff to the statement, or null when it carries no cycle row (a
 * comparison whose sources were never measured, which nothing may print numbers for).
 */
export function planComparisonStatement(tradeoff: PlanTradeoff): PlanComparisonStatement | null {
  const cycle = tradeoff.differences.find((d) => d.bound === 'cycleFraction');
  if (cycle === undefined || cycle.owned === null || cycle.ideal === null) return null;
  return tradeoff.material && tradeoff.line !== null
    ? { kind: 'material', line: tradeoff.line, ownedSeconds: cycle.owned, idealSeconds: cycle.ideal }
    : { kind: 'minor', ownedSeconds: cycle.owned, idealSeconds: cycle.ideal };
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

/**
 * Compare the OWNED plan's card with the IDEAL plan's for the same job.
 *
 * @param owned the scored card whose lines the page prints (the owned plan)
 * @param ideal the scored card of the ideal plan — its `vendor` is irrelevant here; only the two
 *              sides' own numbers and the seven-line verdicts are compared
 */
export function comparePlanOutcomes(
  owned: PlanTradeoffSide,
  ideal: PlanTradeoffSide,
  threshold: { geometryMm: number; coveragePoints: number; cycleFraction: number } = PLAN_MATERIALITY,
): PlanTradeoff {
  const differences: TradeoffDifference[] = [];

  // 1. The seven lines' verdicts: any line the two plans pass and fail differently is material,
  // whatever the numbers say — the operator is choosing between two outcomes, not two prices.
  if (owned.card === undefined || ideal.card === undefined) {
    differences.push({
      bound: 'verdicts',
      reading: 'the seven lines were not scored for this comparison',
      owned: null,
      ideal: null,
      amount: null,
      material: false,
    });
  } else {
    const ownedLines = owned.card.lines;
    const idealLines = ideal.card.lines;
    const verdict = ownedLines
      .map((line) => {
        const other = idealLines.find((l) => l.key === line.key);
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
  }

  // 1b. #1062 (defect 1, 6b's addition) — THE PREDICTED LIP BEVEL. A floor-correct V pocket's
  // flank bevels the design's top face by depth·tan(half); when the two plans differ there by the
  // geometry bound, the operator is choosing between two outcomes — a bevelled lip and a square
  // one — so it gets its own row. It is a PREDICTION, and the row says so: the gate's measured
  // cut-into is its own number and never stands in for this.
  const ownedBevel = owned.score.predictedCutIntoMm ?? 0;
  const idealBevel = ideal.score.predictedCutIntoMm ?? 0;
  const bevelDiff = Math.abs(ownedBevel - idealBevel);
  if (bevelDiff >= threshold.geometryMm - 1e-9) {
    const words = (v: number): string => (v > 0 ? `bevelled ${v.toFixed(2)} mm (V floor)` : 'square');
    differences.push({
      bound: 'geometryMm',
      reading: `lips: ${words(ownedBevel)} · ${words(idealBevel)} (prediction)`,
      owned: ownedBevel,
      ideal: idealBevel,
      amount: bevelDiff,
      material: true,
    });
  }

  // 2. Geometry: the deepest cut below the goal the card states, mm. A side that did not judge
  // cut-into states that row as not judged — never a different quantity under the same name (the
  // planner measures leftover ABOVE the goal, which is the opposite direction).
  const ownedDepth = owned.score.cutInto.maxMm;
  const idealDepth = ideal.score.cutInto.maxMm;
  if (ownedDepth === null || idealDepth === null) {
    differences.push({
      bound: 'geometryMm',
      reading: 'deepest cut-into not judged for this comparison',
      owned: ownedDepth,
      ideal: idealDepth,
      amount: null,
      material: false,
    });
  } else {
    const depthDiff = Math.abs(ownedDepth - idealDepth);
    differences.push({
      bound: 'geometryMm',
      reading: `deepest cut ${ownedDepth.toFixed(2)} → ${idealDepth.toFixed(2)} mm`,
      owned: ownedDepth,
      ideal: idealDepth,
      amount: depthDiff,
      material: depthDiff > threshold.geometryMm + 1e-9,
    });
  }

  // 3. Coverage, percentage points.
  const ownedCov = owned.score.coverage;
  const idealCov = ideal.score.coverage;
  if (ownedCov !== null && idealCov !== null) {
    const covDiff = Math.abs(ownedCov - idealCov) * 100;
    differences.push({
      bound: 'coveragePoints',
      reading: `coverage ${(ownedCov * 100).toFixed(2)} → ${(idealCov * 100).toFixed(2)} %`,
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
    reading: `cycle ${(owned.score.cycleSeconds / 60).toFixed(1)} → ${(ideal.score.cycleSeconds / 60).toFixed(1)} min`,
    owned: owned.score.cycleSeconds,
    ideal: ideal.score.cycleSeconds,
    amount: cycleDiff,
    material: cycleDiff > threshold.cycleFraction + 1e-9,
  });

  const materialRows = differences.filter((d) => d.material);
  const line =
    materialRows.length === 0
      ? null
      : `owned plan vs catalogue ideal: ${materialRows.map((d) => d.reading).join('; ')}`;
  return { material: materialRows.length > 0, line, differences };
}

/**
 * #975 (the manager's ruling, 2026-11-05) — THE SUPERSET RULE, RESTATED.
 *
 * The ideal plan's candidate set contains the owned set, but the selector ranks candidates by
 * COST among plans whose outcomes do not differ materially: adding a bit can change the sequence
 * and move an outcome slightly either way. The invariant the acceptance can hold is therefore the
 * MATERIAL one — the ideal may never be worse than the owned plan by more than `PLAN_MATERIALITY`
 * allows. Inside those bounds the two plans are the same outcome for the operator, which is
 * exactly why the tradeoff line above stays silent about them.
 *
 * Directional on purpose: `comparePlanOutcomes` asks whether the two plans differ materially AT
 * ALL; this asks whether the ideal came off WORSE. The shares (coverage, and the adjudicated
 * cut-into share — both shares of the surface) are bounded in points by `coveragePoints`; the
 * deepest cut is geometry and is bounded in millimetres by `geometryMm`. An outcome either side
 * did not judge (null) is skipped, never assumed clean.
 *
 * CYCLE IS DELIBERATELY NOT BOUNDED HERE (D's review, #961): cost is the selector's own axis, a
 * slower ideal is not a defect in the part, and `comparePlanOutcomes` above still prints a
 * material cycle difference through its `cycleFraction` row.
 */
export interface OutcomeWorsening {
  outcome: 'coverage' | 'cutIntoShare' | 'deepestCut';
  /** The materiality constant that bounds this outcome. */
  bound: TradeoffBound;
  owned: number;
  ideal: number;
  /** How much WORSE the ideal is, in the bound's own units (points, or mm); negative = better. */
  worseBy: number;
  /** TRUE when this row alone makes the ideal materially worse. */
  material: boolean;
  reading: string;
}

/** #1092 — a compact millimetre reading: `0`, `3`, `10.8`, `0.42` — never `0.00` for a zero. */
function mmText(mm: number): string {
  return String(Number(mm.toFixed(2)));
}

/** The goal check's exclusion classes, as the row names them when it prints the excused raw pair. */
const EXCUSE_WORDS: Record<string, string> = {
  wall: ' at a wall cell',
  border: ' at a border cell',
  shadow: ' at a wall-shadow cell',
  silhouette: ' at a silhouette cell',
  edgeBreak: ' at an edge-break cell',
  straddling: ' at a straddling cell',
};

/** WHERE the raw maximum sits: the class the checker excused it as, else its coordinate, else nothing. */
function excusedAt(cut: PlanOutcomeScore['cutInto']): string {
  const cls = cut.rawMaxExclusion;
  const words = cls === undefined || cls === null ? undefined : EXCUSE_WORDS[cls];
  if (words !== undefined) return words;
  const at = cut.maxAt;
  return at !== undefined && at !== null ? ` at ${mmText(at.x)}, ${mmText(at.y)}` : '';
}

export function idealWorsenings(
  owned: PlanOutcomeScore,
  ideal: PlanOutcomeScore,
  threshold: { geometryMm: number; coveragePoints: number } = PLAN_MATERIALITY,
): OutcomeWorsening[] {
  const rows: OutcomeWorsening[] = [];
  const pts = (v: number): string => `${v.toFixed(2)} points`;

  if (owned.coverage !== null && ideal.coverage !== null) {
    const worseBy = (owned.coverage - ideal.coverage) * 100;
    rows.push({
      outcome: 'coverage',
      bound: 'coveragePoints',
      owned: owned.coverage,
      ideal: ideal.coverage,
      worseBy,
      material: worseBy > threshold.coveragePoints + 1e-9,
      reading: `coverage ${pts(-worseBy)}`,
    });
  }

  const ownedShare = owned.cutInto.adjudicatedFraction;
  const idealShare = ideal.cutInto.adjudicatedFraction;
  if (ownedShare !== null && idealShare !== null) {
    const worseBy = (idealShare - ownedShare) * 100;
    rows.push({
      outcome: 'cutIntoShare',
      bound: 'coveragePoints',
      owned: ownedShare,
      ideal: idealShare,
      worseBy,
      material: worseBy > threshold.coveragePoints + 1e-9,
      reading: `cut-into share ${pts(worseBy)}`,
    });
  }

  // #1092 (0f's ruling, 2026-11-09) — THE DEEPEST-CUT ROW IS GATED ON THE ADJUDICATED MAXIMUM.
  // The raw maximum includes cells the goal check excludes by proof (a wall cell, the wall shadow,
  // an edge break, a straddling cell): a raw difference there is a reading artefact, not a worse
  // plan, and it must not decide the superset gate. The raw pair is still PRINTED beside the judged
  // pair, with the class the excluded cell was excused as, and is never gated. A side that cannot
  // adjudicate (a page-JSON card, no `adjudicatedMaxMm`) keeps the raw reading it always had.
  const ownedAdjMm = owned.cutInto.adjudicatedMaxMm;
  const idealAdjMm = ideal.cutInto.adjudicatedMaxMm;
  const ownedDepthMm = owned.cutInto.maxMm;
  const idealDepthMm = ideal.cutInto.maxMm;
  if (ownedAdjMm !== undefined && ownedAdjMm !== null && idealAdjMm !== undefined && idealAdjMm !== null) {
    const worseBy = idealAdjMm - ownedAdjMm;
    const materialByAdjudicated = worseBy > threshold.geometryMm + 1e-9;
    // The raw pair earns its parenthetical only when it reads WORSE than the judged pair — i.e.
    // exactly when the old (raw) rule would have failed the ideal on an excluded cell.
    const rawWorse = ownedDepthMm !== null && idealDepthMm !== null
      && idealDepthMm - ownedDepthMm > threshold.geometryMm + 1e-9
      && !materialByAdjudicated;
    const rawNote = rawWorse
      ? ` (raw ${mmText(ownedDepthMm!)} → ${mmText(idealDepthMm!)} mm${excusedAt(ideal.cutInto)}, excused)`
      : '';
    rows.push({
      outcome: 'deepestCut',
      bound: 'geometryMm',
      owned: ownedAdjMm,
      ideal: idealAdjMm,
      worseBy,
      material: materialByAdjudicated,
      reading: `ideal deepest adjudicated cut ${mmText(ownedAdjMm)} → ${mmText(idealAdjMm)} mm${rawNote}`,
    });
  } else if (ownedDepthMm !== null && idealDepthMm !== null) {
    const worseBy = idealDepthMm - ownedDepthMm;
    rows.push({
      outcome: 'deepestCut',
      bound: 'geometryMm',
      owned: ownedDepthMm,
      ideal: idealDepthMm,
      worseBy,
      material: worseBy > threshold.geometryMm + 1e-9,
      reading: `deepest cut ${worseBy.toFixed(2)} mm`,
    });
  }

  return rows;
}

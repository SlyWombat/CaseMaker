/**
 * #963 — THE GOAL CHECK IN THE OPERATOR'S WORDS, in ONE place. The Cut card prints these lines
 * beside its tick and the run sheet's check section prints the same ones, so the screen and the
 * paper cannot disagree about what the sweep found. The judged line names the cell the pass
 * JUDGED (#964); the raw reading prints BESIDE it and never as the pass.
 */
import type { GoalCutIntoReport } from '@/engine/cnc/engrave/designCheck';

/** mm, up to three decimals with trailing zeros dropped — the page's own depth format. */
export const goalMm = (n: number): string => String(Number(n.toFixed(3)));

/** The page's percentage rounding: two decimals, trailing zeros dropped. */
export const goalPct = (fraction: number): number => Math.round(fraction * 10000) / 100;

/**
 * The MEASURED top-surface coverage, in per cent — the page checker's own arithmetic on the
 * report's `leftoverFractions[0]` (`round(100 − round(100 × leftover > 0.1 mm, 2), 2)`), or null
 * when the report carries no leftover band. `passCoverage` is NOT this number: it is the shop's
 * pass line the check judged against.
 */
export function goalCoveragePct(report: GoalCutIntoReport): number | null {
  const leftover = report.leftoverFractions[0];
  if (leftover === undefined) return null;
  return Math.round((100 - goalPct(leftover)) * 100) / 100;
}

/**
 * THE JUDGED LINE: a pass, the worst ADJUDICATED cut-into cell (where it is, too), the coverage
 * failing, or the check saying it did not run — never a silent pass. `state` is the card's mark;
 * the sheet prints `text` alone.
 */
export function goalVerdictWords(report: GoalCutIntoReport): {
  text: string;
  state: 'match' | 'cut-into' | 'coverage' | 'not-checked';
} {
  if (!report.ran) {
    return {
      text: `Goal not checked: ${report.reason ?? 'the check did not run for this program'}`,
      state: 'not-checked',
    };
  }
  if (report.ok) return { text: 'Matches the design (goal)', state: 'match' };
  // #948 — `ok` false with NO adjudicated cut-into cells is the pass line's coverage failing, not
  // a cut into the part: the cut-into branch would name a 0 mm cut that never happened.
  if (report.adjudicatedMaxMm === 0) {
    const coveragePct = goalCoveragePct(report);
    return {
      text:
        coveragePct === null
          ? report.sentence
          : `Covers ${coveragePct} % of the design’s top surface (the pass line is ${goalPct(report.passCoverage)} %)`,
      state: 'coverage',
    };
  }
  const at = report.adjudicatedMaxAt;
  return {
    text:
      at === null
        ? `Cuts ${goalMm(report.adjudicatedMaxMm)} mm into the design`
        : `Cuts ${goalMm(report.adjudicatedMaxMm)} mm into the design at ${goalMm(at.x)}, ${goalMm(at.y)}`,
    state: 'cut-into',
  };
}

/**
 * #964 — THE RAW READING, printed BESIDE the adjudicated one and never as the pass: every cell
 * the sweep left below the goal before the wall, wall-shadow (and, when the job states one,
 * edge-break) exclusions. Null when the comparison did not run (there is no raw reading to state).
 */
export function goalRawWords(report: GoalCutIntoReport): string | null {
  if (!report.ran) return null;
  const pct = Number((report.cutIntoFraction * 100).toFixed(2));
  const at = report.maxCutIntoAt;
  const where = at === null ? '' : ` at ${goalMm(at.x)}, ${goalMm(at.y)}`;
  return `raw, before exclusions: ${pct} % cut-into, max ${goalMm(report.maxCutIntoMm)} mm${where}`;
}

/** The top-surface coverage beside the raw line, with the pass line it was judged against. */
export function goalCoverageWords(report: GoalCutIntoReport): string | null {
  const coveragePct = goalCoveragePct(report);
  if (coveragePct === null) return null;
  return `Top-surface coverage: ${coveragePct} % (the pass line is ${goalPct(report.passCoverage)} %)`;
}

/**
 * THE WHOLE-SURFACE REACH, when the run states it — the app's own `goal-unreached` share (the
 * surface the setups reproduce, under-faces and undercuts included), in the demo page's card words.
 * Null when no finding carries the number, so a job with nothing to state prints nothing.
 */
export function goalReachWords(reachedFraction: number | undefined): string | null {
  if (reachedFraction === undefined) return null;
  const pct = Math.round(reachedFraction * 1000) / 10;
  return `Whole-surface reach: ${pct} % from this setup (the remainder: under-faces and undercuts)`;
}

/**
 * #1242 (planner v3, step C3) — THE SHORTLIST: which chains get a real plan.
 *
 * The selector no longer plans every candidate chain for real. Each candidate first gets the
 * shadow's cheap estimate (estimated leftover in mm², estimated seconds, and how many of its steps
 * the estimate could not price); the K best by that estimate's own order are planned for real and
 * ranked exactly as before. A chain the estimate could not price is kept whatever K is, because
 * the estimate has no opinion on it. `k <= 0` keeps every chain — the setting off, and today's
 * behaviour.
 *
 * This file is pure and has no imports: `sequence.ts` must not reach into `cam/fields/`, so the
 * caller (`plan.ts`) supplies the estimate map and the shortlist travels in as a plain function.
 */

/** What the shortlist needs from one candidate's estimate. */
export interface ShortlistEstimate {
  /** Estimated material left above the band, mm². */
  leftoverMm2: number;
  /** Estimated cutting and bit-change seconds. */
  totalSeconds: number;
  /** Steps the estimate could not price: above 0 the estimate has no opinion on the chain. */
  unpriced: number;
}

/**
 * #1242 — THE PLAN'S NOTE when the shortlist dropped anything: one sentence naming how many chains
 * were worked out in full of how many considered. A note (the plan's own prose), never a sheet
 * line. Null when nothing was dropped: a full plan has nothing to explain.
 */
export function shortlistNote(counts: { candidates: number; kept: number }): string | null {
  if (counts.kept >= counts.candidates) return null;
  return (
    `The planner worked out ${counts.kept} of ${counts.candidates} possible sets of cutters ` +
    'in full, the most promising by estimate (a shop setting).'
  );
}

/** The estimate's order of two estimates: leftover to a hundredth of a mm², then seconds. */
function compareEstimates(a: ShortlistEstimate, b: ShortlistEstimate): number {
  const roundedA = Math.round(a.leftoverMm2 * 100);
  const roundedB = Math.round(b.leftoverMm2 * 100);
  if (roundedA !== roundedB) return roundedA - roundedB;
  if (a.totalSeconds !== b.totalSeconds) return a.totalSeconds - b.totalSeconds;
  return 0;
}

/**
 * The candidates that get a real plan: the first `k` by the estimate's order, plus every unpriced
 * one. k <= 0 keeps all. Order of the result = order of the input.
 */
export function shortlistOf<T extends { signature: string }>(
  candidates: readonly T[],
  estimates: ReadonlyMap<string, ShortlistEstimate>,
  k: number,
): T[] {
  if (!(k > 0) || candidates.length <= k) return [...candidates];
  const priced = candidates.filter((candidate) => {
    const estimate = estimates.get(candidate.signature);
    return estimate !== undefined && estimate.unpriced === 0;
  });
  const kept = new Set(
    priced
      .slice()
      .sort((a, b) => {
        const order = compareEstimates(estimates.get(a.signature)!, estimates.get(b.signature)!);
        if (order !== 0) return order;
        return a.signature < b.signature ? -1 : a.signature > b.signature ? 1 : 0;
      })
      .slice(0, k)
      .map((candidate) => candidate.signature),
  );
  return candidates.filter((candidate) => {
    const estimate = estimates.get(candidate.signature);
    return estimate === undefined || estimate.unpriced > 0 || kept.has(candidate.signature);
  });
}

/**
 * #1254 — THE EDGE-OPENNESS FACTS, AS PLAIN DATA ON THE PLANNER'S INPUT.
 *
 * #1234 stage 2 put a FUNCTION (`stockEdgeOpen`) on `ModelPlanInput`; the planner's input goes to
 * rank-pool workers by structured clone, and a function cannot be cloned, so the app's
 * `--defer-ideal --parallel-rank` route refused before planning. The input carries facts, never
 * functions: the mount's boxes (XY extents and tops), the fit uncertainty, the clearance and the
 * job blank's dims — and the planner evaluates the rule itself from them.
 *
 * The rule is #1234's own, unchanged: a side is open only when no box overlapping that side's
 * overrun strip rises above the cutter's lowest clearance there.
 */
import type { StockSide } from './ops/edgeOverrun';

/** One mount box's XY extent and top, work frame. */
export interface OpenEdgeBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  topZ: number;
}

/** The raw facts the openness predicate reads. */
export interface OpenEdgeFacts {
  boxes: readonly OpenEdgeBox[];
  uncertaintyMm: number;
  clearanceMm: number;
  /** The JOB blank's dims — the mount's boxes surround the blank, not a stated setup box. */
  stockLengthMm: number;
  stockWidthMm: number;
}

/**
 * #1234's rule, evaluated from the facts — the SAME predicate the generator's closure ran before
 * #1254: a side is open only when no box overlapping the side's overrun strip (band = radius +
 * uncertainty + clearance) rises above `lowestTipZ − radius − clearance`.
 */
export function evaluateOpenEdge(facts: OpenEdgeFacts, side: StockSide, lowestTipZ: number, radiusMm: number): boolean {
  const band = radiusMm + facts.uncertaintyMm + facts.clearanceMm;
  const length = facts.stockLengthMm;
  const width = facts.stockWidthMm;
  const strip = side === 'left'
    ? { minX: -band, maxX: 0, minY: -band, maxY: width + band }
    : side === 'right'
      ? { minX: length, maxX: length + band, minY: -band, maxY: width + band }
      : side === 'front'
        ? { minX: -band, maxX: length + band, minY: -band, maxY: 0 }
        : { minX: -band, maxX: length + band, minY: width, maxY: width + band };
  const lowestSolidZ = lowestTipZ - radiusMm - facts.clearanceMm;
  for (const box of facts.boxes) {
    const overlapX = Math.min(strip.maxX, box.maxX) - Math.max(strip.minX, box.minX);
    const overlapY = Math.min(strip.maxY, box.maxY) - Math.max(strip.minY, box.minY);
    if (overlapX <= 0 || overlapY <= 0) continue;
    // "above" is the ordinary Z order: a top at −15.95 is NOT above −11.6.
    if (box.topZ + facts.uncertaintyMm > lowestSolidZ) return false;
  }
  return true;
}

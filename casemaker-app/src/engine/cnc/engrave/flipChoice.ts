/**
 * #1073 — THE FLIP CHOICE, DERIVED WHERE IT IS PRINTED.
 *
 * The document stores exactly what the operator chose — `setups[i].flip = { method, axis }` — and
 * what the blank is: `stock.squareCorners`. Everything else about the flip follows from those two
 * records and is computed here, never stored. 6b's ruling: a stored derived boolean is wrong the
 * day the stock record changes.
 *
 * THE FENCED CORNER. In the seated (side-1) work frame the corners are FL (0,0), FR (W,0),
 * BL (0,H), BR (W,H), and the fence is the corner at (0,0). A flip is a 180° turn about a
 * horizontal axis, so side 2's fence corner is whichever side-1 corner that turn carries to (0,0):
 *
 *   - left↔right (x → W − x, z → −z, the bracket's own RY180): side 1's FR lands there;
 *   - front↔back (y → H − y, z → −z, RX180): side 1's BL lands there.
 *
 * The corner is a function of the AXIS alone — the method decides how the part is freed, not how
 * the blank turns — and it is never FL, because no 180° turn about a horizontal axis fixes a
 * corner.
 *
 * WHETHER IT IS SQUARE. The blank states its square corners in the Holding step, in this same
 * seated frame; absent states all four square (a dimensioned blank). The fenced corner on side 2
 * is square iff the side-1 corner that lands there is one of them — so a blank with one right
 * angle seated in side 1's fence reads `squareInFence: false` under EITHER axis (A's §2), and the
 * graphic, the sheet and the vendor method's refusal all say so from this one answer.
 */

import type { SetupFlip, StockCorner } from '@/types/engraveJob';

/** The blank's stated square corners in the seated work frame; `undefined` reads all four. */
export type StatedSquareCorners = readonly StockCorner[] | undefined;

/** Canonical order — the corners are printed and read in one order. */
export const STOCK_CORNERS: readonly StockCorner[] = ['FL', 'FR', 'BL', 'BR'];

/** The corners the blank states as square: the stated set, deduped and canonically ordered, or all
 *  four when the stock states none. Always a fresh array. */
export function squareCornersOf(stated: StatedSquareCorners): StockCorner[] {
  if (stated === undefined) return [...STOCK_CORNERS];
  const set = new Set(stated);
  return STOCK_CORNERS.filter((c) => set.has(c));
}

/** The side-1 corner of the seated blank that ends in the fence on side 2, from the flip axis. */
export function fenceCornerFor(axis: SetupFlip['axis']): StockCorner {
  return axis === 'left-right' ? 'FR' : 'BL';
}

export interface FlipFenceFacts {
  /** The side-1 corner of the seated blank that ends in the fence on side 2. */
  fenceCorner: StockCorner;
  /** Whether `fenceCorner` is one of the blank's square corners. */
  squareInFence: boolean;
  /** Every square corner of the blank, canonical order (all four when the stock states none). */
  squareCorners: StockCorner[];
}

/**
 * The flip's fence facts, from the stock's stated square corners and the chosen axis. Pure and
 * total: it answers for any stock record, including one that states nothing (all four square) or
 * an empty list (no square corner).
 */
export function flipFenceFacts(
  stock: { squareCorners?: readonly StockCorner[] },
  flip: Pick<SetupFlip, 'axis'>,
): FlipFenceFacts {
  const squareCorners = squareCornersOf(stock.squareCorners);
  const fenceCorner = fenceCornerFor(flip.axis);
  return { fenceCorner, squareInFence: squareCorners.includes(fenceCorner), squareCorners };
}

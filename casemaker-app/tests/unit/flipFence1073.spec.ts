/**
 * #1073 — THE FENCED CORNER AND WHETHER IT IS SQUARE, DERIVED.
 *
 * The document stores what the operator chose (`setups[i].flip = { method, axis }`) and what the
 * blank is (`stock.squareCorners`). These facts follow from those records and are computed here —
 * never stored (6b's ruling: a stored derived boolean is wrong the day the stock record changes).
 *
 * The seated (side-1) work frame: corners FL (0,0), FR (W,0), BL (0,H), BR (W,H); the fence is the
 * corner at (0,0). A 180° turn about a horizontal axis maps side 1's corners to side 2's:
 *   - left↔right (x → W − x): side 1's FR lands at side 2's (0,0) → FR is in the fence;
 *   - front↔back (y → H − y): side 1's BL lands at side 2's (0,0) → BL is in the fence.
 * Whether that corner is square is a read of the blank's stated corners (absent = all four).
 *
 * RED at m1-land8: no such derivation exists (`@/engine/cnc/engrave/flipChoice` does not resolve).
 */
import { describe, expect, it } from 'vitest';

import { fenceCornerFor, flipFenceFacts, squareCornersOf } from '@/engine/cnc/engrave/flipChoice';
import type { SetupFlip, StockCorner } from '@/types/engraveJob';

describe('#1073 the fenced corner follows from the axis', () => {
  it('left↔right puts side 1’s FR in the fence; front↔back puts its BL there', () => {
    expect(fenceCornerFor('left-right')).toBe('FR');
    expect(fenceCornerFor('front-back')).toBe('BL');
  });

  it('the method never moves the corner — only the axis does', () => {
    for (const axis of ['left-right', 'front-back'] as const) {
      const frame: SetupFlip = { method: 'tabs-in-blank', axis };
      const vendor: SetupFlip = { method: 'free-then-flip', axis };
      expect(flipFenceFacts({}, vendor)).toEqual(flipFenceFacts({}, frame));
    }
  });
});

describe('#1073 whether the fenced corner is square', () => {
  it('a blank that states no square corners reads all four (a dimensioned blank)', () => {
    expect(squareCornersOf(undefined)).toEqual(['FL', 'FR', 'BL', 'BR']);
    for (const axis of ['left-right', 'front-back'] as const) {
      expect(flipFenceFacts({}, { axis }).squareInFence).toBe(true);
    }
  });

  it('the maintainer’s one-right-angle blank: square corner seated at FL, neither flip puts a square edge in the fence', () => {
    const stock = { squareCorners: ['FL'] as const };
    expect(flipFenceFacts(stock, { axis: 'left-right' })).toEqual({
      fenceCorner: 'FR',
      squareInFence: false,
      squareCorners: ['FL'],
    });
    expect(flipFenceFacts(stock, { axis: 'front-back' }).squareInFence).toBe(false);
  });

  it('the corner that lands in the fence decides: FR says yes on left↔right, BL says yes on front↔back', () => {
    expect(flipFenceFacts({ squareCorners: ['FR'] }, { axis: 'left-right' }).squareInFence).toBe(true);
    expect(flipFenceFacts({ squareCorners: ['FR'] }, { axis: 'front-back' }).squareInFence).toBe(false);
    expect(flipFenceFacts({ squareCorners: ['BL'] }, { axis: 'front-back' }).squareInFence).toBe(true);
    expect(flipFenceFacts({ squareCorners: ['BL'] }, { axis: 'left-right' }).squareInFence).toBe(false);
  });

  it('an empty list states a blank with no square corner: not in the fence either', () => {
    for (const axis of ['left-right', 'front-back'] as const) {
      expect(flipFenceFacts({ squareCorners: [] }, { axis }).squareInFence).toBe(false);
    }
  });

  it('duplicates are read as the set they state, in the canonical corner order', () => {
    expect(squareCornersOf(['BR', 'FL', 'FL'])).toEqual(['FL', 'BR']);
    expect(squareCornersOf(['BR', 'FL'])).toEqual(['FL', 'BR']);
  });

  it('the list the caller passed is never mutated or shared', () => {
    const stated: StockCorner[] = ['FL'];
    const facts = flipFenceFacts({ squareCorners: stated }, { axis: 'left-right' });
    stated.push('FR');
    expect(facts.squareCorners).toEqual(['FL']);
    expect(facts.squareInFence).toBe(false);
  });
});

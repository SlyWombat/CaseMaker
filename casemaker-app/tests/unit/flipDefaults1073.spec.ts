/**
 * #1073 — THE DEFAULTS THE FLIP CHOICE OPENS ON, WITH THEIR REASONS (6b's amendment C).
 *
 * The offer pre-selects, it writes nothing: the operator's choice is what the setup stores. The
 * proposal is the frame method (it cuts the board less and holds any outline) and the axis under
 * which the most stated-square edges meet the bracket's two arms; a tie — and the maintainer's
 * one-right-angle blank ties — goes left↔right, keeping the front edge on the front arm.
 *
 * RED at m1-land8: no defaults exist; the offer's pre-selection would be a bare guess.
 */
import { describe, expect, it } from 'vitest';

import { defaultFlip } from '@/engine/cnc/engrave/flipDefaults';
import type { StockCorner } from '@/types/engraveJob';

const at = (squareCorners?: StockCorner[]) => (squareCorners === undefined ? defaultFlip({}) : defaultFlip({ squareCorners }));

describe('#1073 the flip defaults, with their reasons', () => {
  it('the method defaults to tabs-in-blank, and says why in one line', () => {
    const d = at();
    expect(d.method).toBe('tabs-in-blank');
    expect(d.methodReason).toBe('keep the part in the blank on tabs: it cuts the board less, and it holds any outline');
  });

  it('a dimensioned blank (all four square) ties, and the tie goes left↔right', () => {
    const d = at();
    expect(d.axis).toBe('left-right');
    expect(d.axisReason).toBe(
      'left↔right: neither flip puts more square edges on the arms (2 of 2 each), so the front edge stays on the front arm',
    );
  });

  it('the maintainer’s one-right-angle blank at FL ties too: neither axis puts a square edge on the arms', () => {
    const d = at(['FL']);
    expect(d.axis).toBe('left-right');
    expect(d.axisReason).toContain('(0 of 2 each)');
  });

  it('a square right edge favours left↔right; a square back edge favours front↔back', () => {
    const right = at(['FR', 'BR']);
    expect(right.axis).toBe('left-right');
    expect(right.axisReason).toBe('left↔right: it puts 1 of the blank’s square edges on the arms, where front↔back leaves 0');
    const back = at(['BL', 'BR']);
    expect(back.axis).toBe('front-back');
    expect(back.axisReason).toBe('front↔back: it puts 1 of the blank’s square edges on the arms, where left↔right leaves 0');
  });

  it('a blank with no stated square corner is the same tie, and every reason is one line', () => {
    const d = at([]);
    expect(d.axis).toBe('left-right');
    for (const d2 of [at(), at(['FL']), at(['FR', 'BR']), at(['BL', 'BR'])]) {
      expect(d2.methodReason).not.toContain('\n');
      expect(d2.axisReason).not.toContain('\n');
      expect(d2.methodReason.length).toBeGreaterThan(0);
      expect(d2.axisReason.length).toBeGreaterThan(0);
    }
  });
});

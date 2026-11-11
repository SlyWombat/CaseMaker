/**
 * #1214's ruling (b) — THE FEED WORD IS A PURE FUNCTION OF THE POSTED BYTES. A move takes the
 * plunge rate when its Z goes down ON THE POSTED GRID: both ends are rounded to the machine
 * dialect's printed precision (0.001 mm on the Z1) and the rounded values compared. The old rule
 * compared unrounded Zs against a 1e-9 noise floor, so a height change of a few nanometres flipped
 * the feed word and would flip it again on the next kernel change (the Set B hand-in's finding).
 *
 * The five cases are the ruling's acceptance list, verbatim.
 */
import { describe, expect, it } from 'vitest';
import { isPlunge, postedZ } from '@/engine/cnc/cam/printedZ';

describe('#1214 ruling (b) — the plunge test rounds to the printed precision', () => {
  it('−1.0000 → −1.0004 is a FEED: both post as −1.000', () => {
    expect(postedZ(-1.0004)).toBe(-1);
    expect(isPlunge(-1.0, -1.0004)).toBe(false);
  });

  it('−1.0004 → −1.0006 is a PLUNGE: they post as −1.000 then −1.001', () => {
    expect(postedZ(-1.0004)).toBe(-1);
    expect(postedZ(-1.0006)).toBe(-1.001);
    expect(isPlunge(-1.0004, -1.0006)).toBe(true);
  });

  it('−1.000 → −1.001 is a PLUNGE', () => {
    expect(isPlunge(-1.0, -1.001)).toBe(true);
  });

  it('−1.001 → −1.000 is a FEED (an ascent)', () => {
    expect(isPlunge(-1.001, -1.0)).toBe(false);
  });

  it('equal Zs are a FEED', () => {
    expect(isPlunge(-1.0, -1.0)).toBe(false);
  });
});

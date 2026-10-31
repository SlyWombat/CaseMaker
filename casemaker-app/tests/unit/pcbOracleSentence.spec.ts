/**
 * #743 P-5 — a board's oracle sentence is about its COPPER, not about an under/over-cut the board
 * never asked. The report's `copper` field replaces the volumetric numbers in the one sentence the
 * Cut confirm prints, so a short or a piece that is gone arrives in the operator's own words.
 */
import { describe, expect, it } from 'vitest';

import { oracleSentence } from '@/store/engraveRunGate';
import { combineCopperSides } from '@/engine/cnc/engrave/pcbTopology';
import type { OracleReport } from '@/engine/cnc/engrave/oracle';

const report = (copper: NonNullable<OracleReport['copper']>): OracleReport => ({
  ok: copper.ok,
  band: 0.02,
  levels: [],
  worst: { underCut: 0, overCut: 0 },
  copper,
});

describe('a board’s oracle sentence (#743 P-5)', () => {
  it('states the pieces, the pieces still there and the shorts — no under/over-cut', () => {
    const text = oracleSentence({
      oracle: report({ ok: true, designPieces: 2, pieces: 2, matched: 2, shorts: 0, bandLeftMm2: 0 }),
    });
    expect(text).toBe('The copper came out as designed: 2 pieces, 2 of 2 still there, no short.');
    expect(text).not.toContain('under-cut');
  });

  it('names a short and the copper left in the isolation when the board fails', () => {
    const text = oracleSentence({
      oracle: report({ ok: false, designPieces: 2, pieces: 1, matched: 2, shorts: 1, bandLeftMm2: 0.452 }),
    });
    expect(text).toContain('does not match the design');
    expect(text).toContain('1 piece');
    expect(text).toContain('1 short');
    expect(text).toContain('0.452 mm² of copper left in the isolation');
  });

  // #743 P-8 — a two-sided board is one verdict PER FACE, and the sentence names the face that
  // failed while still telling the operator what the other face did.
  it('states both faces when the board was cut on two, naming the one that failed', () => {
    const top = { face: 'top' as const, ok: true, designPieces: 2, pieces: 2, matched: 2, shorts: 0, bandLeftMm2: 0 };
    const bottom = { face: 'bottom' as const, ok: false, designPieces: 2, pieces: 1, matched: 2, shorts: 1, bandLeftMm2: 0.452 };
    const both = combineCopperSides([top, bottom]);
    expect(both.ok).toBe(false);
    expect(both.designPieces).toBe(4);
    const text = oracleSentence({ oracle: { ...report(both), ok: false, copper: both } });
    expect(text).toContain('does not match the design on the bottom face');
    expect(text).toContain('the top face: 2 pieces, 2 of 2 still there, no short');
    expect(text).toContain('the bottom face: 1 piece, 2 of 2 still there, 1 short, 0.452 mm² of copper left in the isolation');
  });

  it('says both faces came out as designed when both did', () => {
    const top = { face: 'top' as const, ok: true, designPieces: 2, pieces: 2, matched: 2, shorts: 0, bandLeftMm2: 0 };
    const bottom = { face: 'bottom' as const, ok: true, designPieces: 1, pieces: 1, matched: 1, shorts: 0, bandLeftMm2: 0 };
    const both = combineCopperSides([top, bottom]);
    expect(oracleSentence({ oracle: { ...report(both), copper: both } })).toBe(
      'The copper came out as designed on both faces — the top face: 2 pieces, 2 of 2 still there, no short; the bottom face: 1 piece, 1 of 1 still there, no short.',
    );
  });
});

/**
 * #743 P-5 — a board's oracle sentence is about its COPPER, not about an under/over-cut the board
 * never asked. The report's `copper` field replaces the volumetric numbers in the one sentence the
 * Cut confirm prints, so a short or a piece that is gone arrives in the operator's own words.
 */
import { describe, expect, it } from 'vitest';

import { oracleSentence } from '@/store/engraveRunGate';
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
});
